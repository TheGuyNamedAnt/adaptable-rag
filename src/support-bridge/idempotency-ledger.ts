import type { RagSupportEvent, RagSupportEventType } from "./support-event.js";

export const RAG_SUPPORT_EVENT_IDEMPOTENCY_LEDGER_SCHEMA_VERSION = 1;

export type RagSupportEventLedgerStatus = "passed" | "needs_attention" | "failed";
export type RagSupportEventLedgerEntryStatus = "processable" | "duplicate" | "conflict";

export interface RagSupportEventLedgerEntry {
  readonly idempotencyKey: string;
  readonly eventId: string;
  readonly sourceSystem: RagSupportEvent["sourceSystem"];
  readonly sourceTicketId?: string;
  readonly runId?: string;
  readonly traceId?: string;
  readonly profileId?: string;
  readonly eventType: RagSupportEventType;
  readonly eventVersion: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly occurrenceCount: number;
  readonly payloadHash: string;
  readonly status: RagSupportEventLedgerEntryStatus;
  readonly outputArtifactIds: readonly string[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

export interface RagSupportEventIdempotencyLedgerMetrics {
  readonly entryCount: number;
  readonly processableCount: number;
  readonly duplicateCount: number;
  readonly conflictCount: number;
  readonly occurrenceCount: number;
}

export interface RagSupportEventIdempotencyLedger {
  readonly schemaVersion: typeof RAG_SUPPORT_EVENT_IDEMPOTENCY_LEDGER_SCHEMA_VERSION;
  readonly ledgerId: string;
  readonly generatedAt: string;
  readonly status: RagSupportEventLedgerStatus;
  readonly entries: readonly RagSupportEventLedgerEntry[];
  readonly processableEventIds: readonly string[];
  readonly duplicateEventIds: readonly string[];
  readonly conflictEventIds: readonly string[];
  readonly metrics: RagSupportEventIdempotencyLedgerMetrics;
  readonly evidenceBoundary: readonly string[];
}

export interface BuildRagSupportEventIdempotencyLedgerInput {
  readonly ledgerId?: string;
  readonly generatedAt?: string;
  readonly events: readonly RagSupportEvent[];
  readonly previousLedger?: RagSupportEventIdempotencyLedger;
  readonly outputArtifactIdsByEventId?: Readonly<Record<string, readonly string[]>>;
}

export function buildRagSupportEventIdempotencyLedger(
  input: BuildRagSupportEventIdempotencyLedgerInput
): RagSupportEventIdempotencyLedger {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const ledgerId = input.ledgerId ?? `rag_support_event_ledger_${safeTimestamp(generatedAt)}`;
  const previousByKey = new Map(
    (input.previousLedger?.entries ?? []).map((entry) => [entry.idempotencyKey, entry])
  );
  const currentByKey = new Map<string, RagSupportEventLedgerEntry>();
  const processableEventIds: string[] = [];
  const duplicateEventIds: string[] = [];
  const conflictEventIds: string[] = [];

  for (const event of input.events) {
    const previous =
      currentByKey.get(event.idempotencyKey) ?? previousByKey.get(event.idempotencyKey);
    const outputArtifactIds = input.outputArtifactIdsByEventId?.[event.eventId] ?? [];

    if (!previous) {
      currentByKey.set(
        event.idempotencyKey,
        entryFromEvent({
          event,
          generatedAt,
          outputArtifactIds,
          status: "processable",
          occurrenceCount: 1,
          warnings: [],
          errors: []
        })
      );
      processableEventIds.push(event.eventId);
      continue;
    }

    if (previous.payloadHash === event.payloadHash) {
      currentByKey.set(
        event.idempotencyKey,
        mergeDuplicate(previous, event, generatedAt, outputArtifactIds)
      );
      duplicateEventIds.push(event.eventId);
      continue;
    }

    currentByKey.set(event.idempotencyKey, mergeConflict(previous, event, generatedAt));
    conflictEventIds.push(event.eventId);
  }

  for (const previous of previousByKey.values()) {
    if (!currentByKey.has(previous.idempotencyKey)) {
      currentByKey.set(previous.idempotencyKey, previous);
    }
  }

  const entries = [...currentByKey.values()].sort((left, right) =>
    left.idempotencyKey.localeCompare(right.idempotencyKey)
  );
  const metrics = ledgerMetrics(entries);
  const status = metrics.conflictCount > 0 ? "failed" : "passed";

  return {
    schemaVersion: RAG_SUPPORT_EVENT_IDEMPOTENCY_LEDGER_SCHEMA_VERSION,
    ledgerId,
    generatedAt,
    status,
    entries,
    processableEventIds,
    duplicateEventIds,
    conflictEventIds,
    metrics,
    evidenceBoundary: ragSupportEventIdempotencyLedgerEvidenceBoundary()
  };
}

export function ragSupportEventIdempotencyLedgerEvidenceBoundary(): readonly string[] {
  return [
    "Includes event ids, idempotency keys, source ticket ids, run ids, trace ids, event types, payload hashes, output artifact ids, duplicate/conflict status, and safe operational warnings.",
    "Excludes raw customer messages, raw diagnostics, raw generated answers, rendered prompts, source bodies, secrets, routing keys, and full principal claims.",
    "Only processable event ids should be promoted into knowledge candidates; duplicate and conflict event ids are audit evidence, not new work."
  ];
}

function entryFromEvent(input: {
  readonly event: RagSupportEvent;
  readonly generatedAt: string;
  readonly outputArtifactIds: readonly string[];
  readonly status: RagSupportEventLedgerEntryStatus;
  readonly occurrenceCount: number;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}): RagSupportEventLedgerEntry {
  return {
    idempotencyKey: input.event.idempotencyKey,
    eventId: input.event.eventId,
    sourceSystem: input.event.sourceSystem,
    ...(input.event.sourceTicketId === undefined
      ? {}
      : { sourceTicketId: input.event.sourceTicketId }),
    ...(input.event.runId === undefined ? {} : { runId: input.event.runId }),
    ...(input.event.traceId === undefined ? {} : { traceId: input.event.traceId }),
    ...(input.event.profileId === undefined ? {} : { profileId: input.event.profileId }),
    eventType: input.event.eventType,
    eventVersion: input.event.eventVersion,
    firstSeenAt: input.generatedAt,
    lastSeenAt: input.generatedAt,
    occurrenceCount: input.occurrenceCount,
    payloadHash: input.event.payloadHash,
    status: input.status,
    outputArtifactIds: uniqueSorted(input.outputArtifactIds),
    warnings: input.warnings,
    errors: input.errors
  };
}

function mergeDuplicate(
  previous: RagSupportEventLedgerEntry,
  event: RagSupportEvent,
  generatedAt: string,
  outputArtifactIds: readonly string[]
): RagSupportEventLedgerEntry {
  return {
    ...previous,
    eventId: previous.eventId,
    lastSeenAt: generatedAt,
    occurrenceCount: previous.occurrenceCount + 1,
    status: previous.status === "conflict" ? "conflict" : "duplicate",
    outputArtifactIds: uniqueSorted([...previous.outputArtifactIds, ...outputArtifactIds]),
    warnings: uniqueSorted([
      ...previous.warnings,
      `Duplicate support event ${event.eventId} matched idempotency key ${event.idempotencyKey}.`
    ])
  };
}

function mergeConflict(
  previous: RagSupportEventLedgerEntry,
  event: RagSupportEvent,
  generatedAt: string
): RagSupportEventLedgerEntry {
  return {
    ...previous,
    lastSeenAt: generatedAt,
    occurrenceCount: previous.occurrenceCount + 1,
    status: "conflict",
    errors: uniqueSorted([
      ...previous.errors,
      `Conflicting support event ${event.eventId} reused idempotency key ${event.idempotencyKey} with a different payload hash.`
    ])
  };
}

function ledgerMetrics(
  entries: readonly RagSupportEventLedgerEntry[]
): RagSupportEventIdempotencyLedgerMetrics {
  return {
    entryCount: entries.length,
    processableCount: entries.filter((entry) => entry.status === "processable").length,
    duplicateCount: entries.filter((entry) => entry.status === "duplicate").length,
    conflictCount: entries.filter((entry) => entry.status === "conflict").length,
    occurrenceCount: entries.reduce((total, entry) => total + entry.occurrenceCount, 0)
  };
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function safeTimestamp(value: string): string {
  return value.replace(/[^0-9a-z]+/giu, "_").replace(/^_+|_+$/gu, "");
}
