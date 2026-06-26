import {
  buildRagSupportKnowledgeApprovalLedger,
  type RagSupportKnowledgeApprovalDecisionInput,
  type RagSupportKnowledgeApprovalLedger
} from "./approval-ledger.js";
import {
  buildRagSupportAutoApprovalDecisions,
  type RagSupportAutoApprovalPolicyInput,
  type RagSupportAutoApprovalResult
} from "./auto-approval.js";
import {
  buildRagSupportEventIdempotencyLedger,
  type RagSupportEventIdempotencyLedger,
  type RagSupportEventLedgerEntry
} from "./idempotency-ledger.js";
import {
  buildRagSupportKnowledgeCandidateQueue,
  type RagSupportKnowledgeCandidateQueue
} from "./knowledge-candidate-queue.js";
import type { RagSupportEvent } from "./support-event.js";

export const RAG_SUPPORT_KNOWLEDGE_FLOW_SCHEMA_VERSION = 1;
export const RAG_SUPPORT_APPROVED_KNOWLEDGE_SOURCES_SCHEMA_VERSION = 1;
export const RAG_SUPPORT_APPROVED_KNOWLEDGE_ENV_VAR = "RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH";

export type RagSupportKnowledgeFlowStatus =
  | "blocked"
  | "ready_for_ingestion"
  | "awaiting_approval"
  | "no_changes";

export type RagSupportKnowledgeFlowMetadata = Readonly<Record<string, string | number | boolean>>;

export interface RagSupportApprovedKnowledgeAccessScopeConfig {
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly teamIds?: readonly string[];
  readonly userIds?: readonly string[];
  readonly roles?: readonly string[];
  readonly tags?: readonly string[];
}

export interface RagSupportApprovedKnowledgeSourceConfigInput {
  readonly enabled?: boolean;
  readonly approvalLedgerPath?: string;
  readonly pathPrefix?: string;
  readonly originUriBase?: string;
  readonly owner?: string;
  readonly accessScope?: RagSupportApprovedKnowledgeAccessScopeConfig;
  readonly capturedAt?: string;
  readonly maxArtifacts?: number;
  readonly metadata?: RagSupportKnowledgeFlowMetadata;
}

export interface RagSupportApprovedKnowledgeSourceConfig {
  readonly sourceId: string;
  readonly ledgerPaths: readonly string[];
  readonly artifactIds: readonly string[];
  readonly pathPrefix: string;
  readonly originUriBase?: string;
  readonly owner?: string;
  readonly accessScope?: RagSupportApprovedKnowledgeAccessScopeConfig;
  readonly capturedAt?: string;
  readonly maxArtifacts?: number;
  readonly metadata: RagSupportKnowledgeFlowMetadata;
}

export interface RagSupportApprovedKnowledgeSourcesConfig {
  readonly schemaVersion: typeof RAG_SUPPORT_APPROVED_KNOWLEDGE_SOURCES_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly sources: readonly RagSupportApprovedKnowledgeSourceConfig[];
  readonly evidenceBoundary: readonly string[];
}

export interface RagSupportKnowledgeFlowInput {
  readonly flowId?: string;
  readonly generatedAt?: string;
  readonly events: readonly RagSupportEvent[];
  readonly previousEventLedger?: RagSupportEventIdempotencyLedger;
  readonly previousCandidateQueue?: RagSupportKnowledgeCandidateQueue;
  readonly approvalDecisions?: readonly RagSupportKnowledgeApprovalDecisionInput[];
  readonly autoApprovalPolicy?: RagSupportAutoApprovalPolicyInput;
  readonly defaultReviewerDestination?: string;
  readonly approvedKnowledgeSourceConfig?: RagSupportApprovedKnowledgeSourceConfigInput;
}

export interface RagSupportKnowledgeFlowMetrics {
  readonly eventCount: number;
  readonly ledgerEntryCount: number;
  readonly processableEventCount: number;
  readonly duplicateEventCount: number;
  readonly conflictEventCount: number;
  readonly candidateCount: number;
  readonly pendingCandidateCount: number;
  readonly rejectedEventCount: number;
  readonly decisionCount: number;
  readonly autoApprovalDecisionCount: number;
  readonly invalidDecisionCount: number;
  readonly approvedArtifactCount: number;
  readonly approvedKnowledgeSourceCount: number;
}

