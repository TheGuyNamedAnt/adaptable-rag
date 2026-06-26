import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import { ContextBuilder } from "../context/context-builder.js";
import type { ContextBuildResult } from "../context/context-types.js";
import type { RagDocument } from "../documents/document.js";
import type { TrustTier } from "../documents/trust-tier.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import type { RagProfile } from "../profiles/profile.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile, type ValidatedRagProfile } from "../profiles/profile-validation.js";
import { KeywordRetriever } from "../retrieval/keyword-retriever.js";
import { FIXED_NOW, makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import { GroundingGate } from "./grounding-gate.js";

type RelationshipPathEvidence = NonNullable<ContextBuildResult["blocks"][number]["graphEvidence"]>;

function profileForTest(overrides: Partial<RagProfile> = {}): ValidatedRagProfile {
  return assertValidProfile({
    ...genericDocsProfile,
    namespaceId: "test-namespace",
    ...overrides,
    modelPolicy: {
      ...genericDocsProfile.modelPolicy,
      ...(overrides.modelPolicy ?? {})
    },
    contextBudget: {
      ...genericDocsProfile.contextBudget,
      ...(overrides.contextBudget ?? {})
    },
    citationPolicy: {
      ...genericDocsProfile.citationPolicy,
      ...(overrides.citationPolicy ?? {})
    },
    trustPolicy: {
      ...genericDocsProfile.trustPolicy,
      ...(overrides.trustPolicy ?? {})
    },
    outputContract: {
      ...genericDocsProfile.outputContract,
      ...(overrides.outputContract ?? {})
    },
    actionPolicy: {
      ...genericDocsProfile.actionPolicy,
      ...(overrides.actionPolicy ?? {})
    },
    redactionPolicy: {
      ...genericDocsProfile.redactionPolicy,
      ...(overrides.redactionPolicy ?? {})
    },
    securityPolicy: {
      ...genericDocsProfile.securityPolicy,
      ...(overrides.securityPolicy ?? {})
    },
    observabilityPolicy: {
      ...genericDocsProfile.observabilityPolicy,
      ...(overrides.observabilityPolicy ?? {})
    }
  });
}

function makeIndexWithDocuments(documents: readonly RagDocument[]): InMemoryRagIndex {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });

  for (const document of documents) {
    const chunks = chunkDocument({ document }).chunks;
    index.addDocument(document);
    index.addChunks(document.id, chunks);
  }

  return index;
}

async function buildContext(
  documents: readonly RagDocument[],
  profile = profileForTest(),
  query = "refund policy"
): Promise<ContextBuildResult> {
  const index = makeIndexWithDocuments(documents);
  const retriever = new KeywordRetriever({ chunkStore: index, now: () => FIXED_NOW });
  const retrieval = await retriever.retrieve({
    query,
    filter: makeIndexFilter(),
    topK: 10,
    retrievalId: "retrieval_answer_test",
    requestedAt: FIXED_NOW
  });
  const builder = new ContextBuilder({ now: () => FIXED_NOW });

  return builder.build({
    profile,
    retrieval,
    contextId: "context_answer_test",
    requestedAt: FIXED_NOW
  });
}

function withTrustTier(document: RagDocument, trustTier: TrustTier): RagDocument {
  return {
    ...document,
    provenance: {
      ...document.provenance,
      trustTier
    }
  };
}

function withRelationshipPathEvidence(
  context: ContextBuildResult,
  graphEvidence: RelationshipPathEvidence
): ContextBuildResult {
  return {
    ...context,
    blocks: context.blocks.map((block, index) =>
      index === 0
        ? {
            ...block,
            graphEvidence
          }
        : block
    )
  };
}

function relationshipPathEvidence(
  overrides: Partial<RelationshipPathEvidence> = {}
): RelationshipPathEvidence {
  return {
    seed: { id: "entity_operating", name: "Operating Subsidiary LLC" },
    target: { id: "entity_parent", name: "Parent LLC" },
    depth: 2,
    edges: [
      {
        relationId: "relation_child_operating",
        relationType: "owns",
        from: { id: "entity_child", name: "Child LLC" },
        to: { id: "entity_operating", name: "Operating Subsidiary LLC" },
        depth: 1,
        evidenceChunkIds: ["chunk_relation_child_operating"]
      },
      {
        relationId: "relation_parent_child",
        relationType: "owns",
        from: { id: "entity_parent", name: "Parent LLC" },
        to: { id: "entity_child", name: "Child LLC" },
        depth: 2,
        evidenceChunkIds: ["chunk_relation_parent_child"]
      }
    ],
    ...overrides
  };
}

