import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { RagDocument } from "../documents/document.js";
import { redactIndexFilterForTrace } from "../indexing/index-filter.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { FakeModelAdapter } from "../model/fake-model-adapter.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import type { GraphQueryIntent, QueryPlan, QueryPlanner } from "../query/query-types.js";
import { InMemoryRagGraphStore } from "../graph/graph-store.js";
import { GraphAugmentedRetriever } from "../retrieval/graph-augmented-retriever.js";
import { KeywordRetriever } from "../retrieval/keyword-retriever.js";
import type { RetrievalRequest, RetrievalResult } from "../retrieval/retrieval-types.js";
import type { Retriever, RetrieverCapabilities } from "../retrieval/retriever.js";
import { hashText } from "../shared/hash.js";
import {
  FIXED_NOW,
  makeDocument,
  makeIndexFilter,
  makePrincipal
} from "../test-support/fixtures.js";
import { RagAnswerRuntime, type GenerationRunner } from "./rag-answer-runtime.js";
import type { RagAnswerRequest } from "./runtime-types.js";

const profile = assertValidProfile({
  ...genericDocsProfile,
  namespaceId: "test-namespace"
});

function makeIndexWithDocuments(documents: readonly RagDocument[]): InMemoryRagIndex {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });

  for (const document of documents) {
    const chunks = chunkDocument({ document }).chunks;
    index.addDocument(document);
    index.addChunks(document.id, chunks);
  }

  return index;
}

function graphRuntimeFor(documents: readonly RagDocument[]): RagAnswerRuntime {
  const index = makeIndexWithDocuments(documents);
  const baseRetriever = new KeywordRetriever({ chunkStore: index, now: () => FIXED_NOW });

  return new RagAnswerRuntime({
    retriever: new GraphAugmentedRetriever({
      baseRetriever,
      graphStore: new InMemoryRagGraphStore(),
      chunkStore: index,
      now: () => FIXED_NOW
    }),
    now: () => FIXED_NOW
  });
}

function runtimeFor(
  documents: readonly RagDocument[],
  generationRunner?: GenerationRunner,
  queryPlanner?: QueryPlanner
): RagAnswerRuntime {
  const index = makeIndexWithDocuments(documents);
  const retriever = new KeywordRetriever({ chunkStore: index, now: () => FIXED_NOW });

  return new RagAnswerRuntime({
    retriever,
    ...(generationRunner ? { generationRunner } : {}),
    ...(queryPlanner ? { queryPlanner } : {}),
    now: () => FIXED_NOW
  });
}

function baseRequest(overrides: Partial<RagAnswerRequest> = {}): RagAnswerRequest {
  return {
    profile,
    question: "What does super-secret-question-token say about refund policy?",
    filter: makeIndexFilter(),
    model: new FakeModelAdapter({ now: () => FIXED_NOW }),
    topK: 10,
    runId: "run_test",
    traceId: "trace_test",
    requestedAt: FIXED_NOW,
    ...overrides
  };
}

function assertSingleLinkedTrace(result: {
  readonly trace: {
    readonly runId: string;
    readonly traceId: string;
    readonly events: readonly { readonly runId: string; readonly traceId: string }[];
  };
}): void {
  assert.deepEqual(
    [...new Set(result.trace.events.map((event) => event.runId))],
    [result.trace.runId]
  );
  assert.deepEqual(
    [...new Set(result.trace.events.map((event) => event.traceId))],
    [result.trace.traceId]
  );
}

function assertTraceRedacted(trace: unknown): void {
  const serialized = JSON.stringify(trace);
  assert.equal(serialized.includes("super-secret-question-token"), false);
  assert.equal(serialized.includes("trace-secret-context-token"), false);
  assert.equal(serialized.includes("Generated answer from approved context."), false);
}

