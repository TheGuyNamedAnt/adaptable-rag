import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { RagDocument } from "../documents/document.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { FakeModelAdapter } from "../model/fake-model-adapter.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { KeywordRetriever } from "../retrieval/keyword-retriever.js";
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
  assert.equal(result.steps[1]?.reason, "evidence_retry");
  assert.equal(result.steps[1]?.topK, 2);
  assert.equal(result.final.status, "succeeded");
  assert.deepEqual(result.trace.answerRunIds, ["agent_test_step_1", "agent_test_step_2"]);
  assert.equal(result.trace.finalAnswerRunId, "agent_test_step_2");
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
