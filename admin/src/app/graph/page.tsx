import { Network, RefreshCw, Terminal } from "lucide-react";
import {
  CollapsibleSection,
  EmptyState,
  IconLink,
  MetricCard,
  NoticeBanner,
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
import {
  getGraphArtifacts,
  type GraphArtifactReadState,
  type GraphArtifactPaths,
  type GraphBatchImportArtifact,
  type GraphBenchmarkArtifact,
  type GraphBenchmarkMetricArtifact,
  type GraphThresholdViolationArtifact
} from "@/lib/graph-artifacts";

export default async function GraphPage() {
  const artifacts = await getGraphArtifacts();
  const states = [
    artifactState(artifacts.artifactStates.benchmark, artifacts.benchmark?.status),
    artifactState(artifacts.artifactStates.batchImport, artifacts.batchImport?.status)
  ];
  const availableCount = states.filter((state) => state.available).length;
  const invalidStates = states.filter((state) => state.invalid);
  const failingCount = states.filter((state) => state.failing).length;

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Inspect"
        title="Knowledge Graph"
        description="Knowledge graph import status, store benchmark performance, and graph retrieval readiness artifacts."
        actions={<IconLink href="/graph" icon={RefreshCw} label="Refresh" />}
      />

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">
        {availableCount === 0 ? (
          <NoticeBanner
            title="No graph artifacts yet"
            message="Run graph benchmark or graph import scripts to populate the operational graph cards below."
          />
        ) : null}
        {invalidStates.length > 0 ? (
          <NoticeBanner
            title="Invalid graph artifact"
            message={`${invalidStates[0].label} could not be parsed at ${invalidStates[0].path}: ${invalidStates[0].error ?? "unknown parse error"}`}
            tone="error"
          />
        ) : null}

        <PageGuide
          title="Use this when graph-backed retrieval is part of the answer path"
          description="Knowledge Graph shows whether entity/relation imports and graph store performance are ready. It is not required for every deployment, but it is required before relying on graph paths."
          steps={[
            "Confirm benchmark and import artifacts exist.",
            "Check threshold violations before counts.",
            "Rerun graph import after parser or ontology changes."
          ]}
          tone={
            failingCount || invalidStates.length
              ? "error"
              : availableCount === 0
                ? "warning"
                : "primary"
          }
        />

        <SectionCard
          title="Graph Summary"
          description={`Generated ${formatTime(artifacts.generatedAt)}`}
          action={<Network className="h-5 w-5 text-primary" aria-hidden="true" />}
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <MetricCard label="Available" value={formatNumber(availableCount)} tone="primary" />
            <MetricCard
              label="Missing"
              value={formatNumber(states.length - availableCount)}
              tone={availableCount === states.length ? "default" : "warning"}
            />
            <MetricCard
              label="Failing"
              value={formatNumber(failingCount)}
              tone={failingCount ? "error" : "default"}
            />
            <MetricCard
              label="Invalid"
              value={formatNumber(invalidStates.length)}
              tone={invalidStates.length ? "error" : "default"}
            />
            <MetricCard label="Store" value={artifacts.benchmark?.storeKind ?? "n/a"} />
            <MetricCard
              label="Imported entities"
              value={formatNumber(artifacts.batchImport?.metrics?.storedEntityCount)}
            />
            <MetricCard
              label="Imported relations"
              value={formatNumber(artifacts.batchImport?.metrics?.storedRelationCount)}
            />
          </div>
        </SectionCard>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-4">
            <GraphBenchmarkCard artifact={artifacts.benchmark} />
            <GraphImportCard artifact={artifacts.batchImport} />
          </div>

          <aside className="min-w-0 space-y-4">
            <GraphRunbookCard defaultOpen={availableCount === 0} />
            <GraphArtifactPathCard
              paths={artifacts.paths}
              states={artifacts.artifactStates}
              defaultOpen={invalidStates.length > 0}
            />
          </aside>
        </div>
      </main>
    </div>
  );
}

