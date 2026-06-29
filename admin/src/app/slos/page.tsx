import {
  Activity,
  BarChart3,
  Database,
  FileSearch,
  RefreshCw,
  ShieldAlert,
  Target
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
  StatusPill,
  type Tone
} from "@/components/ui";
import { formatDurationMs, formatNumber, formatTime, statusTone } from "@/lib/format";
import {
  getSloDashboard,
  type SloCounterRow,
  type SloDashboardResult,
  type SloGate,
  type SloGateStatus
} from "@/lib/slo-dashboard";

export default async function SlosPage() {
  const dashboard = await safeSloDashboard();
  const metrics = dashboard.overview.metrics;

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Verify"
        title="Reliability"
        description="Operational gates for RAG service availability, traffic health, answer reliability, storage posture, and observability."
        actions={
          <>
            <IconLink href="/evals" icon={BarChart3} label="Regression Tests" />
            <IconLink href="/slos" icon={RefreshCw} label="Refresh" />
          </>
        }
      />

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">
        {dashboard.status === "failed" ? (
          <ErrorBanner message="Operational gates are failing. Fix failed gates before company traffic promotion." />
        ) : null}
        {dashboard.status === "warning" ? (
          <NoticeBanner
            title="Operational gates need attention"
            message="One or more gates are warning or missing data. This can be acceptable in local dev, but not for company rollout."
          />
        ) : null}

        <PageGuide
          title="Use this before promoting traffic"
          description="Reliability turns live RAG service counters into promotion gates. It is the quickest way to see whether the system is merely running or actually healthy enough for company use."
          steps={[
            "Read failed and no-data gates before counters.",
            "Use recommendations for the next fix.",
            "Treat local no-data as acceptable only during development."
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
          description="Reliability is the live-traffic gate. These pages explain whether failures come from quality, generated artifacts, or storage posture."
          links={[
            {
              href: "/evals",
              icon: BarChart3,
              label: "Regression Tests",
              detail:
                "Answer-quality pass/fail checks before trusting profile, index, or retrieval changes."
            },
            {
              href: "/quality-ops",
              icon: FileSearch,
              label: "Quality Artifacts",
              detail:
                "Generated reports for parser quality, document QA, provider smoke, and cleanup work."
            },
            {
              href: "/storage",
              icon: Database,
              label: "Storage",
              detail:
                "Durability and vector readiness behind the storage gate in this reliability view."
            }
          ]}
        />

        <SectionCard
          title="Gate Summary"
          description={`Generated ${formatTime(dashboard.generatedAt)} · ${dashboard.overview.endpoints.baseUrl}`}
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <MetricCard
              label="Gate status"
              value={dashboard.status}
              tone={gateTone(dashboard.status)}
            />
            <MetricCard
              label="Passed"
              value={formatNumber(dashboard.summary.passedCount)}
              tone="success"
            />
            <MetricCard
              label="Warnings"
              value={formatNumber(dashboard.summary.warningCount)}
              tone={dashboard.summary.warningCount ? "warning" : "default"}
            />
            <MetricCard
              label="Failed"
              value={formatNumber(dashboard.summary.failedCount)}
              tone={dashboard.summary.failedCount ? "error" : "default"}
            />
            <MetricCard
              label="No data"
              value={formatNumber(dashboard.summary.noDataCount)}
              tone={dashboard.summary.noDataCount ? "warning" : "default"}
            />
            <MetricCard label="Gates" value={formatNumber(dashboard.summary.gateCount)} />
          </div>
        </SectionCard>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <SectionCard
              title="Operational Gates"
              description="Promotion-facing pass, warning, failed, and no-data gates from live RAG service state."
            >
              <div className="grid gap-3 md:grid-cols-2">
                {dashboard.gates.map((gate) => (
                  <GateCard key={gate.id} gate={gate} />
                ))}
              </div>
            </SectionCard>

            <CollapsibleSection
              title="Service Counters"
              description="Raw request and answer counters behind the gate decisions."
              defaultOpen={dashboard.status !== "passed"}
            >
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard label="Uptime" value={formatDurationMs(metrics?.uptimeMs)} />
                <MetricCard
                  label="Total requests"
                  value={formatNumber(metrics?.totalRequests)}
                  tone="primary"
                />
                <MetricCard label="Active" value={formatNumber(metrics?.activeRequests)} />
                <MetricCard label="Completed" value={formatNumber(metrics?.completedRequests)} />
                <MetricCard
                  label="Server errors"
                  value={formatNumber(metrics?.serverErrors)}
                  tone={metrics?.serverErrors ? "error" : "default"}
                />
                <MetricCard
                  label="Request errors"
                  value={formatNumber(metrics?.requestErrors)}
                  tone={metrics?.requestErrors ? "warning" : "default"}
                />
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
                <MetricCard
                  label="Answers failed"
                  value={formatNumber(metrics?.answerFailed)}
                  tone={metrics?.answerFailed ? "error" : "default"}
                />
                <MetricCard
                  label="Answer events"
                  value={formatNumber(dashboard.metrics.answerRequests)}
                  tone={dashboard.metrics.answerRequests > 0 ? "primary" : "warning"}
                />
              </div>
            </CollapsibleSection>

            <div className="grid gap-4 lg:grid-cols-3">
              <CounterTable title="Status Codes" rows={dashboard.counters.statusCodes} />
              <CounterTable title="Routes" rows={dashboard.counters.routes} />
              <CounterTable title="Outcomes" rows={dashboard.counters.outcomes} />
            </div>
          </div>

          <aside className="space-y-4">
            <SectionCard
              title="Production Targets"
              description="The default gates for serious company deployments."
            >
              <div className="space-y-2 text-sm leading-5 text-text-secondary">
                <TargetRow label="Readiness" value="/ready is true" />
                <TargetRow label="Completion" value=">= 99%" />
                <TargetRow label="Server errors" value="0" />
                <TargetRow label="Request errors" value="<= 2%" />
                <TargetRow label="Auth denials" value="0 unexpected" />
                <TargetRow label="Rate limits" value="0 sustained" />
                <TargetRow label="Answer failures" value="0" />
                <TargetRow label="Storage" value="Postgres + pgvector" />
              </div>
            </SectionCard>

            <SectionCard title="Recommendations">
              {dashboard.recommendations.length === 0 ? (
                <div className="rounded-lg border border-card bg-card/40 p-3 text-sm text-text-muted">
                  No recommendations. Operational gates are clean.
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
              title="Escalation Signals"
              description="Counters that should trigger operator attention."
            >
              <div className="space-y-2">
                <SignalRow
                  icon={ShieldAlert}
                  label="Security"
                  value={`${formatNumber(metrics?.authDenied)} auth denials`}
                  tone={metrics?.authDenied ? "warning" : "success"}
                />
                <SignalRow
                  icon={Activity}
                  label="Reliability"
                  value={`${formatNumber(metrics?.serverErrors)} server errors`}
                  tone={metrics?.serverErrors ? "error" : "success"}
                />
                <SignalRow
                  icon={BarChart3}
                  label="Traffic"
                  value={`${formatNumber(metrics?.rateLimited)} rate limits`}
                  tone={metrics?.rateLimited ? "warning" : "success"}
                />
              </div>
            </SectionCard>
          </aside>
        </div>
      </main>
    </div>
  );
}

function GateCard({ gate }: { readonly gate: SloGate }) {
  return (
    <div className="rounded-lg border border-card bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-[0.08em] text-text-muted">
            {gate.area}
          </div>
          <div className="font-medium">{gate.label}</div>
        </div>
        <StatusPill label={gate.status} tone={gateTone(gate.status)} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <MetricCard label="Target" value={gate.target} />
        <MetricCard label="Actual" value={gate.actual} tone={gateTone(gate.status)} />
      </div>
      <p className="mt-3 text-sm leading-5 text-text-secondary">{gate.detail}</p>
      <div className="mt-3 space-y-2">
        {gate.evidence.map((item) => (
          <div
            key={item}
            className="rounded-md border border-card bg-card/40 px-2 py-1.5 text-xs leading-5 text-text-secondary"
          >
            {item}
          </div>
        ))}
      </div>
      {gate.actionHref ? (
        <a
          href={gate.actionHref}
          className="mt-3 inline-flex min-h-9 items-center rounded-lg border border-card px-3 py-2 text-sm text-text-secondary hover:border-primary/30 hover:text-text-primary"
        >
          Inspect
        </a>
      ) : null}
    </div>
  );
}

function CounterTable({
  title,
  rows
}: {
  readonly title: string;
  readonly rows: readonly SloCounterRow[];
}) {
  return (
    <CollapsibleSection title={title} description="Raw counter breakdown from service metrics.">
      {rows.length === 0 ? (
        <EmptyState title="No counters returned" />
      ) : (
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[280px] text-left text-sm">
            <thead className="border-b border-card text-xs uppercase tracking-[0.08em] text-text-muted">
              <tr>
                <th className="px-2 py-2 font-medium">Name</th>
                <th className="px-2 py-2 font-medium">Count</th>
                <th className="px-2 py-2 font-medium">Share</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-card">
              {rows.map((row) => (
                <tr key={row.label} className="hover:bg-card/50">
                  <td className="px-2 py-3 font-medium">{row.label}</td>
                  <td className="px-2 py-3 text-text-secondary">{formatNumber(row.count)}</td>
                  <td className="px-2 py-3 text-text-muted">{formatPercent(row.percentage)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </CollapsibleSection>
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

function SignalRow({
  icon: Icon,
  label,
  value,
  tone
}: {
  readonly icon: typeof Activity;
  readonly label: string;
  readonly value: string;
  readonly tone: Tone;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-card bg-background p-3">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
        <span className="font-medium">{label}</span>
      </div>
      <StatusPill label={value} tone={tone} />
    </div>
  );
}

async function safeSloDashboard(): Promise<SloDashboardResult> {
  try {
    return await getSloDashboard();
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim()
        ? error.message.slice(0, 1200)
        : "SLO dashboard failed.";
    throw new Error(message);
  }
}

function gateTone(status: SloGateStatus): Tone {
  if (status === "no_data") return "default";
  return statusTone(status);
}

function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(value < 0.01 && value > 0 ? 2 : 1)}%`;
}
