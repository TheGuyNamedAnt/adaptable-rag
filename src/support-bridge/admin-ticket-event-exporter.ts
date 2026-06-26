import {
  buildRagSupportEventIdempotencyLedger,
  type RagSupportEventIdempotencyLedger
} from "./idempotency-ledger.js";
import {
  buildRagSupportEvent,
  type BuildRagSupportEventInput,
  type RagKnownIssueStatus,
  type RagSupportEvent,
  type RagSupportEvidenceRef,
  type RagSupportKnowledgeActionKind
} from "./support-event.js";

export const ADMIN_SUPPORT_EVENT_EXPORT_SCHEMA_VERSION = 1;

type AdminSupportProposedKnowledgeAction = NonNullable<
  BuildRagSupportEventInput["proposedKnowledgeAction"]
>;

export interface AdminSupportEventExportInput {
  readonly exportId?: string;
  readonly generatedAt?: string;
  readonly defaultProfileId?: string;
  readonly defaultNamespaceId?: string;
  readonly previousLedger?: RagSupportEventIdempotencyLedger;
  readonly triageReports?: readonly AdminSupportTriageReportArtifact[];
  readonly ticketRecords?: readonly AdminSupportTicketRecordArtifact[];
  readonly humanReviews?: readonly AdminSupportHumanReviewArtifact[];
  readonly routeCorrections?: readonly AdminSupportRouteCorrectionArtifact[];
  readonly replyApprovals?: readonly AdminSupportReplyApprovalArtifact[];
  readonly replyDeliveryPreviews?: readonly AdminSupportReplyDeliveryPreviewArtifact[];
  readonly investigations?: readonly AdminSupportInvestigationArtifact[];
  readonly engineeringAutoRuns?: readonly AdminSupportEngineeringAutoRunArtifact[];
}

export interface AdminSupportEventExportResult {
  readonly schemaVersion: typeof ADMIN_SUPPORT_EVENT_EXPORT_SCHEMA_VERSION;
  readonly exportId: string;
  readonly generatedAt: string;
  readonly events: readonly RagSupportEvent[];
  readonly ledger: RagSupportEventIdempotencyLedger;
  readonly metrics: {
    readonly eventCount: number;
    readonly processableEventCount: number;
    readonly duplicateEventCount: number;
    readonly conflictEventCount: number;
    readonly proposedKnowledgeActionCount: number;
  };
  readonly evidenceBoundary: readonly string[];
}

export interface AdminSupportTriageReportArtifact extends AdminSupportRunTraceRef {
  readonly createdAt?: string;
  readonly artifactPath?: string;
  readonly inputSource?: string;
  readonly title?: string;
  readonly issueType?: string;
  readonly affectedArea?: string;
  readonly severity?: string;
  readonly status?: string;
  readonly escalationRequired?: boolean;
  readonly escalationTarget?: string;
  readonly humanReviewStatus?: string;
  readonly allowedActionClass?: string;
  readonly supportRoute?: AdminSupportRouteSnapshot | null;
}

export interface AdminSupportTicketRecordArtifact extends AdminSupportRunTraceRef {
  readonly ticketId: string;
  readonly updatedAt: string;
  readonly artifactPath?: string;
  readonly state?: string;
  readonly stage?: string;
  readonly currentOwner?: string;
  readonly flags?: {
    readonly knownIssueRelated?: boolean;
    readonly duplicatePossible?: boolean;
    readonly fixReadyForReview?: boolean;
    readonly finalReviewRequired?: boolean;
  };
}

export interface AdminSupportHumanReviewArtifact extends AdminSupportRunTraceRef {
  readonly reviewId: string;
  readonly reviewedAt: string;
  readonly artifactPath?: string;
  readonly reviewer?: string;
  readonly humanReviewStatus: string;
  readonly correctedIssueType?: string;
  readonly correctedSeverity?: string;
  readonly correctedAffectedArea?: string;
  readonly correctedEscalationRequired?: boolean;
  readonly correctedEscalationTarget?: string;
  readonly correctedResolutionStatus?: string;
  readonly confirmedResolutionOutcome?: string;
  readonly falseDeflection?: boolean;
  readonly markedForInvestigation?: boolean;
  readonly notes?: string;
}

