import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FIXED_NOW, makeChunks, makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import { SqliteRagIndex } from "./sqlite-rag-index.js";

const sqliteSkipReason = nodeSqliteSkipReason();

test(
  "SQLite index persists documents, chunks, and migration readiness",
  { skip: sqliteSkipReason ?? false },
  () => {
    const filePath = sqlitePath();
    const document = makeDocument();
    const chunks = makeChunks(document);
    const index = new SqliteRagIndex({ filePath, now: () => FIXED_NOW });

    index.addDocument(document);
    index.addChunks(document.id, chunks);
    index.close();

    const reopened = new SqliteRagIndex({ filePath, now: () => FIXED_NOW });
    assert.equal(reopened.hasDocument(document.id, makeIndexFilter()), true);
    assert.equal(reopened.listChunks(makeIndexFilter()).length, chunks.length);
    assert.deepEqual(reopened.stats(), {
      documentCount: 1,
      chunkCount: chunks.length,
      namespaceIds: [document.namespaceId],
      sourceIds: [document.provenance.sourceId],
      trustTierCounts: {
        trusted_internal: chunks.length
      },
      flaggedChunkCount: 0
    });
    assert.equal(reopened.migrationCheck().status, "passed");
    assert.equal(reopened.readinessCheck().status, "passed");
    reopened.close();
  }
);

test(
  "SQLite FTS searches indexed chunks with access filters",
  { skip: sqliteSkipReason ?? false },
  () => {
    const index = new SqliteRagIndex({ filePath: sqlitePath(), now: () => FIXED_NOW });
    const document = makeDocument({
      id: "doc_sqlite_refunds",
      body: "Refund policy says billing refunds require human review."
    });
    const chunks = makeChunks(document);
    index.addDocument(document);
    index.addChunks(document.id, chunks);

    const results = index.searchKeywordChunks({
      query: "refund policy",
      terms: ["refund", "policy"],
      filter: makeIndexFilter(),
      limit: 5
    });

    assert.equal(results.length > 0, true);
    assert.equal(results[0]?.chunk.chunk.documentId, "doc_sqlite_refunds");
    assert.equal(results[0]?.reasons.includes("sqlite_fts_match"), true);

    const denied = index.searchKeywordChunks({
      query: "refund policy",
      terms: ["refund", "policy"],
      filter: makeIndexFilter({ accessTags: ["missing_tag"] }),
      limit: 5
    });
    assert.equal(denied.length, 0);
    index.close();
  }
);

test(
  "SQLite document replacement removes stale chunks and FTS rows",
  { skip: sqliteSkipReason ?? false },
  () => {
    const index = new SqliteRagIndex({ filePath: sqlitePath(), now: () => FIXED_NOW });
    const original = makeDocument({
      body: "Original refund policy mentions chargebacks."
    });
    index.addDocument(original);
    index.addChunks(original.id, makeChunks(original));

    const replacement = makeDocument({
      body: "Replacement policy only mentions invoices."
    });
    index.addDocument(replacement, { overwriteMode: "replace", indexedAt: FIXED_NOW });
    index.addChunks(replacement.id, makeChunks(replacement));

    assert.equal(
      index.searchKeywordChunks({
        query: "chargebacks",
        terms: ["chargebacks"],
        filter: makeIndexFilter(),
        limit: 5
      }).length,
      0
    );
    assert.equal(
      index.searchKeywordChunks({
        query: "invoices",
        terms: ["invoices"],
        filter: makeIndexFilter(),
        limit: 5
      }).length > 0,
      true
    );
    index.close();
  }
);

test(
  "SQLite FTS writer rebuilds and deletes keyword rows without deleting chunks",
  { skip: sqliteSkipReason ?? false },
  () => {
    const index = new SqliteRagIndex({ filePath: sqlitePath(), now: () => FIXED_NOW });
    const document = makeDocument({
      id: "doc_sqlite_fts_writer",
      body: "Keyword writer rebuilds refund policy rows."
    });
    const chunks = makeChunks(document);
    index.addDocument(document);
    index.addChunks(document.id, chunks);

    const deleted = index.deleteKeywordChunksForDocument({
      documentId: document.id,
      filter: makeIndexFilter()
    });

    assert.equal(deleted.accepted, true);
    assert.equal(index.listChunks(makeIndexFilter()).length, chunks.length);
    assert.equal(
      index.searchKeywordChunks({
        query: "refund policy",
        terms: ["refund", "policy"],
        filter: makeIndexFilter(),
        limit: 5
      }).length,
      0
    );

    const written = index.writeKeywordChunks({ chunks });

    assert.equal(written.indexedChunkCount, chunks.length);
    assert.equal(written.rejectedChunkCount, 0);
    assert.equal(
      index.searchKeywordChunks({
        query: "refund policy",
        terms: ["refund", "policy"],
        filter: makeIndexFilter(),
        limit: 5
      }).length > 0,
      true
    );
    index.close();
  }
);

test(
  "SQLite FTS writer rejects chunks that are not in canonical storage",
  { skip: sqliteSkipReason ?? false },
  () => {
    const index = new SqliteRagIndex({ filePath: sqlitePath(), now: () => FIXED_NOW });
    const document = makeDocument({
      id: "doc_sqlite_missing_fts",
      body: "Missing canonical chunk should not get keyword rows."
    });
    const chunks = makeChunks(document);

    const result = index.writeKeywordChunks({ chunks });

    assert.equal(result.indexedChunkCount, 0);
    assert.equal(result.rejectedChunkCount, chunks.length);
    assert.equal(result.results[0]?.accepted, false);
    index.close();
  }
);

function sqlitePath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "adaptable-rag-sqlite-index-")), "index.sqlite");
}

function nodeSqliteSkipReason(): string | undefined {
  try {
    createRequire(import.meta.url)("node:sqlite");
    return undefined;
  } catch {
    return "node:sqlite is not available in this Node.js runtime";
  }
}
