import "server-only";

import type { Tone } from "@/components/ui";
import { listAdminAnswerRuns } from "@/lib/answer-history-store";
import type { AdminAnswerRunSummary } from "@/lib/answer-history-types";
import {
  getConnectorActionHistory,
  type ConnectorActionAuditRecord
} from "@/lib/connector-admin-state";
import { getConnectorRegistry, type ConnectorRegistryRecord } from "@/lib/connector-registry";
import { getEvalArtifacts, type EvalArtifacts } from "@/lib/eval-artifacts";
import {
  getIngestionJobDetail,
  getIngestionJobs,
  type IngestionDocumentProgressRecord,
  type IngestionJobRecord
} from "@/lib/rag-admin-api";
import { getReviewWorkflowStates } from "@/lib/review-workflow-store";
import type { ReviewWorkflowState, ReviewWorkflowStatus } from "@/lib/review-workflow-types";

export type ReviewQueueKind =
  | "answer"
  | "rejected_evidence"
  | "ingestion"
  | "connector"
  | "eval"
  | "operations";
export type ReviewQueuePriority = "high" | "medium" | "low";
export type ReviewQueueSourceStatus = "available" | "unavailable" | "empty";

export interface ReviewQueueResult {
  readonly generatedAt: string;
  readonly status: "open" | "empty" | "degraded";
  readonly summary: {
    readonly itemCount: number;
    readonly highCount: number;
    readonly mediumCount: number;
    readonly lowCount: number;
    readonly acknowledgedCount: number;
    readonly inReviewCount: number;
    readonly hiddenClosedCount: number;
    readonly unavailableSourceCount: number;
  };
  readonly sources: readonly ReviewQueueSource[];
  readonly items: readonly ReviewQueueItem[];
}

export interface ReviewQueueSource {
  readonly id:
    | ReviewQueueKind
    | "answer_history"
    | "connector_history"
    | "eval_artifacts"
    | "review_workflow";
  readonly label: string;
  readonly status: ReviewQueueSourceStatus;
  readonly itemCount: number;
  readonly detail: string;
  readonly href: string;
}

export interface ReviewQueueItem {
  readonly id: string;
  readonly kind: ReviewQueueKind;
  readonly priority: ReviewQueuePriority;
  readonly status: string;
  readonly title: string;
  readonly detail: string;
  readonly occurredAt?: string;
  readonly primaryId?: string;
  readonly secondaryId?: string;
  readonly reviewStatus?: ReviewWorkflowStatus;
  readonly workflow?: ReviewWorkflowState;
  readonly href: string;
  readonly actionLabel: string;
  readonly scope: readonly ReviewQueueFact[];
  readonly signals: readonly ReviewQueueFact[];
}

export interface ReviewQueueFact {
  readonly label: string;
  readonly value: string;
  readonly tone?: Tone;
}

interface ReviewQueueSection {
  readonly source: ReviewQueueSource;
  readonly items: readonly ReviewQueueItem[];
}

export async function getReviewQueue(): Promise<ReviewQueueResult> {
  const [answers, ingestion, connectors, evals, workflowLoad] = await Promise.all([
    answerReviewItems(),
    ingestionReviewItems(),
    connectorReviewItems(),
    evalReviewItems(),
    loadReviewWorkflowStates()
  ]);
  const sourceSections = [answers, ingestion, connectors, evals];
  const sections = workflowLoad.source ? [...sourceSections, workflowLoad.source] : sourceSections;
  const workflowApplied = applyReviewWorkflow(
    sourceSections.flatMap((section) => section.items),
    workflowLoad.states
  );
  const items = [...workflowApplied.items, ...(workflowLoad.source?.items ?? [])].sort(
    (left, right) => {
      const priorityDelta = priorityRank(left.priority) - priorityRank(right.priority);
      if (priorityDelta !== 0) return priorityDelta;
      return timeRank(right.occurredAt) - timeRank(left.occurredAt);
    }
  );
  const unavailableSourceCount = sections.filter(
    (section) => section.source.status === "unavailable"
  ).length;

  return {
    generatedAt: new Date().toISOString(),
    status: unavailableSourceCount > 0 ? "degraded" : items.length > 0 ? "open" : "empty",
    summary: {
      itemCount: items.length,
      highCount: items.filter((item) => item.priority === "high").length,
      mediumCount: items.filter((item) => item.priority === "medium").length,
      lowCount: items.filter((item) => item.priority === "low").length,
      acknowledgedCount: items.filter((item) => item.reviewStatus === "acknowledged").length,
      inReviewCount: items.filter((item) => item.reviewStatus === "in_review").length,
      hiddenClosedCount: workflowApplied.hiddenClosedCount,
      unavailableSourceCount
    },
    sources: sections.map((section) => section.source),
    items
  };
}