test("allows generation when context meets the answer contract", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [
      makeDocument({
        id: "doc_refunds",
        body: "Refund policy says billing refunds require human review."
      })
    ],
    profile
  );
  const gate = new GroundingGate({ now: () => FIXED_NOW });

  const result = gate.prepare({
    profile,
    context,
    question: "What is the refund policy?",
    answerId: "answer_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "ready");
  assert.equal(result.canGenerate, true);
  assert.equal(result.requiresHumanReview, false);
  assert.equal(result.generation?.contract.schemaName, "GenericSourcedAnswer");
  assert.deepEqual(
    result.generation?.contract.allowedCitationChunkIds,
    context.blocks.map((block) => block.chunkId)
  );
  assert.match(result.generation?.contextText ?? "", /\[SOURCE 1\]/);
  assert.equal(result.trace.answerId, "answer_test");
});

test("refuses generation when evidence is missing", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [
      makeDocument({
        id: "doc_login",
        title: "Login Guide",
        body: "Login troubleshooting covers password reset."
      })
    ],
    profile,
    "refund policy"
  );
  const gate = new GroundingGate({ now: () => FIXED_NOW });

  const result = gate.prepare({
    profile,
    context,
    question: "What is the refund policy?"
  });

  assert.equal(context.blocks.length, 0);
  assert.equal(result.status, "refused");
  assert.equal(result.canGenerate, false);
  assert.equal(result.refusal?.code, "generation_requires_evidence");
  assert.equal(result.generation, undefined);
});

test("marks generation as human review required for review-required evidence", async () => {
  const profile = profileForTest({
    trustPolicy: {
      ...genericDocsProfile.trustPolicy,
      minimumAnswerTrustTier: "user_provided"
    }
  });
  const context = await buildContext(
    [
      withTrustTier(
        makeDocument({
          id: "doc_user_evidence",
          body: "Refund policy from user provided evidence."
        }),
        "user_provided"
      )
    ],
    profile
  );
  const gate = new GroundingGate({ now: () => FIXED_NOW });

  const result = gate.prepare({
    profile,
    context,
    question: "What is the refund policy?"
  });

  assert.equal(result.status, "human_review_required");
  assert.equal(result.canGenerate, true);
  assert.equal(result.requiresHumanReview, true);
  assert.equal(result.generation?.contract.allowedCitationChunkIds.length, 1);
});

test("validates a properly cited sourced answer draft", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [
      makeDocument({
        id: "doc_refunds",
        body: "Refund policy says billing refunds require human review."
      })
    ],
    profile
  );
  const gate = new GroundingGate({ now: () => FIXED_NOW });
  const chunkId = context.blocks[0]?.chunkId;
  assert.ok(chunkId);

  const result = gate.validateDraft({
    profile,
    context,
    draft: {
      answer: "Billing refunds require human review.",
      citationChunkIds: [chunkId],
      evidenceSummary: "One trusted internal policy chunk supports the answer.",
      confidence: "high"
    },
    requestedAt: FIXED_NOW
  });

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.citedChunkIds, [chunkId]);
});

test("validates cited relationship-path evidence edge by edge", async () => {
  const profile = profileForTest();
  const baseContext = await buildContext(
    [
      makeDocument({
        id: "doc_relationship",
        body: "Parent LLC owns Child LLC, and Child LLC owns Operating Subsidiary LLC."
      })
    ],
    profile,
    "who owns operating subsidiary"
  );
  const context = withRelationshipPathEvidence(baseContext, relationshipPathEvidence());
  const gate = new GroundingGate({ now: () => FIXED_NOW });
  const chunkId = context.blocks[0]?.chunkId;
  assert.ok(chunkId);

  const result = gate.validateDraft({
    profile,
    context,
    draft: {
      answer: "Parent LLC owns Operating Subsidiary LLC through Child LLC.",
      citationChunkIds: [chunkId],
      evidenceSummary: "The cited context includes a supported two-edge relationship path.",
      confidence: "high"
    },
    requestedAt: FIXED_NOW
  });

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.trace.relationshipPathCitationCount, 1);
  assert.equal(result.trace.relationshipPathEdgeCount, 2);
  assert.equal(result.trace.relationshipPathMaxDepth, 2);
  assert.equal(result.trace.invalidRelationshipPathCount, 0);
  assert.equal(result.trace.missingRelationshipEdgeEvidenceCount, 0);
  assert.equal(JSON.stringify(result.trace).includes("Parent LLC"), false);
  assert.equal(JSON.stringify(result.trace).includes("Child LLC"), false);
});