test("answer returns one redacted run trace linked across retrieval, context, answer, generation, and model", async () => {
  const runtime = runtimeFor([
    makeDocument({
      id: "doc_runtime_success",
      body: "Refund policy says trace-secret-context-token requests require human review."
    })
  ]);

  const result = await runtime.answer(baseRequest());

  assert.equal(result.status, "succeeded");
  assert.equal(result.trace.status, "succeeded");
  assert.equal(result.trace.runId, "run_test");
  assert.equal(result.trace.traceId, "trace_test");
  assert.equal(result.trace.retrievalId, result.retrieval.trace.retrievalId);
  assert.equal(result.trace.contextId, result.context.trace.contextId);
  assert.equal(result.trace.generationId, result.generation.trace.generationId);
  assert.equal(result.trace.answerId, result.generation.trace.answerId);
  assert.equal(result.trace.modelRequestId, result.generation.trace.model.requestId);
  assert.equal(result.trace.retrievedChunkIds.length, 1);
  assert.equal(result.trace.finalCitations.length, 1);
  assert.equal(result.answerCitations[0]?.chunkId, result.context.blocks[0]?.chunkId);
  assertSingleLinkedTrace(result);
  assertTraceRedacted(result.trace);
});

test("answer exposes resolved visual asset citations without requiring model-written citation objects", async () => {
  const index = makeIndexWithDocuments([
    makeDocument({
      id: "doc_runtime_visual_answer_citation",
      body: "Spreadsheet chart shows revenue by quarter."
    })
  ]);
  const baseRetriever = new KeywordRetriever({ chunkStore: index, now: () => FIXED_NOW });
  const retriever: Retriever = {
    capabilities: baseRetriever.capabilities,
    async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
      const result = await baseRetriever.retrieve(request);
      return {
        ...result,
        candidates: result.candidates.map((candidate, candidateIndex) =>
          candidateIndex === 0
            ? {
                ...candidate,
                citation: {
                  ...candidate.citation,
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
                }
              }
            : candidate
        )
      };
    }
  };
  const runtime = new RagAnswerRuntime({
    retriever,
    now: () => FIXED_NOW
  });

  const result = await runtime.answer(
    baseRequest({
      question: "What does the spreadsheet chart show?"
    })
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.generation.draft?.citations, undefined);
  assert.equal(result.answerCitations[0]?.visualAssetId, "sheet_1_chart_1");
  assert.equal(result.answerCitations[0]?.visualAsset?.title, "Revenue by Quarter");
  assert.equal(result.answerCitations[0]?.visualAsset?.sheetName, "Model");
  assert.equal(result.answerCitations[0]?.visualAsset?.anchorCell, "R2C5");
  assert.equal(JSON.stringify(result.answerCitations).includes("file://"), false);
});

test("answer returns a redacted trace when generation is refused", async () => {
  const runtime = runtimeFor([
    makeDocument({
      id: "doc_runtime_no_evidence",
      title: "Login Guide",
      body: "Login troubleshooting covers password reset."
    })
  ]);

  const result = await runtime.answer(baseRequest());

  assert.equal(result.status, "refused");
  assert.equal(result.trace.status, "refused");
  assert.equal(result.trace.retrievalId, result.retrieval.trace.retrievalId);
  assert.equal(result.trace.contextId, result.context.trace.contextId);
  assert.equal(result.trace.generationId, result.generation.trace.generationId);
  assert.equal(result.trace.answerId, result.generation.trace.answerId);
  assert.equal(result.trace.modelRequestId, undefined);
  assert.equal(
    result.trace.events.some((event) => event.kind === "grounding_checked"),
    true
  );
  assertSingleLinkedTrace(result);
  assertTraceRedacted(result.trace);
});

test("answer returns a redacted trace when the model fails", async () => {
  const runtime = runtimeFor([
    makeDocument({
      id: "doc_runtime_model_failure",
      body: "Refund policy says billing refunds require review."
    })
  ]);

  const result = await runtime.answer(
    baseRequest({
      model: new FakeModelAdapter({ failWith: "provider leaked raw failure", now: () => FIXED_NOW })
    })
  );

  assert.equal(result.status, "model_failed");
  assert.equal(result.trace.status, "model_failed");
  assert.equal(result.trace.modelRequestId, result.generation.trace.model.requestId);
  assert.equal(JSON.stringify(result.trace).includes("provider leaked raw failure"), false);
  assertSingleLinkedTrace(result);
  assertTraceRedacted(result.trace);
});