interface ReviewWorkflowLoadResult {
  readonly states: ReadonlyMap<string, ReviewWorkflowState>;
  readonly source?: ReviewQueueSection;
}

async function loadReviewWorkflowStates(): Promise<ReviewWorkflowLoadResult> {
  try {
    return { states: await getReviewWorkflowStates() };
  } catch (error) {
    return {
      states: new Map<string, ReviewWorkflowState>(),
      source: unavailableSection({
        id: "review_workflow",
        label: "Review workflow",
        href: "/admin-ops",
        item: {
          id: "review_workflow_unavailable",
          kind: "operations",
          priority: "high",
          status: "unavailable",
          reviewStatus: "open",
          title: "Review workflow state unavailable",
          detail: safeErrorMessage(error, "Review workflow state is unavailable."),
          href: "/admin-ops",
          actionLabel: "Inspect Admin Ops",
          scope: [{ label: "Surface", value: "review workflow" }],
          signals: []
        }
      })
    };
  }
}

function applyReviewWorkflow(
  items: readonly ReviewQueueItem[],
  states: ReadonlyMap<string, ReviewWorkflowState>
): { readonly items: readonly ReviewQueueItem[]; readonly hiddenClosedCount: number } {
  const visible: ReviewQueueItem[] = [];
  let hiddenClosedCount = 0;

  for (const item of items) {
    const workflow = states.get(item.id);
    const reviewStatus = workflow?.status ?? "open";
    if (reviewStatus === "resolved" || reviewStatus === "dismissed") {
      hiddenClosedCount += 1;
      continue;
    }
    visible.push({
      ...item,
      reviewStatus,
      ...(workflow ? { workflow } : {})
    });
  }

  return { items: visible, hiddenClosedCount };
}

async function answerReviewItems(): Promise<ReviewQueueSection> {
  try {
    const history = await listAdminAnswerRuns({ limit: 75 });
    const items = history.runs.flatMap(answerRunItems);
    return {
      source: {
        id: "answer_history",
        label: "Answer history",
        status: "available",
        itemCount: items.length,
        detail: `${history.page.total.toLocaleString()} redacted answer run(s) in ${history.page.storageKind}.`,
        href: "/traces"
      },
      items
    };
  } catch (error) {
    return unavailableSection({
      id: "answer_history",
      label: "Answer history",
      href: "/traces",
      item: {
        id: "answer_history_unavailable",
        kind: "operations",
        priority: "high",
        status: "unavailable",
        title: "Answer history unavailable",
        detail: safeErrorMessage(error, "Answer run history is unavailable."),
        href: "/admin-ops",
        actionLabel: "Inspect Admin Ops",
        scope: [{ label: "Surface", value: "answer history" }],
        signals: []
      }
    });
  }
}

