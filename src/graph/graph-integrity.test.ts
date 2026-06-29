import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { RagChunk } from "../documents/chunk.js";
import { FIXED_NOW } from "../test-support/fixtures.js";
import { checkGraphIntegrity } from "./graph-integrity.js";
import type {
  GraphEntityKind,
  GraphEntityProposal,
  GraphEvidenceAnchor,
  GraphExtractionBatch,
  GraphRelationProposal
} from "./graph-types.js";
import { ownershipGraphOntology } from "./ownership-ontology.js";

test("graph integrity accepts multi-anchor table relationship evidence", () => {
  const parentChunk = makeChunk({
    id: "chunk_parent_context",
    text: "BERKSHIRE HATHAWAY INC.\nSubsidiaries of Registrant"
  });
  const tableChunk = makeChunk({
    id: "chunk_table_row",
    text: "Company Name | Domicile or State of Incorporation\nGeneral Re Corporation | Delaware"
  });
  const batch = makeBatch({
    entities: [
      makeEntity({
        id: "entity_berkshire",
        name: "Berkshire Hathaway Inc.",
        evidence: [anchor(parentChunk)]
      }),
      makeEntity({
        id: "entity_general_re",
        name: "General Re Corporation",
        evidence: [anchor(tableChunk)]
      }),
      makeEntity({
        id: "location_delaware",
        kind: "location",
        name: "Delaware",
        evidence: [anchor(tableChunk)]
      })
    ],
    relations: [
      makeRelation({
        id: "relation_berkshire_owns_general_re",
        sourceEntityId: "entity_berkshire",
        targetEntityId: "entity_general_re",
        relationKind: "owns",
        evidence: [anchor(parentChunk), anchor(tableChunk)]
      }),
      makeRelation({
        id: "relation_general_re_registered_delaware",
        sourceEntityId: "entity_general_re",
        targetEntityId: "location_delaware",
        relationKind: "registered_in",
        evidence: [anchor(tableChunk)]
      })
    ]
  });

  const result = checkGraphIntegrity({ batch, chunks: [parentChunk, tableChunk] });

  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
});

test("graph integrity rejects relation evidence that only contains nearby unrelated text", () => {
  const chunk = makeChunk({
    id: "chunk_unrelated",
    text: "Parent LLC filed an annual report. Operating LLC is mentioned in another note."
  });
  const batch = makeBatch({
    entities: [
      makeEntity({
        id: "entity_parent",
        name: "Parent LLC",
        evidence: [anchor(chunk)]
      }),
      makeEntity({
        id: "entity_child",
        name: "Child LLC",
        evidence: [anchor(chunk)]
      })
    ],
    relations: [
      makeRelation({
        id: "relation_parent_owns_child",
        sourceEntityId: "entity_parent",
        targetEntityId: "entity_child",
        relationKind: "owns",
        evidence: [anchor(chunk)]
      })
    ]
  });

  const result = checkGraphIntegrity({ batch, chunks: [chunk] });

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.errors.map((issue) => issue.code),
    ["entity_evidence_text_missing", "relation_target_not_grounded", "relation_kind_not_grounded"]
  );
});

test("graph integrity rejects stale evidence anchors", () => {
  const chunk = makeChunk({
    id: "chunk_supported",
    text: "Parent LLC owns Child LLC."
  });
  const badAnchor = {
    ...anchor(chunk),
    documentId: "doc_other",
    sourceId: "source_other",
    quoteHash: "bad_hash",
    characterStart: chunk.characterStart + 1,
    characterEnd: chunk.characterEnd + 1
  };
  const batch = makeBatch({
    entities: [
      makeEntity({ id: "entity_parent", name: "Parent LLC", evidence: [badAnchor] }),
      makeEntity({ id: "entity_child", name: "Child LLC", evidence: [anchor(chunk)] })
    ],
    relations: [
      makeRelation({
        id: "relation_parent_owns_child",
        evidence: [badAnchor]
      })
    ]
  });

  const result = checkGraphIntegrity({ batch, chunks: [chunk] });

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.errors.map((issue) => issue.code),
    [
      "evidence_document_mismatch",
      "evidence_source_mismatch",
      "evidence_quote_hash_mismatch",
      "evidence_character_range_mismatch",
      "evidence_character_range_mismatch",
      "evidence_document_mismatch",
      "evidence_source_mismatch",
      "evidence_quote_hash_mismatch",
      "evidence_character_range_mismatch",
      "evidence_character_range_mismatch"
    ]
  );
});

