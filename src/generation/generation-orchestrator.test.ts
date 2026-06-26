import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import { ContextBuilder } from "../context/context-builder.js";
import type { ContextBuildResult } from "../context/context-types.js";
import type { RagDocument } from "../documents/document.js";
import type { CitationPointer } from "../documents/provenance.js";
import type { TrustTier } from "../documents/trust-tier.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import {
  ModelBackedGroundingJudge,
  type GroundingJudgeIssue,
  type GroundingJudgeModelAdapter,
  type GroundingJudgeModelRequest,
  type GroundingJudgeModelResult,
  type GroundingJudgeVerdict
} from "../answer/grounding-judge.js";
import { FakeModelAdapter } from "../model/fake-model-adapter.js";
import type {
  ModelAdapter,
  ModelGenerateRequest,
  ModelGenerateResult
} from "../model/model-types.js";
import type { RagProfile } from "../profiles/profile.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile, type ValidatedRagProfile } from "../profiles/profile-validation.js";
import { KeywordRetriever } from "../retrieval/keyword-retriever.js";
import { FIXED_NOW, makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import { GenerationOrchestrator } from "./generation-orchestrator.js";

function profileForTest(overrides: Partial<RagProfile> = {}): ValidatedRagProfile {
  return assertValidProfile({
    ...genericDocsProfile,
    namespaceId: "test-namespace",
    ...overrides,
    modelPolicy: {
      ...genericDocsProfile.modelPolicy,
      ...(overrides.modelPolicy ?? {})
    },
    contextBudget: {
      ...genericDocsProfile.contextBudget,
      ...(overrides.contextBudget ?? {})
    },
    citationPolicy: {
      ...genericDocsProfile.citationPolicy,
      ...(overrides.citationPolicy ?? {})
    },
    trustPolicy: {
      ...genericDocsProfile.trustPolicy,
      ...(overrides.trustPolicy ?? {})
    },
    outputContract: {
      ...genericDocsProfile.outputContract,
      ...(overrides.outputContract ?? {})
    },
    actionPolicy: {
      ...genericDocsProfile.actionPolicy,
      ...(overrides.actionPolicy ?? {})
    },
    costLatencyBudget: {
      ...genericDocsProfile.costLatencyBudget,
      ...(overrides.costLatencyBudget ?? {})
    },
    redactionPolicy: {
      ...genericDocsProfile.redactionPolicy,
      ...(overrides.redactionPolicy ?? {})
    },
    securityPolicy: {
      ...genericDocsProfile.securityPolicy,
      ...(overrides.securityPolicy ?? {})
    },
    observabilityPolicy: {
      ...genericDocsProfile.observabilityPolicy,
      ...(overrides.observabilityPolicy ?? {})
    }
  });
}

function makeIndexWithDocuments(documents: readonly RagDocument[]): InMemoryRagIndex {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });

  for (const document of documents) {
    const chunks = chunkDocument({ document }).chunks;
    index.addDocument(document);
    index.addChunks(document.id, chunks);
  }

  return index;
}

async function buildContext(
  documents: readonly RagDocument[],
  profile = profileForTest(),
  query = "refund policy"
): Promise<ContextBuildResult> {
  const index = makeIndexWithDocuments(documents);
  const retriever = new KeywordRetriever({ chunkStore: index, now: () => FIXED_NOW });
  const retrieval = await retriever.retrieve({
    query,
    filter: makeIndexFilter(),
    topK: 10,
    retrievalId: "retrieval_generation_test",
    requestedAt: FIXED_NOW
  });
  const builder = new ContextBuilder({ now: () => FIXED_NOW });

  return builder.build({
    profile,
    retrieval,
    contextId: "context_generation_test",
    requestedAt: FIXED_NOW
  });
}

function withTrustTier(document: RagDocument, trustTier: TrustTier): RagDocument {
  return {
    ...document,
    provenance: {
      ...document.provenance,
      trustTier
    }
  };
}

