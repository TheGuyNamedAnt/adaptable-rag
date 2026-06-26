import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { RagDocument } from "../documents/document.js";
import { GraphApprovalRunner, ThresholdGraphApprovalPolicy } from "../graph/graph-approval.js";
import { GraphEntityResolutionRunner } from "../graph/graph-entity-resolution.js";
import { InMemoryRagGraphStore } from "../graph/graph-store.js";
import type {
  GraphEntityProposal,
  GraphEvidenceAnchor,
  GraphExtractionBatch,
  GraphRelationProposal
} from "../graph/graph-types.js";
import { validateGraphExtractionBatch } from "../graph/graph-validation.js";
import { InMemoryGraphStore } from "../graph/in-memory-graph-store.js";
import { ownershipGraphOntology } from "../graph/ownership-ontology.js";
import { ProposalBackedRagGraphStore } from "../graph/proposal-graph-adapter.js";
import { checkRelationEvidenceFaithfulness } from "../graph/relation-evidence-faithfulness.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { GraphAugmentedRetriever } from "../retrieval/graph-augmented-retriever.js";
import type { RetrievalGraphPathEvidence } from "../retrieval/graph-evidence.js";
import { KeywordRetriever } from "../retrieval/keyword-retriever.js";
import {
  FIXED_NOW,
  makeDocument,
  makeIndexFilter,
  makePrincipal
} from "../test-support/fixtures.js";
import { checkRelationshipClaimGrounding } from "./relationship-claim-grounding.js";

test("graph eval gate: one-hop retrieval recalls ownership evidence", async () => {
  const { index, chunksByDocument } = makeIndex([
    makeDocument({
      id: "doc_parent",
      title: "Parent LLC ownership memo",
      body: "Parent LLC is the controlling member in the structure."
    }),
    makeDocument({
      id: "doc_child",
      title: "Child LLC operating agreement",
      body: "Child LLC is wholly owned by Parent LLC."
    })
  ]);
  const graph = new InMemoryRagGraphStore();
  graph.upsertEntity({
    id: "entity_parent",
    name: "Parent LLC",
    chunkIds: [firstChunkId(chunksByDocument, "doc_parent")]
  });
  graph.upsertEntity({
    id: "entity_child",
    name: "Child LLC",
    aliases: ["subsidiary"],
    chunkIds: [firstChunkId(chunksByDocument, "doc_child")]
  });
  graph.upsertRelationship({
    id: "rel_parent_owns_child",
    fromEntityId: "entity_parent",
    toEntityId: "entity_child",
    type: "owns",
    highLevelKeywords: ["ownership", "parent", "child"],
    chunkIds: [firstChunkId(chunksByDocument, "doc_child")]
  });

  const result = await makeGraphRetriever(index, graph).retrieve({
    query: "Who owns Child LLC?",
    filter: makeIndexFilter(),
    topK: 5,
    mode: "keyword",
    requestedAt: FIXED_NOW
  });

  assert.equal(
    result.candidates.some(
      (candidate) =>
        candidate.chunk.documentId === "doc_parent" ||
        candidate.reasons.includes("graph_one_hop:owns")
    ),
    true
  );
});

test("graph eval gate: ownership validation rejects orphan relation endpoints", () => {
  const valid = validateGraphExtractionBatch(makeOwnershipBatch());
  const invalid = validateGraphExtractionBatch(
    makeOwnershipBatch({
      relations: [
        makeRelation({
          id: "rel_orphan",
          sourceEntityId: "entity_parent",
          targetEntityId: "entity_missing",
          relationKind: "owns"
        })
      ]
    })
  );

  assert.equal(valid.valid, true);
  assert.equal(
    invalid.errors.some((issue) => issue.code === "unknown_relation_entity"),
    true
  );
});

