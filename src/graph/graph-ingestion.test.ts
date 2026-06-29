import assert from "node:assert/strict";
import test from "node:test";

import { CorpusAdapterRegistry } from "../corpus/adapter-registry.js";
import { DatabaseCorpusAdapter } from "../corpus/database-corpus-adapter.js";
import { IngestPipeline } from "../ingestion/ingest-pipeline.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import type { RagProfile } from "../profiles/profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { KeywordRetriever } from "../retrieval/keyword-retriever.js";
import { GraphAugmentedRetriever } from "../retrieval/graph-augmented-retriever.js";
import { ownerDefinedAclMapper } from "../security/connector-acl-mapper.js";
import {
  FIXED_NOW,
  makeChunks,
  makeDocument,
  makeIndexFilter,
  makePrincipal
} from "../test-support/fixtures.js";
import { GraphApprovalRunner } from "./graph-approval.js";
import {
  buildGraphExtractionTrace,
  type GraphExtractionRequest,
  type GraphExtractionResult,
  type GraphExtractor
} from "./graph-extractor.js";
import { GraphIngestionRunner } from "./graph-ingestion.js";
import type { GraphExtractionBatch } from "./graph-types.js";
import { InMemoryGraphStore } from "./in-memory-graph-store.js";
import { ownershipGraphOntology } from "./ownership-ontology.js";
import { ProposalBackedRagGraphStore } from "./proposal-graph-adapter.js";

const profile = assertValidProfile({
  ...genericDocsProfile,
  namespaceId: "test-namespace"
});

