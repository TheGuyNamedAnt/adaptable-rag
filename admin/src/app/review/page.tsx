import Link from "next/link";
import { ClipboardCheck, History, RadioTower, RefreshCw, ShieldAlert } from "lucide-react";
import {
  EmptyState,
  ErrorBanner,
  IconLink,
  MetricCard,
  NoticeBanner,
  PageGuide,
  PageHeader,
  SectionCard,
  StatusPill,
  type Tone
} from "@/components/ui";
import { ReviewQueueActions } from "@/components/ReviewQueueActions";
import {
  getReviewQueue,
  type ReviewQueueItem,
  type ReviewQueueKind,
  type ReviewQueuePriority,
  type ReviewQueueResult,
  type ReviewQueueSource,
  type ReviewQueueSourceStatus
} from "@/lib/review-queue";
import type { ReviewWorkflowStatus } from "@/lib/review-workflow-types";
import { formatNumber, formatTime, statusTone, truncateMiddle } from "@/lib/format";

type SearchParams = Record<string, string | string[] | undefined>;

const QUEUE_KINDS: readonly ReviewQueueKind[] = [
  "answer",
  "rejected_evidence",
  "ingestion",
  "connector",
  "eval",
  "operations"
];

const QUEUE_PRIORITIES: readonly ReviewQueuePriority[] = ["high", "medium", "low"];

