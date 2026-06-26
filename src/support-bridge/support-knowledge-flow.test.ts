import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { runRagSupportKnowledgeFlow } from "./support-knowledge-flow.js";
import { buildRagSupportEvent } from "./support-event.js";

const execFileAsync = promisify(execFile);
const GENERATED_AT = "2026-06-24T00:00:00.000Z";

test("support knowledge flow links approved artifacts and emits production ingestion config", () => {
  const events = [knownIssueStatusEvent()];
  const pending = runRagSupportKnowledgeFlow({
    flowId: "support_flow_pending",
    generatedAt: GENERATED_AT,
    events
  });
  const candidate = pending.candidateQueue.candidates[0];
  assert.ok(candidate);

  const result = runRagSupportKnowledgeFlow({
    flowId: "support_flow_approved",
    generatedAt: GENERATED_AT,
    events,
    approvalDecisions: [
      {
        decisionId: "decision_known_issue_in_progress",
        candidateId: candidate.candidateId,
        action: "approve",
        reviewerId: "reviewer@example.test",
        summary: "Approved status wording for support.",
        approvedTitle: "Blocking issue is in progress",
        approvedBody: "We know this problem exists and engineering is working on a fix.",
        visibility: "customer_safe",
        reasonCodes: ["engineering_status_confirmed"]
      }
    ],
    approvedKnowledgeSourceConfig: {
      approvalLedgerPath: "approval-ledger.json",
      pathPrefix: "approved-knowledge",
      accessScope: {
        tenantId: "tenant_1",
        namespaceId: "generic-docs",
        roles: ["support"],
        tags: ["known-issues"]
      },
      metadata: {
        environment: "test"
      }
    }
  });
  const artifact = result.approvalLedger.approvedArtifacts[0];
  const source = result.approvedKnowledgeSourcesConfig.sources[0];
  const entry = result.eventLedger.entries[0];

  assert.ok(artifact);
  assert.ok(source);
  assert.ok(entry);
  assert.equal(result.status, "ready_for_ingestion");
  assert.equal(result.metrics.pendingCandidateCount, 0);
  assert.equal(result.ingestionReadiness.answerableNow, false);
  assert.equal(result.ingestionReadiness.requiredNextGate, "production_ingestion");
  assert.equal(result.ingestionReadiness.approvedKnowledgeSourceConfigEmitted, true);
  assert.equal(source.sourceId, artifact.ingestionHint.sourceId);
  assert.deepEqual(source.ledgerPaths, ["approval-ledger.json"]);
  assert.deepEqual(source.artifactIds, [artifact.artifactId]);
  assert.equal(source.metadata.connector, "support-bridge");
  assert.equal(source.metadata.supportKnowledgeFlowId, "support_flow_approved");
  assert.deepEqual(entry.outputArtifactIds, [artifact.artifactId]);
});

test("support knowledge flow keeps unapproved candidates out of ingestion config", () => {
  const result = runRagSupportKnowledgeFlow({
    flowId: "support_flow_waiting",
    generatedAt: GENERATED_AT,
    events: [knownIssueStatusEvent()]
  });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.metrics.candidateCount, 1);
  assert.equal(result.metrics.pendingCandidateCount, 1);
  assert.equal(result.metrics.approvedArtifactCount, 0);
  assert.deepEqual(result.approvedKnowledgeSourcesConfig.sources, []);
  assert.equal(result.ingestionReadiness.answerableNow, false);
  assert.equal(result.ingestionReadiness.approvedKnowledgeSourceConfigEmitted, false);
});

test("support knowledge flow can auto-approve safe known issue ticket updates", () => {
  const result = runRagSupportKnowledgeFlow({
    flowId: "support_flow_auto",
    generatedAt: GENERATED_AT,
    events: [knownIssueStatusEvent()],
    autoApprovalPolicy: {
      enabled: true
    }
  });
  const decision = result.approvalLedger.decisions[0];
  const artifact = result.approvalLedger.approvedArtifacts[0];

  assert.ok(decision);
  assert.ok(artifact);
  assert.equal(result.status, "ready_for_ingestion");
  assert.equal(result.metrics.autoApprovalDecisionCount, 1);
  assert.equal(result.metrics.pendingCandidateCount, 0);
  assert.equal(decision.decisionId.startsWith("auto_support_sync_"), true);
  assert.equal(decision.reviewerIdHash, "auto_support_ticket_sync");
  assert.deepEqual([...decision.reasonCodes].sort(), [
    "auto_ticket_sync",
    "known_issue_status_in_progress",
    "structured_support_event"
  ]);
  assert.equal(artifact.visibility, "customer_safe");
  assert.equal(artifact.body, "We know this problem exists and are investigating a fix.");
});