function GraphBenchmarkCard({
  artifact
}: {
  readonly artifact: GraphBenchmarkArtifact | undefined;
}) {
  return (
    <SectionCard
      title="Store Benchmark"
      description="Graph store write, lookup, and pagination timings used to gate graph-backed retrieval paths."
    >
      {!artifact ? (
        <EmptyState
          title="No graph benchmark artifact"
          detail="Run npm run graph:benchmark to write .rag/graph-benchmark/latest/benchmark.json."
        />
      ) : (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <MetricCard
              label="Status"
              value={artifact.status ?? "unknown"}
              tone={statusTone(artifact.status)}
            />
            <MetricCard label="Store" value={artifact.storeKind ?? "n/a"} />
            <MetricCard label="Entities" value={formatNumber(artifact.parameters?.entityCount)} />
            <MetricCard
              label="Relations"
              value={formatNumber(artifact.parameters?.relationCount)}
            />
            <MetricCard label="Page size" value={formatNumber(artifact.parameters?.pageSize)} />
            <MetricCard
              label="Violations"
              value={formatNumber(artifact.violations?.length)}
              tone={(artifact.violations?.length ?? 0) > 0 ? "error" : "default"}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <MetricCard label="Write total" value={formatDurationMs(artifact.write?.durationMs)} />
            <MetricCard
              label="Entity lookup p95"
              value={formatDurationMs(artifact.reads?.entityLookup?.p95Ms)}
            />
            <MetricCard
              label="Relation lookup p95"
              value={formatDurationMs(artifact.reads?.relationLookup?.p95Ms)}
            />
            <MetricCard
              label="Entity page p95"
              value={formatDurationMs(artifact.reads?.entityPage?.p95Ms)}
            />
            <MetricCard
              label="Relation page p95"
              value={formatDurationMs(artifact.reads?.relationPage?.p95Ms)}
            />
          </div>
          <BenchmarkReadTable artifact={artifact} />
          <ViolationList violations={artifact.violations ?? []} />
        </div>
      )}
    </SectionCard>
  );
}

function GraphImportCard({
  artifact
}: {
  readonly artifact: GraphBatchImportArtifact | undefined;
}) {
  return (
    <SectionCard
      title="Batch Import"
      description="Resumable graph batch import status, checkpoint progress, write timings, and threshold failures."
    >
      {!artifact ? (
        <EmptyState
          title="No graph import artifact"
          detail="Run npm run graph:import -- --batches <path> to write .rag/graph-import/latest/import.json."
        />
      ) : (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <MetricCard
              label="Status"
              value={artifact.status ?? "unknown"}
              tone={statusTone(artifact.status)}
            />
            <MetricCard label="Stop reason" value={artifact.stopReason ?? "n/a"} />
            <MetricCard
              label="Source batches"
              value={formatNumber(artifact.metrics?.sourceBatchCount)}
            />
            <MetricCard
              label="Completed"
              value={formatNumber(artifact.metrics?.completedBatchCount)}
            />
            <MetricCard
              label="Failed"
              value={formatNumber(artifact.metrics?.failedBatchCount)}
              tone={(artifact.metrics?.failedBatchCount ?? 0) > 0 ? "error" : "default"}
            />
            <MetricCard label="Skipped" value={formatNumber(artifact.metrics?.skippedBatchCount)} />
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <MetricCard
              label="Stored entities"
              value={formatNumber(artifact.metrics?.storedEntityCount)}
            />
            <MetricCard
              label="Stored relations"
              value={formatNumber(artifact.metrics?.storedRelationCount)}
            />
            <MetricCard
              label="Write total"
              value={formatDurationMs(artifact.metrics?.totalWriteMs)}
            />
            <MetricCard
              label="Write p95"
              value={formatDurationMs(artifact.metrics?.p95BatchWriteMs)}
            />
            <MetricCard
              label="Write max"
              value={formatDurationMs(artifact.metrics?.maxBatchWriteMs)}
            />
          </div>
          <div className="grid gap-2 text-xs text-text-muted md:grid-cols-3">
            <div>Import: {truncateMiddle(artifact.importId ?? "n/a", 48)}</div>
            <div>Started: {formatTime(artifact.startedAt)}</div>
            <div>Finished: {formatTime(artifact.finishedAt)}</div>
          </div>
          <ImportWriteTable writes={(artifact.writes ?? []).slice(0, 8)} />
          <ImportFailureList failures={(artifact.failures ?? []).slice(0, 5)} />
          <ViolationList violations={artifact.thresholdViolations ?? []} />
        </div>
      )}
    </SectionCard>
  );
}

