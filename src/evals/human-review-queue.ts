import { summarizeRunTrace, type TraceSummary } from "../observability/trace-forensics.js";
import type { RagRunStatus } from "../observability/trace.js";
import type { RagProfile } from "../profiles/profile.js";
import type { RagAnswerResult } from "../runtime/runtime-types.js";
import type { RagIncidentBundle, RagIncidentSeverity } from "./incident-bundle.js";
import type { RagEvalCaseResult, RagEvalRunSummary, RagEvalSuiteResult } from "./eval-types.js";

export const RAG_HUMAN_REVIEW_QUEUE_SCHEMA_VERSION = 1;

export type RagHumanReviewQueueStatus = "empty" | "open";
export type RagHumanReviewItemStatus = "open" | "assigned" | "resolved" | "dismissed";
export type RagHumanReviewPriority = "low" | "medium" | "high" | "critical";
export type RagHumanReviewItemKind = "answer_review" | "failed_run_review" | "incident_review";

export interface RagHumanReviewAnswerInput {
  readonly id?: string;
  readonly source?: string;
  readonly artifactPath?: string;
  readonly assignedTo?: string;
  readonly slaHours?: number;
  readonly profile?: RagProfile;
  readonly result: RagAnswerResult;
}

export interface RagHumanReviewQueueInput {
  readonly queueId?: string;
  readonly generatedAt?: string;
  readonly profiles?: readonly RagProfile[];
  readonly evalSummary?: RagEvalRunSummary;
  readonly evalSummaryPath?: string;
  readonly answerResults?: readonly RagHumanReviewAnswerInput[];
  readonly incidentBundle?: RagIncidentBundle;
  readonly incidentBundlePath?: string;
  readonly includeRefusals?: boolean;
  readonly defaultSlaHours?: number;
}

export interface RagHumanReviewEscalationRoute {
  readonly ruleId: string;
  readonly description: string;
  readonly trigger: string;
  readonly destination: string;
}

export interface RagHumanReviewEvidence {
  readonly status?: RagRunStatus | string;
  readonly trace?: TraceSummary;
  readonly artifactPaths: readonly string[];
  readonly warningCodes: readonly string[];
  readonly failureStage?: string;
  readonly failureErrorName?: string;
  readonly contextEvidenceStatus?: string;
  readonly retrievalMode?: string;
  readonly citationCount?: number;
  readonly rejectedChunkCount?: number;
  readonly safetyFlagCount?: number;
  readonly incidentId?: string;
  readonly incidentStatus?: string;
  readonly incidentSeverity?: RagIncidentSeverity;
  readonly incidentFindingCount?: number;
}

export interface RagHumanReviewQueueItem {
  readonly itemId: string;
  readonly kind: RagHumanReviewItemKind;
  readonly status: RagHumanReviewItemStatus;
  readonly priority: RagHumanReviewPriority;
  readonly createdAt: string;
  readonly dueAt?: string;
  readonly source: string;
  readonly summary: string;
  readonly profileId?: string;
  readonly namespaceId?: string;
  readonly caseId?: string;
  readonly setKind?: string;
  readonly runId?: string;
  readonly traceId?: string;
  readonly answerId?: string;
  readonly generationId?: string;
  readonly incidentId?: string;
  readonly assignedTo?: string;
  readonly destinations: readonly string[];
  readonly escalationRules: readonly RagHumanReviewEscalationRoute[];
  readonly reasonCodes: readonly string[];
  readonly evidence: RagHumanReviewEvidence;
  readonly recommendedActions: readonly string[];
}

export interface RagHumanReviewQueueMetrics {
  readonly itemCount: number;
  readonly openItemCount: number;
  readonly criticalItemCount: number;
  readonly highItemCount: number;
  readonly mediumItemCount: number;
  readonly lowItemCount: number;
}

export interface RagHumanReviewQueue {
  readonly schemaVersion: typeof RAG_HUMAN_REVIEW_QUEUE_SCHEMA_VERSION;
  readonly queueId: string;
  readonly generatedAt: string;
  readonly status: RagHumanReviewQueueStatus;
  readonly summary: string;
  readonly metrics: RagHumanReviewQueueMetrics;
  readonly items: readonly RagHumanReviewQueueItem[];
  readonly evidenceBoundary: readonly string[];
}