test("answer fails before retrieval when graph-required query uses a non-graph retriever", async () => {
  const runtime = runtimeFor([
    makeDocument({
      id: "doc_runtime_ownership_plain",
      body: "Parent LLC owns Child LLC."
    })
  ]);

  const result = await runtime.answer(
    baseRequest({
      question: "Who owns Child LLC?",
      filter: makeIndexFilter()
    })
  );

  assert.equal(result.status, "retrieval_failed");
  assert.equal(result.failure.errorName, "GraphRetrievalRequired");
  assert.equal(
    result.trace.events.some(
      (event) => event.kind === "query_planned" && event.data?.graphRoute === "graph_required"
    ),
    true
  );
});

test("answer allows graph-required query when retriever supports graph search", async () => {
  const runtime = graphRuntimeFor([
    makeDocument({
      id: "doc_runtime_ownership_graph",
      body: "Parent LLC owns Child LLC."
    })
  ]);

  const result = await runtime.answer(
    baseRequest({
      question: "Who owns Child LLC?",
      filter: makeIndexFilter()
    })
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.retrieval.trace.fusionStrategy, "graph_multi_hop");
});

test("answer executes parallel planned queries as one redacted linked trace", async () => {
  const parallelProfile = assertValidProfile({
    ...genericDocsProfile,
    namespaceId: "test-namespace",
    retrieval: {
      ...genericDocsProfile.retrieval,
      allowQueryRewrite: true,
      allowParallelQueries: true
    },
    costLatencyBudget: {
      ...genericDocsProfile.costLatencyBudget,
      maxRetrievalCalls: 3
    }
  });
  const runtime = runtimeFor(
    [
      makeDocument({
        id: "doc_runtime_planned_query",
        body: "Acme Corp refund policy says billing review is required."
      })
    ],
    undefined,
    new StaticQueryPlanner([
      {
        id: "q_original",
        query: "What does Acme Corp refund policy require?",
        kind: "original",
        weight: 1
      },
      {
        id: "q_low_level",
        query: "Acme Corp",
        kind: "low_level",
        weight: 0.9
      },
      {
        id: "q_high_level",
        query: "refund policy billing review",
        kind: "high_level",
        weight: 0.75
      }
    ])
  );

  const result = await runtime.answer(
    baseRequest({
      profile: parallelProfile,
      question: "What does Acme Corp refund policy require?",
      filter: makeIndexFilter()
    })
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.trace.queryPlanId, "run_test_query_plan");
  assert.equal(result.trace.plannedQueryHashes.length, 3);
  assert.equal(
    "retrieval" in result ? result.retrieval.trace.fusionStrategy : undefined,
    "planned_query_rrf"
  );
  assert.equal(
    "retrieval" in result ? result.retrieval.trace.childRetrievalIds?.length : undefined,
    3
  );
  assert.equal(JSON.stringify(result.trace).includes("Acme Corp"), false);
  assertSingleLinkedTrace(result);
});

test("answer executes HyDE planned queries through normal planned-query fusion", async () => {
  const parallelProfile = assertValidProfile({
    ...genericDocsProfile,
    namespaceId: "test-namespace",
    retrieval: {
      ...genericDocsProfile.retrieval,
      allowQueryRewrite: true,
      allowParallelQueries: true
    },
    costLatencyBudget: {
      ...genericDocsProfile.costLatencyBudget,
      maxRetrievalCalls: 2
    }
  });
  const runtime = runtimeFor(
    [
      makeDocument({
        id: "doc_runtime_hyde",
        body: "Customer concentration risk creates revenue exposure after the acquisition."
      })
    ],
    undefined,
    new StaticQueryPlanner([
      {
        id: "q_original",
        query: "What risks matter after the transaction?",
        kind: "original",
        weight: 1
      },
      {
        id: "q_hyde",
        query: "A likely answer discusses customer concentration risk and revenue exposure.",
        kind: "hyde",
        weight: 0.8
      }
    ])
  );

  const result = await runtime.answer(
    baseRequest({
      profile: parallelProfile,
      question: "What risks matter after the transaction?",
      filter: makeIndexFilter()
    })
  );

  assert.equal(result.status, "succeeded");
  assert.equal(
    "retrieval" in result ? result.retrieval.trace.fusionStrategy : undefined,
    "planned_query_rrf"
  );
  assert.equal(
    "retrieval" in result
      ? result.retrieval.candidates.some((candidate) =>
          candidate.reasons.includes("planned_query_hyde")
        )
      : false,
    true
  );
  assert.equal(JSON.stringify(result.trace).includes("customer concentration"), false);
  assertSingleLinkedTrace(result);
});