class CountingModelAdapter implements ModelAdapter {
  readonly id = "counting";
  readonly provider = "test";
  readonly modelName = "counting-model";
  callCount = 0;

  async generate(request: ModelGenerateRequest): Promise<ModelGenerateResult> {
    this.callCount += 1;
    return new FakeModelAdapter({ now: () => FIXED_NOW }).generate(request);
  }
}

class ThrowingModelAdapter implements ModelAdapter {
  readonly id = "throwing";
  readonly provider = "test";
  readonly modelName = "throwing-model";

  async generate(): Promise<ModelGenerateResult> {
    throw new Error("adapter exploded");
  }
}

class StaticGroundingJudgeAdapter implements GroundingJudgeModelAdapter {
  readonly id = "static-grounding-judge";
  readonly provider = "test";
  readonly modelName = "static-judge-model";

  private readonly verdict: GroundingJudgeVerdict;
  private readonly issues: readonly GroundingJudgeIssue[];
  private readonly fail: boolean;

  constructor(options: {
    readonly verdict: GroundingJudgeVerdict;
    readonly issues?: readonly GroundingJudgeIssue[];
    readonly fail?: boolean;
  }) {
    this.verdict = options.verdict;
    this.issues = options.issues ?? [];
    this.fail = options.fail ?? false;
  }

  async judge(request: GroundingJudgeModelRequest): Promise<GroundingJudgeModelResult> {
    if (this.fail) {
      throw new Error("judge unavailable");
    }

    return {
      verdict: this.verdict,
      issues: this.issues,
      provider: this.provider,
      modelName: this.modelName,
      completedAt: request.requestedAt ?? FIXED_NOW,
      latencyMs: 7,
      cost: {
        amountUsd: 0.002,
        currency: "USD"
      },
      warnings: []
    };
  }
}

test("runs a successful gated generation flow", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [
      makeDocument({
        id: "doc_refunds",
        body: "Refund policy says billing refunds require human review."
      })
    ],
    profile
  );
  const orchestrator = new GenerationOrchestrator({ now: () => FIXED_NOW });

  const result = await orchestrator.run({
    profile,
    context,
    question: "What is the refund policy?",
    model: new FakeModelAdapter({ latencyMs: 12, estimatedCostUsd: 0.001, now: () => FIXED_NOW }),
    generationId: "generation_test",
    answerId: "answer_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.draft?.answer, "Generated answer from approved context.");
  assert.equal(result.validation?.valid, true);
  assert.equal(result.trace.model.attempted, true);
  assert.equal(result.trace.model.provider, "fake");
  assert.equal(result.trace.model.requestId, "model_generation_test");
  assert.equal(result.trace.model.latencyMs, 12);
  assert.equal(result.trace.model.estimatedCostUsd, 0.001);
  assert.equal(result.resolvedCitations[0]?.chunkId, context.blocks[0]?.chunkId);
  assert.equal(result.warnings.length, 0);
});

test("resolves model chunk ids to full context citations with visual asset metadata", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [
      makeDocument({
        id: "doc_visual_answer_citation",
        body: "Spreadsheet chart shows revenue by quarter."
      })
    ],
    profile,
    "spreadsheet chart"
  );
  const block = context.blocks[0];
  assert.ok(block);
  const chunkId = block.chunkId;
  const visualCitation: CitationPointer = {
    ...block.citation,
    visualAssetId: "sheet_1_chart_1",
    visualAsset: {
      id: "sheet_1_chart_1",
      kind: "figure",
      mediaType: "image/svg+xml",
      pageNumber: 1,
      assetType: "chart",
      title: "Revenue by Quarter",
      chartType: "BarChart",
      sheetName: "Model",
      anchorCell: "R2C5"
    }
  };
  const visualContext: ContextBuildResult = {
    ...context,
    blocks: [{ ...block, citation: visualCitation }],
    citations: [visualCitation]
  };
  const orchestrator = new GenerationOrchestrator({ now: () => FIXED_NOW });

  const result = await orchestrator.run({
    profile,
    context: visualContext,
    question: "What does the spreadsheet chart show?",
    model: new FakeModelAdapter({
      draft: {
        answer: "The chart shows revenue by quarter.",
        citationChunkIds: [chunkId],
        evidenceSummary: "The cited spreadsheet chart supports the answer."
      },
      now: () => FIXED_NOW
    }),
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.draft?.citations, undefined);
  assert.equal(result.resolvedCitations[0]?.visualAssetId, "sheet_1_chart_1");
  assert.equal(result.resolvedCitations[0]?.visualAsset?.title, "Revenue by Quarter");
  assert.equal(result.resolvedCitations[0]?.visualAsset?.sheetName, "Model");
  assert.equal(result.resolvedCitations[0]?.visualAsset?.anchorCell, "R2C5");
  assert.equal(JSON.stringify(result.resolvedCitations).includes("file://"), false);
});