export interface AdminSupportRouteCorrectionArtifact extends AdminSupportRunTraceRef {
  readonly eventId: string;
  readonly createdAt: string;
  readonly artifactPath?: string;
  readonly actor?: string;
  readonly reason?: string;
  readonly idempotencyKey?: string;
  readonly sourceReportFile?: string;
  readonly previousRoute?: AdminSupportRouteSnapshot | null;
  readonly nextRoute?: AdminSupportRouteSnapshot | null;
  readonly previousAllowedActionClass?: string;
  readonly nextAllowedActionClass?: string;
  readonly previousPriority?: string;
  readonly nextPriority?: string;
}

export interface AdminSupportReplyApprovalArtifact extends AdminSupportRunTraceRef {
  readonly approvalId: string;
  readonly createdAt: string;
  readonly artifactPath?: string;
  readonly approver?: string;
  readonly decision: string;
  readonly allowedDeliveryMode?: string;
  readonly finalSendAllowed?: boolean;
  readonly gateDecision?: string;
  readonly blockerCount?: number;
  readonly notes?: string;
}

export interface AdminSupportReplyDeliveryPreviewArtifact extends AdminSupportRunTraceRef {
  readonly deliveryPreviewId: string;
  readonly approvalId?: string;
  readonly createdAt: string;
  readonly artifactPath?: string;
  readonly actor?: string;
  readonly reason?: string;
  readonly status: string;
  readonly sendEnabled?: boolean;
  readonly sendDisabledReason?: string;
}

export interface AdminSupportInvestigationArtifact extends AdminSupportRunTraceRef {
  readonly investigationId: string;
  readonly createdAt: string;
  readonly artifactPath?: string;
  readonly status: string;
  readonly sourceReportFile?: string;
  readonly suggestedNextAction?: string;
  readonly engineeringReady?: boolean;
  readonly prCandidate?: boolean;
  readonly recommendedAction?: string;
}

export interface AdminSupportEngineeringAutoRunArtifact extends AdminSupportRunTraceRef {
  readonly autoRunId: string;
  readonly createdAt: string;
  readonly artifactPath?: string;
  readonly actor?: string;
  readonly reason?: string;
  readonly status: string;
  readonly outcomeSummary?: string;
  readonly toolActionsRequested?: boolean;
  readonly toolActionsPerformed?: boolean;
  readonly finalReviewRequired?: boolean;
}

export interface AdminSupportRunTraceRef {
  readonly runId: string;
  readonly traceId: string;
  readonly profileId?: string;
  readonly namespaceId?: string;
  readonly profilePath?: string;
  readonly sourceTicketId?: string;
}

export interface AdminSupportRouteSnapshot {
  readonly matchedRuleId?: string;
  readonly queueId?: string;
  readonly queueName?: string;
  readonly departmentId?: string;
  readonly departmentName?: string;
  readonly priority?: string;
  readonly allowedActionClass?: string;
  readonly slaPolicyId?: string;
  readonly escalationTarget?: string;
}

interface ExportContext {
  readonly generatedAt: string;
  readonly defaultProfileId?: string;
  readonly defaultNamespaceId?: string;
}

