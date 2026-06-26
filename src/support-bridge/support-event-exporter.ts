import type { RagSupportKnowledgeApprovalDecisionInput } from "./approval-ledger.js";
import {
  buildRagSupportEventIdempotencyLedger,
  type RagSupportEventIdempotencyLedger
} from "./idempotency-ledger.js";
import type {
  RagSupportEvent,
  RagSupportEventSourceSystem,
  RagSupportEventType,
  RagSupportKnowledgeActionKind
} from "./support-event.js";

export const RAG_SUPPORT_EVENT_EXPORT_SCHEMA_VERSION = 1;

export type RagSupportEventExportStatus = "passed" | "needs_attention" | "failed";
export type RagSupportEventExportContractSeverity = "error" | "warning";

export type RagSupportEventExportContractIssueCode =
  | "exporter_id_required"
  | "exporter_description_required"
  | "exporter_threw"
  | "event_count_below_minimum"
  | "approval_decision_unexpected"
  | "export_warning_unexpected"
  | "export_warning_code_required"
  | "export_warning_message_required"
  | "export_warning_leaks_sensitive_diagnostics"
  | "event_schema_invalid"
  | "event_source_system_invalid"
  | "event_type_invalid"
  | "event_payload_hash_invalid"
  | "event_evidence_boundary_missing"
  | "event_contains_sensitive_text"
  | "event_proposed_action_requires_approval"
  | "decision_contains_raw_reviewer_id"
  | "decision_contains_sensitive_text"
  | "ledger_conflict";

export interface RagSupportEventExporter {
  readonly id: string;
  readonly description: string;
  exportEvents(
    request: RagSupportEventExportRequest
  ): Promise<RagSupportEventExporterResult> | RagSupportEventExporterResult;
}

export interface RagSupportEventExportRequest {
  readonly exportId?: string;
  readonly generatedAt?: string;
  readonly previousLedger?: RagSupportEventIdempotencyLedger;
  readonly cursor?: string;
  readonly maxEvents?: number;
  readonly profileId?: string;
  readonly namespaceId?: string;
}

export interface RagSupportEventExportWarning {
  readonly code: string;
  readonly message: string;
  readonly eventId?: string;
}

export interface RagSupportEventExporterResult {
  readonly events: readonly RagSupportEvent[];
  readonly approvalDecisions?: readonly RagSupportKnowledgeApprovalDecisionInput[];
  readonly warnings?: readonly RagSupportEventExportWarning[];
  readonly cursor?: string;
  readonly metadata?: RagSupportEventExportMetadata;
}

export type RagSupportEventExportMetadata = Readonly<Record<string, string | number | boolean>>;

export interface RagSupportEventExportBundleInput {
  readonly exportId?: string;
  readonly exporterId: string;
  readonly generatedAt?: string;
  readonly events: readonly RagSupportEvent[];
  readonly approvalDecisions?: readonly RagSupportKnowledgeApprovalDecisionInput[];
  readonly previousLedger?: RagSupportEventIdempotencyLedger;
  readonly warnings?: readonly RagSupportEventExportWarning[];
  readonly cursor?: string;
  readonly metadata?: RagSupportEventExportMetadata;
}

export interface RagSupportEventExportMetrics {
  readonly eventCount: number;
  readonly approvalDecisionCount: number;
  readonly exportWarningCount: number;
  readonly processableEventCount: number;
  readonly duplicateEventCount: number;
  readonly conflictEventCount: number;
  readonly proposedKnowledgeActionCount: number;
}

export interface RagSupportEventExportBundle {
  readonly schemaVersion: typeof RAG_SUPPORT_EVENT_EXPORT_SCHEMA_VERSION;
  readonly exportId: string;
  readonly exporterId: string;
  readonly generatedAt: string;
  readonly status: RagSupportEventExportStatus;
  readonly events: readonly RagSupportEvent[];
  readonly approvalDecisions: readonly RagSupportKnowledgeApprovalDecisionInput[];
  readonly ledger: RagSupportEventIdempotencyLedger;
  readonly metrics: RagSupportEventExportMetrics;
  readonly warnings: readonly RagSupportEventExportWarning[];
  readonly cursor?: string;
  readonly metadata: RagSupportEventExportMetadata;
  readonly evidenceBoundary: readonly string[];
}