test("links one generation answer to context, retrieval, and model traces", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [
      makeDocument({
        id: "doc_trace_links",
        body: "Refund policy says billing refunds require human review."
      })
    ],
    profile
  );
  const orchestrator = new GenerationOrchestrator({ now: () => FIXED_NOW });

  const result = await orchestrator.run({
    profile,
    context,
    question: "What is the refund policy?",
    model: new FakeModelAdapter({ now: () => FIXED_NOW }),
    generationId: "generation_trace_links",
    answerId: "answer_trace_links",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.trace.generationId, "generation_trace_links");
  assert.equal(result.trace.answerId, "answer_trace_links");
  assert.equal(result.trace.contextId, context.trace.contextId);
  assert.equal(result.trace.retrievalId, context.trace.retrievalId);
  assert.equal(result.trace.model.requestId, "model_generation_trace_links");
  assert.equal(result.gate.trace.answerId, result.trace.answerId);
});

test("refuses without calling the model when the gate blocks generation", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [
      makeDocument({
        id: "doc_login",
        title: "Login Guide",
        body: "Login troubleshooting covers password reset."
      })
    ],
    profile,
    "refund policy"
  );
  const model = new CountingModelAdapter();
  const orchestrator = new GenerationOrchestrator({ now: () => FIXED_NOW });

  const result = await orchestrator.run({
    profile,
    context,
    question: "What is the refund policy?",
    model
  });

  assert.equal(result.status, "refused");
  assert.equal(result.refusal?.code, "generation_requires_evidence");
  assert.equal(result.trace.model.attempted, false);
  assert.equal(model.callCount, 0);
});

test("returns model_failed when the adapter returns a failed result", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [makeDocument({ id: "doc_refunds", body: "Refund policy." })],
    profile
  );
  const orchestrator = new GenerationOrchestrator({ now: () => FIXED_NOW });

  const result = await orchestrator.run({
    profile,
    context,
    question: "What is the refund policy?",
    model: new FakeModelAdapter({ failWith: "provider unavailable", now: () => FIXED_NOW })
  });

  assert.equal(result.status, "model_failed");
  assert.equal(result.model?.status, "failed");
  assert.equal(result.trace.model.errorMessage, "provider unavailable");
  assert.equal(result.validation, undefined);
});

test("converts thrown adapter errors into model_failed results", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [makeDocument({ id: "doc_refunds", body: "Refund policy." })],
    profile
  );
  const orchestrator = new GenerationOrchestrator({ now: () => FIXED_NOW });

  const result = await orchestrator.run({
    profile,
    context,
    question: "What is the refund policy?",
    model: new ThrowingModelAdapter()
  });

  assert.equal(result.status, "model_failed");
  assert.equal(result.trace.model.provider, "test");
  assert.equal(result.trace.model.errorMessage, "adapter exploded");
});