test("graph integrity rejects unsafe approved inferred or ambiguous relations", () => {
  const chunk = makeChunk({
    id: "chunk_supported",
    text: "Parent LLC owns Child LLC."
  });
  const batch = makeBatch({
    entities: [
      makeEntity({ id: "entity_parent", name: "Parent LLC", evidence: [anchor(chunk)] }),
      makeEntity({ id: "entity_child", name: "Child LLC", evidence: [anchor(chunk)] })
    ],
    relations: [
      makeRelation({
        id: "relation_parent_owns_child",
        factStrength: "inferred_fact",
        verificationStatus: "ambiguous",
        evidence: [anchor(chunk)]
      })
    ]
  });

  const result = checkGraphIntegrity({ batch, chunks: [chunk] });

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.errors.map((issue) => issue.code),
    ["batch_validation_failed", "unsafe_auto_approved_relation", "unsafe_auto_approved_relation"]
  );
});

test("graph integrity reports structural validation failures with graph integrity issues", () => {
  const chunk = makeChunk({
    id: "chunk_supported",
    text: "Parent LLC owns Child LLC."
  });
  const batch = makeBatch({
    entities: [
      makeEntity({ id: "entity_parent", name: "Parent LLC", evidence: [anchor(chunk)] }),
      makeEntity({ id: "entity_parent", name: "Duplicate Parent LLC", evidence: [anchor(chunk)] }),
      makeEntity({ id: "entity_child", name: "Child LLC", evidence: [anchor(chunk)] })
    ],
    relations: [
      makeRelation({ id: "relation_duplicate", evidence: [anchor(chunk)] }),
      makeRelation({ id: "relation_duplicate", evidence: [anchor(chunk)] })
    ]
  });

  const result = checkGraphIntegrity({ batch, chunks: [chunk] });

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.errors
      .filter((issue) => issue.code === "batch_validation_failed")
      .map((issue) => issue.validationCode),
    ["duplicate_id", "duplicate_id"]
  );
});

function makeBatch(overrides: Partial<GraphExtractionBatch> = {}): GraphExtractionBatch {
  return {
    id: overrides.id ?? "batch_graph_integrity",
    namespaceId: overrides.namespaceId ?? "test-namespace",
    ontology: overrides.ontology ?? ownershipGraphOntology,
    entities: overrides.entities ?? [
      makeEntity({ id: "entity_parent", name: "Parent LLC" }),
      makeEntity({ id: "entity_child", name: "Child LLC" })
    ],
    relations: overrides.relations ?? [
      makeRelation({
        id: "relation_parent_owns_child"
      })
    ],
    createdAt: overrides.createdAt ?? FIXED_NOW
  };
}

function makeEntity(overrides: Partial<GraphEntityProposal> = {}): GraphEntityProposal {
  const name = overrides.name ?? "Parent LLC";
  return {
    id: overrides.id ?? "entity_parent",
    namespaceId: overrides.namespaceId ?? "test-namespace",
    kind: overrides.kind ?? ("legal_entity" satisfies GraphEntityKind),
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
    evidence: overrides.evidence ?? [],
    status: overrides.status ?? "approved",
    createdAt: overrides.createdAt ?? FIXED_NOW,
    ...(overrides.metadata === undefined ? {} : { metadata: overrides.metadata })
  };
}

function makeRelation(overrides: Partial<GraphRelationProposal> = {}): GraphRelationProposal {
  return {
    id: overrides.id ?? "relation_parent_owns_child",
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
    evidence: overrides.evidence ?? [],
    temporal: overrides.temporal ?? { observedAt: FIXED_NOW },
    verificationStatus: overrides.verificationStatus ?? "supported",
    status: overrides.status ?? "approved",
    createdAt: overrides.createdAt ?? FIXED_NOW,
    ...(overrides.metadata === undefined ? {} : { metadata: overrides.metadata })
  };
}

function makeChunk(input: {
  readonly id: string;
  readonly text: string;
  readonly documentId?: string;
  readonly sourceId?: string;
  readonly characterStart?: number;
}): RagChunk {
  const sourceId = input.sourceId ?? "curated_docs";
  const characterStart = input.characterStart ?? 0;
  return {
    id: input.id,
    documentId: input.documentId ?? "doc_graph_integrity",
    namespaceId: "test-namespace",
    text: input.text,
    index: 0,
    textHash: createHash("sha256").update(input.text, "utf8").digest("hex"),
    characterStart,
    characterEnd: characterStart + input.text.length,
    safetyFlags: [],
    provenance: {
      sourceId,
      sourceKind: "local_file",
      title: "Graph Integrity Source",
      ingestedAt: FIXED_NOW,
      trustTier: "trusted_internal",
      sensitivity: "internal",
      capturedAt: FIXED_NOW
    },
    citation: {
      sourceId,
      chunkId: input.id,
      title: "Graph Integrity Source",
      locator: `chars ${characterStart}-${characterStart + input.text.length}`
    },
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "test-namespace",
      tags: ["support"]
    }
  };
}

function anchor(chunk: RagChunk): GraphEvidenceAnchor {
  return {
    chunkId: chunk.id,
    documentId: chunk.documentId,
    sourceId: chunk.provenance.sourceId,
    citation: chunk.citation,
    quoteHash: chunk.textHash,
    characterStart: chunk.characterStart,
    characterEnd: chunk.characterEnd
  };
}