test("graph eval gate: graph expansion cannot leak denied ownership chunks", async () => {
  const deniedPrincipal = makePrincipal({ tags: ["support"], roles: ["support"] });
  const { index, chunksByDocument } = makeIndex([
    makeDocument({
      id: "doc_public_child",
      body: "Child LLC appears in the support-accessible entity memo."
    }),
    makeDocument({
      id: "doc_private_owner",
      body: "Board memo: Parent LLC secretly owns Child LLC.",
      accessScope: {
        tenantId: "tenant_1",
        namespaceId: "test-namespace",
        tags: ["board_only"]
      }
    })
  ]);
  const graph = new InMemoryRagGraphStore();
  graph.upsertEntity({
    id: "entity_child",
    name: "Child LLC",
    chunkIds: [firstChunkId(chunksByDocument, "doc_public_child")]
  });
  graph.upsertEntity({
    id: "entity_parent",
    name: "Parent LLC",
    chunkIds: [firstChunkId(chunksByDocument, "doc_private_owner")]
  });
  graph.upsertRelationship({
    id: "rel_private_owner",
    fromEntityId: "entity_parent",
    toEntityId: "entity_child",
    type: "owns",
    highLevelKeywords: ["ownership"],
    chunkIds: [firstChunkId(chunksByDocument, "doc_private_owner")]
  });

  const result = await makeGraphRetriever(index, graph).retrieve({
    query: "Who owns Child LLC?",
    filter: makeIndexFilter({ principal: deniedPrincipal }),
    topK: 5,
    mode: "keyword",
    requestedAt: FIXED_NOW
  });

  assert.equal(
    result.candidates.some((candidate) => candidate.chunk.documentId === "doc_private_owner"),
    false
  );
});

test("graph eval gate: approval policy separates supported, inferred, and unsupported edges", () => {
  const store = new InMemoryGraphStore();
  store.addExtractionBatch(
    makeOwnershipBatch({
      ontology: {
        ...ownershipGraphOntology,
        allowInferredRelations: true
      },
      relations: [
        makeRelation({
          id: "rel_high_confidence",
          relationKind: "owns",
          confidence: 0.94,
          verificationStatus: "supported"
        }),
        makeRelation({
          id: "rel_inferred",
          relationKind: "controls",
          confidence: 0.96,
          factStrength: "inferred_fact",
          verificationStatus: "supported"
        }),
        makeRelation({
          id: "rel_unsupported",
          relationKind: "owns",
          confidence: 0.99,
          verificationStatus: "unsupported"
        })
      ]
    })
  );

  const result = new GraphApprovalRunner({
    graphStore: store,
    policy: new ThresholdGraphApprovalPolicy({
      entityConfidenceThreshold: 0.8,
      relationConfidenceThreshold: 0.9,
      autoApproveRelationKinds: ["owns", "controls"]
    }),
    now: () => FIXED_NOW
  }).approve({
    filter: makeIndexFilter(),
    runId: "graph_eval_approval",
    requestedAt: FIXED_NOW
  });
  const byId = new Map(result.decisions.map((decision) => [decision.id, decision.status]));

  assert.equal(byId.get("rel_high_confidence"), "approved");
  assert.equal(byId.get("rel_inferred"), "needs_review");
  assert.equal(byId.get("rel_unsupported"), "rejected");
});

test("graph eval gate: relation evidence faithfulness rejects unrelated cited chunks", () => {
  const faithful = makeOwnershipBatch({
    relations: [
      makeRelation({
        id: "rel_faithful",
        relationKind: "owns",
        evidence: [makeEvidence({ chunkId: "chunk_supported" })]
      })
    ]
  });
  const unfaithful = makeOwnershipBatch({
    relations: [
      makeRelation({
        id: "rel_unfaithful",
        relationKind: "owns",
        evidence: [makeEvidence({ chunkId: "chunk_unrelated" })]
      })
    ]
  });

  assert.equal(
    checkRelationEvidenceFaithfulness({
      entities: faithful.entities,
      relations: faithful.relations,
      chunks: [
        makeChunk({
          id: "chunk_supported",
          body: "Parent LLC owns Child LLC under the operating agreement."
        })
      ]
    }).faithful,
    true
  );
  const result = checkRelationEvidenceFaithfulness({
    entities: unfaithful.entities,
    relations: unfaithful.relations,
    chunks: [
      makeChunk({
        id: "chunk_unrelated",
        body: "Parent LLC filed an annual report. The document does not discuss Child LLC."
      })
    ]
  });

  assert.equal(result.faithful, false);
  assert.deepEqual(
    result.issues.map((issue) => issue.code),
    ["relation_kind_not_supported"]
  );
});

