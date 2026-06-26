import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import { FakeEmbeddingAdapter } from "../embeddings/fake-embedding-adapter.js";
import { EmbeddingIndexer } from "../embeddings/embedding-indexer.js";
import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { redactIndexFilterForTrace } from "../indexing/index-filter.js";
import { InMemoryVectorStore } from "../indexing/vector-store.js";
import { FakeModelAdapter } from "../model/fake-model-adapter.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { RagAnswerRuntime } from "../runtime/rag-answer-runtime.js";
import { hashText } from "../shared/hash.js";
import {
  FIXED_NOW,
  makeDocument,
  makeIndexFilter,
  makePrincipal
} from "../test-support/fixtures.js";
import { HybridRetriever } from "./hybrid-retriever.js";
import { KeywordRetriever } from "./keyword-retriever.js";
import type { Retriever, RetrieverCapabilities } from "./retriever.js";
import type {
  RetrievalCandidate,
  RetrievalRejection,
  RetrievalRequest,
  RetrievalResult,
  RetrievalTrace
} from "./retrieval-types.js";
import { VectorRetriever } from "./vector-retriever.js";

test("hybrid retrieval uses RRF, dedupes chunks, and preserves child modes", async () => {
  const shared = firstChunk(
    makeDocument({
      id: "doc_shared",
      body: "Refund billing policy appears in both channels."
    })
  );
  const keywordOnly = firstChunk(
    makeDocument({
      id: "doc_keyword",
      body: "Refund policy has exact words."
    })
  );
  const vectorOnly = firstChunk(
    makeDocument({
      id: "doc_vector",
      body: "Billing exception review is semantically nearby."
    })
  );
  const keywordRetriever = new StaticRetriever("keyword", [
    candidate(keywordOnly, 10, 1, ["refund"], ["keyword_term_match"]),
    candidate(shared, 5, 2, ["refund", "billing"], ["keyword_term_match"])
  ]);
  const vectorRetriever = new StaticRetriever("vector", [
    candidate(shared, 0.8, 1, [], ["vector_cosine_similarity"]),
    candidate(vectorOnly, 0.8, 2, [], ["vector_cosine_similarity"])
  ]);
  const retriever = new HybridRetriever({
    keywordRetriever,
    vectorRetriever,
    now: () => FIXED_NOW
  });

  const result = await retriever.retrieve({
    query: "refund billing",
    mode: "hybrid",
    filter: makeIndexFilter(),
    topK: 3,
    candidatePoolLimit: 10,
    includeRejected: true,
    retrievalId: "hybrid_retrieval_test",
    requestedAt: FIXED_NOW
  });

  assert.deepEqual(
    result.candidates.map((entry) => entry.chunk.documentId),
    ["doc_shared", "doc_keyword", "doc_vector"]
  );
  assert.equal(result.candidates[0]?.score, 0.016262);
  assert.deepEqual(result.candidates[0]?.matchedTerms, ["billing", "refund"]);
  assert.equal(result.candidates[0]?.reasons.includes("hybrid_keyword_component"), true);
  assert.equal(result.candidates[0]?.reasons.includes("hybrid_vector_component"), true);
  assert.equal(result.candidates[0]?.reasons.includes("hybrid_rrf_score"), true);
  assert.equal(result.trace.mode, "hybrid");
  assert.equal(result.trace.fusionStrategy, "reciprocal_rank_fusion");
  assert.deepEqual(result.trace.childRetrievalIds, [
    "hybrid_retrieval_test_keyword",
    "hybrid_retrieval_test_vector"
  ]);
  assert.equal(result.trace.retrievalId, "hybrid_retrieval_test");
  assert.equal(result.trace.candidatePoolSize, 3);
  assert.deepEqual(
    keywordRetriever.calls.map((call) => call.mode),
    ["keyword"]
  );
  assert.deepEqual(
    vectorRetriever.calls.map((call) => call.mode),
    ["vector"]
  );
  assert.equal(keywordRetriever.calls[0]?.topK, 10);
  assert.equal(vectorRetriever.calls[0]?.topK, 10);
  assert.equal(JSON.stringify(result.trace).includes("refund billing"), false);
});