test("query runtime applies per-branch retrieval budgets to planned queries", async () => {
  const parallelProfile = assertValidProfile({
    ...genericDocsProfile,
    namespaceId: "test-namespace",
    retrieval: {
      ...genericDocsProfile.retrieval,
      allowQueryRewrite: true,
      allowParallelQueries: true
    },
    costLatencyBudget: {
      ...genericDocsProfile.costLatencyBudget,
      maxRetrievalCalls: 3
    }
  });
  const retriever = new RecordingRetriever();
  const runtime = new RagAnswerRuntime({
    retriever,
    queryPlanner: new StaticQueryPlanner([
      {
        id: "q_original",
        query: "What does Acme Corp refund policy require?",
        kind: "original",
        weight: 1
      },
      {
        id: "q_high_level",
        query: "refund policy billing review",
        kind: "high_level",
        weight: 0.75
      },
      {
        id: "q_hyde",
        query: "A likely answer discusses billing review before refund approval.",
        kind: "hyde",
        weight: 0.8
      }
    ]),
    now: () => FIXED_NOW
  });

  const result = await runtime.query(
    baseRequest({
      profile: parallelProfile,
      question: "What does Acme Corp refund policy require?",
      filter: makeIndexFilter()
    })
  );

  assert.equal(result.status, "query_succeeded");
  assert.deepEqual(
    retriever.requests.map((request) => request.topK),
    [10, 8, 8]
  );
  assert.deepEqual(
    retriever.requests.map((request) => request.candidatePoolLimit),
    [40, 32, 32]
  );
  assert.deepEqual(
    retriever.requests.map((request) => request.graph),
    [{ enabled: false }, { enabled: false }, { enabled: false }]
  );
  assert.equal(result.retrieval.trace.retrievalBudget?.enabledQueryCount, 3);
  assert.equal(result.retrieval.trace.retrievalBudget?.totalCandidatePoolLimit, 104);
  assert.equal(JSON.stringify(result.trace).includes("Acme Corp"), false);
});

test("query runtime applies profile source-hint filters without broadening caller filters", async () => {
  const routedProfile = assertValidProfile({
    ...profile,
    corpusSources: [
      {
        id: "support_docs",
        adapter: "local-files",
        description: "Support docs.",
        enabled: true,
        trustTierFloor: "trusted_internal",
        tags: ["support"]
      },
      {
        id: "feedback_examples",
        adapter: "local-files",
        description: "Feedback examples.",
        enabled: true,
        trustTierFloor: "user_provided",
        tags: ["tickets"]
      }
    ],
    retrieval: {
      ...profile.retrieval,
      sourceHintRoutes: {
        support: {
          mode: "filter",
          sourceIds: ["support_docs"]
        }
      }
    }
  });
  const runtime = runtimeFor([
    makeDocument({
      id: "doc_support_password",
      body: "Password reset failures after login updates are handled from support docs.",
      provenance: {
        sourceId: "support_docs",
        sourceKind: "local_file",
        title: "Support Password Reset",
        ingestedAt: FIXED_NOW,
        trustTier: "trusted_internal",
        sensitivity: "internal",
        capturedAt: FIXED_NOW
      }
    }),
    makeDocument({
      id: "doc_feedback_password",
      body: "Password reset failures are also mentioned in feedback examples.",
      provenance: {
        sourceId: "feedback_examples",
        sourceKind: "support_ticket",
        title: "Feedback Password Reset",
        ingestedAt: FIXED_NOW,
        trustTier: "user_provided",
        sensitivity: "internal",
        capturedAt: FIXED_NOW
      }
    })
  ]);

  const result = await runtime.answer(
    baseRequest({
      profile: routedProfile,
      question: "Why can't users reset passwords after the login update?"
    })
  );

  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    result.retrieval.candidates.map((candidate) => candidate.chunk.provenance.sourceId),
    ["support_docs"]
  );
  const routeFilter = result.retrieval.trace.retrievalBudget?.branches[0]?.routeFilter;
  assert.equal(routeFilter?.sourceIdCount, 1);
  assert.deepEqual(routeFilter?.sourceIdHashes, [hashText("support_docs")]);
  assert.equal(JSON.stringify(result.retrieval.trace).includes("support_docs"), false);
});