export function buildHumanReviewQueue(input: RagHumanReviewQueueInput): RagHumanReviewQueue {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const queueId = input.queueId ?? `rag_review_queue_${safeTimestamp(generatedAt)}`;
  const profileById = new Map((input.profiles ?? []).map((profile) => [profile.id, profile]));
  const defaultSlaHours = input.defaultSlaHours ?? 24;
  const items = [
    ...itemsFromEvalSummary({
      evalSummary: input.evalSummary,
      evalSummaryPath: input.evalSummaryPath,
      profileById,
      generatedAt,
      includeRefusals: input.includeRefusals ?? false,
      defaultSlaHours
    }),
    ...itemsFromAnswerResults({
      answerResults: input.answerResults ?? [],
      generatedAt,
      includeRefusals: input.includeRefusals ?? false,
      defaultSlaHours
    }),
    ...itemsFromIncident({
      incidentBundle: input.incidentBundle,
      incidentBundlePath: input.incidentBundlePath,
      generatedAt,
      defaultSlaHours
    })
  ];
  const sortedItems = sortItems(dedupeItems(items));
  const metrics = queueMetrics(sortedItems);

  return {
    schemaVersion: RAG_HUMAN_REVIEW_QUEUE_SCHEMA_VERSION,
    queueId,
    generatedAt,
    status: sortedItems.length === 0 ? "empty" : "open",
    summary:
      sortedItems.length === 0
        ? "No human review or escalation items were produced by the supplied evidence."
        : `${sortedItems.length} human review item(s) need triage; ${metrics.criticalItemCount} critical and ${metrics.highItemCount} high priority.`,
    metrics,
    items: sortedItems,
    evidenceBoundary: [
      "Includes run ids, trace ids, profile ids, namespace ids, statuses, warning codes, counts, escalation destinations, artifact paths, and safe trace summaries.",
      "Excludes raw user questions, raw source bodies, rendered context, generated answer text, bearer tokens, API keys, routing keys, and full principal claims.",
      "Reviewers should open linked local artifacts for deeper inspection instead of copying prompts, source text, or answers into queue tickets."
    ]
  };
}

export function renderHumanReviewQueueMarkdown(queue: RagHumanReviewQueue): string {
  return [
    `# Human Review Queue`,
    "",
    `- Queue ID: \`${md(queue.queueId)}\``,
    `- Generated: \`${md(queue.generatedAt)}\``,
    `- Status: **${md(queue.status)}**`,
    "",
    "## Summary",
    "",
    md(queue.summary),
    "",
    "## Metrics",
    "",
    `- Items: ${queue.metrics.itemCount}`,
    `- Open: ${queue.metrics.openItemCount}`,
    `- Critical: ${queue.metrics.criticalItemCount}`,
    `- High: ${queue.metrics.highItemCount}`,
    `- Medium: ${queue.metrics.mediumItemCount}`,
    `- Low: ${queue.metrics.lowItemCount}`,
    "",
    "## Items",
    "",
    itemTable(queue),
    "",
    "## Item Details",
    "",
    itemDetails(queue),
    "",
    "## Evidence Boundary",
    "",
    queue.evidenceBoundary.map((entry) => `- ${md(entry)}`).join("\n"),
    ""
  ].join("\n");
}

function itemsFromEvalSummary(input: {
  readonly evalSummary: RagEvalRunSummary | undefined;
  readonly evalSummaryPath: string | undefined;
  readonly profileById: ReadonlyMap<string, RagProfile>;
  readonly generatedAt: string;
  readonly includeRefusals: boolean;
  readonly defaultSlaHours: number;
}): readonly RagHumanReviewQueueItem[] {
  if (!input.evalSummary) {
    return [];
  }

  return input.evalSummary.suites.flatMap((suite) =>
    suite.cases.flatMap((evalCase) =>
      itemFromEvalCase({
        suite,
        evalCase,
        profile: input.profileById.get(suite.profileId),
        evalSummaryPath: input.evalSummaryPath,
        generatedAt: input.generatedAt,
        includeRefusals: input.includeRefusals,
        defaultSlaHours: input.defaultSlaHours
      })
    )
  );
}

