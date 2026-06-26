import { hashStableValue } from "../shared/stable-hash.js";

export const RAG_SUPPORT_EVENT_SCHEMA_VERSION = 1;

export type RagSupportEventSourceSystem =
  | "admin_support"
  | "support_bot"
  | "rag_review"
  | "external_ticket"
  | "manual";

export type RagSupportEventType =
  | "ticket_triaged"
  | "human_review_saved"
  | "route_corrected"
  | "reply_approved"
  | "reply_delivery_preview_created"
  | "engineering_investigation_started"
  | "engineering_status_changed"
  | "known_issue_candidate_created"
  | "known_issue_confirmed"
  | "known_issue_status_changed"
  | "ticket_resolved"
  | "customer_confirmed_fix"
  | "eval_failure_action_reviewed"
  | "rag_review_decision_recorded"
  | "rag_feedback_signal_created";

export type RagKnownIssueStatus =
  | "candidate"
  | "confirmed"
  | "in_progress"
  | "fixed"
  | "verified"
  | "closed"
  | "rejected"
  | "duplicate"
  | "blocked";

export type RagSupportKnowledgeActionKind =
  | "none"
  | "known_issue_candidate"
  | "known_issue_status_update"
  | "support_policy_update"
  | "routing_rule_update"
  | "eval_case"
  | "customer_macro_update"
  | "corpus_doc_update";

export type RagSupportEvidenceKind =
  | "ticket"
  | "trace"
  | "review"
  | "route_correction"
  | "reply_approval"
  | "engineering_artifact"
  | "eval_result"
  | "knowledge_candidate"
  | "known_issue"
  | "config_change";

export type RagSupportEvidenceSensitivity =
  | "customer_safe"
  | "internal_only"
  | "engineering_only"
  | "restricted";

export interface RagSupportEvidenceRef {
  readonly refId: string;
  readonly kind: RagSupportEvidenceKind;
  readonly sourceSystem?: RagSupportEventSourceSystem;
  readonly artifactPath?: string;
  readonly ticketId?: string;
  readonly runId?: string;
  readonly traceId?: string;
  readonly reviewId?: string;
  readonly sensitivity: RagSupportEvidenceSensitivity;
  readonly customerSafe: boolean;
}

export interface RagSupportProposedKnowledgeAction {
  readonly kind: RagSupportKnowledgeActionKind;
  readonly actionId?: string;
  readonly targetId?: string;
  readonly knownIssueStatus?: RagKnownIssueStatus;
  readonly title?: string;
  readonly summary?: string;
  readonly proposedWording?: string;
  readonly requiresApproval: boolean;
  readonly approverDestination?: string;
}

export interface RagSupportEvent {
  readonly schemaVersion: typeof RAG_SUPPORT_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly sourceSystem: RagSupportEventSourceSystem;
  readonly sourceEventId?: string;
  readonly sourceTicketId?: string;
  readonly runId?: string;
  readonly traceId?: string;
  readonly profileId?: string;
  readonly namespaceId?: string;
  readonly eventType: RagSupportEventType;
  readonly eventVersion: string;
  readonly occurredAt: string;
  readonly observedAt: string;
  readonly actor?: string;
  readonly summary: string;
  readonly evidenceRefs: readonly RagSupportEvidenceRef[];
  readonly proposedKnowledgeAction: RagSupportProposedKnowledgeAction;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  readonly payloadHash: string;
  readonly evidenceBoundary: readonly string[];
}

export interface BuildRagSupportEventInput {
  readonly eventId?: string;
  readonly idempotencyKey?: string;
  readonly sourceSystem: RagSupportEventSourceSystem;
  readonly sourceEventId?: string;
  readonly sourceTicketId?: string;
  readonly runId?: string;
  readonly traceId?: string;
  readonly profileId?: string;
  readonly namespaceId?: string;
  readonly eventType: RagSupportEventType;
  readonly eventVersion?: string;
  readonly occurredAt: string;
  readonly observedAt?: string;
  readonly actor?: string;
  readonly summary: string;
  readonly evidenceRefs?: readonly RagSupportEvidenceRef[];
  readonly proposedKnowledgeAction?: Partial<RagSupportProposedKnowledgeAction>;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null | undefined>>;
}