test("query runtime redacts profile source-hint preferences in retrieval budget traces", async () => {
  const preferredProfile = assertValidProfile({
    ...profile,
    corpusSources: [
      {
        id: "curated_docs",
        adapter: "local-files",
        description: "Curated docs.",
        enabled: true,
        trustTierFloor: "trusted_internal",
        tags: ["docs"]
      }
    ],
    retrieval: {
      ...profile.retrieval,
      sourceHintRoutes: {
        docs: {
          mode: "prefer",
          sourceIds: ["curated_docs"]
        }
      }
    }
  });
  const runtime = runtimeFor([
    makeDocument({
      id: "doc_preferred_docs",
      body: "Refund policy says preferred docs should stay citable."
    })
  ]);

  const result = await runtime.answer(
    baseRequest({
      profile: preferredProfile,
      question: "What does the refund policy say?"
    })
  );

  assert.equal(result.status, "succeeded");
  const routePreference = result.retrieval.trace.retrievalBudget?.branches[0]?.routePreference;
  assert.equal(routePreference?.sourceIdCount, 1);
  assert.deepEqual(routePreference?.sourceIdHashes, [hashText("curated_docs")]);
  assert.equal(routePreference?.fusionWeightMultiplier, 1.15);
  assert.equal(JSON.stringify(result.retrieval.trace).includes("curated_docs"), false);
});

test("query runtime redacts graph entity hints from retrieval budget traces", async () => {
  const graphProfile = assertValidProfile({
    ...genericDocsProfile,
    namespaceId: "test-namespace",
    retrieval: {
      ...genericDocsProfile.retrieval,
      allowQueryRewrite: true,
      allowParallelQueries: true
    }
  });
  const retriever = new RecordingRetriever();
  const runtime = new RagAnswerRuntime({
    retriever,
    queryPlanner: new StaticQueryPlanner(
      [
        {
          id: "q_original",
          query: "Who owns Secret Target LLC?",
          kind: "original",
          weight: 1
        }
      ],
      {
        route: "graph_required",
        relationKinds: ["owns"],
        entityHints: ["Secret Target LLC"],
        direction: "incoming",
        executionMode: "graph_first",
        reason: "Static test graph route."
      }
    ),
    now: () => FIXED_NOW
  });

  const result = await runtime.query(
    baseRequest({
      profile: graphProfile,
      question: "Who owns Secret Target LLC?",
      filter: makeIndexFilter()
    })
  );

  assert.equal(result.status, "query_succeeded");
  const graphTrace = result.retrieval.trace.retrievalBudget?.branches[0]?.graph;

  assert.deepEqual(retriever.requests[0]?.graph?.entityHints, ["Secret Target LLC"]);
  assert.equal(JSON.stringify(result.retrieval.trace).includes("Secret Target LLC"), false);
  assert.equal(JSON.stringify(result.trace).includes("Secret Target LLC"), false);
  assert.equal(graphTrace?.entityHintCount, 1);
  assert.deepEqual(graphTrace?.entityHintHashes, [hashText("Secret Target LLC")]);
  assert.equal("entityHints" in (graphTrace ?? {}), false);
});

test("answer fails before retrieval when planned queries exceed retrieval-call budget", async () => {
  const budgetedProfile = assertValidProfile({
    ...genericDocsProfile,
    namespaceId: "test-namespace",
    retrieval: {
      ...genericDocsProfile.retrieval,
      allowQueryRewrite: true,
      allowParallelQueries: true
    },
    costLatencyBudget: {
      ...genericDocsProfile.costLatencyBudget,
      maxRetrievalCalls: 1
    }
  });
  const runtime = runtimeFor(
    [
      makeDocument({
        id: "doc_runtime_budget",
        body: "Refund policy says billing review is required."
      })
    ],
    undefined,
    new StaticQueryPlanner([
      {
        id: "q_original",
        query: "What does refund policy require?",
        kind: "original",
        weight: 1
      },
      {
        id: "q_high_level",
        query: "billing review",
        kind: "high_level",
        weight: 0.75
      }
    ])
  );

  const result = await runtime.answer(
    baseRequest({
      profile: budgetedProfile,
      question: "What does refund policy require?",
      filter: makeIndexFilter()
    })
  );

  assert.equal(result.status, "retrieval_failed");
  assert.equal(result.failure.errorName, "BudgetExceeded");
  assert.equal(
    result.trace.events.some((event) => event.kind === "retrieval_finished"),
    false
  );
});