export interface RagSupportKnowledgeFlowIngestionReadiness {
  readonly answerableNow: false;
  readonly requiredNextGate: "production_ingestion";
  readonly envVar: typeof RAG_SUPPORT_APPROVED_KNOWLEDGE_ENV_VAR;
  readonly approvalLedgerPath: string;
  readonly approvedArtifactCount: number;
  readonly approvedKnowledgeSourceCount: number;
  readonly approvedKnowledgeSourceConfigEmitted: boolean;
  readonly reason: string;
}

export interface RagSupportKnowledgeFlowResult {
  readonly schemaVersion: typeof RAG_SUPPORT_KNOWLEDGE_FLOW_SCHEMA_VERSION;
  readonly flowId: string;
  readonly generatedAt: string;
  readonly status: RagSupportKnowledgeFlowStatus;
  readonly eventLedger: RagSupportEventIdempotencyLedger;
  readonly candidateQueue: RagSupportKnowledgeCandidateQueue;
  readonly autoApproval: RagSupportAutoApprovalResult;
  readonly approvalLedger: RagSupportKnowledgeApprovalLedger;
  readonly approvedKnowledgeSourcesConfig: RagSupportApprovedKnowledgeSourcesConfig;
  readonly metrics: RagSupportKnowledgeFlowMetrics;
  readonly ingestionReadiness: RagSupportKnowledgeFlowIngestionReadiness;
  readonly evidenceBoundary: readonly string[];
}

export function runRagSupportKnowledgeFlow(
  input: RagSupportKnowledgeFlowInput
): RagSupportKnowledgeFlowResult {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const flowId = input.flowId ?? `rag_support_knowledge_flow_${safeTimestamp(generatedAt)}`;
  const initialEventLedger = buildRagSupportEventIdempotencyLedger({
    ledgerId: `${flowId}_event_ledger`,
    generatedAt,
    events: input.events,
    ...(input.previousEventLedger === undefined
      ? {}
      : { previousLedger: input.previousEventLedger })
  });
  const candidateQueue = buildRagSupportKnowledgeCandidateQueue({
    queueId: `${flowId}_candidate_queue`,
    generatedAt,
    events: input.events,
    ledger: initialEventLedger,
    ...(input.previousCandidateQueue === undefined
      ? {}
      : { previousQueue: input.previousCandidateQueue }),
    ...(input.defaultReviewerDestination === undefined
      ? {}
      : { defaultReviewerDestination: input.defaultReviewerDestination })
  });
  const explicitApprovalDecisions = input.approvalDecisions ?? [];
  const autoApproval = buildRagSupportAutoApprovalDecisions({
    generatedAt,
    queue: candidateQueue,
    ...(input.autoApprovalPolicy === undefined ? {} : { policy: input.autoApprovalPolicy }),
    explicitlyDecidedCandidateIds: explicitApprovalDecisions.map((decision) => decision.candidateId)
  });
  const approvalDecisions = [...explicitApprovalDecisions, ...autoApproval.decisions];
  const approvalLedger = buildRagSupportKnowledgeApprovalLedger({
    ledgerId: `${flowId}_approval_ledger`,
    generatedAt,
    queue: candidateQueue,
    decisions: approvalDecisions
  });
  const eventLedger = linkEventLedgerOutputs(
    initialEventLedger,
    approvedArtifactIdsByEventId(approvalLedger)
  );
  const approvedKnowledgeSourcesConfig = approvedKnowledgeSourcesConfigFromApprovalLedger({
    flowId,
    generatedAt,
    approvalLedger,
    sourceConfig: input.approvedKnowledgeSourceConfig
  });
  const metrics = flowMetrics({
    eventCount: input.events.length,
    eventLedger,
    candidateQueue,
    autoApproval,
    approvalLedger,
    approvedKnowledgeSourcesConfig
  });
  const ingestionReadiness = flowIngestionReadiness({
    metrics,
    sourceConfig: input.approvedKnowledgeSourceConfig
  });

  return {
    schemaVersion: RAG_SUPPORT_KNOWLEDGE_FLOW_SCHEMA_VERSION,
    flowId,
    generatedAt,
    status: flowStatus(eventLedger, candidateQueue, metrics),
    eventLedger,
    candidateQueue,
    autoApproval,
    approvalLedger,
    approvedKnowledgeSourcesConfig,
    metrics,
    ingestionReadiness,
    evidenceBoundary: ragSupportKnowledgeFlowEvidenceBoundary()
  };
}

