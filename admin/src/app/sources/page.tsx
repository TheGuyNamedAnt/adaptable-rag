import Link from "next/link";
import { GitBranch, RefreshCw, UploadCloud } from "lucide-react";
import {
  EmptyState,
  ErrorBanner,
  IconLink,
  MetricCard,
  NoticeBanner,
  PageGuide,
  PageHeader,
  SectionCard,
  StatusPill
} from "@/components/ui";
import { formatNumber, formatTime, statusTone, truncateMiddle } from "@/lib/format";
import { getConnectorRegistry, type ConnectorRegistryRecord } from "@/lib/connector-registry";
import {
  getIngestionJobs,
  getSourceHealth,
  type IngestionJobRecord,
  type SourceHealthRecord
} from "@/lib/rag-admin-api";
import {
  getSourceInventory,
  type SourceInventoryBatch,
  type SourceInventoryRecord
} from "@/lib/source-inventory";

type SearchParams = Record<string, string | string[] | undefined>;

interface SourceViewRecord extends SourceInventoryRecord {
  readonly latestHealth?: SourceHealthRecord;
}

export default async function SourcesPage({
  searchParams
}: {
  searchParams?: SearchParams | Promise<SearchParams>;
}) {
  const params = (await searchParams) ?? {};
  const requestedJobId = firstParam(params.jobId);
  const requestedSourceId = firstParam(params.sourceId);
  const [inventory, connectorRegistry, jobsResult] = await Promise.all([
    getSourceInventory(),
    getConnectorRegistry(),
    getIngestionJobs({ limit: 20 })
  ]);
  const jobs = jobsResult.data ?? [];
  const selectedJobId = requestedJobId ?? jobs[0]?.jobId;
  const healthResult = selectedJobId ? await getSourceHealth(selectedJobId) : undefined;
  const jobHealthSources = healthResult?.data?.sources ?? [];
  const sources = mergeSourceInventory(
    inventory.sources,
    connectorRegistry.connectors,
    jobHealthSources
  );
  const selectedSourceId = requestedSourceId ?? sources[0]?.sourceId;
  const selectedSource = sources.find((source) => source.sourceId === selectedSourceId);
  const selectedBatches = inventory.batches.filter((batch) => batch.sourceId === selectedSourceId);
  const selectedHealth = selectedSource?.latestHealth;
  const failedCount = sources.filter((source) => source.latestHealth?.health === "failed").length;
  const warningCount = sources.filter((source) => source.latestHealth?.health === "warning").length;
  const metadataGap =
    jobsResult.status === "unavailable" && isPostgresMetadataError(jobsResult.error);

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Configure"
        title="Knowledge Sources"
        description="Stable source inventory, upload batches, connector links, and latest indexing health."
        actions={
          <>
            <IconLink href="/connectors" icon={GitBranch} label="Connectors" />
            <IconLink href="/ingestion" icon={UploadCloud} label="Add Knowledge" />
            <IconLink
              href={sourcesHref({ jobId: selectedJobId, sourceId: selectedSourceId })}
              icon={RefreshCw}
              label="Refresh"
            />
          </>
        }
      />

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">
        {metadataGap ? (
          <NoticeBanner
            title="Local source inventory"
            message="Upload batches are available from local admin metadata. Durable source health, failed document stages, and job-level sync history need Postgres-backed ingestion metadata."
          />
        ) : jobsResult.status === "unavailable" ? (
          <ErrorBanner message={jobsResult.error ?? "Ingestion jobs are unavailable."} />
        ) : null}
        {healthResult?.status === "unavailable" && !isPostgresMetadataError(healthResult.error) ? (
          <ErrorBanner message={healthResult.error ?? "Source health is unavailable."} />
        ) : null}

        <PageGuide
          title="Use this to understand where knowledge came from"
          description="Knowledge Sources connects stable source ids to upload batches, connector records, and latest indexing health. Use it when a document is missing, stale, or failing before jumping into raw job details."
          steps={[
            "Pick the source id first.",
            "Check latest health and batches.",
            "Open the matching ingestion job for document-level failures."
          ]}
          tone={failedCount ? "error" : warningCount ? "warning" : "primary"}
        />

        <SectionCard
          title="Knowledge Source Summary"
          description="Counts are based on safe IDs, upload batches, and durable job metadata when available."
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-7">
            <MetricCard label="Sources" value={formatNumber(sources.length)} tone="primary" />
            <MetricCard label="Upload batches" value={formatNumber(inventory.batches.length)} />
            <MetricCard
              label="Connectors"
              value={formatNumber(connectorRegistry.connectors.length)}
            />
            <MetricCard
              label="Stored files"
              value={formatNumber(sumSources(sources, "storedFileCount"))}
            />
            <MetricCard label="Job sources" value={formatNumber(jobHealthSources.length)} />
            <MetricCard
              label="Failed"
              value={formatNumber(failedCount)}
              tone={failedCount ? "error" : "default"}
            />
            <MetricCard
              label="Warnings"
              value={formatNumber(warningCount)}
              tone={warningCount ? "warning" : "default"}
            />
          </div>
        </SectionCard>

        <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <SectionCard
            title="Source Inventory"
            description="Source IDs stay stable across upload and ingestion runs."
          >
            <div className="space-y-2">
              {sources.length === 0 ? (
                <EmptyState
                  title="No sources found"
                  detail="Upload files from Add Knowledge or configure a company connector pack."
                  actionHref="/ingestion"
                  actionLabel="Open Add Knowledge"
                />
              ) : (
                sources.map((source) => (
                  <SourceButton
                    key={source.sourceId}
                    source={source}
                    selected={source.sourceId === selectedSourceId}
                    href={sourcesHref({ jobId: selectedJobId, sourceId: source.sourceId })}
                  />
                ))
              )}
            </div>
          </SectionCard>

          <div className="space-y-4">
            <SelectedSourceCard source={selectedSource} health={selectedHealth} />
            <UploadBatchCard batches={selectedBatches} />
            <DurableHealthCard
              selectedJobId={selectedJobId}
              selectedSourceId={selectedSourceId}
              health={selectedHealth}
              metadataGap={metadataGap}
            />
            <JobHistoryCard
              jobs={jobs}
              selectedJobId={selectedJobId}
              selectedSourceId={selectedSourceId}
              metadataGap={metadataGap}
            />
          </div>
        </div>
      </main>
    </div>
  );
}

