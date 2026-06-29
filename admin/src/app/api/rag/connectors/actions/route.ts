import { NextResponse } from "next/server";
import type { AdminPreflightFailure } from "@/lib/admin-api-preflight";
import {
  appendConnectorActionAudit,
  disableConnectorOverride,
  getConnectorActionHistory,
  newConnectorActionId,
  reenableConnectorOverride,
  type ConnectorActionAuditRecord,
  type ConnectorActionAuditResult,
  type ConnectorActionAuditStatus,
  type ConnectorAdminAction
} from "@/lib/connector-admin-state";
import { getConnectorRegistry, type ConnectorRegistryRecord } from "@/lib/connector-registry";
import {
  runCompanyConnectorSync,
  type AdminCompanySyncResult,
  type Availability
} from "@/lib/rag-admin-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONNECTOR_ACTIONS: ReadonlySet<ConnectorAdminAction> = new Set([
  "delta_sync",
  "full_sync",
  "retry_failed",
  "disable_connector",
  "reenable_connector"
]);

interface ConnectorActionRequestBody {
  readonly action?: unknown;
  readonly connectorRecordId?: unknown;
  readonly reason?: unknown;
  readonly requestedBy?: unknown;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  return NextResponse.json(
    await getConnectorActionHistory({
      connectorRecordId: stringField(url.searchParams.get("connectorRecordId")),
      limit: numberField(url.searchParams.get("limit")),
      offset: numberField(url.searchParams.get("offset"))
    })
  );
}

export async function POST(request: Request) {
  const requestedAt = new Date().toISOString();
  const actionId = newConnectorActionId();
  const body = await parseRequestBody(request);
  if (!body) {
    return NextResponse.json(
      {
        status: "rejected",
        actionId,
        error: {
          name: "InvalidConnectorActionBody",
          message: "Connector action body must be JSON."
        }
      },
      { status: 400 }
    );
  }

  const action = parseAction(body.action);
  const connectorRecordId = stringField(body.connectorRecordId);
  const requestedBy = stringField(body.requestedBy) ?? "admin_ui";
  if (!action || !connectorRecordId) {
    await appendConnectorActionAudit({
      actionId,
      action: action ?? "delta_sync",
      status: "rejected",
      requestedAt,
      finishedAt: new Date().toISOString(),
      requestedBy,
      connectorRecordId,
      error: "Connector action and connectorRecordId are required."
    });
    return NextResponse.json(
      {
        status: "rejected",
        actionId,
        error: {
          name: "InvalidConnectorAction",
          message: "Connector action and connectorRecordId are required."
        }
      },
      { status: 400 }
    );
  }

  const registry = await getConnectorRegistry();
  const connector = registry.connectors.find((record) => record.id === connectorRecordId);
  if (!connector) {
    await appendConnectorActionAudit({
      actionId,
      action,
      status: "rejected",
      requestedAt,
      finishedAt: new Date().toISOString(),
      requestedBy,
      connectorRecordId,
      error: "Connector record was not found."
    });
    return NextResponse.json(
      {
        status: "rejected",
        actionId,
        error: {
          name: "ConnectorNotFound",
          message: "Connector record was not found."
        }
      },
      { status: 404 }
    );
  }

  if (action === "disable_connector") {
    return disableConnectorAction({
      actionId,
      requestedAt,
      requestedBy,
      connector,
      reason: reasonField(body.reason)
    });
  }

  if (action === "reenable_connector") {
    return reenableConnectorAction({
      actionId,
      requestedAt,
      requestedBy,
      connector
    });
  }

  if (!connector.enabled) {
    await appendConnectorActionAudit(
      actionAuditRecord({
        actionId,
        action,
        status: "rejected",
        requestedAt,
        requestedBy,
        connector,
        error: "Connector is disabled."
      })
    );
    return NextResponse.json(
      {
        status: "rejected",
        actionId,
        connector: connectorSummary(connector),
        error: connectorPreflightError({
          name: "ConnectorDisabled",
          code: "connector_disabled",
          message: "Connector is disabled. Re-enable it before running sync.",
          actionHref: "/connectors",
          actionLabel: "Re-enable Connector",
          details: {
            connector: connectorSummary(connector)
          }
        })
      },
      { status: 409 }
    );
  }

  if (action === "retry_failed" && connector.failedItemCount <= 0) {
    await appendConnectorActionAudit(
      actionAuditRecord({
        actionId,
        action,
        status: "rejected",
        requestedAt,
        requestedBy,
        connector,
        error: "Connector does not have failed items in the latest artifact."
      })
    );
    return NextResponse.json(
      {
        status: "rejected",
        actionId,
        connector: connectorSummary(connector),
        error: connectorPreflightError({
          name: "NoFailedConnectorItems",
          code: "connector_retry_not_needed",
          message: "Connector does not have failed items in the latest artifact.",
          actionHref: "/connectors",
          actionLabel: "Review Connector",
          details: {
            connector: connectorSummary(connector),
            failedItemCount: connector.failedItemCount
          }
        })
      },
      { status: 409 }
    );
  }

  return syncConnectorAction({
    actionId,
    action,
    requestedAt,
    requestedBy,
    connector
  });
}

