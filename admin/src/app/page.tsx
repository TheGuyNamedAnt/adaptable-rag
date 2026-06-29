import {
  Activity,
  BrainCircuit,
  ClipboardList,
  GitBranch,
  RefreshCw,
  Route,
  SearchCheck,
  Server,
  ShieldCheck
} from "lucide-react";
import Link from "next/link";
import {
  ErrorBanner,
  IconLink,
  MetricCard,
  NoticeBanner,
  PageHeader,
  PrerequisiteChecklist,
  SectionCard,
  StatusPill
} from "@/components/ui";
import type { Tone } from "@/components/ui";
import {
  formatDurationMs,
  formatNumber,
  formatTime,
  statusTone,
  truncateMiddle
} from "@/lib/format";
import { getConnectorRegistry } from "@/lib/connector-registry";
import { getOverview, type ProviderSummary } from "@/lib/rag-admin-api";

export default async function OverviewPage() {
  const [overview, connectorRegistry] = await Promise.all([getOverview(), getConnectorRegistry()]);
  const health = overview.health;
  const metrics = overview.metrics;
  const index = health?.index;
  const indexPosture = storagePosture(index?.storageKind, index?.durable);
  const postgresMetadataErrors = overview.errors.filter(isPostgresMetadataError);
  const otherErrors = overview.errors.filter((error) => !isPostgresMetadataError(error));
  const hasMetadataGap = postgresMetadataErrors.length > 0;
  const runtimeReady = overview.ready?.ready === true || health?.status === "ready";
  const hasKnowledge = (index?.documentCount ?? 0) > 0 && (index?.chunkCount ?? 0) > 0;
  const providerReady = modelProviderReady(health?.providers?.model);
  const deploymentSnapshot = buildDeploymentSnapshot({
    runtimeReady,
    hasKnowledge,
    hasMetadataGap,
    providerReady,
    indexPosture
  });

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Start"
        title="Deployment Dashboard"
        description="What is ready, what is blocked, and where to go next."
        actions={<IconLink href="/" icon={RefreshCw} label="Refresh" />}
      />

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">
        {!runtimeReady && otherErrors.length > 0 ? (
          <ErrorBanner message={`RAG service is offline: ${otherErrors[0]}`} />
        ) : null}
        {runtimeReady && hasMetadataGap ? (
          <NoticeBanner
            title="Local inspection mode"
            message="The RAG service is online. Answer testing and local intake are available, while durable job history and source health need Postgres ingestion metadata."
          />
        ) : null}
        {runtimeReady && otherErrors.length > 0 ? (
          <NoticeBanner
            title="Partial live data"
            message={`Some admin data is unavailable: ${otherErrors[0]}`}
          />
        ) : null}

        <SectionCard
          title="Deployment Snapshot"
          description="Start here before opening a detailed diagnostics page."
          action={<StatusPill label={deploymentSnapshot.label} tone={deploymentSnapshot.tone} />}
        >
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)]">
            <div className={`rounded-lg border p-4 ${snapshotToneClass(deploymentSnapshot.tone)}`}>
              <div className="text-lg font-semibold">{deploymentSnapshot.title}</div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-current/80">
                {deploymentSnapshot.detail}
              </p>
              <Link
                href={deploymentSnapshot.actionHref}
                className="mt-4 inline-flex min-h-10 items-center rounded-lg bg-text-primary px-4 py-2 text-sm font-medium text-white"
              >
                {deploymentSnapshot.actionLabel}
              </Link>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <ReadinessTile
                label="RAG service"
                value={runtimeReady ? "online" : "offline"}
                detail={health?.profileId ?? overview.endpoints.baseUrl}
                tone={runtimeReady ? "success" : "error"}
              />
              <ReadinessTile
                label="Knowledge"
                value={runtimeReady ? (hasKnowledge ? "loaded" : "empty") : "unknown"}
                detail={
                  runtimeReady
                    ? `${formatNumber(index?.documentCount)} docs · ${formatNumber(index?.chunkCount)} chunks`
                    : "Health check unavailable"
                }
                tone={runtimeReady ? (hasKnowledge ? "success" : "warning") : "default"}
              />
              <ReadinessTile
                label="History"
                value={runtimeReady ? (hasMetadataGap ? "local only" : "durable") : "unknown"}
                detail={
                  runtimeReady
                    ? hasMetadataGap
                      ? "Postgres metadata needed"
                      : "Job metadata connected"
                    : "Check after RAG service starts"
                }
                tone={runtimeReady ? (hasMetadataGap ? "warning" : "success") : "default"}
              />
              <ReadinessTile
                label="Provider"
                value={runtimeReady ? (providerReady ? "configured" : "check setup") : "unknown"}
                detail={
                  runtimeReady
                    ? (health?.providers?.model?.modelName ?? "not configured")
                    : "Health check unavailable"
                }
                tone={runtimeReady ? (providerReady ? "success" : "warning") : "default"}
              />
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title="Operator Workflow"
          description="Use these in order when setting up or debugging a deployment."
        >
          <div className="grid gap-2 md:grid-cols-5">
            <WorkflowStep
              index="1"
              title="Configure profile"
              detail="Set behavior, sources, trust, and budgets."
              href="/profiles"
              status={health?.profileId ? "configured" : "start here"}
              tone={health?.profileId ? "success" : "primary"}
            />
            <WorkflowStep
              index="2"
              title="Load knowledge"
              detail="Upload files or run a connector sync."
              href="/ingestion"
              status={hasKnowledge ? "loaded" : "start here"}
              tone={hasKnowledge ? "success" : "primary"}
            />
            <WorkflowStep
              index="3"
              title="Test an answer"
              detail="Ask a scoped question and inspect the result."
              href="/answer-lab"
              status={runtimeReady ? "available" : "offline"}
              tone={runtimeReady ? "primary" : "error"}
            />
            <WorkflowStep
              index="4"
              title="Inspect evidence"
              detail="Review traces, citations, and rejected chunks."
              href="/traces"
              status={
                metrics?.answerSucceeded || metrics?.answerRefused ? "has runs" : "after test"
              }
              tone={metrics?.answerSucceeded || metrics?.answerRefused ? "success" : "default"}
            />
            <WorkflowStep
              index="5"
              title="Clear production gates"
              detail="Storage, metadata, providers, and review work."
              href="/storage"
              status={deploymentSnapshot.label}
              tone={deploymentSnapshot.tone}
            />
          </div>
        </SectionCard>

        <PrerequisiteChecklist
          title="Action Gates"
          description="This is what should be blocked or treated as setup-only before the system is used."
          items={[
            {
              label: "Configure profile",
              status: health?.profileId ? "ready" : "warning",
              detail: health?.profileId
                ? `${health.profileId} is the active runtime profile.`
                : "Use local defaults only for development; set a runtime profile before production use.",
              actionHref: health?.profileId ? undefined : "/profiles",
              actionLabel: health?.profileId ? undefined : "Open Profile"
            },
            {
              label: "Add knowledge",
              status: hasKnowledge ? "ready" : "warning",
              detail: hasKnowledge
                ? `${formatNumber(index?.documentCount)} document(s) and ${formatNumber(index?.chunkCount)} chunk(s) are indexed.`
                : "Answer testing should stay blocked until upload or connector sync creates documents and chunks.",
              actionHref: hasKnowledge ? "/sources" : "/ingestion",
              actionLabel: hasKnowledge ? "Review Sources" : "Add Knowledge"
            },
            {
              label: "Test answer",
              status: runtimeReady && hasKnowledge ? "ready" : "blocked",
              detail:
                runtimeReady && hasKnowledge
                  ? "The answer path has both a live service and retrievable knowledge."
                  : runtimeReady
                    ? "The service is online, but the knowledge index is empty."
                    : "The answer path depends on the live RAG service.",
              actionHref:
                runtimeReady && hasKnowledge
                  ? "/answer-lab"
                  : runtimeReady
                    ? "/ingestion"
                    : "/storage",
              actionLabel:
                runtimeReady && hasKnowledge
                  ? "Test Answer"
                  : runtimeReady
                    ? "Add Knowledge"
                    : "Open Storage"
            },
            {
              label: "Connector sync",
              status: connectorRegistry.connectors.length > 0 ? "ready" : "warning",
              detail:
                connectorRegistry.connectors.length > 0
                  ? `${formatNumber(connectorRegistry.connectors.length)} connector pack(s) can be synced.`
                  : "Connector sync should be setup-only until a company connector pack is installed.",
              actionHref: "/connectors",
              actionLabel:
                connectorRegistry.connectors.length > 0 ? "Open Connectors" : "Set Up Connectors"
            },
            {
              label: "Production use",
              status: deploymentSnapshot.tone === "success" ? "ready" : "blocked",
              detail: deploymentSnapshot.detail,
              actionHref: deploymentSnapshot.actionHref,
              actionLabel: deploymentSnapshot.actionLabel
            }
          ]}
        />

        <SectionCard
          title="RAG Service Details"
          description={`${overview.endpoints.baseUrl} · ${overview.endpoints.repoRoot}`}
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <MetricCard
              label="Readiness"
              value={overview.ready?.ready ? "ready" : (overview.ready?.status ?? overview.status)}
              tone={
                overview.ready?.ready
                  ? "success"
                  : statusTone(overview.ready?.status ?? overview.status)
              }
            />
            <MetricCard label="Profile" value={health?.profileId ?? "n/a"} tone="primary" />
            <MetricCard label="Namespace" value={health?.namespaceId ?? "n/a"} />
            <MetricCard label="Retrieval" value={health?.retrievalMode ?? "n/a"} />
            <MetricCard
              label="Documents"
              value={formatNumber(index?.documentCount)}
              detail={indexPosture.detail}
            />
            <MetricCard
              label="Chunks"
              value={formatNumber(index?.chunkCount)}
              detail={indexPosture.label}
              tone={indexPosture.tone}
            />
          </div>
        </SectionCard>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <SectionCard
              title="Knowledge Activity"
              description={
                hasMetadataGap
                  ? "Production run history is hidden until Postgres ingestion metadata is connected."
                  : "Postgres-backed ingestion jobs. This list is redacted to ids, stages, counts, and safe errors."
              }
              action={
                <Link className="text-sm font-medium text-primary" href="/ingestion">
                  Open Knowledge
                </Link>
              }
            >
              {overview.recentJobs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-card bg-card/40 p-4 text-sm text-text-muted">
                  {hasMetadataGap
                    ? "Local corpus intake is available, but durable job history needs Postgres metadata."
                    : "No ingestion jobs are available yet."}
                </div>
              ) : (
                <div className="max-w-full overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left text-sm">
                    <thead className="border-b border-card text-xs uppercase tracking-[0.08em] text-text-muted">
                      <tr>
                        <th className="px-2 py-2 font-medium">Job</th>
                        <th className="px-2 py-2 font-medium">Status</th>
                        <th className="px-2 py-2 font-medium">Stage</th>
                        <th className="px-2 py-2 font-medium">Sources</th>
                        <th className="px-2 py-2 font-medium">Updated</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-card">
                      {overview.recentJobs.map((job) => (
                        <tr key={job.jobId} className="hover:bg-card/50">
                          <td className="px-2 py-3">
                            <Link
                              className="font-medium text-text-primary hover:text-primary"
                              href={`/ingestion/${encodeURIComponent(job.jobId)}`}
                            >
                              {truncateMiddle(job.jobId)}
                            </Link>
                            <div className="text-xs text-text-muted">
                              {truncateMiddle(job.runId, 54)}
                            </div>
                          </td>
                          <td className="px-2 py-3">
                            <StatusPill label={job.status} tone={statusTone(job.status)} />
                          </td>
                          <td className="px-2 py-3 text-text-secondary">{job.stage}</td>
                          <td className="px-2 py-3 text-text-secondary">{job.sourceIds.length}</td>
                          <td className="px-2 py-3 text-text-muted">{formatTime(job.updatedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>

            <SectionCard
              title="RAG Service Traffic"
              description="Live request counters from the RAG HTTP service."
            >
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard label="Uptime" value={formatDurationMs(metrics?.uptimeMs)} />
                <MetricCard label="Total requests" value={formatNumber(metrics?.totalRequests)} />
                <MetricCard label="Active" value={formatNumber(metrics?.activeRequests)} />
                <MetricCard label="Completed" value={formatNumber(metrics?.completedRequests)} />
                <MetricCard
                  label="Auth denied"
                  value={formatNumber(metrics?.authDenied)}
                  tone={metrics?.authDenied ? "warning" : "default"}
                />
                <MetricCard
                  label="Rate limited"
                  value={formatNumber(metrics?.rateLimited)}
                  tone={metrics?.rateLimited ? "warning" : "default"}
                />
                <MetricCard
                  label="Answers succeeded"
                  value={formatNumber(metrics?.answerSucceeded)}
                  tone="success"
                />
                <MetricCard
                  label="Answers refused"
                  value={formatNumber(metrics?.answerRefused)}
                  tone={metrics?.answerRefused ? "warning" : "default"}
                />
              </div>
            </SectionCard>
          </div>

          <aside className="space-y-4">
            <SectionCard
              title="Storage Diagnostics"
              description="Where documents, vectors, and sync state are stored."
            >
              <div className="space-y-2 text-sm">
                <StorageRow
                  label="Index"
                  value={health?.index?.storageKind}
                  durable={health?.index?.durable}
                />
                <StorageRow
                  label="Vector"
                  value={health?.vector?.storageKind}
                  durable={health?.vector?.durable}
                  detail={dimensionLabel(health?.vector?.dimensions)}
                />
                <StorageRow
                  label="Visual vector"
                  value={health?.visualVector?.storageKind}
                  durable={health?.visualVector?.durable}
                  detail={dimensionLabel(health?.visualVector?.dimensions)}
                />
                <StorageRow
                  label="Sync ledger"
                  value={health?.sourceSyncLedger?.storageKind}
                  durable={health?.sourceSyncLedger?.durable}
                />
              </div>
            </SectionCard>

            <SectionCard
              title="Provider Diagnostics"
              description="Configured generation and reranking providers."
            >
              <div className="space-y-2">
                {Object.entries(health?.providers ?? {}).length === 0 ? (
                  <div className="rounded-lg bg-card p-3 text-sm text-text-muted">
                    No provider health is available.
                  </div>
                ) : (
                  Object.entries(health?.providers ?? {}).map(([kind, provider]) =>
                    provider ? (
                      <div key={kind} className="rounded-lg border border-card bg-background p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-sm font-medium capitalize">{kind}</div>
                          <StatusPill label={provider.provider ?? "configured"} tone="success" />
                        </div>
                        <div className="mt-1 truncate text-xs text-text-muted">
                          {provider.modelName ?? provider.id ?? "model unavailable"}
                        </div>
                      </div>
                    ) : null
                  )
                )}
              </div>
            </SectionCard>

            <SectionCard
              title="Production Gates"
              description="What must be connected before this is production-clean."
            >
              <div className="space-y-2">
                <ChecklistRow
                  label="Index storage"
                  value={indexPosture.label}
                  detail={indexPosture.detail}
                  tone={indexPosture.tone}
                />
                <ChecklistRow
                  label="Job metadata"
                  value={hasMetadataGap ? "local only" : "connected"}
                  detail={
                    hasMetadataGap ? "RAG_POSTGRES_URL required" : "Durable job history available"
                  }
                  tone={hasMetadataGap ? "warning" : "success"}
                />
                <ChecklistRow
                  label="Vector retrieval"
                  value={storagePosture(health?.vector?.storageKind, health?.vector?.durable).label}
                  detail={
                    health?.vector?.dimensions
                      ? `${health.vector.dimensions} dimensions`
                      : "not configured"
                  }
                  tone={storagePosture(health?.vector?.storageKind, health?.vector?.durable).tone}
                />
                <ChecklistRow
                  label="Source ledger"
                  value={
                    storagePosture(
                      health?.sourceSyncLedger?.storageKind,
                      health?.sourceSyncLedger?.durable
                    ).label
                  }
                  detail="Connector sync state"
                  tone={
                    storagePosture(
                      health?.sourceSyncLedger?.storageKind,
                      health?.sourceSyncLedger?.durable
                    ).tone
                  }
                />
                <ChecklistRow
                  label="Model provider"
                  value={
                    modelProviderReady(health?.providers?.model) ? "configured" : "dev placeholder"
                  }
                  detail={health?.providers?.model?.modelName ?? "not configured"}
                  tone={modelProviderReady(health?.providers?.model) ? "success" : "warning"}
                />
              </div>
            </SectionCard>

            <SectionCard title="Common Shortcuts" description="Main places to continue from here.">
              <div className="space-y-2">
                <NextSurface
                  icon={Route}
                  label="RAG Profile"
                  href="/profiles"
                  detail="Configure behavior and policy"
                />
                <NextSurface
                  icon={ClipboardList}
                  label="Add Knowledge"
                  href="/ingestion"
                  detail="Upload, sync, and ingestion runs"
                />
                <NextSurface
                  icon={Server}
                  label="Knowledge Sources"
                  href="/sources"
                  detail="Source health by latest job"
                />
                <NextSurface
                  icon={GitBranch}
                  label="Connectors"
                  href="/connectors"
                  detail="Repeatable company source systems"
                />
                <NextSurface
                  icon={BrainCircuit}
                  label="Test answers"
                  href="/answer-lab"
                  detail="Scoped questions and safe traces"
                />
                <NextSurface
                  icon={SearchCheck}
                  label="Evidence Explorer"
                  href="/traces"
                  detail="Runs, citations, rejected evidence"
                />
                <NextSurface
                  icon={ShieldCheck}
                  label="Review work"
                  href="/review"
                  detail="Human decisions and handoff"
                />
              </div>
            </SectionCard>
          </aside>
        </div>
      </main>
    </div>
  );
}

interface DeploymentSnapshot {
  readonly label: string;
  readonly tone: Tone;
  readonly title: string;
  readonly detail: string;
  readonly actionLabel: string;
  readonly actionHref: string;
}

function buildDeploymentSnapshot(input: {
  readonly runtimeReady: boolean;
  readonly hasKnowledge: boolean;
  readonly hasMetadataGap: boolean;
  readonly providerReady: boolean;
  readonly indexPosture: { readonly tone: Tone; readonly label: string };
}): DeploymentSnapshot {
  if (!input.runtimeReady) {
    return {
      label: "offline",
      tone: "error",
      title: "Start the RAG service",
      detail:
        "The admin console is running, but the RAG service is not answering health checks. Most pages can still show saved artifacts, but live answer testing and service counters are unavailable.",
      actionLabel: "Open diagnostics",
      actionHref: "/admin-ops"
    };
  }

  if (!input.hasKnowledge) {
    return {
      label: "needs knowledge",
      tone: "warning",
      title: "RAG service is online, but the knowledge base is empty",
      detail:
        "Load documents or run a connector sync before judging answer quality. Empty indexes make answer failures look like model problems even when the setup is simply missing content.",
      actionLabel: "Load knowledge",
      actionHref: "/ingestion"
    };
  }

  if (input.hasMetadataGap) {
    return {
      label: "local ready",
      tone: "warning",
      title: "Ready for local answer testing",
      detail:
        "The RAG service and knowledge index can be tested now. For a production company deployment, connect Postgres-backed job metadata so ingestion history and source health are durable.",
      actionLabel: "Test an answer",
      actionHref: "/answer-lab"
    };
  }

  if (!input.providerReady) {
    return {
      label: "provider check",
      tone: "warning",
      title: "Core RAG service is ready; verify the model provider",
      detail:
        "The deployment has durable metadata, but the configured provider still looks like a local placeholder or incomplete setup. Confirm real model credentials before production use.",
      actionLabel: "Open diagnostics",
      actionHref: "/admin-ops"
    };
  }

  if (input.indexPosture.tone !== "success") {
    return {
      label: "storage check",
      tone: "warning",
      title: "Answer path is ready; storage still needs review",
      detail:
        "The deployment can answer questions, but index storage is not marked as a production posture. Review storage before calling the deployment production-clean.",
      actionLabel: "Review storage",
      actionHref: "/storage"
    };
  }

  return {
    label: "production ready",
    tone: "success",
    title: "Deployment is ready for production checks",
    detail:
      "RAG service, knowledge, metadata, provider setup, and storage posture all look connected from the admin surface. Continue with review work, evals, and SLO gates.",
    actionLabel: "Open review work",
    actionHref: "/review"
  };
}

function snapshotToneClass(tone: Tone): string {
  if (tone === "success") return "border-success/20 bg-success/10 text-success";
  if (tone === "error") return "border-error/20 bg-error/10 text-error";
  if (tone === "primary") return "border-primary/20 bg-primary/10 text-primary";
  if (tone === "warning") return "border-warning/20 bg-warning/10 text-warning";
  return "border-card bg-card text-text-secondary";
}

function ReadinessTile({
  label,
  value,
  detail,
  tone
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone: Tone;
}) {
  return (
    <div className="rounded-lg border border-card bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-[0.08em] text-text-muted">
          {label}
        </div>
        <StatusPill label={value} tone={tone} />
      </div>
      <div className="mt-2 truncate text-sm text-text-secondary">{detail}</div>
    </div>
  );
}

function WorkflowStep({
  index,
  title,
  detail,
  href,
  status,
  tone
}: {
  readonly index: string;
  readonly title: string;
  readonly detail: string;
  readonly href: string;
  readonly status: string;
  readonly tone: Tone;
}) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-card bg-background p-3 hover:border-primary/30"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-card text-sm font-semibold text-text-secondary">
          {index}
        </div>
        <StatusPill label={status} tone={tone} />
      </div>
      <div className="mt-3 text-sm font-semibold">{title}</div>
      <div className="mt-1 text-xs leading-5 text-text-muted">{detail}</div>
    </Link>
  );
}

function isPostgresMetadataError(error: string): boolean {
  return error.toLowerCase().includes("postgres index storage");
}

function ChecklistRow({
  label,
  value,
  detail,
  tone
}: {
  label: string;
  value: string;
  detail: string;
  tone: Tone;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-card bg-background px-3 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="truncate text-xs text-text-muted">{detail}</div>
      </div>
      <StatusPill label={value} tone={tone} />
    </div>
  );
}

function StorageRow({
  label,
  value,
  durable,
  detail
}: {
  label: string;
  value: string | undefined;
  durable: boolean | undefined;
  detail?: string;
}) {
  const posture = storagePosture(value, durable);
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-card bg-background px-3 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="truncate text-xs text-text-muted">{storageDetail(value, detail)}</div>
      </div>
      <StatusPill label={posture.label} tone={posture.tone} />
    </div>
  );
}

function NextSurface({
  icon: Icon,
  label,
  href,
  detail,
  muted = false
}: {
  icon: typeof Activity;
  label: string;
  href: string;
  detail: string;
  muted?: boolean;
}) {
  return (
    <Link
      className={`flex items-start gap-3 rounded-lg border border-card bg-background p-3 ${muted ? "opacity-65" : "hover:border-primary/30"}`}
      href={href}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block truncate text-xs text-text-muted">{detail}</span>
      </span>
    </Link>
  );
}

function dimensionLabel(dimensions: number | undefined): string | undefined {
  return dimensions === undefined ? undefined : `${dimensions} dimensions`;
}

function storagePosture(
  storageKind: string | undefined,
  durable: boolean | undefined
): { readonly label: string; readonly tone: Tone; readonly detail: string } {
  if (!storageKind) return { label: "none", tone: "default", detail: "not configured" };
  if (storageKind === "postgres" || storageKind === "hosted") {
    return { label: "production", tone: "success", detail: storageKind };
  }
  if (storageKind === "sqlite") {
    return { label: "local sqlite", tone: "warning", detail: "sqlite local persistent" };
  }
  if (storageKind === "json_file") {
    return { label: "local persistent", tone: "warning", detail: "json file local storage" };
  }
  if (storageKind === "memory") return { label: "memory", tone: "warning", detail: "in-memory" };
  return {
    label: durable ? "durable" : "local",
    tone: durable ? "success" : "warning",
    detail: storageKind
  };
}

function storageDetail(storageKind: string | undefined, detail: string | undefined): string {
  if (!storageKind) return detail ?? "not configured";
  return [storageKind, detail].filter(Boolean).join(" · ");
}

function modelProviderReady(provider: ProviderSummary | undefined): boolean {
  if (!provider) return false;
  const joined = [provider.id, provider.provider, provider.modelName].filter(Boolean).join(" ");
  return !/(placeholder|example\.invalid|json-chat)/iu.test(joined);
}
