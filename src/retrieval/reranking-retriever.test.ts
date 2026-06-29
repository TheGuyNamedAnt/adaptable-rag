import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { RagChunk } from "../documents/chunk.js";
import { redactIndexFilterForTrace } from "../indexing/index-filter.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { FIXED_NOW, makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import { LightweightReranker } from "./lightweight-reranker.js";
import {
  ModelBackedReranker,
  type RerankModelAdapter,
  type RerankModelRequest,
  type RerankModelResult,
  type RerankModelScore
} from "./model-reranker.js";
import { RerankingRetriever } from "./reranking-retriever.js";
import type { Retriever, RetrieverCapabilities } from "./retriever.js";
import type {
  RetrievalCandidate,
  RetrievalRequest,
  RetrievalResult,
  RetrievalTrace
} from "./retrieval-types.js";

const validatedProfile = assertValidProfile({
  ...genericDocsProfile,
  namespaceId: "test-namespace",
  retrieval: {
    ...genericDocsProfile.retrieval,
    mode: "keyword",
    rerankMode: "lightweight"
  }
});
const profile = {
  id: validatedProfile.id,
  namespaceId: validatedProfile.namespaceId,
  modelTier: validatedProfile.modelPolicy.defaultTierByRole.context_evaluation,
  allowModelFallback: validatedProfile.modelPolicy.allowModelFallback
};

class StaticRetriever implements Retriever {
  readonly capabilities: RetrieverCapabilities = {
    modes: ["keyword"],
    supportsVectorSearch: false,
    supportsHybridSearch: false
  };
  readonly calls: RetrievalRequest[] = [];

  constructor(private readonly candidates: readonly RetrievalCandidate[]) {}

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    this.calls.push(request);
    const returned = this.candidates.slice(0, request.topK);
    return {
      query: request.query,
      candidates: returned,
      rejected: [],
      trace: trace(request, returned)
    };
  }
}

class StaticRerankModelAdapter implements RerankModelAdapter {
  readonly id = "static-rerank-model";
  readonly provider = "test";
  readonly modelName = "static-reranker";

  constructor(
    private readonly scores: readonly RerankModelScore[],
    private readonly failWith?: string
  ) {}

  async rerank(request: RerankModelRequest): Promise<RerankModelResult> {
    if (this.failWith) {
      return {
        status: "failed",
        scores: [],
        provider: this.provider,
        modelName: this.modelName,
        completedAt: request.requestedAt ?? FIXED_NOW,
        latencyMs: 5,
        cost: {
          amountUsd: 0,
          currency: "USD"
        },
        warnings: ["model_failed"],
        errorMessage: this.failWith
      };
    }

    return {
      status: "succeeded",
      scores: this.scores,
      provider: this.provider,
      modelName: this.modelName,
      completedAt: request.requestedAt ?? FIXED_NOW,
      latencyMs: 5,
      cost: {
        amountUsd: 0.001,
        currency: "USD"
      },
      warnings: []
    };
  }
}