function BenchmarkReadTable({ artifact }: { readonly artifact: GraphBenchmarkArtifact }) {
  const rows = [
    metricRow("Entity lookup", artifact.reads?.entityLookup),
    metricRow("Relation lookup", artifact.reads?.relationLookup),
    metricRow("Entity page", artifact.reads?.entityPage),
    metricRow("Relation page", artifact.reads?.relationPage)
  ];

  if (rows.every((row) => row.metric === undefined)) {
    return <EmptyState title="No benchmark read metrics in artifact" />;
  }

  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="border-b border-card text-xs uppercase tracking-[0.08em] text-text-muted">
          <tr>
            <th className="px-2 py-2 font-medium">Operation</th>
            <th className="px-2 py-2 font-medium">Samples</th>
            <th className="px-2 py-2 font-medium">Mean</th>
            <th className="px-2 py-2 font-medium">P95</th>
            <th className="px-2 py-2 font-medium">Max</th>
            <th className="px-2 py-2 font-medium">Results</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-card">
          {rows.map((row) => (
            <tr key={row.label} className="hover:bg-card/50">
              <td className="px-2 py-3 font-medium">{row.label}</td>
              <td className="px-2 py-3 text-text-secondary">
                {formatNumber(row.metric?.sampleCount)}
              </td>
              <td className="px-2 py-3 text-text-secondary">
                {formatDurationMs(row.metric?.meanMs)}
              </td>
              <td className="px-2 py-3 text-text-secondary">
                {formatDurationMs(row.metric?.p95Ms)}
              </td>
              <td className="px-2 py-3 text-text-secondary">
                {formatDurationMs(row.metric?.maxMs)}
              </td>
              <td className="px-2 py-3 text-text-muted">
                {formatNumber(row.metric?.minResultCount)} -{" "}
                {formatNumber(row.metric?.maxResultCount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ImportWriteTable({
  writes
}: {
  readonly writes: NonNullable<GraphBatchImportArtifact["writes"]>;
}) {
  if (writes.length === 0) return <EmptyState title="No write rows in import artifact" />;
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="border-b border-card text-xs uppercase tracking-[0.08em] text-text-muted">
          <tr>
            <th className="px-2 py-2 font-medium">Batch</th>
            <th className="px-2 py-2 font-medium">Attempts</th>
            <th className="px-2 py-2 font-medium">Duration</th>
            <th className="px-2 py-2 font-medium">Entities</th>
            <th className="px-2 py-2 font-medium">Relations</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-card">
          {writes.map((write, index) => (
            <tr key={`${write.batchId ?? "batch"}-${index}`} className="hover:bg-card/50">
              <td className="px-2 py-3 font-medium">
                {truncateMiddle(write.batchId ?? "unknown", 48)}
              </td>
              <td className="px-2 py-3 text-text-secondary">{formatNumber(write.attemptCount)}</td>
              <td className="px-2 py-3 text-text-secondary">
                {formatDurationMs(write.durationMs)}
              </td>
              <td className="px-2 py-3 text-text-secondary">{formatNumber(write.entityCount)}</td>
              <td className="px-2 py-3 text-text-secondary">{formatNumber(write.relationCount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ImportFailureList({
  failures
}: {
  readonly failures: NonNullable<GraphBatchImportArtifact["failures"]>;
}) {
  if (failures.length === 0) return null;
  return (
    <div className="space-y-2">
      {failures.map((failure, index) => (
        <div
          key={`${failure.batchId ?? "failure"}-${index}`}
          className="rounded-lg border border-error/20 bg-error/10 p-3 text-sm text-error"
        >
          <div className="font-medium">
            {truncateMiddle(failure.batchId ?? "unknown batch", 48)}
          </div>
          <div className="mt-1 text-xs leading-5 text-current/80">
            {failure.message ?? "No failure message."}
          </div>
        </div>
      ))}
    </div>
  );
}

function ViolationList({
  violations
}: {
  readonly violations: readonly GraphThresholdViolationArtifact[];
}) {
  if (violations.length === 0) return null;
  return (
    <div className="space-y-2">
      {violations.map((violation, index) => (
        <div
          key={`${violation.signalName ?? "violation"}-${index}`}
          className="rounded-lg border border-error/20 bg-error/10 p-3 text-sm text-error"
        >
          <div className="font-medium">{violation.signalName ?? "threshold_violation"}</div>
          <div className="mt-1 text-xs leading-5 text-current/80">
            {violation.message ??
              `${formatNumber(violation.observedValue)} exceeded ${formatNumber(
                violation.threshold
              )}.`}
          </div>
        </div>
      ))}
    </div>
  );
}

function GraphRunbookCard({ defaultOpen = false }: { readonly defaultOpen?: boolean }) {
  const commands = [
    "npm run graph:benchmark",
    "npm run graph:benchmark -- --store sqlite --max-entity-lookup-p95-ms <ms>",
    "npm run graph:import -- --batches <graph-batches.jsonl>",
    "npm run graph:import -- --batches <graph-batches.jsonl> --continue-on-error"
  ];

  return (
    <CollapsibleSection
      title="Runbook"
      description="Commands that populate graph operational artifacts."
      defaultOpen={defaultOpen}
    >
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
    </CollapsibleSection>
  );
}

function GraphArtifactPathCard({
  paths,
  states,
  defaultOpen = false
}: {
  readonly paths: GraphArtifactPaths;
  readonly states: Readonly<Record<keyof GraphArtifactPaths, GraphArtifactReadState>>;
  readonly defaultOpen?: boolean;
}) {
  return (
    <CollapsibleSection
      title="Artifact Paths"
      description="Default JSON inputs for this page."
      defaultOpen={defaultOpen}
    >
      <div className="space-y-2 text-xs text-text-muted">
        {Object.entries(paths).map(([label, value]) => {
          const state = states[label as keyof GraphArtifactPaths];
          return (
            <div key={label} className="rounded-lg border border-card bg-background p-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <div className="font-medium text-text-secondary">{label}</div>
                <StatusPill label={state.status} tone={artifactReadTone(state.status)} />
              </div>
              <div className="break-all font-mono leading-5">{value}</div>
              {state.status === "invalid" ? (
                <div className="mt-2 rounded-md border border-error/20 bg-error/10 p-2 text-error">
                  {state.error ?? "Artifact could not be parsed."}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </CollapsibleSection>
  );
}

function artifactState(readState: GraphArtifactReadState, status: string | undefined) {
  return {
    label: readState.label,
    path: readState.path,
    error: readState.error,
    available: readState.status === "available",
    invalid: readState.status === "invalid",
    failing:
      readState.status === "invalid" ||
      status === "failed" ||
      status === "error" ||
      status === "partial"
  };
}

function metricRow(label: string, metric: GraphBenchmarkMetricArtifact | undefined) {
  return { label, metric };
}

function artifactReadTone(status: GraphArtifactReadState["status"]) {
  return status === "available" ? "success" : status === "invalid" ? "error" : "warning";
}
