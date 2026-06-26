import assert from "node:assert/strict";
import test from "node:test";

import { IngestPipeline } from "../ingestion/ingest-pipeline.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import type { CorpusSourceConfig, RagProfile } from "../profiles/profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { hashText } from "../shared/hash.js";
import {
  buildRagSupportKnowledgeApprovalLedger,
  type RagSupportApprovedKnowledgeArtifact
} from "../support-bridge/approval-ledger.js";
import { buildRagSupportEventIdempotencyLedger } from "../support-bridge/idempotency-ledger.js";
import { buildRagSupportKnowledgeCandidateQueue } from "../support-bridge/knowledge-candidate-queue.js";
import { buildRagSupportEvent } from "../support-bridge/support-event.js";
import { FIXED_NOW, makeIndexFilter, makePrincipal } from "../test-support/fixtures.js";
import {
  APPROVED_KNOWLEDGE_ARTIFACT_ADAPTER_ID,
  ApprovedKnowledgeArtifactCorpusAdapter
} from "./approved-knowledge-artifact-adapter.js";
import { CorpusAdapterRegistry } from "./adapter-registry.js";

const PROFILE_ID = "approved-artifact-profile";
const NAMESPACE_ID = "approved-artifact-namespace";
const SOURCE_ID = "approved_knowledge_approved-artifact-profile";

