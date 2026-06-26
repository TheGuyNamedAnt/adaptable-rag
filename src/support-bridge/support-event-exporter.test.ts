import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertRagSupportEventExporterContract,
  buildRagSupportEventExportBundle,
  renderRagSupportEventExportMarkdown,
  validateRagSupportEventExportBundle,
  validateRagSupportEventExporterContract,
  type RagSupportEventExporter
} from "./support-event-exporter.js";
import { buildRagSupportEvent, type RagSupportEvent } from "./support-event.js";

const execFileAsync = promisify(execFile);
const GENERATED_AT = "2026-06-24T00:00:00.000Z";

test("support event exporter contract accepts safe project exports", async () => {
  const event = knownIssueCandidateEvent();
  const exporter: RagSupportEventExporter = {
    id: "project_support_exporter",
    description: "Exports safe support events from a project-owned admin system.",
    exportEvents: () => ({
      events: [event],
      approvalDecisions: [
        {
          candidateId: "candidate_known_issue_1",
          action: "approve",
          reviewerIdHash: "reviewer_hash_1",
          summary: "Approved known issue wording.",
          approvedBody: "We know this issue exists and engineering is working on a fix."
        }
      ],
      metadata: {
        connector: "project-admin"
      }
    })
  };

  const result = await assertRagSupportEventExporterContract({
    exporter,
    request: {
      exportId: "support_export_1",
      generatedAt: GENERATED_AT
    }
  });

  assert.equal(result.status, "passed");
  assert.equal(result.metrics.eventCount, 1);
  assert.equal(result.metrics.approvalDecisionCount, 1);
  assert.equal(result.metrics.processableEventCount, 1);
  assert.equal(result.bundle?.ledger.status, "passed");
  assert.deepEqual(result.issues, []);
});

test("support event exporter contract rejects unsafe events and raw reviewer ids", async () => {
  const unsafeEvent = {
    ...knownIssueCandidateEvent(),
    summary: "Raw support detail leaked Bearer abcdefghijklmnop",
    payloadHash: "not-a-sha256",
    evidenceBoundary: [],
    proposedKnowledgeAction: {
      kind: "known_issue_candidate",
      requiresApproval: false
    }
  } as RagSupportEvent;
  const exporter: RagSupportEventExporter = {
    id: "unsafe_project_exporter",
    description: "Unsafe fixture.",
    exportEvents: () => ({
      events: [unsafeEvent],
      approvalDecisions: [
        {
          candidateId: "candidate_known_issue_1",
          action: "approve",
          reviewerId: "raw_reviewer@example.test",
          summary: "Approved after checking token=decision_secret_123.",
          approvedBody: "Unsafe decision body."
        }
      ]
    })
  };

  const result = await validateRagSupportEventExporterContract({
    exporter,
    request: {
      generatedAt: GENERATED_AT
    }
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(result.issues.map((issue) => issue.code).sort(), [
    "decision_contains_raw_reviewer_id",
    "decision_contains_sensitive_text",
    "event_contains_sensitive_text",
    "event_evidence_boundary_missing",
    "event_payload_hash_invalid",
    "event_proposed_action_requires_approval"
  ]);
  await assert.rejects(
    assertRagSupportEventExporterContract({
      exporter,
      request: {
        generatedAt: GENERATED_AT
      }
    }),
    /Support event exporter contract failed/u
  );
});

test("support event export bundle validation detects idempotency conflicts", () => {
  const first = knownIssueCandidateEvent({
    eventId: "support_event_first",
    summary: "First known issue signal."
  });
  const conflict = knownIssueCandidateEvent({
    eventId: "support_event_conflict",
    summary: "Same idempotency key, different payload."
  });
  const bundle = buildRagSupportEventExportBundle({
    exportId: "support_export_conflict",
    exporterId: "project_support_exporter",
    generatedAt: GENERATED_AT,
    events: [first, conflict]
  });
  const issues = validateRagSupportEventExportBundle({ bundle });
  const markdown = renderRagSupportEventExportMarkdown(bundle, issues);

  assert.equal(bundle.ledger.status, "failed");
  assert.equal(
    issues.some((issue) => issue.code === "ledger_conflict"),
    true
  );
  assert.equal(markdown.includes("ledger_conflict"), true);
});

test("support event export validator CLI writes export and validation artifacts", async () => {
  const event = knownIssueCandidateEvent();
  const tempDir = await mkdtemp(path.join(tmpdir(), "rag-support-export-"));
  const eventsPath = path.join(tempDir, "events.jsonl");
  const decisionsPath = path.join(tempDir, "decisions.jsonl");
  const reportDir = path.join(tempDir, "report");
  await writeFile(eventsPath, `${JSON.stringify(event)}\n`);
  await writeFile(
    decisionsPath,
    `${JSON.stringify({
      candidateId: "candidate_known_issue_1",
      action: "approve",
      reviewerIdHash: "reviewer_hash_1",
      summary: "Approved known issue wording.",
      approvedBody: "Engineering is working on the known issue."
    })}\n`
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "scripts/validate-support-event-export.mjs",
      "--events",
      eventsPath,
      "--decisions",
      decisionsPath,
      "--report-dir",
      reportDir,
      "--generated-at",
      GENERATED_AT,
      "--export-id",
      "support_export_cli",
      "--exporter-id",
      "project_support_exporter"
    ],
    { cwd: process.cwd() }
  );
  const validation = JSON.parse(await readFile(path.join(reportDir, "validation.json"), "utf8"));
  const bundle = JSON.parse(await readFile(path.join(reportDir, "export.json"), "utf8"));
  const markdown = await readFile(path.join(reportDir, "export.md"), "utf8");
  const eventsJsonl = await readFile(path.join(reportDir, "events.jsonl"), "utf8");

  assert.equal(stdout.includes("Support event export validation passed"), true);
  assert.equal(validation.status, "passed");
  assert.equal(bundle.metrics.eventCount, 1);
  assert.equal(bundle.metrics.approvalDecisionCount, 1);
  assert.equal(markdown.includes("Support Event Export"), true);
  assert.equal(eventsJsonl.trim().length > 0, true);
});

function knownIssueCandidateEvent(
  options: {
    readonly eventId?: string;
    readonly summary?: string;
  } = {}
) {
  return buildRagSupportEvent({
    ...(options.eventId === undefined ? {} : { eventId: options.eventId }),
    sourceSystem: "admin_support",
    sourceEventId: "known_issue_signal_123",
    sourceTicketId: "ticket_123",
    runId: "run_123",
    traceId: "trace_123",
    profileId: "generic-docs",
    namespaceId: "generic-docs",
    eventType: "known_issue_candidate_created",
    occurredAt: GENERATED_AT,
    summary: options.summary ?? "Support ticket indicates a possible known issue.",
    evidenceRefs: [
      {
        refId: "ticket_123",
        kind: "ticket",
        sourceSystem: "admin_support",
        artifactPath: "support/tickets/ticket_123.json",
        ticketId: "ticket_123",
        runId: "run_123",
        traceId: "trace_123",
        sensitivity: "internal_only",
        customerSafe: false
      }
    ],
    proposedKnowledgeAction: {
      kind: "known_issue_candidate",
      targetId: "known_issue_blocking_failure",
      knownIssueStatus: "candidate",
      title: "Possible blocking failure known issue",
      summary: "Create a candidate known issue from repeated reports.",
      proposedWording: "We're checking whether this matches other reports.",
      requiresApproval: true,
      approverDestination: "engineering"
    },
    metadata: {
      supportState: "engineering_investigation"
    }
  });
}