export interface RagSupportEventExporterContractExpectations {
  readonly minEvents?: number;
  readonly allowApprovalDecisions?: boolean;
  readonly allowExportWarnings?: boolean;
  readonly allowLedgerConflicts?: boolean;
  readonly allowedSourceSystems?: readonly RagSupportEventSourceSystem[];
  readonly forbiddenDiagnosticPatterns?: readonly RegExp[];
}

export interface RagSupportEventExporterContractOptions {
  readonly exporter: RagSupportEventExporter;
  readonly request?: RagSupportEventExportRequest;
  readonly expectations?: RagSupportEventExporterContractExpectations;
}

export interface RagSupportEventExportBundleValidationOptions {
  readonly bundle: RagSupportEventExportBundle;
  readonly expectations?: RagSupportEventExporterContractExpectations;
}

export interface RagSupportEventExportContractIssue {
  readonly severity: RagSupportEventExportContractSeverity;
  readonly code: RagSupportEventExportContractIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface RagSupportEventExportContractResult {
  readonly status: RagSupportEventExportStatus;
  readonly exporterId: string;
  readonly exportId?: string;
  readonly metrics: RagSupportEventExportMetrics;
  readonly issues: readonly RagSupportEventExportContractIssue[];
  readonly bundle?: RagSupportEventExportBundle;
  readonly evidenceBoundary: readonly string[];
}

export class RagSupportEventExporterContractError extends Error {
  readonly result: RagSupportEventExportContractResult;