test("loads approved artifacts as checksummed corpus records with safe defaults", async () => {
  const profile = approvedArtifactProfile();
  const source = profile.corpusSources[0];
  assert.ok(source);
  const artifact = approvedArtifact();
  const adapter = new ApprovedKnowledgeArtifactCorpusAdapter({
    sources: [
      {
        sourceId: source.id,
        artifacts: [artifact],
        accessScope: {
          tags: ["reviewed"],
          roles: ["support"]
        },
        metadata: {
          connector: "support-bridge"
        },
        owner: "support"
      }
    ]
  });
  const principal = makePrincipal({
    tenantId: "tenant_1",
    namespaceIds: [profile.namespaceId]
  });

  const loaded = await adapter.load({
    profile,
    source,
    requestedBy: principal,
    runId: "approved_artifact_load_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(loaded.warnings.length, 0);
  assert.equal(loaded.records.length, 1);
  const record = loaded.records[0];
  assert.ok(record);
  assert.equal(record.sourceId, source.id);
  assert.equal(record.sourceKind, "derived_summary");
  assert.equal(record.trustTier, "generated_or_derived");
  assert.equal(record.sensitivity, "internal");
  assert.equal(record.title, artifact.title);
  assert.equal(record.body, artifact.body);
  assert.equal(record.checksum, hashText(artifact.body));
  assert.equal(record.path?.startsWith("approved-knowledge/"), true);
  assert.equal(record.owner, "support");
  assert.deepEqual(record.accessScope, {
    tenantId: "tenant_1",
    namespaceId: profile.namespaceId,
    roles: ["support"],
    tags: ["approved-knowledge", "reviewed", "known_issue_candidate", "customer_safe"]
  });
  assert.equal(record.metadata?.["artifactId"], artifact.artifactId);
  assert.equal(record.metadata?.["bodyHash"], artifact.bodyHash);
  assert.equal(record.metadata?.["connector"], "support-bridge");
  assert.equal(record.metadata?.["autoApproved"], false);
  assert.equal(record.metadata?.["humanApproved"], true);
});

test("loads auto-approved artifacts without marking them as human approved", async () => {
  const profile = approvedArtifactProfile();
  const source = profile.corpusSources[0];
  assert.ok(source);
  const artifact = approvedArtifact({
    metadata: {
      autoApproved: true,
      autoApprovalPolicyVersion: 1,
      source: "support-ticket-cli-sync"
    }
  });
  const adapter = new ApprovedKnowledgeArtifactCorpusAdapter({
    sources: [
      {
        sourceId: source.id,
        artifacts: [artifact]
      }
    ]
  });

  const loaded = await adapter.load({
    profile,
    source,
    requestedBy: makePrincipal({
      tenantId: "tenant_1",
      namespaceIds: [profile.namespaceId]
    }),
    runId: "approved_artifact_auto_load_test",
    requestedAt: FIXED_NOW
  });
  const record = loaded.records[0];

  assert.ok(record);
  assert.equal(record.metadata?.["autoApproved"], true);
  assert.equal(record.metadata?.["humanApproved"], false);
  assert.equal(record.metadata?.["artifact.autoApprovalPolicyVersion"], 1);
  assert.equal(record.metadata?.["artifact.source"], "support-ticket-cli-sync");
});

test("ingests approved artifacts through the normal ingest pipeline", async () => {
  const profile = approvedArtifactProfile();
  const source = profile.corpusSources[0];
  assert.ok(source);
  const artifact = approvedArtifact();
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const pipeline = new IngestPipeline({
    adapterRegistry: new CorpusAdapterRegistry([
      new ApprovedKnowledgeArtifactCorpusAdapter({
        sources: [
          {
            sourceId: source.id,
            artifacts: [artifact]
          }
        ]
      })
    ]),
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  });
  const principal = makePrincipal({
    tenantId: "tenant_1",
    namespaceIds: [profile.namespaceId],
    tags: ["approved-knowledge", "known_issue_candidate", "customer_safe"]
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    runId: "approved_artifact_ingest_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.adapterWarnings.length, 0);
  assert.equal(result.rejectedRecords.length, 0);
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0]?.provenance.sourceKind, "derived_summary");
  assert.equal(result.documents[0]?.provenance.trustTier, "generated_or_derived");
  assert.equal(result.chunks.length, 1);
  assert.equal(
    index.findDocuments(
      makeIndexFilter({
        namespaceId: profile.namespaceId,
        tenantId: principal.tenantId,
        principal
      })
    ).length,
    1
  );
});

test("normalization still rejects unsafe trust promotion for approved artifacts", async () => {
  const profile = approvedArtifactProfile({ trustTierOverride: "trusted_internal" });
  const source = profile.corpusSources[0];
  assert.ok(source);
  const artifact = approvedArtifact();
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const pipeline = new IngestPipeline({
    adapterRegistry: new CorpusAdapterRegistry([
      new ApprovedKnowledgeArtifactCorpusAdapter({
        sources: [
          {
            sourceId: source.id,
            artifacts: [artifact]
          }
        ]
      })
    ]),
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: makePrincipal({ tenantId: "tenant_1", namespaceIds: [profile.namespaceId] }),
    requestedAt: FIXED_NOW
  });

  assert.equal(result.documents.length, 0);
  assert.equal(result.chunks.length, 0);
  assert.equal(result.rejectedRecords.length, 1);
  assert.equal(
    result.normalizationIssues.some((issue) => issue.code === "unsafe_trust_upgrade"),
    true
  );
});

test("refuses tampered or wrong-namespace artifacts without leaking body text", async () => {
  const profile = approvedArtifactProfile();
  const source = profile.corpusSources[0];
  assert.ok(source);
  const artifact = approvedArtifact();
  const tampered = {
    ...artifact,
    body: "Tampered approved body with api_key=secret_123."
  };
  const wrongNamespace = {
    ...artifact,
    artifactId: `${artifact.artifactId}_wrong_namespace`,
    namespaceId: "other-namespace"
  };
  const adapter = new ApprovedKnowledgeArtifactCorpusAdapter({
    sources: [
      {
        sourceId: source.id,
        artifacts: [tampered, wrongNamespace]
      }
    ]
  });

  const loaded = await adapter.load({
    profile,
    source,
    requestedBy: makePrincipal({ tenantId: "tenant_1", namespaceIds: [profile.namespaceId] }),
    runId: "approved_artifact_refusal_test",
    requestedAt: FIXED_NOW
  });
  const serializedWarnings = JSON.stringify(loaded.warnings);

  assert.equal(loaded.records.length, 0);
  assert.equal(
    loaded.warnings.some((warning) => warning.code === "artifact_body_hash_mismatch"),
    true
  );
  assert.equal(
    loaded.warnings.some((warning) => warning.code === "artifact_namespace_mismatch"),
    true
  );
  assert.equal(serializedWarnings.includes("secret_123"), false);
  assert.equal(serializedWarnings.includes("Tampered approved body"), false);
});

function approvedArtifactProfile(
  options: {
    readonly trustTierOverride?: CorpusSourceConfig["trustTierOverride"];
  } = {}
) {
  const source: CorpusSourceConfig = {
    id: SOURCE_ID,
    adapter: APPROVED_KNOWLEDGE_ARTIFACT_ADAPTER_ID,
    description: "Human-approved support knowledge artifacts.",
    enabled: true,
    trustTierFloor: "generated_or_derived",
    tags: ["approved-knowledge"]
  };
  const sourceWithOptions: CorpusSourceConfig =
    options.trustTierOverride === undefined
      ? source
      : {
          ...source,
          trustTierOverride: options.trustTierOverride
        };
  const profile: RagProfile = {
    ...genericDocsProfile,
    id: PROFILE_ID,
    namespaceId: NAMESPACE_ID,
    corpusSources: [sourceWithOptions],
    trustPolicy: {
      ...genericDocsProfile.trustPolicy,
      allowedTrustTiers: [
        ...genericDocsProfile.trustPolicy.allowedTrustTiers,
        "generated_or_derived"
      ],
      minimumAnswerTrustTier: "generated_or_derived"
    },
    citationPolicy: {
      ...genericDocsProfile.citationPolicy,
      allowedSourceKindsForCitations: [
        ...genericDocsProfile.citationPolicy.allowedSourceKindsForCitations,
        "derived_summary"
      ]
    },
    evals: {
      goldenSetPath: "profiles/approved-artifact/evals/golden.jsonl",
      adversarialSetPath: "profiles/approved-artifact/evals/adversarial.jsonl",
      requiredChecks: genericDocsProfile.evals.requiredChecks
    }
  };

  return assertValidProfile(profile);
}

function approvedArtifact(
  overrides: Partial<RagSupportApprovedKnowledgeArtifact> = {}
): RagSupportApprovedKnowledgeArtifact {
  const event = buildRagSupportEvent({
    eventId: "support_event_known_issue",
    sourceSystem: "admin_support",
    sourceEventId: "ticket_123:known_issue_signal",
    sourceTicketId: "ticket_123",
    runId: "run_ticket_123",
    traceId: "trace_ticket_123",
    profileId: PROFILE_ID,
    namespaceId: NAMESPACE_ID,
    eventType: "known_issue_candidate_created",
    occurredAt: FIXED_NOW,
    summary: "Support ticket indicates a possible known issue.",
    evidenceRefs: [
      {
        refId: "artifact_ticket_123",
        kind: "ticket",
        sourceSystem: "admin_support",
        artifactPath: "support/artifacts/ticket_123.json",
        ticketId: "ticket_123",
        runId: "run_ticket_123",
        traceId: "trace_ticket_123",
        sensitivity: "internal_only",
        customerSafe: false
      }
    ],
    proposedKnowledgeAction: {
      kind: "known_issue_candidate",
      targetId: "known_issue_blocking_failure",
      knownIssueStatus: "candidate",
      title: "Possible blocking failure known issue",
      summary: "Create a known issue candidate from repeated blocking reports.",
      proposedWording: "We're checking whether this matches other reports.",
      requiresApproval: true,
      approverDestination: "engineering"
    }
  });
  const ledger = buildRagSupportEventIdempotencyLedger({
    generatedAt: FIXED_NOW,
    events: [event]
  });
  const queue = buildRagSupportKnowledgeCandidateQueue({
    generatedAt: FIXED_NOW,
    events: [event],
    ledger
  });
  const candidate = queue.candidates[0];
  assert.ok(candidate);
  const approval = buildRagSupportKnowledgeApprovalLedger({
    generatedAt: FIXED_NOW,
    queue,
    decisions: [
      {
        decisionId: "approval_decision_1",
        candidateId: candidate.candidateId,
        action: "approve",
        reviewerId: "reviewer_1",
        summary: "Approved known issue wording for support use.",
        approvedTitle: "Blocking failure known issue",
        approvedBody:
          "We're aware of this blocking failure and are investigating a fix. Support should tell customers that engineering is actively working on the issue and that updates will be posted when the fix is confirmed.",
        visibility: "customer_safe",
        reasonCodes: ["confirmed_by_engineering"]
      }
    ]
  });
  const artifact = approval.approvedArtifacts[0];
  assert.ok(artifact);

  return {
    ...artifact,
    ...overrides
  };
}