export default async function ReviewPage({
  searchParams
}: {
  searchParams?: SearchParams | Promise<SearchParams>;
}) {
  const params = (await searchParams) ?? {};
  const kind = reviewKindParam(firstParam(params.kind));
  const priority = priorityParam(firstParam(params.priority));
  const queue = await safeReviewQueue();
  const filteredItems = queue.items.filter(
    (item) => (!kind || item.kind === kind) && (!priority || item.priority === priority)
  );

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Run"
        title="Review Work"
        description="Human decisions for failed answers, refused answers, rejected evidence, ingestion failures, connector failures, and eval issues."
        actions={
          <div className="flex items-center gap-2">
            <IconLink href="/review/history" icon={History} label="History" />
            <IconLink href="/review/sync" icon={RadioTower} label="Sync" />
            <IconLink href={reviewHref({ kind, priority })} icon={RefreshCw} label="Refresh" />
          </div>
        }
      />

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">
        {queue.status === "degraded" ? (
          <ErrorBanner message="Review queue is degraded because one or more inspection sources are unavailable." />
        ) : null}
        {queue.status === "open" ? (
          <NoticeBanner
            title="Open review items"
            message="These items need operator review before treating this deployment as production-clean."
          />
        ) : null}

        <PageGuide
          title="Use this to decide what needs a human"
          description="Review Work combines failed answers, refused answers, rejected evidence, ingestion failures, connector failures, and eval issues into one operator queue."
          steps={[
            "Handle high-priority items first.",
            "Assign or acknowledge items you are actively investigating.",
            "Use Sync when decisions need an external ticket handoff."
          ]}
          tone={
            queue.status === "degraded" ? "error" : queue.status === "open" ? "warning" : "primary"
          }
        />

        <SectionCard
          title="Queue Summary"
          description={`Generated ${formatTime(queue.generatedAt)}`}
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-9">
            <MetricCard label="Status" value={queue.status} tone={queueStatusTone(queue.status)} />
            <MetricCard
              label="Open items"
              value={formatNumber(queue.summary.itemCount)}
              tone={queue.summary.itemCount ? "warning" : "success"}
            />
            <MetricCard
              label="High"
              value={formatNumber(queue.summary.highCount)}
              tone={queue.summary.highCount ? "error" : "default"}
            />
            <MetricCard
              label="Medium"
              value={formatNumber(queue.summary.mediumCount)}
              tone={queue.summary.mediumCount ? "warning" : "default"}
            />
            <MetricCard label="Low" value={formatNumber(queue.summary.lowCount)} />
            <MetricCard
              label="In review"
              value={formatNumber(queue.summary.inReviewCount)}
              tone={queue.summary.inReviewCount ? "primary" : "default"}
            />
            <MetricCard
              label="Acknowledged"
              value={formatNumber(queue.summary.acknowledgedCount)}
              tone={queue.summary.acknowledgedCount ? "primary" : "default"}
            />
            <MetricCard
              label="Closed hidden"
              value={formatNumber(queue.summary.hiddenClosedCount)}
              tone={queue.summary.hiddenClosedCount ? "success" : "default"}
            />
            <MetricCard
              label="Unavailable sources"
              value={formatNumber(queue.summary.unavailableSourceCount)}
              tone={queue.summary.unavailableSourceCount ? "error" : "default"}
            />
          </div>
        </SectionCard>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <SectionCard
              title="Open Work"
              description="Rows contain safe ids, hashes, counts, stages, and redacted operational errors only."
            >
              <div className="mb-4 space-y-3">
                <div className="hide-scrollbar flex gap-2 overflow-x-auto pb-1">
                  <FilterChip label="All types" href={reviewHref({ priority })} active={!kind} />
                  {QUEUE_KINDS.map((nextKind) => (
                    <FilterChip
                      key={nextKind}
                      label={kindLabel(nextKind)}
                      href={reviewHref({ kind: nextKind, priority })}
                      active={kind === nextKind}
                    />
                  ))}
                </div>
                <div className="hide-scrollbar flex gap-2 overflow-x-auto pb-1">
                  <FilterChip
                    label="All priorities"
                    href={reviewHref({ kind })}
                    active={!priority}
                  />
                  {QUEUE_PRIORITIES.map((nextPriority) => (
                    <FilterChip
                      key={nextPriority}
                      label={nextPriority}
                      href={reviewHref({ kind, priority: nextPriority })}
                      active={priority === nextPriority}
                    />
                  ))}
                </div>
              </div>

              {filteredItems.length === 0 ? (
                <EmptyState
                  title={queue.items.length === 0 ? "No open review items" : "No matching items"}
                  detail={
                    queue.items.length === 0
                      ? "The currently connected review sources do not have failed, refused, rejected, or warning records."
                      : "Clear filters or choose a different queue type."
                  }
                  actionHref={queue.items.length === 0 ? "/answer-lab" : "/review"}
                  actionLabel={queue.items.length === 0 ? "Open Test Answer" : "Clear Filters"}
                />
              ) : (
                <div className="space-y-3">
                  {filteredItems.map((item) => (
                    <ReviewItemCard key={item.id} item={item} />
                  ))}
                </div>
              )}
            </SectionCard>
          </div>

          <aside className="space-y-4">
            <SectionCard
              title="Source Coverage"
              description="Queue inputs and whether they are currently inspectable."
            >
              <div className="space-y-2">
                {queue.sources.map((source) => (
                  <SourceCoverageRow key={source.id} source={source} />
                ))}
              </div>
            </SectionCard>

            <SectionCard title="Operator Rules" description="What belongs in this queue.">
              <div className="space-y-2 text-sm leading-5 text-text-secondary">
                <RuleRow label="Answer failures" value="high" />
                <RuleRow label="Refused answers" value="medium" />
                <RuleRow label="Rejected evidence" value="medium" />
                <RuleRow label="Failed ingestion docs" value="high" />
                <RuleRow label="Connector failures" value="high" />
                <RuleRow label="Eval failures" value="high" />
                <div className="rounded-lg border border-card bg-background p-3">
                  The queue does not display document bodies, prompts, answer text, provider
                  payloads, API keys, or raw connector content.
                </div>
              </div>
            </SectionCard>

            <SectionCard
              title="Workflow Controls"
              description="Persisted operator decisions for the open queue."
            >
              <div className="space-y-2">
                <NextControlRow
                  icon={ClipboardCheck}
                  label="Assignment"
                  detail="Owner and status per review item"
                />
                <NextControlRow
                  icon={ShieldAlert}
                  label="Acknowledgement"
                  detail="Stored separately from source evidence"
                />
                <Link
                  href="/review/history"
                  className="block rounded-lg border border-card bg-background p-3 text-sm text-text-secondary hover:border-primary/30 hover:text-text-primary"
                >
                  Review history
                </Link>
                <Link
                  href="/review/sync"
                  className="block rounded-lg border border-card bg-background p-3 text-sm text-text-secondary hover:border-primary/30 hover:text-text-primary"
                >
                  Review sync
                </Link>
              </div>
            </SectionCard>
          </aside>
        </div>
      </main>
    </div>
  );
}

