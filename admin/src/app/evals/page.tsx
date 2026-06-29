import { Activity, BarChart3, FileSearch, RefreshCw } from "lucide-react";
import {
  EmptyState,
  IconLink,
  MetricCard,
  PageGuide,
  PageHeader,
  RelatedPageLinks,
  SectionCard,
  StatusPill
} from "@/components/ui";
import { formatDurationMs, formatNumber, formatTime, statusTone } from "@/lib/format";
import { getEvalArtifacts } from "@/lib/eval-artifacts";

export default async function EvalsPage() {
  const artifacts = await getEvalArtifacts();
  const dashboard = artifacts.dashboard;
  const summary = artifacts.summary;
  const regression = artifacts.regression;
  const passRate =
    summary && summary.caseCount > 0
      ? (summary.caseCount - summary.failureCount) / summary.caseCount
      : undefined;

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Verify"
        title="Regression Tests"
        description="Retrieval, citation, refusal, access-boundary, and regression quality artifacts."
        actions={
          <>
            <IconLink href="/quality-ops" icon={FileSearch} label="Quality Artifacts" />
            <IconLink href="/evals" icon={RefreshCw} label="Refresh" />
          </>
        }
      />

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">
        {!dashboard && !summary && !regression ? (
          <EmptyState
            title="No eval artifact found"
            detail="Run the retrieval benchmark or deployment check to populate .rag/eval-runs/latest."
            actionHref="/quality-ops"
            actionLabel="Open Quality Artifacts"
          />
        ) : null}

        <PageGuide
          title="Use this to decide whether answers are still safe after changes"
          description="Regression Tests reads the latest eval artifacts for retrieval, citation, refusal, access-boundary, and regression quality. It is the quality gate before trusting a profile or index change."
          steps={[
            "Check pass rate and failure count.",
            "Inspect failed suites by profile and namespace.",
            "Use Quality Artifacts for parser and benchmark reports."
          ]}
          tone={summary?.passed === false ? "error" : !summary ? "warning" : "primary"}
        />

        <RelatedPageLinks
          description="Regression Tests is the answer-quality gate. These adjacent pages explain the generated reports and the live traffic posture."
          links={[
            {
              href: "/quality-ops",
              icon: FileSearch,
              label: "Quality Artifacts",
              detail:
                "Parser, document QA, provider smoke, ingestion integrity, migration, and cleanup reports."
            },
            {
              href: "/slos",
              icon: Activity,
              label: "Reliability",
              detail: "Live service counters and promotion gates after the system is running."
            },
            {
              href: "/answer-lab",
              icon: BarChart3,
              label: "Test Answer",
              detail:
                "Run a concrete question and inspect citations, rejected evidence, and trace output."
            }
          ]}
        />

        <SectionCard
          title="Quality Summary"
          description={`Latest dashboard artifact: ${formatTime(dashboard?.generatedAt)}`}
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <MetricCard
              label="Status"
              value={summary?.passed ? "passed" : "attention"}
              tone={summary?.passed ? "success" : "warning"}
            />
            <MetricCard label="Cases" value={formatNumber(summary?.caseCount)} />
            <MetricCard label="Suites" value={formatNumber(summary?.suiteCount)} />
            <MetricCard label="Pass rate" value={formatPercent(passRate)} />
            <MetricCard label="Recall@K" value={formatMetric(dashboard?.recallAtK)} />
            <MetricCard label="MRR" value={formatMetric(dashboard?.mrr)} />
          </div>
        </SectionCard>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <SectionCard
              title="Retrieval And Citation Metrics"
              description="These are the Phase 1 retrieval quality gates."
            >
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <MetricCard
                  label="Citation precision"
                  value={formatMetric(dashboard?.citationPrecision)}
                />
                <MetricCard
                  label="Citation recall"
                  value={formatMetric(dashboard?.citationRecall)}
                />
                <MetricCard
                  label="Refusal correctness"
                  value={formatMetric(dashboard?.refusalCorrectnessRate)}
                />
                <MetricCard
                  label="Access boundary"
                  value={formatMetric(dashboard?.accessBoundaryCorrectnessRate)}
                  tone="success"
                />
                <MetricCard
                  label="Stale-source refusal"
                  value={formatMetric(dashboard?.staleSourceRefusalRate)}
                />
                <MetricCard
                  label="Graph grounding"
                  value={formatMetric(dashboard?.graphPathGrounding)}
                />
              </div>
            </SectionCard>

            <SectionCard title="Suites" description="Profile and namespace coverage.">
              {!summary || summary.suites.length === 0 ? (
                <EmptyState
                  title="No suites found"
                  detail="Run the eval suite for at least one profile and namespace to see coverage here."
                  actionHref="/profiles"
                  actionLabel="Review Profiles"
                />
              ) : (
                <div className="max-w-full overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="border-b border-card text-xs uppercase tracking-[0.08em] text-text-muted">
                      <tr>
                        <th className="px-2 py-2 font-medium">Profile</th>
                        <th className="px-2 py-2 font-medium">Namespace</th>
                        <th className="px-2 py-2 font-medium">Status</th>
                        <th className="px-2 py-2 font-medium">Cases</th>
                        <th className="px-2 py-2 font-medium">Failures</th>
                        <th className="px-2 py-2 font-medium">Missing checks</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-card">
                      {summary.suites.map((suite) => (
                        <tr
                          key={`${suite.profileId}:${suite.namespaceId}`}
                          className="hover:bg-card/50"
                        >
                          <td className="px-2 py-3 font-medium">{suite.profileId}</td>
                          <td className="px-2 py-3 text-text-secondary">{suite.namespaceId}</td>
                          <td className="px-2 py-3">
                            <StatusPill
                              label={suite.passed ? "passed" : "failed"}
                              tone={suite.passed ? "success" : "error"}
                            />
                          </td>
                          <td className="px-2 py-3 text-text-secondary">
                            {formatNumber(suite.caseCount)}
                          </td>
                          <td className="px-2 py-3 text-text-secondary">
                            {formatNumber(suite.failureCount)}
                          </td>
                          <td className="px-2 py-3 text-text-muted">
                            {suite.missingRequiredChecks.length
                              ? suite.missingRequiredChecks.join(", ")
                              : "none"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          </div>

          <aside className="space-y-4">
            <SectionCard title="Service Cost And Latency">
              <div className="grid gap-2">
                <MetricCard label="Latency p50" value={formatDurationMs(dashboard?.latencyMsP50)} />
                <MetricCard
                  label="Estimated cost"
                  value={formatCurrency(dashboard?.estimatedCostUsdTotal)}
                />
                <MetricCard
                  label="Parser impact"
                  value={formatMetric(dashboard?.parserQualityImpact)}
                />
              </div>
            </SectionCard>

            <SectionCard title="Regression">
              {!regression ? (
                <EmptyState
                  title="No regression artifact"
                  detail="Regression deltas appear after a baseline and current eval artifact are available."
                  actionHref="/quality-ops"
                  actionLabel="Open Quality Artifacts"
                />
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <StatusPill
                      label={regression.passed ? "passed" : "failed"}
                      tone={regression.passed ? "success" : "error"}
                    />
                    <span className="text-xs text-text-muted">
                      {formatNumber(regression.deltas.length)} delta(s)
                    </span>
                  </div>
                  <div className="space-y-2">
                    {regression.deltas.slice(0, 8).map((delta) => (
                      <div
                        key={delta.metric}
                        className="rounded-lg border border-card bg-background p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="truncate text-sm font-medium">{delta.metric}</div>
                          <StatusPill
                            label={signedNumber(delta.change)}
                            tone={statusTone("passed")}
                          />
                        </div>
                        <div className="mt-1 text-xs text-text-muted">
                          {formatNumber(delta.baseline)} to {formatNumber(delta.current)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </SectionCard>
          </aside>
        </div>
      </main>
    </div>
  );
}

function formatMetric(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "n/a";
}

function formatPercent(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value * 100)}%`
    : "n/a";
}

function formatCurrency(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(4)}` : "n/a";
}

function signedNumber(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
