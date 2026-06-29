import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { DocumentLayout } from "../documents/layout.js";
import { buildSearchableArtifacts } from "../ingestion/searchable-artifacts.js";
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

test("persists and reloads parser-derived searchable chunks", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-index-"));
  try {
    const filePath = path.join(directory, "index.json");
    const body = ["Region Revenue", "North America 120", "OCR note"].join("\n");
    const document = {
      ...makeDocument({
        id: "doc_durable_parser_chunks",
        body
      }),
      layout: durableParserLayout(body)
    };
    const bodyChunks = chunkDocument({ document }).chunks;
    const searchable = buildSearchableArtifacts({ document, bodyChunks });
    const chunks = [...bodyChunks, ...searchable.chunks];
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
    const storedChunks = reloaded.findChunks(makeIndexFilter()).map((indexed) => indexed.chunk);

    assert.equal(reloaded.stats().chunkCount, chunks.length);
    assert.equal(
      storedChunks.some((chunk) => chunk.metadata?.["searchableUnitType"] === "table_chunk"),
      true
    );
    assert.equal(
      storedChunks.some((chunk) => chunk.metadata?.["searchableUnitType"] === "parser_gap_chunk"),
      true
    );
    assert.equal(
      storedChunks.some((chunk) => chunk.metadata?.["tableId"] === "table_durable"),
      true
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reloads external durable snapshot writes before serving reads", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-index-"));
  try {
    const filePath = path.join(directory, "index.json");
    const document = makeDocument({
      id: "doc_external_write",
      body: "External upload ingestion should be visible to a running JSON index."
    });
    const chunks = chunkDocument({ document }).chunks;
    const servingIndex = new JsonFileRagIndex({
      filePath,
      now: () => FIXED_NOW,
      pretty: true
    });

    assert.equal(servingIndex.stats().documentCount, 0);

    const writerIndex = new JsonFileRagIndex({
      filePath,
      now: () => FIXED_NOW,
      pretty: true
    });
    writerIndex.addDocument(document, { indexedAt: FIXED_NOW });
    writerIndex.addChunks(document.id, chunks, { indexedAt: FIXED_NOW });

    assert.equal(servingIndex.stats().documentCount, 1);
    assert.equal(servingIndex.stats().chunkCount, chunks.length);
    assert.equal(
      servingIndex.getDocument(document.id, makeIndexFilter())?.document.id,
      document.id
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("clears serving reads when an external durable snapshot is removed", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-index-"));
  try {
    const filePath = path.join(directory, "index.json");
    const document = makeDocument({
      id: "doc_external_delete",
      body: "External index deletion should clear a running JSON index."
    });
    const chunks = chunkDocument({ document }).chunks;
    const servingIndex = new JsonFileRagIndex({
      filePath,
      now: () => FIXED_NOW,
      pretty: true
    });
    servingIndex.addDocument(document, { indexedAt: FIXED_NOW });
    servingIndex.addChunks(document.id, chunks, { indexedAt: FIXED_NOW });

    assert.equal(servingIndex.stats().documentCount, 1);

    unlinkSync(filePath);

    assert.equal(servingIndex.stats().documentCount, 0);
    assert.equal(servingIndex.stats().chunkCount, 0);
    assert.equal(servingIndex.getDocument(document.id, makeIndexFilter()), undefined);
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

function durableParserLayout(body: string): DocumentLayout {
  const headerStart = body.indexOf("Region Revenue");
  const rowStart = body.indexOf("North America 120");
  const ocrNoteStart = body.indexOf("OCR note");

  return {
    parserId: "durable-parser",
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
        id: "table_durable",
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