  constructor(result: RagSupportEventExportContractResult) {
    super(
      `Support event exporter contract failed for "${result.exporterId}": ${result.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.message)
        .join("; ")}`
    );
    this.name = "RagSupportEventExporterContractError";
    this.result = result;
  }
}

const SUPPORT_EVENT_SOURCE_SYSTEMS = [
  "admin_support",
  "support_bot",
  "rag_review",
  "external_ticket",
  "manual"
] as const satisfies readonly RagSupportEventSourceSystem[];

const SUPPORT_EVENT_TYPES = [
  "ticket_triaged",
  "human_review_saved",
  "route_corrected",
  "reply_approved",
  "reply_delivery_preview_created",
  "engineering_investigation_started",
  "engineering_status_changed",
  "known_issue_candidate_created",
  "known_issue_confirmed",
  "known_issue_status_changed",
  "ticket_resolved",
  "customer_confirmed_fix",
  "eval_failure_action_reviewed",
  "rag_review_decision_recorded",
  "rag_feedback_signal_created"
] as const satisfies readonly RagSupportEventType[];

const SUPPORT_KNOWLEDGE_ACTION_KINDS = [
  "none",
  "known_issue_candidate",
  "known_issue_status_update",
  "support_policy_update",
  "routing_rule_update",
  "eval_case",
  "customer_macro_update",
  "corpus_doc_update"
] as const satisfies readonly RagSupportKnowledgeActionKind[];

const DEFAULT_FORBIDDEN_DIAGNOSTIC_PATTERNS = [
  /bearer\s+(?!\[redacted\])[a-z0-9._~+/=-]{8,}/iu,
  /api[_-]?key\s*[:=]\s*(?!\[redacted\])[^,\s]+/iu,
  /password\s*[:=]\s*(?!\[redacted\])[^,\s]+/iu,
  /secret\s*[:=]\s*(?!\[redacted\])[^,\s]+/iu,
  /token\s*[:=]\s*(?!\[redacted\])[^,\s]+/iu
] as const;

const EMPTY_METRICS: RagSupportEventExportMetrics = {
  eventCount: 0,
  approvalDecisionCount: 0,
  exportWarningCount: 0,
  processableEventCount: 0,
  duplicateEventCount: 0,
  conflictEventCount: 0,
  proposedKnowledgeActionCount: 0
};

export async function assertRagSupportEventExporterContract(
  options: RagSupportEventExporterContractOptions
): Promise<RagSupportEventExportContractResult> {
  const result = await validateRagSupportEventExporterContract(options);
  if (result.issues.some((issue) => issue.severity === "error")) {
    throw new RagSupportEventExporterContractError(result);
  }

  return result;
}

export async function validateRagSupportEventExporterContract(
  options: RagSupportEventExporterContractOptions
): Promise<RagSupportEventExportContractResult> {
  const issues: RagSupportEventExportContractIssue[] = [];
  const expectations = normalizeExpectations(options.expectations);
  validateStaticExporterContract(options.exporter, issues);

  let exported: RagSupportEventExporterResult | undefined;
  try {
    exported = await options.exporter.exportEvents(options.request ?? {});
  } catch (error) {
    issues.push({
      severity: "error",
      code: "exporter_threw",
      path: "exporter.exportEvents",
      message: `Exporter must return warnings instead of throwing: ${errorName(error)}.`
    });
  }

  if (!exported) {
    return contractResult({
      exporterId: safeLabel(options.exporter.id),
      issues,
      metrics: EMPTY_METRICS
    });
  }

  const generatedAt = options.request?.generatedAt ?? new Date().toISOString();
  const bundle = buildRagSupportEventExportBundle({
    exporterId: options.exporter.id,
    generatedAt,
    events: exported.events,
    ...(options.request?.exportId === undefined ? {} : { exportId: options.request.exportId }),
    ...(exported.approvalDecisions === undefined
      ? {}
      : { approvalDecisions: exported.approvalDecisions }),
    ...(options.request?.previousLedger === undefined
      ? {}
      : { previousLedger: options.request.previousLedger }),
    ...(exported.warnings === undefined ? {} : { warnings: exported.warnings }),
    ...(exported.cursor === undefined ? {} : { cursor: exported.cursor }),
    ...(exported.metadata === undefined ? {} : { metadata: exported.metadata })
  });
  issues.push(...validateRagSupportEventExportBundle({ bundle, expectations }));

  return contractResult({
    exporterId: safeLabel(options.exporter.id),
    exportId: bundle.exportId,
    bundle,
    issues,
    metrics: bundle.metrics
  });
}

export function buildRagSupportEventExportBundle(
  input: RagSupportEventExportBundleInput
): RagSupportEventExportBundle {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const exportId =
    input.exportId ??
    `rag_support_event_export_${safeTimestamp(generatedAt)}_${safeId(input.exporterId)}`;
  const ledger = buildRagSupportEventIdempotencyLedger({
    ledgerId: `${exportId}_ledger`,
    generatedAt,
    events: input.events,
    ...(input.previousLedger === undefined ? {} : { previousLedger: input.previousLedger })
  });
  const metrics = exportMetrics({
    events: input.events,
    approvalDecisions: input.approvalDecisions ?? [],
    warnings: input.warnings ?? [],
    ledger
  });

  return {
    schemaVersion: RAG_SUPPORT_EVENT_EXPORT_SCHEMA_VERSION,
    exportId,
    exporterId: safeId(input.exporterId),
    generatedAt,
    status: exportStatus(ledger, input.warnings ?? []),
    events: input.events,
    approvalDecisions: input.approvalDecisions ?? [],
    ledger,
    metrics,
    warnings: input.warnings ?? [],
    ...(input.cursor === undefined ? {} : { cursor: safeText(input.cursor) }),
    metadata: safeMetadata(input.metadata ?? {}),
    evidenceBoundary: ragSupportEventExportEvidenceBoundary()
  };
}

export function validateRagSupportEventExportBundle(
  options: RagSupportEventExportBundleValidationOptions
): readonly RagSupportEventExportContractIssue[] {
  const expectations = normalizeExpectations(options.expectations);
  const issues: RagSupportEventExportContractIssue[] = [];
  validateBundleCounts(options.bundle, expectations, issues);
  validateExportWarnings(options.bundle.warnings, expectations, issues);
  validateEvents(options.bundle.events, expectations, issues);
  validateApprovalDecisions(options.bundle.approvalDecisions, expectations, issues);

  if (options.bundle.ledger.status === "failed" && !expectations.allowLedgerConflicts) {
    issues.push({
      severity: "error",
      code: "ledger_conflict",
      path: "ledger.status",
      message: "Exported support events produced an idempotency conflict."
    });
  }

  return issues;
}

export function renderRagSupportEventExportMarkdown(
  bundle: RagSupportEventExportBundle,
  issues: readonly RagSupportEventExportContractIssue[] = []
): string {
  return [
    "# Support Event Export",
    "",
    `- Export ID: \`${md(bundle.exportId)}\``,
    `- Exporter: \`${md(bundle.exporterId)}\``,
    `- Generated: \`${md(bundle.generatedAt)}\``,
    `- Status: **${md(bundle.status)}**`,
    "",
    "## Metrics",
    "",
    `- Events: ${bundle.metrics.eventCount}`,
    `- Processable events: ${bundle.metrics.processableEventCount}`,
    `- Duplicate events: ${bundle.metrics.duplicateEventCount}`,
    `- Conflict events: ${bundle.metrics.conflictEventCount}`,
    `- Proposed knowledge actions: ${bundle.metrics.proposedKnowledgeActionCount}`,
    `- Approval decisions: ${bundle.metrics.approvalDecisionCount}`,
    `- Export warnings: ${bundle.metrics.exportWarningCount}`,
    "",
    "## Contract Issues",
    "",
    issueTable(issues),
    "",
    "## Events",
    "",
    eventTable(bundle.events),
    "",
    "## Evidence Boundary",
    "",
    bundle.evidenceBoundary.map((entry) => `- ${md(entry)}`).join("\n"),
    ""
  ].join("\n");
}

export function ragSupportEventExportEvidenceBoundary(): readonly string[] {
  return [
    "Includes safe support event ids, source systems, ticket ids, run ids, trace ids, profile/namespace ids, summaries, evidence refs, proposed knowledge-action metadata, idempotency status, safe approval-decision shells, and export warnings.",
    "Excludes raw admin ticket payloads, raw customer messages, raw diagnostics, raw generated answers, rendered prompts, source bodies, credentials, routing secrets, full principal claims, and raw reviewer identifiers.",
    "Exported support events and approval decisions are operational handoff artifacts only; support knowledge remains non-answerable until support knowledge approval and production ingestion gates both pass."
  ];
}

export function supportEventExportContractEvidenceBoundary(): readonly string[] {
  return [
    "Checks exporter identity, event schema, source-system enums, event-type enums, payload-hash shape, idempotency conflicts, approval-decision reviewer identity handling, warning redaction, and forbidden diagnostic patterns.",
    "Does not execute project code beyond the provided exporter callback and does not fetch raw tickets itself.",
    "Passing this contract proves the export boundary shape, not the truth of the underlying project support data."
  ];
}

function validateStaticExporterContract(
  exporter: RagSupportEventExporter,
  issues: RagSupportEventExportContractIssue[]
): void {
  if (!exporter.id.trim()) {
    issues.push({
      severity: "error",
      code: "exporter_id_required",
      path: "exporter.id",
      message: "Exporter id is required."
    });
  }

  if (!exporter.description.trim()) {
    issues.push({
      severity: "error",
      code: "exporter_description_required",
      path: "exporter.description",
      message: "Exporter description is required."
    });
  }
}

function validateBundleCounts(
  bundle: RagSupportEventExportBundle,
  expectations: NormalizedExpectations,
  issues: RagSupportEventExportContractIssue[]
): void {
  if (bundle.events.length < expectations.minEvents) {
    issues.push({
      severity: "error",
      code: "event_count_below_minimum",
      path: "events",
      message: `Exporter returned ${bundle.events.length} event(s), expected at least ${expectations.minEvents}.`
    });
  }

  if (bundle.approvalDecisions.length > 0 && !expectations.allowApprovalDecisions) {
    issues.push({
      severity: "error",
      code: "approval_decision_unexpected",
      path: "approvalDecisions",
      message: "Exporter returned approval decisions, but this fixture does not allow them."
    });
  }
}

function validateExportWarnings(
  warnings: readonly RagSupportEventExportWarning[],
  expectations: NormalizedExpectations,
  issues: RagSupportEventExportContractIssue[]
): void {
  if (warnings.length > 0 && !expectations.allowExportWarnings) {
    issues.push({
      severity: "error",
      code: "export_warning_unexpected",
      path: "warnings",
      message: "Exporter returned warnings, but warnings are disallowed by this fixture."
    });
  }

  warnings.forEach((warning, index) => {
    if (!warning.code.trim()) {
      issues.push({
        severity: "error",
        code: "export_warning_code_required",
        path: `warnings[${index}].code`,
        message: "Export warning code is required."
      });
    }

    if (!warning.message.trim()) {
      issues.push({
        severity: "error",
        code: "export_warning_message_required",
        path: `warnings[${index}].message`,
        message: "Export warning message is required."
      });
    }

    if (containsForbiddenDiagnostic(warning.message, expectations.forbiddenDiagnosticPatterns)) {
      issues.push({
        severity: "error",
        code: "export_warning_leaks_sensitive_diagnostics",
        path: `warnings[${index}].message`,
        message: "Export warning message contains a forbidden sensitive diagnostic pattern."
      });
    }
  });
}

function validateEvents(
  events: readonly RagSupportEvent[],
  expectations: NormalizedExpectations,
  issues: RagSupportEventExportContractIssue[]
): void {
  events.forEach((event, index) => {
    const path = `events[${index}]`;
    validateEventShape(event, path, expectations, issues);

    if (
      containsForbiddenDiagnostic(JSON.stringify(event), expectations.forbiddenDiagnosticPatterns)
    ) {
      issues.push({
        severity: "error",
        code: "event_contains_sensitive_text",
        path,
        message: "Support event contains a forbidden sensitive diagnostic pattern."
      });
    }
  });
}

function validateEventShape(
  event: RagSupportEvent,
  path: string,
  expectations: NormalizedExpectations,
  issues: RagSupportEventExportContractIssue[]
): void {
  if (event.schemaVersion !== 1) {
    issueInvalidEvent(path, "schemaVersion must be 1.", issues);
  }
  requireNonEmptyString(event.eventId, `${path}.eventId`, issues);
  requireNonEmptyString(event.idempotencyKey, `${path}.idempotencyKey`, issues);
  requireNonEmptyString(event.eventVersion, `${path}.eventVersion`, issues);
  requireNonEmptyString(event.occurredAt, `${path}.occurredAt`, issues);
  requireNonEmptyString(event.observedAt, `${path}.observedAt`, issues);
  requireNonEmptyString(event.summary, `${path}.summary`, issues);

  if (!expectations.allowedSourceSystems.includes(event.sourceSystem)) {
    issues.push({
      severity: "error",
      code: "event_source_system_invalid",
      path: `${path}.sourceSystem`,
      message: `Unsupported support event source system "${safeLabel(event.sourceSystem)}".`
    });
  }

  if (!SUPPORT_EVENT_TYPES.includes(event.eventType)) {
    issues.push({
      severity: "error",
      code: "event_type_invalid",
      path: `${path}.eventType`,
      message: `Unsupported support event type "${safeLabel(event.eventType)}".`
    });
  }

  if (!/^sha256:[a-f0-9]{64}$/u.test(event.payloadHash)) {
    issues.push({
      severity: "error",
      code: "event_payload_hash_invalid",
      path: `${path}.payloadHash`,
      message: "Support event payloadHash must be a sha256 hash."
    });
  }

  if (
    !Array.isArray(event.evidenceBoundary) ||
    !event.evidenceBoundary.some((entry) => entry.includes("raw customer messages"))
  ) {
    issues.push({
      severity: "error",
      code: "event_evidence_boundary_missing",
      path: `${path}.evidenceBoundary`,
      message: "Support event evidence boundary must explicitly exclude raw customer messages."
    });
  }

  if (!Array.isArray(event.evidenceRefs)) {
    issueInvalidEvent(`${path}.evidenceRefs`, "evidenceRefs must be an array.", issues);
  }

  if (!isRecord(event.metadata)) {
    issueInvalidEvent(`${path}.metadata`, "metadata must be an object.", issues);
  }

  if (!isRecord(event.proposedKnowledgeAction)) {
    issueInvalidEvent(
      `${path}.proposedKnowledgeAction`,
      "proposedKnowledgeAction must be an object.",
      issues
    );
    return;
  }

  const actionKind = event.proposedKnowledgeAction.kind;
  if (!SUPPORT_KNOWLEDGE_ACTION_KINDS.includes(actionKind)) {
    issueInvalidEvent(
      `${path}.proposedKnowledgeAction.kind`,
      `Unsupported proposed knowledge action kind "${safeLabel(actionKind)}".`,
      issues
    );
  }

  if (actionKind !== "none" && event.proposedKnowledgeAction.requiresApproval !== true) {
    issues.push({
      severity: "error",
      code: "event_proposed_action_requires_approval",
      path: `${path}.proposedKnowledgeAction.requiresApproval`,
      message: "Support knowledge actions must require approval before promotion."
    });
  }
}

function validateApprovalDecisions(
  decisions: readonly RagSupportKnowledgeApprovalDecisionInput[],
  expectations: NormalizedExpectations,
  issues: RagSupportEventExportContractIssue[]
): void {
  decisions.forEach((decision, index) => {
    const path = `approvalDecisions[${index}]`;
    if (decision.reviewerId !== undefined) {
      issues.push({
        severity: "error",
        code: "decision_contains_raw_reviewer_id",
        path: `${path}.reviewerId`,
        message: "Exported approval decisions must use reviewerIdHash instead of raw reviewerId."
      });
    }

    if (
      containsForbiddenDiagnostic(
        JSON.stringify(decision),
        expectations.forbiddenDiagnosticPatterns
      )
    ) {
      issues.push({
        severity: "error",
        code: "decision_contains_sensitive_text",
        path,
        message: "Approval decision contains a forbidden sensitive diagnostic pattern."
      });
    }
  });
}

interface NormalizedExpectations {
  readonly minEvents: number;
  readonly allowApprovalDecisions: boolean;
  readonly allowExportWarnings: boolean;
  readonly allowLedgerConflicts: boolean;
  readonly allowedSourceSystems: readonly RagSupportEventSourceSystem[];
  readonly forbiddenDiagnosticPatterns: readonly RegExp[];
}

function normalizeExpectations(
  expectations: RagSupportEventExporterContractExpectations | undefined
): NormalizedExpectations {
  return {
    minEvents: nonNegativeInteger(expectations?.minEvents, 1, "minEvents"),
    allowApprovalDecisions: expectations?.allowApprovalDecisions ?? true,
    allowExportWarnings: expectations?.allowExportWarnings ?? true,
    allowLedgerConflicts: expectations?.allowLedgerConflicts ?? false,
    allowedSourceSystems: expectations?.allowedSourceSystems ?? SUPPORT_EVENT_SOURCE_SYSTEMS,
    forbiddenDiagnosticPatterns:
      expectations?.forbiddenDiagnosticPatterns ?? DEFAULT_FORBIDDEN_DIAGNOSTIC_PATTERNS
  };
}

function contractResult(input: {
  readonly exporterId: string;
  readonly exportId?: string;
  readonly bundle?: RagSupportEventExportBundle;
  readonly issues: readonly RagSupportEventExportContractIssue[];
  readonly metrics: RagSupportEventExportMetrics;
}): RagSupportEventExportContractResult {
  const hasErrors = input.issues.some((issue) => issue.severity === "error");
  const hasWarnings = input.issues.some((issue) => issue.severity === "warning");

  return {
    status: hasErrors ? "failed" : hasWarnings ? "needs_attention" : "passed",
    exporterId: input.exporterId,
    ...(input.exportId === undefined ? {} : { exportId: input.exportId }),
    metrics: input.metrics,
    issues: input.issues,
    ...(input.bundle === undefined ? {} : { bundle: input.bundle }),
    evidenceBoundary: supportEventExportContractEvidenceBoundary()
  };
}

function exportMetrics(input: {
  readonly events: readonly RagSupportEvent[];
  readonly approvalDecisions: readonly RagSupportKnowledgeApprovalDecisionInput[];
  readonly warnings: readonly RagSupportEventExportWarning[];
  readonly ledger: RagSupportEventIdempotencyLedger;
}): RagSupportEventExportMetrics {
  return {
    eventCount: input.events.length,
    approvalDecisionCount: input.approvalDecisions.length,
    exportWarningCount: input.warnings.length,
    processableEventCount: input.ledger.processableEventIds.length,
    duplicateEventCount: input.ledger.duplicateEventIds.length,
    conflictEventCount: input.ledger.conflictEventIds.length,
    proposedKnowledgeActionCount: input.events.filter(
      (event) => event.proposedKnowledgeAction.kind !== "none"
    ).length
  };
}

function exportStatus(
  ledger: RagSupportEventIdempotencyLedger,
  warnings: readonly RagSupportEventExportWarning[]
): RagSupportEventExportStatus {
  if (ledger.status === "failed") {
    return "failed";
  }
  if (warnings.length > 0) {
    return "needs_attention";
  }
  return "passed";
}

function issueInvalidEvent(
  path: string,
  message: string,
  issues: RagSupportEventExportContractIssue[]
): void {
  issues.push({
    severity: "error",
    code: "event_schema_invalid",
    path,
    message
  });
}

function requireNonEmptyString(
  value: unknown,
  path: string,
  issues: RagSupportEventExportContractIssue[]
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    issueInvalidEvent(path, "Expected a non-empty string.", issues);
  }
}

