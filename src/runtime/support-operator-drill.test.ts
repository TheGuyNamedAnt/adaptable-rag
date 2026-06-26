import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { APPROVED_KNOWLEDGE_ARTIFACT_ADAPTER_ID } from "../corpus/approved-knowledge-artifact-adapter.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile, type ValidatedRagProfile } from "../profiles/profile-validation.js";
import {
  buildRagSupportKnowledgeApprovalLedger,
  type RagSupportKnowledgeApprovalDecisionInput
} from "../support-bridge/approval-ledger.js";
import { buildRagSupportEventIdempotencyLedger } from "../support-bridge/idempotency-ledger.js";
import { buildRagSupportKnowledgeCandidateQueue } from "../support-bridge/knowledge-candidate-queue.js";
import { buildRagSupportEvent } from "../support-bridge/support-event.js";
import type { RagSupportEventExporter } from "../support-bridge/support-event-exporter.js";
import type { RagSupportKnowledgeFlowResult } from "../support-bridge/support-knowledge-flow.js";
import { FIXED_NOW, makeIndexFilter, makePrincipal } from "../test-support/fixtures.js";
import type { ProductionRagApp, ProductionRagAnswerResponse } from "./production-app.js";
import {
  createProductionIngestRuntime,
  type ProductionIngestionConfig
} from "./production-ingestion.js";
import {
  renderRagSupportOperatorDrillMarkdown,
  runRagSupportOperatorDrill
} from "./support-operator-drill.js";

const APPROVED_PROFILE_ID = "approved-artifact-profile";
const APPROVED_NAMESPACE_ID = "approved-artifact-namespace";
const APPROVED_SOURCE_ID = "approved_knowledge_approved-artifact-profile";
const execFileAsync = promisify(execFile);

test("support operator drill proves support knowledge is not answerable before ingestion", async () => {
  const result = await runRagSupportOperatorDrill({
    drillId: "operator_drill_ready",
    generatedAt: FIXED_NOW,
    exporter: safeApprovedExporter(),
    approvedKnowledgeSourceConfig: {
      approvalLedgerPath: "approval-ledger.json",
      pathPrefix: "approved-knowledge"
    }
  });
  const markdown = renderRagSupportOperatorDrillMarkdown(result);

  assert.equal(result.status, "ready_for_ingestion");
  assert.equal(result.supportKnowledgeFlow?.metrics.approvedArtifactCount, 1);
  assert.equal(result.supportKnowledgeFlow.ingestionReadiness.answerableNow, false);
  assert.deepEqual(
    result.gateChecks.map((gate) => gate.name),
    ["support_event_export", "support_knowledge_approval", "before_production_ingestion"]
  );
  assert.deepEqual(
    result.gateChecks.map((gate) => gate.answerableByRuntime),
    [false, false, false]
  );
  assert.equal(result.gateChecks.at(-1)?.retrievalEligible, false);
  assert.equal(markdown.includes("Support Operator Drill"), true);
});

test("support operator drill links export, approval, production ingestion, and index admission", async () => {
  const approvedProfile = approvedArtifactProfile();
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const approvedPrincipal = makePrincipal({
    tenantId: "tenant_1",
    namespaceIds: [approvedProfile.namespaceId],
    tags: ["approved-knowledge", "known_issue_candidate", "customer_safe"]
  });

  assert.equal(index.stats().chunkCount, 0);

  const result = await runRagSupportOperatorDrill({
    drillId: "operator_drill_ingest",
    generatedAt: FIXED_NOW,
    exporter: safeApprovedExporter(),
    approvedKnowledgeSourceConfig: {
      approvalLedgerPath: "approval-ledger.json",
      pathPrefix: "approved-knowledge"
    },
    productionIngestion: {
      indexStats: () => index.stats(),
      request: {
        tenantId: "tenant_1",
        namespaceId: approvedProfile.namespaceId,
        principal: approvedPrincipal,
        sourceIds: [APPROVED_SOURCE_ID],
        overwriteMode: "replace",
        runId: "support_operator_drill_ingest",
        requestedAt: FIXED_NOW
      },
      createRuntime: ({ supportKnowledgeFlow }) =>
        createProductionIngestRuntime({
          app: fakeApp({ index, profileOverride: approvedProfile }),
          config: productionConfigFromFlow(supportKnowledgeFlow),
          now: () => FIXED_NOW
        })
    }
  });
  const chunks = index.findChunks(
    makeIndexFilter({
      tenantId: "tenant_1",
      namespaceId: approvedProfile.namespaceId,
      principal: approvedPrincipal,
      sourceIds: [APPROVED_SOURCE_ID]
    })
  );
  const afterGate = result.gateChecks.find((gate) => gate.name === "after_production_ingestion");

  assert.equal(result.status, "ingested");
  assert.equal(result.preIngestionIndex?.chunkCount, 0);
  assert.equal(result.postIngestionIndex?.chunkCount, 1);
  assert.equal(result.ingestion?.runId, "support_operator_drill_ingest");
  assert.equal(result.ingestion?.counts.documentsAccepted, 1);
  assert.equal(result.ingestion?.counts.chunksAccepted, 1);
  assert.equal(result.ingestion?.counts.recordsRejected, 0);
  assert.equal(afterGate?.retrievalEligible, true);
  assert.equal(afterGate?.answerableByRuntime, true);
  assert.equal(chunks.length, 1);
  assert.equal(
    JSON.stringify(result.ingestion).includes(
      "Approved operator-drill knowledge says the blocking failure is known"
    ),
    false
  );
});

