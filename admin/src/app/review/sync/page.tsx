import Link from "next/link";
import { ClipboardList, History, RefreshCw } from "lucide-react";
import {
  CollapsibleSection,
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
import { ReviewSyncRunButton } from "@/components/ReviewSyncRunButton";
import {
  getAdminReviewSyncArtifactStatus,
  type AdminReviewSyncArtifactStatus,
  type AdminReviewSyncSummary,
  type ReviewSyncArtifactState
} from "@/lib/review-sync-artifacts";
import { formatNumber, formatTime, statusTone } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ReviewSyncPage() {
  const status = await safeReviewSyncStatus();
  const syncSummary = status.syncArtifact.summary;
  const reconciliationSummary = status.reconciliationArtifact.summary;

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Run"
        title="Review Sync"
        description="Export admin review decisions, prove ticket payload shape, and reconcile idempotency before wiring a live company ticket sink."
        actions={
          <div className="flex items-center gap-2">
            <IconLink href="/review" icon={ClipboardList} label="Open Queue" />
            <IconLink href="/review/history" icon={History} label="History" />
            <IconLink href="/review/sync" icon={RefreshCw} label="Refresh" />
          </div>
        }
      />

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">
        {status.status === "failed" ? (
          <ErrorBanner message="Review sync artifacts are invalid. Inspect the artifact paths below and rerun dry-run sync after fixing the bad file." />
        ) : null}
        {status.status === "empty" || status.status === "partial" ? (
          <NoticeBanner
            title="Sync artifacts incomplete"
            message="Run a dry-run sync to build the admin review export, ticket payloads, sync report, and reconciliation store."
          />
        ) : null}

        <PageGuide
          title="Use this before sending review work to another system"
          description="Review Sync proves ticket payload shape, dry-run handoff status, and idempotency before a live ticket sink is connected. It is intentionally artifact-first."
          steps={[
            "Run dry-run sync after queue decisions change.",
            "Check failed and duplicate counts.",
            "Only wire a live sink after reconciliation is clean."
          ]}
          tone={
            status.status === "failed"
              ? "error"
              : status.status === "empty" || status.status === "partial"
                ? "warning"
                : "primary"
          }
        />

        <SectionCard
          title="Handoff Summary"
          description={`Generated ${formatTime(status.generatedAt)}`}
          action={<ReviewSyncRunButton />}
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-9">
            <MetricCard label="Status" value={status.status} tone={statusTone(status.status)} />
            <MetricCard
              label="Export tickets"
              value={formatNumber(status.exportArtifact.summary?.exportedTicketCount)}
              tone={ticketTone(status.exportArtifact.summary?.exportedTicketCount)}
            />
            <MetricCard
              label="Sync status"
              value={syncSummary?.status ?? "missing"}
              tone={statusTone(syncSummary?.status)}
            />
            <MetricCard
              label="Synced"
              value={formatNumber(syncSummary?.syncedTicketCount)}
              tone={syncSummary?.syncedTicketCount ? "success" : "default"}
            />
            <MetricCard
              label="Skipped"
              value={formatNumber(syncSummary?.skippedTicketCount)}
              tone={syncSummary?.skippedTicketCount ? "warning" : "default"}
            />
            <MetricCard
              label="Failed"
              value={formatNumber(syncSummary?.failedTicketCount)}
              tone={syncSummary?.failedTicketCount ? "error" : "default"}
            />
            <MetricCard
              label="Reconciliation"
              value={reconciliationSummary?.status ?? "missing"}
              tone={statusTone(reconciliationSummary?.status)}
            />
            <MetricCard
              label="Duplicates"
              value={formatNumber(reconciliationSummary?.duplicateCount)}
              tone={reconciliationSummary?.duplicateCount ? "error" : "default"}
            />
            <MetricCard
              label="External refs"
              value={formatNumber(reconciliationSummary?.externalRefCount)}
            />
          </div>
        </SectionCard>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-4">
            <SectionCard
              title="Pipeline Artifacts"
              description="Operator-visible status for export, sync, and reconciliation artifacts. Paths are repo-relative."
            >
              <div className="space-y-2">
                <ArtifactRow
                  title="Admin review export"
                  artifact={status.exportArtifact}
                  detail={
                    status.exportArtifact.summary
                      ? `${formatNumber(status.exportArtifact.summary.exportedDecisionCount)} decisions · ${formatNumber(status.exportArtifact.summary.queueSnapshotCount)} queue snapshots`
                      : undefined
                  }
                />
                <ArtifactRow
                  title="Ticket payloads"
                  artifact={status.ticketsArtifact}
                  detail={
                    status.ticketsArtifact.summary
                      ? `${formatNumber(status.ticketsArtifact.summary.ticketCount)} tickets · ${status.ticketsArtifact.summary.operations.join(", ") || "no operations"}`
                      : undefined
                  }
                />
                <ArtifactRow
                  title="Dry-run sync report"
                  artifact={status.syncArtifact}
                  detail={syncDetail(status.syncArtifact.summary)}
                />
                <ArtifactRow
                  title="Reconciliation report"
                  artifact={status.reconciliationArtifact}
                  detail={
                    reconciliationSummary
                      ? `${formatNumber(reconciliationSummary.skippedCount)} skipped · ${formatNumber(reconciliationSummary.pendingCount)} pending · ${formatNumber(reconciliationSummary.failedCount)} failed`
                      : undefined
                  }
                />
              </div>
            </SectionCard>

            <SectionCard
              title="Warnings And Errors"
              description="Only operational summaries are shown here. Raw ticket bodies and source text stay in artifacts."
            >
              {status.warnings.length === 0 && status.errors.length === 0 ? (
                <EmptyState
                  title="No warnings or errors"
                  detail="The latest artifact set is clean."
                />
              ) : (
                <div className="space-y-2">
                  {status.errors.map((error) => (
                    <IssueRow key={error} tone="error" label="Error" value={error} />
                  ))}
                  {status.warnings.map((warning) => (
                    <IssueRow key={warning} tone="warning" label="Warning" value={warning} />
                  ))}
                </div>
              )}
            </SectionCard>
          </div>

          <aside className="space-y-4">
            <SectionCard title="Company Sink Readiness" description="What this page proves today.">
              <div className="space-y-2 text-sm leading-5 text-text-secondary">
                <ReadinessRow label="Stable ids" value="queue item + decision dedupe keys" />
                <ReadinessRow label="Privacy" value="hashes and bounded operational summaries" />
                <ReadinessRow label="Retries" value="idempotency store preserves first seen keys" />
                <ReadinessRow label="Live sink" value="CLI/webhook connector handles real sends" />
                <Link
                  href="/api/rag/review/sync"
                  className="block rounded-lg border border-card bg-background p-3 text-sm text-text-secondary hover:border-primary/30 hover:text-text-primary"
                >
                  Open sync status JSON
                </Link>
              </div>
            </SectionCard>

            <CollapsibleSection
              title="Evidence Boundary"
              description="Privacy and evidence limits for this dry-run sink."
            >
              <div className="space-y-2">
                {status.evidenceBoundary.map((entry) => (
                  <div
                    key={entry}
                    className="rounded-lg border border-card bg-background p-3 text-sm leading-5 text-text-secondary"
                  >
                    {entry}
                  </div>
                ))}
              </div>
            </CollapsibleSection>

            <CollapsibleSection
              title="Artifact Files"
              description="Repo-relative files used by export, dry-run sync, and reconciliation."
              defaultOpen={status.status === "failed"}
            >
              <div className="space-y-2">
                {Object.entries(status.artifactPaths).map(([key, value]) => (
                  <div key={key} className="rounded-lg border border-card bg-background p-3">
                    <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted">
                      {artifactLabel(key)}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-text-secondary">
                      {value}
                    </div>
                  </div>
                ))}
              </div>
            </CollapsibleSection>
          </aside>
        </div>
      </main>
    </div>
  );
}

