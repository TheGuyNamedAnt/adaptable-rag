import { RefreshCw, Route, ShieldCheck } from "lucide-react";
import {
  CollapsibleSection,
  EmptyState,
  ErrorBanner,
  IconLink,
  MetricCard,
  PageGuide,
  PageHeader,
  SectionCard,
  StatusPill
} from "@/components/ui";
import { ProfileDraftBuilder } from "@/components/ProfileDraftBuilder";
import { formatNumber, truncateMiddle } from "@/lib/format";
import { getConnectorRegistry, type ConnectorRegistryRecord } from "@/lib/connector-registry";
import { getEvalArtifacts } from "@/lib/eval-artifacts";
import { getOverview } from "@/lib/rag-admin-api";

interface ProfileRow {
  readonly profileId: string;
  readonly namespaceId: string;
  readonly sourceIds: readonly string[];
  readonly connectorCount: number;
  readonly evalCaseCount: number;
  readonly evalFailureCount: number;
  readonly runtimeActive: boolean;
}

const POLICY_GROUPS = [
  {
    label: "Retrieval",
    detail: "Mode, max chunks, query rewrite, parallel queries, rerank mode, and source routes."
  },
  {
    label: "Evidence",
    detail: "Citation minimums, trusted citation requirements, refusal behavior, and source kinds."
  },
  {
    label: "Budgets",
    detail: "Context tokens, output reserve, max retrieval calls, model calls, latency, and cost."
  },
  {
    label: "Security",
    detail: "Prompt-injection handling, retrieved-text isolation, redaction, and raw vector access."
  },
  {
    label: "Operations",
    detail: "Observability level, trace redaction, memory mode, escalation rules, and eval paths."
  }
] as const;

export default async function ProfilesPage() {
  const [overview, registry, evalArtifacts] = await Promise.all([
    getOverview(),
    getConnectorRegistry(),
    getEvalArtifacts()
  ]);
  const rows = buildProfileRows({
    connectors: registry.connectors,
    runtimeProfileId: overview.health?.profileId,
    runtimeNamespaceId: overview.health?.namespaceId,
    evalSuites: evalArtifacts.summary?.suites ?? []
  });
  const activeRows = rows.filter((row) => row.runtimeActive);
  const namespaceCount = new Set(rows.map((row) => row.namespaceId)).size;
  const sourceCount = rows.reduce((total, row) => total + row.sourceIds.length, 0);
  const evalFailureCount = rows.reduce((total, row) => total + row.evalFailureCount, 0);

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Configure"
        title="RAG Profile"
        description="Configure one portable behavior profile and inspect active namespace, source, and eval coverage."
        actions={<IconLink href="/profiles" icon={RefreshCw} label="Refresh status" />}
      />

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">
        {overview.errors.length > 0 ? (
          <ErrorBanner
            message={`RAG service profile health is unavailable: ${overview.errors[0]}`}
          />
        ) : null}

        <PageGuide
          title="Use this to shape one adaptable profile before promotion"
          description="The profile ties a namespace to retrieval, citation, refusal, budget, security, and eval policy. Exported JSON can be adapted for any use case; live service changes still go through config, regression tests, and promotion."
          steps={[
            "Configure the profile.",
            "Export and validate the profile JSON.",
            "Run Regression Tests before service use."
          ]}
          tone={overview.errors.length > 0 ? "warning" : "primary"}
        />

        <ProfileDraftBuilder />

        <SectionCard
          title="Active Profile Status"
          description={`${overview.endpoints.baseUrl} · ${overview.endpoints.repoRoot}`}
          action={<Route className="h-5 w-5 text-primary" aria-hidden="true" />}
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <MetricCard
              label="Active service profile"
              value={formatNumber(activeRows.length)}
              tone="primary"
            />
            <MetricCard label="Detected records" value={formatNumber(rows.length)} />
            <MetricCard label="Namespaces seen" value={formatNumber(namespaceCount)} />
            <MetricCard label="Sources connected" value={formatNumber(sourceCount)} />
            <MetricCard
              label="Eval failures"
              value={formatNumber(evalFailureCount)}
              tone={evalFailureCount ? "error" : "default"}
            />
            <MetricCard label="Retrieval" value={overview.health?.retrievalMode ?? "n/a"} />
          </div>
        </SectionCard>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <CollapsibleSection
              title="Detected Profile Evidence"
              description="Advanced evidence from service health, connector artifacts, and eval suites. This is not a profile picker."
            >
              {rows.length === 0 ? (
                <EmptyState
                  title="No profile records found"
                  detail="Start the RAG service or run company validation/evals to emit profile and namespace evidence."
                  actionHref="/connectors"
                  actionLabel="Open Connectors"
                />
              ) : (
                <ProfileEvidenceList rows={rows} />
              )}
            </CollapsibleSection>
          </div>

          <aside className="space-y-4">
            <SectionCard
              title="Control Plane"
              description="Profile policy groups that determine RAG service behavior."
              action={<ShieldCheck className="h-5 w-5 text-success" aria-hidden="true" />}
            >
              <div className="space-y-2">
                {POLICY_GROUPS.map((group) => (
                  <div
                    key={group.label}
                    className="rounded-lg border border-card bg-background p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium">{group.label}</div>
                      <StatusPill label="profile" tone="primary" />
                    </div>
                    <div className="mt-1 text-xs leading-5 text-text-muted">{group.detail}</div>
                  </div>
                ))}
              </div>
            </SectionCard>

            <SectionCard title="Service Identity" description="Current health-reported profile.">
              <div className="space-y-2">
                <IdentityFact label="Profile" value={overview.health?.profileId} />
                <IdentityFact label="Namespace" value={overview.health?.namespaceId} />
                <IdentityFact label="Retrieval" value={overview.health?.retrievalMode} />
                <IdentityFact label="Readiness" value={overview.ready?.status ?? overview.status} />
              </div>
            </SectionCard>
          </aside>
        </div>
      </main>
    </div>
  );
}