function answerRunItems(run: AdminAnswerRunSummary): readonly ReviewQueueItem[] {
  const items: ReviewQueueItem[] = [];
  const traceHref = `/traces?runId=${encodeURIComponent(run.runId)}`;
  if (isAnswerFailure(run.status)) {
    items.push({
      id: `answer_failed:${run.runId}`,
      kind: "answer",
      priority: "high",
      status: run.status,
      title: "Answer run failed",
      detail: "The guarded answer path failed before producing a safe completed answer.",
      occurredAt: run.savedAt,
      primaryId: run.runId,
      secondaryId: run.traceId,
      href: traceHref,
      actionLabel: "Inspect Trace",
      scope: answerScope(run),
      signals: answerSignals(run)
    });
  }
  if (run.status === "refused") {
    items.push({
      id: `answer_refused:${run.runId}`,
      kind: "answer",
      priority: "medium",
      status: run.status,
      title: "Answer refused",
      detail: "The RAG service refused to answer. Review whether the refusal was expected.",
      occurredAt: run.savedAt,
      primaryId: run.runId,
      secondaryId: run.traceId,
      href: traceHref,
      actionLabel: "Inspect Trace",
      scope: answerScope(run),
      signals: answerSignals(run)
    });
  }
  if (run.rejectedChunkCount > 0) {
    items.push({
      id: `rejected_evidence:${run.runId}`,
      kind: "rejected_evidence",
      priority: "medium",
      status: "rejected",
      title: "Rejected evidence needs review",
      detail: "Chunks were rejected by retrieval or context gates.",
      occurredAt: run.savedAt,
      primaryId: run.runId,
      secondaryId: run.traceId,
      href: `/rejected?runId=${encodeURIComponent(run.runId)}`,
      actionLabel: "Inspect Rejections",
      scope: answerScope(run),
      signals: [
        { label: "Rejected chunks", value: String(run.rejectedChunkCount), tone: "warning" },
        { label: "Retrieval rejected", value: countLabel(run.retrievalRejectedCount) },
        { label: "Context rejected", value: countLabel(run.contextRejectedCount) }
      ]
    });
  }
  if (run.status === "succeeded" && run.hasAnswer && run.finalCitationCount === 0) {
    items.push({
      id: `answer_uncited:${run.runId}`,
      kind: "answer",
      priority: "medium",
      status: "uncited",
      title: "Answer completed without citations",
      detail: "A completed answer without final citations should be checked before production use.",
      occurredAt: run.savedAt,
      primaryId: run.runId,
      secondaryId: run.traceId,
      href: traceHref,
      actionLabel: "Inspect Trace",
      scope: answerScope(run),
      signals: answerSignals(run)
    });
  }
  return items;
}

async function ingestionReviewItems(): Promise<ReviewQueueSection> {
  const jobsResult = await getIngestionJobs({ limit: 30 });
  if (jobsResult.status === "unavailable") {
    return unavailableSection({
      id: "ingestion",
      label: "Ingestion metadata",
      href: "/ingestion",
      item: {
        id: "ingestion_metadata_unavailable",
        kind: "operations",
        priority: "high",
        status: "unavailable",
        title: "Ingestion inspection unavailable",
        detail:
          jobsResult.error ??
          "Ingestion inspection is unavailable. Configure production metadata storage.",
        href: "/storage",
        actionLabel: "Inspect Storage",
        scope: [{ label: "Surface", value: "ingestion jobs" }],
        signals: []
      }
    });
  }

  const jobs = jobsResult.data ?? [];
  const reviewJobs = jobs.filter(jobNeedsReview);
  const detailResults = await Promise.all(
    reviewJobs.slice(0, 8).map(async (job) => ({
      job,
      detail: await getIngestionJobDetail(job.jobId, {
        documentStatus: ["failed"],
        documentLimit: 5,
        checkpointLimit: 1
      })
    }))
  );
  const failedDocumentItems = detailResults.flatMap(({ job, detail }) =>
    (detail.data?.failedDocuments ?? []).map((document) => failedDocumentItem(job, document))
  );
  const jobItems = reviewJobs.map(ingestionJobItem);
  const items = [...failedDocumentItems, ...jobItems];

  return {
    source: {
      id: "ingestion",
      label: "Ingestion metadata",
      status: "available",
      itemCount: items.length,
      detail: `${jobs.length.toLocaleString()} recent ingestion job(s) inspected.`,
      href: "/ingestion"
    },
    items
  };
}