test("answer rejects injected planners that bypass profile query policy", async () => {
  const noParallelProfile = assertValidProfile({
    ...genericDocsProfile,
    namespaceId: "test-namespace",
    retrieval: {
      ...genericDocsProfile.retrieval,
      allowQueryRewrite: true,
      allowParallelQueries: false
    },
    costLatencyBudget: {
      ...genericDocsProfile.costLatencyBudget,
      maxRetrievalCalls: 3
    }
  });
  const runtime = runtimeFor(
    [
      makeDocument({
        id: "doc_runtime_policy",
        body: "Refund policy says billing review is required."
      })
    ],
    undefined,
    new StaticQueryPlanner([
      {
        id: "q_original",
        query: "What does refund policy require?",
        kind: "original",
        weight: 1
      },
      {
        id: "q_high_level",
        query: "billing review",
        kind: "high_level",
        weight: 0.75
      }
    ])
  );

  const result = await runtime.answer(
    baseRequest({
      profile: noParallelProfile,
      question: "What does refund policy require?",
      filter: makeIndexFilter()
    })
  );

  assert.equal(result.status, "retrieval_failed");
  assert.equal(
    result.trace.events.some((event) => event.kind === "retrieval_started"),
    false
  );
});

test("answer returns a trace when retrieval fails before a retrieval result exists", async () => {
  const runtime = runtimeFor([makeDocument()]);

  const result = await runtime.answer(
    baseRequest({
      filter: makeIndexFilter({ tenantId: "tenant_2" })
    })
  );

  assert.equal(result.status, "retrieval_failed");
  assert.equal(result.failure.stage, "retrieval");
  assert.equal(result.trace.status, "retrieval_failed");
  assert.equal(result.trace.retrievalId, "run_test_retrieval");
  assert.equal(result.trace.contextId, undefined);
  assert.equal(result.trace.generationId, undefined);
  assert.equal(
    result.trace.events.some((event) => event.kind === "run_failed"),
    true
  );
  assertSingleLinkedTrace(result);
  assertTraceRedacted(result.trace);
});

test("answer fails before retrieval when the profile mode is not supported by the retriever", async () => {
  const runtime = runtimeFor([makeDocument()]);
  const unsupportedProfile = {
    ...profile,
    retrieval: {
      ...profile.retrieval,
      mode: "hybrid"
    }
  } as unknown as typeof profile;

  const result = await runtime.answer(
    baseRequest({
      profile: unsupportedProfile
    })
  );

  assert.equal(result.status, "retrieval_failed");
  assert.equal(result.failure.stage, "retrieval");
  assert.equal(result.failure.errorName, "UnsupportedRetrievalMode");
  assert.equal(result.trace.status, "retrieval_failed");
  assert.equal(result.trace.retrievalId, "run_test_retrieval");
  assert.equal(result.trace.contextId, undefined);
  assertSingleLinkedTrace(result);
  assertTraceRedacted(result.trace);
});

test("answer returns a trace when context building fails after retrieval", async () => {
  const runtime = runtimeFor([
    makeDocument({
      id: "doc_other_namespace",
      namespaceId: "other-namespace",
      accessScope: {
        tenantId: "tenant_1",
        namespaceId: "other-namespace",
        tags: ["support"]
      },
      body: "Refund policy from the wrong namespace."
    })
  ]);

  const result = await runtime.answer(
    baseRequest({
      filter: makeIndexFilter({
        namespaceId: "other-namespace",
        principal: makePrincipal({ namespaceIds: ["other-namespace"] })
      })
    })
  );

  assert.equal(result.status, "context_failed");
  assert.equal(result.failure.stage, "context");
  assert.equal(result.trace.status, "context_failed");
  assert.equal(result.trace.retrievalId, result.retrieval.trace.retrievalId);
  assert.equal(result.trace.contextId, "run_test_context");
  assert.equal(result.trace.generationId, undefined);
  assertSingleLinkedTrace(result);
  assertTraceRedacted(result.trace);
});

