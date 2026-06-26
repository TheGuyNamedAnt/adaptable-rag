import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import { redactIndexFilterForTrace } from "../indexing/index-filter.js";
import type { IndexedChunk } from "../indexing/index-types.js";
import { FIXED_NOW, makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import { AdaptiveRetrievalController } from "./adaptive-retrieval-controller.js";
import type { RetrievalRequest, RetrievalResult } from "./retrieval-types.js";
import type { Retriever, RetrieverCapabilities } from "./retriever.js";

const [chunk] = chunkDocument({
  document: makeDocument({
    id: "doc_adaptive_policy",
    body: "Refund policy says billing refunds require human review."
  })
}).chunks;

assert.ok(chunk);

test("adaptive controller emits answerable strategy trace without retry", async () => {
  const retriever = new SequenceRetriever([
    result({
      request: baseRequest(),
      candidates: [
        {
          chunk,
          indexedAt: FIXED_NOW
        }
      ]
    })
  ]);
  const controller = new AdaptiveRetrievalController({ retriever, minCandidates: 1 });

  const retrieved = await controller.retrieve(baseRequest());

  assert.equal(retrieved.trace.adaptiveStrategy?.initialStrategy, "keyword_only");
  assert.equal(retrieved.trace.adaptiveStrategy?.finalDecision, "answerable");
  assert.deepEqual(retrieved.trace.adaptiveStrategy?.attemptedStrategies, ["keyword_only"]);
  assert.equal(retriever.calls.length, 1);
});

test("adaptive controller retries with expanded candidate pool when evidence is thin", async () => {
  const request = baseRequest({ topK: 2, candidatePoolLimit: 2 });
  const retriever = new SequenceRetriever([
    result({ request, candidates: [] }),
    result({
      request,
      candidates: [
        {
          chunk,
          indexedAt: FIXED_NOW
        }
      ],
      retrievalId: "retrieval_adaptive_retry"
    })
  ]);
  const controller = new AdaptiveRetrievalController({ retriever, minCandidates: 1 });

  const retrieved = await controller.retrieve(request);

  assert.equal(retriever.calls.length, 2);
  assert.equal(retriever.calls[1]?.candidatePoolLimit, 20);
  assert.equal(retrieved.candidates.length, 1);
  assert.equal(retrieved.trace.adaptiveStrategy?.retryStrategy, "expanded_candidate_pool");
  assert.equal(retrieved.trace.adaptiveStrategy?.finalDecision, "retried_answerable");
  assert.deepEqual(retrieved.trace.adaptiveStrategy?.attemptedStrategies, [
    "keyword_only",
    "expanded_candidate_pool"
  ]);
});

test("adaptive controller refuses access-denied retrieval without retry", async () => {
  const request = baseRequest();
  const retriever = new SequenceRetriever([
    {
      ...result({ request, candidates: [] }),
      rejected: [
        {
          code: "access_denied_or_missing_chunk",
          reason: "Chunk was not found or access was denied."
        }
      ]
    }
  ]);
  const controller = new AdaptiveRetrievalController({ retriever });

  const retrieved = await controller.retrieve(request);

  assert.equal(retriever.calls.length, 1);
  assert.equal(retrieved.trace.adaptiveStrategy?.diagnosis.code, "access_denied_or_missing_source");
  assert.equal(retrieved.trace.adaptiveStrategy?.finalDecision, "refused");
});

class SequenceRetriever implements Retriever {
  readonly capabilities: RetrieverCapabilities = {
    modes: ["keyword"],
    supportsVectorSearch: false,
    supportsHybridSearch: false
  };

  readonly calls: RetrievalRequest[] = [];
  private readonly results: RetrievalResult[];

  constructor(results: RetrievalResult[]) {
    this.results = results;
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    this.calls.push(request);
    const result = this.results.shift();
    if (!result) {
      throw new Error("No retrieval result queued.");
    }
    return {
      ...result,
      trace: {
        ...result.trace,
        retrievalId: request.retrievalId ?? result.trace.retrievalId
      }
    };
  }
}

function baseRequest(overrides: Partial<RetrievalRequest> = {}): RetrievalRequest {
  return {
    query: "refund policy",
    filter: makeIndexFilter(),
    topK: 1,
    mode: "keyword",
    retrievalId: "retrieval_adaptive",
    requestedAt: FIXED_NOW,
    ...overrides
  };
}

function result(input: {
  readonly request: RetrievalRequest;
  readonly candidates: readonly IndexedChunk[];
  readonly retrievalId?: string;
}): RetrievalResult {
  return {
    query: input.request.query,
    candidates: input.candidates.map((indexed, index) => ({
      chunk: indexed.chunk,
      score: 1 - index / 10,
      rank: index + 1,
      matchedTerms: ["refund", "policy"],
      citation: indexed.chunk.citation,
      reasons: ["stub_match"]
    })),
    rejected: [],
    trace: {
      retrievalId: input.retrievalId ?? input.request.retrievalId ?? "retrieval_adaptive",
      startedAt: FIXED_NOW,
      finishedAt: FIXED_NOW,
      mode: input.request.mode ?? "keyword",
      queryHash: "hash_query",
      normalizedQueryHash: "hash_normalized",
      searchTermHashes: ["hash_refund", "hash_policy"],
      access: redactIndexFilterForTrace(input.request.filter),
      candidatePoolSize: input.candidates.length,
      returnedCount: input.candidates.length,
      rejectedCount: 0
    }
  };
}
