"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, Loader2, Power, RefreshCw, Repeat2, RotateCcw } from "lucide-react";
import type React from "react";

type ConnectorAction =
  | "delta_sync"
  | "full_sync"
  | "retry_failed"
  | "disable_connector"
  | "reenable_connector";

interface ConnectorActionButtonsProps {
  readonly connector: {
    readonly id: string;
    readonly connectorId: string;
    readonly sourceId: string;
    readonly enabled: boolean;
    readonly failedItemCount: number;
  };
}

interface ConnectorActionResponse {
  readonly status?: string;
  readonly actionId?: string;
  readonly sync?: {
    readonly status?: string;
    readonly data?: {
      readonly status?: string;
      readonly runId?: string;
      readonly metrics?: {
        readonly syncedRecordCount?: number;
        readonly syncFailedItemCount?: number;
        readonly ingestedDocumentCount?: number;
        readonly ingestedChunkCount?: number;
        readonly propagatedDeleteCount?: number;
      };
    };
    readonly error?: string;
  };
  readonly error?: {
    readonly name?: string;
    readonly message?: string;
  };
}

export function ConnectorActionButtons({ connector }: ConnectorActionButtonsProps) {
  const router = useRouter();
  const [busyAction, setBusyAction] = useState<ConnectorAction | undefined>();
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string }>();

  const isBusy = busyAction !== undefined;
  const disabled = isBusy || !connector.enabled;

  async function runAction(action: ConnectorAction) {
    if (action === "full_sync") {
      const confirmed = window.confirm(
        "Run a full sync for this connector? Missing source items can propagate deletes when the connector returns a complete listing."
      );
      if (!confirmed) return;
    }
    if (action === "disable_connector") {
      const confirmed = window.confirm(
        "Disable this connector in the admin console? Sync actions will be blocked until it is re-enabled."
      );
      if (!confirmed) return;
    }

    setBusyAction(action);
    setMessage(undefined);
    try {
      const response = await fetch("/api/rag/connectors/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          connectorRecordId: connector.id,
          requestedBy: "admin_ui"
        })
      });
      const json = (await response.json().catch(() => ({}))) as ConnectorActionResponse;
      if (!response.ok) {
        throw new Error(errorMessage(json) ?? `Connector action failed with ${response.status}.`);
      }
      setMessage({ tone: "success", text: successMessage(action, json) });
      router.refresh();
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Connector action failed."
      });
    } finally {
      setBusyAction(undefined);
    }
  }

  return (
    <div className="min-w-[260px] space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {connector.enabled ? (
          <>
            <ActionButton
              action="delta_sync"
              label="Delta"
              title="Run scoped delta sync"
              disabled={disabled}
              busyAction={busyAction}
              onClick={runAction}
              icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
            />
            <ActionButton
              action="full_sync"
              label="Full"
              title="Run scoped full sync"
              disabled={disabled}
              busyAction={busyAction}
              onClick={runAction}
              icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}
            />
            <ActionButton
              action="retry_failed"
              label="Retry"
              title={
                connector.failedItemCount > 0
                  ? "Retry failed items with a scoped delta sync"
                  : "No failed items in the latest artifact"
              }
              disabled={disabled || connector.failedItemCount <= 0}
              busyAction={busyAction}
              onClick={runAction}
              icon={<Repeat2 className="h-3.5 w-3.5" aria-hidden="true" />}
            />
            <ActionButton
              action="disable_connector"
              label="Disable"
              title="Disable connector sync actions"
              disabled={isBusy || !connector.enabled}
              busyAction={busyAction}
              onClick={runAction}
              icon={<Ban className="h-3.5 w-3.5" aria-hidden="true" />}
              danger
            />
          </>
        ) : (
          <ActionButton
            action="reenable_connector"
            label="Re-enable"
            title="Re-enable connector sync actions"
            disabled={isBusy}
            busyAction={busyAction}
            onClick={runAction}
            icon={<Power className="h-3.5 w-3.5" aria-hidden="true" />}
          />
        )}
      </div>
      {message ? (
        <div
          className={`max-w-[360px] text-xs leading-5 ${
            message.tone === "success" ? "text-success" : "text-error"
          }`}
        >
          {message.text}
        </div>
      ) : null}
    </div>
  );
}

function ActionButton({
  action,
  label,
  title,
  disabled,
  busyAction,
  icon,
  danger = false,
  onClick
}: {
  readonly action: ConnectorAction;
  readonly label: string;
  readonly title: string;
  readonly disabled: boolean;
  readonly busyAction: ConnectorAction | undefined;
  readonly icon: React.ReactNode;
  readonly danger?: boolean;
  readonly onClick: (action: ConnectorAction) => void;
}) {
  const busy = busyAction === action;
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={() => onClick(action)}
      className={`inline-flex min-h-8 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
        danger
          ? "border-error/20 text-error hover:border-error/40 hover:bg-error/10"
          : "border-card text-text-secondary hover:border-primary/30 hover:text-text-primary"
      } disabled:cursor-not-allowed disabled:opacity-45`}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : icon}
      <span>{label}</span>
    </button>
  );
}

function successMessage(action: ConnectorAction, response: ConnectorActionResponse): string {
  if (action === "disable_connector") return "Connector disabled.";
  if (action === "reenable_connector") return "Connector re-enabled.";
  const sync = response.sync?.data;
  const metrics = sync?.metrics;
  const parts = [
    sync?.status ?? response.status ?? "submitted",
    sync?.runId ? `run ${sync.runId}` : undefined,
    formatCount(metrics?.syncedRecordCount, "records"),
    formatCount(metrics?.ingestedDocumentCount, "docs"),
    formatCount(metrics?.ingestedChunkCount, "chunks"),
    formatCount(metrics?.propagatedDeleteCount, "deletes"),
    formatCount(metrics?.syncFailedItemCount, "failed")
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

function errorMessage(response: ConnectorActionResponse): string | undefined {
  if (response.error?.message) {
    return response.error.name
      ? `${response.error.name}: ${response.error.message}`
      : response.error.message;
  }
  return response.sync?.error;
}

function formatCount(value: number | undefined, label: string): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toLocaleString()} ${label}`
    : undefined;
}