test("blocks invalid model drafts before returning success", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [makeDocument({ id: "doc_refunds", body: "Refund policy." })],
    profile
  );
  const orchestrator = new GenerationOrchestrator({ now: () => FIXED_NOW });

  const result = await orchestrator.run({
    profile,
    context,
    question: "What is the refund policy?",
    model: new FakeModelAdapter({
      draft: {
        answer: "Refunds are always approved.",
        citationChunkIds: [],
        evidenceSummary: "No citations were used."
      },
      now: () => FIXED_NOW
    })
  });

  assert.equal(result.status, "validation_failed");
  assert.equal(result.validation?.valid, false);
  assert.equal(
    result.validation?.errors.some((error) => error.code === "missing_required_citation"),
    true
  );
  assert.equal(result.trace.validationValid, false);
});

test("marks valid generations as human review required when validation warns", async () => {
  const profile = profileForTest({
    actionPolicy: {
      mode: "human_approval_required",
      allowedActions: ["create_ticket"],
      requireApprovalFor: ["create_ticket"]
    }
  });
  const context = await buildContext(
    [makeDocument({ id: "doc_refunds", body: "Refund policy." })],
    profile
  );
  const chunkId = context.blocks[0]?.chunkId;
  assert.ok(chunkId);
  const orchestrator = new GenerationOrchestrator({ now: () => FIXED_NOW });

  const result = await orchestrator.run({
    profile,
    context,
    question: "What is the refund policy?",
    model: new FakeModelAdapter({
      draft: {
        answer: "Refund policy exists.",
        citationChunkIds: [chunkId],
        evidenceSummary: "One trusted policy chunk supports the answer.",
        actions: ["create_ticket"]
      },
      now: () => FIXED_NOW
    })
  });

  assert.equal(result.status, "human_review_required");
  assert.equal(result.validation?.valid, true);
  assert.equal(result.trace.validationWarningCount, 1);
});

test("marks valid generations as human review required when the model reports warnings", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [makeDocument({ id: "doc_refunds", body: "Refund policy." })],
    profile
  );
  const orchestrator = new GenerationOrchestrator({ now: () => FIXED_NOW });

  const result = await orchestrator.run({
    profile,
    context,
    question: "What is the refund policy?",
    model: new FakeModelAdapter({
      warnings: ["provider returned low confidence metadata"],
      now: () => FIXED_NOW
    })
  });

  assert.equal(result.status, "human_review_required");
  assert.equal(result.warnings[0]?.code, "model_warning");
  assert.equal(result.trace.warningCodes.includes("model_warning"), true);
  assert.equal(result.trace.model.warningCount, 1);
});

test("model-backed grounding judge can fail an otherwise valid draft", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [makeDocument({ id: "doc_refunds", body: "Refund policy requires review." })],
    profile
  );
  const chunkId = context.blocks[0]?.chunkId;
  assert.ok(chunkId);
  const orchestrator = new GenerationOrchestrator({
    groundingJudge: new ModelBackedGroundingJudge({
      adapter: new StaticGroundingJudgeAdapter({
        verdict: "unsupported",
        issues: [
          {
            code: "unsupported_claim",
            message: "The answer made a claim not supported by cited evidence.",
            chunkId
          }
        ],
        fail: false
      }),
      now: () => FIXED_NOW
    }),
    now: () => FIXED_NOW
  });

  const result = await orchestrator.run({
    profile,
    context,
    question: "What is the refund policy?",
    model: new FakeModelAdapter({
      draft: {
        answer: "Refund policy requires review.",
        citationChunkIds: [chunkId],
        evidenceSummary: "The cited policy chunk supports the answer."
      },
      now: () => FIXED_NOW
    })
  });

  assert.equal(result.validation?.valid, true);
  assert.equal(result.status, "validation_failed");
  assert.equal(result.groundingJudge?.verdict, "unsupported");
  assert.equal(result.trace.groundingJudge?.verdict, "unsupported");
  assert.equal(JSON.stringify(result.trace).includes("Refund policy requires review"), false);
});

