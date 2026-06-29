import Link from "next/link";
import { ClipboardList, Download, RadioTower, RefreshCw } from "lucide-react";
import {
  EmptyState,
  ErrorBanner,
  IconLink,
  MetricCard,
  PageGuide,
  PageHeader,
  SectionCard,
  StatusPill,
  type Tone
} from "@/components/ui";
import { ReviewWorkflowHistoryActions } from "@/components/ReviewWorkflowHistoryActions";
import {
  listReviewWorkflowHistory,
  type ReviewWorkflowHistoryResult
} from "@/lib/review-workflow-store";
import {
  REVIEW_WORKFLOW_STATUSES,
  type ReviewWorkflowState,
  type ReviewWorkflowStatus
} from "@/lib/review-workflow-types";
import { formatNumber, formatTime, truncateMiddle } from "@/lib/format";

type SearchParams = Record<string, string | string[] | undefined>;

const DEFAULT_LIMIT = 25;

export default async function ReviewHistoryPage({
  searchParams
}: {
  searchParams?: SearchParams | Promise<SearchParams>;
}) {
  const params = (await searchParams) ?? {};
  const status = statusParam(firstParam(params.status));
  const owner = firstParam(params.owner)?.trim() || undefined;
  const offset = offsetParam(firstParam(params.offset));
  const history = await safeReviewWorkflowHistory({ status, owner, offset });

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Run"
        title="Review History"
        description="Audit trail for review queue acknowledgements, assignments, resolutions, dismissals, and reopen decisions."
        actions={
          <div className="flex items-center gap-2">
            <IconLink href="/review" icon={ClipboardList} label="Open Queue" />
            <IconLink href="/review/sync" icon={RadioTower} label="Sync" />
            <IconLink href={exportHref({ status, owner, offset })} icon={Download} label="Export" />
            <IconLink
              href={historyHref({ status, owner, offset })}
              icon={RefreshCw}
              label="Refresh"
            />
          </div>
        }
      />

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">
        {history.status === "failed" ? (
          <ErrorBanner message="Review workflow history is unavailable. Inspect Diagnostics for review metadata storage readiness." />
        ) : null}

        <PageGuide
          title="Use this to audit human review decisions"
          description="Review History shows assignment, acknowledgement, resolution, dismissal, and reopen state. It is the audit trail for the current queue, not the place to discover new failures."
          steps={[
            "Filter by status or owner.",
            "Review notes and timestamps.",
            "Return to Review Work for current open items."
          ]}
          tone={history.status === "failed" ? "error" : "primary"}
        />

        <SectionCard
          title="History Summary"
          description={`Generated ${formatTime(history.generatedAt)} · ${history.page.storageKind}`}
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-8">
            <MetricCard label="Total" value={formatNumber(history.summary.totalCount)} />
            <MetricCard
              label="Filtered"
              value={formatNumber(history.summary.filteredCount)}
              tone={status || owner ? "primary" : "default"}
            />
            <MetricCard label="Open" value={formatNumber(history.summary.openCount)} />
            <MetricCard
              label="Acknowledged"
              value={formatNumber(history.summary.acknowledgedCount)}
              tone={history.summary.acknowledgedCount ? "primary" : "default"}
            />
            <MetricCard
              label="In review"
              value={formatNumber(history.summary.inReviewCount)}
              tone={history.summary.inReviewCount ? "primary" : "default"}
            />
            <MetricCard
              label="Resolved"
              value={formatNumber(history.summary.resolvedCount)}
              tone={history.summary.resolvedCount ? "success" : "default"}
            />
            <MetricCard
              label="Dismissed"
              value={formatNumber(history.summary.dismissedCount)}
              tone={history.summary.dismissedCount ? "warning" : "default"}
            />
            <MetricCard label="Closed" value={formatNumber(history.summary.closedCount)} />
          </div>
        </SectionCard>

        <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="space-y-4">
            <SectionCard title="Filters">
              <div className="space-y-3">
                <div className="space-y-2">
                  <FilterChip label="All statuses" href={historyHref({ owner })} active={!status} />
                  {REVIEW_WORKFLOW_STATUSES.map((nextStatus) => (
                    <FilterChip
                      key={nextStatus}
                      label={statusLabel(nextStatus)}
                      href={historyHref({ status: nextStatus, owner })}
                      active={status === nextStatus}
                    />
                  ))}
                </div>

                <form action="/review/history" method="get" className="space-y-2">
                  {status ? <input type="hidden" name="status" value={status} /> : null}
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted">
                      Owner
                    </span>
                    <input
                      name="owner"
                      defaultValue={owner ?? ""}
                      maxLength={120}
                      className="h-9 w-full rounded-md border border-card bg-background px-2 text-sm text-text-primary outline-none focus:border-primary/50"
                      placeholder="admin"
                    />
                  </label>
                  <button
                    type="submit"
                    className="inline-flex min-h-9 w-full items-center justify-center rounded-lg border border-card bg-text-primary px-3 py-2 text-xs font-medium text-white"
                  >
                    Apply
                  </button>
                  {owner ? (
                    <Link
                      href={historyHref({ status })}
                      className="block rounded-lg border border-card bg-background px-3 py-2 text-center text-xs text-text-secondary hover:border-primary/30 hover:text-text-primary"
                    >
                      Clear owner
                    </Link>
                  ) : null}
                </form>
              </div>
            </SectionCard>
          </aside>

          <SectionCard
            title="Workflow Records"
            description="Records contain queue item ids, workflow status, owner, bounded operator notes, and timestamps only."
          >
            {history.states.length === 0 ? (
              <EmptyState
                title="No workflow records"
                detail="No review decisions match the current filters."
                actionHref="/review"
                actionLabel="Open Review Work"
              />
            ) : (
              <div className="space-y-3">
                {history.states.map((state) => (
                  <WorkflowRecordCard key={state.itemId} state={state} />
                ))}
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-text-muted">
                Showing {formatNumber(history.states.length)} of{" "}
                {formatNumber(history.summary.filteredCount)}
              </div>
              <div className="flex gap-2">
                <PaginationLink
                  label="Previous"
                  disabled={history.page.offset === 0}
                  href={historyHref({
                    status,
                    owner,
                    offset: Math.max(0, history.page.offset - history.page.limit)
                  })}
                />
                <PaginationLink
                  label="Next"
                  disabled={!history.page.hasMore}
                  href={historyHref({
                    status,
                    owner,
                    offset: history.page.offset + history.page.limit
                  })}
                />
              </div>
            </div>
          </SectionCard>
        </div>
      </main>
    </div>
  );
}

function WorkflowRecordCard({ state }: { readonly state: ReviewWorkflowState }) {
  return (
    <div className="rounded-lg border border-card bg-background p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill label={statusLabel(state.status)} tone={statusTone(state.status)} />
            {state.owner ? <StatusPill label={`owner: ${state.owner}`} tone="default" /> : null}
          </div>
          <div className="mt-2 font-medium">{truncateMiddle(state.itemId, 82)}</div>
          {state.note ? (
            <p className="mt-1 text-sm leading-5 text-text-secondary">{state.note}</p>
          ) : null}
        </div>
        <ReviewWorkflowHistoryActions state={state} />
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-xs text-text-muted">
        <span>Updated: {formatTime(state.updatedAt)}</span>
        <span>Updated by: {state.updatedBy}</span>
        {state.acknowledgedAt ? (
          <span>Acknowledged: {formatTime(state.acknowledgedAt)}</span>
        ) : null}
        {state.acknowledgedBy ? <span>Acknowledged by: {state.acknowledgedBy}</span> : null}
      </div>
    </div>
  );
}

function FilterChip({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`block rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
        active
          ? "border-text-primary bg-text-primary text-white"
          : "border-card bg-background text-text-secondary hover:border-primary/30 hover:text-text-primary"
      }`}
    >
      {label}
    </Link>
  );
}