function containsForbiddenDiagnostic(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function issueTable(issues: readonly RagSupportEventExportContractIssue[]): string {
  if (issues.length === 0) {
    return "_No contract issues._";
  }

  return [
    "| Severity | Code | Path |",
    "| --- | --- | --- |",
    ...issues.map(
      (issue) => `| ${md(issue.severity)} | \`${md(issue.code)}\` | \`${md(issue.path)}\` |`
    )
  ].join("\n");
}

function eventTable(events: readonly RagSupportEvent[]): string {
  if (events.length === 0) {
    return "_No support events._";
  }

  return [
    "| Event | Source | Type | Action |",
    "| --- | --- | --- | --- |",
    ...events.map(
      (event) =>
        `| \`${md(event.eventId)}\` | ${md(event.sourceSystem)} | ${md(event.eventType)} | ${md(
          event.proposedKnowledgeAction.kind
        )} |`
    )
  ].join("\n");
}

function safeMetadata(metadata: RagSupportEventExportMetadata): RagSupportEventExportMetadata {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      safeId(key),
      typeof value === "string" ? safeText(value) : value
    ])
  );
}

function safeText(value: string): string {
  return value
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [REDACTED]")
    .slice(0, 500);
}

function safeLabel(value: unknown): string {
  return safeText(String(value)).slice(0, 120);
}

function safeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
}

function safeTimestamp(value: string): string {
  return value.replace(/[^0-9A-Za-z]+/g, "_").replace(/^_+|_+$/g, "");
}

function nonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function md(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/`/g, "'");
}