function connectorReviewItems(): Promise<ReviewQueueSection> {
  return Promise.all([getConnectorRegistry(), getConnectorActionHistory({ limit: 50 })])
    .then(([registry, history]) => {
      const connectorItems = registry.connectors.filter(connectorNeedsReview).map(connectorItem);
      const actionItems = history.records
        .filter(connectorActionNeedsReview)
        .map(connectorActionItem);
      const items = [...connectorItems, ...actionItems];
      const section: ReviewQueueSection = {
        source: {
          id: "connector_history",
          label: "Connectors",
          status: "available",
          itemCount: items.length,
          detail: `${registry.connectors.length.toLocaleString()} connector(s), ${history.records.length.toLocaleString()} action record(s).`,
          href: "/connectors"
        },
        items
      };
      return section;
    })
    .catch((error: unknown) =>
      unavailableSection({
        id: "connector_history",
        label: "Connectors",
        href: "/connectors",
        item: {
          id: "connectors_unavailable",
          kind: "operations",
          priority: "high",
          status: "unavailable",
          title: "Connector review unavailable",
          detail: safeErrorMessage(error, "Connector registry or action history is unavailable."),
          href: "/admin-ops",
          actionLabel: "Inspect Admin Ops",
          scope: [{ label: "Surface", value: "connectors" }],
          signals: []
        }
      })
    );
}

async function evalReviewItems(): Promise<ReviewQueueSection> {
  try {
    const artifacts = await getEvalArtifacts();
    const items = evalItems(artifacts);
    return {
      source: {
        id: "eval_artifacts",
        label: "Eval artifacts",
        status:
          artifacts.summary || artifacts.regression || artifacts.dashboard ? "available" : "empty",
        itemCount: items.length,
        detail:
          artifacts.summary || artifacts.regression || artifacts.dashboard
            ? "Latest eval artifacts loaded from .rag/eval-runs/latest."
            : "No eval artifacts found.",
        href: "/evals"
      },
      items
    };
  } catch (error) {
    return unavailableSection({
      id: "eval_artifacts",
      label: "Eval artifacts",
      href: "/evals",
      item: {
        id: "eval_artifacts_unavailable",
        kind: "operations",
        priority: "medium",
        status: "unavailable",
        title: "Eval artifacts unavailable",
        detail: safeErrorMessage(error, "Eval artifacts are unavailable."),
        href: "/evals",
        actionLabel: "Inspect Evals",
        scope: [{ label: "Surface", value: "evals" }],
        signals: []
      }
    });
  }
}

function evalItems(artifacts: EvalArtifacts): readonly ReviewQueueItem[] {
  const items: ReviewQueueItem[] = [];
  if (artifacts.summary && !artifacts.summary.passed) {
    items.push({
      id: "eval_summary_failed",
      kind: "eval",
      priority: "high",
      status: "failed",
      title: "Eval summary failed",
      detail: "One or more retrieval/citation/refusal/access eval cases failed.",
      occurredAt: artifacts.generatedAt,
      href: "/evals",
      actionLabel: "Inspect Evals",
      scope: [{ label: "Suites", value: String(artifacts.summary.suiteCount) }],
      signals: [
        { label: "Cases", value: String(artifacts.summary.caseCount) },
        { label: "Failures", value: String(artifacts.summary.failureCount), tone: "error" }
      ]
    });
  }
  for (const suite of artifacts.summary?.suites ?? []) {
    if (suite.failureCount > 0 || suite.missingRequiredChecks.length > 0) {
      items.push({
        id: `eval_suite:${suite.profileId}:${suite.namespaceId}`,
        kind: "eval",
        priority: suite.failureCount > 0 ? "high" : "medium",
        status: suite.failureCount > 0 ? "failed" : "missing_checks",
        title: "Eval suite needs review",
        detail:
          suite.failureCount > 0
            ? "A profile/namespace eval suite has failing cases."
            : "A profile/namespace eval suite is missing required checks.",
        occurredAt: artifacts.generatedAt,
        primaryId: suite.profileId,
        secondaryId: suite.namespaceId,
        href: "/evals",
        actionLabel: "Inspect Evals",
        scope: [
          { label: "Profile", value: suite.profileId },
          { label: "Namespace", value: suite.namespaceId }
        ],
        signals: [
          { label: "Cases", value: String(suite.caseCount) },
          { label: "Failures", value: String(suite.failureCount), tone: "error" },
          {
            label: "Missing checks",
            value: String(suite.missingRequiredChecks.length),
            tone: "warning"
          }
        ]
      });
    }
  }
  if (artifacts.regression && !artifacts.regression.passed) {
    items.push({
      id: "eval_regression_failed",
      kind: "eval",
      priority: "high",
      status: "failed",
      title: "Eval regression failed",
      detail: "A regression gate failed against the current eval baseline.",
      occurredAt: artifacts.generatedAt,
      href: "/evals",
      actionLabel: "Inspect Regression",
      scope: [{ label: "Surface", value: "regression" }],
      signals: [
        { label: "Failures", value: String(artifacts.regression.failureCount), tone: "error" },
        { label: "Warnings", value: String(artifacts.regression.warningCount), tone: "warning" }
      ]
    });
  } else if (artifacts.regression && artifacts.regression.warningCount > 0) {
    items.push({
      id: "eval_regression_warning",
      kind: "eval",
      priority: "medium",
      status: "warning",
      title: "Eval regression warning",
      detail: "A regression warning should be checked before promotion.",
      occurredAt: artifacts.generatedAt,
      href: "/evals",
      actionLabel: "Inspect Regression",
      scope: [{ label: "Surface", value: "regression" }],
      signals: [
        { label: "Warnings", value: String(artifacts.regression.warningCount), tone: "warning" }
      ]
    });
  }
  return items;
}