test("graph eval gate: relation evidence faithfulness accepts built-in relation terms", () => {
  const cases = [
    ["controls", "controls"],
    ["manages", "manages"],
    ["beneficiary_of", "beneficiary of"],
    ["trustee_of", "trustee of"],
    ["director_of", "director of"],
    ["signatory_of", "signed by"],
    ["guarantees", "guarantees"],
    ["owes", "owes debt payable to"],
    ["member_of", "member of"],
    ["registered_in", "registered in"],
    ["formed_on", "formed on"],
    ["expires_on", "expires on"],
    ["reports_metric", "reports metric"],
    ["supplies", "supplies"],
    ["customer_of", "customer of"],
    ["partner_of", "partner of"],
    ["related_to", "related to"],
    ["custom_relation_kind", "custom relation kind"]
  ] as const;

  for (const [relationKind, phrase] of cases) {
    const batch = makeOwnershipBatch({
      relations: [
        makeRelation({
          id: `rel_${relationKind}`,
          relationKind,
          evidence: [makeEvidence({ chunkId: `chunk_${relationKind}` })]
        })
      ]
    });
    const result = checkRelationEvidenceFaithfulness({
      entities: batch.entities,
      relations: batch.relations,
      chunks: [
        makeChunk({
          id: `chunk_${relationKind}`,
          body: `Parent LLC ${phrase} Child LLC under the source agreement.`
        })
      ]
    });

    assert.equal(result.faithful, true, relationKind);
    assert.deepEqual(result.issues, [], relationKind);
  }
});

test("graph eval gate: relation evidence faithfulness reports structural evidence failures", () => {
  const batch = makeOwnershipBatch({
    relations: [
      makeRelation({
        id: "rel_missing_endpoint",
        sourceEntityId: "entity_missing",
        evidence: [makeEvidence({ chunkId: "chunk_supported" })]
      }),
      makeRelation({
        id: "rel_missing_evidence",
        evidence: []
      }),
      makeRelation({
        id: "rel_unknown_chunk",
        evidence: [makeEvidence({ chunkId: "chunk_unknown" })]
      }),
      makeRelation({
        id: "rel_missing_source",
        evidence: [makeEvidence({ chunkId: "chunk_missing_source" })]
      }),
      makeRelation({
        id: "rel_missing_target",
        evidence: [makeEvidence({ chunkId: "chunk_missing_target" })]
      })
    ]
  });

  const result = checkRelationEvidenceFaithfulness({
    entities: batch.entities,
    relations: batch.relations,
    chunks: [
      makeChunk({
        id: "chunk_supported",
        body: "Parent LLC owns Child LLC."
      }),
      makeChunk({
        id: "chunk_missing_source",
        body: "Another parent owns Child LLC."
      }),
      makeChunk({
        id: "chunk_missing_target",
        body: "Parent LLC owns another child."
      })
    ]
  });

  assert.equal(result.faithful, false);
  assert.deepEqual(
    result.issues.map((issue) => issue.code),
    [
      "missing_relation_endpoint",
      "missing_relation_evidence",
      "unknown_evidence_chunk",
      "source_entity_not_supported",
      "target_entity_not_supported"
    ]
  );
});

test("graph eval gate: entity dedup resolves legal suffix variants and rewires relations", () => {
  const store = new InMemoryGraphStore();
  store.addExtractionBatch(
    makeOwnershipBatch({
      entities: [
        makeEntity({
          id: "entity_acme_canonical",
          name: "Acme LLC",
          normalizedName: "acme llc",
          confidence: 0.96,
          status: "approved"
        }),
        makeEntity({
          id: "entity_acme_duplicate",
          name: "ACME, L.L.C.",
          normalizedName: "acme l l c",
          confidence: 0.89,
          status: "approved"
        }),
        makeEntity({
          id: "entity_child",
          name: "Child LLC",
          normalizedName: "child llc",
          confidence: 0.91,
          status: "approved"
        })
      ],
      relations: [
        makeRelation({
          id: "rel_duplicate_owns_child",
          sourceEntityId: "entity_acme_duplicate",
          targetEntityId: "entity_child",
          relationKind: "owns",
          status: "approved"
        })
      ]
    })
  );

  const result = new GraphEntityResolutionRunner({
    graphStore: store,
    now: () => FIXED_NOW
  }).resolve({
    filter: makeIndexFilter(),
    runId: "graph_eval_entity_dedup",
    requestedAt: FIXED_NOW
  });
  const retrievalGraph = new ProposalBackedRagGraphStore(store);

  assert.equal(result.canonicalCount, 1);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.rewiredRelationCount, 1);
  assert.deepEqual(result.decisions[0]?.duplicateEntityIds, ["entity_acme_duplicate"]);
  assert.deepEqual(
    store
      .findRelations({ filter: makeIndexFilter(), includeUnapproved: true })
      .map((relation) => [relation.id, relation.sourceEntityId, relation.targetEntityId]),
    [["rel_duplicate_owns_child", "entity_acme_canonical", "entity_child"]]
  );
  assert.deepEqual(
    retrievalGraph.findEntities(["acme"], 10, makeIndexFilter()).map((match) => match.entity.id),
    ["entity_acme_canonical"]
  );
});