export function exportAdminSupportTicketEvents(
  input: AdminSupportEventExportInput
): AdminSupportEventExportResult {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const exportId = input.exportId ?? `admin_support_event_export_${safeTimestamp(generatedAt)}`;
  const context: ExportContext = {
    generatedAt,
    ...(input.defaultProfileId === undefined ? {} : { defaultProfileId: input.defaultProfileId }),
    ...(input.defaultNamespaceId === undefined
      ? {}
      : { defaultNamespaceId: input.defaultNamespaceId })
  };
  const events = [
    ...(input.triageReports ?? []).map((item) => eventFromTriageReport(item, context)),
    ...(input.ticketRecords ?? []).flatMap((item) => eventsFromTicketRecord(item, context)),
    ...(input.humanReviews ?? []).map((item) => eventFromHumanReview(item, context)),
    ...(input.routeCorrections ?? []).map((item) => eventFromRouteCorrection(item, context)),
    ...(input.replyApprovals ?? []).map((item) => eventFromReplyApproval(item, context)),
    ...(input.replyDeliveryPreviews ?? []).map((item) =>
      eventFromReplyDeliveryPreview(item, context)
    ),
    ...(input.investigations ?? []).map((item) => eventFromInvestigation(item, context)),
    ...(input.engineeringAutoRuns ?? []).map((item) => eventFromEngineeringAutoRun(item, context))
  ];
  const ledger = buildRagSupportEventIdempotencyLedger({
    generatedAt,
    events,
    ...(input.previousLedger === undefined ? {} : { previousLedger: input.previousLedger })
  });

  return {
    schemaVersion: ADMIN_SUPPORT_EVENT_EXPORT_SCHEMA_VERSION,
    exportId,
    generatedAt,
    events,
    ledger,
    metrics: {
      eventCount: events.length,
      processableEventCount: ledger.processableEventIds.length,
      duplicateEventCount: ledger.duplicateEventIds.length,
      conflictEventCount: ledger.conflictEventIds.length,
      proposedKnowledgeActionCount: events.filter(
        (event) => event.proposedKnowledgeAction.kind !== "none"
      ).length
    },
    evidenceBoundary: adminSupportEventExporterEvidenceBoundary()
  };
}

export function adminSupportEventExporterEvidenceBoundary(): readonly string[] {
  return [
    "Exports safe operational facts from admin support artifacts: ids, timestamps, states, routing labels, review statuses, artifact paths, and proposed knowledge actions.",
    "Does not export raw customer messages, raw diagnostic bodies, reply drafts, generated answers, full support notes, credentials, or production principal claims.",
    "Exported events are not approved knowledge; they must pass idempotency and promotion gates before the agent can cite them as known facts."
  ];
}

function eventFromTriageReport(
  artifact: AdminSupportTriageReportArtifact,
  context: ExportContext
): RagSupportEvent {
  return buildEvent({
    context,
    artifact,
    sourceEventId: `triage:${artifact.runId}:${artifact.traceId}`,
    eventType: "ticket_triaged",
    occurredAt: artifact.createdAt ?? context.generatedAt,
    summary: [
      "Admin support ticket triaged",
      artifact.title,
      artifact.issueType,
      artifact.affectedArea,
      artifact.severity,
      routeLabel(artifact.supportRoute)
    ],
    evidence: evidenceRef("trace", artifact, "triage_report", artifact.artifactPath),
    proposedKnowledgeAction: { kind: "none", requiresApproval: false },
    metadata: {
      input_source: artifact.inputSource,
      issue_type: artifact.issueType,
      affected_area: artifact.affectedArea,
      severity: artifact.severity,
      status: artifact.status,
      escalation_required: artifact.escalationRequired,
      escalation_target: artifact.escalationTarget,
      human_review_status: artifact.humanReviewStatus,
      allowed_action_class: artifact.allowedActionClass,
      route_queue_id: artifact.supportRoute?.queueId,
      route_rule_id: artifact.supportRoute?.matchedRuleId
    }
  });
}