function ingestionJobItem(job: IngestionJobRecord): ReviewQueueItem {
  const failedCount = failedDocumentCount(job.counts);
  return {
    id: `ingestion_job:${job.jobId}`,
    kind: "ingestion",
    priority: job.status === "failed" || failedCount > 0 ? "high" : "medium",
    status: job.status,
    title: "Ingestion job needs review",
    detail: job.errorMessage ?? `Job is ${job.status} at stage ${job.stage}.`,
    occurredAt: job.updatedAt,
    primaryId: job.jobId,
    secondaryId: job.runId,
    href: `/ingestion/${encodeURIComponent(job.jobId)}`,
    actionLabel: "Inspect Job",
    scope: [
      { label: "Tenant", value: job.tenantId },
      { label: "Namespace", value: job.namespaceId },
      { label: "Sources", value: String(job.sourceIds.length) }
    ],
    signals: [
      { label: "Stage", value: job.stage, tone: job.status === "failed" ? "error" : "warning" },
      {
        label: "Failed docs",
        value: countLabel(failedCount),
        tone: failedCount > 0 ? "error" : "default"
      }
    ]
  };
}

function failedDocumentItem(
  job: IngestionJobRecord,
  document: IngestionDocumentProgressRecord
): ReviewQueueItem {
  return {
    id: `ingestion_document:${job.jobId}:${document.sourceId}:${document.documentId}`,
    kind: "ingestion",
    priority: document.retryable ? "high" : "medium",
    status: document.status,
    title: "Ingestion document failed",
    detail: document.errorMessage ?? "A document failed during ingestion.",
    occurredAt: document.updatedAt,
    primaryId: document.documentId,
    secondaryId: job.jobId,
    href: `/ingestion/${encodeURIComponent(job.jobId)}?documentStatus=failed&sourceId=${encodeURIComponent(document.sourceId)}`,
    actionLabel: "Inspect Document",
    scope: [
      { label: "Source", value: document.sourceId },
      { label: "Job", value: job.jobId }
    ],
    signals: [
      { label: "Stage", value: document.failureStage ?? "unknown", tone: "error" },
      { label: "Phase", value: document.failurePhase ?? "unknown" },
      {
        label: "Retryable",
        value: document.retryable ? "yes" : "no",
        tone: document.retryable ? "warning" : "default"
      }
    ]
  };
}

function connectorItem(connector: ConnectorRegistryRecord): ReviewQueueItem {
  return {
    id: `connector:${connector.id}`,
    kind: "connector",
    priority: connector.status === "failed" || connector.failedItemCount > 0 ? "high" : "medium",
    status: connector.enabled ? connector.status : "disabled",
    title: connector.enabled ? "Connector needs review" : "Connector is disabled",
    detail: connector.enabled
      ? "Connector contract, latest artifact, or failed item count needs operator attention."
      : (connector.disabledReason ?? "Connector sync actions are disabled."),
    occurredAt: connector.lastCheckedAt,
    primaryId: connector.id,
    href: "/connectors",
    actionLabel: "Inspect Connector",
    scope: [
      { label: "Company", value: connector.companyId },
      { label: "Source", value: connector.sourceId },
      { label: "Namespace", value: connector.namespaceId ?? "n/a" }
    ],
    signals: [
      {
        label: "Failed items",
        value: String(connector.failedItemCount),
        tone: connector.failedItemCount > 0 ? "error" : "default"
      },
      {
        label: "Warnings",
        value: String(connector.warningCount),
        tone: connector.warningCount > 0 ? "warning" : "default"
      },
      {
        label: "Errors",
        value: String(connector.errorCount),
        tone: connector.errorCount > 0 ? "error" : "default"
      }
    ]
  };
}