test("grounding judge uncertainty forces human review", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [makeDocument({ id: "doc_refunds", body: "Refund policy requires review." })],
    profile
  );
  const chunkId = context.blocks[0]?.chunkId;
  assert.ok(chunkId);
  const orchestrator = new GenerationOrchestrator({
    groundingJudge: new ModelBackedGroundingJudge({
      adapter: new StaticGroundingJudgeAdapter({
        verdict: "needs_review",
        issues: [
          {
            code: "missing_citation_support",
            message: "Citation support should be reviewed.",
            chunkId
          }
        ]
      }),
      now: () => FIXED_NOW
    }),
    now: () => FIXED_NOW
  });

  const result = await orchestrator.run({
    profile,
    context,
    question: "What is the refund policy?",
    model: new FakeModelAdapter({
      draft: {
        answer: "Refund policy requires review.",
        citationChunkIds: [chunkId],
        evidenceSummary: "The cited policy chunk supports the answer."
      },
      now: () => FIXED_NOW
    })
  });

  assert.equal(result.status, "human_review_required");
  assert.equal(result.groundingJudge?.verdict, "needs_review");
  assert.equal(
    result.warnings.some((warning) => warning.code === "grounding_judge_warning"),
    true
  );
});

test("grounding judge failures cannot return a successful generation", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [makeDocument({ id: "doc_refunds", body: "Refund policy requires review." })],
    profile
  );
  const chunkId = context.blocks[0]?.chunkId;
  assert.ok(chunkId);
  const orchestrator = new GenerationOrchestrator({
    groundingJudge: new ModelBackedGroundingJudge({
      adapter: new StaticGroundingJudgeAdapter({ verdict: "grounded", fail: true }),
      now: () => FIXED_NOW
    }),
    now: () => FIXED_NOW
  });

  const result = await orchestrator.run({
    profile,
    context,
    question: "What is the refund policy?",
    model: new FakeModelAdapter({
      draft: {
        answer: "Refund policy requires review.",
        citationChunkIds: [chunkId],
        evidenceSummary: "The cited policy chunk supports the answer."
      },
      now: () => FIXED_NOW
    })
  });

  assert.equal(result.status, "human_review_required");
  assert.equal(result.groundingJudge?.verdict, "failed");
  assert.equal(
    result.warnings.some((warning) => warning.code === "grounding_judge_failed"),
    true
  );
});

test("marks valid generations as human review required when cost or latency budgets are exceeded", async () => {
  const profile = profileForTest({
    costLatencyBudget: {
      ...genericDocsProfile.costLatencyBudget,
      maxRuntimeMs: 1000,
      maxEstimatedCostUsd: 0.001
    }
  });
  const context = await buildContext(
    [makeDocument({ id: "doc_refunds", body: "Refund policy." })],
    profile
  );
  const orchestrator = new GenerationOrchestrator({ now: () => FIXED_NOW });

  const result = await orchestrator.run({
    profile,
    context,
    question: "What is the refund policy?",
    model: new FakeModelAdapter({
      latencyMs: 1001,
      estimatedCostUsd: 0.002,
      now: () => FIXED_NOW
    })
  });

  assert.equal(result.status, "human_review_required");
  assert.equal(
    result.warnings.some((warning) => warning.code === "model_latency_budget_exceeded"),
    true
  );
  assert.equal(
    result.warnings.some((warning) => warning.code === "model_cost_budget_exceeded"),
    true
  );
  assert.equal(result.trace.warningCount, 2);
});

test("marks valid generations as human review required when draft output budget is exceeded", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [makeDocument({ id: "doc_refunds", body: "Refund policy." })],
    profile
  );
  const chunkId = context.blocks[0]?.chunkId;
  assert.ok(chunkId);
  const orchestrator = new GenerationOrchestrator({ now: () => FIXED_NOW });

  const result = await orchestrator.run({
    profile,
    context,
    question: "What is the refund policy?",
    model: new FakeModelAdapter({
      draft: {
        answer: "Refund policy ".repeat(400),
        citationChunkIds: [chunkId],
        evidenceSummary: "One trusted policy chunk supports the answer."
      },
      now: () => FIXED_NOW
    })
  });

  assert.equal(result.status, "human_review_required");
  assert.equal(result.validation?.valid, true);
  assert.equal(result.warnings[0]?.code, "draft_output_budget_exceeded");
});