test("hybrid retrieval keeps score-normalization available as an explicit compatibility strategy", async () => {
  const shared = firstChunk(
    makeDocument({
      id: "doc_shared_score",
      body: "Refund billing policy appears in both channels."
    })
  );
  const keywordOnly = firstChunk(
    makeDocument({
      id: "doc_keyword_score",
      body: "Refund policy has exact words."
    })
  );
  const vectorOnly = firstChunk(
    makeDocument({
      id: "doc_vector_score",
      body: "Billing exception review is semantically nearby."
    })
  );
  const retriever = new HybridRetriever({
    keywordRetriever: new StaticRetriever("keyword", [
      candidate(keywordOnly, 10, 1, ["refund"], ["keyword_term_match"]),
      candidate(shared, 5, 2, ["refund", "billing"], ["keyword_term_match"])
    ]),
    vectorRetriever: new StaticRetriever("vector", [
      candidate(shared, 0.8, 1, [], ["vector_cosine_similarity"]),
      candidate(vectorOnly, 0.8, 2, [], ["vector_cosine_similarity"])
    ]),
    fusionStrategy: "score_normalization",
    now: () => FIXED_NOW
  });

  const result = await retriever.retrieve({
    query: "refund billing",
    mode: "hybrid",
    filter: makeIndexFilter(),
    topK: 3,
    candidatePoolLimit: 10,
    retrievalId: "hybrid_score_normalization_test",
    requestedAt: FIXED_NOW
  });

  assert.deepEqual(
    result.candidates.map((entry) => entry.chunk.documentId),
    ["doc_shared_score", "doc_keyword_score", "doc_vector_score"]
  );
  assert.equal(result.candidates[0]?.score, 0.75);
  assert.equal(result.candidates[0]?.reasons.includes("hybrid_score_normalized"), true);
  assert.equal(result.trace.fusionStrategy, "score_normalization");
});

test("advertises honest hybrid retrieval capabilities", () => {
  const retriever = new HybridRetriever({
    keywordRetriever: new StaticRetriever("keyword", []),
    vectorRetriever: new StaticRetriever("vector", [])
  });

  assert.deepEqual(retriever.capabilities.modes, ["hybrid"]);
  assert.equal(retriever.capabilities.supportsVectorSearch, true);
  assert.equal(retriever.capabilities.supportsHybridSearch, true);
});

test("refuses construction without keyword and vector child capabilities", () => {
  assert.throws(
    () =>
      new HybridRetriever({
        keywordRetriever: new StaticRetriever("keyword", []),
        vectorRetriever: new StaticRetriever("keyword", [])
      }),
    /requires a child retriever/
  );
});

test("hybrid retriever refuses to serve keyword or vector mode directly", async () => {
  const retriever = new HybridRetriever({
    keywordRetriever: new StaticRetriever("keyword", []),
    vectorRetriever: new StaticRetriever("vector", [])
  });

  await assert.rejects(
    () =>
      retriever.retrieve({
        query: "refund",
        mode: "keyword",
        filter: makeIndexFilter(),
        topK: 1
      }),
    /cannot serve retrieval mode/
  );
});

test("hybrid retrieval cannot return chunks denied by the shared index filter", async () => {
  const accessible = makeDocument({
    id: "doc_accessible",
    body: "Refund billing policy requires support review.",
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "test-namespace",
      tags: ["support"]
    }
  });
  const restricted = makeDocument({
    id: "doc_restricted",
    body: "Refund billing policy for restricted finance records.",
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "test-namespace",
      tags: ["restricted"]
    }
  });
  const { retriever } = await makeHybridRetriever([accessible, restricted]);

  const result = await retriever.retrieve({
    query: "refund billing",
    mode: "hybrid",
    filter: makeIndexFilter(),
    topK: 5,
    candidatePoolLimit: 10,
    includeRejected: true
  });

  assert.deepEqual(
    result.candidates.map((entry) => entry.chunk.documentId),
    ["doc_accessible"]
  );
  assert.equal(
    result.rejected.some((rejection) => rejection.code === "access_denied_or_missing_chunk"),
    true
  );
});