test("graph eval gate: relationship claim grounding accepts a cited supported chain", () => {
  const result = checkRelationshipClaimGrounding({
    contextBlocks: [
      {
        chunkId: "chunk_parent_candidate",
        graphEvidence: makeRelationshipPathEvidence()
      }
    ],
    citedChunkIds: ["chunk_parent_candidate"],
    expectedPaths: [
      {
        depth: 2,
        requireEdgeEvidence: true,
        edges: [
          {
            relationType: "owns",
            fromEntityId: "entity_parent",
            toEntityId: "entity_child"
          },
          {
            relationType: "owns",
            fromEntityId: "entity_child",
            toEntityId: "entity_operating_subsidiary"
          }
        ]
      }
    ]
  });

  assert.equal(result.passed, true);
  assert.equal(result.matchedPathCount, 1);
  assert.deepEqual(result.failures, []);
});

test("graph eval gate: relationship claim grounding rejects unsupported chains", () => {
  const result = checkRelationshipClaimGrounding({
    contextBlocks: [
      {
        chunkId: "chunk_parent_candidate",
        graphEvidence: makeRelationshipPathEvidence()
      }
    ],
    citedChunkIds: ["chunk_parent_candidate"],
    expectedPaths: [
      {
        depth: 2,
        requireEdgeEvidence: true,
        edges: [
          {
            relationType: "owns",
            fromEntityId: "entity_parent",
            toEntityId: "entity_operating_subsidiary"
          }
        ]
      }
    ]
  });

  assert.equal(result.passed, false);
  assert.equal(result.matchedPathCount, 0);
  assert.equal(result.failures.length, 1);
});

test("graph eval gate: relationship claim grounding ignores uncited relationship paths", () => {
  const result = checkRelationshipClaimGrounding({
    contextBlocks: [
      {
        chunkId: "chunk_parent_candidate",
        graphEvidence: makeRelationshipPathEvidence()
      }
    ],
    citedChunkIds: ["chunk_other"],
    expectedPaths: [
      {
        depth: 2,
        edges: [
          {
            relationType: "owns",
            fromName: "Parent LLC",
            toName: "Child LLC"
          },
          {
            relationType: "owns",
            fromName: "Child LLC",
            toName: "Operating Subsidiary LLC"
          }
        ]
      }
    ]
  });

  assert.equal(result.passed, false);
  assert.equal(result.matchedPathCount, 0);
});

function makeGraphRetriever(
  index: InMemoryRagIndex,
  graph: InMemoryRagGraphStore
): GraphAugmentedRetriever {
  return new GraphAugmentedRetriever({
    baseRetriever: new KeywordRetriever({ chunkStore: index, now: () => FIXED_NOW }),
    graphStore: graph,
    chunkStore: index,
    now: () => FIXED_NOW
  });
}

function makeRelationshipPathEvidence(): RetrievalGraphPathEvidence {
  return {
    seed: { id: "entity_operating_subsidiary", name: "Operating Subsidiary LLC" },
    target: { id: "entity_parent", name: "Parent LLC" },
    depth: 2,
    edges: [
      {
        relationId: "rel_child_operating",
        relationType: "owns",
        from: { id: "entity_child", name: "Child LLC" },
        to: { id: "entity_operating_subsidiary", name: "Operating Subsidiary LLC" },
        depth: 1,
        evidenceChunkIds: ["chunk_rel_child_operating"]
      },
      {
        relationId: "rel_parent_child",
        relationType: "owns",
        from: { id: "entity_parent", name: "Parent LLC" },
        to: { id: "entity_child", name: "Child LLC" },
        depth: 2,
        evidenceChunkIds: ["chunk_rel_parent_child"]
      }
    ]
  };
}

function makeIndex(documents: readonly RagDocument[]): {
  readonly index: InMemoryRagIndex;
  readonly chunksByDocument: ReadonlyMap<string, readonly { readonly id: string }[]>;
} {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const chunksByDocument = new Map<string, readonly { readonly id: string }[]>();

  for (const document of documents) {
    const chunks = chunkDocument({ document }).chunks;
    index.addDocument(document);
    index.addChunks(document.id, chunks);
    chunksByDocument.set(document.id, chunks);
  }

  return { index, chunksByDocument };
}