test("support knowledge flow does not auto-approve non-allowlisted support knowledge", () => {
  const result = runRagSupportKnowledgeFlow({
    flowId: "support_flow_auto_skip",
    generatedAt: GENERATED_AT,
    events: [routingRuleEvent()],
    autoApprovalPolicy: {
      enabled: true
    }
  });
  const skipped = result.autoApproval.skippedCandidates[0];

  assert.ok(skipped);
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.metrics.autoApprovalDecisionCount, 0);
  assert.equal(result.metrics.pendingCandidateCount, 1);
  assert.equal(result.metrics.approvedArtifactCount, 0);
  assert.equal(skipped.reasonCode, "kind_not_allowed");
});

test("support knowledge flow redacts unsafe text and raw reviewer ids", () => {
  const events = [
    knownIssueStatusEvent({
      summary: "Engineering update references Bearer event_secret_1234567890."
    })
  ];
  const pending = runRagSupportKnowledgeFlow({
    flowId: "support_flow_redaction_pending",
    generatedAt: GENERATED_AT,
    events
  });
  const candidate = pending.candidateQueue.candidates[0];
  assert.ok(candidate);

  const result = runRagSupportKnowledgeFlow({
    flowId: "support_flow_redaction",
    generatedAt: GENERATED_AT,
    events,
    approvalDecisions: [
      {
        candidateId: candidate.candidateId,
        action: "approve",
        reviewerId: "raw_reviewer_should_not_leak",
        summary: "Approved after checking token=summary_secret_123.",
        approvedTitle: "Known issue api_key=title_secret_123",
        approvedBody: "Customer-safe body with Bearer body_secret_123456.",
        metadata: {
          unsafe: "password=decision_secret_123"
        }
      }
    ],
    approvedKnowledgeSourceConfig: {
      metadata: {
        unsafeSourceMetadata: "api_key=source_secret_123"
      }
    }
  });
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes("event_secret_1234567890"), false);
  assert.equal(serialized.includes("summary_secret_123"), false);
  assert.equal(serialized.includes("title_secret_123"), false);
  assert.equal(serialized.includes("body_secret_123456"), false);
  assert.equal(serialized.includes("decision_secret_123"), false);
  assert.equal(serialized.includes("source_secret_123"), false);
  assert.equal(serialized.includes("raw_reviewer_should_not_leak"), false);
});

test("support knowledge flow CLI writes operator artifacts and source config", async () => {
  const events = [knownIssueStatusEvent()];
  const pending = runRagSupportKnowledgeFlow({
    flowId: "support_flow_cli_pending",
    generatedAt: GENERATED_AT,
    events
  });
  const candidate = pending.candidateQueue.candidates[0];
  assert.ok(candidate);

  const tempDir = await mkdtemp(path.join(tmpdir(), "rag-support-knowledge-flow-"));
  const eventsPath = path.join(tempDir, "events.jsonl");
  const decisionsPath = path.join(tempDir, "decisions.jsonl");
  const reportDir = path.join(tempDir, "report");
  await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await writeFile(
    decisionsPath,
    `${JSON.stringify({
      decisionId: "decision_cli_known_issue",
      candidateId: candidate.candidateId,
      action: "approve",
      reviewerIdHash: "reviewer_hash_cli",
      summary: "Approved CLI fixture.",
      approvedBody: "Engineering is working on the known issue."
    })}\n`
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "scripts/run-support-knowledge-flow.mjs",
      "--events",
      eventsPath,
      "--decisions",
      decisionsPath,
      "--report-dir",
      reportDir,
      "--generated-at",
      GENERATED_AT,
      "--flow-id",
      "support_flow_cli",
      "--access-scope-json",
      JSON.stringify({
        tenantId: "tenant_1",
        namespaceId: "generic-docs",
        roles: ["support"]
      }),
      "--metadata-json",
      JSON.stringify({
        environment: "test"
      })
    ],
    { cwd: process.cwd() }
  );

  const flow = JSON.parse(await readFile(path.join(reportDir, "flow.json"), "utf8"));
  const sourcesConfig = JSON.parse(
    await readFile(path.join(reportDir, "approved-knowledge.sources.json"), "utf8")
  );
  const approvalLedger = JSON.parse(
    await readFile(path.join(reportDir, "approval-ledger.json"), "utf8")
  );
  const flowMarkdown = await readFile(path.join(reportDir, "flow.md"), "utf8");

  assert.equal(stdout.includes("Support knowledge flow built: ready_for_ingestion"), true);
  assert.equal(flow.status, "ready_for_ingestion");
  assert.equal(flow.ingestionReadiness.answerableNow, false);
  assert.equal(sourcesConfig.sources.length, 1);
  assert.deepEqual(sourcesConfig.sources[0].ledgerPaths, ["approval-ledger.json"]);
  assert.deepEqual(sourcesConfig.sources[0].artifactIds, [
    approvalLedger.approvedArtifacts[0].artifactId
  ]);
  assert.equal(flowMarkdown.includes("## Approved Knowledge Sources"), true);
});

