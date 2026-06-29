"use client";

import Link from "next/link";
import { FileSearch, SearchCheck } from "lucide-react";
import { EmptyState, MetricCard, SectionCard, StatusPill } from "@/components/ui";
import {
  formatDurationMs,
  formatNumber,
  formatTime,
  statusTone,
  truncateMiddle
} from "@/lib/format";
import type {
  AdminAnswerResponse,
  CitationPointer,
  RetrievalBudgetBranchTrace,
  RetrievalBudgetTrace,
  TraceEvent
} from "@/lib/rag-answer-types";

export function AnswerResultPanels({
  result,
  mode = "full"
}: {
  result: AdminAnswerResponse;
  mode?: "full" | "answer" | "trace" | "citations";
}) {
  const showAnswer = mode === "full" || mode === "answer";
  const showTrace = mode === "full" || mode === "trace";
  const showCitations = mode === "full" || mode === "citations";
  const retrievalTrace = result.retrieval?.trace;
  const contextTrace = result.context?.trace;
  const evidence = result.context?.evidence;
  const citations = uniqueCitations(result.citations ?? result.trace.finalCitations ?? []);
  const hasGraphTrace = [
    retrievalTrace?.graphTraversalDepth,
    retrievalTrace?.graphVisitedEntityCount,
    retrievalTrace?.graphTraversedEdgeCount,
    contextTrace?.graphEvidencePathCount,
    contextTrace?.graphEvidenceMaxDepth,
    contextTrace?.graphEvidenceEdgeCount
  ].some((value) => typeof value === "number");

  return (
    <div className="space-y-4">
      <SectionCard
        title="Run Summary"
        description={`${result.trace.profileId} · ${result.trace.namespaceId}`}
        action={<StatusPill label={result.status} tone={statusTone(result.status)} />}
      >
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
          <MetricCard label="Run" value={truncateMiddle(result.trace.runId, 28)} />
          <MetricCard
            label="Trace"
            value={truncateMiddle(result.trace.traceId, 28)}
            tone="primary"
          />
          <MetricCard label="Retrieval" value={retrievalTrace?.mode ?? "n/a"} />
          <MetricCard label="Candidates" value={formatNumber(retrievalTrace?.candidatePoolSize)} />
          <MetricCard
            label="Returned"
            value={formatNumber(retrievalTrace?.returnedCount)}
            tone="success"
          />
          <MetricCard
            label="Rejected"
            value={formatNumber(retrievalTrace?.rejectedCount)}
            tone={retrievalTrace?.rejectedCount ? "warning" : "default"}
          />
        </div>
        <div className="mt-3 grid gap-2 text-xs text-text-muted md:grid-cols-3">
          <div>Started: {formatTime(result.trace.startedAt)}</div>
          <div>Finished: {formatTime(result.trace.finishedAt)}</div>
          <div>Events: {result.trace.events.length}</div>
        </div>
        {mode === "full" ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              className="inline-flex items-center gap-2 rounded-lg border border-card bg-surface px-3 py-2 text-sm text-text-secondary hover:border-primary/30"
              href="/traces"
            >
              <SearchCheck className="h-4 w-4" />
              Open Trace
            </Link>
            <Link
              className="inline-flex items-center gap-2 rounded-lg border border-card bg-surface px-3 py-2 text-sm text-text-secondary hover:border-primary/30"
              href="/citations"
            >
              <FileSearch className="h-4 w-4" />
              Open Citations
            </Link>
          </div>
        ) : null}
      </SectionCard>

      {showAnswer ? (
        <SectionCard
          title="Answer"
          description="Generated answer or refusal returned by the production endpoint."
        >
          {result.answer ? (
            <div className="whitespace-pre-wrap rounded-lg border border-card bg-background p-4 text-sm leading-6">
              {result.answer}
            </div>
          ) : result.refusal ? (
            <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-warning/20 bg-warning/10 p-4 text-xs text-warning">
              {JSON.stringify(result.refusal, null, 2)}
            </pre>
          ) : result.failure ? (
            <div className="rounded-lg border border-error/20 bg-error/10 p-4 text-sm text-error">
              {result.failure.errorName ?? "Failure"}:{" "}
              {result.failure.message ?? "No safe error detail returned."}
            </div>
          ) : (
            <EmptyState
              title="No answer text returned"
              detail="The endpoint returned a status without answer text, refusal, or failure detail."
            />
          )}
          {result.evidenceSummary ? (
            <div className="mt-3 rounded-lg bg-card p-3 text-sm text-text-secondary">
              {result.evidenceSummary}
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      {showTrace ? (
        <>
          <SectionCard
            title="Retrieval Trace"
            description="Safe strategy, candidate, and context metrics."
          >
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              <MetricCard
                label="Retrieval ID"
                value={truncateMiddle(retrievalTrace?.retrievalId ?? "n/a", 28)}
              />
              <MetricCard label="Duration" value={retrievalDuration(result)} />
              <MetricCard label="Context blocks" value={formatNumber(contextTrace?.blockCount)} />
              <MetricCard
                label="Context rejected"
                value={formatNumber(contextTrace?.rejectedCount)}
              />
              <MetricCard label="Tokens" value={formatNumber(contextTrace?.totalTokenEstimate)} />
            </div>

            {retrievalTrace?.adaptiveStrategy ? (
              <div className="mt-4 rounded-lg border border-card bg-background p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill
                    label={retrievalTrace.adaptiveStrategy.initialStrategy}
                    tone="primary"
                  />
                  <StatusPill
                    label={retrievalTrace.adaptiveStrategy.finalDecision}
                    tone={statusTone(retrievalTrace.adaptiveStrategy.finalDecision)}
                  />
                  {retrievalTrace.adaptiveStrategy.retryStrategy ? (
                    <StatusPill
                      label={`retry ${retrievalTrace.adaptiveStrategy.retryStrategy}`}
                      tone="warning"
                    />
                  ) : null}
                </div>
                <p className="mt-2 text-sm text-text-secondary">
                  {retrievalTrace.adaptiveStrategy.reason}
                </p>
                <p className="mt-1 text-xs text-text-muted">
                  Diagnosis: {retrievalTrace.adaptiveStrategy.diagnosis.code} ·{" "}
                  {retrievalTrace.adaptiveStrategy.diagnosis.reason}
                </p>
              </div>
            ) : null}

            {retrievalTrace?.retrievalBudget ? (
              <RetrievalBudgetCard budget={retrievalTrace.retrievalBudget} />
            ) : null}

            {hasGraphTrace ? (
              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
                <MetricCard
                  label="Graph depth"
                  value={formatNumber(retrievalTrace?.graphTraversalDepth)}
                />
                <MetricCard
                  label="Visited entities"
                  value={formatNumber(retrievalTrace?.graphVisitedEntityCount)}
                />
                <MetricCard
                  label="Traversed edges"
                  value={formatNumber(retrievalTrace?.graphTraversedEdgeCount)}
                />
                <MetricCard
                  label="Evidence paths"
                  value={formatNumber(contextTrace?.graphEvidencePathCount)}
                />
                <MetricCard
                  label="Evidence max depth"
                  value={formatNumber(contextTrace?.graphEvidenceMaxDepth)}
                />
                <MetricCard
                  label="Evidence edges"
                  value={formatNumber(contextTrace?.graphEvidenceEdgeCount)}
                />
              </div>
            ) : null}

            {evidence ? (
              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard
                  label="Evidence"
                  value={evidence.status}
                  tone={statusTone(evidence.status)}
                />
                <MetricCard label="Citations" value={formatNumber(evidence.citationCount)} />
                <MetricCard
                  label="Trusted citations"
                  value={formatNumber(evidence.trustedCitationCount)}
                />
                <MetricCard
                  label="Human review"
                  value={formatNumber(evidence.requiresHumanReviewCount)}
                  tone={evidence.requiresHumanReviewCount ? "warning" : "default"}
                />
              </div>
            ) : null}
          </SectionCard>

          <SectionCard
            title="Event Timeline"
            description="Trace events are redacted to event kind, time, message, and safe data keys."
          >
            {result.trace.events.length === 0 ? (
              <EmptyState title="No trace events returned" />
            ) : (
              <div className="space-y-2">
                {result.trace.events.map((event, index) => (
                  <TraceEventRow key={`${event.kind}-${event.at}-${index}`} event={event} />
                ))}
              </div>
            )}
          </SectionCard>
        </>
      ) : null}

      {showCitations ? (
        <SectionCard
          title="Citation Chain"
          description="Final citations and chunk pointers returned by the safe answer trace."
        >
          {citations.length === 0 && (result.citationChunkIds?.length ?? 0) === 0 ? (
            <EmptyState
              title="No final citations returned"
              detail="This usually means the answer was refused or failed before citation resolution."
            />
          ) : (
            <div className="space-y-3">
              {citations.map((citation, index) => (
                <CitationRow
                  key={`${citation.sourceId}-${citation.chunkId}-${index}`}
                  citation={citation}
                  index={index}
                />
              ))}
              {citations.length === 0 && result.citationChunkIds ? (
                <div className="rounded-lg border border-card bg-background p-3">
                  <div className="text-sm font-medium">Citation chunk IDs</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {result.citationChunkIds.map((chunkId) => (
                      <span
                        key={chunkId}
                        className="rounded-md bg-card px-2 py-1 text-xs text-text-secondary"
                      >
                        {truncateMiddle(chunkId, 48)}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </SectionCard>
      ) : null}
    </div>
  );
}

function RetrievalBudgetCard({ budget }: { budget: RetrievalBudgetTrace }) {
  const disabledQueryIds = asArray(budget.disabledQueryIds);
  const branches = asArray(budget.branches);
  return (
    <div className="mt-4 rounded-lg border border-card bg-background p-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
        <MetricCard label="Budget strategy" value={budget.strategy} tone="primary" />
        <MetricCard label="Requested top K" value={formatNumber(budget.requestedTopK)} />
        <MetricCard label="Max calls" value={formatNumber(budget.maxRetrievalCalls)} />
        <MetricCard label="Enabled queries" value={formatNumber(budget.enabledQueryCount)} />
        <MetricCard label="Disabled queries" value={formatNumber(disabledQueryIds.length)} />
        <MetricCard label="Pool limit" value={formatNumber(budget.totalCandidatePoolLimit)} />
      </div>
      <RetrievalBudgetBranchTable branches={branches} />
    </div>
  );
}

function RetrievalBudgetBranchTable({
  branches
}: {
  branches: readonly RetrievalBudgetBranchTrace[];
}) {
  if (branches.length === 0) return null;
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[820px] text-left text-sm">
        <thead className="border-b border-card text-xs uppercase tracking-[0.08em] text-text-muted">
          <tr>
            <th className="px-2 py-2 font-medium">Query</th>
            <th className="px-2 py-2 font-medium">Kind</th>
            <th className="px-2 py-2 font-medium">State</th>
            <th className="px-2 py-2 font-medium">Top K</th>
            <th className="px-2 py-2 font-medium">Weight</th>
            <th className="px-2 py-2 font-medium">Pool</th>
            <th className="px-2 py-2 font-medium">Reasons</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-card">
          {branches.map((branch) => (
            <RetrievalBudgetBranchRow key={branch.plannedQueryId} branch={branch} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RetrievalBudgetBranchRow({ branch }: { branch: RetrievalBudgetBranchTrace }) {
  const reasons = asArray(branch.reasons)
    .filter((reason): reason is string => typeof reason === "string")
    .join(", ");
  return (
    <tr className="hover:bg-card/50">
      <td className="px-2 py-3 font-medium">
        {truncateMiddle(branch.plannedQueryId ?? "unknown query", 48)}
      </td>
      <td className="px-2 py-3 text-text-secondary">{branch.kind}</td>
      <td className="px-2 py-3">
        <StatusPill
          label={branch.enabled ? "enabled" : "disabled"}
          tone={branch.enabled ? "success" : "warning"}
        />
      </td>
      <td className="px-2 py-3 text-text-secondary">{formatNumber(branch.topK)}</td>
      <td className="px-2 py-3 text-text-secondary">{formatWeight(branch.fusionWeight)}</td>
      <td className="px-2 py-3 text-text-secondary">{formatNumber(branch.candidatePoolLimit)}</td>
      <td className="px-2 py-3 text-text-muted">{truncateMiddle(reasons || "none", 72)}</td>
    </tr>
  );
}

function TraceEventRow({ event }: { event: TraceEvent }) {
  const dataKeys = Object.keys(event.data ?? {}).sort();
  return (
    <div className="rounded-lg border border-card bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusPill label={event.kind} tone={statusTone(event.kind)} />
        <span className="text-xs text-text-muted">{formatTime(event.at)}</span>
      </div>
      <div className="mt-2 text-sm text-text-secondary">{event.message}</div>
      <div className="mt-1 truncate text-xs text-text-muted">
        Data keys: {dataKeys.length === 0 ? "none" : dataKeys.join(", ")}
      </div>
    </div>
  );
}

function CitationRow({ citation, index }: { citation: CitationPointer; index: number }) {
  return (
    <div className="rounded-lg border border-card bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {index + 1}. {citation.title || "Untitled citation"}
          </div>
          <div className="truncate text-xs text-text-muted">{citation.locator ?? "No locator"}</div>
        </div>
        <StatusPill
          label={citation.pageNumber ? `page ${citation.pageNumber}` : "citation"}
          tone="success"
        />
      </div>
      <div className="mt-3 grid gap-2 text-xs text-text-muted md:grid-cols-2">
        <div>Source: {truncateMiddle(citation.sourceId, 64)}</div>
        <div>Chunk: {truncateMiddle(citation.chunkId, 64)}</div>
      </div>
      {citation.visualAssetId ? (
        <div className="mt-2 text-xs text-text-muted">
          Visual asset: {truncateMiddle(citation.visualAssetId, 64)}
        </div>
      ) : null}
    </div>
  );
}

function asArray<T>(value: readonly T[] | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

function formatWeight(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function retrievalDuration(result: AdminAnswerResponse): string {
  const startedAt = result.retrieval?.trace?.startedAt;
  const finishedAt = result.retrieval?.trace?.finishedAt;
  if (!startedAt || !finishedAt) return "n/a";
  const duration = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  return formatDurationMs(duration);
}

function uniqueCitations(citations: readonly CitationPointer[]): readonly CitationPointer[] {
  const seen = new Set<string>();
  const unique: CitationPointer[] = [];
  for (const citation of citations) {
    const key = `${citation.sourceId}:${citation.chunkId}:${citation.locator ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(citation);
  }
  return unique;
}