function makeOwnershipBatch(overrides: Partial<GraphExtractionBatch> = {}): GraphExtractionBatch {
  const entities = overrides.entities ?? [
    makeEntity({ id: "entity_parent", name: "Parent LLC" }),
    makeEntity({ id: "entity_child", name: "Child LLC" })
  ];

  return {
    id: overrides.id ?? "batch_ownership_eval",
    namespaceId: overrides.namespaceId ?? "test-namespace",
    ontology: overrides.ontology ?? ownershipGraphOntology,
    entities,
    relations: overrides.relations ?? [
      makeRelation({
        id: "rel_parent_owns_child",
        relationKind: "owns"
      })
    ],
    createdAt: overrides.createdAt ?? FIXED_NOW
  };
}

function makeEntity(overrides: Partial<GraphEntityProposal>): GraphEntityProposal {
  const name = overrides.name ?? "Parent LLC";
  const entity: GraphEntityProposal = {
    id: overrides.id ?? "entity_parent",
    namespaceId: overrides.namespaceId ?? "test-namespace",
    kind: overrides.kind ?? "legal_entity",
    name,
    normalizedName: overrides.normalizedName ?? name.toLowerCase(),
    aliases: overrides.aliases ?? [],
    confidence: overrides.confidence ?? 0.92,
    trustTier: overrides.trustTier ?? "trusted_internal",
    accessScope: overrides.accessScope ?? {
      tenantId: "tenant_1",
      namespaceId: "test-namespace",
      tags: ["support"]
    },
    evidence: overrides.evidence ?? [makeEvidence()],
    status: overrides.status ?? "proposed",
    createdAt: overrides.createdAt ?? FIXED_NOW
  };
  return overrides.metadata === undefined ? entity : { ...entity, metadata: overrides.metadata };
}

function makeRelation(overrides: Partial<GraphRelationProposal>): GraphRelationProposal {
  const relation: GraphRelationProposal = {
    id: overrides.id ?? "rel_parent_owns_child",
    namespaceId: overrides.namespaceId ?? "test-namespace",
    relationKind: overrides.relationKind ?? "owns",
    sourceEntityId: overrides.sourceEntityId ?? "entity_parent",
    targetEntityId: overrides.targetEntityId ?? "entity_child",
    factStrength: overrides.factStrength ?? "explicit_fact",
    confidence: overrides.confidence ?? 0.93,
    trustTier: overrides.trustTier ?? "trusted_internal",
    accessScope: overrides.accessScope ?? {
      tenantId: "tenant_1",
      namespaceId: "test-namespace",
      tags: ["support"]
    },
    evidence: overrides.evidence ?? [makeEvidence()],
    temporal: overrides.temporal ?? { observedAt: FIXED_NOW },
    verificationStatus: overrides.verificationStatus ?? "supported",
    status: overrides.status ?? "proposed",
    createdAt: overrides.createdAt ?? FIXED_NOW
  };
  return overrides.metadata === undefined
    ? relation
    : { ...relation, metadata: overrides.metadata };
}

function makeEvidence(overrides: Partial<GraphEvidenceAnchor> = {}): GraphEvidenceAnchor {
  const chunkId = overrides.chunkId ?? "chunk_ownership";
  return {
    chunkId,
    documentId: overrides.documentId ?? "doc_ownership",
    sourceId: overrides.sourceId ?? "source_eval",
    citation: {
      sourceId: overrides.sourceId ?? "source_eval",
      chunkId,
      title: "Ownership Eval",
      locator: "Parent LLC owns Child LLC."
    },
    ...(overrides.quoteHash === undefined ? {} : { quoteHash: overrides.quoteHash }),
    ...(overrides.characterStart === undefined ? {} : { characterStart: overrides.characterStart }),
    ...(overrides.characterEnd === undefined ? {} : { characterEnd: overrides.characterEnd })
  };
}

function makeChunk(input: { readonly id: string; readonly body: string }) {
  const document = makeDocument({
    id: `doc_${input.id}`,
    title: "Graph Eval Evidence",
    body: input.body
  });
  const chunk = chunkDocument({ document }).chunks[0];
  if (!chunk) {
    throw new Error("Expected graph eval fixture to produce a chunk.");
  }
  return { ...chunk, id: input.id };
}

function firstChunkId(
  chunksByDocument: ReadonlyMap<string, readonly { readonly id: string }[]>,
  documentId: string
): string {
  const id = chunksByDocument.get(documentId)?.[0]?.id;
  if (!id) {
    throw new Error(`Missing chunk for document "${documentId}".`);
  }
  return id;
}