async function disableConnectorAction(input: {
  readonly actionId: string;
  readonly requestedAt: string;
  readonly requestedBy: string;
  readonly connector: ConnectorRegistryRecord;
  readonly reason?: string;
}) {
  const disabled = await disableConnectorOverride({
    id: input.connector.id,
    companyId: input.connector.companyId,
    connectorId: input.connector.connectorId,
    sourceId: input.connector.sourceId,
    namespaceId: input.connector.namespaceId,
    disabledAt: new Date().toISOString(),
    disabledBy: input.requestedBy,
    reason: input.reason
  });
  const finishedAt = new Date().toISOString();
  await appendConnectorActionAudit(
    actionAuditRecord({
      actionId: input.actionId,
      action: "disable_connector",
      status: "succeeded",
      requestedAt: input.requestedAt,
      finishedAt,
      requestedBy: input.requestedBy,
      connector: input.connector
    })
  );
  return NextResponse.json({
    status: "disabled",
    actionId: input.actionId,
    connector: connectorSummary({ ...input.connector, enabled: false }),
    disabled
  });
}

async function reenableConnectorAction(input: {
  readonly actionId: string;
  readonly requestedAt: string;
  readonly requestedBy: string;
  readonly connector: ConnectorRegistryRecord;
}) {
  if (input.connector.enabled) {
    await appendConnectorActionAudit(
      actionAuditRecord({
        actionId: input.actionId,
        action: "reenable_connector",
        status: "rejected",
        requestedAt: input.requestedAt,
        requestedBy: input.requestedBy,
        connector: input.connector,
        error: "Connector is already enabled."
      })
    );
    return NextResponse.json(
      {
        status: "rejected",
        actionId: input.actionId,
        connector: connectorSummary(input.connector),
        error: connectorPreflightError({
          name: "ConnectorAlreadyEnabled",
          code: "connector_already_enabled",
          message: "Connector is already enabled.",
          actionHref: "/connectors",
          actionLabel: "Review Connector",
          details: {
            connector: connectorSummary(input.connector)
          }
        })
      },
      { status: 409 }
    );
  }

  const removed = await reenableConnectorOverride(input.connector.id);
  const finishedAt = new Date().toISOString();
  await appendConnectorActionAudit(
    actionAuditRecord({
      actionId: input.actionId,
      action: "reenable_connector",
      status: removed ? "succeeded" : "rejected",
      requestedAt: input.requestedAt,
      finishedAt,
      requestedBy: input.requestedBy,
      connector: input.connector,
      error: removed ? undefined : "Disabled connector override was not found."
    })
  );
  if (!removed) {
    return NextResponse.json(
      {
        status: "rejected",
        actionId: input.actionId,
        connector: connectorSummary(input.connector),
        error: connectorPreflightError({
          name: "DisabledConnectorOverrideNotFound",
          code: "connector_disabled_override_missing",
          message: "Disabled connector override was not found.",
          actionHref: "/connectors",
          actionLabel: "Review Connector",
          details: {
            connector: connectorSummary(input.connector)
          }
        })
      },
      { status: 409 }
    );
  }

  return NextResponse.json({
    status: "enabled",
    actionId: input.actionId,
    connector: connectorSummary({ ...input.connector, enabled: true })
  });
}

async function syncConnectorAction(input: {
  readonly actionId: string;
  readonly action: Exclude<ConnectorAdminAction, "disable_connector" | "reenable_connector">;
  readonly requestedAt: string;
  readonly requestedBy: string;
  readonly connector: ConnectorRegistryRecord;
}) {
  const mode = input.action === "full_sync" ? "full" : "delta";
  const deleteMissing = input.action === "full_sync";
  const sync = await runCompanyConnectorSync({
    companyId: input.connector.companyId,
    connectorId: input.connector.connectorId,
    sourceId: input.connector.sourceId,
    namespaceId: input.connector.namespaceId,
    mode,
    deleteMissing,
    requestedAt: input.requestedAt,
    runId: `${input.actionId}_${mode}`
  });
  const auditStatus = syncAuditStatus(sync);
  const result = sync.data === undefined ? undefined : syncAuditResult(sync.data);
  await appendConnectorActionAudit(
    actionAuditRecord({
      actionId: input.actionId,
      action: input.action,
      status: auditStatus,
      requestedAt: input.requestedAt,
      requestedBy: input.requestedBy,
      connector: input.connector,
      mode,
      deleteMissing,
      command: sync.command,
      result,
      error: sync.error
    })
  );

  return NextResponse.json(
    {
      status: auditStatus,
      actionId: input.actionId,
      connector: connectorSummary(input.connector),
      sync: {
        status: sync.status,
        data: sync.data,
        error: sync.error,
        command: sync.command
      }
    },
    { status: sync.status === "available" ? 200 : 502 }
  );
}