function itemFromEvalCase(input: {
  readonly suite: RagEvalSuiteResult;
  readonly evalCase: RagEvalCaseResult;
  readonly profile: RagProfile | undefined;
  readonly evalSummaryPath: string | undefined;
  readonly generatedAt: string;
  readonly includeRefusals: boolean;
  readonly defaultSlaHours: number;
}): readonly RagHumanReviewQueueItem[] {
  if (!shouldQueueEvalCase(input.evalCase, input.includeRefusals)) {
    return [];
  }

  const status = input.evalCase.status ?? (input.evalCase.passed ? "succeeded" : "eval_failed");
  const priority = priorityForStatus(status, !input.evalCase.passed);
  const routes = escalationRoutes(input.profile);
  const artifactPath =
    input.evalSummaryPath ?? artifactPathForEvalCase(input.suite, input.evalCase);
  const trace = input.evalCase.trace ? summarizeRunTrace(input.evalCase.trace) : undefined;
  const itemDueAt = dueAt(input.generatedAt, slaForPriority(priority, input.defaultSlaHours));

  return [
    {
      itemId: safeItemId("eval", input.suite.profileId, input.evalCase.id),
      kind: status === "human_review_required" ? "answer_review" : "failed_run_review",
      status: "open",
      priority,
      createdAt: input.generatedAt,
      ...(itemDueAt === undefined ? {} : { dueAt: itemDueAt }),
      source: "eval",
      summary: `Eval case ${input.evalCase.id} returned ${status}.`,
      profileId: input.suite.profileId,
      namespaceId: input.suite.namespaceId,
      caseId: input.evalCase.id,
      setKind: input.evalCase.setKind,
      ...(trace?.runId === undefined ? {} : { runId: trace.runId }),
      ...(trace?.traceId === undefined ? {} : { traceId: trace.traceId }),
      ...(trace?.answerId === undefined ? {} : { answerId: trace.answerId }),
      ...(trace?.generationId === undefined ? {} : { generationId: trace.generationId }),
      destinations: destinationsForRoutes(routes),
      escalationRules: routes,
      reasonCodes: evalReasonCodes(input.evalCase),
      evidence: {
        status,
        ...(trace === undefined ? {} : { trace }),
        artifactPaths: [artifactPath],
        warningCodes: [],
        ...(input.evalCase.contextStatus === undefined
          ? {}
          : { contextEvidenceStatus: input.evalCase.contextStatus }),
        ...(input.evalCase.retrievalMode === undefined
          ? {}
          : { retrievalMode: input.evalCase.retrievalMode }),
        citationCount: input.evalCase.finalCitationCount,
        rejectedChunkCount: trace?.rejectedChunkCount ?? 0,
        safetyFlagCount: trace?.safetyFlagCount ?? 0
      },
      recommendedActions: recommendedActionsForQueueItem({
        source: "eval",
        status,
        routes,
        artifactPath
      })
    }
  ];
}

function itemsFromAnswerResults(input: {
  readonly answerResults: readonly RagHumanReviewAnswerInput[];
  readonly generatedAt: string;
  readonly includeRefusals: boolean;
  readonly defaultSlaHours: number;
}): readonly RagHumanReviewQueueItem[] {
  return input.answerResults.flatMap((answerInput, index) =>
    itemFromAnswerResult({
      answerInput,
      fallbackId: `answer_${index + 1}`,
      generatedAt: input.generatedAt,
      includeRefusals: input.includeRefusals,
      defaultSlaHours: input.defaultSlaHours
    })
  );
}