test("answer returns a trace when the generation runner throws unexpectedly", async () => {
  const throwingRunner: GenerationRunner = {
    async run() {
      throw new Error("generation leaked raw failure");
    }
  };
  const runtime = runtimeFor(
    [
      makeDocument({
        id: "doc_runtime_generation_failure",
        body: "Refund policy says billing refunds require review."
      })
    ],
    throwingRunner
  );

  const result = await runtime.answer(baseRequest());

  assert.equal(result.status, "generation_failed");
  assert.equal(result.failure.stage, "generation");
  assert.equal(result.trace.status, "generation_failed");
  assert.equal(result.trace.retrievalId, result.retrieval.trace.retrievalId);
  assert.equal(result.trace.contextId, result.context.trace.contextId);
  assert.equal(result.trace.generationId, "run_test_generation");
  assert.equal(result.trace.answerId, "run_test_answer");
  assert.equal(JSON.stringify(result.trace).includes("generation leaked raw failure"), false);
  assertSingleLinkedTrace(result);
  assertTraceRedacted(result.trace);
});

class StaticQueryPlanner implements QueryPlanner {
  constructor(
    private readonly queries: QueryPlan["queries"],
    private readonly graphIntent: GraphQueryIntent = {
      route: "none",
      relationKinds: [],
      entityHints: [],
      direction: "any",
      executionMode: "expand",
      reason: "Static test planner does not route to graph."
    }
  ) {}

  plan(request: Parameters<QueryPlanner["plan"]>[0]): QueryPlan {
    const graphIntent = this.graphIntent;
    const relationshipIntent = graphIntent.route !== "none";
    return {
      originalQuestion: request.question,
      intent: {
        primary: relationshipIntent ? "relationship" : "general",
        secondary: [],
        sourceHints: relationshipIntent ? ["graph"] : ["docs"],
        confidence: 0.8,
        reason: "Static test planner query intent."
      },
      lowLevelKeywords: ["Acme Corp"],
      highLevelKeywords: ["refund", "billing", "review"],
      graphIntent,
      queries: this.queries,
      trace: {
        queryPlanId: request.queryPlanId ?? "query_plan_static",
        startedAt: request.requestedAt ?? FIXED_NOW,
        finishedAt: FIXED_NOW,
        strategy: "default_heuristic",
        originalQuestionHash: hashText(request.question),
        plannedQueryHashes: this.queries.map((query) => hashText(query.query)),
        lowLevelKeywordHashes: [hashText("Acme Corp")],
        highLevelKeywordHashes: [hashText("refund"), hashText("billing"), hashText("review")],
        primaryIntent: relationshipIntent ? "relationship" : "general",
        secondaryIntentHashes: [],
        sourceHintHashes: [hashText(relationshipIntent ? "graph" : "docs")],
        intentConfidence: 0.8,
        graphRoute: graphIntent.route,
        ...(graphIntent.direction === undefined ? {} : { graphDirection: graphIntent.direction }),
        ...(graphIntent.executionMode === undefined
          ? {}
          : { graphExecutionMode: graphIntent.executionMode }),
        graphRelationKindHashes: graphIntent.relationKinds.map(hashText),
        graphEntityHintHashes: graphIntent.entityHints.map(hashText),
        queryCount: this.queries.length,
        rewriteEnabled: request.profile.retrieval.allowQueryRewrite,
        parallelQueriesEnabled: request.profile.retrieval.allowParallelQueries
      }
    };
  }
}

class RecordingRetriever implements Retriever {
  readonly capabilities: RetrieverCapabilities = {
    modes: ["keyword"],
    supportsVectorSearch: false,
    supportsHybridSearch: false,
    supportsGraphSearch: true
  };

  readonly requests: RetrievalRequest[] = [];

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    this.requests.push(request);

    return {
      query: request.query,
      candidates: [],
      rejected: [],
      trace: {
        retrievalId: request.retrievalId ?? "recording_retrieval",
        startedAt: request.requestedAt ?? FIXED_NOW,
        finishedAt: FIXED_NOW,
        mode: "keyword",
        queryHash: hashText(request.query),
        normalizedQueryHash: hashText(request.query.trim().replace(/\s+/g, " ").toLowerCase()),
        searchTermHashes: [],
        access: redactIndexFilterForTrace(request.filter),
        candidatePoolSize: 0,
        returnedCount: 0,
        rejectedCount: 0
      }
    };
  }
}
