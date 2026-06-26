import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import { FakeEmbeddingAdapter } from "../embeddings/fake-embedding-adapter.js";
import { EmbeddingIndexer } from "../embeddings/embedding-indexer.js";
import type { RagDocument } from "../documents/document.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { InMemoryVectorStore } from "../indexing/vector-store.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { RagAnswerRuntime } from "../runtime/rag-answer-runtime.js";
import { FakeModelAdapter } from "../model/fake-model-adapter.js";
import {
  FIXED_NOW,
  makeDocument,
  makeIndexFilter,
  makePrincipal
} from "../test-support/fixtures.js";
import { VectorRetriever } from "./vector-retriever.js";

test("retrieves vector matches with citations and redacted trace fields", async () => {
  const { retriever } = await makeVectorRetriever([
    makeDocument({
      id: "doc_refund",
      body: "Refund billing policy requires support review."
    }),
    makeDocument({
      id: "doc_login",
      body: "Login password reset steps for account recovery."
    })
  ]);

  const result = await retriever.retrieve({
    query: "refund billing",
    filter: makeIndexFilter(),
    topK: 2,
    retrievalId: "vector_retrieval_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.candidates[0]?.chunk.documentId, "doc_refund");
  assert.equal(result.candidates[0]?.citation.chunkId, result.candidates[0]?.chunk.id);
  assert.equal(result.candidates[0]?.reasons.includes("vector_cosine_similarity"), true);
  assert.deepEqual(result.candidates[0]?.matchedTerms, []);
  assert.equal(result.trace.mode, "vector");
  assert.equal(result.trace.retrievalId, "vector_retrieval_test");
  assert.deepEqual(result.trace.searchTermHashes, []);
  assert.equal(result.trace.returnedCount, 2);
});

test("advertises honest vector-only retrieval capabilities", async () => {
  const { retriever } = await makeVectorRetriever([makeDocument()]);

  assert.deepEqual(retriever.capabilities.modes, ["vector"]);
  assert.equal(retriever.capabilities.supportsVectorSearch, true);
  assert.equal(retriever.capabilities.supportsHybridSearch, false);
});

test("vector retriever refuses to serve keyword mode", async () => {
  const { retriever } = await makeVectorRetriever([makeDocument()]);

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

test("runtime can answer with a profile configured for vector retrieval", async () => {
  const profile = assertValidProfile({
    ...genericDocsProfile,
    retrieval: {
      ...genericDocsProfile.retrieval,
      mode: "vector"
    }
  });
  const principal = makePrincipal({
    namespaceIds: [profile.namespaceId],
    roles: ["reader"],
    tags: ["curated", "docs"]
  });
  const { retriever } = await makeVectorRetriever(
    [
      makeDocument({
        id: "doc_refund",
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
  assert.equal("context" in result ? result.context.evidence.status : undefined, "answerable");
  assert.equal(result.trace.retrievalId?.includes("retrieval"), true);
});

async function makeVectorRetriever(
  documents: readonly RagDocument[],
  dimensions = 32
): Promise<{
  readonly retriever: VectorRetriever;
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
    retriever: new VectorRetriever({
      embeddingAdapter,
      vectorStore,
      now: () => FIXED_NOW
    }),
    chunkIndex,
    vectorStore
  };
}