export function ragSupportKnowledgeFlowEvidenceBoundary(): readonly string[] {
  return [
    "Includes support event ledger entries, idempotency keys, candidate ids, approval decisions, approved artifact ids, source ids, ledger path references, metrics, and safe operator summaries.",
    "Excludes raw admin ticket payloads, raw customer messages, raw diagnostics, raw generated answers, rendered prompts, source bodies, secrets, routing keys, full principal claims, and raw reviewer identifiers.",
    "The emitted approved knowledge source config is not answerable knowledge; it is only an input to the separate production ingestion gate named by RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH."
  ];
}

export function ragSupportApprovedKnowledgeSourcesEvidenceBoundary(): readonly string[] {
  return [
    "Includes approved artifact ids, approval ledger paths, profile source ids, safe access-scope defaults, deployment metadata, and source-level adapter hints.",
    "Excludes raw tickets, raw candidates, raw support events, raw model outputs, raw reviewer identifiers, source bodies, credentials, routing secrets, and full principal claims.",
    "Production ingestion must still read the referenced approval ledger, verify approvedArtifacts, enforce source id matches, body hashes, trust floors, access controls, chunking, and index admission."
  ];
}

export function renderRagSupportKnowledgeFlowMarkdown(
  result: RagSupportKnowledgeFlowResult
): string {
  return [
    "# Support Knowledge Flow",
    "",
    `- Flow ID: \`${md(result.flowId)}\``,
    `- Generated: \`${md(result.generatedAt)}\``,
    `- Status: **${md(result.status)}**`,
    `- Runtime answerable now: **${result.ingestionReadiness.answerableNow ? "yes" : "no"}**`,
    `- Next gate: \`${md(result.ingestionReadiness.requiredNextGate)}\` via \`${md(
      result.ingestionReadiness.envVar
    )}\``,
    "",
    "## Metrics",
    "",
    `- Events: ${result.metrics.eventCount}`,
    `- Processable events: ${result.metrics.processableEventCount}`,
    `- Duplicate events: ${result.metrics.duplicateEventCount}`,
    `- Conflict events: ${result.metrics.conflictEventCount}`,
    `- Candidates: ${result.metrics.candidateCount}`,
    `- Pending candidates: ${result.metrics.pendingCandidateCount}`,
    `- Decisions: ${result.metrics.decisionCount}`,
    `- Auto approval decisions: ${result.metrics.autoApprovalDecisionCount}`,
    `- Invalid decisions: ${result.metrics.invalidDecisionCount}`,
    `- Approved artifacts: ${result.metrics.approvedArtifactCount}`,
    `- Approved knowledge sources: ${result.metrics.approvedKnowledgeSourceCount}`,
    "",
    "## Ingestion Readiness",
    "",
    md(result.ingestionReadiness.reason),
    "",
    "## Approved Knowledge Sources",
    "",
    sourceTable(result.approvedKnowledgeSourcesConfig.sources),
    "",
    "## Evidence Boundary",
    "",
    result.evidenceBoundary.map((entry) => `- ${md(entry)}`).join("\n"),
    ""
  ].join("\n");
}