test("rejects cited relationship-path evidence with a broken chain", async () => {
  const profile = profileForTest();
  const baseContext = await buildContext(
    [
      makeDocument({
        id: "doc_relationship_broken",
        body: "Parent LLC owns Child LLC, and Child LLC owns Operating Subsidiary LLC."
      })
    ],
    profile,
    "who owns operating subsidiary"
  );
  const context = withRelationshipPathEvidence(
    baseContext,
    relationshipPathEvidence({
      edges: [
        {
          relationId: "relation_child_operating",
          relationType: "owns",
          from: { id: "entity_child", name: "Child LLC" },
          to: { id: "entity_operating", name: "Operating Subsidiary LLC" },
          depth: 1,
          evidenceChunkIds: ["chunk_relation_child_operating"]
        },
        {
          relationId: "relation_unrelated",
          relationType: "owns",
          from: { id: "entity_unrelated_parent", name: "Unrelated Parent LLC" },
          to: { id: "entity_unrelated_child", name: "Unrelated Child LLC" },
          depth: 2,
          evidenceChunkIds: ["chunk_relation_unrelated"]
        }
      ]
    })
  );
  const gate = new GroundingGate({ now: () => FIXED_NOW });
  const chunkId = context.blocks[0]?.chunkId;
  assert.ok(chunkId);

  const result = gate.validateDraft({
    profile,
    context,
    draft: {
      answer: "Parent LLC owns Operating Subsidiary LLC through Child LLC.",
      citationChunkIds: [chunkId],
      evidenceSummary: "The cited context includes a relationship path."
    },
    requestedAt: FIXED_NOW
  });

  assert.equal(result.valid, false);
  assert.equal(
    result.errors.some((error) => error.code === "invalid_relationship_path_evidence"),
    true
  );
  assert.equal(result.errors[0]?.chunkId, chunkId);
  assert.equal(result.trace.relationshipPathCitationCount, 1);
  assert.equal(result.trace.invalidRelationshipPathCount, 1);
});

test("warns when cited relationship-path edges have no evidence chunk ids", async () => {
  const profile = profileForTest();
  const baseContext = await buildContext(
    [
      makeDocument({
        id: "doc_relationship_missing_edge_evidence",
        body: "Parent LLC owns Child LLC, and Child LLC owns Operating Subsidiary LLC."
      })
    ],
    profile,
    "who owns operating subsidiary"
  );
  const context = withRelationshipPathEvidence(
    baseContext,
    relationshipPathEvidence({
      edges: [
        {
          relationId: "relation_child_operating",
          relationType: "owns",
          from: { id: "entity_child", name: "Child LLC" },
          to: { id: "entity_operating", name: "Operating Subsidiary LLC" },
          depth: 1,
          evidenceChunkIds: []
        },
        {
          relationId: "relation_parent_child",
          relationType: "owns",
          from: { id: "entity_parent", name: "Parent LLC" },
          to: { id: "entity_child", name: "Child LLC" },
          depth: 2,
          evidenceChunkIds: ["chunk_relation_parent_child"]
        }
      ]
    })
  );
  const gate = new GroundingGate({ now: () => FIXED_NOW });
  const chunkId = context.blocks[0]?.chunkId;
  assert.ok(chunkId);

  const result = gate.validateDraft({
    profile,
    context,
    draft: {
      answer: "Parent LLC owns Operating Subsidiary LLC through Child LLC.",
      citationChunkIds: [chunkId],
      evidenceSummary: "The cited context includes a relationship path."
    },
    requestedAt: FIXED_NOW
  });

  assert.equal(result.valid, true);
  assert.equal(
    result.warnings.some((warning) => warning.code === "missing_relationship_edge_evidence"),
    true
  );
  assert.equal(result.trace.missingRelationshipEdgeEvidenceCount, 1);
});

test("rejects drafts with unknown and insufficient citations", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [
      makeDocument({
        id: "doc_refunds",
        body: "Refund policy says billing refunds require human review."
      })
    ],
    profile
  );
  const gate = new GroundingGate({ now: () => FIXED_NOW });

  const result = gate.validateDraft({
    profile,
    context,
    draft: {
      answer: "Billing refunds require human review.",
      citationChunkIds: ["chunk_missing"],
      evidenceSummary: "Evidence was cited."
    }
  });

  assert.equal(result.valid, false);
  assert.equal(
    result.errors.some((error) => error.code === "unknown_citation"),
    true
  );
  assert.equal(
    result.errors.some((error) => error.code === "insufficient_citations"),
    true
  );
  assert.deepEqual(result.unknownCitationChunkIds, ["chunk_missing"]);
});