export function buildRagSupportEvent(input: BuildRagSupportEventInput): RagSupportEvent {
  const observedAt = input.observedAt ?? input.occurredAt;
  const eventVersion = input.eventVersion ?? "v1";
  const idempotencyKey =
    input.idempotencyKey ??
    ragSupportEventIdempotencyKey({
      sourceSystem: input.sourceSystem,
      ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
      ...(input.sourceTicketId === undefined ? {} : { sourceTicketId: input.sourceTicketId }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      eventType: input.eventType,
      eventVersion
    });
  const eventId = input.eventId ?? `rag_support_event_${shortHash(idempotencyKey)}`;
  const eventWithoutHash = {
    schemaVersion: RAG_SUPPORT_EVENT_SCHEMA_VERSION,
    eventId: safeId(eventId),
    idempotencyKey,
    sourceSystem: input.sourceSystem,
    ...(input.sourceEventId === undefined ? {} : { sourceEventId: safeText(input.sourceEventId) }),
    ...(input.sourceTicketId === undefined
      ? {}
      : { sourceTicketId: safeText(input.sourceTicketId) }),
    ...(input.runId === undefined ? {} : { runId: safeText(input.runId) }),
    ...(input.traceId === undefined ? {} : { traceId: safeText(input.traceId) }),
    ...(input.profileId === undefined ? {} : { profileId: safeText(input.profileId) }),
    ...(input.namespaceId === undefined ? {} : { namespaceId: safeText(input.namespaceId) }),
    eventType: input.eventType,
    eventVersion: safeKeyPart(eventVersion),
    occurredAt: input.occurredAt,
    observedAt,
    ...(input.actor === undefined ? {} : { actor: safeText(input.actor) }),
    summary: safeText(input.summary),
    evidenceRefs: sanitizeEvidenceRefs(input.evidenceRefs ?? []),
    proposedKnowledgeAction: proposedKnowledgeAction(input.proposedKnowledgeAction),
    metadata: safeMetadata(input.metadata ?? {}),
    evidenceBoundary: ragSupportEventEvidenceBoundary()
  } satisfies Omit<RagSupportEvent, "payloadHash">;

  return {
    ...eventWithoutHash,
    payloadHash: `sha256:${hashStableValue(supportEventHashMaterial(eventWithoutHash))}`
  };
}

export function ragSupportEventIdempotencyKey(input: {
  readonly sourceSystem: RagSupportEventSourceSystem;
  readonly sourceEventId?: string;
  readonly sourceTicketId?: string;
  readonly runId?: string;
  readonly traceId?: string;
  readonly eventType: RagSupportEventType;
  readonly eventVersion?: string;
}): string {
  const traceSubject = [input.runId, input.traceId]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(":");
  const subject = (input.sourceEventId ?? input.sourceTicketId ?? traceSubject) || "unknown";

  return [
    "rag_support_event",
    input.sourceSystem,
    subject,
    input.eventType,
    input.eventVersion ?? "v1"
  ]
    .map(safeKeyPart)
    .join(":");
}

export function ragSupportEventEvidenceBoundary(): readonly string[] {
  return [
    "Includes stable ids, ticket ids, run ids, trace ids, profile ids, event types, safe summaries, artifact paths, sensitivity labels, proposed knowledge action metadata, and redacted operational metadata.",
    "Excludes raw customer messages, raw diagnostics, raw generated answers, rendered prompts, full source bodies, bearer tokens, API keys, passwords, routing secrets, and full principal claims.",
    "A support event is operational evidence only; it cannot be used as approved answer knowledge until a promotion gate writes an approved knowledge artifact."
  ];
}

function proposedKnowledgeAction(
  action: Partial<RagSupportProposedKnowledgeAction> | undefined
): RagSupportProposedKnowledgeAction {
  return {
    kind: action?.kind ?? "none",
    ...(action?.actionId === undefined ? {} : { actionId: safeId(action.actionId) }),
    ...(action?.targetId === undefined ? {} : { targetId: safeId(action.targetId) }),
    ...(action?.knownIssueStatus === undefined
      ? {}
      : { knownIssueStatus: action.knownIssueStatus }),
    ...(action?.title === undefined ? {} : { title: safeText(action.title) }),
    ...(action?.summary === undefined ? {} : { summary: safeText(action.summary) }),
    ...(action?.proposedWording === undefined
      ? {}
      : { proposedWording: safeText(action.proposedWording) }),
    requiresApproval:
      action?.requiresApproval ?? (action?.kind !== undefined && action.kind !== "none"),
    ...(action?.approverDestination === undefined
      ? {}
      : { approverDestination: safeText(action.approverDestination) })
  };
}

function sanitizeEvidenceRefs(
  refs: readonly RagSupportEvidenceRef[]
): readonly RagSupportEvidenceRef[] {
  return refs.map((ref) => ({
    refId: safeId(ref.refId),
    kind: ref.kind,
    ...(ref.sourceSystem === undefined ? {} : { sourceSystem: ref.sourceSystem }),
    ...(ref.artifactPath === undefined ? {} : { artifactPath: safePath(ref.artifactPath) }),
    ...(ref.ticketId === undefined ? {} : { ticketId: safeText(ref.ticketId) }),
    ...(ref.runId === undefined ? {} : { runId: safeText(ref.runId) }),
    ...(ref.traceId === undefined ? {} : { traceId: safeText(ref.traceId) }),
    ...(ref.reviewId === undefined ? {} : { reviewId: safeText(ref.reviewId) }),
    sensitivity: ref.sensitivity,
    customerSafe: ref.customerSafe
  }));
}

function safeMetadata(
  metadata: Readonly<Record<string, string | number | boolean | null | undefined>>
): Readonly<Record<string, string | number | boolean | null>> {
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        safeKeyPart(key),
        typeof value === "string" ? safeText(value) : (value ?? null)
      ])
  );
}

