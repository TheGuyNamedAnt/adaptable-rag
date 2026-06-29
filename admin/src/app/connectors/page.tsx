import { RefreshCw, UploadCloud } from "lucide-react";
import { ConnectorActionButtons } from "@/components/ConnectorActionButtons";
import { ConnectorActionHistoryPanel } from "@/components/ConnectorActionHistoryPanel";
import {
  EmptyState,
  IconLink,
  MetricCard,
  NoticeBanner,
  PageGuide,
  PageHeader,
  SectionCard,
  StatusPill
} from "@/components/ui";
import { formatNumber, formatTime, statusTone, truncateMiddle } from "@/lib/format";
import { getConnectorActionHistory } from "@/lib/connector-admin-state";
import { getConnectorRegistry, type ConnectorRegistryRecord } from "@/lib/connector-registry";

export default async function ConnectorsPage() {
  const registry = await getConnectorRegistry();
  const actionHistory = await getConnectorActionHistory({ limit: 12 });
  const failedCount = registry.connectors.filter(
    (connector) => connector.status === "failed"
  ).length;
  const warningCount = registry.connectors.filter(
    (connector) => connector.status === "warning"
  ).length;
  const passedCount = registry.connectors.filter(
    (connector) => connector.status === "passed"
  ).length;

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Configure"
        title="Connectors"
        description="Configure repeatable source systems, then sync them as an Add Knowledge intake path."
        actions={
          <>
            <IconLink href="/ingestion" icon={UploadCloud} label="Add Knowledge" />
            <IconLink href="/connectors" icon={RefreshCw} label="Refresh" />
          </>
        }
      />

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">
        {registry.connectors.length === 0 ? (
          <NoticeBanner
            title="No installed connector packs"
            message="Copy the company connector pack template into a deployment repo and run the company validation command. Upload-based local sources still work from Add Knowledge."
          />
        ) : null}

        <PageGuide
          title="Use this when knowledge should come from a company system"
          description="Connectors is where repeatable source systems are configured and synced. Add Knowledge points here when the intake method is a connector instead of a manual upload."
          steps={[
            "Validate or configure the connector pack.",
            "Check source id and namespace coverage.",
            "Sync, retry, disable, or re-enable from the connector row."
          ]}
          tone={failedCount ? "error" : warningCount ? "warning" : "primary"}
        />

        <SectionCard
          title="Connector Summary"
          description="Contract status comes from safe deployment artifacts under .rag/company."
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <MetricCard
              label="Connectors"
              value={formatNumber(registry.connectors.length)}
              tone="primary"
            />
            <MetricCard label="Deployments" value={formatNumber(registry.deployments.length)} />
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
            <MetricCard label="Templates" value={formatNumber(registry.catalog.length)} />
          </div>
        </SectionCard>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <SectionCard
              title="Installed Connector Packs"
              description="Configured connectors mapped to source ids and namespaces."
            >
              {registry.connectors.length === 0 ? (
                <EmptyState
                  title="No connector records found"
                  detail="The company deployment validator has not emitted connector artifacts yet."
                  actionHref="/ingestion"
                  actionLabel="Open Add Knowledge"
                />
              ) : (
                <div className="max-w-full overflow-x-auto">
                  <table className="w-full min-w-[1120px] text-left text-sm">
                    <thead className="border-b border-card text-xs uppercase tracking-[0.08em] text-text-muted">
                      <tr>
                        <th className="px-2 py-2 font-medium">Connector</th>
                        <th className="px-2 py-2 font-medium">Status</th>
                        <th className="px-2 py-2 font-medium">Source</th>
                        <th className="px-2 py-2 font-medium">Modes</th>
                        <th className="px-2 py-2 font-medium">Returned</th>
                        <th className="px-2 py-2 font-medium">Deleted</th>
                        <th className="px-2 py-2 font-medium">Checked</th>
                        <th className="px-2 py-2 font-medium">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-card">
                      {registry.connectors.map((connector) => (
                        <ConnectorRow key={connector.id} connector={connector} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>

            <SectionCard
              title="Company Deployments"
              description="Deployment-level readiness and connector contract coverage."
            >
              {registry.deployments.length === 0 ? (
                <EmptyState
                  title="No deployment artifacts found"
                  detail="Deployment readiness appears after company validation emits deployment artifacts."
                  actionHref="/profiles"
                  actionLabel="Review Profiles"
                />
              ) : (
                <div className="grid gap-2 md:grid-cols-2">
                  {registry.deployments.map((deployment) => (
                    <div
                      key={deployment.artifactId}
                      className="rounded-lg border border-card bg-background p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">
                            {deployment.companyName}
                          </div>
                          <div className="truncate text-xs text-text-muted">
                            {deployment.artifactId}
                          </div>
                        </div>
                        <StatusPill
                          label={deployment.status}
                          tone={statusTone(deployment.status)}
                        />
                      </div>
                      <div className="mt-3 grid grid-cols-3 gap-2">
                        <MetricCard
                          label="RAG Profile"
                          value={formatNumber(deployment.profileCount)}
                        />
                        <MetricCard
                          label="Connectors"
                          value={formatNumber(deployment.connectorCount)}
                        />
                        <MetricCard
                          label="Cases"
                          value={formatNumber(deployment.checkedCaseCount)}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>

          <aside className="space-y-4">
            <SectionCard
              title="Action History"
              description="Recent connector sync, retry, disable, and re-enable attempts."
            >
              <ConnectorActionHistoryPanel initialHistory={actionHistory} />
            </SectionCard>

            <SectionCard
              title="Connector Catalog"
              description="Common plug-and-play source systems this console is structured to support."
            >
              <div className="space-y-2">
                {registry.catalog.map((catalogItem) => (
                  <div
                    key={catalogItem.id}
                    className="rounded-lg border border-card bg-background p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium">{catalogItem.label}</div>
                      <StatusPill label={catalogItem.status} tone="primary" />
                    </div>
                    <div className="mt-1 text-xs text-text-muted">{catalogItem.category}</div>
                    <div className="mt-2 text-xs leading-5 text-text-secondary">
                      {catalogItem.notes}
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          </aside>
        </div>
      </main>
    </div>
  );
}

function ConnectorRow({ connector }: { connector: ConnectorRegistryRecord }) {
  return (
    <tr className="hover:bg-card/50">
      <td className="px-2 py-3">
        <div className="font-medium">{truncateMiddle(connector.connectorId, 42)}</div>
        <div className="text-xs text-text-muted">
          {connector.sourceSystem} · {connector.companyName}
        </div>
      </td>
      <td className="px-2 py-3">
        <div className="flex flex-wrap gap-1.5">
          <StatusPill label={connector.status} tone={statusTone(connector.status)} />
          {!connector.enabled ? (
            <StatusPill label="disabled" tone={statusTone("disabled")} />
          ) : null}
        </div>
        {connector.disabledReason ? (
          <div className="mt-1 max-w-[220px] truncate text-xs text-text-muted">
            {connector.disabledReason}
          </div>
        ) : null}
      </td>
      <td className="px-2 py-3">
        <div className="font-medium text-text-secondary">
          {truncateMiddle(connector.sourceId, 42)}
        </div>
        <div className="text-xs text-text-muted">{connector.namespaceId ?? "namespace n/a"}</div>
      </td>
      <td className="px-2 py-3 text-text-secondary">
        {connector.modes.length ? connector.modes.join(", ") : "n/a"}
      </td>
      <td className="px-2 py-3 text-text-secondary">
        {formatNumber(connector.returnedRecordCount)}
      </td>
      <td className="px-2 py-3 text-text-secondary">{formatNumber(connector.deletedItemCount)}</td>
      <td className="px-2 py-3 text-text-muted">{formatTime(connector.lastCheckedAt)}</td>
      <td className="px-2 py-3">
        <ConnectorActionButtons
          connector={{
            id: connector.id,
            connectorId: connector.connectorId,
            sourceId: connector.sourceId,
            enabled: connector.enabled,
            failedItemCount: connector.failedItemCount
          }}
        />
      </td>
    </tr>
  );
}
