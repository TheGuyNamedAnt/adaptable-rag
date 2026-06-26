import assert from "node:assert/strict";
import test from "node:test";

import { hashText } from "../chunking/hash.js";
import { DEFAULT_CHUNKING_POLICY } from "../chunking/chunk-policy.js";
import type { CorpusAdapter, CorpusLoadRequest, CorpusLoadResult } from "../corpus/adapter.js";
import { CorpusAdapterRegistry } from "../corpus/adapter-registry.js";
import type { CorpusRecord } from "../corpus/corpus-record.js";
import type { RagChunk } from "../documents/chunk.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import type { IndexChunkOptions, IndexOperationResult } from "../indexing/index-types.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { FIXED_NOW, makeIndexFilter, makePrincipal } from "../test-support/fixtures.js";
import { IngestPipeline, type IngestPipelineResumeState } from "./ingest-pipeline.js";

const profile = assertValidProfile(genericDocsProfile);
const principal = makePrincipal({
  tenantId: "tenant_1",
  namespaceIds: [genericDocsProfile.namespaceId],
  roles: ["admin"],
  tags: ["support"]
});

class StaticAdapter implements CorpusAdapter {
  readonly id = "local-files";
  readonly description = "Static test adapter";
  readonly records: readonly (CorpusRecord | null | undefined)[];
  readonly sourceId: string;

  constructor(records: readonly (CorpusRecord | null | undefined)[], sourceId = "curated_docs") {
    this.records = records;
    this.sourceId = sourceId;
  }

  async load(_request: CorpusLoadRequest): Promise<CorpusLoadResult> {
    return {
      sourceId: this.sourceId,
      records: this.records,
      warnings: []
    };
  }
}

class RejectingDocumentIndex extends InMemoryRagIndex {
  addDocument(): IndexOperationResult {
    return {
      accepted: false,
      id: "record_ingest",
      message: "Document rejected by durable store."
    };
  }
}

class RejectingChunkIndex extends InMemoryRagIndex {
  addChunks(): readonly IndexOperationResult[] {
    return [
      {
        accepted: false,
        id: "record_ingest_chunk_0001",
        message: "Chunk rejected by durable store."
      }
    ];
  }
}

class ValidationThrowingChunkIndex extends InMemoryRagIndex {
  override addChunks(
    documentId: string,
    chunks: readonly RagChunk[],
    options: IndexChunkOptions = {}
  ): readonly IndexOperationResult[] {
    if (documentId === "record_bad_chunk") {
      throw new Error(
        "Chunks rejected by index validation:\ntext: Chunk exceeds maxCharacters=1800."
      );
    }

    return super.addChunks(documentId, chunks, options);
  }
}

function record(overrides: Partial<CorpusRecord> = {}): CorpusRecord {
  const body = overrides.body ?? "Refund policy body for ingest pipeline.";

  return {
    id: "record_ingest",
    sourceId: "curated_docs",
    sourceKind: "local_file",
    title: "Ingest Policy",
    body,
    trustTier: "trusted_internal",
    sensitivity: "internal",
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: genericDocsProfile.namespaceId,
      tags: ["support"]
    },
    capturedAt: FIXED_NOW,
    checksum: hashText(body),
    ...overrides
  };
}

test("ingests adapter records through normalization, chunking, and indexing", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const registry = new CorpusAdapterRegistry([new StaticAdapter([record()])]);
  const pipeline = new IngestPipeline({
    adapterRegistry: registry,
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    runId: "ingest_test",
    requestedAt: FIXED_NOW
  });

  const filter = makeIndexFilter({
    namespaceId: genericDocsProfile.namespaceId,
    principal,
    tenantId: principal.tenantId
  });

  assert.equal(result.runId, "ingest_test");
  assert.deepEqual(result.loadedSourceIds, ["curated_docs"]);
  assert.equal(result.documents.length, 1);
  assert.equal(result.chunks.length, 1);
  assert.equal(result.rejectedRecords.length, 0);
  assert.equal(index.findDocuments(filter).length, 1);
  assert.equal(index.findChunks(filter).length, 1);
});

