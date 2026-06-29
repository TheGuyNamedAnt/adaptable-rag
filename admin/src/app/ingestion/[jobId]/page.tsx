import Link from "next/link";
import { ArrowLeft, ExternalLink, RefreshCw } from "lucide-react";
import {
  EmptyState,
  ErrorBanner,
  IconLink,
  MetricCard,
  PageGuide,
  PageHeader,
  SectionCard,
  StatusPill
} from "@/components/ui";
import {
  formatDurationMs,
  formatNumber,
  formatTime,
  statusTone,
  truncateMiddle
} from "@/lib/format";
import { getIngestionJobDetail } from "@/lib/rag-admin-api";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function IngestionJobPage({
  params,
  searchParams
}: {
  params: { jobId: string } | Promise<{ jobId: string }>;
  searchParams?: SearchParams | Promise<SearchParams>;
}) {
  const { jobId } = await params;
  const resolvedSearchParams = (await searchParams) ?? {};
  const documentStatus = allParams(resolvedSearchParams.documentStatus);
  const sourceId = firstParam(resolvedSearchParams.sourceId);
  const documentOffset = nonNegativeParam(firstParam(resolvedSearchParams.documentOffset)) ?? 0;
  const checkpointOffset = nonNegativeParam(firstParam(resolvedSearchParams.checkpointOffset)) ?? 0;
  const detailResult = await getIngestionJobDetail(jobId, {
    sourceId,
    documentStatus,
    documentOffset,
    checkpointOffset,
    documentLimit: 50,
    checkpointLimit: 20
  });
  const detail = detailResult.data;
  const summary = detail?.summary;
  const guideTone =
    summary?.failed === true
      ? "error"
      : detail?.counts.failedDocumentCount
        ? "warning"
        : detail
          ? "primary"
          : "warning";

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Ingestion"
        title={truncateMiddle(jobId, 72)}
        description="Job summary, source progress, checkpoints, and document-level rejection state."
        actions={
          <>
            <IconLink href="/ingestion" icon={ArrowLeft} label="Jobs" />
            <IconLink
              href={jobHref(jobId, { sourceId, documentStatus, documentOffset, checkpointOffset })}
              icon={RefreshCw}
              label="Refresh"
            />
          </>
        }
      />

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">
        <PageGuide
          title="Use this to find where ingestion stopped"
          description="A job detail page narrows one ingestion run down to source progress, document status, checkpoints, and failure stages. It is the fastest place to separate parser, chunking, embedding, indexing, and graph failures."
          steps={[
            "Start with status and current stage.",
            "Filter documents by failed or skipped.",
            "Use checkpoints when the job stopped mid-stage."
          ]}
          tone={guideTone}
        />
        {detailResult.status === "unavailable" ? (
          <ErrorBanner message={detailResult.error ?? "Ingestion job is unavailable."} />
        ) : null}
        {!detail || !summary ? (
          <EmptyState
            title="Job details unavailable"
            detail="The admin app could not load this job from the configured Postgres-backed inspection store."
            actionHref="/ingestion"
            actionLabel="Back to Runs"
          />
        ) : (
          <>
            <SectionCard
              title="Run Summary"
              description={`${summary.tenantId} · ${summary.namespaceId} · ${summary.sourceIds.length} source(s)`}
              action={<StatusPill label={summary.status} tone={statusTone(summary.status)} />}
            >
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
                <MetricCard label="Stage" value={summary.stage} tone={statusTone(summary.stage)} />
                <MetricCard label="Attempt" value={summary.attempt} />
                <MetricCard label="Duration" value={formatDurationMs(summary.durationMs)} />
                <MetricCard
                  label="Failed docs"
                  value={formatNumber(detail.counts.failedDocumentCount)}
                  tone={detail.counts.failedDocumentCount ? "error" : "default"}
                />
                <MetricCard
                  label="Skipped docs"
                  value={formatNumber(detail.counts.skippedDocumentCount)}
                  tone={detail.counts.skippedDocumentCount ? "warning" : "default"}
                />
                <MetricCard
                  label="Retryable"
                  value={formatNumber(detail.counts.retryableFailureCount)}
                  tone={detail.counts.retryableFailureCount ? "warning" : "default"}
                />
              </div>
              <div className="mt-3 grid gap-2 text-xs text-text-muted md:grid-cols-3">
                <div>Requested: {formatTime(summary.requestedAt)}</div>
                <div>Started: {formatTime(summary.startedAt)}</div>
                <div>Updated: {formatTime(summary.updatedAt)}</div>
              </div>
              {summary.errorMessage ? (
                <div className="mt-3 rounded-lg border border-error/20 bg-error/10 p-3 text-sm text-error">
                  {summary.errorName ? `${summary.errorName}: ` : null}
                  {summary.errorMessage}
                </div>
              ) : null}
            </SectionCard>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="space-y-4">
                <SectionCard
                  title="Document Progress"
                  description="Only safe ids, statuses, chunk counts, and failure stage metadata are shown."
                >
                  <div className="hide-scrollbar mb-4 flex gap-2 overflow-x-auto pb-1">
                    <FilterChip
                      label="All"
                      href={jobHref(jobId, { sourceId })}
                      active={documentStatus.length === 0}
                    />
                    {["failed", "skipped", "accepted", "indexing", "embedding", "chunking"].map(
                      (status) => (
                        <FilterChip
                          key={status}
                          label={status}
                          href={jobHref(jobId, { sourceId, documentStatus: [status] })}
                          active={documentStatus.length === 1 && documentStatus[0] === status}
                        />
                      )
                    )}
                  </div>

                  {detail.documents.length === 0 ? (
                    <EmptyState
                      title="No documents in this page"
                      detail="Adjust the status/source filters or move to the next page when more documents are available."
                      actionHref={jobHref(jobId, { sourceId })}
                      actionLabel="Clear Filters"
                    />
                  ) : (
                    <div className="max-w-full overflow-x-auto">
                      <table className="w-full min-w-[900px] text-left text-sm">
                        <thead className="border-b border-card text-xs uppercase tracking-[0.08em] text-text-muted">
                          <tr>
                            <th className="px-2 py-2 font-medium">Document</th>
                            <th className="px-2 py-2 font-medium">Status</th>
                            <th className="px-2 py-2 font-medium">Source</th>
                            <th className="px-2 py-2 font-medium">Chunks</th>
                            <th className="px-2 py-2 font-medium">Failure</th>
                            <th className="px-2 py-2 font-medium">Updated</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-card">
                          {detail.documents.map((document) => (
                            <tr
                              key={`${document.sourceId}-${document.documentId}`}
                              className="hover:bg-card/50"
                            >
                              <td className="px-2 py-3 font-medium">
                                {truncateMiddle(document.documentId, 56)}
                              </td>
                              <td className="px-2 py-3">
                                <StatusPill
                                  label={document.status}
                                  tone={statusTone(document.status)}
                                />
                              </td>
                              <td className="px-2 py-3 text-text-secondary">
                                {truncateMiddle(document.sourceId, 42)}
                              </td>
                              <td className="px-2 py-3 text-text-secondary">
                                {document.chunkCount}
                              </td>
                              <td className="px-2 py-3 text-text-muted">
                                {document.failureStage ? (
                                  <span>
                                    {document.failureStage}
                                    {document.failurePhase ? ` · ${document.failurePhase}` : ""}
                                    {document.retryable ? " · retryable" : ""}
                                  </span>
                                ) : (
                                  "none"
                                )}
                              </td>
                              <td className="px-2 py-3 text-text-muted">
                                {formatTime(document.updatedAt)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <Pagination
                    previousHref={
                      documentOffset > 0
                        ? jobHref(jobId, {
                            sourceId,
                            documentStatus,
                            documentOffset: Math.max(0, documentOffset - 50),
                            checkpointOffset
                          })
                        : undefined
                    }
                    nextHref={
                      detail.page.documentHasMore
                        ? jobHref(jobId, {
                            sourceId,
                            documentStatus,
                            documentOffset: documentOffset + 50,
                            checkpointOffset
                          })
                        : undefined
                    }
                  />
                </SectionCard>
              </div>

              <aside className="space-y-4">
                <SectionCard
                  title="Sources"
                  description="Per-source progress for this job."
                  action={
                    <Link
                      className="inline-flex items-center gap-1 text-sm font-medium text-primary"
                      href={`/sources?jobId=${encodeURIComponent(jobId)}`}
                    >
                      Health <ExternalLink className="h-3.5 w-3.5" />
                    </Link>
                  }
                >
                  <div className="space-y-2">
                    {detail.sources.length === 0 ? (
                      <EmptyState
                        title="No source progress"
                        detail="Source health appears after the job records per-source progress."
                        actionHref="/sources"
                        actionLabel="Open Sources"
                      />
                    ) : (
                      detail.sources.map((source) => (
                        <Link
                          key={source.sourceId}
                          href={jobHref(jobId, { sourceId: source.sourceId, documentStatus })}
                          className={`block rounded-lg border p-3 ${sourceId === source.sourceId ? "border-text-primary bg-text-primary text-white" : "border-card bg-background hover:border-primary/30"}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="truncate text-sm font-medium">{source.sourceId}</div>
                            <StatusPill label={source.status} tone={statusTone(source.status)} />
                          </div>
                          <div
                            className={`mt-2 grid grid-cols-3 gap-2 text-xs ${sourceId === source.sourceId ? "text-white/75" : "text-text-muted"}`}
                          >
                            <span>{source.acceptedDocumentCount} accepted</span>
                            <span>{source.failedDocumentCount} failed</span>
                            <span>{source.skippedDocumentCount} skipped</span>
                          </div>
                        </Link>
                      ))
                    )}
                  </div>
                </SectionCard>

                <SectionCard
                  title="Checkpoints"
                  description={
                    summary.currentCheckpointPhase
                      ? `Current phase: ${summary.currentCheckpointPhase}`
                      : undefined
                  }
                >
                  <div className="space-y-2">
                    {detail.checkpoints.length === 0 ? (
                      <EmptyState title="No checkpoints in this page" />
                    ) : (
                      detail.checkpoints.map((checkpoint) => (
                        <div
                          key={checkpoint.checkpointId}
                          className="rounded-lg border border-card bg-background p-3"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-sm font-medium">#{checkpoint.sequence}</div>
                            <StatusPill
                              label={checkpoint.stage}
                              tone={statusTone(checkpoint.stage)}
                            />
                          </div>
                          <div className="mt-1 text-xs text-text-muted">
                            {formatTime(checkpoint.recordedAt)}
                          </div>
                          <div className="mt-2 truncate text-xs text-text-muted">
                            Keys: {Object.keys(checkpoint.checkpoint).sort().join(", ") || "none"}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                  <Pagination
                    previousHref={
                      checkpointOffset > 0
                        ? jobHref(jobId, {
                            sourceId,
                            documentStatus,
                            documentOffset,
                            checkpointOffset: Math.max(0, checkpointOffset - 20)
                          })
                        : undefined
                    }
                    nextHref={
                      detail.page.checkpointHasMore
                        ? jobHref(jobId, {
                            sourceId,
                            documentStatus,
                            documentOffset,
                            checkpointOffset: checkpointOffset + 20
                          })
                        : undefined
                    }
                  />
                </SectionCard>
              </aside>
            </div>
          </>
        )}
      </main>
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

function Pagination({ previousHref, nextHref }: { previousHref?: string; nextHref?: string }) {
  if (!previousHref && !nextHref) return null;
  return (
    <div className="mt-4 flex items-center justify-end gap-2">
      {previousHref ? (
        <Link
          className="rounded-lg border border-card bg-surface px-3 py-2 text-xs font-medium text-text-secondary hover:border-primary/30"
          href={previousHref}
        >
          Previous
        </Link>
      ) : null}
      {nextHref ? (
        <Link
          className="rounded-lg border border-card bg-surface px-3 py-2 text-xs font-medium text-text-secondary hover:border-primary/30"
          href={nextHref}
        >
          Next
        </Link>
      ) : null}
    </div>
  );
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function allParams(value: string | string[] | undefined): readonly string[] {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function nonNegativeParam(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function jobHref(
  jobId: string,
  input: {
    sourceId?: string;
    documentStatus?: readonly string[];
    documentOffset?: number;
    checkpointOffset?: number;
  } = {}
): string {
  const params = new URLSearchParams();
  if (input.sourceId) params.set("sourceId", input.sourceId);
  for (const status of input.documentStatus ?? []) params.append("documentStatus", status);
  if (input.documentOffset) params.set("documentOffset", String(input.documentOffset));
  if (input.checkpointOffset) params.set("checkpointOffset", String(input.checkpointOffset));
  const query = params.toString();
  return query
    ? `/ingestion/${encodeURIComponent(jobId)}?${query}`
    : `/ingestion/${encodeURIComponent(jobId)}`;
}