test("requires evidence summary when the profile contract requires it", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [
      makeDocument({
        id: "doc_refunds",
        body: "Refund policy says billing refunds require human review."
      })
    ],
    profile
  );
  const gate = new GroundingGate({ now: () => FIXED_NOW });
  const chunkId = context.blocks[0]?.chunkId;
  assert.ok(chunkId);

  const result = gate.validateDraft({
    profile,
    context,
    draft: {
      answer: "Billing refunds require human review.",
      citationChunkIds: [chunkId]
    }
  });

  assert.equal(result.valid, false);
  assert.equal(
    result.errors.some((error) => error.code === "missing_evidence_summary"),
    true
  );
});

test("blocks actions that are not allowed by the profile", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [
      makeDocument({
        id: "doc_refunds",
        body: "Refund policy says billing refunds require human review."
      })
    ],
    profile
  );
  const gate = new GroundingGate({ now: () => FIXED_NOW });
  const chunkId = context.blocks[0]?.chunkId;
  assert.ok(chunkId);

  const result = gate.validateDraft({
    profile,
    context,
    draft: {
      answer: "Billing refunds require human review.",
      citationChunkIds: [chunkId],
      evidenceSummary: "One trusted internal policy chunk supports the answer.",
      actions: ["issue_refund"]
    }
  });

  assert.equal(result.valid, false);
  assert.equal(result.errors[0]?.code, "action_not_allowed");
  assert.equal(result.errors[0]?.action, "issue_refund");
});

test("warns when an allowed action requires approval", async () => {
  const profile = profileForTest({
    actionPolicy: {
      mode: "human_approval_required",
      allowedActions: ["create_ticket"],
      requireApprovalFor: ["create_ticket"]
    }
  });
  const context = await buildContext(
    [
      makeDocument({
        id: "doc_refunds",
        body: "Refund policy says billing refunds require human review."
      })
    ],
    profile
  );
  const gate = new GroundingGate({ now: () => FIXED_NOW });
  const chunkId = context.blocks[0]?.chunkId;
  assert.ok(chunkId);

  const result = gate.validateDraft({
    profile,
    context,
    draft: {
      answer: "Billing refunds require human review.",
      citationChunkIds: [chunkId],
      evidenceSummary: "One trusted internal policy chunk supports the answer.",
      actions: ["create_ticket"]
    }
  });

  assert.equal(result.valid, true);
  assert.equal(result.warnings[0]?.code, "action_requires_approval");
});

test("requires a refusal draft when context is not answerable", async () => {
  const profile = profileForTest();
  const context = await buildContext(
    [
      makeDocument({
        id: "doc_login",
        title: "Login Guide",
        body: "Login troubleshooting covers password reset."
      })
    ],
    profile,
    "refund policy"
  );
  const gate = new GroundingGate({ now: () => FIXED_NOW });

  const result = gate.validateDraft({
    profile,
    context,
    draft: {
      answer: "Refunds are always approved.",
      citationChunkIds: [],
      evidenceSummary: "No evidence."
    }
  });

  assert.equal(result.valid, false);
  assert.equal(
    result.errors.some((error) => error.code === "refusal_required"),
    true
  );
});

test("keeps raw context text out of answer traces", async () => {
  const rawText = "internal answer trace phrase should not leak";
  const profile = profileForTest();
  const context = await buildContext(
    [
      makeDocument({
        id: "doc_trace",
        body: `Refund policy says ${rawText}.`
      })
    ],
    profile
  );
  const gate = new GroundingGate({ now: () => FIXED_NOW });

  const gateResult = gate.prepare({
    profile,
    context,
    question: "What is the refund policy?"
  });
  const validationResult = gate.validateDraft({
    profile,
    context,
    draft: {
      answer: "The policy has a trace phrase.",
      citationChunkIds: [context.blocks[0]?.chunkId ?? ""],
      evidenceSummary: "One trusted internal policy chunk supports the answer."
    }
  });

  assert.equal(JSON.stringify(gateResult.trace).includes(rawText), false);
  assert.equal(JSON.stringify(validationResult.trace).includes(rawText), false);
});
