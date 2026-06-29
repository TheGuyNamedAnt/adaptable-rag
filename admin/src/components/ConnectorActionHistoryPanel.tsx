"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { StatusPill } from "@/components/ui";
import { formatNumber, formatTime, statusTone, truncateMiddle } from "@/lib/format";

interface ConnectorActionHistoryResult {
  readonly generatedAt: string;
  readonly records: readonly ConnectorActionAuditRecord[];
  readonly page: {
    readonly limit: number;
    readonly offset: number;
    readonly hasMore: boolean;
    readonly truncated: boolean;
    readonly storageKind: "postgres" | "json_file";
  };
}

interface ConnectorActionAuditRecord {
  readonly actionId: string;
  readonly action: string;
  readonly status: string;
  readonly requestedAt: string;
  readonly finishedAt: string;
  readonly requestedBy: string;
  readonly connectorRecordId?: string;
  readonly companyId?: string;
  readonly connectorId?: string;
  readonly sourceId?: string;
  readonly namespaceId?: string;
  readonly mode?: "delta" | "full";
  readonly deleteMissing?: boolean;
  readonly command?: readonly string[];
  readonly result?: {
    readonly syncStatus?: string;
    readonly runId?: string;
    readonly mode?: string;
    readonly connectorCount?: number;
    readonly sourceCount?: number;
    readonly syncedRecordCount?: number;
    readonly syncFailedItemCount?: number;
    readonly ingestedDocumentCount?: number;
    readonly ingestedChunkCount?: number;
    readonly rejectedRecordCount?: number;
    readonly propagatedDeleteCount?: number;
    readonly deletedDocumentCount?: number;
    readonly deletedChunkCount?: number;
  };
  readonly error?: string;
}

export function ConnectorActionHistoryPanel({
  initialHistory
}: {
  readonly initialHistory: ConnectorActionHistoryResult;
}) {
  const [history, setHistory] = useState(initialHistory);
  const [expandedActionId, setExpandedActionId] = useState<string | undefined>();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function refreshHistory() {
    setRefreshing(true);
    setError(undefined);
    try {
      const response = await fetch("/api/rag/connectors/actions?limit=12", {
        cache: "no-store"
      });
      const json = (await response.json()) as ConnectorActionHistoryResult;
      if (!response.ok) throw new Error(`History refresh failed with ${response.status}.`);
      setHistory(json);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "History refresh failed.");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-text-muted">
          {formatNumber(history.records.length)} recent · {storageLabel(history.page.storageKind)} ·{" "}
          {formatTime(history.generatedAt)}
        </div>
        <button
          type="button"
          onClick={refreshHistory}
          disabled={refreshing}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-card px-2.5 py-1.5 text-xs text-text-secondary hover:border-primary/30 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          Refresh
        </button>
      </div>

      {history.page.truncated ? (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-2 text-xs leading-5 text-warning">
          Showing the recent audit window. Increase the action-log read limit for deeper history.
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-error/20 bg-error/10 p-2 text-xs leading-5 text-error">
          {error}
        </div>
      ) : null}

      {history.records.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card bg-card/40 p-3 text-xs leading-5 text-text-muted">
          No connector actions recorded yet.
        </div>
      ) : (
        <div className="space-y-2">
          {history.records.map((record) => {
            const expanded = expandedActionId === record.actionId;
            return (
              <div
                key={record.actionId}
                className="rounded-lg border border-card bg-background p-3"
              >
                <button
                  type="button"
                  onClick={() => setExpandedActionId(expanded ? undefined : record.actionId)}
                  className="flex w-full items-start justify-between gap-2 text-left"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {expanded ? (
                        <ChevronDown className="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />
                      )}
                      <span className="text-sm font-medium">{actionLabel(record.action)}</span>
                      <StatusPill label={record.status} tone={statusTone(record.status)} />
                    </div>
                    <div className="mt-1 truncate text-xs text-text-muted">
                      {record.connectorId
                        ? truncateMiddle(record.connectorId, 30)
                        : "connector n/a"}{" "}
                      · {record.sourceId ? truncateMiddle(record.sourceId, 30) : "source n/a"}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-xs text-text-muted">
                    {formatTime(record.requestedAt)}
                  </div>
                </button>

                {expanded ? <ActionDetails record={record} /> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ActionDetails({ record }: { readonly record: ConnectorActionAuditRecord }) {
  const command = record.command?.join(" ");
  return (
    <div className="mt-3 space-y-3 border-t border-card pt-3 text-xs leading-5 text-text-secondary">
      <div className="grid gap-2 sm:grid-cols-2">
        <Detail label="Action id" value={truncateMiddle(record.actionId, 34)} />
        <Detail label="Requested by" value={record.requestedBy} />
        <Detail label="Company" value={record.companyId ?? "n/a"} />
        <Detail label="Namespace" value={record.namespaceId ?? "n/a"} />
        <Detail label="Mode" value={record.mode ?? record.result?.mode ?? "n/a"} />
        <Detail label="Delete missing" value={record.deleteMissing === true ? "yes" : "no"} />
        <Detail label="Run id" value={record.result?.runId ?? "n/a"} />
        <Detail label="Sync status" value={record.result?.syncStatus ?? "n/a"} />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Metric label="Records" value={record.result?.syncedRecordCount} />
        <Metric label="Docs" value={record.result?.ingestedDocumentCount} />
        <Metric label="Chunks" value={record.result?.ingestedChunkCount} />
        <Metric label="Rejected" value={record.result?.rejectedRecordCount} />
        <Metric label="Deletes" value={record.result?.propagatedDeleteCount} />
        <Metric label="Failed" value={record.result?.syncFailedItemCount} />
      </div>

      {record.error ? (
        <div className="rounded-lg border border-error/20 bg-error/10 p-2 text-error">
          {record.error}
        </div>
      ) : null}

      {command ? (
        <pre className="max-h-28 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg border border-card bg-card/50 p-2 font-mono text-[11px] leading-5 text-text-muted">
          {command}
        </pre>
      ) : null}
    </div>
  );
}

function Detail({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-[0.08em] text-text-muted">{label}</div>
      <div className="truncate text-text-secondary">{value}</div>
    </div>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: number | undefined }) {
  return (
    <div className="rounded-lg border border-card bg-card/40 px-2 py-1.5">
      <div className="text-sm font-semibold">{formatNumber(value)}</div>
      <div className="text-[11px] text-text-muted">{label}</div>
    </div>
  );
}

function actionLabel(action: string): string {
  switch (action) {
    case "delta_sync":
      return "Delta sync";
    case "full_sync":
      return "Full sync";
    case "retry_failed":
      return "Retry failed";
    case "disable_connector":
      return "Disable";
    case "reenable_connector":
      return "Re-enable";
    default:
      return action;
  }
}

function storageLabel(kind: "postgres" | "json_file"): string {
  return kind === "postgres" ? "Postgres" : "Local file";
}
