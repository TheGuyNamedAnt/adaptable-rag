import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { RagDocument } from "../documents/document.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { FakeModelAdapter } from "../model/fake-model-adapter.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { KeywordRetriever } from "../retrieval/keyword-retriever.js";
import type { Retriever, RetrieverCapabilities } from "../retrieval/retriever.js";
import type {
  AdaptiveRetrievalStrategy,
  RetrievalRequest,
  RetrievalResult
} from "../retrieval/retrieval-types.js";
import { FIXED_NOW, makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import { RagAgentRuntime } from "./rag-agent-runtime.js";
import { RagAnswerRuntime } from "./rag-answer-runtime.js";

const profile = assertValidProfile({
  ...genericDocsProfile,
  namespaceId: "test-namespace",
  citationPolicy: {
    ...genericDocsProfile.citationPolicy,
    minimumCitationsForAnswer: 2,
    minimumTrustedCitations: 1
  },
  retrieval: {
    ...genericDocsProfile.retrieval,
    maxChunks: 8
  }
});

test("agent retries thin evidence through normal answer runs", async () => {
  const answerRuntime = new RagAnswerRuntime({
    retriever: new KeywordRetriever({
      chunkStore: makeIndexWithDocuments([
        makeDocument({
          id: "doc_refund_1",
          body: "Refund policy requires approval for refund requests."
        }),
        makeDocument({
          id: "doc_refund_2",
          body: "Refund policy says approved refund requests need a support note."
        })
      ]),
      now: () => FIXED_NOW
    }),
    now: () => FIXED_NOW
  });
  const agent = new RagAgentRuntime({ answerRuntime, now: () => FIXED_NOW });

  const result = await agent.run({
    profile,
    question: "What does refund policy require?",
    filter: makeIndexFilter(),
    model: new FakeModelAdapter({ now: () => FIXED_NOW }),
    topK: 1,
    maxSteps: 2,
    runId: "agent_test",
    traceId: "trace_agent_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0]?.reason, "initial");
  assert.equal(result.steps[0]?.result.status, "refused");
  assert.deepEqual(result.steps[0]?.retryPlan, {
    planned: true,
    reason: "citation_retry",
    evidenceStatus: "insufficient_citations",
    nextTopK: 2,
    nextCandidatePoolLimit: 40
  });
  assert.equal(result.steps[1]?.reason, "citation_retry");
  assert.equal(result.steps[1]?.topK, 2);
  assert.equal(result.steps[1]?.retryPlan.planned, false);
  assert.equal(result.steps[1]?.retryPlan.evidenceStatus, "answerable");
  assert.equal(result.steps[1]?.retryPlan.stoppedBecause, "not_retryable");
  assert.equal(result.final.status, "succeeded");
  assert.deepEqual(result.trace.answerRunIds, ["agent_test_step_1", "agent_test_step_2"]);
  assert.equal(result.trace.finalAnswerRunId, "agent_test_step_2");
  assert.deepEqual(result.trace.retryReasons, ["citation_retry"]);
  assert.deepEqual(result.trace.evidenceStatuses, ["insufficient_citations", "answerable"]);
});

test("agent carries adaptive retrieval retry strategy into step reasons", async () => {
  const document = makeDocument({
    id: "doc_graph",
    body: "Acme owns Beta through a verified subsidiary relationship."
  });
  const [chunk] = chunkDocument({ document }).chunks;
  assert.ok(chunk);
  const answerRuntime = new RagAnswerRuntime({
    retriever: new AdaptiveTraceRetriever(
      retrievalResult({
        requestMode: "keyword",
        chunk,
        retryStrategy: "graph_deepening"
      })
    ),
    now: () => FIXED_NOW
  });
  const agent = new RagAgentRuntime({ answerRuntime, now: () => FIXED_NOW });

  const result = await agent.run({
    profile,
    question: "How is Acme connected to Beta?",
    filter: makeIndexFilter(),
    model: new FakeModelAdapter({ now: () => FIXED_NOW }),
    topK: 1,
    maxSteps: 2,
    runId: "agent_graph_test",
    traceId: "trace_agent_graph_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.steps[1]?.reason, "graph_deepening");
  assert.equal(result.steps[1]?.topK, 2);
  assert.equal(result.steps[1]?.candidatePoolLimit, 40);
  assert.equal(result.steps[0]?.retryPlan.adaptiveRetryStrategy, "graph_deepening");
  assert.deepEqual(result.trace.retryReasons, ["graph_deepening"]);
});

test("agent records retry-disabled stop reasons without another answer run", async () => {
  const answerRuntime = new RagAnswerRuntime({
    retriever: new KeywordRetriever({
      chunkStore: makeIndexWithDocuments([
        makeDocument({
          id: "doc_refund_1",
          body: "Refund policy requires approval for refund requests."
        })
      ]),
      now: () => FIXED_NOW
    }),
    now: () => FIXED_NOW
  });
  const agent = new RagAgentRuntime({ answerRuntime, now: () => FIXED_NOW });

  const result = await agent.run({
    profile,
    question: "What does refund policy require?",
    filter: makeIndexFilter(),
    model: new FakeModelAdapter({ now: () => FIXED_NOW }),
    topK: 1,
    maxSteps: 3,
    retryWhenEvidenceInsufficient: false,
    runId: "agent_retry_disabled_test",
    traceId: "trace_agent_retry_disabled_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]?.retryPlan.planned, false);
  assert.equal(result.steps[0]?.retryPlan.evidenceStatus, "insufficient_citations");
  assert.equal(result.steps[0]?.retryPlan.stoppedBecause, "retry_disabled");
  assert.deepEqual(result.trace.retryReasons, []);
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

class AdaptiveTraceRetriever implements Retriever {
  readonly capabilities: RetrieverCapabilities = {
    modes: ["keyword"],
    supportsVectorSearch: false,
    supportsHybridSearch: false,
    supportsGraphSearch: true
  };

  constructor(private readonly result: RetrievalResult) {}

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    return {
      ...this.result,
      trace: {
        ...this.result.trace,
        retrievalId: request.retrievalId ?? this.result.trace.retrievalId
      }
    };
  }
}

function retrievalResult(input: {
  readonly requestMode: RetrievalRequest["mode"];
  readonly chunk: NonNullable<ReturnType<typeof chunkDocument>["chunks"][number]>;
  readonly retryStrategy: AdaptiveRetrievalStrategy;
}): RetrievalResult {
  return {
    query: "relationship query",
    candidates: [
      {
        chunk: input.chunk,
        score: 1,
        rank: 1,
        matchedTerms: ["connected"],
        citation: input.chunk.citation,
        reasons: ["keyword_term_match"]
      }
    ],
    rejected: [],
    trace: {
      retrievalId: "adaptive_trace_retrieval",
      startedAt: FIXED_NOW,
      finishedAt: FIXED_NOW,
      mode: input.requestMode ?? "keyword",
      queryHash: "query_hash",
      normalizedQueryHash: "normalized_query_hash",
      searchTermHashes: [],
      access: {
        tenantId: "tenant_1",
        namespaceId: "test-namespace",
        principalHash: "principal_hash",
        principalNamespaceCount: 1,
        principalTeamCount: 0,
        principalRoleCount: 0,
        principalTagCount: 0,
        documentIdCount: 0,
        chunkIdCount: 0,
        sourceIdCount: 0,
        sourceKindCount: 0,
        trustTierCount: 0,
        includeSafetyFlagCount: 0,
        excludeSafetyFlagCount: 0,
        accessTagCount: 0
      },
      candidatePoolSize: 1,
      returnedCount: 1,
      rejectedCount: 0,
      adaptiveStrategy: {
        initialStrategy: "graph_augmented",
        reason: "question_or_plan_requested_graph_evidence",
        diagnosis: {
          code: "graph_requested",
          reason: "graph_evidence_requested",
          candidateCount: 1,
          rejectedCount: 0,
          trustedCandidateCount: 1
        },
        retryStrategy: input.retryStrategy,
        retryReason: "graph_evidence_requested",
        finalDecision: "insufficient_evidence",
        attemptedStrategies: ["graph_augmented", input.retryStrategy]
      }
    }
  };
}