function eventsFromTicketRecord(
  artifact: AdminSupportTicketRecordArtifact,
  context: ExportContext
): readonly RagSupportEvent[] {
  const events: RagSupportEvent[] = [];
  if (artifact.flags?.knownIssueRelated === true || artifact.flags?.duplicatePossible === true) {
    events.push(
      buildEvent({
        context,
        artifact,
        sourceEventId: `${artifact.ticketId}:known_issue_signal:${artifact.updatedAt}`,
        eventType: "known_issue_candidate_created",
        occurredAt: artifact.updatedAt,
        summary: [
          "Admin ticket indicates a possible known issue",
          artifact.ticketId,
          artifact.state,
          artifact.currentOwner
        ],
        evidence: evidenceRef("ticket", artifact, "ticket_record", artifact.artifactPath),
        proposedKnowledgeAction: {
          kind: "known_issue_candidate",
          targetId: `known_issue_${artifact.ticketId}`,
          knownIssueStatus: "candidate",
          title: "Possible known issue from admin ticket",
          summary: "Review linked support artifacts before promoting this ticket signal.",
          proposedWording: "We're checking whether this matches other reports.",
          requiresApproval: true,
          approverDestination: "human_support"
        },
        metadata: {
          ticket_state: artifact.state,
          ticket_stage: artifact.stage,
          current_owner: artifact.currentOwner,
          known_issue_related: artifact.flags.knownIssueRelated,
          duplicate_possible: artifact.flags.duplicatePossible
        }
      })
    );
  }

  if (artifact.state === "resolved") {
    events.push(
      buildEvent({
        context,
        artifact,
        sourceEventId: `${artifact.ticketId}:resolved:${artifact.updatedAt}`,
        eventType: "ticket_resolved",
        occurredAt: artifact.updatedAt,
        summary: ["Admin support ticket resolved", artifact.ticketId],
        evidence: evidenceRef("ticket", artifact, "ticket_record", artifact.artifactPath),
        proposedKnowledgeAction:
          artifact.flags?.knownIssueRelated === true
            ? knownIssueStatusAction("verified", artifact.ticketId)
            : { kind: "none", requiresApproval: false },
        metadata: {
          ticket_state: artifact.state,
          current_owner: artifact.currentOwner,
          known_issue_related: artifact.flags?.knownIssueRelated
        }
      })
    );
  }

  return events;
}

function eventFromHumanReview(
  artifact: AdminSupportHumanReviewArtifact,
  context: ExportContext
): RagSupportEvent {
  return buildEvent({
    context,
    artifact,
    sourceEventId: artifact.reviewId,
    eventType: "human_review_saved",
    occurredAt: artifact.reviewedAt,
    ...(artifact.reviewer === undefined ? {} : { actor: artifact.reviewer }),
    summary: [
      "Human review saved",
      artifact.humanReviewStatus,
      artifact.correctedIssueType,
      artifact.correctedAffectedArea,
      artifact.correctedSeverity
    ],
    evidence: evidenceRef("review", artifact, artifact.reviewId, artifact.artifactPath),
    proposedKnowledgeAction: reviewKnowledgeAction(artifact),
    metadata: {
      human_review_status: artifact.humanReviewStatus,
      corrected_issue_type: artifact.correctedIssueType,
      corrected_severity: artifact.correctedSeverity,
      corrected_affected_area: artifact.correctedAffectedArea,
      corrected_escalation_required: artifact.correctedEscalationRequired,
      corrected_escalation_target: artifact.correctedEscalationTarget,
      corrected_resolution_status: artifact.correctedResolutionStatus,
      confirmed_resolution_outcome: artifact.confirmedResolutionOutcome,
      false_deflection: artifact.falseDeflection,
      marked_for_investigation: artifact.markedForInvestigation
    }
  });
}