test("resumes from document checkpoints without reindexing completed documents", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const registry = new CorpusAdapterRegistry([
    new StaticAdapter([
      record({ id: "record_first", body: "First resumable ingest document." }),
      record({ id: "record_second", body: "Second resumable ingest document." })
    ])
  ]);
  const pipeline = new IngestPipeline({
    adapterRegistry: registry,
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  let resumeState: IngestPipelineResumeState = {};
  await assert.rejects(
    pipeline.ingest({
      profile,
      requestedBy: principal,
      runId: "resume_test",
      requestedAt: FIXED_NOW,
      onCheckpoint: (checkpoint) => {
        resumeState = {
          completedSourceIds: checkpoint.completedSourceIds,
          completedDocumentIds: checkpoint.completedDocumentIds
        };
        throw new Error("simulated worker crash");
      }
    }),
    /simulated worker crash/u
  );

  assert.deepEqual(resumeState.completedDocumentIds, ["record_first"]);

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    runId: "resume_test",
    requestedAt: FIXED_NOW,
    resumeState
  });

  assert.deepEqual(
    result.documents.map((document) => document.id),
    ["record_second"]
  );
  assert.equal(
    result.indexResults.every((indexResult) => indexResult.accepted),
    true
  );
  assert.equal(index.stats().documentCount, 2);
});

test("rejects malformed adapter records without indexing them", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const registry = new CorpusAdapterRegistry([
    new StaticAdapter([
      null,
      record({
        id: "record_bad_checksum",
        checksum: hashText("tampered")
      })
    ])
  ]);
  const pipeline = new IngestPipeline({
    adapterRegistry: registry,
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    requestedAt: FIXED_NOW
  });

  assert.equal(result.documents.length, 0);
  assert.equal(result.chunks.length, 0);
  assert.equal(result.rejectedRecords.length, 2);
  assert.equal(
    result.normalizationIssues.some((issue) => issue.code === "null_record"),
    true
  );
  assert.equal(
    result.normalizationIssues.some((issue) => issue.code === "checksum_mismatch"),
    true
  );
});

test("records adapter source id mismatches as warnings", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const registry = new CorpusAdapterRegistry([new StaticAdapter([record()], "wrong_source")]);
  const pipeline = new IngestPipeline({
    adapterRegistry: registry,
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    requestedAt: FIXED_NOW
  });

  assert.equal(
    result.adapterWarnings.some((warning) => warning.code === "source_id_mismatch"),
    true
  );
});

test("reports parser quality warnings for accepted parser-backed documents", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const registry = new CorpusAdapterRegistry([
    new StaticAdapter([
      record({
        metadata: {
          parserRouterSelectedScore: 65,
          parserRouterTraceJson: JSON.stringify({
            selectedParserId: "fallback-parser",
            selectedTier: "fallback",
            selectedQualityScore: 65,
            attempts: [
              {
                parserId: "native-parser",
                tier: "fast_native",
                status: "rejected",
                qualityScore: 40,
                reasons: ["layout was required but missing"]
              },
              {
                parserId: "fallback-parser",
                tier: "fallback",
                status: "accepted",
                qualityScore: 65
              }
            ]
          })
        }
      })
    ])
  ]);
  const pipeline = new IngestPipeline({
    adapterRegistry: registry,
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    requestedAt: FIXED_NOW
  });

  assert.equal(result.parserQuality.tracedDocumentCount, 1);
  assert.equal(result.parserQuality.lowScoreDocumentCount, 1);
  assert.equal(result.parserQuality.fallbackSelectedCount, 1);
  assert.equal(result.parserQuality.rejectedAttemptCount, 1);
  assert.equal(result.parserQuality.readiness.status, "insufficient");
  assert.deepEqual(
    result.parserQualityWarnings.map((warning) => warning.code),
    ["parser_score_below_threshold", "parser_fallback_selected", "parser_rejected_attempts"]
  );
});

