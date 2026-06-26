import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import { KeywordRetriever } from "../retrieval/keyword-retriever.js";
import {
  FIXED_NOW,
  makeDocument,
  makeIndexFilter,
  makePrincipal
} from "../test-support/fixtures.js";
import { JsonFileRagIndex } from "./json-file-index.js";

test("persists and reloads a validated index snapshot", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-index-"));
  try {
    const filePath = path.join(directory, "index.json");
    const document = makeDocument({
      id: "doc_durable",
      body: "Durable refund policy evidence."
    });
    const chunks = chunkDocument({ document }).chunks;
    const first = new JsonFileRagIndex({
      filePath,
      now: () => FIXED_NOW,
      pretty: true
    });

    first.addDocument(document, { indexedAt: FIXED_NOW });
    first.addChunks(document.id, chunks, { indexedAt: FIXED_NOW });

    const reloaded = new JsonFileRagIndex({
      filePath,
      now: () => FIXED_NOW
    });

    assert.equal(reloaded.capabilities.durable, true);
    assert.equal(reloaded.stats().documentCount, 1);
    assert.equal(reloaded.stats().chunkCount, chunks.length);
    assert.equal(reloaded.getDocument(document.id, makeIndexFilter())?.document.id, document.id);
    assert.equal(reloaded.findChunks(makeIndexFilter()).length, chunks.length);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reloaded durable index denies restricted chunks through direct APIs and retrieval", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-index-"));
  try {
    const filePath = path.join(directory, "index.json");
    const document = makeDocument({
      id: "doc_restricted_durable",
      accessScope: {
        tenantId: "tenant_1",
        namespaceId: "test-namespace",
        userIds: ["user_allowed"],
        teamIds: ["billing_team"],
        roles: ["support"],
        tags: ["billing", "internal"]
      },
      body: "Refund policy for restricted billing support."
    });
    const chunks = chunkDocument({ document }).chunks;
    const chunk = chunks[0];
    assert.ok(chunk);
    const first = new JsonFileRagIndex({ filePath, now: () => FIXED_NOW });

    first.addDocument(document, { indexedAt: FIXED_NOW });
    first.addChunks(document.id, chunks, { indexedAt: FIXED_NOW });

    const reloaded = new JsonFileRagIndex({ filePath, now: () => FIXED_NOW });
    const deniedFilter = makeIndexFilter({
      principal: makePrincipal({
        userId: "user_denied",
        teamIds: ["billing_team"],
        roles: ["support"],
        tags: ["billing", "internal"]
      })
    });
    const allowedFilter = makeIndexFilter({
      principal: makePrincipal({
        userId: "user_allowed",
        teamIds: ["billing_team"],
        roles: ["support"],
        tags: ["billing", "internal"]
      })
    });
    const retriever = new KeywordRetriever({
      chunkStore: reloaded,
      now: () => FIXED_NOW
    });

    assert.equal(reloaded.getDocument(document.id, allowedFilter)?.document.id, document.id);
    assert.equal(reloaded.getChunk(chunk.id, allowedFilter)?.chunk.id, chunk.id);
    assert.equal(reloaded.getDocument(document.id, deniedFilter), undefined);
    assert.equal(reloaded.getChunk(chunk.id, deniedFilter), undefined);
    assert.equal(reloaded.hasDocument(document.id, deniedFilter), false);
    assert.equal(reloaded.hasChunk(chunk.id, deniedFilter), false);
    assert.deepEqual(reloaded.findDocuments(deniedFilter), []);
    assert.deepEqual(reloaded.findChunks(deniedFilter), []);
    assert.deepEqual(reloaded.listDocuments(deniedFilter), []);
    assert.deepEqual(reloaded.listChunks(deniedFilter), []);

    const deniedRetrieval = await retriever.retrieve({
      query: "refund policy",
      filter: deniedFilter,
      topK: 5
    });

    assert.equal(deniedRetrieval.candidates.length, 0);
    assert.equal(deniedRetrieval.trace.candidatePoolSize, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects invalid durable snapshots before serving reads", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-index-"));
  try {
    const filePath = path.join(directory, "index.json");
    writeFileSync(filePath, JSON.stringify({ version: 1, documents: {}, chunks: [] }), "utf8");

    assert.throws(
      () => new JsonFileRagIndex({ filePath, now: () => FIXED_NOW }),
      /Invalid index snapshot/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
