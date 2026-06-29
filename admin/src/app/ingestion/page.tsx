import Link from "next/link";
import { FileUp, GitBranch, RefreshCw } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  EmptyState,
  ErrorBanner,
  IconLink,
  MetricCard,
  NoticeBanner,
  PageGuide,
  PageHeader,
  PrerequisiteChecklist,
  SectionCard,
  StatusPill,
  type Tone
} from "@/components/ui";
import { UploadCorpusPanel } from "@/components/UploadCorpusPanel";
import { formatNumber, formatTime, statusTone, truncateMiddle } from "@/lib/format";
import { getConnectorRegistry } from "@/lib/connector-registry";
import { getIngestionJobs, getOverview } from "@/lib/rag-admin-api";

type SearchParams = Record<string, string | string[] | undefined>;

const JOB_STATUSES = [
  "queued",
  "loading_source",
  "normalizing",
  "parsing",
  "chunking",
  "embedding",
  "indexing",
  "graph_extracting",
  "completed",
  "completed_with_warnings",
  "failed",
  "cancelled"
] as const;

export default async function IngestionPage({
  searchParams
}: {
  searchParams?: SearchParams | Promise<SearchParams>;
}) {
  const params = (await searchParams) ?? {};
  const status = firstParam(params.status);
  const tenantId = firstParam(params.tenantId);
  const namespaceId = firstParam(params.namespaceId);
  const limit = positiveParam(firstParam(params.limit)) ?? 50;
  const [jobsResult, overview, connectorRegistry] = await Promise.all([
    getIngestionJobs({ status, tenantId, namespaceId, limit }),
    getOverview(),
    getConnectorRegistry()
  ]);
  const jobs = jobsResult.data ?? [];
  const failedCount = jobs.filter((job) => job.status === "failed").length;
  const runningCount = jobs.filter(
    (job) => !["completed", "completed_with_warnings", "failed", "cancelled"].includes(job.status)
  ).length;
  const runtimeReady = overview.ready?.ready === true || overview.health?.status === "ready";
  const hasKnowledge =
    (overview.health?.index?.documentCount ?? 0) > 0 &&
    (overview.health?.index?.chunkCount ?? 0) > 0;
  const metadataGap =
    jobsResult.status === "unavailable" && isPostgresMetadataError(jobsResult.error);
  const uploadDisabledReason =
    jobsResult.status === "unavailable" && !metadataGap
      ? (jobsResult.error ?? "The CLI-backed ingestion path is unavailable.")
      : undefined;

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Run"
        title="Add Knowledge"
        description="Upload files or sync a connector, then see whether indexing finished."
        actions={
          <>
            <IconLink href="/connectors" icon={GitBranch} label="Connector setup" />
            <IconLink
              href={filterHref({ status, tenantId, namespaceId, limit })}
              icon={RefreshCw}
              label="Refresh"
            />
          </>
        }
      />

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">
        {metadataGap ? (
          <NoticeBanner
            title="Local intake mode"
            message="Upload still writes through the production ingestion path, but durable job history and source health need Postgres-backed ingestion metadata. Configure RAG_POSTGRES_URL for the company deployment view."
          />
        ) : jobsResult.status === "unavailable" ? (
          <ErrorBanner message={jobsResult.error ?? "Ingestion jobs are unavailable."} />
        ) : null}

        <PageGuide
          title="Use this to load or inspect knowledge"
          description="Add Knowledge is where documents enter the RAG system. Manual uploads and connector syncs both create source records, then ingestion turns them into normalized documents and chunks."
          steps={[
            "Choose upload or connector sync.",
            "Watch failed and running jobs first.",
            "Open a job when document-level failure reasons matter."
          ]}
          tone={failedCount ? "error" : runningCount ? "primary" : "primary"}
        />

        <PrerequisiteChecklist
          title="Data Intake Gates"
          description="These are the prerequisites before knowledge can be used downstream for answers, source health, and production checks."
          items={[
            {
              label: "Manual upload",
              status: uploadDisabledReason ? "blocked" : "warning",
              detail: uploadDisabledReason
                ? uploadDisabledReason
                : "Available, but the final upload action stays blocked until files and scope are selected.",
              actionHref: uploadDisabledReason ? "/storage" : undefined,
              actionLabel: uploadDisabledReason ? "Open Storage" : undefined
            },
            {
              label: "Connector sync",
              status: connectorRegistry.connectors.length > 0 ? "ready" : "warning",
              detail:
                connectorRegistry.connectors.length > 0
                  ? `${connectorRegistry.connectors.length.toLocaleString()} connector pack(s) are configured for sync.`
                  : "No connector packs are installed. Manual upload still works, but connector sync is setup-only.",
              actionHref: connectorRegistry.connectors.length > 0 ? "/connectors" : "/connectors",
              actionLabel:
                connectorRegistry.connectors.length > 0 ? "Open Connectors" : "Set Up Connectors"
            },
            {
              label: "Live answer service",
              status: runtimeReady ? "ready" : "warning",
              detail: runtimeReady
                ? "The RAG service can use indexed knowledge after ingestion finishes."
                : "Uploads can be staged through CLI ingestion, but Test Answer remains blocked until the service is online.",
              actionHref: runtimeReady ? undefined : "/storage",
              actionLabel: runtimeReady ? undefined : "Open Storage"
            },
            {
              label: "Indexed knowledge",
              status: hasKnowledge ? "ready" : "warning",
              detail: hasKnowledge
                ? `${overview.health?.index?.documentCount?.toLocaleString() ?? "n/a"} document(s) and ${overview.health?.index?.chunkCount?.toLocaleString() ?? "n/a"} chunk(s) are already indexed.`
                : "No indexed documents/chunks are visible yet. Upload or sync before testing answers."
            }
          ]}
        />

        <SectionCard
          title="Choose Intake Method"
          description="Both paths feed the same indexing pipeline. Use manual upload for local files; use connectors for repeatable company systems."
        >
          <div className="grid gap-2 md:grid-cols-2">
            <IntakeMethodCard
              href="#upload-knowledge"
              icon={FileUp}
              title="Upload files or folders"
              detail="Queue local files, assign source scope, and ingest them immediately."
              statusLabel={uploadDisabledReason ? "blocked" : "select files"}
              statusToneValue={uploadDisabledReason ? "error" : "warning"}
            />
            <IntakeMethodCard
              href="/connectors"
              icon={GitBranch}
              title="Sync a connector"
              detail="Use a configured company source system such as Drive, Slack, Notion, S3, or Zendesk."
              statusLabel={connectorRegistry.connectors.length > 0 ? "ready" : "setup required"}
              statusToneValue={connectorRegistry.connectors.length > 0 ? "success" : "warning"}
            />
          </div>
        </SectionCard>

        <div id="upload-knowledge">
          <UploadCorpusPanel
            defaultTenantId={tenantId ?? "tenant_1"}
            defaultNamespaceId={namespaceId ?? "generic-docs"}
            disabledReason={uploadDisabledReason}
          />
        </div>

        <SectionCard
          title="Ingestion Runs"
          description="Durable run history, checkpoints, failed documents, and stage counts."
        >
          <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <MetricCard label="Returned" value={formatNumber(jobs.length)} />
            <MetricCard
              label="Running"
              value={formatNumber(runningCount)}
              tone={runningCount ? "primary" : "default"}
            />
            <MetricCard
              label="Failed"
              value={formatNumber(failedCount)}
              tone={failedCount ? "error" : "default"}
            />
            <MetricCard label="Tenant" value={tenantId ?? "all"} />
            <MetricCard label="Namespace" value={namespaceId ?? "all"} />
          </div>

          <div className="hide-scrollbar mb-4 flex gap-2 overflow-x-auto pb-1">
            <FilterChip
              label="All"
              href={filterHref({ tenantId, namespaceId, limit })}
              active={!status}
            />
            {JOB_STATUSES.map((nextStatus) => (
              <FilterChip
                key={nextStatus}
                label={nextStatus}
                href={filterHref({ status: nextStatus, tenantId, namespaceId, limit })}
                active={status === nextStatus}
              />
            ))}
          </div>

          {jobs.length === 0 ? (
            <EmptyState
              title={
                jobsResult.status === "unavailable"
                  ? "Durable run history is not connected"
                  : "No ingestion runs found"
              }
              detail={
                jobsResult.status === "unavailable"
                  ? "The upload panel above is still available for local corpus intake. Production run history appears here after Postgres job metadata is configured."
                  : "Upload or sync a source, then accepted, skipped, failed, and checkpoint counts will appear here."
              }
              actionHref={jobsResult.status === "unavailable" ? "/storage" : "/sources"}
              actionLabel={
                jobsResult.status === "unavailable" ? "Open Storage" : "Review Knowledge Sources"
              }
            />
          ) : (
            <div className="max-w-full overflow-x-auto">
              <table className="w-full min-w-[940px] text-left text-sm">
                <thead className="border-b border-card text-xs uppercase tracking-[0.08em] text-text-muted">
                  <tr>
                    <th className="px-2 py-2 font-medium">Job</th>
                    <th className="px-2 py-2 font-medium">Status</th>
                    <th className="px-2 py-2 font-medium">Stage</th>
                    <th className="px-2 py-2 font-medium">Scope</th>
                    <th className="px-2 py-2 font-medium">Counts</th>
                    <th className="px-2 py-2 font-medium">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-card">
                  {jobs.map((job) => (
                    <tr key={job.jobId} className="hover:bg-card/50">
                      <td className="px-2 py-3">
                        <Link
                          className="font-medium text-text-primary hover:text-primary"
                          href={`/ingestion/${encodeURIComponent(job.jobId)}`}
                        >
                          {truncateMiddle(job.jobId, 48)}
                        </Link>
                        <div className="text-xs text-text-muted">
                          {truncateMiddle(job.runId, 58)}
                        </div>
                      </td>
                      <td className="px-2 py-3">
                        <StatusPill label={job.status} tone={statusTone(job.status)} />
                      </td>
                      <td className="px-2 py-3 text-text-secondary">{job.stage}</td>
                      <td className="px-2 py-3">
                        <div className="text-text-secondary">{job.tenantId}</div>
                        <div className="text-xs text-text-muted">{job.namespaceId}</div>
                      </td>
                      <td className="px-2 py-3 text-text-secondary">
                        <div>{job.sourceIds.length} source(s)</div>
                        <div className="text-xs text-text-muted">{countSummary(job.counts)}</div>
                      </td>
                      <td className="px-2 py-3 text-text-muted">{formatTime(job.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </main>
    </div>
  );
}

function IntakeMethodCard({
  href,
  icon: Icon,
  title,
  detail,
  statusLabel,
  statusToneValue
}: {
  readonly href: string;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly detail: string;
  readonly statusLabel?: string;
  readonly statusToneValue?: Tone;
}) {
  return (
    <Link
      href={href}
      className="group flex min-h-24 items-start gap-3 rounded-lg border border-card bg-background p-3 text-sm text-text-secondary hover:border-primary/30 hover:text-text-primary"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-card text-text-muted group-hover:text-primary">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block font-medium text-text-primary">{title}</span>
        <span className="mt-1 block text-xs leading-5 text-text-muted">{detail}</span>
        {statusLabel ? (
          <span className="mt-2 inline-flex">
            <StatusPill label={statusLabel} tone={statusToneValue ?? "default"} />
          </span>
        ) : null}
      </span>
    </Link>
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

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function positiveParam(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isPostgresMetadataError(error: string | undefined): boolean {
  return (error ?? "").toLowerCase().includes("postgres index storage");
}

function filterHref(input: {
  status?: string;
  tenantId?: string;
  namespaceId?: string;
  limit?: number;
}): string {
  const params = new URLSearchParams();
  if (input.status) params.set("status", input.status);
  if (input.tenantId) params.set("tenantId", input.tenantId);
  if (input.namespaceId) params.set("namespaceId", input.namespaceId);
  if (input.limit && input.limit !== 50) params.set("limit", String(input.limit));
  const query = params.toString();
  return query ? `/ingestion?${query}` : "/ingestion";
}

function countSummary(counts: Record<string, number> | undefined): string {
  if (!counts) return "no counts";
  const entries = Object.entries(counts).slice(0, 3);
  return entries.length === 0
    ? "no counts"
    : entries.map(([key, value]) => `${key}: ${value}`).join(" · ");
}
