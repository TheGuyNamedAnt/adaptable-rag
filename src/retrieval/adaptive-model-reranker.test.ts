import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { RagChunk } from "../documents/chunk.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { FIXED_NOW, makeDocument } from "../test-support/fixtures.js";
import { AdaptiveModelReranker, adaptiveModelRerankReasons } from "./adaptive-model-reranker.js";
import { LightweightReranker } from "./lightweight-reranker.js";
import {
  ModelBackedReranker,
  type RerankModelAdapter,
  type RerankModelRequest,
  type RerankModelResult
} from "./model-reranker.js";
import type { RerankProfileConfig } from "./reranker.js";
import type { RetrievalCandidate } from "./retrieval-types.js";

const validatedProfile = assertValidProfile({
  ...genericDocsProfile,
  namespaceId: "test-namespace"
});
const profile: RerankProfileConfig = {
  id: validatedProfile.id,
  namespaceId: validatedProfile.namespaceId,
  modelTier: validatedProfile.modelPolicy.defaultTierByRole.context_evaluation,
  allowModelFallback: true
};

class RecordingRerankModelAdapter implements RerankModelAdapter {
  readonly id = "recording-rerank-model";
  readonly provider = "test";
  readonly modelName = "recording-reranker";
  requests: RerankModelRequest[] = [];

  async rerank(request: RerankModelRequest): Promise<RerankModelResult> {
    this.requests.push(request);
    return {
      status: "succeeded",
      scores: request.candidates.map((candidate, index) => ({
        chunkId: candidate.chunkId,
        score: 1 - index * 0.1,
        reason: "adaptive_test"
      })),
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

test("adaptive model reranker skips model calls for confident low-risk candidates", async () => {
  const adapter = new RecordingRerankModelAdapter();
  const reranker = new AdaptiveModelReranker({
    modelReranker: new ModelBackedReranker({ adapter, now: () => FIXED_NOW }),
    lightweightReranker: new LightweightReranker({ now: () => FIXED_NOW })
  });

  const result = await reranker.rerank({
    profile,
    query: "account setup",
    candidates: [
      candidate(
        firstChunk(
          makeDocument({
            id: "doc_setup",
            body: "Account setup instructions for workspace onboarding."
          })
        ),
        1,
        1
      )
    ],
    topK: 1,
    rerankId: "adaptive_skip_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(adapter.requests.length, 0);
  assert.equal(result.trace.mode, "lightweight");
  assert.equal(result.trace.warningCodes.includes("adaptive_model_rerank_skipped"), true);
});

test("adaptive model reranker triggers model calls and records reasons for risky queries", async () => {
  const adapter = new RecordingRerankModelAdapter();
  const reranker = new AdaptiveModelReranker({
    modelReranker: new ModelBackedReranker({ adapter, now: () => FIXED_NOW }),
    lightweightReranker: new LightweightReranker({ now: () => FIXED_NOW })
  });
  const first = firstChunk(
    makeDocument({
      id: "doc_refund_a",
      body: "Refund billing cancellation evidence is covered in the support policy."
    })
  );
  const duplicate = firstChunk(
    makeDocument({
      id: "doc_refund_b",
      body: "Refund billing cancellation evidence is covered in the support policy."
    })
  );

  const result = await reranker.rerank({
    profile,
    query: "Can I get a refund and cancel billing?",
    candidates: [candidate(first, 0.5, 1), candidate(duplicate, 0.49, 2)],
    topK: 1,
    rerankId: "adaptive_trigger_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(adapter.requests.length, 1);
  assert.equal(result.trace.mode, "model");
  assert.equal(result.trace.warningCodes.includes("adaptive_model_rerank_triggered"), true);
  assert.equal(result.trace.warningCodes.includes("adaptive_reason:high_risk_query"), true);
  assert.equal(result.trace.warningCodes.includes("adaptive_reason:duplicate_evidence"), true);
});

test("adaptive model rerank reason detector reports score and context pressure signals", async () => {
  const lightweight = new LightweightReranker({ now: () => FIXED_NOW });
  const candidates = Array.from({ length: 8 }, (_, index) =>
    candidate(
      firstChunk(
        makeDocument({
          id: `doc_${index}`,
          body: `General onboarding setup step ${index}.`
        })
      ),
      0.1,
      index + 1
    )
  );
  const request = {
    profile,
    query: "setup",
    candidates,
    topK: 2,
    rerankId: "adaptive_reasons_test",
    requestedAt: FIXED_NOW
  };
  const result = await lightweight.rerank(request);
  const reasons = adaptiveModelRerankReasons({
    request,
    lightweight: result,
    lowTopScoreThreshold: 0.9
  });

  assert.equal(reasons.includes("low_top_score"), true);
  assert.equal(reasons.includes("context_budget_pressure"), true);
});

function firstChunk(document: ReturnType<typeof makeDocument>): RagChunk {
  const [chunk] = chunkDocument({ document }).chunks;
  assert.ok(chunk);
  return chunk;
}

function candidate(chunk: RagChunk, score: number, rank: number): RetrievalCandidate {
  return {
    chunk,
    score,
    rank,
    matchedTerms: [],
    citation: chunk.citation,
    reasons: ["keyword_term_match"]
  };
}