test("lightweight reranking reorders candidates without leaking raw query or text in traces", async () => {
  const login = firstChunk(
    makeDocument({
      id: "doc_login",
      body: "Login password reset steps for account recovery."
    })
  );
  const refund = firstChunk(
    makeDocument({
      id: "doc_refund",
      body: "Refund billing policy requires support review."
    })
  );
  const child = new StaticRetriever([
    candidate(login, 0.2, 1, ["keyword_term_match"]),
    candidate(refund, 0.2, 2, ["keyword_term_match"])
  ]);
  const retriever = new RerankingRetriever({
    profile,
    retriever: child,
    reranker: new LightweightReranker({ now: () => FIXED_NOW }),
    now: () => FIXED_NOW
  });

  const result = await retriever.retrieve({
    query: "refund billing",
    mode: "keyword",
    filter: makeIndexFilter(),
    topK: 1,
    retrievalId: "rerank_retrieval_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.chunk.documentId, "doc_refund");
  assert.equal(result.candidates[0]?.rank, 1);
  assert.equal(result.candidates[0]?.reasons.includes("lightweight_rerank"), true);
  assert.equal(child.calls[0]?.topK, 20);
  assert.equal(result.rerank?.mode, "lightweight");
  assert.equal(result.trace.rerankId, "rerank_retrieval_test_rerank");
  assert.equal(JSON.stringify(result.trace).includes("refund billing"), false);
  assert.equal(JSON.stringify(result.rerank).includes("Refund billing policy"), false);
});

test("lightweight reranking boosts precise citation evidence", async () => {
  const generic = firstChunk(
    makeDocument({
      id: "doc_generic",
      body: "Refund billing policy requires support review."
    })
  );
  const cited = withCitationEvidence(
    firstChunk(
      makeDocument({
        id: "doc_cited",
        body: "Refund billing policy requires support review."
      })
    )
  );
  const child = new StaticRetriever([
    candidate(generic, 0.5, 1, ["keyword_term_match"]),
    candidate(cited, 0.5, 1, ["keyword_term_match"])
  ]);
  const retriever = new RerankingRetriever({
    profile,
    retriever: child,
    reranker: new LightweightReranker({ now: () => FIXED_NOW }),
    now: () => FIXED_NOW
  });

  const result = await retriever.retrieve({
    query: "refund billing",
    mode: "keyword",
    filter: makeIndexFilter(),
    topK: 1,
    retrievalId: "lightweight_citation_quality_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.candidates[0]?.chunk.documentId, "doc_cited");
  assert.equal(result.candidates[0]?.reasons.includes("lightweight_citation_quality"), true);
});

test("lightweight reranking routes table questions toward table-derived chunks", async () => {
  const generic = firstChunk(
    makeDocument({
      id: "doc_table_generic",
      body: "North America revenue 120 appears in the appendix."
    })
  );
  const table = withSearchableUnit(
    firstChunk(
      makeDocument({
        id: "doc_table_row",
        body: "North America revenue 120 appears in the appendix."
      })
    ),
    "table_row_chunk"
  );
  const child = new StaticRetriever([
    candidate(generic, 0.65, 1, ["keyword_term_match"]),
    candidate(table, 0.61, 2, ["keyword_term_match"])
  ]);
  const retriever = new RerankingRetriever({
    profile,
    retriever: child,
    reranker: new LightweightReranker({ now: () => FIXED_NOW }),
    now: () => FIXED_NOW
  });

  const result = await retriever.retrieve({
    query: "which table row has revenue 120",
    mode: "keyword",
    filter: makeIndexFilter(),
    topK: 1,
    retrievalId: "lightweight_table_unit_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.candidates[0]?.chunk.documentId, "doc_table_row");
  assert.equal(result.candidates[0]?.reasons.includes("lightweight_searchable_unit_match"), true);
});

test("lightweight reranking routes formula questions toward equation-derived chunks", async () => {
  const generic = firstChunk(
    makeDocument({
      id: "doc_formula_generic",
      body: "The appendix discusses retention metrics and model quality."
    })
  );
  const equation = withSearchableUnit(
    firstChunk(
      makeDocument({
        id: "doc_equation_retention",
        body: "x = y + z"
      })
    ),
    "equation_chunk",
    ["Equation", "Metric: retention formula", "Text: x = y + z", "Page: 4"].join("\n")
  );
  const child = new StaticRetriever([
    candidate(generic, 0.66, 1, ["keyword_term_match"]),
    candidate(equation, 0.6, 2, ["keyword_term_match"])
  ]);
  const retriever = new RerankingRetriever({
    profile,
    retriever: child,
    reranker: new LightweightReranker({ now: () => FIXED_NOW }),
    now: () => FIXED_NOW
  });

  const result = await retriever.retrieve({
    query: "retention formula equation",
    mode: "keyword",
    filter: makeIndexFilter(),
    topK: 1,
    retrievalId: "lightweight_equation_unit_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.candidates[0]?.chunk.documentId, "doc_equation_retention");
  assert.equal(result.candidates[0]?.reasons.includes("lightweight_searchable_unit_match"), true);
});

test("lightweight reranking downgrades parser gap chunks as answer evidence", async () => {
  const answer = firstChunk(
    makeDocument({
      id: "doc_answer",
      body: "OCR page notes say the scanned appendix needs manual review."
    })
  );
  const parserGap = withSearchableUnit(
    firstChunk(
      makeDocument({
        id: "doc_parser_gap",
        body: "OCR page notes say the scanned appendix needs manual review."
      })
    ),
    "parser_gap_chunk"
  );
  const child = new StaticRetriever([
    candidate(parserGap, 0.9, 1, ["keyword_term_match"]),
    candidate(answer, 0.85, 2, ["keyword_term_match"])
  ]);
  const retriever = new RerankingRetriever({
    profile,
    retriever: child,
    reranker: new LightweightReranker({ now: () => FIXED_NOW }),
    now: () => FIXED_NOW
  });

  const result = await retriever.retrieve({
    query: "ocr page manual review",
    mode: "keyword",
    filter: makeIndexFilter(),
    topK: 2,
    retrievalId: "lightweight_parser_gap_unit_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.candidates[0]?.chunk.documentId, "doc_answer");
  assert.equal(result.candidates[1]?.reasons.includes("lightweight_parser_gap_downgrade"), true);
});

test("lightweight reranking diversifies near-duplicate evidence", async () => {
  const first = firstChunk(
    makeDocument({
      id: "doc_first_duplicate",
      body: "Refund billing cancellation evidence is covered in the support policy."
    })
  );
  const duplicate = firstChunk(
    makeDocument({
      id: "doc_second_duplicate",
      body: "Refund billing cancellation evidence is covered in the support policy."
    })
  );
  const complementary = firstChunk(
    makeDocument({
      id: "doc_complementary",
      body: "Refund requests after cancellation require the original receipt."
    })
  );
  const child = new StaticRetriever([
    candidate(first, 1, 1, ["keyword_term_match"]),
    candidate(duplicate, 0.98, 2, ["keyword_term_match"]),
    candidate(complementary, 0.94, 3, ["keyword_term_match"])
  ]);
  const retriever = new RerankingRetriever({
    profile,
    retriever: child,
    reranker: new LightweightReranker({ now: () => FIXED_NOW }),
    now: () => FIXED_NOW
  });

  const result = await retriever.retrieve({
    query: "refund billing cancellation",
    mode: "keyword",
    filter: makeIndexFilter(),
    topK: 2,
    retrievalId: "lightweight_diversity_test",
    requestedAt: FIXED_NOW
  });

  assert.deepEqual(
    result.candidates.map((entry) => entry.chunk.documentId),
    ["doc_first_duplicate", "doc_complementary"]
  );
});

test("model reranking cannot introduce unknown candidate chunk ids", async () => {
  const first = firstChunk(
    makeDocument({
      id: "doc_first",
      body: "Refund billing policy requires support review."
    })
  );
  const second = firstChunk(
    makeDocument({
      id: "doc_second",
      body: "Login password reset steps for account recovery."
    })
  );
  const child = new StaticRetriever([
    candidate(first, 0.1, 1, ["keyword_term_match"]),
    candidate(second, 0.9, 2, ["keyword_term_match"])
  ]);
  const retriever = new RerankingRetriever({
    profile,
    retriever: child,
    reranker: new ModelBackedReranker({
      adapter: new StaticRerankModelAdapter([
        { chunkId: "chunk_not_in_candidates", score: 1, reason: "unknown" },
        { chunkId: first.id, score: 0.8, reason: "best_supported" }
      ]),
      now: () => FIXED_NOW
    }),
    now: () => FIXED_NOW
  });

  const result = await retriever.retrieve({
    query: "refund billing",
    mode: "keyword",
    filter: makeIndexFilter(),
    topK: 1,
    retrievalId: "model_rerank_test",
    requestedAt: FIXED_NOW
  });

  assert.deepEqual(
    result.candidates.map((entry) => entry.chunk.documentId),
    ["doc_first"]
  );
  assert.equal(result.rejected[0]?.code, "rerank_unknown_candidate");
  assert.equal(result.rerank?.provider, "test");
  assert.equal(result.rerank?.modelTier, "strong");
});

test("model reranking reports invalid scored candidates when valid scores remain", async () => {
  const refund = firstChunk(
    makeDocument({
      id: "doc_refund",
      body: "Refund billing policy requires support review."
    })
  );
  const login = firstChunk(
    makeDocument({
      id: "doc_login",
      body: "Login password reset steps for account recovery."
    })
  );
  const child = new StaticRetriever([
    candidate(refund, 0.4, 1, ["keyword_term_match"]),
    candidate(login, 0.5, 2, ["keyword_term_match"])
  ]);
  const retriever = new RerankingRetriever({
    profile,
    retriever: child,
    reranker: new ModelBackedReranker({
      adapter: new StaticRerankModelAdapter([
        { chunkId: refund.id, score: 0.8, reason: "supported" },
        { chunkId: login.id, score: Number.POSITIVE_INFINITY, reason: "bad_score" }
      ]),
      now: () => FIXED_NOW
    }),
    now: () => FIXED_NOW
  });

  const result = await retriever.retrieve({
    query: "refund billing",
    mode: "keyword",
    filter: makeIndexFilter(),
    topK: 2,
    retrievalId: "model_rerank_partial_invalid_score_test",
    requestedAt: FIXED_NOW
  });

  assert.deepEqual(
    result.candidates.map((entry) => entry.chunk.documentId),
    ["doc_refund"]
  );
  assert.equal(result.rejected[0]?.code, "rerank_invalid_score");
  assert.equal(result.rejected[0]?.chunkId, login.id);
  assert.equal(result.rerank?.warningCodes.length, 0);
});

test("model reranking ignores duplicate scores and uses stable tie breakers", async () => {
  const alpha = firstChunk(
    makeDocument({
      id: "doc_alpha",
      body: "Alpha policy details for account support."
    })
  );
  const beta = firstChunk(
    makeDocument({
      id: "doc_beta",
      body: "Beta policy details for account support."
    })
  );
  const gamma = firstChunk(
    makeDocument({
      id: "doc_gamma",
      body: "Gamma policy details for account support."
    })
  );
  const child = new StaticRetriever([
    candidate(beta, 0.5, 1, ["keyword_term_match"]),
    candidate(alpha, 0.5, 1, ["keyword_term_match"]),
    candidate(gamma, 0.5, 3, ["keyword_term_match"])
  ]);
  const retriever = new RerankingRetriever({
    profile,
    retriever: child,
    reranker: new ModelBackedReranker({
      adapter: new StaticRerankModelAdapter([
        { chunkId: gamma.id, score: 0.7, reason: "same_score" },
        { chunkId: beta.id, score: 0.7, reason: "same_score" },
        { chunkId: alpha.id, score: 0.7, reason: "same_score" },
        { chunkId: beta.id, score: 1, reason: "duplicate_score" }
      ]),
      now: () => FIXED_NOW
    }),
    now: () => FIXED_NOW
  });

  const result = await retriever.retrieve({
    query: "account support policy",
    mode: "keyword",
    filter: makeIndexFilter(),
    topK: 3,
    retrievalId: "model_rerank_tie_break_test",
    requestedAt: FIXED_NOW
  });
  const sameRankExpected = [alpha, beta]
    .slice()
    .sort((first, second) => first.id.localeCompare(second.id))
    .map((chunk) => chunk.documentId);

  assert.deepEqual(
    result.candidates.map((entry) => entry.chunk.documentId),
    [...sameRankExpected, "doc_gamma"]
  );
  assert.deepEqual(
    result.candidates.map((entry) => entry.score),
    [0.7, 0.7, 0.7]
  );
});

test("model reranking falls back when the model adapter fails and fallback is allowed", async () => {
  const login = firstChunk(
    makeDocument({
      id: "doc_login",
      body: "Login password reset steps for account recovery."
    })
  );
  const refund = firstChunk(
    makeDocument({
      id: "doc_refund",
      body: "Refund billing policy requires support review."
    })
  );
  const child = new StaticRetriever([
    candidate(login, 0.2, 1, ["keyword_term_match"]),
    candidate(refund, 0.2, 2, ["keyword_term_match"])
  ]);
  const retriever = new RerankingRetriever({
    profile,
    retriever: child,
    reranker: new ModelBackedReranker({
      adapter: new StaticRerankModelAdapter([], "rerank provider unavailable"),
      now: () => FIXED_NOW
    }),
    now: () => FIXED_NOW
  });

  const result = await retriever.retrieve({
    query: "refund billing",
    mode: "keyword",
    filter: makeIndexFilter(),
    topK: 1,
    retrievalId: "model_rerank_fallback_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.candidates[0]?.chunk.documentId, "doc_refund");
  assert.equal(result.rejected[0]?.code, "model_rerank_failed");
  assert.deepEqual(result.rerank?.warningCodes, ["model_rerank_failed", "model_rerank_fallback"]);
});

test("model reranking rejects invalid scores and falls back when no valid scores remain", async () => {
  const refund = firstChunk(
    makeDocument({
      id: "doc_refund",
      body: "Refund billing policy requires support review."
    })
  );
  const child = new StaticRetriever([candidate(refund, 0.2, 1, ["keyword_term_match"])]);
  const retriever = new RerankingRetriever({
    profile,
    retriever: child,
    reranker: new ModelBackedReranker({
      adapter: new StaticRerankModelAdapter([{ chunkId: refund.id, score: Number.NaN }]),
      now: () => FIXED_NOW
    }),
    now: () => FIXED_NOW
  });

  const result = await retriever.retrieve({
    query: "refund billing",
    mode: "keyword",
    filter: makeIndexFilter(),
    topK: 1,
    retrievalId: "model_rerank_invalid_score_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.candidates[0]?.chunk.documentId, "doc_refund");
  assert.equal(result.rejected[0]?.code, "model_rerank_failed");
  assert.deepEqual(result.rerank?.warningCodes, ["model_rerank_empty", "model_rerank_fallback"]);
});

test("model reranking throws on model failure when fallback is disabled", async () => {
  const refund = firstChunk(
    makeDocument({
      id: "doc_refund",
      body: "Refund billing policy requires support review."
    })
  );
  const reranker = new ModelBackedReranker({
    adapter: new StaticRerankModelAdapter([], "rerank provider unavailable"),
    now: () => FIXED_NOW
  });

  await assert.rejects(
    () =>
      reranker.rerank({
        profile: {
          ...profile,
          allowModelFallback: false
        },
        query: "refund billing",
        candidates: [candidate(refund, 0.2, 1, ["keyword_term_match"])],
        topK: 1,
        rerankId: "model_rerank_no_fallback_test",
        requestedAt: FIXED_NOW
      }),
    /rerank provider unavailable/
  );
});

function firstChunk(document: ReturnType<typeof makeDocument>): RagChunk {
  const [chunk] = chunkDocument({ document }).chunks;
  assert.ok(chunk);
  return chunk;
}

function withCitationEvidence(chunk: RagChunk): RagChunk {
  return {
    ...chunk,
    layoutRegionIds: ["region_refund_policy"],
    boundingBoxes: [
      {
        pageNumber: 3,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.1,
        unit: "normalized"
      }
    ],
    citation: {
      ...chunk.citation,
      locator: "page 3, paragraph 2",
      pageNumber: 3,
      layoutRegionIds: ["region_refund_policy"],
      boundingBoxes: [
        {
          pageNumber: 3,
          x: 0.1,
          y: 0.2,
          width: 0.3,
          height: 0.1,
          unit: "normalized"
        }
      ]
    }
  };
}

function withSearchableUnit(
  chunk: RagChunk,
  searchableUnitType: string,
  searchableEmbeddingText?: string
): RagChunk {
  return {
    ...chunk,
    metadata: {
      ...(chunk.metadata ?? {}),
      searchableUnitType,
      ...(searchableEmbeddingText === undefined ? {} : { searchableEmbeddingText })
    }
  };
}

function candidate(
  chunk: RagChunk,
  score: number,
  rank: number,
  reasons: readonly string[]
): RetrievalCandidate {
  return {
    chunk,
    score,
    rank,
    matchedTerms: [],
    citation: chunk.citation,
    reasons
  };
}

function trace(
  request: RetrievalRequest,
  candidates: readonly RetrievalCandidate[]
): RetrievalTrace {
  return {
    retrievalId: request.retrievalId ?? "retrieval_static",
    startedAt: request.requestedAt ?? FIXED_NOW,
    finishedAt: FIXED_NOW,
    mode: request.mode ?? "keyword",
    queryHash: "query_hash",
    normalizedQueryHash: "normalized_query_hash",
    searchTermHashes: [],
    access: redactIndexFilterForTrace(request.filter),
    candidatePoolSize: candidates.length,
    returnedCount: candidates.length,
    rejectedCount: 0
  };
}
