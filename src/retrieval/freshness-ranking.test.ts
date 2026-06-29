import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import { makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import {
  applyFreshnessRecencyBoostToCandidates,
  freshnessTraceForCandidates
} from "./freshness-ranking.js";
import type { RetrievalCandidate, RetrievalRequest } from "./retrieval-types.js";

test("freshness recency boost reranks retrieval candidates and preserves normal ordering otherwise", () => {
  const older = candidate("doc_a_older", "2026-01-01T00:00:00.000Z", 0.5, 1);
  const newer = candidate("doc_z_newer", "2026-06-20T00:00:00.000Z", 0.5, 2);
  const normal = applyFreshnessRecencyBoostToCandidates([older, newer], request());
  const fresh = applyFreshnessRecencyBoostToCandidates(
    [older, newer],
    request({ primary: "freshness", sourceHints: ["recent"] })
  );

  assert.deepEqual(
    normal.map((entry) => entry.chunk.documentId),
    ["doc_a_older", "doc_z_newer"]
  );
  assert.deepEqual(
    fresh.map((entry) => entry.chunk.documentId),
    ["doc_z_newer", "doc_a_older"]
  );
  assert.equal(fresh[0]?.reasons.includes("freshness_recency_boost"), true);
  assert.deepEqual(freshnessTraceForCandidates(fresh, request()), undefined);
  assert.equal(
    freshnessTraceForCandidates(fresh, request({ primary: "freshness", sourceHints: ["recent"] }))
      ?.boostedCandidateCount,
    1
  );
});

function candidate(
  documentId: string,
  capturedAt: string,
  score: number,
  rank: number
): RetrievalCandidate {
  const document = makeDocument({
    id: documentId,
    body: "Refund policy."
  });
  const chunk = chunkDocument({
    document: {
      ...document,
      provenance: {
        ...document.provenance,
        capturedAt
      }
    }
  }).chunks[0];
  assert.ok(chunk);

  return {
    chunk,
    score,
    rank,
    matchedTerms: ["refund", "policy"],
    citation: chunk.citation,
    reasons: ["test_candidate"]
  };
}

function request(intent?: RetrievalRequest["intent"]): RetrievalRequest {
  return {
    query: "refund policy",
    filter: makeIndexFilter(),
    topK: 2,
    ...(intent === undefined ? {} : { intent })
  };
}