function eventFromRouteCorrection(
  artifact: AdminSupportRouteCorrectionArtifact,
  context: ExportContext
): RagSupportEvent {
  const targetId = artifact.nextRoute?.matchedRuleId ?? artifact.nextRoute?.queueId;

  return buildEvent({
    context,
    artifact,
    sourceEventId: artifact.eventId,
    eventType: "route_corrected",
    occurredAt: artifact.createdAt,
    ...(artifact.actor === undefined ? {} : { actor: artifact.actor }),
    summary: [
      "Support route corrected",
      routeLabel(artifact.previousRoute),
      "to",
      routeLabel(artifact.nextRoute),
      artifact.reason
    ],
    evidence: evidenceRef("route_correction", artifact, artifact.eventId, artifact.artifactPath),
    proposedKnowledgeAction: {
      kind: "routing_rule_update",
      ...(targetId === undefined ? {} : { targetId }),
      title: "Support route correction candidate",
      summary: "Review this route correction as a possible profile routing rule update.",
      requiresApproval: true,
      approverDestination: "human_support"
    },
    metadata: {
      idempotency_key: artifact.idempotencyKey,
      previous_queue_id: artifact.previousRoute?.queueId,
      next_queue_id: artifact.nextRoute?.queueId,
      previous_rule_id: artifact.previousRoute?.matchedRuleId,
      next_rule_id: artifact.nextRoute?.matchedRuleId,
      previous_allowed_action_class: artifact.previousAllowedActionClass,
      next_allowed_action_class: artifact.nextAllowedActionClass,
      previous_priority: artifact.previousPriority,
      next_priority: artifact.nextPriority,
      source_report_file: artifact.sourceReportFile
    }
  });
}

function eventFromReplyApproval(
  artifact: AdminSupportReplyApprovalArtifact,
  context: ExportContext
): RagSupportEvent {
  return buildEvent({
    context,
    artifact,
    sourceEventId: artifact.approvalId,
    eventType: "reply_approved",
    occurredAt: artifact.createdAt,
    ...(artifact.approver === undefined ? {} : { actor: artifact.approver }),
    summary: ["Reply approval recorded", artifact.decision, artifact.allowedDeliveryMode],
    evidence: evidenceRef("reply_approval", artifact, artifact.approvalId, artifact.artifactPath),
    proposedKnowledgeAction:
      artifact.decision === "needs_revision"
        ? {
            kind: "customer_macro_update",
            title: "Reply revision candidate",
            summary:
              "Review the held or revised reply decision for possible support macro changes.",
            requiresApproval: true,
            approverDestination: "human_support"
          }
        : { kind: "none", requiresApproval: false },
    metadata: {
      decision: artifact.decision,
      allowed_delivery_mode: artifact.allowedDeliveryMode,
      final_send_allowed: artifact.finalSendAllowed,
      gate_decision: artifact.gateDecision,
      blocker_count: artifact.blockerCount
    }
  });
}

function eventFromReplyDeliveryPreview(
  artifact: AdminSupportReplyDeliveryPreviewArtifact,
  context: ExportContext
): RagSupportEvent {
  return buildEvent({
    context,
    artifact,
    sourceEventId: artifact.deliveryPreviewId,
    eventType: "reply_delivery_preview_created",
    occurredAt: artifact.createdAt,
    ...(artifact.actor === undefined ? {} : { actor: artifact.actor }),
    summary: ["Reply delivery preview created", artifact.status, artifact.sendDisabledReason],
    evidence: evidenceRef(
      "reply_approval",
      artifact,
      artifact.deliveryPreviewId,
      artifact.artifactPath
    ),
    proposedKnowledgeAction: { kind: "none", requiresApproval: false },
    metadata: {
      approval_id: artifact.approvalId,
      status: artifact.status,
      send_enabled: artifact.sendEnabled,
      send_disabled_reason: artifact.sendDisabledReason
    }
  });
}

function eventFromInvestigation(
  artifact: AdminSupportInvestigationArtifact,
  context: ExportContext
): RagSupportEvent {
  const knownIssueAction =
    artifact.status === "duplicate_known_issue"
      ? knownIssueStatusAction("duplicate", artifact.investigationId)
      : { kind: "none" as const, requiresApproval: false };
  return buildEvent({
    context,
    artifact,
    sourceEventId: artifact.investigationId,
    eventType: "engineering_investigation_started",
    occurredAt: artifact.createdAt,
    summary: [
      "Engineering investigation recorded",
      artifact.status,
      artifact.suggestedNextAction,
      artifact.recommendedAction
    ],
    evidence: evidenceRef(
      "engineering_artifact",
      artifact,
      artifact.investigationId,
      artifact.artifactPath
    ),
    proposedKnowledgeAction: knownIssueAction,
    metadata: {
      investigation_status: artifact.status,
      source_report_file: artifact.sourceReportFile,
      engineering_ready: artifact.engineeringReady,
      pr_candidate: artifact.prCandidate
    }
  });
}