function approvedKnowledgeSourcesConfigFromApprovalLedger(input: {
  readonly flowId: string;
  readonly generatedAt: string;
  readonly approvalLedger: RagSupportKnowledgeApprovalLedger;
  readonly sourceConfig: RagSupportApprovedKnowledgeSourceConfigInput | undefined;
}): RagSupportApprovedKnowledgeSourcesConfig {
  const enabled = input.sourceConfig?.enabled ?? true;
  const ledgerPath = input.sourceConfig?.approvalLedgerPath ?? "approval-ledger.json";
  const pathPrefix = input.sourceConfig?.pathPrefix ?? "approved-knowledge";
  const sourcesById = new Map<string, string[]>();

  if (enabled) {
    for (const artifact of input.approvalLedger.approvedArtifacts) {
      const existing = sourcesById.get(artifact.ingestionHint.sourceId) ?? [];
      sourcesById.set(artifact.ingestionHint.sourceId, [...existing, artifact.artifactId]);
    }
  }

  const sources = [...sourcesById.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceId, artifactIds]) => {
      const metadata = {
        ...safeMetadata(input.sourceConfig?.metadata ?? {}),
        connector: "support-bridge",
        supportKnowledgeFlowId: input.flowId,
        supportApprovalLedgerId: input.approvalLedger.ledgerId
      } satisfies RagSupportKnowledgeFlowMetadata;

      return {
        sourceId,
        ledgerPaths: [ledgerPath],
        artifactIds: uniqueSorted(artifactIds),
        pathPrefix,
        ...(input.sourceConfig?.originUriBase === undefined
          ? {}
          : { originUriBase: input.sourceConfig.originUriBase }),
        ...(input.sourceConfig?.owner === undefined ? {} : { owner: input.sourceConfig.owner }),
        ...(input.sourceConfig?.accessScope === undefined
          ? {}
          : { accessScope: input.sourceConfig.accessScope }),
        ...(input.sourceConfig?.capturedAt === undefined
          ? {}
          : { capturedAt: input.sourceConfig.capturedAt }),
        ...(input.sourceConfig?.maxArtifacts === undefined
          ? {}
          : { maxArtifacts: input.sourceConfig.maxArtifacts }),
        metadata
      } satisfies RagSupportApprovedKnowledgeSourceConfig;
    });

  return {
    schemaVersion: RAG_SUPPORT_APPROVED_KNOWLEDGE_SOURCES_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    sources,
    evidenceBoundary: ragSupportApprovedKnowledgeSourcesEvidenceBoundary()
  };
}

function approvedArtifactIdsByEventId(
  approvalLedger: RagSupportKnowledgeApprovalLedger
): ReadonlyMap<string, readonly string[]> {
  const idsByEventId = new Map<string, string[]>();

  for (const artifact of approvalLedger.approvedArtifacts) {
    for (const eventId of artifact.sourceEventIds) {
      const existing = idsByEventId.get(eventId) ?? [];
      idsByEventId.set(eventId, [...existing, artifact.artifactId]);
    }
  }

  return new Map(
    [...idsByEventId.entries()].map(([eventId, artifactIds]) => [
      eventId,
      uniqueSorted(artifactIds)
    ])
  );
}

function linkEventLedgerOutputs(
  ledger: RagSupportEventIdempotencyLedger,
  outputArtifactIdsByEventId: ReadonlyMap<string, readonly string[]>
): RagSupportEventIdempotencyLedger {
  if (outputArtifactIdsByEventId.size === 0) {
    return ledger;
  }

  const entries = ledger.entries.map((entry) => linkedEntry(entry, outputArtifactIdsByEventId));

  return {
    ...ledger,
    entries
  };
}

function linkedEntry(
  entry: RagSupportEventLedgerEntry,
  outputArtifactIdsByEventId: ReadonlyMap<string, readonly string[]>
): RagSupportEventLedgerEntry {
  const artifactIds = outputArtifactIdsByEventId.get(entry.eventId);
  if (artifactIds === undefined || artifactIds.length === 0) {
    return entry;
  }

  return {
    ...entry,
    outputArtifactIds: uniqueSorted([...entry.outputArtifactIds, ...artifactIds])
  };
}

function flowMetrics(input: {
  readonly eventCount: number;
  readonly eventLedger: RagSupportEventIdempotencyLedger;
  readonly candidateQueue: RagSupportKnowledgeCandidateQueue;
  readonly autoApproval: RagSupportAutoApprovalResult;
  readonly approvalLedger: RagSupportKnowledgeApprovalLedger;
  readonly approvedKnowledgeSourcesConfig: RagSupportApprovedKnowledgeSourcesConfig;
}): RagSupportKnowledgeFlowMetrics {
  return {
    eventCount: input.eventCount,
    ledgerEntryCount: input.eventLedger.metrics.entryCount,
    processableEventCount: input.eventLedger.metrics.processableCount,
    duplicateEventCount: input.eventLedger.metrics.duplicateCount,
    conflictEventCount: input.eventLedger.metrics.conflictCount,
    candidateCount: input.candidateQueue.metrics.candidateCount,
    pendingCandidateCount: unresolvedPendingCandidateCount(
      input.candidateQueue,
      input.approvalLedger
    ),
    rejectedEventCount: input.candidateQueue.metrics.rejectedEventCount,
    decisionCount: input.approvalLedger.metrics.decisionCount,
    autoApprovalDecisionCount: input.autoApproval.metrics.decisionCount,
    invalidDecisionCount: input.approvalLedger.metrics.invalidDecisionCount,
    approvedArtifactCount: input.approvalLedger.metrics.approvedArtifactCount,
    approvedKnowledgeSourceCount: input.approvedKnowledgeSourcesConfig.sources.length
  };
}

