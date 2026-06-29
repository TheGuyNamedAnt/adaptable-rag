import { ClipboardList, Database, RefreshCw, ShieldCheck, Terminal } from "lucide-react";
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
import { getProductionSetupChecklist, type ProductionSetupChecklist } from "@/lib/production-setup";
import {
  getAdminDoctor,
  type AdminDoctorCheck,
  type AdminDoctorResult,
  type AdminMetadataRuntime
} from "@/lib/admin-doctor";

export default async function AdminOpsPage() {
  const [doctor, productionSetup] = await Promise.all([
    safeAdminDoctor(),
    safeProductionSetupChecklist()
  ]);
  const failedCount = doctor.checks.filter((check) => check.status === "failed").length;
  const warningCount = doctor.checks.filter((check) => check.status === "warning").length;
  const passedCount = doctor.checks.filter((check) => check.status === "passed").length;
  const commands = uniqueSorted(
    doctor.checks.flatMap((check) => (check.command ? [check.command] : []))
  );

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Configure"
        title="Setup Diagnostics"
        description="Admin metadata readiness, migration checks, and safe operator fixes."
        actions={
          <>
            <IconLink href="/storage" icon={Database} label="Storage" />
            <IconLink href="/admin-ops" icon={RefreshCw} label="Refresh" />
          </>
        }
      />

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">
        {doctor.status === "failed" ? (
          <ErrorBanner message="Admin metadata is not production-ready. Review the failed checks before using this deployment for company operations." />
        ) : null}
        {doctor.status === "warning" ? (
          <NoticeBanner
            title="Admin metadata is in local/dev mode"
            message="The admin app can operate, but one or more metadata stores are not durable Postgres-backed production stores."
          />
        ) : null}

        <PageGuide
          title="Use this when the admin console itself may be misconfigured"
          description="Diagnostics checks the admin-side stores and setup commands. It does not judge answer quality; it tells you whether trace history, connector state, and review workflow metadata can be trusted."
          steps={[
            "Start with failed checks.",
            "Run only the surfaced fix commands you intend to apply.",
            "Return to Storage after metadata checks are clean."
          ]}
          tone={
            doctor.status === "failed"
              ? "error"
              : doctor.status === "warning"
                ? "warning"
                : "primary"
          }
        />

        <RelatedPageLinks
          description="Diagnostics is the admin-app setup view. These pages show the runtime stores and the workflows that depend on durable admin metadata."
          links={[
            {
              href: "/storage",
              icon: Database,
              label: "Storage",
              detail:
                "RAG service storage, vectors, source ledger health, and shared production readiness."
            },
            {
              href: "/connectors",
              icon: ClipboardList,
              label: "Connectors",
              detail:
                "Connector state uses admin metadata to track sync actions and disabled overrides."
            },
            {
              href: "/review",
              icon: ShieldCheck,
              label: "Review Work",
              detail:
                "Review decisions need durable metadata before operator actions can be audited."
            }
          ]}
        />

        <SectionCard
          title="Doctor Summary"
          description={`Generated ${formatTime(doctor.generatedAt)}`}
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <MetricCard label="Status" value={doctor.status} tone={statusTone(doctor.status)} />
            <MetricCard label="Passed" value={formatNumber(passedCount)} tone="success" />
            <MetricCard
              label="Warnings"
              value={formatNumber(warningCount)}
              tone={warningCount ? "warning" : "default"}
            />
            <MetricCard
              label="Failed"
              value={formatNumber(failedCount)}
              tone={failedCount ? "error" : "default"}
            />
            <MetricCard label="Checks" value={formatNumber(doctor.checks.length)} />
          </div>
        </SectionCard>

        <ProductionSetupPanel checklist={productionSetup} />

        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-4">
            <SectionCard
              title="Admin Metadata Stores"
              description="These are admin-only operational stores. They should be Postgres in company deployments."
            >
              <div className="grid gap-3 md:grid-cols-3">
                <MetadataStoreCard title="Trace History" runtime={doctor.metadata.traceHistory} />
                <MetadataStoreCard
                  title="Connector State"
                  runtime={doctor.metadata.connectorState}
                />
                <MetadataStoreCard
                  title="Review Workflow"
                  runtime={doctor.metadata.reviewWorkflow}
                />
              </div>
            </SectionCard>

            <CollapsibleSection
              title="Readiness Checks"
              description="Read-only checks for admin metadata mode, Postgres connectivity, tables, and required columns."
              defaultOpen={failedCount > 0 || warningCount > 0}
            >
              {doctor.checks.length === 0 ? (
                <EmptyState title="No checks returned" />
              ) : (
                <div className="max-w-full overflow-x-auto">
                  <table className="w-full min-w-[860px] text-left text-sm">
                    <thead className="border-b border-card text-xs uppercase tracking-[0.08em] text-text-muted">
                      <tr>
                        <th className="px-2 py-2 font-medium">Check</th>
                        <th className="px-2 py-2 font-medium">Area</th>
                        <th className="px-2 py-2 font-medium">Status</th>
                        <th className="px-2 py-2 font-medium">Detail</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-card">
                      {doctor.checks.map((check) => (
                        <CheckRow key={check.id} check={check} />
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
              description="Safe commands and env lines for the failed or warning checks."
              defaultOpen={commands.length > 0}
            >
              {commands.length === 0 ? (
                <EmptyState title="No operator fix commands are required" />
              ) : (
                <div className="space-y-2">
                  {commands.map((command) => (
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

            <SectionCard title="Recommendations">
              {doctor.recommendations.length === 0 ? (
                <div className="rounded-lg border border-card bg-card/40 p-3 text-sm text-text-muted">
                  No recommendations. Admin metadata is production-ready.
                </div>
              ) : (
                <div className="space-y-2">
                  {uniqueSorted(doctor.recommendations).map((recommendation) => (
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
              title="Production Meaning"
              description="What this page proves before a company rollout."
            >
              <div className="space-y-2 text-sm leading-5 text-text-secondary">
                <div className="flex gap-2 rounded-lg border border-card bg-background p-3">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  <span>
                    Postgres mode means answer-run history, connector actions, disabled overrides,
                    and review decisions survive admin restarts and can be audited.
                  </span>
                </div>
                <div className="rounded-lg border border-card bg-background p-3">
                  The checks never read document bodies, prompts, provider payloads, credentials, or
                  connector source content.
                </div>
              </div>
            </SectionCard>
          </aside>
        </div>
      </main>
    </div>
  );
}

function MetadataStoreCard({
  title,
  runtime
}: {
  readonly title: string;
  readonly runtime: AdminMetadataRuntime;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-card bg-background p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          <div className="mt-1 break-all text-xs text-text-muted">{runtime.requiredMigration}</div>
        </div>
        <StatusPill
          label={runtime.effectiveKind}
          tone={runtime.effectiveKind === "postgres" ? "success" : "warning"}
        />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <MetadataFact label="Configured" value={runtime.configuredKind} />
        <MetadataFact label="Schema" value={runtime.schema} />
        <MetadataFact label="URL" value={runtime.urlConfigured ? "configured" : "missing"} />
        <MetadataFact label="Tables" value={formatNumber(runtime.requiredTables.length)} />
      </div>
      <div className="mt-3 break-words text-xs leading-5 text-text-secondary">
        {runtime.requiredTables.join(", ")}
      </div>
    </div>
  );
}

function MetadataFact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-card/60 px-2 py-1.5">
      <div className="text-[11px] text-text-muted">{label}</div>
      <div className="truncate font-medium text-text-secondary">{value}</div>
    </div>
  );
}

function CheckRow({ check }: { readonly check: AdminDoctorCheck }) {
  return (
    <tr className="hover:bg-card/50">
      <td className="px-2 py-3">
        <div className="font-medium">{check.label}</div>
        {check.recommendation ? (
          <div className="mt-1 text-xs text-text-muted">{check.recommendation}</div>
        ) : null}
      </td>
      <td className="px-2 py-3 text-text-secondary">{areaLabel(check.area)}</td>
      <td className="px-2 py-3">
        <StatusPill label={check.status} tone={statusTone(check.status)} />
      </td>
      <td className="px-2 py-3 text-text-secondary">{check.detail}</td>
    </tr>
  );
}

async function safeAdminDoctor(): Promise<AdminDoctorResult> {
  try {
    return await getAdminDoctor();
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim()
        ? error.message.slice(0, 1200)
        : "Admin Doctor failed.";
    return {
      generatedAt: new Date().toISOString(),
      status: "failed",
      checks: [
        {
          id: "admin_doctor.unhandled_error",
          label: "Admin Doctor",
          status: "failed",
          area: "connector_state",
          detail: message,
          recommendation: "Fix the server-side admin Doctor error, then rerun the check."
        }
      ],
      metadata: {
        traceHistory: {
          area: "trace_history",
          configuredKind: "auto",
          effectiveKind: "json_file",
          schema: "rag_core",
          urlConfigured: false,
          requiredMigration: "deploy/postgres/004_admin_trace_history.sql",
          requiredTables: ["admin_answer_runs"]
        },
        connectorState: {
          area: "connector_state",
          configuredKind: "auto",
          effectiveKind: "json_file",
          schema: "rag_core",
          urlConfigured: false,
          requiredMigration: "deploy/postgres/005_admin_connector_state.sql",
          requiredTables: ["admin_connector_actions", "admin_connector_disabled_overrides"]
        },
        reviewWorkflow: {
          area: "review_queue",
          configuredKind: "auto",
          effectiveKind: "json_file",
          schema: "rag_core",
          urlConfigured: false,
          requiredMigration: "deploy/postgres/006_admin_review_queue.sql",
          requiredTables: ["admin_review_states"]
        }
      },
      recommendations: ["Fix the server-side admin Doctor error, then rerun the check."]
    };
  }
}

async function safeProductionSetupChecklist(): Promise<ProductionSetupChecklist> {
  try {
    return await getProductionSetupChecklist();
  } catch (error) {
    return {
      generatedAt: new Date().toISOString(),
      status: "failed",
      summary: {
        stepCount: 1,
        passedCount: 0,
        warningCount: 0,
        failedCount: 1,
        pendingCount: 0
      },
      steps: [
        {
          id: "production_setup.unhandled_error",
          area: "Production setup",
          title: "Production setup checklist",
          status: "failed",
          detail:
            error instanceof Error && error.message.trim()
              ? error.message.slice(0, 1200)
              : "Production setup checklist failed.",
          evidence: [],
          env: [],
          commands: [],
          recheckPath: "/storage"
        }
      ]
    };
  }
}

function areaLabel(area: string): string {
  if (area === "trace_history") return "Trace history";
  if (area === "connector_state") return "Connector state";
  if (area === "review_queue") return "Review queue";
  return area;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