function connectorActionItem(record: ConnectorActionAuditRecord): ReviewQueueItem {
  return {
    id: `connector_action:${record.actionId}`,
    kind: "connector",
    priority: record.status === "failed" ? "high" : "medium",
    status: record.status,
    title: "Connector action needs review",
    detail: record.error ?? `Connector action ${record.action} ended as ${record.status}.`,
    occurredAt: record.finishedAt,
    primaryId: record.actionId,
    secondaryId: record.connectorRecordId,
    href: "/connectors",
    actionLabel: "Inspect Action",
    scope: [
      { label: "Action", value: record.action },
      { label: "Connector", value: record.connectorRecordId ?? "n/a" },
      { label: "Source", value: record.sourceId ?? "n/a" }
    ],
    signals: [
      {
        label: "Sync status",
        value: record.result?.syncStatus ?? record.status,
        tone: record.status === "failed" ? "error" : "warning"
      },
      { label: "Failed items", value: countLabel(record.result?.syncFailedItemCount) },
      { label: "Rejected records", value: countLabel(record.result?.rejectedRecordCount) }
    ]
  };
}

function unavailableSection(input: {
  readonly id: ReviewQueueSource["id"];
  readonly label: string;
  readonly href: string;
  readonly item: ReviewQueueItem;
}): ReviewQueueSection {
  return {
    source: {
      id: input.id,
      label: input.label,
      status: "unavailable",
      itemCount: 1,
      detail: input.item.detail,
      href: input.href
    },
    items: [input.item]
  };
}

function answerScope(run: AdminAnswerRunSummary): readonly ReviewQueueFact[] {
  return [
    { label: "Tenant", value: run.tenantId },
    { label: "Namespace", value: run.namespaceId },
    { label: "Question hash", value: run.questionHash }
  ];
}

function answerSignals(run: AdminAnswerRunSummary): readonly ReviewQueueFact[] {
  return [
    {
      label: "Citations",
      value: String(run.finalCitationCount),
      tone: run.finalCitationCount ? "success" : "warning"
    },
    {
      label: "Rejected chunks",
      value: String(run.rejectedChunkCount),
      tone: run.rejectedChunkCount ? "warning" : "default"
    },
    { label: "Events", value: String(run.eventCount) }
  ];
}

function jobNeedsReview(job: IngestionJobRecord): boolean {
  return (
    job.status === "failed" ||
    job.status === "completed_with_warnings" ||
    job.status === "cancelled" ||
    failedDocumentCount(job.counts) > 0 ||
    Boolean(job.errorMessage)
  );
}

function connectorNeedsReview(connector: ConnectorRegistryRecord): boolean {
  return (
    connector.status === "failed" ||
    connector.status === "warning" ||
    connector.failedItemCount > 0 ||
    connector.warningCount > 0 ||
    connector.errorCount > 0 ||
    !connector.enabled
  );
}

function connectorActionNeedsReview(record: ConnectorActionAuditRecord): boolean {
  return record.status === "failed" || record.status === "partial" || record.status === "rejected";
}

function isAnswerFailure(status: string): boolean {
  return status === "failed" || status.endsWith("_failed") || status.includes("failed");
}

function failedDocumentCount(counts: Record<string, number> | undefined): number {
  return (
    numberValue(counts?.failedDocumentCount) ??
    numberValue(counts?.documentsFailed) ??
    numberValue(counts?.failed) ??
    0
  );
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function countLabel(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "n/a";
}

function priorityRank(priority: ReviewQueuePriority): number {
  switch (priority) {
    case "high":
      return 0;
    case "medium":
      return 1;
    case "low":
      return 2;
  }
}

function timeRank(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return redactOperationalText(error.message).slice(0, 1200);
  }
  return fallback;
}

function redactOperationalText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|secret|password)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgres://[redacted]@");
}
