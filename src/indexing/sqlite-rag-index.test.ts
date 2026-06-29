import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { DocumentLayout } from "../documents/layout.js";
import { buildSearchableArtifacts } from "../ingestion/searchable-artifacts.js";
import { FIXED_NOW, makeChunks, makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import { SqliteRagIndex } from "./sqlite-rag-index.js";

const nodeSqliteSkipReasonValue = nodeSqliteSkipReason();
const sqliteFtsSkipReasonValue = sqliteFtsSkipReason();

test(
  "SQLite index persists documents, chunks, and migration readiness",
  { skip: nodeSqliteSkipReasonValue ?? false },
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
    const readiness = reopened.readinessCheck();
    assert.equal(reopened.migrationCheck().status, sqliteFtsSkipReasonValue ? "failed" : "passed");
    assert.equal(readiness.status, sqliteFtsSkipReasonValue ? "failed" : "passed");
    assert.equal(
      readiness.checks.some((check) => check.id === "sqlite_fts5" && check.status === "failed"),
      Boolean(sqliteFtsSkipReasonValue)
    );
    reopened.close();
  }
);

test(
  "SQLite index persists parser-derived searchable chunks without requiring FTS5",
  { skip: nodeSqliteSkipReasonValue ?? false },
  () => {
    const filePath = sqlitePath();
    const body = ["Region Revenue", "North America 120", "OCR note"].join("\n");
    const document = {
      ...makeDocument({
        id: "doc_sqlite_parser_chunks",
        body
      }),
      layout: sqliteParserLayout(body)
    };
    const bodyChunks = chunkDocument({ document }).chunks;
    const searchable = buildSearchableArtifacts({ document, bodyChunks });
    const chunks = [...bodyChunks, ...searchable.chunks];
    const index = new SqliteRagIndex({ filePath, now: () => FIXED_NOW });

    index.addDocument(document);
    index.addChunks(document.id, chunks);
    index.close();

    const reopened = new SqliteRagIndex({ filePath, now: () => FIXED_NOW });
    const storedChunks = reopened.listChunks(makeIndexFilter()).map((indexed) => indexed.chunk);

    assert.equal(storedChunks.length, chunks.length);
    assert.equal(
      storedChunks.some((chunk) => chunk.metadata?.["searchableUnitType"] === "table_chunk"),
      true
    );
    assert.equal(
      storedChunks.some((chunk) => chunk.metadata?.["searchableUnitType"] === "parser_gap_chunk"),
      true
    );
    assert.equal(
      storedChunks.some((chunk) => chunk.metadata?.["tableId"] === "table_sqlite"),
      true
    );
    reopened.close();
  }
);

test(
  "SQLite FTS searches indexed chunks with access filters",
  { skip: nodeSqliteSkipReasonValue ?? sqliteFtsSkipReasonValue ?? false },
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
  { skip: nodeSqliteSkipReasonValue ?? sqliteFtsSkipReasonValue ?? false },
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
  { skip: nodeSqliteSkipReasonValue ?? sqliteFtsSkipReasonValue ?? false },
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
  { skip: nodeSqliteSkipReasonValue ?? sqliteFtsSkipReasonValue ?? false },
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
  } catch {
    return "node:sqlite is not available in this Node.js runtime";
  }
  return undefined;
}

function sqliteFtsSkipReason(): string | undefined {
  if (nodeSqliteSkipReasonValue) {
    return nodeSqliteSkipReasonValue;
  }
  try {
    const index = new SqliteRagIndex({ filePath: sqlitePath(), now: () => FIXED_NOW });
    const readiness = index.readinessCheck();
    index.close();
    return readiness.checks.some((check) => check.id === "sqlite_fts5" && check.status === "failed")
      ? "node:sqlite is available but this SQLite build does not include FTS5"
      : undefined;
  } catch (error) {
    if (error instanceof Error && /no such module:\s*fts5/i.test(error.message)) {
      return "node:sqlite is available but this SQLite build does not include FTS5";
    }
    throw error;
  }
}

function sqliteParserLayout(body: string): DocumentLayout {
  const headerStart = body.indexOf("Region Revenue");
  const rowStart = body.indexOf("North America 120");
  const ocrNoteStart = body.indexOf("OCR note");

  return {
    parserId: "sqlite-parser",
    parserVersion: "1.0.0",
    strategy: "hybrid",
    pages: [
      { pageNumber: 1, width: 612, height: 792, unit: "point" },
      { pageNumber: 2, width: 612, height: 792, unit: "point" }
    ],
    regions: [
      {
        id: "table_region",
        kind: "table",
        pageNumber: 1,
        characterStart: headerStart,
        characterEnd: rowStart + "North America 120".length
      },
      {
        id: "cell_header_region",
        kind: "text",
        pageNumber: 1,
        text: "Region",
        characterStart: headerStart,
        characterEnd: headerStart + "Region".length
      },
      {
        id: "cell_header_revenue",
        kind: "text",
        pageNumber: 1,
        text: "Revenue",
        characterStart: headerStart + "Region ".length,
        characterEnd: headerStart + "Region Revenue".length
      },
      {
        id: "cell_region",
        kind: "text",
        pageNumber: 1,
        text: "North America",
        characterStart: rowStart,
        characterEnd: rowStart + "North America".length
      },
      {
        id: "cell_revenue",
        kind: "text",
        pageNumber: 1,
        text: "120",
        characterStart: rowStart + "North America ".length,
        characterEnd: rowStart + "North America 120".length
      },
      {
        id: "page_image_region",
        kind: "page_image",
        pageNumber: 2
      },
      {
        id: "ocr_note",
        kind: "text",
        pageNumber: 2,
        text: "OCR note",
        characterStart: ocrNoteStart,
        characterEnd: ocrNoteStart + "OCR note".length
      }
    ],
    tables: [
      {
        id: "table_sqlite",
        pageNumber: 1,
        regionId: "table_region",
        cells: [
          { rowIndex: 0, columnIndex: 0, text: "Region", regionId: "cell_header_region" },
          { rowIndex: 0, columnIndex: 1, text: "Revenue", regionId: "cell_header_revenue" },
          { rowIndex: 1, columnIndex: 0, text: "North America", regionId: "cell_region" },
          { rowIndex: 1, columnIndex: 1, text: "120", regionId: "cell_revenue" }
        ]
      }
    ]
  };
}