function eventFromEngineeringAutoRun(
  artifact: AdminSupportEngineeringAutoRunArtifact,
  context: ExportContext
): RagSupportEvent {
  return buildEvent({
    context,
    artifact,
    sourceEventId: artifact.autoRunId,
    eventType: "engineering_status_changed",
    occurredAt: artifact.createdAt,
    ...(artifact.actor === undefined ? {} : { actor: artifact.actor }),
    summary: ["Engineering auto-run status changed", artifact.status, artifact.outcomeSummary],
    evidence: evidenceRef(
      "engineering_artifact",
      artifact,
      artifact.autoRunId,
      artifact.artifactPath
    ),
    proposedKnowledgeAction: engineeringAutoRunKnowledgeAction(artifact),
    metadata: {
      auto_run_status: artifact.status,
      tool_actions_requested: artifact.toolActionsRequested,
      tool_actions_performed: artifact.toolActionsPerformed,
      final_review_required: artifact.finalReviewRequired
    }
  });
}

function buildEvent(input: {
  readonly context: ExportContext;
  readonly artifact: AdminSupportRunTraceRef;
  readonly sourceEventId: string;
  readonly eventType: BuildRagSupportEventInput["eventType"];
  readonly occurredAt: string;
  readonly actor?: string;
  readonly summary: readonly (string | undefined | null | boolean)[];
  readonly evidence: RagSupportEvidenceRef;
  readonly proposedKnowledgeAction: AdminSupportProposedKnowledgeAction;
  readonly metadata: Readonly<Record<string, string | number | boolean | null | undefined>>;
}): RagSupportEvent {
  const resolvedProfileId = profileId(input.artifact, input.context);
  const resolvedNamespaceId = namespaceId(input.artifact, input.context);

  return buildRagSupportEvent({
    sourceSystem: "admin_support",
    sourceEventId: input.sourceEventId,
    sourceTicketId: sourceTicketId(input.artifact),
    runId: input.artifact.runId,
    traceId: input.artifact.traceId,
    ...(resolvedProfileId === undefined ? {} : { profileId: resolvedProfileId }),
    ...(resolvedNamespaceId === undefined ? {} : { namespaceId: resolvedNamespaceId }),
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    observedAt: input.context.generatedAt,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    summary: sentence(input.summary),
    evidenceRefs: [input.evidence],
    proposedKnowledgeAction: input.proposedKnowledgeAction,
    metadata: input.metadata
  });
}

function evidenceRef(
  kind: RagSupportEvidenceRef["kind"],
  artifact: AdminSupportRunTraceRef,
  refId: string,
  artifactPath: string | undefined
): RagSupportEvidenceRef {
  return {
    refId,
    kind,
    sourceSystem: "admin_support",
    ...(artifactPath === undefined ? {} : { artifactPath }),
    ticketId: sourceTicketId(artifact),
    runId: artifact.runId,
    traceId: artifact.traceId,
    sensitivity: kind === "ticket" || kind === "trace" ? "internal_only" : "engineering_only",
    customerSafe: false
  };
}