function itemFromAnswerResult(input: {
  readonly answerInput: RagHumanReviewAnswerInput;
  readonly fallbackId: string;
  readonly generatedAt: string;
  readonly includeRefusals: boolean;
  readonly defaultSlaHours: number;
}): readonly RagHumanReviewQueueItem[] {
  const result = input.answerInput.result;
  if (!shouldQueueRunStatus(result.status, input.includeRefusals)) {
    return [];
  }

  const trace = summarizeRunTrace(result.trace);
  const priority = priorityForStatus(result.status, true);
  const routes = escalationRoutes(input.answerInput.profile);
  const artifactPaths = input.answerInput.artifactPath ? [input.answerInput.artifactPath] : [];
  const warningCodes = "generation" in result ? result.generation.trace.warningCodes : [];
  const failure = "failure" in result ? result.failure : undefined;
  const itemDueAt = dueAt(
    input.generatedAt,
    input.answerInput.slaHours ?? slaForPriority(priority, input.defaultSlaHours)
  );

  return [
    {
      itemId: safeItemId(
        "run",
        trace.profileId,
        input.answerInput.id ?? trace.traceId ?? input.fallbackId
      ),
      kind: result.status === "human_review_required" ? "answer_review" : "failed_run_review",
      status: "open",
      priority,
      createdAt: input.generatedAt,
      ...(itemDueAt === undefined ? {} : { dueAt: itemDueAt }),
      source: input.answerInput.source ?? "runtime",
      summary: `RAG run ${trace.traceId} returned ${result.status}.`,
      profileId: trace.profileId,
      namespaceId: trace.namespaceId,
      runId: trace.runId,
      traceId: trace.traceId,
      ...(trace.answerId === undefined ? {} : { answerId: trace.answerId }),
      ...(trace.generationId === undefined ? {} : { generationId: trace.generationId }),
      ...(input.answerInput.assignedTo === undefined
        ? {}
        : { assignedTo: input.answerInput.assignedTo }),
      destinations: destinationsForRoutes(routes),
      escalationRules: routes,
      reasonCodes: runReasonCodes(result.status, warningCodes, failure),
      evidence: {
        status: result.status,
        trace,
        artifactPaths,
        warningCodes,
        ...(failure === undefined
          ? {}
          : { failureStage: failure.stage, failureErrorName: failure.errorName }),
        ...("context" in result ? { contextEvidenceStatus: result.context.evidence.status } : {}),
        ...("retrieval" in result ? { retrievalMode: result.retrieval.trace.mode } : {}),
        citationCount: trace.finalCitationCount,
        rejectedChunkCount: trace.rejectedChunkCount,
        safetyFlagCount: trace.safetyFlagCount
      },
      recommendedActions: recommendedActionsForQueueItem({
        source: input.answerInput.source ?? "runtime",
        status: result.status,
        routes,
        ...(input.answerInput.artifactPath === undefined
          ? {}
          : { artifactPath: input.answerInput.artifactPath })
      })
    }
  ];
}

function itemsFromIncident(input: {
  readonly incidentBundle: RagIncidentBundle | undefined;
  readonly incidentBundlePath: string | undefined;
  readonly generatedAt: string;
  readonly defaultSlaHours: number;
}): readonly RagHumanReviewQueueItem[] {
  if (!input.incidentBundle || input.incidentBundle.status === "healthy") {
    return [];
  }

  const priority = priorityForIncidentSeverity(input.incidentBundle.severity);
  const itemDueAt = dueAt(input.generatedAt, slaForPriority(priority, input.defaultSlaHours));
  const artifactPaths = [
    ...(input.incidentBundlePath ? [input.incidentBundlePath] : []),
    ...input.incidentBundle.sourceArtifacts.flatMap((artifact) =>
      artifact.path && artifact.status === "present" ? [artifact.path] : []
    )
  ];

  return [
    {
      itemId: safeItemId("incident", input.incidentBundle.incidentId),
      kind: "incident_review",
      status: "open",
      priority,
      createdAt: input.generatedAt,
      ...(itemDueAt === undefined ? {} : { dueAt: itemDueAt }),
      source: "incident_bundle",
      summary: `Incident bundle ${input.incidentBundle.incidentId} is ${input.incidentBundle.status}/${input.incidentBundle.severity}.`,
      incidentId: input.incidentBundle.incidentId,
      destinations: ["incident_response"],
      escalationRules: [],
      reasonCodes: [
        `incident_status:${input.incidentBundle.status}`,
        `incident_severity:${input.incidentBundle.severity}`
      ],
      evidence: {
        status: input.incidentBundle.status,
        artifactPaths: uniqueSorted(artifactPaths),
        warningCodes: [],
        incidentId: input.incidentBundle.incidentId,
        incidentStatus: input.incidentBundle.status,
        incidentSeverity: input.incidentBundle.severity,
        incidentFindingCount: input.incidentBundle.findings.length
      },
      recommendedActions: input.incidentBundle.recommendedActions
    }
  ];
}

