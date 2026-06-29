import {
  ClipboardCheck,
  Database,
  RefreshCw,
  Settings2,
  Terminal,
  UploadCloud
} from "lucide-react";
import {
  CollapsibleSection,
  EmptyState,
  ErrorBanner,
  IconLink,
  MetricCard,
  NoticeBanner,
  PageGuide,
  PageHeader,
  RelatedPageLinks,
  SectionCard,
  StatusPill
} from "@/components/ui";
import { ProductionSetupPanel } from "@/components/ProductionSetupPanel";
import { formatNumber, formatTime, statusTone } from "@/lib/format";
import {
  buildProductionSetupChecklist,
  readCompanyPostgresSmokeReport
} from "@/lib/production-setup";
import {
  getStorageDashboard,
  type StorageDashboardResult,
  type StorageSurfaceSummary
} from "@/lib/storage-dashboard";
import type { AdminDoctorCheck, AdminMetadataRuntime } from "@/lib/admin-doctor";
import type { RuntimeDoctorCheck } from "@/lib/rag-admin-api";

export default async function StoragePage() {
  const [dashboard, smokeReport] = await Promise.all([
    safeStorageDashboard(),
    readCompanyPostgresSmokeReport()
  ]);
  const productionSetup = buildProductionSetupChecklist(dashboard, smokeReport);
  const health = dashboard.overview.health ?? dashboard.runtimeDoctor.data?.health;
  const runtimeStatus = dashboard.runtimeDoctor.data?.status ?? dashboard.runtimeDoctor.status;
  const runtimeStorageFailed = dashboard.runtimeStorageChecks.filter(
    (check) => check.status === "failed"
  ).length;
  const adminFailed = dashboard.adminDoctor.checks.filter(
    (check) => check.status === "failed"
  ).length;
  const fixCommands = uniqueSorted(
    dashboard.adminDoctor.checks.flatMap((check) => (check.command ? [check.command] : []))
  );

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Configure"
        title="Storage"
        description="RAG data stores, vector readiness, source ledger state, and admin metadata migrations."
        actions={
          <>
            <IconLink href="/admin-ops" icon={ClipboardCheck} label="Setup Diagnostics" />
            <IconLink href="/storage" icon={RefreshCw} label="Refresh" />
          </>
        }
      />

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">
        {dashboard.status === "failed" ? (
          <ErrorBanner message="Storage is not production-ready. Review failed RAG service or admin migration checks before company rollout." />
        ) : null}
        {dashboard.status === "warning" ? (
          <NoticeBanner
            title="Storage needs production hardening"
            message="One or more storage surfaces are local, missing, skipped, or not backed by durable Postgres metadata."
          />
        ) : null}

        <PageGuide
          title="Use this to decide whether data storage is production-clean"
          description="Storage separates RAG service stores from admin metadata stores. A local setup can still be useful for testing, but company deployments need durable RAG storage and durable admin audit metadata."
          steps={[
            "Check the summary status first.",
            "Fix RAG service storage before admin metadata if both fail.",
            "Use Diagnostics for admin metadata commands."
          ]}
          tone={
            dashboard.status === "failed"
              ? "error"
              : dashboard.status === "warning"
                ? "warning"
                : "primary"
          }
        />

        <RelatedPageLinks
          description="Storage is the durability view. These pages either configure what gets stored or use storage health to decide whether the system is ready."
          links={[
            {
              href: "/admin-ops",
              icon: ClipboardCheck,
              label: "Setup Diagnostics",
              detail:
                "Admin metadata checks and safe fix commands for trace, connector, and review stores."
            },
            {
              href: "/profiles",
              icon: Settings2,
              label: "RAG Profile",
              detail:
                "The active profile controls namespaces, evidence rules, trust, budgets, and routing."
            },
            {
              href: "/ingestion",
              icon: UploadCloud,
              label: "Add Knowledge",
              detail:
                "Uploads and connector syncs write source records, documents, chunks, and vectors."
            }
          ]}
        />

        <SectionCard
          title="Storage Summary"
          description={`Generated ${formatTime(dashboard.generatedAt)} · ${dashboard.overview.endpoints.baseUrl}`}
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <MetricCard
              label="Storage status"
              value={dashboard.status}
              tone={statusTone(dashboard.status)}
            />
            <MetricCard
              label="RAG service check"
              value={runtimeStatus ?? "n/a"}
              tone={statusTone(runtimeStatus)}
            />
            <MetricCard
              label="Admin Doctor"
              value={dashboard.adminDoctor.status}
              tone={statusTone(dashboard.adminDoctor.status)}
            />
            <MetricCard
              label="Documents"
              value={formatNumber(health?.index?.documentCount)}
              tone="primary"
            />
            <MetricCard label="Chunks" value={formatNumber(health?.index?.chunkCount)} />
            <MetricCard
              label="Failures"
              value={formatNumber(runtimeStorageFailed + adminFailed)}
              tone={runtimeStorageFailed + adminFailed > 0 ? "error" : "default"}
            />
          </div>
        </SectionCard>

        <ProductionSetupPanel checklist={productionSetup} />

        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-4">
            <SectionCard
              title="RAG Storage Surfaces"
              description="Live storage surfaces reported by production RAG service health."
            >
              <div className="grid gap-3 md:grid-cols-2">
                {dashboard.surfaces.map((surface) => (
                  <StorageSurfaceCard key={surface.id} surface={surface} />
                ))}
              </div>
            </SectionCard>

            <CollapsibleSection
              title="RAG Storage Checks"
              description="Storage checks from the compiled RAG service doctor. Provider probes are not run here."
              defaultOpen={
                dashboard.runtimeDoctor.status === "unavailable" || runtimeStorageFailed > 0
              }
            >
              {dashboard.runtimeDoctor.status === "unavailable" ? (
                <ErrorBanner
                  message={
                    dashboard.runtimeDoctor.error ??
                    "RAG service check is unavailable. Build the RAG CLI and rerun."
                  }
                />
              ) : dashboard.runtimeStorageChecks.length === 0 ? (
                <EmptyState
                  title="No RAG storage checks returned"
                  detail="The RAG service may be using stores that do not expose extended readiness checks."
                />
              ) : (
                <div className="max-w-full overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left text-sm">
                    <thead className="border-b border-card text-xs uppercase tracking-[0.08em] text-text-muted">
                      <tr>
                        <th className="px-2 py-2 font-medium">Check</th>
                        <th className="px-2 py-2 font-medium">Status</th>
                        <th className="px-2 py-2 font-medium">Message</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-card">
                      {dashboard.runtimeStorageChecks.map((check, index) => (
                        <RuntimeCheckRow key={`${check.id ?? "check"}-${index}`} check={check} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CollapsibleSection>

            <CollapsibleSection
              title="Admin Metadata Migration Checks"
              description="Read-only checks for trace history, connector action, and review workflow metadata."
              defaultOpen={adminFailed > 0}
            >
              <div className="mb-3 grid gap-3 md:grid-cols-3">
                <AdminMetadataCard
                  title="Trace History"
                  metadata={dashboard.adminDoctor.metadata.traceHistory}
                />
                <AdminMetadataCard
                  title="Connector State"
                  metadata={dashboard.adminDoctor.metadata.connectorState}
                />
                <AdminMetadataCard
                  title="Review Workflow"
                  metadata={dashboard.adminDoctor.metadata.reviewWorkflow}
                />
              </div>

              {dashboard.adminDoctor.checks.length === 0 ? (
                <EmptyState title="No admin metadata checks returned" />
              ) : (
                <div className="max-w-full overflow-x-auto">
                  <table className="w-full min-w-[820px] text-left text-sm">
                    <thead className="border-b border-card text-xs uppercase tracking-[0.08em] text-text-muted">
                      <tr>
                        <th className="px-2 py-2 font-medium">Check</th>
                        <th className="px-2 py-2 font-medium">Area</th>
                        <th className="px-2 py-2 font-medium">Status</th>
                        <th className="px-2 py-2 font-medium">Detail</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-card">
                      {dashboard.adminDoctor.checks.map((check) => (
                        <AdminCheckRow key={check.id} check={check} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CollapsibleSection>
          </div>

          <aside className="min-w-0 space-y-4">
            <CollapsibleSection
              title="Fix Commands"
              description="Commands and env lines surfaced by checks."
              defaultOpen={fixCommands.length > 0}
            >
              {fixCommands.length === 0 ? (
                <EmptyState title="No storage fix commands are required" />
              ) : (
                <div className="space-y-2">
                  {fixCommands.map((command) => (
                    <div key={command} className="rounded-lg border border-card bg-background p-3">
                      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-text-muted">
                        <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                        Operator command
                      </div>
                      <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-card/60 p-2 font-mono text-[11px] leading-5 text-text-secondary">
                        {command}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </CollapsibleSection>

            <SectionCard
              title="Recommendations"
              description="Highest-signal storage and metadata issues."
            >
              {dashboard.recommendations.length === 0 ? (
                <div className="rounded-lg border border-card bg-card/40 p-3 text-sm text-text-muted">
                  No recommendations. Storage checks are clean.
                </div>
              ) : (
                <div className="space-y-2">
                  {dashboard.recommendations.map((recommendation) => (
                    <div
                      key={recommendation}
                      className="rounded-lg border border-card bg-background p-3 text-sm leading-5 text-text-secondary"
                    >
                      {recommendation}
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>

            <SectionCard
              title="Production Target"
              description="What the serious company deployment should show."
            >
              <div className="space-y-2 text-sm leading-5 text-text-secondary">
                <TargetRow label="Documents/chunks" value="Postgres FTS" />
                <TargetRow label="Text vectors" value="Postgres pgvector" />
                <TargetRow label="Source ledger" value="Postgres" />
                <TargetRow label="Admin metadata" value="Postgres" />
                <div className="rounded-lg border border-card bg-background p-3">
                  <Database className="mb-2 h-4 w-4 text-primary" aria-hidden="true" />
                  Local JSON and SQLite remain valid for plug-and-play dev installs, but company
                  deployments should land on Postgres-backed storage and admin metadata.
                </div>
              </div>
            </SectionCard>
          </aside>
        </div>
      </main>
    </div>
  );
}

function StorageSurfaceCard({ surface }: { readonly surface: StorageSurfaceSummary }) {
  return (
    <div className="min-w-0 rounded-lg border border-card bg-background p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium">{surface.label}</div>
          <div className="mt-1 text-xs text-text-muted">{surface.detail}</div>
        </div>
        <StatusPill label={surface.status} tone={statusTone(surface.status)} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <MetricCard label="Kind" value={surface.storageKind} />
        <MetricCard
          label="Durable"
          value={surface.durable ? "yes" : "no"}
          tone={surface.durable ? "success" : "warning"}
        />
        {surface.documentCount !== undefined ? (
          <MetricCard label="Documents" value={formatNumber(surface.documentCount)} />
        ) : null}
        {surface.chunkCount !== undefined ? (
          <MetricCard label="Chunks" value={formatNumber(surface.chunkCount)} />
        ) : null}
        {surface.dimensions !== undefined ? (
          <MetricCard label="Dimensions" value={formatNumber(surface.dimensions)} />
        ) : null}
      </div>
    </div>
  );
}

function RuntimeCheckRow({ check }: { readonly check: RuntimeDoctorCheck }) {
  return (
    <tr className="hover:bg-card/50">
      <td className="px-2 py-3">
        <div className="font-medium">{check.id ?? "storage_check"}</div>
        <div className="text-xs text-text-muted">{check.kind ?? "storage"}</div>
      </td>
      <td className="px-2 py-3">
        <StatusPill label={check.status ?? "unknown"} tone={statusTone(check.status)} />
      </td>
      <td className="px-2 py-3 text-text-secondary">{check.message ?? "No message."}</td>
    </tr>
  );
}

function AdminMetadataCard({
  title,
  metadata
}: {
  readonly title: string;
  readonly metadata: AdminMetadataRuntime;
}) {
  return (
    <div className="rounded-lg border border-card bg-background p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          <div className="mt-1 break-all text-xs text-text-muted">{metadata.requiredMigration}</div>
        </div>
        <StatusPill
          label={metadata.effectiveKind}
          tone={metadata.effectiveKind === "postgres" ? "success" : "warning"}
        />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <Fact label="Configured" value={metadata.configuredKind} />
        <Fact label="Schema" value={metadata.schema} />
        <Fact label="URL" value={metadata.urlConfigured ? "configured" : "missing"} />
        <Fact label="Tables" value={formatNumber(metadata.requiredTables.length)} />
      </div>
    </div>
  );
}

function AdminCheckRow({ check }: { readonly check: AdminDoctorCheck }) {
  return (
    <tr className="hover:bg-card/50">
      <td className="px-2 py-3">
        <div className="font-medium">{check.label}</div>
        {check.recommendation ? (
          <div className="mt-1 text-xs text-text-muted">{check.recommendation}</div>
        ) : null}
      </td>
      <td className="px-2 py-3 text-text-secondary">
        {check.area === "trace_history" ? "Trace history" : "Connector state"}
      </td>
      <td className="px-2 py-3">
        <StatusPill label={check.status} tone={statusTone(check.status)} />
      </td>
      <td className="px-2 py-3 text-text-secondary">{check.detail}</td>
    </tr>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-card/60 px-2 py-1.5">
      <div className="text-[11px] text-text-muted">{label}</div>
      <div className="truncate font-medium text-text-secondary">{value}</div>
    </div>
  );
}

function TargetRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-card bg-background p-3">
      <span className="text-text-muted">{label}</span>
      <span className="font-medium text-text-primary">{value}</span>
    </div>
  );
}

async function safeStorageDashboard(): Promise<StorageDashboardResult> {
  try {
    return await getStorageDashboard();
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim()
        ? error.message.slice(0, 1200)
        : "Storage dashboard failed.";
    throw new Error(message);
  }
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