test("graph ingestion runner extracts and writes validated graph proposals", async () => {
  const document = makeDocument({ body: "Parent LLC owns Child LLC." });
  const chunks = makeChunks(document);
  const graphStore = new InMemoryGraphStore();
  const runner = new GraphIngestionRunner({
    extractor: fakeExtractor((request) => successResult(request, makeBatch(request))),
    graphStore,
    now: () => FIXED_NOW
  });

  const result = await runner.ingest({
    profile,
    ontology: ownershipGraphOntology,
    documents: [document],
    chunks,
    ingestionId: "graph_ingest_1",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.graphIntegrity?.valid, true);
  assert.equal(result.trace.graphIntegrityStatus, "passed");
  assert.equal(result.trace.entityCount, 2);
  assert.equal(result.trace.relationCount, 1);
  assert.equal(result.trace.storedEntityCount, 2);
  assert.equal(result.trace.storedRelationCount, 1);
  assert.deepEqual(
    graphStore
      .findRelations({ filter: makeIndexFilter(), includeUnapproved: true })
      .map((relation) => relation.id),
    ["relation_owns"]
  );
});

test("graph ingestion runner can auto-approve stored graph proposals", async () => {
  const document = makeDocument({ body: "Parent LLC owns Child LLC." });
  const chunks = makeChunks(document);
  const graphStore = new InMemoryGraphStore();
  const runner = new GraphIngestionRunner({
    extractor: fakeExtractor((request) => successResult(request, makeBatch(request))),
    graphStore,
    approvalRunner: new GraphApprovalRunner({
      graphStore,
      now: () => FIXED_NOW
    }),
    now: () => FIXED_NOW
  });

  const result = await runner.ingest({
    profile,
    ontology: ownershipGraphOntology,
    documents: [document],
    chunks,
    approvalFilter: makeIndexFilter(),
    ingestionId: "graph_ingest_approval_1",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.graphIntegrity?.valid, true);
  assert.equal(result.approval?.approvedCount, 3);
  assert.equal(result.trace.approvalDecisionCount, 3);
  assert.equal(result.trace.approvedCount, 3);
  assert.deepEqual(
    graphStore.findRelations({ filter: makeIndexFilter() }).map((relation) => relation.id),
    ["relation_owns"]
  );
});

test("graph ingestion inherits owner-mapped connector ACLs into graph proposals and retrieval", async () => {
  const profile = connectorGraphProfile();
  const source = profile.corpusSources[0];
  assert.ok(source);

  const aclMapper = ownerDefinedAclMapper({
    id: "owner-acl",
    map: ({ nativeAcl, context }) => {
      const acl = nativeAcl as {
        readonly groups?: readonly string[];
        readonly labels?: readonly string[];
      };
      return {
        tenantId: context.defaultTenantId,
        namespaceId: context.defaultNamespaceId,
        teamIds: acl.groups ?? [],
        tags: [...context.defaultTags, ...(acl.labels ?? [])]
      };
    }
  });
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const ingest = await new IngestPipeline({
    adapterRegistry: new CorpusAdapterRegistry([
      new DatabaseCorpusAdapter({
        client: {
          query: async () => ({
            rows: [
              {
                id: "public-child",
                title: "Child Ownership Summary",
                body: "Child LLC is visible in the standard ownership summary.",
                acl: {
                  groups: ["support_team"],
                  labels: ["public"]
                }
              },
              {
                id: "private-parent",
                title: "Private Parent Memo",
                body: "Board memo: Parent LLC owns Child LLC.",
                acl: {
                  groups: ["board_team"],
                  labels: ["board_only"]
                }
              }
            ]
          })
        },
        sources: [
          {
            sourceId: source.id,
            queryName: "ownership_docs",
            aclMapper,
            mapping: {
              id: "id",
              title: "title",
              body: "body",
              accessScopeFrom: "acl"
            }
          }
        ]
      })
    ]),
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  }).ingest({
    profile,
    requestedBy: makePrincipal({
      tenantId: "tenant_1",
      namespaceIds: [profile.namespaceId],
      teamIds: ["support_team"],
      tags: ["connector", "public"]
    }),
    requestedAt: FIXED_NOW
  });
  const graphStore = new InMemoryGraphStore();
  const approvalPrincipal = makePrincipal({
    tenantId: "tenant_1",
    namespaceIds: [profile.namespaceId],
    teamIds: ["support_team", "board_team"],
    tags: ["connector", "public", "board_only"]
  });
  const graphResult = await new GraphIngestionRunner({
    extractor: fakeExtractor((request) => successResult(request, connectorAclBatch(request))),
    graphStore,
    approvalRunner: new GraphApprovalRunner({ graphStore, now: () => FIXED_NOW }),
    now: () => FIXED_NOW
  }).ingest({
    profile,
    ontology: ownershipGraphOntology,
    documents: ingest.documents,
    chunks: ingest.chunks,
    approvalFilter: makeIndexFilter({
      namespaceId: profile.namespaceId,
      principal: approvalPrincipal
    }),
    ingestionId: "connector_acl_graph_ingest",
    requestedAt: FIXED_NOW
  });
  const supportPrincipal = makePrincipal({
    tenantId: "tenant_1",
    namespaceIds: [profile.namespaceId],
    teamIds: ["support_team"],
    tags: ["connector", "public"]
  });
  const retriever = new GraphAugmentedRetriever({
    baseRetriever: new KeywordRetriever({ chunkStore: index, now: () => FIXED_NOW }),
    graphStore: new ProposalBackedRagGraphStore(graphStore),
    chunkStore: index,
    now: () => FIXED_NOW
  });
  const retrieved = await retriever.retrieve({
    query: "Who owns Child LLC?",
    filter: makeIndexFilter({
      namespaceId: profile.namespaceId,
      principal: supportPrincipal
    }),
    topK: 10,
    mode: "keyword",
    requestedAt: FIXED_NOW
  });
  const allRelations = graphStore.findRelations({
    filter: makeIndexFilter({
      namespaceId: profile.namespaceId,
      principal: approvalPrincipal
    }),
    includeUnapproved: true
  });

  assert.equal(ingest.rejectedRecords.length, 0);
  assert.equal(graphResult.status, "succeeded");
  assert.equal(graphResult.approval?.approvedCount, 3);
  assert.deepEqual(allRelations[0]?.accessScope, {
    tenantId: "tenant_1",
    namespaceId: profile.namespaceId,
    teamIds: ["board_team"],
    tags: ["connector", "board_only"]
  });
  assert.equal(
    graphStore.findRelations({
      filter: makeIndexFilter({
        namespaceId: profile.namespaceId,
        principal: supportPrincipal
      })
    }).length,
    0
  );
  assert.equal(
    retrieved.candidates.some((candidate) => candidate.chunk.documentId.includes("private")),
    false
  );
});

test("graph ingestion runner skips when no accepted chunks are available", async () => {
  let called = false;
  const runner = new GraphIngestionRunner({
    extractor: fakeExtractor(async () => {
      called = true;
      throw new Error("should not run");
    }),
    graphStore: new InMemoryGraphStore(),
    now: () => FIXED_NOW
  });

  const result = await runner.ingest({
    profile,
    ontology: ownershipGraphOntology,
    documents: [],
    chunks: [],
    requestedAt: FIXED_NOW
  });

  assert.equal(called, false);
  assert.equal(result.status, "skipped");
  assert.equal(result.trace.documentCount, 0);
  assert.equal(result.trace.chunkCount, 0);
});

test("graph ingestion runner fails soft when extraction fails and does not write proposals", async () => {
  const document = makeDocument();
  const chunks = makeChunks(document);
  const graphStore = new InMemoryGraphStore();
  const runner = new GraphIngestionRunner({
    extractor: fakeExtractor(async (request) => ({
      status: "failed",
      failure: {
        code: "provider_failed",
        message: "Provider failed.",
        retryable: true
      },
      validationIssues: [],
      trace: buildGraphExtractionTrace({
        request,
        extractionId: request.extractionId ?? "extract_1",
        startedAt: request.requestedAt ?? FIXED_NOW,
        finishedAt: FIXED_NOW,
        status: "failed"
      })
    })),
    graphStore,
    now: () => FIXED_NOW
  });

  const result = await runner.ingest({
    profile,
    ontology: ownershipGraphOntology,
    documents: [document],
    chunks,
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "failed");
  assert.equal(result.trace.extractionStatus, "failed");
  assert.deepEqual(
    graphStore.findRelations({ filter: makeIndexFilter(), includeUnapproved: true }),
    []
  );
});

test("graph ingestion runner fails before writing or approving ungrounded graph facts", async () => {
  const document = makeDocument({
    body: "Parent LLC and Child LLC appear in the annual report."
  });
  const chunks = makeChunks(document);
  const graphStore = new InMemoryGraphStore();
  const runner = new GraphIngestionRunner({
    extractor: fakeExtractor((request) => successResult(request, makeBatch(request))),
    graphStore,
    approvalRunner: new GraphApprovalRunner({ graphStore, now: () => FIXED_NOW }),
    now: () => FIXED_NOW
  });

  const result = await runner.ingest({
    profile,
    ontology: ownershipGraphOntology,
    documents: [document],
    chunks,
    approvalFilter: makeIndexFilter(),
    ingestionId: "graph_ingest_integrity_failure",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "failed");
  assert.equal(result.graphIntegrity?.valid, false);
  assert.equal(result.trace.graphIntegrityStatus, "failed");
  assert.equal(result.trace.graphIntegrityErrorCount, 1);
  assert.equal(result.storeWrite, undefined);
  assert.equal(result.approval, undefined);
  assert.deepEqual(
    result.graphIntegrity?.errors.map((issue) => issue.code),
    ["relation_kind_not_grounded"]
  );
  assert.deepEqual(
    graphStore.findRelations({ filter: makeIndexFilter(), includeUnapproved: true }),
    []
  );
});

function fakeExtractor(
  handler: (
    request: GraphExtractionRequest
  ) => GraphExtractionResult | Promise<GraphExtractionResult>
): GraphExtractor {
  return {
    id: "fake-graph-extractor",
    supportedOntologyIds: [ownershipGraphOntology.id],
    extract: async (request) => handler(request)
  };
}

function successResult(
  request: GraphExtractionRequest,
  batch: GraphExtractionBatch
): GraphExtractionResult {
  return {
    status: "succeeded",
    batch,
    validationIssues: [],
    trace: buildGraphExtractionTrace({
      request,
      extractionId: request.extractionId ?? "extract_1",
      startedAt: request.requestedAt ?? FIXED_NOW,
      finishedAt: FIXED_NOW,
      status: "succeeded",
      entityCount: batch.entities.length,
      relationCount: batch.relations.length
    })
  };
}

function makeBatch(request: GraphExtractionRequest): GraphExtractionBatch {
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
        evidence: [anchor],
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

function connectorAclBatch(request: GraphExtractionRequest): GraphExtractionBatch {
  const publicChunk = request.chunks.find((chunk) =>
    chunk.text.includes("standard ownership summary")
  );
  const privateChunk = request.chunks.find((chunk) => chunk.text.includes("Parent LLC owns Child"));
  if (!publicChunk || !privateChunk) {
    throw new Error("connector ACL fixture requires public and private chunks");
  }
  const publicAnchor = {
    chunkId: publicChunk.id,
    documentId: publicChunk.documentId,
    sourceId: publicChunk.provenance.sourceId,
    citation: publicChunk.citation,
    quoteHash: publicChunk.textHash,
    characterStart: publicChunk.characterStart,
    characterEnd: publicChunk.characterEnd
  };
  const privateAnchor = {
    chunkId: privateChunk.id,
    documentId: privateChunk.documentId,
    sourceId: privateChunk.provenance.sourceId,
    citation: privateChunk.citation,
    quoteHash: privateChunk.textHash,
    characterStart: privateChunk.characterStart,
    characterEnd: privateChunk.characterEnd
  };

  return {
    id: "connector_acl_batch",
    namespaceId: request.profile.namespaceId,
    ontology: request.ontology,
    entities: [
      {
        id: "entity_child",
        namespaceId: request.profile.namespaceId,
        kind: "legal_entity",
        name: "Child LLC",
        normalizedName: "child llc",
        confidence: 0.93,
        trustTier: publicChunk.provenance.trustTier,
        accessScope: publicChunk.accessScope,
        evidence: [publicAnchor],
        status: "proposed",
        createdAt: FIXED_NOW
      },
      {
        id: "entity_parent",
        namespaceId: request.profile.namespaceId,
        kind: "legal_entity",
        name: "Parent LLC",
        normalizedName: "parent llc",
        confidence: 0.94,
        trustTier: privateChunk.provenance.trustTier,
        accessScope: privateChunk.accessScope,
        evidence: [privateAnchor],
        status: "proposed",
        createdAt: FIXED_NOW
      }
    ],
    relations: [
      {
        id: "relation_parent_owns_child",
        namespaceId: request.profile.namespaceId,
        relationKind: "owns",
        sourceEntityId: "entity_parent",
        targetEntityId: "entity_child",
        factStrength: "explicit_fact",
        confidence: 0.91,
        trustTier: privateChunk.provenance.trustTier,
        accessScope: privateChunk.accessScope,
        evidence: [privateAnchor],
        temporal: { observedAt: FIXED_NOW },
        verificationStatus: "supported",
        status: "proposed",
        createdAt: FIXED_NOW
      }
    ],
    createdAt: FIXED_NOW
  };
}

function connectorGraphProfile() {
  const source = genericDocsProfile.corpusSources[0];
  assert.ok(source);

  return assertValidProfile({
    ...genericDocsProfile,
    id: "connector-graph-acl",
    namespaceId: "connector-graph-acl",
    corpusSources: [
      {
        ...source,
        id: "connector_docs",
        adapter: "database",
        description: "Connector documents with owner-defined ACLs.",
        trustTierFloor: "trusted_internal",
        tags: ["connector"]
      }
    ],
    citationPolicy: {
      ...genericDocsProfile.citationPolicy,
      allowedSourceKindsForCitations: [
        ...genericDocsProfile.citationPolicy.allowedSourceKindsForCitations,
        "database_row"
      ]
    }
  } satisfies RagProfile);
}