function shouldQueueEvalCase(evalCase: RagEvalCaseResult, includeRefusals: boolean): boolean {
  if (!evalCase.passed) {
    return true;
  }

  if (!evalCase.status) {
    return false;
  }

  return shouldQueueRunStatus(evalCase.status, includeRefusals);
}

function shouldQueueRunStatus(status: string, includeRefusals: boolean): boolean {
  if (status === "succeeded") {
    return false;
  }

  if (status === "refused") {
    return includeRefusals;
  }

  return (
    status === "human_review_required" ||
    status.endsWith("_failed") ||
    status === "validation_failed"
  );
}

function priorityForStatus(status: string, evalFailed: boolean): RagHumanReviewPriority {
  if (
    status === "retrieval_failed" ||
    status === "context_failed" ||
    status === "generation_failed"
  ) {
    return "high";
  }

  if (status === "model_failed" || status === "validation_failed") {
    return "high";
  }

  if (evalFailed) {
    return "high";
  }

  if (status === "human_review_required") {
    return "medium";
  }

  return "low";
}

function priorityForIncidentSeverity(severity: RagIncidentSeverity): RagHumanReviewPriority {
  switch (severity) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "warning":
      return "medium";
    case "none":
      return "low";
  }
}

function escalationRoutes(
  profile: RagProfile | undefined
): readonly RagHumanReviewEscalationRoute[] {
  return (
    profile?.escalationRules.map((rule) => ({
      ruleId: rule.id,
      description: rule.description,
      trigger: rule.trigger,
      destination: rule.destination
    })) ?? []
  );
}

function destinationsForRoutes(
  routes: readonly RagHumanReviewEscalationRoute[]
): readonly string[] {
  return uniqueSorted(routes.map((route) => route.destination)).length > 0
    ? uniqueSorted(routes.map((route) => route.destination))
    : ["human_review"];
}

function evalReasonCodes(evalCase: RagEvalCaseResult): readonly string[] {
  return uniqueSorted([
    ...(evalCase.status ? [`status:${evalCase.status}`] : []),
    ...(evalCase.passed ? [] : ["eval_failed"]),
    ...evalCase.checks.map((check) => `check:${check}`)
  ]);
}

function runReasonCodes(
  status: string,
  warningCodes: readonly string[],
  failure: { readonly stage: string; readonly errorName: string } | undefined
): readonly string[] {
  return uniqueSorted([
    `status:${status}`,
    ...warningCodes.map((code) => `warning:${code}`),
    ...(failure ? [`failure_stage:${failure.stage}`, `failure:${failure.errorName}`] : [])
  ]);
}

function recommendedActionsForQueueItem(input: {
  readonly source: string;
  readonly status: string;
  readonly routes: readonly RagHumanReviewEscalationRoute[];
  readonly artifactPath?: string;
}): readonly string[] {
  const actions = new Set<string>();
  actions.add(
    "Review the safe trace summary and linked artifacts before taking user-visible action."
  );

  if (input.artifactPath) {
    actions.add(`Open ${input.artifactPath} for the source evidence.`);
  }

  if (input.status === "human_review_required") {
    actions.add(
      "Approve, revise, or reject the drafted response/action according to profile policy."
    );
  } else if (input.status.endsWith("_failed") || input.status === "validation_failed") {
    actions.add("Assign the failure to the owning engineering or operations team before retrying.");
  } else if (input.status === "refused") {
    actions.add(
      "Confirm whether refusal was expected or whether the corpus/profile needs an update."
    );
  }

  for (const destination of destinationsForRoutes(input.routes)) {
    actions.add(`Route to ${destination}.`);
  }

  return [...actions].sort();
}