function actionAuditRecord(input: {
  readonly actionId: string;
  readonly action: ConnectorAdminAction;
  readonly status: ConnectorActionAuditStatus;
  readonly requestedAt: string;
  readonly finishedAt?: string;
  readonly requestedBy: string;
  readonly connector?: ConnectorRegistryRecord;
  readonly connectorRecordId?: string;
  readonly mode?: "delta" | "full";
  readonly deleteMissing?: boolean;
  readonly command?: readonly string[];
  readonly result?: ConnectorActionAuditResult;
  readonly error?: string;
}): ConnectorActionAuditRecord {
  return {
    actionId: input.actionId,
    action: input.action,
    status: input.status,
    requestedAt: input.requestedAt,
    finishedAt: input.finishedAt ?? new Date().toISOString(),
    requestedBy: input.requestedBy,
    connectorRecordId: input.connector?.id ?? input.connectorRecordId,
    companyId: input.connector?.companyId,
    connectorId: input.connector?.connectorId,
    sourceId: input.connector?.sourceId,
    namespaceId: input.connector?.namespaceId,
    mode: input.mode,
    deleteMissing: input.deleteMissing,
    command: input.command,
    result: input.result,
    error: input.error
  };
}

function syncAuditStatus(sync: Availability<AdminCompanySyncResult>): ConnectorActionAuditStatus {
  if (sync.status === "unavailable") return "failed";
  if (sync.data?.status === "failed") return "failed";
  if (sync.data?.status === "partial") return "partial";
  return "succeeded";
}

function syncAuditResult(result: AdminCompanySyncResult): ConnectorActionAuditResult {
  return {
    syncStatus: result.status,
    runId: result.runId,
    mode: result.mode,
    connectorCount: result.connectorCount,
    sourceCount: result.sourceCount,
    syncedRecordCount: result.metrics?.syncedRecordCount,
    syncFailedItemCount: result.metrics?.syncFailedItemCount,
    ingestedDocumentCount: result.metrics?.ingestedDocumentCount,
    ingestedChunkCount: result.metrics?.ingestedChunkCount,
    rejectedRecordCount: result.metrics?.rejectedRecordCount,
    propagatedDeleteCount: result.metrics?.propagatedDeleteCount,
    deletedDocumentCount: result.metrics?.deletedDocumentCount,
    deletedChunkCount: result.metrics?.deletedChunkCount,
    sourceResults: result.results?.map((sourceResult) => ({
      connectorId: sourceResult.connectorId,
      sourceId: sourceResult.sourceId,
      status: sourceResult.status,
      runId: sourceResult.runId,
      mode: sourceResult.mode,
      returnedRecordCount: sourceResult.sync?.returnedRecordCount,
      deletedItemCount: sourceResult.sync?.deletedItemCount,
      failedItemCount: sourceResult.sync?.failedItemCount,
      warningCount: sourceResult.sync?.warningCount,
      documentCount: sourceResult.ingest?.documentCount,
      chunkCount: sourceResult.ingest?.chunkCount,
      rejectedRecordCount: sourceResult.ingest?.rejectedRecordCount
    }))
  };
}

function connectorSummary(connector: ConnectorRegistryRecord) {
  return {
    id: connector.id,
    companyId: connector.companyId,
    connectorId: connector.connectorId,
    sourceId: connector.sourceId,
    namespaceId: connector.namespaceId,
    enabled: connector.enabled,
    status: connector.status,
    failedItemCount: connector.failedItemCount
  };
}

function connectorPreflightError(failure: AdminPreflightFailure) {
  return {
    name: failure.name,
    message: failure.message,
    preflight: failure
  };
}

async function parseRequestBody(request: Request): Promise<ConnectorActionRequestBody | undefined> {
  try {
    const value = (await request.json()) as unknown;
    return typeof value === "object" && value !== null
      ? (value as ConnectorActionRequestBody)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseAction(value: unknown): ConnectorAdminAction | undefined {
  if (typeof value !== "string") return undefined;
  return CONNECTOR_ACTIONS.has(value as ConnectorAdminAction)
    ? (value as ConnectorAdminAction)
    : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 256) : undefined;
}

function reasonField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : undefined;
}

function numberField(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