test("does not chunk or report documents when document indexing rejects", async () => {
  const documentIndex = new RejectingDocumentIndex({ now: () => FIXED_NOW });
  const chunkIndex = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const registry = new CorpusAdapterRegistry([new StaticAdapter([record()])]);
  const pipeline = new IngestPipeline({
    adapterRegistry: registry,
    documentStore: documentIndex,
    chunkStore: chunkIndex,
    now: () => FIXED_NOW
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    requestedAt: FIXED_NOW
  });

  assert.equal(
    result.indexResults.some((indexResult) => !indexResult.accepted),
    true
  );
  assert.equal(result.documents.length, 0);
  assert.equal(result.chunks.length, 0);
  assert.equal(
    chunkIndex.hasChunk(
      "record_ingest_chunk_0001",
      makeIndexFilter({
        namespaceId: genericDocsProfile.namespaceId,
        principal,
        tenantId: principal.tenantId
      })
    ),
    false
  );
});

test("skips over-limit documents without committing document-only metadata", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const registry = new CorpusAdapterRegistry([
    new StaticAdapter([
      record({
        id: "record_too_large",
        body: ["alpha beta gamma", "delta epsilon zeta", "eta theta iota"].join("\n\n")
      }),
      record({
        id: "record_small",
        body: "Small policy body."
      })
    ])
  ]);
  const pipeline = new IngestPipeline({
    adapterRegistry: registry,
    documentStore: index,
    chunkStore: index,
    chunkingPolicy: {
      ...DEFAULT_CHUNKING_POLICY,
      maxCharacters: 20,
      overlapCharacters: 0,
      minCharacters: 1,
      maxChunksPerDocument: 1,
      boundaryStrategy: "character_window"
    },
    now: () => FIXED_NOW
  });
  const filter = makeIndexFilter({
    namespaceId: genericDocsProfile.namespaceId,
    principal,
    tenantId: principal.tenantId
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    requestedAt: FIXED_NOW
  });

  assert.deepEqual(
    result.rejectedRecords.map((rejected) => rejected.recordId),
    ["record_too_large"]
  );
  assert.deepEqual(
    result.chunkingWarnings.map((warning) => warning.code),
    ["max_chunks_per_document_exceeded"]
  );
  assert.equal(index.hasDocument("record_too_large", filter), false);
  assert.equal(index.hasDocument("record_small", filter), true);
  assert.equal(result.documents.length, 1);
  assert.equal(index.findChunks(filter).length, 1);
});

test("rolls back document metadata when chunk index validation fails", async () => {
  const index = new ValidationThrowingChunkIndex({ now: () => FIXED_NOW });
  const registry = new CorpusAdapterRegistry([
    new StaticAdapter([
      record({
        id: "record_bad_chunk",
        body: "This document chunks cleanly before the chunk store rejects it.",
        accessScope: {
          tenantId: "tenant_1",
          namespaceId: genericDocsProfile.namespaceId,
          roles: ["admin"],
          tags: ["private-cleanup"]
        }
      }),
      record({
        id: "record_after_bad_chunk",
        body: "This document should still be indexed after the bad chunk."
      })
    ])
  ]);
  const pipeline = new IngestPipeline({
    adapterRegistry: registry,
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  });
  const filter = makeIndexFilter({
    namespaceId: genericDocsProfile.namespaceId,
    principal,
    tenantId: principal.tenantId
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    requestedAt: FIXED_NOW
  });

  assert.deepEqual(
    result.rejectedRecords.map((rejected) => rejected.recordId),
    ["record_bad_chunk"]
  );
  assert.deepEqual(
    result.chunkingWarnings.map((warning) => warning.code),
    ["chunk_index_validation_failed"]
  );
  assert.equal(index.hasDocument("record_bad_chunk", filter), false);
  assert.equal(index.hasDocument("record_after_bad_chunk", filter), true);
  assert.equal(result.documents.length, 1);
  assert.equal(index.findChunks(filter).length, 1);
});

test("reports only chunks accepted by the chunk store", async () => {
  const documentIndex = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const chunkIndex = new RejectingChunkIndex({ now: () => FIXED_NOW });
  const registry = new CorpusAdapterRegistry([new StaticAdapter([record()])]);
  const pipeline = new IngestPipeline({
    adapterRegistry: registry,
    documentStore: documentIndex,
    chunkStore: chunkIndex,
    now: () => FIXED_NOW
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    requestedAt: FIXED_NOW
  });

  assert.equal(result.documents.length, 1);
  assert.equal(
    result.indexResults.some((indexResult) => !indexResult.accepted),
    true
  );
  assert.equal(result.chunks.length, 0);
});
