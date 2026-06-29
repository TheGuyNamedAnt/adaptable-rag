"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { AnswerResultPanels } from "@/components/AnswerResultPanels";
import { RejectedEvidencePanel } from "@/components/RejectedEvidencePanel";
import { EmptyState, ErrorBanner, MetricCard, SectionCard, StatusPill } from "@/components/ui";
import type {
  AdminAnswerRunDetail,
  AdminAnswerRunListFilter,
  AdminAnswerRunList,
  AdminAnswerRunSummary
} from "@/lib/answer-history-types";
import { formatNumber, formatTime, statusTone, truncateMiddle } from "@/lib/format";

type InspectorMode = "trace" | "citations" | "rejected";

export function TraceHistoryClient({ mode }: { mode: InspectorMode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedRunId = searchParams.get("runId");
  const [history, setHistory] = useState<AdminAnswerRunList | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(requestedRunId);
  const [detail, setDetail] = useState<AdminAnswerRunDetail | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState<AdminAnswerRunListFilter>({});
  const [filterDraft, setFilterDraft] = useState<AdminAnswerRunListFilter>({});

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    setError(null);
    try {
      const nextHistory = await fetchJson<AdminAnswerRunList>(historyUrl(offset, filters));
      setHistory(nextHistory);
      setSelectedRunId((current) => {
        if (requestedRunId && nextHistory.runs.some((run) => run.runId === requestedRunId)) {
          return requestedRunId;
        }
        if (current && nextHistory.runs.some((run) => run.runId === current)) {
          return current;
        }
        return nextHistory.runs[0]?.runId ?? null;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Trace history failed to load.");
    } finally {
      setLoadingHistory(false);
    }
  }, [filters, offset, requestedRunId]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null);
      return;
    }

    let cancelled = false;
    const runId = selectedRunId;
    async function loadDetail() {
      setLoadingDetail(true);
      setError(null);
      try {
        const nextDetail = await fetchJson<AdminAnswerRunDetail>(
          `/api/rag/answer-runs/${encodeURIComponent(runId)}`
        );
        if (!cancelled) setDetail(nextDetail);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Trace detail failed to load.");
        }
      } finally {
        if (!cancelled) setLoadingDetail(false);
      }
    }

    void loadDetail();
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  const selectedSummary = useMemo(
    () => history?.runs.find((run) => run.runId === selectedRunId),
    [history, selectedRunId]
  );
  const activeFilterCount = Object.values(filters).filter(
    (value) => typeof value === "string" && value.trim().length > 0
  ).length;

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDetail(null);
    setSelectedRunId(null);
    setOffset(0);
    setFilters(compactFilters(filterDraft));
  }

  function clearFilters() {
    setDetail(null);
    setSelectedRunId(null);
    setOffset(0);
    setFilterDraft({});
    setFilters({});
  }

  function selectRun(runId: string) {
    setSelectedRunId(runId);
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set("runId", runId);
    router.replace(`${pathname}?${nextParams.toString()}`, { scroll: false });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <div className="space-y-4">
        <SectionCard
          title="Evidence History"
          description="Durable redacted answer-run artifacts."
          action={
            <button
              onClick={() => void loadHistory()}
              className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-card bg-surface px-3 py-2 text-sm text-text-secondary hover:border-primary/30"
            >
              <RefreshCw className={`h-4 w-4 ${loadingHistory ? "animate-spin" : ""}`} />
              Refresh
            </button>
          }
        >
          <details
            className="mb-3 rounded-lg border border-card bg-background p-3"
            open={activeFilterCount > 0}
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
              <span>Filters</span>
              <div className="flex items-center gap-2">
                <span className="text-xs font-normal text-text-muted">
                  Storage: {history?.page.storageKind ?? "detecting"}
                </span>
                <StatusPill
                  label={activeFilterCount ? `${activeFilterCount} active` : "all runs"}
                  tone={activeFilterCount ? "primary" : "default"}
                />
              </div>
            </summary>
            <form onSubmit={applyFilters} className="mt-3 space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <FilterInput
                  label="Status"
                  value={filterDraft.status}
                  onChange={(status) => setFilterDraft((current) => ({ ...current, status }))}
                />
                <FilterInput
                  label="Namespace"
                  value={filterDraft.namespaceId}
                  onChange={(namespaceId) =>
                    setFilterDraft((current) => ({ ...current, namespaceId }))
                  }
                />
                <FilterInput
                  label="Run ID"
                  value={filterDraft.runId}
                  onChange={(runId) => setFilterDraft((current) => ({ ...current, runId }))}
                />
                <FilterInput
                  label="Trace ID"
                  value={filterDraft.traceId}
                  onChange={(traceId) => setFilterDraft((current) => ({ ...current, traceId }))}
                />
                <FilterInput
                  label="Rejection code"
                  value={filterDraft.rejectionCode}
                  onChange={(rejectionCode) =>
                    setFilterDraft((current) => ({ ...current, rejectionCode }))
                  }
                />
                <FilterInput
                  label="Tenant"
                  value={filterDraft.tenantId}
                  onChange={(tenantId) => setFilterDraft((current) => ({ ...current, tenantId }))}
                />
                <FilterInput
                  label="From"
                  placeholder="2026-06-26T00:00:00Z"
                  value={filterDraft.from}
                  onChange={(from) => setFilterDraft((current) => ({ ...current, from }))}
                />
                <FilterInput
                  label="To"
                  placeholder="2026-06-26T23:59:59Z"
                  value={filterDraft.to}
                  onChange={(to) => setFilterDraft((current) => ({ ...current, to }))}
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={clearFilters}
                  className="rounded-lg border border-card px-3 py-2 text-xs text-text-secondary"
                >
                  Clear
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-text-primary px-3 py-2 text-xs font-medium text-white"
                >
                  Apply filters
                </button>
              </div>
            </form>
          </details>

          {loadingHistory && !history ? (
            <EmptyState title="Loading trace history" />
          ) : history && history.runs.length > 0 ? (
            <div className="space-y-2">
              {history.runs.map((run) => (
                <HistoryRunButton
                  key={`${run.savedAt}-${run.runId}`}
                  run={run}
                  selected={run.runId === selectedRunId}
                  onSelect={() => selectRun(run.runId)}
                />
              ))}
              <div className="flex items-center justify-between gap-2 pt-2">
                <button
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 25))}
                  className="rounded-lg border border-card px-3 py-2 text-xs text-text-secondary disabled:opacity-40"
                >
                  Newer
                </button>
                <span className="text-xs text-text-muted">
                  {formatNumber(history.page.total)} matching
                </span>
                <button
                  disabled={!history.page.hasMore}
                  onClick={() => setOffset(offset + history.page.limit)}
                  className="rounded-lg border border-card px-3 py-2 text-xs text-text-secondary disabled:opacity-40"
                >
                  Older
                </button>
              </div>
            </div>
          ) : (
            <EmptyState
              title="No durable evidence history"
              detail="Run Test Answer once. The admin server will append a redacted trace artifact under .rag/admin-traces."
              actionHref="/answer-lab"
              actionLabel="Open Test Answer"
            />
          )}
        </SectionCard>
      </div>

      <div className="space-y-4">
        {error ? <ErrorBanner message={error} /> : null}
        {selectedSummary ? <RunHeader run={selectedSummary} /> : null}
        {loadingDetail ? <EmptyState title="Loading selected run" /> : null}
        {!loadingDetail && detail ? (
          mode === "rejected" ? (
            <RejectedEvidencePanel rejected={detail.rejectedEvidence} />
          ) : (
            <AnswerResultPanels result={detail.response} mode={mode} />
          )
        ) : null}
        {!loadingDetail && !detail && history && history.runs.length === 0 ? (
          <EmptyState
            title="No run selected"
            detail="Create an answer run first, then evidence, citations, and rejected chunks will appear here."
            actionHref="/answer-lab"
            actionLabel="Open Test Answer"
          />
        ) : null}
      </div>
    </div>
  );
}