function flowIngestionReadiness(input: {
  readonly metrics: RagSupportKnowledgeFlowMetrics;
  readonly sourceConfig: RagSupportApprovedKnowledgeSourceConfigInput | undefined;
}): RagSupportKnowledgeFlowIngestionReadiness {
  const approvalLedgerPath = input.sourceConfig?.approvalLedgerPath ?? "approval-ledger.json";
  const sourceConfigEnabled = input.sourceConfig?.enabled ?? true;
  const sourceConfigEmitted =
    sourceConfigEnabled &&
    input.metrics.approvedArtifactCount > 0 &&
    input.metrics.approvedKnowledgeSourceCount > 0;

  return {
    answerableNow: false,
    requiredNextGate: "production_ingestion",
    envVar: RAG_SUPPORT_APPROVED_KNOWLEDGE_ENV_VAR,
    approvalLedgerPath,
    approvedArtifactCount: input.metrics.approvedArtifactCount,
    approvedKnowledgeSourceCount: input.metrics.approvedKnowledgeSourceCount,
    approvedKnowledgeSourceConfigEmitted: sourceConfigEmitted,
    reason: sourceConfigEmitted
      ? "Approved artifacts are ready to be handed to production ingestion, but they are not answerable until ingestion, chunking, access checks, and indexing complete."
      : "No approved knowledge source config was emitted because there are no approved artifacts or the source config output is disabled."
  };
}

function flowStatus(
  eventLedger: RagSupportEventIdempotencyLedger,
  candidateQueue: RagSupportKnowledgeCandidateQueue,
  metrics: RagSupportKnowledgeFlowMetrics
): RagSupportKnowledgeFlowStatus {
  if (eventLedger.status === "failed" || candidateQueue.status === "blocked") {
    return "blocked";
  }
  if (metrics.approvedArtifactCount > 0) {
    return "ready_for_ingestion";
  }
  if (metrics.pendingCandidateCount > 0) {
    return "awaiting_approval";
  }
  return "no_changes";
}

function unresolvedPendingCandidateCount(
  candidateQueue: RagSupportKnowledgeCandidateQueue,
  approvalLedger: RagSupportKnowledgeApprovalLedger
): number {
  const decidedCandidateIds = new Set(
    approvalLedger.decisions.map((decision) => decision.candidateId)
  );

  return candidateQueue.candidates.filter(
    (candidate) =>
      candidate.status === "pending_review" && !decidedCandidateIds.has(candidate.candidateId)
  ).length;
}

function sourceTable(sources: readonly RagSupportApprovedKnowledgeSourceConfig[]): string {
  if (sources.length === 0) {
    return "_No approved knowledge source config emitted._";
  }

  return [
    "| Source | Ledger Paths | Artifact IDs |",
    "| --- | --- | --- |",
    ...sources.map(
      (source) =>
        `| \`${md(source.sourceId)}\` | ${source.ledgerPaths
          .map((entry) => `\`${md(entry)}\``)
          .join(", ")} | ${source.artifactIds.map((entry) => `\`${md(entry)}\``).join(", ")} |`
    )
  ].join("\n");
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))
  ].sort();
}

function safeTimestamp(value: string): string {
  return value.replace(/[^0-9A-Za-z]+/g, "_").replace(/^_+|_+$/g, "");
}

function safeMetadata(metadata: RagSupportKnowledgeFlowMetadata): RagSupportKnowledgeFlowMetadata {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
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

function md(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/`/g, "'");
}
