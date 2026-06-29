import assert from "node:assert/strict";
import test from "node:test";

import type { RagChunk } from "../documents/chunk.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import type { Retriever, RetrieverCapabilities } from "./retriever.js";
import type { RetrievalRequest, RetrievalResult } from "./retrieval-types.js";
import { FIXED_NOW, makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import { hashText } from "../shared/hash.js";
import {
  ConnectedChunkRetriever,
  type ConnectedChunkRelationship
} from "./connected-chunk-retriever.js";

test("connected chunk retriever adds adjacent chunks from the same document", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const document = makeDocument({
    id: "doc_policy",
    body: "Refund definitions and scope.\n\nRefund approvals require manager review.\n\nApproved refunds must include a support note."
  });
  const chunks = makeChunks(document);
  index.addDocument(document);
  index.addChunks(document.id, chunks);

  const retriever = new ConnectedChunkRetriever({
    retriever: new StaticRetriever(resultWithCandidates([candidate(chunks[1], 1, 1)])),
    chunkStore: index
  });

  const result = await retriever.retrieve(request());

  assert.deepEqual(
    result.candidates.map((entry) => entry.chunk.id),
    [chunks[1]?.id, chunks[0]?.id, chunks[2]?.id]
  );
  assert.ok(result.candidates[1]?.reasons.includes("connected_previous_chunk"));
  assert.ok(result.candidates[2]?.reasons.includes("connected_next_chunk"));
  assert.equal(result.trace.fusionStrategy, "connected_chunk_expansion");
});

test("connected chunk retriever adds graph relationship evidence chunks", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const document = makeDocument({
    id: "doc_relationship",
    body: "Acme is the customer account.\n\nAcme owns Beta through a verified subsidiary filing.\n\nBeta escalation policy requires legal review."
  });
  const chunks = makeChunks(document);
  index.addDocument(document);
  index.addChunks(document.id, chunks);

  const seed = candidate(chunks[0], 1, 1, {
    seed: { id: "entity_acme", name: "Acme" },
    target: { id: "entity_beta", name: "Beta" },
    depth: 1,
    edges: [
      {
        relationId: "rel_acme_beta",
        relationType: "owns",
        from: { id: "entity_acme", name: "Acme" },
        to: { id: "entity_beta", name: "Beta" },
        depth: 1,
        evidenceChunkIds: [chunks[1]?.id ?? ""]
      }
    ]
  });
  const retriever = new ConnectedChunkRetriever({
    retriever: new StaticRetriever(resultWithCandidates([seed])),
    chunkStore: index,
    adjacentWindow: 0
  });

  const result = await retriever.retrieve(request());

  assert.deepEqual(
    result.candidates.map((entry) => entry.chunk.id),
    [chunks[0]?.id, chunks[1]?.id]
  );
  assert.ok(result.candidates[1]?.reasons.includes("connected_graph_evidence_chunk"));
  assert.equal(result.candidates[1]?.graphEvidence?.edges[0]?.relationType, "owns");
  assert.equal(result.trace.candidatePoolSize, 2);
});

test("connected chunk retriever follows explicit ingested chunk relationships", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const document = makeDocument({
    id: "doc_explicit_relation",
    body: "A policy summary.\n\nA referenced exception table.\n\nA final note."
  });
  const chunks = makeChunks(document);
  index.addDocument(document);
  index.addChunks(document.id, chunks);
  const relationship: ConnectedChunkRelationship = {
    id: "chunk_rel:references:0:1",
    documentId: document.id,
    fromChunkId: chunks[0].id,
    toChunkId: chunks[1].id,
    kind: "references",
    evidence: "layout_relation",
    weight: 0.78
  };
  const retriever = new ConnectedChunkRetriever({
    retriever: new StaticRetriever(resultWithCandidates([candidate(chunks[0], 1, 1)])),
    chunkStore: index,
    adjacentWindow: 0,
    chunkRelationships: [relationship]
  });

  const result = await retriever.retrieve(request());

  assert.deepEqual(
    result.candidates.map((entry) => entry.chunk.id),
    [chunks[0].id, chunks[1].id]
  );
  assert.ok(result.candidates[1]?.reasons.includes("connected_references"));
});

class StaticRetriever implements Retriever {
  readonly capabilities: RetrieverCapabilities = {
    modes: ["keyword"],
    supportsVectorSearch: false,
    supportsHybridSearch: false
  };

  constructor(private readonly result: RetrievalResult) {}

  async retrieve(): Promise<RetrievalResult> {
    return this.result;
  }
}

function request(): RetrievalRequest {
  return {
    query: "refund policy",
    filter: makeIndexFilter(),
    topK: 3,
    mode: "keyword",
    retrievalId: "connected_retrieval_test",
    requestedAt: FIXED_NOW
  };
}

function resultWithCandidates(
  candidates: readonly RetrievalResult["candidates"][number][]
): RetrievalResult {
  return {
    query: "refund policy",
    candidates,
    rejected: [],
    trace: {
      retrievalId: "static_retrieval",
      startedAt: FIXED_NOW,
      finishedAt: FIXED_NOW,
      mode: "keyword",
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
      candidatePoolSize: candidates.length,
      returnedCount: candidates.length,
      rejectedCount: 0
    }
  };
}

function candidate(
  chunk: RagChunk,
  score: number,
  rank: number,
  graphEvidence?: RetrievalResult["candidates"][number]["graphEvidence"]
): RetrievalResult["candidates"][number] {
  return {
    chunk,
    score,
    rank,
    matchedTerms: ["refund"],
    citation: chunk.citation,
    reasons: ["seed"],
    ...(graphEvidence === undefined ? {} : { graphEvidence })
  };
}

function makeChunks(
  document: ReturnType<typeof makeDocument>
): readonly [RagChunk, RagChunk, RagChunk] {
  const texts = document.body.split("\n\n");
  assert.equal(texts.length, 3);
  return [
    makeChunk(document, texts[0] ?? "", 0, 0),
    makeChunk(document, texts[1] ?? "", 1, (texts[0]?.length ?? 0) + 2),
    makeChunk(
      document,
      texts[2] ?? "",
      2,
      (texts[0]?.length ?? 0) + 2 + (texts[1]?.length ?? 0) + 2
    )
  ];
}

function makeChunk(
  document: ReturnType<typeof makeDocument>,
  text: string,
  index: number,
  characterStart: number
): RagChunk {
  return {
    id: `${document.id}_chunk_${index}`,
    documentId: document.id,
    namespaceId: document.namespaceId,
    text,
    index,
    textHash: hashText(text),
    characterStart,
    characterEnd: characterStart + text.length,
    tokenEstimate: Math.max(1, Math.ceil(text.length / 4)),
    safetyFlags: [],
    provenance: document.provenance,
    citation: {
      sourceId: document.provenance.sourceId,
      chunkId: `${document.id}_chunk_${index}`,
      title: document.title,
      locator: `paragraph ${index + 1}`
    },
    accessScope: document.accessScope
  };
}