test("support operator drill stops before support flow when export contract fails", async () => {
  const result = await runRagSupportOperatorDrill({
    drillId: "operator_drill_bad_export",
    generatedAt: FIXED_NOW,
    exporter: {
      id: "empty_support_exporter",
      description: "Exporter with no events.",
      exportEvents: () => ({
        events: []
      })
    },
    exportExpectations: {
      minEvents: 1
    }
  });

  assert.equal(result.status, "failed_export_contract");
  assert.equal(result.supportKnowledgeFlow, undefined);
  assert.deepEqual(
    result.gateChecks.map((gate) => gate.name),
    ["support_event_export"]
  );
  assert.equal(result.gateChecks[0]?.answerableByRuntime, false);
  assert.equal(result.gateChecks[0]?.retrievalEligible, false);
});

test("support operator drill CLI writes report and production handoff artifacts", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "rag-support-operator-drill-"));
  const event = knownIssueEvent();
  const approvalDecisions = approvedDecisionsForEvent(event);
  const eventsPath = path.join(tempDir, "events.jsonl");
  const decisionsPath = path.join(tempDir, "decisions.jsonl");
  const reportDir = path.join(tempDir, "report");
  await writeFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  await writeFile(
    decisionsPath,
    `${approvalDecisions.map((decision) => JSON.stringify(decision)).join("\n")}\n`,
    "utf8"
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "scripts/run-support-operator-drill.mjs",
      "--events",
      eventsPath,
      "--decisions",
      decisionsPath,
      "--report-dir",
      reportDir,
      "--generated-at",
      FIXED_NOW,
      "--drill-id",
      "operator_drill_cli",
      "--exporter-id",
      "operator_drill_cli_exporter"
    ],
    { cwd: process.cwd() }
  );
  const drill = JSON.parse(await readFile(path.join(reportDir, "drill.json"), "utf8"));
  const validation = JSON.parse(await readFile(path.join(reportDir, "validation.json"), "utf8"));
  const sourceConfig = JSON.parse(
    await readFile(path.join(reportDir, "approved-knowledge.sources.json"), "utf8")
  );
  const approvalLedger = JSON.parse(
    await readFile(path.join(reportDir, "approval-ledger.json"), "utf8")
  );
  const drillMarkdown = await readFile(path.join(reportDir, "drill.md"), "utf8");

  assert.equal(stdout.includes("Support operator drill ready_for_ingestion"), true);
  assert.equal(stdout.includes("answerable before ingestion: no"), true);
  assert.equal(drill.status, "ready_for_ingestion");
  assert.equal(validation.status, "passed");
  assert.equal(sourceConfig.sources.length, 1);
  assert.deepEqual(sourceConfig.sources[0].artifactIds, [
    approvalLedger.approvedArtifacts[0].artifactId
  ]);
  assert.equal(drill.gateChecks.at(-1).answerableByRuntime, false);
  assert.equal(drill.gateChecks.at(-1).retrievalEligible, false);
  assert.equal(drillMarkdown.includes("Support Operator Drill"), true);
});

function safeApprovedExporter(): RagSupportEventExporter {
  const event = knownIssueEvent();
  const approvalDecisions = approvedDecisionsForEvent(event);

  return {
    id: "safe_operator_drill_exporter",
    description: "Exports a safe known-issue support event and its approved knowledge decision.",
    exportEvents: () => ({
      events: [event],
      approvalDecisions,
      metadata: {
        source: "operator-drill-fixture"
      }
    })
  };
}

