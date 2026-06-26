import assert from "node:assert/strict";
import test from "node:test";

import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { FIXED_NOW, makeDocument, makeChunks } from "../test-support/fixtures.js";
import {
  buildGraphExtractionTrace,
  runGraphExtractor,
  type GraphExtractionRequest,
  type GraphExtractionResult,
  type GraphExtractor
} from "./graph-extractor.js";
import type { GraphExtractionBatch } from "./graph-types.js";
import { ownershipGraphOntology } from "./ownership-ontology.js";

const profile = assertValidProfile({
  ...genericDocsProfile,
  namespaceId: "test-namespace"
});

test("graph extractor contract accepts validated ownership batches", async () => {
  const document = makeDocument();
  const chunks = makeChunks(document);
  const request = makeRequest(document, chunks);
  const extractor = fakeExtractor((input) => {
    const batch = makeBatch(input, "supported");
    return {
      status: "succeeded",
      batch,
      validationIssues: [],
      trace: buildGraphExtractionTrace({
        request: input,
        extractionId: input.extractionId ?? "extract_1",
        startedAt: input.requestedAt ?? FIXED_NOW,
        finishedAt: FIXED_NOW,
        status: "succeeded",
        entityCount: batch.entities.length,
        relationCount: batch.relations.length
      })
    };
  });

  const result = await runGraphExtractor(extractor, request, { now: () => FIXED_NOW });

  assert.equal(result.status, "succeeded");
  assert.equal(result.trace.ontologyId, ownershipGraphOntology.id);
  assert.equal(result.trace.entityCount, 2);
  assert.equal(result.trace.relationCount, 1);
});

test("graph extractor contract fails unsupported ontologies before model work", async () => {
  let called = false;
  const document = makeDocument();
  const result = await runGraphExtractor(
    fakeExtractor(async () => {
      called = true;
      throw new Error("should not run");
    }, []),
    makeRequest(document, makeChunks(document)),
    { now: () => FIXED_NOW }
  );

  assert.equal(called, false);
  assert.equal(result.status, "failed");
  assert.equal(result.trace.validationErrorCount, 0);
  assert.equal(result.status === "failed" ? result.failure.code : "", "unsupported_ontology");
});

test("graph extractor contract rejects invalid batches returned by providers", async () => {
  const document = makeDocument();
  const chunks = makeChunks(document);
  const request = makeRequest(document, chunks);
  const extractor = fakeExtractor((input) => ({
    status: "succeeded",
    batch: makeBatch(input, "missing_relation_evidence"),
    validationIssues: [],
    trace: buildGraphExtractionTrace({
      request: input,
      extractionId: input.extractionId ?? "extract_1",
      startedAt: input.requestedAt ?? FIXED_NOW,
      finishedAt: FIXED_NOW,
      status: "succeeded"
    })
  }));

  const result = await runGraphExtractor(extractor, request, { now: () => FIXED_NOW });

  assert.equal(result.status, "failed");
  assert.equal(result.status === "failed" ? result.failure.code : "", "extractor_failed");
});

function makeRequest(
  document: ReturnType<typeof makeDocument>,
  chunks: ReturnType<typeof makeChunks>
): GraphExtractionRequest {
  return {
    profile,
    ontology: ownershipGraphOntology,
    documents: [document],
    chunks,
    extractionId: "extract_1",
    requestedAt: FIXED_NOW
  };
}

function fakeExtractor(
  handler: (
    request: GraphExtractionRequest
  ) => GraphExtractionResult | Promise<GraphExtractionResult>,
  supportedOntologyIds: readonly string[] = [ownershipGraphOntology.id]
): GraphExtractor {
  return {
    id: "fake-graph-extractor",
    supportedOntologyIds,
    extract: async (request) => handler(request)
  };
}

function makeBatch(
  request: GraphExtractionRequest,
  mode: "supported" | "missing_relation_evidence"
): GraphExtractionBatch {
  const chunk = request.chunks[0];
  if (!chunk) {
    throw new Error("fixture requires at least one chunk");
  }

  const anchor = {
    chunkId: chunk.id,
    documentId: chunk.documentId,
    sourceId: chunk.provenance.sourceId,
    citation: chunk.citation,
    quoteHash: chunk.textHash,
    characterStart: chunk.characterStart,
    characterEnd: chunk.characterEnd
  };

  return {
    id: "batch_1",
    namespaceId: request.profile.namespaceId,
    ontology: request.ontology,
    entities: [
      {
        id: "entity_parent",
        namespaceId: request.profile.namespaceId,
        kind: "legal_entity",
        name: "Parent LLC",
        normalizedName: "parent",
        confidence: 0.92,
        trustTier: "trusted_internal",
        accessScope: chunk.accessScope,
        evidence: [anchor],
        status: "proposed",
        createdAt: FIXED_NOW
      },
      {
        id: "entity_child",
        namespaceId: request.profile.namespaceId,
        kind: "legal_entity",
        name: "Child LLC",
        normalizedName: "child",
        confidence: 0.9,
        trustTier: "trusted_internal",
        accessScope: chunk.accessScope,
        evidence: [anchor],
        status: "proposed",
        createdAt: FIXED_NOW
      }
    ],
    relations: [
      {
        id: "relation_owns",
        namespaceId: request.profile.namespaceId,
        relationKind: "owns",
        sourceEntityId: "entity_parent",
        targetEntityId: "entity_child",
        factStrength: "explicit_fact",
        confidence: 0.86,
        trustTier: "trusted_internal",
        accessScope: chunk.accessScope,
        evidence: mode === "supported" ? [anchor] : [],
        temporal: {
          observedAt: FIXED_NOW
        },
        verificationStatus: "not_checked",
        status: "proposed",
        createdAt: FIXED_NOW
      }
    ],
    createdAt: FIXED_NOW
  };
}