function reviewKnowledgeAction(
  artifact: AdminSupportHumanReviewArtifact
): AdminSupportProposedKnowledgeAction {
  if (artifact.falseDeflection === true) {
    return {
      kind: "eval_case",
      title: "False deflection regression candidate",
      summary: "A human review marked this ticket as a false deflection.",
      requiresApproval: true,
      approverDestination: "human_support"
    };
  }
  if (
    artifact.correctedIssueType ||
    artifact.correctedSeverity ||
    artifact.correctedAffectedArea ||
    artifact.correctedEscalationRequired !== undefined ||
    artifact.correctedEscalationTarget
  ) {
    return {
      kind: "eval_case",
      title: "Human correction regression candidate",
      summary: "A human corrected labels or escalation, so this ticket may need eval coverage.",
      requiresApproval: true,
      approverDestination: "human_support"
    };
  }
  return { kind: "none", requiresApproval: false };
}

function engineeringAutoRunKnowledgeAction(
  artifact: AdminSupportEngineeringAutoRunArtifact
): AdminSupportProposedKnowledgeAction {
  if (artifact.status === "patch_ready_for_review") {
    return knownIssueStatusAction("in_progress", artifact.autoRunId);
  }
  if (
    artifact.status === "blocked" ||
    artifact.status === "fix_cannot_reproduce" ||
    artifact.status === "fix_unsafe_to_change"
  ) {
    return {
      kind: "known_issue_status_update",
      targetId: artifact.autoRunId,
      knownIssueStatus: "blocked",
      title: "Known issue blocked status candidate",
      summary: "Engineering could not safely complete the fix path.",
      proposedWording:
        "We're still investigating this and need more review before promising a fix.",
      requiresApproval: true,
      approverDestination: "engineering"
    };
  }
  return { kind: "none", requiresApproval: false };
}

function knownIssueStatusAction(
  status: RagKnownIssueStatus,
  targetId: string
): AdminSupportProposedKnowledgeAction {
  return {
    kind: "known_issue_status_update" satisfies RagSupportKnowledgeActionKind,
    targetId,
    knownIssueStatus: status,
    title: `Known issue ${status} status candidate`,
    summary: "Review linked support and engineering artifacts before changing known-issue status.",
    proposedWording: knownIssueWording(status),
    requiresApproval: true,
    approverDestination: "engineering"
  };
}

function knownIssueWording(status: RagKnownIssueStatus): string {
  if (status === "candidate") return "We're checking whether this matches other reports.";
  if (status === "confirmed") return "We're aware of this issue.";
  if (status === "in_progress") return "We're investigating a fix.";
  if (status === "fixed") return "This was fixed in the linked version.";
  if (status === "verified") return "This has been verified as resolved.";
  return "This issue needs human review before we can make a customer-facing claim.";
}

function sourceTicketId(artifact: AdminSupportRunTraceRef): string {
  return artifact.sourceTicketId ?? `ticket_${artifact.traceId || artifact.runId}`;
}

function profileId(artifact: AdminSupportRunTraceRef, context: ExportContext): string | undefined {
  return artifact.profileId ?? context.defaultProfileId ?? profileIdFromPath(artifact.profilePath);
}

function namespaceId(
  artifact: AdminSupportRunTraceRef,
  context: ExportContext
): string | undefined {
  return artifact.namespaceId ?? context.defaultNamespaceId;
}

function profileIdFromPath(profilePath: string | undefined): string | undefined {
  if (!profilePath) return undefined;
  const fileName = profilePath.split(/[\\/]/u).filter(Boolean).pop();
  return fileName?.replace(/\.profile\.json$/u, "").replace(/\.json$/u, "");
}

function routeLabel(route: AdminSupportRouteSnapshot | null | undefined): string | undefined {
  if (!route) return undefined;
  return [
    route.queueId ?? route.queueName,
    route.departmentId ?? route.departmentName,
    route.priority
  ]
    .filter(Boolean)
    .join("/");
}

function sentence(parts: readonly (string | undefined | null | boolean)[]): string {
  const text = parts
    .filter((part): part is string | boolean => part !== undefined && part !== null && part !== "")
    .map((part) => String(part))
    .join(" ");
  return text || "Admin support event exported.";
}

function safeTimestamp(value: string): string {
  return value.replace(/[^0-9a-z]+/giu, "_").replace(/^_+|_+$/gu, "");
}
