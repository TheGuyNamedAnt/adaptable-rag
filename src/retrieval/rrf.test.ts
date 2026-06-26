import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import { makeDocument } from "../test-support/fixtures.js";
import { mergeCandidatesByRrf, reciprocalRankScore } from "./rrf.js";
import type { RetrievalCandidate } from "./retrieval-types.js";

test("reciprocal rank fusion promotes chunks that rank well in multiple sources", () => {
  const shared = firstChunk(
    makeDocument({
      id: "doc_shared",
      body: "Refund billing policy appears in both retrieval tracks."
    })
  );
  const keywordOnly = firstChunk(
    makeDocument({
      id: "doc_keyword",
      body: "Refund policy exact keyword match."
    })
  );
  const vectorOnly = firstChunk(
    makeDocument({
      id: "doc_vector",
      body: "Billing exception review semantic match."
    })
  );

  const merged = mergeCandidatesByRrf(
    [
      {
        candidates: [
          candidate(keywordOnly, 10, 1, ["refund"], ["keyword_term_match"]),
          candidate(shared, 5, 2, ["refund", "billing"], ["keyword_term_match"])
        ],
        weight: 1,
        componentReason: "keyword_component"
      },
      {
        candidates: [
          candidate(shared, 0.8, 1, [], ["vector_similarity"]),
          candidate(vectorOnly, 0.8, 2, [], ["vector_similarity"])
        ],
        weight: 1,
        componentReason: "vector_component"
      }
    ],
    {
      scoreReason: "rrf_score"
    }
  );

  assert.deepEqual(
    merged.map((entry) => entry.chunk.documentId),
    ["doc_shared", "doc_keyword", "doc_vector"]
  );
  assert.equal(merged[0]?.reasons.includes("rrf_score"), true);
  assert.equal(merged[0]?.reasons.includes("keyword_component"), true);
  assert.equal(merged[0]?.reasons.includes("vector_component"), true);
  assert.equal(merged[0]?.score, 0.032522);
});

test("reciprocal rank score validates unsafe inputs", () => {
  assert.equal(reciprocalRankScore(1, 60, 1), 1 / 61);
  assert.throws(() => reciprocalRankScore(0), /rank/);
  assert.throws(() => reciprocalRankScore(1, 0), /k/);
  assert.throws(() => reciprocalRankScore(1, 60, -1), /weight/);
});

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