function artifactPathForEvalCase(suite: RagEvalSuiteResult, evalCase: RagEvalCaseResult): string {
  return evalCase.setKind === "golden" ? suite.goldenSetPath : suite.adversarialSetPath;
}

function queueMetrics(items: readonly RagHumanReviewQueueItem[]): RagHumanReviewQueueMetrics {
  return {
    itemCount: items.length,
    openItemCount: items.filter((item) => item.status === "open").length,
    criticalItemCount: items.filter((item) => item.priority === "critical").length,
    highItemCount: items.filter((item) => item.priority === "high").length,
    mediumItemCount: items.filter((item) => item.priority === "medium").length,
    lowItemCount: items.filter((item) => item.priority === "low").length
  };
}

function dedupeItems(
  items: readonly RagHumanReviewQueueItem[]
): readonly RagHumanReviewQueueItem[] {
  const seen = new Set<string>();
  const output: RagHumanReviewQueueItem[] = [];

  for (const item of items) {
    if (!seen.has(item.itemId)) {
      seen.add(item.itemId);
      output.push(item);
    }
  }

  return output;
}

function sortItems(items: readonly RagHumanReviewQueueItem[]): readonly RagHumanReviewQueueItem[] {
  const priorityOrder: Readonly<Record<RagHumanReviewPriority, number>> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3
  };

  return [...items].sort((first, second) => {
    const priorityDiff = priorityOrder[second.priority] - priorityOrder[first.priority];
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    return first.itemId.localeCompare(second.itemId);
  });
}

function slaForPriority(priority: RagHumanReviewPriority, defaultSlaHours: number): number {
  switch (priority) {
    case "critical":
      return Math.min(defaultSlaHours, 2);
    case "high":
      return Math.min(defaultSlaHours, 8);
    case "medium":
      return defaultSlaHours;
    case "low":
      return defaultSlaHours * 2;
  }
}

function dueAt(generatedAt: string, hours: number): string | undefined {
  const time = Date.parse(generatedAt);
  if (!Number.isFinite(time)) {
    return undefined;
  }
  return new Date(time + hours * 60 * 60 * 1000).toISOString();
}

function itemTable(queue: RagHumanReviewQueue): string {
  if (queue.items.length === 0) {
    return "- No human review items.";
  }

  const rows = queue.items.map(
    (item) =>
      `| \`${md(item.itemId)}\` | ${md(item.priority)} | ${md(item.kind)} | ${md(item.source)} | ${md(item.profileId ?? "-")} | ${md(item.traceId ?? item.incidentId ?? "-")} | ${md(item.destinations.join(", "))} |`
  );
  return [
    "| Item | Priority | Kind | Source | Profile | Trace/Incident | Destinations |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows
  ].join("\n");
}

function itemDetails(queue: RagHumanReviewQueue): string {
  if (queue.items.length === 0) {
    return "- None.";
  }

  return queue.items
    .map((item) =>
      [
        `### ${md(item.itemId)}`,
        "",
        md(item.summary),
        "",
        `- Status: ${md(item.status)}`,
        `- Priority: ${md(item.priority)}`,
        `- Due: ${md(item.dueAt ?? "-")}`,
        `- Reasons: ${md(item.reasonCodes.join(", ") || "-")}`,
        `- Destinations: ${md(item.destinations.join(", ") || "-")}`,
        `- Artifacts: ${md(item.evidence.artifactPaths.join(", ") || "-")}`,
        `- Trace linked: ${item.evidence.trace?.linked === undefined ? "-" : String(item.evidence.trace.linked)}`,
        "",
        "Actions:",
        item.recommendedActions.map((action) => `- ${md(action)}`).join("\n")
      ].join("\n")
    )
    .join("\n\n");
}

function safeItemId(...parts: readonly string[]): string {
  return parts
    .join("_")
    .replace(/[^0-9a-z._-]+/giu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
}

function safeTimestamp(value: string): string {
  return value.replace(/[^0-9a-z]+/giu, "_").replace(/^_+|_+$/gu, "");
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function md(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}