function SourceButton({
  source,
  selected,
  href
}: {
  source: SourceViewRecord;
  selected: boolean;
  href: string;
}) {
  const healthLabel = source.latestHealth?.health ?? source.origin;
  return (
    <Link
      href={href}
      className={`block rounded-lg border p-3 ${
        selected
          ? "border-text-primary bg-text-primary text-white"
          : "border-card bg-background hover:border-primary/30"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{truncateMiddle(source.sourceId, 38)}</div>
          <div
            className={`mt-1 truncate text-xs ${selected ? "text-white/70" : "text-text-muted"}`}
          >
            {source.sourceKind} · {source.namespaceId ?? "namespace n/a"}
          </div>
        </div>
        <StatusPill label={healthLabel} tone={statusTone(healthLabel)} />
      </div>
      <div className={`mt-2 text-xs ${selected ? "text-white/70" : "text-text-muted"}`}>
        {formatNumber(source.storedFileCount)} file(s) · {formatNumber(source.batchCount)} batch(es)
      </div>
    </Link>
  );
}

function SelectedSourceCard({
  source,
  health
}: {
  source: SourceViewRecord | undefined;
  health: SourceHealthRecord | undefined;
}) {
  if (!source) {
    return (
      <SectionCard title="Selected Source">
        <EmptyState
          title="No source selected"
          detail="Choose a source from the inventory or upload a corpus batch."
          actionHref="/ingestion"
          actionLabel="Open Add Knowledge"
        />
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Selected Source"
      description="Safe source scope, latest batch metadata, and current durable health when available."
      action={
        <Link className="text-sm font-medium text-primary" href="/ingestion">
          Upload or sync
        </Link>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Kind" value={source.sourceKind} tone="primary" />
        <MetricCard label="Origin" value={source.origin} />
        <MetricCard
          label="Health"
          value={health?.health ?? "not connected"}
          tone={statusTone(health?.health)}
        />
        <MetricCard label="Files" value={formatNumber(source.storedFileCount)} />
      </div>
      <div className="mt-3 grid gap-2 text-xs text-text-muted md:grid-cols-2">
        <div>Source: {truncateMiddle(source.sourceId, 64)}</div>
        <div>Latest batch: {truncateMiddle(source.latestBatchId ?? "n/a", 64)}</div>
        <div>Tenant: {source.tenantId ?? "n/a"}</div>
        <div>Namespace: {source.namespaceId ?? "n/a"}</div>
        <div>Roles: {source.roles.length ? source.roles.join(", ") : "n/a"}</div>
        <div>Tags: {source.tags.length ? source.tags.join(", ") : "n/a"}</div>
        <div>Latest upload: {formatTime(source.latestUploadedAt)}</div>
        <div>Total size: {formatBytes(source.totalBytes)}</div>
      </div>
    </SectionCard>
  );
}

function UploadBatchCard({ batches }: { batches: readonly SourceInventoryBatch[] }) {
  return (
    <SectionCard
      title="Upload Batches"
      description="Safe batch history for this source. File names are not shown here."
    >
      {batches.length === 0 ? (
        <EmptyState
          title="No upload batches"
          detail="This source may come from a durable connector or a Postgres ingestion job."
          actionHref="/connectors"
          actionLabel="Open Connectors"
        />
      ) : (
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-card text-xs uppercase tracking-[0.08em] text-text-muted">
              <tr>
                <th className="px-2 py-2 font-medium">Batch</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2 font-medium">Run</th>
                <th className="px-2 py-2 font-medium">Files</th>
                <th className="px-2 py-2 font-medium">Docs</th>
                <th className="px-2 py-2 font-medium">Chunks</th>
                <th className="px-2 py-2 font-medium">Uploaded</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-card">
              {batches.slice(0, 12).map((batch) => (
                <tr key={batch.batchId} className="hover:bg-card/50">
                  <td className="px-2 py-3 font-medium">{truncateMiddle(batch.batchId, 42)}</td>
                  <td className="px-2 py-3">
                    <StatusPill
                      label={batch.status ?? "uploaded"}
                      tone={statusTone(batch.status)}
                    />
                  </td>
                  <td className="px-2 py-3 text-text-muted">
                    {truncateMiddle(batch.runId ?? "n/a", 34)}
                  </td>
                  <td className="px-2 py-3 text-text-secondary">
                    {formatNumber(batch.storedFileCount)}
                    {batch.skippedFileCount ? ` / ${batch.skippedFileCount} skipped` : ""}
                  </td>
                  <td className="px-2 py-3 text-text-secondary">
                    {formatNumber(batch.documentsAccepted)}
                  </td>
                  <td className="px-2 py-3 text-text-secondary">
                    {formatNumber(batch.chunksAccepted)}
                  </td>
                  <td className="px-2 py-3 text-text-muted">{formatTime(batch.uploadedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function DurableHealthCard({
  selectedJobId,
  selectedSourceId,
  health,
  metadataGap
}: {
  selectedJobId: string | undefined;
  selectedSourceId: string | undefined;
  health: SourceHealthRecord | undefined;
  metadataGap: boolean;
}) {
  return (
    <SectionCard
      title="Durable Source Health"
      description={
        selectedJobId ? `Latest selected job: ${selectedJobId}` : "No durable job selected"
      }
    >
      {!selectedSourceId ? (
        <EmptyState
          title="No source selected"
          detail="Choose a source from the inventory or upload files to create one."
          actionHref="/ingestion"
          actionLabel="Open Add Knowledge"
        />
      ) : health ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <MetricCard label="Health" value={health.health} tone={statusTone(health.health)} />
          <MetricCard label="Loaded" value={formatNumber(health.loadedDocumentCount)} />
          <MetricCard label="Accepted" value={formatNumber(health.acceptedDocumentCount)} />
          <MetricCard
            label="Failed"
            value={formatNumber(health.failedDocumentCount)}
            tone={health.failedDocumentCount ? "error" : "default"}
          />
          <MetricCard label="Skipped" value={formatNumber(health.skippedDocumentCount)} />
        </div>
      ) : (
        <EmptyState
          title="No durable health for this source"
          detail={
            metadataGap
              ? "Connect Postgres-backed ingestion metadata to see source health, failed stages, and document-level status."
              : "This source has no progress rows in the selected ingestion job."
          }
          actionHref={metadataGap ? "/storage" : "/ingestion"}
          actionLabel={metadataGap ? "Open Storage" : "Open Add Knowledge"}
        />
      )}
    </SectionCard>
  );
}

function JobHistoryCard({
  jobs,
  selectedJobId,
  selectedSourceId,
  metadataGap
}: {
  jobs: readonly IngestionJobRecord[];
  selectedJobId: string | undefined;
  selectedSourceId: string | undefined;
  metadataGap: boolean;
}) {
  return (
    <SectionCard
      title="Durable Job Runs"
      description="Use this to inspect source health from a specific ingestion run."
    >
      {jobs.length === 0 ? (
        <EmptyState
          title="No durable jobs available"
          detail={
            metadataGap
              ? "Local uploads are tracked above. Production job runs appear after Postgres metadata is configured."
              : "Run ingestion or sync first, then job history will appear here."
          }
          actionHref={metadataGap ? "/storage" : "/ingestion"}
          actionLabel={metadataGap ? "Open Storage" : "Open Add Knowledge"}
        />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {jobs.map((job) => (
            <Link
              key={job.jobId}
              href={sourcesHref({ jobId: job.jobId, sourceId: selectedSourceId })}
              className={`rounded-lg border p-3 ${
                job.jobId === selectedJobId
                  ? "border-primary/40 bg-primary/10"
                  : "border-card bg-background hover:border-primary/30"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="truncate text-sm font-medium">{truncateMiddle(job.jobId, 34)}</div>
                <StatusPill label={job.status} tone={statusTone(job.status)} />
              </div>
              <div className="mt-1 truncate text-xs text-text-muted">
                {formatTime(job.updatedAt)} · {job.sourceIds.length} source(s)
              </div>
            </Link>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function mergeSourceInventory(
  inventorySources: readonly SourceInventoryRecord[],
  connectorSources: readonly ConnectorRegistryRecord[],
  healthSources: readonly SourceHealthRecord[]
): readonly SourceViewRecord[] {
  const bySourceId = new Map<string, SourceViewRecord>();
  for (const source of inventorySources) {
    bySourceId.set(source.sourceId, source);
  }
  for (const connector of connectorSources) {
    const current = bySourceId.get(connector.sourceId);
    bySourceId.set(connector.sourceId, {
      ...(current ?? {
        sourceId: connector.sourceId,
        batchCount: 0,
        storedFileCount: 0,
        skippedFileCount: 0,
        totalBytes: 0,
        roles: [],
        tags: []
      }),
      sourceKind: connector.sourceSystem,
      origin: current?.origin ?? "connector",
      namespaceId: current?.namespaceId ?? connector.namespaceId,
      latestUploadedAt: current?.latestUploadedAt ?? connector.lastCheckedAt
    });
  }
  for (const health of healthSources) {
    const current = bySourceId.get(health.sourceId);
    if (current) {
      bySourceId.set(health.sourceId, { ...current, latestHealth: health });
      continue;
    }
    bySourceId.set(health.sourceId, {
      sourceId: health.sourceId,
      sourceKind: "job_source",
      origin: "job",
      batchCount: 0,
      storedFileCount: 0,
      skippedFileCount: 0,
      totalBytes: 0,
      roles: [],
      tags: [],
      latestUploadedAt: health.updatedAt,
      latestHealth: health
    });
  }
  return [...bySourceId.values()].sort((left, right) => {
    const leftTime = timeValue(left.latestHealth?.updatedAt ?? left.latestUploadedAt);
    const rightTime = timeValue(right.latestHealth?.updatedAt ?? right.latestUploadedAt);
    return rightTime - leftTime;
  });
}

function sumSources(
  sources: readonly SourceViewRecord[],
  key: "storedFileCount" | "batchCount"
): number {
  return sources.reduce((total, source) => total + source[key], 0);
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isPostgresMetadataError(error: string | undefined): boolean {
  return (error ?? "").toLowerCase().includes("postgres index storage");
}

function sourcesHref(input: { jobId?: string; sourceId?: string }): string {
  const params = new URLSearchParams();
  if (input.jobId) params.set("jobId", input.jobId);
  if (input.sourceId) params.set("sourceId", input.sourceId);
  const query = params.toString();
  return query ? `/sources?${query}` : "/sources";
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "n/a";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function timeValue(value: string | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