async function safeReviewSyncStatus(): Promise<AdminReviewSyncArtifactStatus> {
  try {
    return await getAdminReviewSyncArtifactStatus();
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim()
        ? error.message.slice(0, 1200)
        : "Review sync status is unavailable.";
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      status: "failed",
      exportArtifact: {
        status: "invalid",
        path: ".rag/admin-review-export/latest/export.json",
        error: message
      },
      ticketsArtifact: {
        status: "missing",
        path: ".rag/admin-review-export/latest/tickets.json"
      },
      syncArtifact: {
        status: "missing",
        path: ".rag/review-sync/admin-ui/sync.json"
      },
      reconciliationArtifact: {
        status: "missing",
        path: ".rag/review-reconciliation/admin-ui/reconciliation.json"
      },
      artifactPaths: {
        exportJson: ".rag/admin-review-export/latest/export.json",
        exportMarkdown: ".rag/admin-review-export/latest/export.md",
        ticketsJson: ".rag/admin-review-export/latest/tickets.json",
        syncTicketsJson: ".rag/review-sync/admin-ui/tickets.json",
        syncJson: ".rag/review-sync/admin-ui/sync.json",
        syncMarkdown: ".rag/review-sync/admin-ui/sync.md",
        idempotencyStoreJson: ".rag/review-reconciliation/admin-ui/idempotency-store.json",
        reconciliationJson: ".rag/review-reconciliation/admin-ui/reconciliation.json",
        reconciliationMarkdown: ".rag/review-reconciliation/admin-ui/reconciliation.md"
      },
      warnings: [],
      errors: [message],
      evidenceBoundary: [
        "Review sync status failed before artifact summaries could be loaded.",
        "No source document text, prompt text, provider payload, or credential value is returned."
      ]
    };
  }
}