function approvedDecisionsForEvent(
  event: ReturnType<typeof knownIssueEvent>
): readonly RagSupportKnowledgeApprovalDecisionInput[] {
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
  const approvalDecisions: readonly RagSupportKnowledgeApprovalDecisionInput[] = [
    {
      decisionId: "operator_drill_approval",
      candidateId: candidate.candidateId,
      action: "approve",
      reviewerIdHash: "reviewer_hash_operator_drill",
      summary: "Approved known issue wording for the operator drill.",
      approvedTitle: "Blocking failure known issue",
      approvedBody:
        "Approved operator-drill knowledge says the blocking failure is known and engineering is investigating a fix. Support can say updates will be shared after the fix is confirmed.",
      visibility: "customer_safe",
      reasonCodes: ["confirmed_by_engineering"]
    }
  ];
  const approvalLedger = buildRagSupportKnowledgeApprovalLedger({
    generatedAt: FIXED_NOW,
    queue,
    decisions: approvalDecisions
  });
  assert.equal(approvalLedger.metrics.approvedArtifactCount, 1);
  return approvalDecisions;
}

function knownIssueEvent() {
  return buildRagSupportEvent({
    eventId: "operator_drill_known_issue_event",
    sourceSystem: "admin_support",
    sourceEventId: "ticket_123:known_issue_signal",
    sourceTicketId: "ticket_123",
    runId: "run_ticket_123",
    traceId: "trace_ticket_123",
    profileId: APPROVED_PROFILE_ID,
    namespaceId: APPROVED_NAMESPACE_ID,
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
}

function productionConfigFromFlow(input: RagSupportKnowledgeFlowResult): ProductionIngestionConfig {
  return {
    localFiles: {
      sources: []
    },
    approvedKnowledgeArtifacts: {
      sources: input.approvedKnowledgeSourcesConfig.sources.map((source) => ({
        sourceId: source.sourceId,
        artifacts: input.approvalLedger.approvedArtifacts,
        artifactIds: source.artifactIds,
        pathPrefix: source.pathPrefix,
        ...(source.originUriBase === undefined ? {} : { originUriBase: source.originUriBase }),
        ...(source.owner === undefined ? {} : { owner: source.owner }),
        ...(source.accessScope === undefined ? {} : { accessScope: source.accessScope }),
        ...(source.capturedAt === undefined ? {} : { capturedAt: source.capturedAt }),
        ...(source.maxArtifacts === undefined ? {} : { maxArtifacts: source.maxArtifacts }),
        ...(source.metadata === undefined ? {} : { metadata: source.metadata })
      }))
    }
  };
}

function approvedArtifactProfile(): ValidatedRagProfile {
  return assertValidProfile({
    ...genericDocsProfile,
    id: APPROVED_PROFILE_ID,
    namespaceId: APPROVED_NAMESPACE_ID,
    corpusSources: [
      {
        id: APPROVED_SOURCE_ID,
        adapter: APPROVED_KNOWLEDGE_ARTIFACT_ADAPTER_ID,
        description: "Human-approved support knowledge artifacts.",
        enabled: true,
        trustTierFloor: "generated_or_derived",
        tags: ["approved-knowledge"]
      }
    ],
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
  });
}

function fakeApp(options: {
  readonly index: InMemoryRagIndex;
  readonly profileOverride: ValidatedRagProfile;
}): ProductionRagApp {
  const { index, profileOverride } = options;

  return {
    config: {} as ProductionRagApp["config"],
    profile: profileOverride,
    chunkStore: index,
    runtime: {
      providerAdapters: {}
    } as unknown as ProductionRagApp["runtime"],
    answer: async (): Promise<ProductionRagAnswerResponse> =>
      ({
        status: "refused",
        trace: {}
      }) as ProductionRagAnswerResponse,
    health: () => ({
      status: "ready",
      profileId: profileOverride.id,
      namespaceId: profileOverride.namespaceId,
      retrievalMode: profileOverride.retrieval.mode,
      index: {
        storageKind: "memory",
        durable: false,
        documentCount: index.stats().documentCount,
        chunkCount: index.stats().chunkCount
      },
      providers: {
        model: {
          id: "fake",
          provider: "fake",
          modelName: "fake"
        }
      }
    }),
    selfTest: async () => ({
      status: "passed",
      checkedAt: FIXED_NOW,
      profileId: profileOverride.id,
      namespaceId: profileOverride.namespaceId,
      retrievalMode: profileOverride.retrieval.mode,
      probeProviders: false,
      checkCount: 0,
      failedCount: 0,
      skippedCount: 0,
      checks: []
    })
  };
}