function safeId(value: string): string {
  return safeKeyPart(value) || "unknown";
}

function safePath(value: string): string {
  return safeText(value).replace(/\\/gu, "/");
}

function safeKeyPart(value: string): string {
  return safeText(value)
    .toLowerCase()
    .replace(/[^0-9a-z._:-]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function safeText(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "$1[REDACTED]"),
    value.replace(/\s+/gu, " ").trim()
  ).slice(0, 1000);
}

function shortHash(value: string): string {
  return hashStableValue(value).slice(0, 16);
}

function supportEventHashMaterial(event: Omit<RagSupportEvent, "payloadHash">): unknown {
  return {
    schemaVersion: event.schemaVersion,
    idempotencyKey: event.idempotencyKey,
    sourceSystem: event.sourceSystem,
    sourceEventId: event.sourceEventId,
    sourceTicketId: event.sourceTicketId,
    runId: event.runId,
    traceId: event.traceId,
    profileId: event.profileId,
    namespaceId: event.namespaceId,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    occurredAt: event.occurredAt,
    actor: event.actor,
    summary: event.summary,
    evidenceRefs: event.evidenceRefs,
    proposedKnowledgeAction: event.proposedKnowledgeAction,
    metadata: event.metadata
  };
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(bearer\s+)[a-z0-9._-]{8,}/giu,
  /\b(api[_-]?key\s*[:=]\s*)[^\s,;]+/giu,
  /\b(token\s*[:=]\s*)[^\s,;]+/giu,
  /\b(password\s*[:=]\s*)[^\s,;]+/giu
];