function ArtifactRow({
  title,
  artifact,
  detail
}: {
  readonly title: string;
  readonly artifact: ReviewSyncArtifactState<unknown>;
  readonly detail?: string;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-card bg-background p-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill label={artifact.status} tone={artifactTone(artifact.status)} />
          <span className="font-medium">{title}</span>
        </div>
        <div className="mt-1 break-all font-mono text-xs text-text-muted">{artifact.path}</div>
        {detail ? <div className="mt-1 text-sm text-text-secondary">{detail}</div> : null}
        {artifact.error ? <div className="mt-1 text-sm text-error">{artifact.error}</div> : null}
      </div>
      <div className="text-xs text-text-muted">{formatTime(artifact.updatedAt)}</div>
    </div>
  );
}

function IssueRow({ tone, label, value }: { tone: Tone; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-card bg-background p-3 text-sm">
      <StatusPill label={label} tone={tone} />
      <div className="mt-2 leading-5 text-text-secondary">{value}</div>
    </div>
  );
}

function ReadinessRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-card bg-background p-3">
      <span className="text-text-muted">{label}</span>
      <span className="text-right font-medium text-text-primary">{value}</span>
    </div>
  );
}

function artifactTone(status: string): Tone {
  switch (status) {
    case "available":
      return "success";
    case "missing":
      return "warning";
    case "invalid":
      return "error";
    default:
      return "default";
  }
}

function ticketTone(value: number | undefined): Tone {
  if (value === undefined) return "default";
  return value > 0 ? "primary" : "warning";
}

function syncDetail(summary: AdminReviewSyncSummary | undefined): string | undefined {
  if (!summary) return undefined;
  return `${formatNumber(summary.ticketCount)} tickets · ${formatNumber(summary.skippedTicketCount)} skipped · ${formatNumber(summary.failedTicketCount)} failed`;
}

function artifactLabel(value: string): string {
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
}