test("blocks model drafts that leak context wrappers", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [makeDocument({ id: "doc_refunds", body: "Refund policy." })],
    profile
  );
  const chunkId = context.blocks[0]?.chunkId;
  assert.ok(chunkId);
  const orchestrator = new GenerationOrchestrator({ now: () => FIXED_NOW });

  const result = await orchestrator.run({
    profile,
    context,
    question: "What is the refund policy?",
    model: new FakeModelAdapter({
      draft: {
        answer: "[SOURCE 1] Refund policy exists.",
        citationChunkIds: [chunkId],
        evidenceSummary: "One trusted policy chunk supports the answer."
      },
      now: () => FIXED_NOW
    })
  });

  assert.equal(result.status, "validation_failed");
  assert.equal(
    result.validation?.errors.some((error) => error.code === "raw_context_leak"),
    true
  );
});

test("blocks model drafts that cite unknown chunks", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [makeDocument({ id: "doc_refunds", body: "Refund policy." })],
    profile
  );
  const orchestrator = new GenerationOrchestrator({ now: () => FIXED_NOW });

  const result = await orchestrator.run({
    profile,
    context,
    question: "What is the refund policy?",
    model: new FakeModelAdapter({
      draft: {
        answer: "Refund policy exists.",
        citationChunkIds: ["chunk_not_in_context"],
        evidenceSummary: "The answer cites a chunk."
      },
      now: () => FIXED_NOW
    })
  });

  assert.equal(result.status, "validation_failed");
  assert.equal(
    result.validation?.errors.some((error) => error.code === "unknown_citation"),
    true
  );
});

test("blocks model drafts that request disallowed actions", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [makeDocument({ id: "doc_refunds", body: "Refund policy." })],
    profile
  );
  const chunkId = context.blocks[0]?.chunkId;
  assert.ok(chunkId);
  const orchestrator = new GenerationOrchestrator({ now: () => FIXED_NOW });

  const result = await orchestrator.run({
    profile,
    context,
    question: "What is the refund policy?",
    model: new FakeModelAdapter({
      draft: {
        answer: "Refund policy exists.",
        citationChunkIds: [chunkId],
        evidenceSummary: "One trusted policy chunk supports the answer.",
        actions: ["issue_refund"]
      },
      now: () => FIXED_NOW
    })
  });

  assert.equal(result.status, "validation_failed");
  assert.equal(
    result.validation?.errors.some((error) => error.code === "action_not_allowed"),
    true
  );
});

test("marks valid generations as human review required when evidence trust requires review", async () => {
  const profile = profileForTest({
    trustPolicy: {
      ...genericDocsProfile.trustPolicy,
      minimumAnswerTrustTier: "user_provided"
    }
  });
  const context = await buildContext(
    [
      withTrustTier(
        makeDocument({
          id: "doc_user",
          body: "Refund policy from user provided evidence."
        }),
        "user_provided"
      )
    ],
    profile
  );
  const orchestrator = new GenerationOrchestrator({ now: () => FIXED_NOW });

  const result = await orchestrator.run({
    profile,
    context,
    question: "What is the refund policy?",
    model: new FakeModelAdapter({ now: () => FIXED_NOW })
  });

  assert.equal(result.status, "human_review_required");
  assert.equal(result.gate.status, "human_review_required");
  assert.equal(result.validation?.valid, true);
});

test("keeps raw context text out of generation traces", async () => {
  const rawText = "internal generation trace phrase should not leak";
  const profile = profileForTest();
  const context = await buildContext(
    [
      makeDocument({
        id: "doc_trace",
        body: `Refund policy says ${rawText}.`
      })
    ],
    profile
  );
  const orchestrator = new GenerationOrchestrator({ now: () => FIXED_NOW });

  const result = await orchestrator.run({
    profile,
    context,
    question: "What is the refund policy?",
    model: new FakeModelAdapter({ now: () => FIXED_NOW })
  });

  assert.equal(result.status, "succeeded");
  assert.equal(JSON.stringify(result.trace).includes(rawText), false);
});