function PaginationLink({
  label,
  href,
  disabled
}: {
  readonly label: string;
  readonly href: string;
  readonly disabled: boolean;
}) {
  if (disabled) {
    return (
      <span className="inline-flex min-h-9 items-center rounded-lg border border-card bg-card/40 px-3 py-2 text-xs text-text-muted">
        {label}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="inline-flex min-h-9 items-center rounded-lg border border-card bg-background px-3 py-2 text-xs text-text-secondary hover:border-primary/30 hover:text-text-primary"
    >
      {label}
    </Link>
  );
}

async function safeReviewWorkflowHistory(input: {
  readonly status?: ReviewWorkflowStatus;
  readonly owner?: string;
  readonly offset: number;
}): Promise<ReviewWorkflowHistoryResult & { readonly status?: "failed" }> {
  try {
    return await listReviewWorkflowHistory({
      ...(input.status ? { status: input.status } : {}),
      ...(input.owner ? { owner: input.owner } : {}),
      limit: DEFAULT_LIMIT,
      offset: input.offset
    });
  } catch {
    return {
      generatedAt: new Date().toISOString(),
      status: "failed",
      states: [],
      summary: {
        totalCount: 0,
        filteredCount: 0,
        openCount: 0,
        acknowledgedCount: 0,
        inReviewCount: 0,
        resolvedCount: 0,
        dismissedCount: 0,
        closedCount: 0
      },
      page: {
        limit: DEFAULT_LIMIT,
        offset: input.offset,
        hasMore: false,
        storageKind: "json_file"
      }
    };
  }
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function statusParam(value: string | undefined): ReviewWorkflowStatus | undefined {
  return value && REVIEW_WORKFLOW_STATUSES.includes(value as ReviewWorkflowStatus)
    ? (value as ReviewWorkflowStatus)
    : undefined;
}

function offsetParam(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function historyHref(input: {
  readonly status?: ReviewWorkflowStatus;
  readonly owner?: string;
  readonly offset?: number;
}): string {
  const params = new URLSearchParams();
  if (input.status) params.set("status", input.status);
  if (input.owner) params.set("owner", input.owner);
  if (input.offset) params.set("offset", String(input.offset));
  const query = params.toString();
  return query ? `/review/history?${query}` : "/review/history";
}

function exportHref(input: {
  readonly status?: ReviewWorkflowStatus;
  readonly owner?: string;
  readonly offset?: number;
}): string {
  const params = new URLSearchParams();
  if (input.status) params.set("status", input.status);
  if (input.owner) params.set("owner", input.owner);
  if (input.offset) params.set("offset", String(input.offset));
  const query = params.toString();
  return query ? `/api/rag/review/export?${query}` : "/api/rag/review/export";
}

function statusLabel(status: ReviewWorkflowStatus): string {
  return status.replace("_", " ");
}

function statusTone(status: ReviewWorkflowStatus): Tone {
  switch (status) {
    case "open":
      return "default";
    case "acknowledged":
    case "in_review":
      return "primary";
    case "resolved":
      return "success";
    case "dismissed":
      return "warning";
  }
}