function ReviewItemCard({ item }: { readonly item: ReviewQueueItem }) {
  const reviewStatus = item.reviewStatus ?? "open";
  return (
    <div className="rounded-lg border border-card bg-background p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill label={kindLabel(item.kind)} tone="primary" />
            <StatusPill label={item.priority} tone={priorityTone(item.priority)} />
            <StatusPill label={item.status} tone={statusTone(item.status)} />
            <StatusPill label={`review: ${reviewStatus}`} tone={reviewStatusTone(reviewStatus)} />
          </div>
          <div className="mt-2 font-medium">{item.title}</div>
          <p className="mt-1 text-sm leading-5 text-text-secondary">{item.detail}</p>
        </div>
        <Link
          href={item.href}
          className="inline-flex min-h-9 shrink-0 items-center rounded-lg border border-card px-3 py-2 text-sm text-text-secondary hover:border-primary/30 hover:text-text-primary"
        >
          {item.actionLabel}
        </Link>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <FactGroup title="Scope" facts={item.scope} />
        <FactGroup title="Signals" facts={item.signals} />
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-xs text-text-muted">
        {item.primaryId ? <span>ID: {truncateMiddle(item.primaryId, 58)}</span> : null}
        {item.secondaryId ? <span>Related: {truncateMiddle(item.secondaryId, 58)}</span> : null}
        {item.occurredAt ? <span>Updated: {formatTime(item.occurredAt)}</span> : null}
        {item.workflow ? (
          <span>
            Reviewed: {formatTime(item.workflow.updatedAt)} by {item.workflow.updatedBy}
          </span>
        ) : null}
      </div>

      <ReviewQueueActions
        itemId={item.id}
        reviewStatus={reviewStatus}
        {...(item.workflow ? { workflow: item.workflow } : {})}
      />
    </div>
  );
}