test("support knowledge flow CLI can auto-approve safe ticket updates", async () => {
  const events = [knownIssueStatusEvent()];
  const tempDir = await mkdtemp(path.join(tmpdir(), "rag-support-knowledge-flow-auto-"));
  const eventsPath = path.join(tempDir, "events.jsonl");
  const reportDir = path.join(tempDir, "report");
  await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "scripts/run-support-knowledge-flow.mjs",
      "--events",
      eventsPath,
      "--report-dir",
      reportDir,
      "--generated-at",
      GENERATED_AT,
      "--flow-id",
      "support_flow_cli_auto",
      "--auto-approve-safe-ticket-updates"
    ],
    { cwd: process.cwd() }
  );

  const flow = JSON.parse(await readFile(path.join(reportDir, "flow.json"), "utf8"));
  const approvalLedger = JSON.parse(
    await readFile(path.join(reportDir, "approval-ledger.json"), "utf8")
  );

  assert.equal(stdout.includes("Support knowledge flow built: ready_for_ingestion"), true);
  assert.equal(stdout.includes("1 auto decision(s)"), true);
  assert.equal(flow.status, "ready_for_ingestion");
  assert.equal(flow.metrics.autoApprovalDecisionCount, 1);
  assert.equal(
    approvalLedger.approvedArtifacts[0].body,
    "We know this problem exists and are investigating a fix."
  );
});

test("support knowledge flow CLI rejects malformed support event input", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "rag-support-knowledge-flow-bad-"));
  const eventsPath = path.join(tempDir, "events.json");
  await writeFile(eventsPath, `${JSON.stringify([{ schemaVersion: 1, eventId: "bad_event" }])}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/run-support-knowledge-flow.mjs", "--events", eventsPath, "--report-dir", tempDir],
      { cwd: process.cwd() }
    ),
    (error) => {
      const stderr =
        typeof error === "object" && error !== null && "stderr" in error ? error.stderr : "";
      assert.equal(String(stderr).includes("idempotencyKey"), true);
      return true;
    }
  );
});

function knownIssueStatusEvent(
  options: {
    readonly summary?: string;
  } = {}
) {
  return buildRagSupportEvent({
    eventId: "support_event_known_issue_in_progress",
    sourceSystem: "admin_support",
    sourceEventId: "engineering_status_1",
    sourceTicketId: "ticket_123",
    runId: "run_123",
    traceId: "trace_123",
    profileId: "generic-docs",
    namespaceId: "generic-docs",
    eventType: "engineering_status_changed",
    occurredAt: GENERATED_AT,
    summary: options.summary ?? "Engineering marked the known issue as in progress.",
    evidenceRefs: [
      {
        refId: "known_issue_123",
        kind: "known_issue",
        sourceSystem: "admin_support",
        artifactPath: "support/known-issues/known_issue_123.json",
        ticketId: "ticket_123",
        runId: "run_123",
        traceId: "trace_123",
        sensitivity: "internal_only",
        customerSafe: false
      }
    ],
    proposedKnowledgeAction: {
      kind: "known_issue_status_update",
      targetId: "known_issue_blocking_failure",
      knownIssueStatus: "in_progress",
      title: "Blocking issue in progress",
      summary: "Engineering is investigating a fix.",
      proposedWording: "We know this problem exists and engineering is working on a fix.",
      requiresApproval: true,
      approverDestination: "engineering"
    },
    metadata: {
      supportState: "engineering_investigation"
    }
  });
}

function routingRuleEvent() {
  return buildRagSupportEvent({
    eventId: "support_event_routing_rule",
    sourceSystem: "admin_support",
    sourceEventId: "route_correction_1",
    sourceTicketId: "ticket_456",
    profileId: "generic-docs",
    namespaceId: "generic-docs",
    eventType: "route_corrected",
    occurredAt: GENERATED_AT,
    summary: "A route correction suggests changing support routing.",
    evidenceRefs: [
      {
        refId: "route_correction_1",
        kind: "route_correction",
        sourceSystem: "admin_support",
        artifactPath: "support/route-corrections/route_correction_1.json",
        ticketId: "ticket_456",
        sensitivity: "internal_only",
        customerSafe: false
      }
    ],
    proposedKnowledgeAction: {
      kind: "routing_rule_update",
      targetId: "routing_rule_billing",
      summary: "Route future billing tickets differently.",
      proposedWording: "Billing tickets should go to the billing queue.",
      requiresApproval: true,
      approverDestination: "support_ops"
    },
    metadata: {
      supportState: "route_correction"
    }
  });
}
