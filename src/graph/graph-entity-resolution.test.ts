import assert from "node:assert/strict";
import test from "node:test";

import { FIXED_NOW, makeChunks, makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import { GraphEntityResolutionRunner, normalizeEntityName } from "./graph-entity-resolution.js";
import type {
  GraphEntityProposal,
  GraphExtractionBatch,
  GraphRelationProposal
} from "./graph-types.js";
import { InMemoryGraphStore } from "./in-memory-graph-store.js";
import { ownershipGraphOntology } from "./ownership-ontology.js";
import { ProposalBackedRagGraphStore } from "./proposal-graph-adapter.js";

test("normalizes common legal suffixes for entity resolution", () => {
  assert.equal(normalizeEntityName("ACME, L.L.C."), "acme");
  assert.equal(normalizeEntityName("Acme Limited Liability Company"), "acme");
  assert.equal(normalizeEntityName("Acme Holdings GmbH"), "acme holdings");
});

test("entity resolution supersedes duplicate entities and rewires relation endpoints", () => {
  const graphStore = new InMemoryGraphStore();
  graphStore.addExtractionBatch(makeBatch());
  const runner = new GraphEntityResolutionRunner({
    graphStore,
    now: () => FIXED_NOW
  });

  const result = runner.resolve({
    filter: makeIndexFilter(),
    runId: "resolution_1",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.canonicalCount, 1);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.rewiredRelationCount, 1);
  assert.deepEqual(result.decisions[0]?.duplicateEntityIds, ["entity_acme_duplicate"]);
  assert.deepEqual(
    graphStore
      .findRelations({ filter: makeIndexFilter(), includeUnapproved: true })
      .map((relation) => [relation.id, relation.sourceEntityId, relation.targetEntityId]),
    [["relation_duplicate_owns_child", "entity_acme", "entity_child"]]
  );
});

test("entity resolution keeps same-name legal variants separate when jurisdictions differ", () => {
  const graphStore = new InMemoryGraphStore();
  graphStore.addExtractionBatch(makeJurisdictionBatch());
  const result = new GraphEntityResolutionRunner({
    graphStore,
    now: () => FIXED_NOW
  }).resolve({
    filter: makeIndexFilter(),
    runId: "resolution_jurisdiction_split",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.canonicalCount, 0);
  assert.equal(result.duplicateCount, 0);
  assert.deepEqual(
    graphStore
      .findEntities(makeIndexFilter())
      .filter((entity) => entity.kind === "legal_entity")
      .map((entity) => entity.id)
      .sort(),
    ["entity_benjamin_canada", "entity_benjamin_us"]
  );
});

test("entity resolution auto-merges name variants when stable identifiers match", () => {
  const graphStore = new InMemoryGraphStore();
  graphStore.addExtractionBatch(makeIdentifierBatch());
  const result = new GraphEntityResolutionRunner({
    graphStore,
    now: () => FIXED_NOW
  }).resolve({
    filter: makeIndexFilter(),
    runId: "resolution_identifier",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.canonicalCount, 1);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.rewiredRelationCount, 1);
  assert.equal(result.reviewCandidateCount, 0);
  assert.equal(result.decisions[0]?.normalizedName, "ticker:aapl");
  assert.deepEqual(result.decisions[0]?.duplicateEntityIds, ["entity_apple_computer"]);
  assert.deepEqual(
    graphStore
      .findRelations({ filter: makeIndexFilter(), includeUnapproved: true })
      .map((relation) => [relation.id, relation.sourceEntityId, relation.targetEntityId]),
    [["relation_apple_computer_registered", "entity_apple_inc", "location_california"]]
  );
});

test("entity resolution flags fuzzy legal-name matches for review instead of merging", () => {
  const graphStore = new InMemoryGraphStore();
  graphStore.addExtractionBatch(makeAppleAmbiguityBatch());
  const result = new GraphEntityResolutionRunner({
    graphStore,
    now: () => FIXED_NOW
  }).resolve({
    filter: makeIndexFilter(),
    runId: "resolution_fuzzy_review",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.canonicalCount, 0);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.rewiredRelationCount, 0);
  assert.equal(result.reviewCandidateCount, 1);
  assert.deepEqual(result.reviewCandidates[0]?.entityIds, [
    "entity_apple_hospitality",
    "entity_apple_inc"
  ]);
  assert.match(result.reviewCandidates[0]?.reason ?? "", /hospitality/);
  assert.match(result.reviewCandidates[0]?.reason ?? "", /reit/);
  assert.deepEqual(
    graphStore
      .findEntities(makeIndexFilter())
      .filter((entity) => entity.kind === "legal_entity")
      .map((entity) => [entity.id, entity.status])
      .sort(),
    [
      ["entity_apple_hospitality", "approved"],
      ["entity_apple_inc", "approved"]
    ]
  );
});

test("entity resolution treats equivalent domain and website identifiers as the same stable identity", () => {
  const graphStore = new InMemoryGraphStore();
  graphStore.addExtractionBatch(
    makeEdgeCaseBatch({
      id: "batch_resolution_domain_identifier",
      body: "OpenAI, Inc. and OpenAI Global LLC share the same public domain identifier.",
      entities: [
        {
          id: "entity_openai_inc",
          name: "OpenAI, Inc.",
          normalizedName: "openai inc",
          confidence: 0.96,
          metadata: { domain: "openai.com" }
        },
        {
          id: "entity_openai_global",
          name: "OpenAI Global LLC",
          normalizedName: "openai global llc",
          metadata: { website: "https://www.openai.com/research" }
        }
      ]
    })
  );

  const result = new GraphEntityResolutionRunner({
    graphStore,
    now: () => FIXED_NOW
  }).resolve({
    filter: makeIndexFilter(),
    runId: "resolution_domain_identifier",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.canonicalCount, 1);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.reviewCandidateCount, 0);
  assert.equal(result.decisions[0]?.normalizedName, "domain:openai.com");
  assert.deepEqual(result.decisions[0]?.duplicateEntityIds, ["entity_openai_global"]);
});

test("entity resolution normalizes CIK identifiers with leading zeros", () => {
  const graphStore = new InMemoryGraphStore();
  graphStore.addExtractionBatch(
    makeEdgeCaseBatch({
      id: "batch_resolution_cik_identifier",
      body: "Apple Inc. and Apple Computer, Inc. share the same CIK.",
      entities: [
        {
          id: "entity_apple_inc",
          name: "Apple Inc.",
          normalizedName: "apple inc",
          confidence: 0.96,
          metadata: { cik: "0000320193" }
        },
        {
          id: "entity_apple_computer",
          name: "Apple Computer, Inc.",
          normalizedName: "apple computer inc",
          metadata: { cik: 320193 }
        }
      ]
    })
  );

  const result = new GraphEntityResolutionRunner({
    graphStore,
    now: () => FIXED_NOW
  }).resolve({
    filter: makeIndexFilter(),
    runId: "resolution_cik_identifier",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.canonicalCount, 1);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.decisions[0]?.normalizedName, "cik:320193");
  assert.deepEqual(result.decisions[0]?.duplicateEntityIds, ["entity_apple_computer"]);
});

test("entity resolution blocks stable-identifier merges when jurisdiction evidence conflicts", () => {
  const graphStore = new InMemoryGraphStore();
  graphStore.addExtractionBatch(
    makeEdgeCaseBatch({
      id: "batch_resolution_identifier_jurisdiction_conflict",
      body: "Acme Ltd. has conflicting registry evidence in Delaware and Canada.",
      entities: [
        {
          id: "entity_acme_delaware",
          name: "Acme Ltd.",
          normalizedName: "acme ltd",
          confidence: 0.96,
          metadata: { lei: "LEI-123" }
        },
        {
          id: "entity_acme_canada",
          name: "Acme Limited",
          normalizedName: "acme limited",
          metadata: { lei: "lei-123" }
        },
        {
          id: "location_delaware",
          kind: "location",
          name: "Delaware",
          normalizedName: "delaware"
        },
        {
          id: "location_canada",
          kind: "location",
          name: "Canada",
          normalizedName: "canada"
        }
      ],
      relations: [
        {
          id: "relation_acme_delaware_registered",
          relationKind: "registered_in",
          sourceEntityId: "entity_acme_delaware",
          targetEntityId: "location_delaware"
        },
        {
          id: "relation_acme_canada_registered",
          relationKind: "registered_in",
          sourceEntityId: "entity_acme_canada",
          targetEntityId: "location_canada"
        }
      ]
    })
  );

  const result = new GraphEntityResolutionRunner({
    graphStore,
    now: () => FIXED_NOW
  }).resolve({
    filter: makeIndexFilter(),
    runId: "resolution_identifier_jurisdiction_conflict",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.canonicalCount, 0);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.reviewCandidateCount, 1);
  assert.match(result.reviewCandidates[0]?.reason ?? "", /jurisdiction/u);
  assert.deepEqual(
    graphStore
      .findEntities(makeIndexFilter())
      .filter((entity) => entity.kind === "legal_entity")
      .map((entity) => [entity.id, entity.status])
      .sort(),
    [
      ["entity_acme_canada", "approved"],
      ["entity_acme_delaware", "approved"]
    ]
  );
});

test("entity resolution treats alias-only matches as review candidates, not automatic merges", () => {
  const graphStore = new InMemoryGraphStore();
  graphStore.addExtractionBatch(
    makeEdgeCaseBatch({
      id: "batch_resolution_alias_only",
      body: "IBM may refer to International Business Machines Corporation, but alias-only evidence needs review.",
      entities: [
        {
          id: "entity_ibm_full",
          name: "International Business Machines Corporation",
          normalizedName: "international business machines corporation",
          aliases: ["IBM"],
          confidence: 0.95
        },
        {
          id: "entity_ibm_short",
          name: "IBM",
          normalizedName: "ibm"
        }
      ]
    })
  );

  const result = new GraphEntityResolutionRunner({
    graphStore,
    now: () => FIXED_NOW
  }).resolve({
    filter: makeIndexFilter(),
    runId: "resolution_alias_only",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.canonicalCount, 0);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.reviewCandidateCount, 1);
  assert.deepEqual(result.reviewCandidates[0]?.entityIds, ["entity_ibm_full", "entity_ibm_short"]);
});

test("entity resolution does not merge or review identical names across different entity kinds", () => {
  const graphStore = new InMemoryGraphStore();
  graphStore.addExtractionBatch(
    makeEdgeCaseBatch({
      id: "batch_resolution_cross_kind",
      body: "Jordan can be a jurisdiction or an entity name, so kinds must remain separate.",
      entities: [
        {
          id: "entity_jordan_company",
          kind: "legal_entity",
          name: "Jordan",
          normalizedName: "jordan",
          metadata: { registryId: "JORDAN-1" }
        },
        {
          id: "location_jordan",
          kind: "location",
          name: "Jordan",
          normalizedName: "jordan",
          metadata: { registry_id: "JORDAN-1" }
        }
      ]
    })
  );

  const result = new GraphEntityResolutionRunner({
    graphStore,
    now: () => FIXED_NOW
  }).resolve({
    filter: makeIndexFilter(),
    runId: "resolution_cross_kind",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.canonicalCount, 0);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.reviewCandidateCount, 0);
  assert.deepEqual(
    graphStore
      .findEntities(makeIndexFilter())
      .map((entity) => [entity.id, entity.kind, entity.status])
      .sort(),
    [
      ["entity_jordan_company", "legal_entity", "approved"],
      ["location_jordan", "location", "approved"]
    ]
  );
});

test("entity resolution ignores rejected and superseded proposals when finding duplicates", () => {
  const graphStore = new InMemoryGraphStore();
  graphStore.addExtractionBatch(
    makeEdgeCaseBatch({
      id: "batch_resolution_inactive",
      body: "Only active proposals should be eligible for entity resolution.",
      entities: [
        {
          id: "entity_active",
          name: "Northwind LLC",
          normalizedName: "northwind llc",
          metadata: { ticker: "NWND" }
        },
        {
          id: "entity_rejected",
          name: "Northwind Limited Liability Company",
          normalizedName: "northwind limited liability company",
          status: "rejected",
          metadata: { ticker: "NWND" }
        },
        {
          id: "entity_superseded",
          name: "NORTHWIND, L.L.C.",
          normalizedName: "northwind l l c",
          status: "superseded"
        }
      ]
    })
  );

  const result = new GraphEntityResolutionRunner({
    graphStore,
    now: () => FIXED_NOW
  }).resolve({
    filter: makeIndexFilter(),
    runId: "resolution_inactive",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.canonicalCount, 0);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.reviewCandidateCount, 0);
});

test("proposal-backed retrieval graph hides superseded duplicate entities", () => {
  const graphStore = new InMemoryGraphStore();
  graphStore.addExtractionBatch(makeBatch());
  new GraphEntityResolutionRunner({ graphStore, now: () => FIXED_NOW }).resolve({
    filter: makeIndexFilter(),
    requestedAt: FIXED_NOW
  });
  const retrievalGraph = new ProposalBackedRagGraphStore(graphStore);

  assert.deepEqual(
    retrievalGraph.findEntities(["acme"], 10, makeIndexFilter()).map((match) => match.entity.id),
    ["entity_acme"]
  );
});

function makeBatch(): GraphExtractionBatch {
  const document = makeDocument({
    id: "doc_resolution",
    title: "Resolution memo",
    body: "Acme LLC owns Child LLC. ACME, L.L.C. is the same company."
  });
  const chunk = makeChunks(document)[0];
  if (!chunk) {
    throw new Error("Fixture requires a chunk.");
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
    id: "batch_resolution",
    namespaceId: "test-namespace",
    ontology: ownershipGraphOntology,
    entities: [
      {
        id: "entity_acme",
        namespaceId: "test-namespace",
        kind: "legal_entity",
        name: "Acme LLC",
        normalizedName: "acme llc",
        confidence: 0.95,
        trustTier: "trusted_internal",
        accessScope: chunk.accessScope,
        evidence: [anchor],
        status: "approved",
        createdAt: FIXED_NOW
      },
      {
        id: "entity_acme_duplicate",
        namespaceId: "test-namespace",
        kind: "legal_entity",
        name: "ACME, L.L.C.",
        normalizedName: "acme l l c",
        confidence: 0.9,
        trustTier: "trusted_internal",
        accessScope: chunk.accessScope,
        evidence: [anchor],
        status: "approved",
        createdAt: FIXED_NOW
      },
      {
        id: "entity_child",
        namespaceId: "test-namespace",
        kind: "legal_entity",
        name: "Child LLC",
        normalizedName: "child",
        confidence: 0.9,
        trustTier: "trusted_internal",
        accessScope: chunk.accessScope,
        evidence: [anchor],
        status: "approved",
        createdAt: FIXED_NOW
      }
    ],
    relations: [
      {
        id: "relation_duplicate_owns_child",
        namespaceId: "test-namespace",
        relationKind: "owns",
        sourceEntityId: "entity_acme_duplicate",
        targetEntityId: "entity_child",
        factStrength: "explicit_fact",
        confidence: 0.9,
        trustTier: "trusted_internal",
        accessScope: chunk.accessScope,
        evidence: [anchor],
        temporal: { observedAt: FIXED_NOW },
        verificationStatus: "supported",
        status: "approved",
        createdAt: FIXED_NOW
      }
    ],
    createdAt: FIXED_NOW
  };
}

interface EdgeCaseEntityFixture {
  readonly id: string;
  readonly kind?: GraphEntityProposal["kind"];
  readonly name: string;
  readonly normalizedName?: string;
  readonly aliases?: readonly string[];
  readonly confidence?: number;
  readonly status?: GraphEntityProposal["status"];
  readonly metadata?: GraphEntityProposal["metadata"];
}

interface EdgeCaseRelationFixture {
  readonly id: string;
  readonly relationKind: GraphRelationProposal["relationKind"];
  readonly sourceEntityId: string;
  readonly targetEntityId: string;
  readonly confidence?: number;
  readonly status?: GraphRelationProposal["status"];
}

function makeEdgeCaseBatch(options: {
  readonly id: string;
  readonly body: string;
  readonly entities: readonly EdgeCaseEntityFixture[];
  readonly relations?: readonly EdgeCaseRelationFixture[];
}): GraphExtractionBatch {
  const document = makeDocument({
    id: `${options.id}_doc`,
    title: "Entity resolution edge case",
    body: options.body
  });
  const chunk = makeChunks(document)[0];
  if (!chunk) {
    throw new Error("Fixture requires a chunk.");
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

  const entities: GraphEntityProposal[] = options.entities.map((entity) => ({
    id: entity.id,
    namespaceId: "test-namespace",
    kind: entity.kind ?? "legal_entity",
    name: entity.name,
    normalizedName: entity.normalizedName ?? entity.name.toLowerCase(),
    confidence: entity.confidence ?? 0.9,
    trustTier: "trusted_internal",
    accessScope: chunk.accessScope,
    evidence: [anchor],
    status: entity.status ?? "approved",
    createdAt: FIXED_NOW,
    ...(entity.aliases === undefined ? {} : { aliases: entity.aliases }),
    ...(entity.metadata === undefined ? {} : { metadata: entity.metadata })
  }));

  const relations: GraphRelationProposal[] = (options.relations ?? []).map((relation) => ({
    id: relation.id,
    namespaceId: "test-namespace",
    relationKind: relation.relationKind,
    sourceEntityId: relation.sourceEntityId,
    targetEntityId: relation.targetEntityId,
    factStrength: "explicit_fact",
    confidence: relation.confidence ?? 0.9,
    trustTier: "trusted_internal",
    accessScope: chunk.accessScope,
    evidence: [anchor],
    temporal: { observedAt: FIXED_NOW },
    verificationStatus: "supported",
    status: relation.status ?? "approved",
    createdAt: FIXED_NOW
  }));

  return {
    id: options.id,
    namespaceId: "test-namespace",
    ontology: ownershipGraphOntology,
    entities,
    relations,
    createdAt: FIXED_NOW
  };
}

function makeIdentifierBatch(): GraphExtractionBatch {
  const document = makeDocument({
    id: "doc_resolution_identifier",
    title: "Company aliases",
    body: "Apple Computer, Inc. is an older name for Apple Inc. Apple Computer, Inc. was registered in California."
  });
  const chunk = makeChunks(document)[0];
  if (!chunk) {
    throw new Error("Fixture requires a chunk.");
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
  const base = {
    namespaceId: "test-namespace",
    confidence: 0.9,
    trustTier: "trusted_internal" as const,
    accessScope: chunk.accessScope,
    evidence: [anchor],
    status: "approved" as const,
    createdAt: FIXED_NOW
  };

  return {
    id: "batch_resolution_identifier",
    namespaceId: "test-namespace",
    ontology: ownershipGraphOntology,
    entities: [
      {
        ...base,
        id: "entity_apple_inc",
        kind: "legal_entity",
        name: "Apple Inc.",
        normalizedName: "apple inc",
        confidence: 0.96,
        metadata: { ticker: "AAPL" }
      },
      {
        ...base,
        id: "entity_apple_computer",
        kind: "legal_entity",
        name: "Apple Computer, Inc.",
        normalizedName: "apple computer inc",
        aliases: ["Apple Computer"],
        metadata: { ticker: "aapl" }
      },
      {
        ...base,
        id: "location_california",
        kind: "location",
        name: "California",
        normalizedName: "california"
      }
    ],
    relations: [
      {
        ...base,
        id: "relation_apple_computer_registered",
        relationKind: "registered_in",
        sourceEntityId: "entity_apple_computer",
        targetEntityId: "location_california",
        factStrength: "explicit_fact",
        temporal: { observedAt: FIXED_NOW },
        verificationStatus: "supported"
      }
    ],
    createdAt: FIXED_NOW
  };
}

function makeAppleAmbiguityBatch(): GraphExtractionBatch {
  const document = makeDocument({
    id: "doc_resolution_apple_ambiguity",
    title: "Company list",
    body: "Apple Inc. and Apple Hospitality REIT, Inc. are different legal entities."
  });
  const chunk = makeChunks(document)[0];
  if (!chunk) {
    throw new Error("Fixture requires a chunk.");
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
  const base = {
    namespaceId: "test-namespace",
    kind: "legal_entity" as const,
    confidence: 0.9,
    trustTier: "trusted_internal" as const,
    accessScope: chunk.accessScope,
    evidence: [anchor],
    status: "approved" as const,
    createdAt: FIXED_NOW
  };

  return {
    id: "batch_resolution_apple_ambiguity",
    namespaceId: "test-namespace",
    ontology: ownershipGraphOntology,
    entities: [
      {
        ...base,
        id: "entity_apple_inc",
        name: "Apple Inc.",
        normalizedName: "apple inc"
      },
      {
        ...base,
        id: "entity_apple_hospitality",
        name: "Apple Hospitality REIT, Inc.",
        normalizedName: "apple hospitality reit inc"
      }
    ],
    relations: [],
    createdAt: FIXED_NOW
  };
}

function makeJurisdictionBatch(): GraphExtractionBatch {
  const document = makeDocument({
    id: "doc_resolution_jurisdiction",
    title: "Subsidiaries",
    body: "Benjamin Moore & Co. is incorporated in New Jersey. Benjamin Moore & Co., Limited is incorporated in Canada."
  });
  const chunk = makeChunks(document)[0];
  if (!chunk) {
    throw new Error("Fixture requires a chunk.");
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
  const base = {
    namespaceId: "test-namespace",
    confidence: 0.9,
    trustTier: "trusted_internal" as const,
    accessScope: chunk.accessScope,
    evidence: [anchor],
    status: "approved" as const,
    createdAt: FIXED_NOW
  };

  return {
    id: "batch_resolution_jurisdiction",
    namespaceId: "test-namespace",
    ontology: ownershipGraphOntology,
    entities: [
      {
        ...base,
        id: "entity_benjamin_us",
        kind: "legal_entity",
        name: "Benjamin Moore & Co.",
        normalizedName: "benjamin moore & co"
      },
      {
        ...base,
        id: "entity_benjamin_canada",
        kind: "legal_entity",
        name: "Benjamin Moore & Co., Limited",
        normalizedName: "benjamin moore & co limited"
      },
      {
        ...base,
        id: "location_new_jersey",
        kind: "location",
        name: "New Jersey",
        normalizedName: "new jersey"
      },
      {
        ...base,
        id: "location_canada",
        kind: "location",
        name: "Canada",
        normalizedName: "canada"
      }
    ],
    relations: [
      {
        ...base,
        id: "relation_benjamin_us_registered",
        relationKind: "registered_in",
        sourceEntityId: "entity_benjamin_us",
        targetEntityId: "location_new_jersey",
        factStrength: "explicit_fact",
        temporal: { observedAt: FIXED_NOW },
        verificationStatus: "supported"
      },
      {
        ...base,
        id: "relation_benjamin_canada_registered",
        relationKind: "registered_in",
        sourceEntityId: "entity_benjamin_canada",
        targetEntityId: "location_canada",
        factStrength: "explicit_fact",
        temporal: { observedAt: FIXED_NOW },
        verificationStatus: "supported"
      }
    ],
    createdAt: FIXED_NOW
  };
}