test("runtime can answer with a profile configured for hybrid retrieval", async () => {
  const profile = assertValidProfile({
    ...genericDocsProfile,
    retrieval: {
      ...genericDocsProfile.retrieval,
      mode: "hybrid"
    }
  });
  const principal = makePrincipal({
    namespaceIds: [profile.namespaceId],
    roles: ["reader"],
    tags: ["curated", "docs"]
  });
  const { retriever } = await makeHybridRetriever(
    [
      makeDocument({
        id: "doc_hybrid_refund",
        namespaceId: profile.namespaceId,
        body: "Refund billing policy requires support review.",
        accessScope: {
          tenantId: principal.tenantId,
          namespaceId: profile.namespaceId,
          roles: ["reader"],
          tags: ["curated", "docs"]
        }
      })
    ],
    32
  );
  const runtime = new RagAnswerRuntime({
    retriever,
    now: () => FIXED_NOW
  });

  const result = await runtime.answer({
    profile,
    question: "What does the refund billing policy require?",
    filter: makeIndexFilter({
      namespaceId: profile.namespaceId,
      principal,
      tenantId: principal.tenantId
    }),
    model: new FakeModelAdapter({ now: () => FIXED_NOW }),
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "succeeded");
  assert.equal("retrieval" in result ? result.retrieval.trace.mode : undefined, "hybrid");
  assert.equal("context" in result ? result.context.evidence.status : undefined, "answerable");
  assert.equal(result.trace.retrievalId?.includes("retrieval"), true);
});

class StaticRetriever implements Retriever {
  readonly capabilities: RetrieverCapabilities;
  readonly calls: RetrievalRequest[] = [];

  constructor(
    private readonly mode: "keyword" | "vector",
    private readonly candidates: readonly RetrievalCandidate[],
    private readonly rejected: readonly RetrievalRejection[] = []
  ) {
    this.capabilities = {
      modes: [mode],
      supportsVectorSearch: mode === "vector",
      supportsHybridSearch: false
    };
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    this.calls.push(request);

    return {
      query: request.query,
      candidates: this.candidates,
      rejected: this.rejected,
      trace: traceFor(this.mode, request, this.candidates.length, this.rejected.length)
    };
  }
}

function candidate(
  chunk: RagChunk,
  score: number,
  rank: number,
  matchedTerms: readonly string[],
  reasons: readonly string[]
): RetrievalCandidate {
  return {
    chunk,
    score,
    rank,
    matchedTerms,
    citation: chunk.citation,
    reasons
  };
}

function firstChunk(document: RagDocument): RagChunk {
  const chunk = chunkDocument({ document }).chunks[0];
  assert.ok(chunk);
  return chunk;
}

function traceFor(
  mode: "keyword" | "vector",
  request: RetrievalRequest,
  returnedCount: number,
  rejectedCount: number
): RetrievalTrace {
  const normalizedQuery = request.query.trim().replace(/\s+/g, " ").toLowerCase();

  return {
    retrievalId: request.retrievalId ?? `${mode}_retrieval`,
    startedAt: request.requestedAt ?? FIXED_NOW,
    finishedAt: FIXED_NOW,
    mode,
    queryHash: hashText(request.query),
    normalizedQueryHash: hashText(normalizedQuery),
    searchTermHashes: mode === "keyword" ? [hashText("refund"), hashText("billing")] : [],
    access: redactIndexFilterForTrace(request.filter),
    candidatePoolSize: returnedCount,
    returnedCount,
    rejectedCount
  };
}

async function makeHybridRetriever(
  documents: readonly RagDocument[],
  dimensions = 32
): Promise<{
  readonly retriever: HybridRetriever;
  readonly chunkIndex: InMemoryRagIndex;
  readonly vectorStore: InMemoryVectorStore;
}> {
  const chunkIndex = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const chunks = [];
  for (const document of documents) {
    const documentChunks = chunkDocument({ document }).chunks;
    chunkIndex.addDocument(document);
    chunkIndex.addChunks(document.id, documentChunks);
    chunks.push(...documentChunks);
  }

  const embeddingAdapter = new FakeEmbeddingAdapter({ dimensions });
  const vectorStore = new InMemoryVectorStore({
    chunkStore: chunkIndex,
    dimensions,
    now: () => FIXED_NOW
  });
  await new EmbeddingIndexer({
    adapter: embeddingAdapter,
    vectorStore,
    now: () => FIXED_NOW
  }).indexChunks({
    chunks,
    requestedAt: FIXED_NOW
  });

  return {
    retriever: new HybridRetriever({
      keywordRetriever: new KeywordRetriever({ chunkStore: chunkIndex, now: () => FIXED_NOW }),
      vectorRetriever: new VectorRetriever({
        embeddingAdapter,
        vectorStore,
        now: () => FIXED_NOW
      }),
      now: () => FIXED_NOW
    }),
    chunkIndex,
    vectorStore
  };
}