function HistoryRunButton({
  run,
  selected,
  onSelect
}: {
  run: AdminAnswerRunSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`block w-full rounded-lg border p-3 text-left transition ${
        selected
          ? "border-primary/40 bg-primary/10"
          : "border-card bg-background hover:border-primary/30"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <StatusPill label={run.status} tone={statusTone(run.status)} />
        <span className="text-xs text-text-muted">{formatTime(run.savedAt)}</span>
      </div>
      <div className="mt-2 truncate text-sm font-medium">{truncateMiddle(run.runId, 46)}</div>
      <div className="mt-1 truncate text-xs text-text-muted">
        {run.namespaceId} · question {truncateMiddle(run.questionHash, 20)}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <MiniMetric label="returned" value={formatNumber(run.returnedCount)} />
        <MiniMetric label="rejected" value={formatNumber(run.rejectedChunkCount)} />
        <MiniMetric label="citations" value={formatNumber(run.finalCitationCount)} />
      </div>
    </button>
  );
}

function RunHeader({ run }: { run: AdminAnswerRunSummary }) {
  return (
    <SectionCard
      title="Stored Run"
      description={`${run.tenantId} · ${run.namespaceId} · ${run.profileId}`}
      action={<StatusPill label={run.status} tone={statusTone(run.status)} />}
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Run" value={truncateMiddle(run.runId, 34)} />
        <MetricCard label="Trace" value={truncateMiddle(run.traceId, 34)} tone="primary" />
        <MetricCard label="Question hash" value={truncateMiddle(run.questionHash, 34)} />
        <MetricCard
          label="Answer text"
          value={run.answerRedacted ? "redacted" : run.hasAnswer ? "present" : "none"}
          tone={run.answerRedacted ? "warning" : "default"}
        />
      </div>
      {run.evidenceSummaryRedacted ? (
        <div className="mt-3 rounded-lg border border-warning/20 bg-warning/10 p-3 text-xs text-warning">
          Evidence summary text was not persisted in durable history.
        </div>
      ) : null}
    </SectionCard>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-card px-2 py-1">
      <div className="truncate text-xs font-semibold">{value}</div>
      <div className="truncate text-[10px] text-text-muted">{label}</div>
    </div>
  );
}

function FilterInput({
  label,
  value,
  placeholder,
  onChange
}: {
  label: string;
  value: string | undefined;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-text-muted">{label}</span>
      <input
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-card bg-background px-3 py-2 text-xs"
      />
    </label>
  );
}

function historyUrl(offset: number, filters: AdminAnswerRunListFilter): string {
  const params = new URLSearchParams({
    limit: "25",
    offset: String(offset)
  });
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" && value.trim()) {
      params.set(key, value.trim());
    }
  }
  return `/api/rag/answer-runs?${params.toString()}`;
}

function compactFilters(filters: AdminAnswerRunListFilter): AdminAnswerRunListFilter {
  return Object.fromEntries(
    Object.entries(filters)
      .map(([key, value]) => [key, value?.trim()])
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
  ) as AdminAnswerRunListFilter;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const json = (await response.json()) as T | { error?: { message?: string } };
  if (!response.ok) {
    const message =
      typeof json === "object" && json !== null && "error" in json && json.error?.message
        ? json.error.message
        : `Request failed with ${response.status}.`;
    throw new Error(message);
  }
  return json as T;
}