function IdentityFact({ label, value }: { readonly label: string; readonly value?: string }) {
  return (
    <div className="rounded-lg border border-card bg-background p-3">
      <div className="text-xs font-medium text-text-muted">{label}</div>
      <div className="mt-1 break-all text-sm text-text-secondary">{value ?? "n/a"}</div>
    </div>
  );
}

function ProfileEvidenceList({ rows }: { readonly rows: readonly ProfileRow[] }) {
  return (
    <div className="grid gap-2 md:grid-cols-2">
      {rows.map((row) => (
        <div
          key={`${row.profileId}:${row.namespaceId}`}
          className="min-w-0 rounded-lg border border-card bg-background p-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {truncateMiddle(row.profileId, 42)}
              </div>
              <div className="mt-1 truncate text-xs text-text-muted">
                Namespace: {truncateMiddle(row.namespaceId, 42)}
              </div>
            </div>
            <StatusPill
              label={row.runtimeActive ? "active" : "artifact"}
              tone={row.runtimeActive ? "success" : "default"}
            />
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <MetricCard label="Sources" value={formatNumber(row.sourceIds.length)} />
            <MetricCard label="Connectors" value={formatNumber(row.connectorCount)} />
            <MetricCard label="Eval cases" value={formatNumber(row.evalCaseCount)} />
            <MetricCard
              label="Failures"
              value={formatNumber(row.evalFailureCount)}
              tone={row.evalFailureCount ? "error" : "success"}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function buildProfileRows(input: {
  readonly connectors: readonly ConnectorRegistryRecord[];
  readonly runtimeProfileId?: string;
  readonly runtimeNamespaceId?: string;
  readonly evalSuites: readonly {
    readonly profileId: string;
    readonly namespaceId: string;
    readonly caseCount: number;
    readonly failureCount: number;
  }[];
}): readonly ProfileRow[] {
  const records = new Map<string, MutableProfileRow>();
  const ensure = (profileId: string, namespaceId: string) => {
    const key = `${profileId}:${namespaceId}`;
    const existing = records.get(key);
    if (existing) return existing;
    const next: MutableProfileRow = {
      profileId,
      namespaceId,
      sourceIds: new Set<string>(),
      connectorCount: 0,
      evalCaseCount: 0,
      evalFailureCount: 0,
      runtimeActive:
        profileId === input.runtimeProfileId && namespaceId === input.runtimeNamespaceId
    };
    records.set(key, next);
    return next;
  };

  if (input.runtimeProfileId && input.runtimeNamespaceId) {
    ensure(input.runtimeProfileId, input.runtimeNamespaceId);
  }

  for (const connector of input.connectors) {
    if (!connector.profileId || !connector.namespaceId) continue;
    const row = ensure(connector.profileId, connector.namespaceId);
    row.connectorCount += 1;
    row.sourceIds.add(connector.sourceId);
  }

  for (const suite of input.evalSuites) {
    const row = ensure(suite.profileId, suite.namespaceId);
    row.evalCaseCount += suite.caseCount;
    row.evalFailureCount += suite.failureCount;
  }

  return [...records.values()]
    .map((row) => ({
      profileId: row.profileId,
      namespaceId: row.namespaceId,
      sourceIds: [...row.sourceIds].sort(),
      connectorCount: row.connectorCount,
      evalCaseCount: row.evalCaseCount,
      evalFailureCount: row.evalFailureCount,
      runtimeActive: row.runtimeActive
    }))
    .sort((left, right) =>
      left.runtimeActive === right.runtimeActive
        ? `${left.profileId}:${left.namespaceId}`.localeCompare(
            `${right.profileId}:${right.namespaceId}`
          )
        : left.runtimeActive
          ? -1
          : 1
    );
}

interface MutableProfileRow {
  readonly profileId: string;
  readonly namespaceId: string;
  readonly sourceIds: Set<string>;
  connectorCount: number;
  evalCaseCount: number;
  evalFailureCount: number;
  readonly runtimeActive: boolean;
}