function FactGroup({
  title,
  facts
}: {
  readonly title: string;
  readonly facts: readonly {
    readonly label: string;
    readonly value: string;
    readonly tone?: Tone;
  }[];
}) {
  return (
    <div className="rounded-md border border-card bg-card/40 p-2">
      <div className="mb-2 text-xs font-medium uppercase tracking-[0.08em] text-text-muted">
        {title}
      </div>
      {facts.length === 0 ? (
        <div className="text-xs text-text-muted">none</div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {facts.map((fact) => (
            <span
              key={`${fact.label}:${fact.value}`}
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-card bg-background px-2 py-1 text-xs text-text-secondary"
            >
              <span className="text-text-muted">{fact.label}</span>
              <span className={fact.tone ? toneText(fact.tone) : "truncate"}>
                {truncateMiddle(fact.value, 52)}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SourceCoverageRow({ source }: { readonly source: ReviewQueueSource }) {
  return (
    <Link
      href={source.href}
      className="block rounded-lg border border-card bg-background p-3 hover:border-primary/30"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">{source.label}</div>
          <div className="mt-1 text-xs leading-5 text-text-muted">{source.detail}</div>
        </div>
        <StatusPill label={source.status} tone={sourceStatusTone(source.status)} />
      </div>
      <div className="mt-2 text-xs text-text-secondary">
        {formatNumber(source.itemCount)} queue item(s)
      </div>
    </Link>
  );
}

function RuleRow({
  label,
  value
}: {
  readonly label: string;
  readonly value: ReviewQueuePriority;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-card bg-background p-3">
      <span>{label}</span>
      <StatusPill label={value} tone={priorityTone(value)} />
    </div>
  );
}

function NextControlRow({
  icon: Icon,
  label,
  detail
}: {
  readonly icon: typeof ClipboardCheck;
  readonly label: string;
  readonly detail: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-card bg-background p-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-text-muted">{detail}</span>
      </span>
    </div>
  );
}

function FilterChip({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`shrink-0 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
        active
          ? "border-text-primary bg-text-primary text-white"
          : "border-card bg-surface text-text-secondary hover:border-primary/30"
      }`}
    >
      {label}
    </Link>
  );
}

async function safeReviewQueue(): Promise<ReviewQueueResult> {
  try {
    return await getReviewQueue();
  } catch (error) {
    const detail =
      error instanceof Error && error.message.trim()
        ? error.message.slice(0, 1200)
        : "Review queue failed.";
    return {
      generatedAt: new Date().toISOString(),
      status: "degraded",
      summary: {
        itemCount: 1,
        highCount: 1,
        mediumCount: 0,
        lowCount: 0,
        acknowledgedCount: 0,
        inReviewCount: 0,
        hiddenClosedCount: 0,
        unavailableSourceCount: 1
      },
      sources: [
        {
          id: "operations",
          label: "Review queue",
          status: "unavailable",
          itemCount: 1,
          detail,
          href: "/admin-ops"
        }
      ],
      items: [
        {
          id: "review_queue_failed",
          kind: "operations",
          priority: "high",
          status: "failed",
          title: "Review queue failed",
          detail,
          href: "/admin-ops",
          actionLabel: "Inspect Diagnostics",
          scope: [{ label: "Surface", value: "review queue" }],
          signals: []
        }
      ]
    };
  }
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function reviewKindParam(value: string | undefined): ReviewQueueKind | undefined {
  return value && QUEUE_KINDS.includes(value as ReviewQueueKind)
    ? (value as ReviewQueueKind)
    : undefined;
}

function priorityParam(value: string | undefined): ReviewQueuePriority | undefined {
  return value && QUEUE_PRIORITIES.includes(value as ReviewQueuePriority)
    ? (value as ReviewQueuePriority)
    : undefined;
}

function reviewHref(input: {
  readonly kind?: ReviewQueueKind;
  readonly priority?: ReviewQueuePriority;
}): string {
  const params = new URLSearchParams();
  if (input.kind) params.set("kind", input.kind);
  if (input.priority) params.set("priority", input.priority);
  const query = params.toString();
  return query ? `/review?${query}` : "/review";
}

function kindLabel(kind: ReviewQueueKind): string {
  switch (kind) {
    case "answer":
      return "Answer";
    case "rejected_evidence":
      return "Rejected evidence";
    case "ingestion":
      return "Ingestion";
    case "connector":
      return "Connector";
    case "eval":
      return "Eval";
    case "operations":
      return "Operations";
  }
}

function queueStatusTone(status: ReviewQueueResult["status"]): Tone {
  if (status === "empty") return "success";
  if (status === "degraded") return "error";
  return "warning";
}

function sourceStatusTone(status: ReviewQueueSourceStatus): Tone {
  if (status === "available") return "success";
  if (status === "unavailable") return "error";
  return "default";
}

function reviewStatusTone(status: ReviewWorkflowStatus): Tone {
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

function priorityTone(priority: ReviewQueuePriority): Tone {
  if (priority === "high") return "error";
  if (priority === "medium") return "warning";
  return "default";
}

function toneText(tone: Tone): string {
  switch (tone) {
    case "primary":
      return "truncate text-primary";
    case "success":
      return "truncate text-success";
    case "warning":
      return "truncate text-warning";
    case "error":
      return "truncate text-error";
    case "default":
      return "truncate";
  }
}
