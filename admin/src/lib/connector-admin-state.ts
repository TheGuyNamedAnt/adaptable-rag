import "server-only";

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import type { Pool } from "pg";
import { resolveRagRepoRoot } from "@/lib/repo-root";

export type ConnectorAdminAction =
  | "delta_sync"
  | "full_sync"
  | "retry_failed"
  | "disable_connector"
  | "reenable_connector";

export type ConnectorActionAuditStatus = "succeeded" | "partial" | "failed" | "rejected";
export type ConnectorAdminStateStorageKind = "postgres" | "json_file";

export interface DisabledConnectorOverride {
  readonly id: string;
  readonly companyId: string;
  readonly connectorId: string;
  readonly sourceId: string;
  readonly namespaceId?: string;
  readonly disabledAt: string;
  readonly disabledBy: string;
  readonly reason?: string;
}

export interface ConnectorActionAuditRecord {
  readonly actionId: string;
  readonly action: ConnectorAdminAction;
  readonly status: ConnectorActionAuditStatus;
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
  readonly result?: ConnectorActionAuditResult;
  readonly error?: string;
}

export interface ConnectorActionHistoryResult {
  readonly generatedAt: string;
  readonly records: readonly ConnectorActionAuditRecord[];
  readonly page: {
    readonly limit: number;
    readonly offset: number;
    readonly hasMore: boolean;
    readonly truncated: boolean;
    readonly storageKind: ConnectorAdminStateStorageKind;
  };
}

export interface ConnectorActionHistoryQuery {
  readonly connectorRecordId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ConnectorActionAuditResult {
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
  readonly sourceResults?: readonly ConnectorActionAuditSourceResult[];
}

export interface ConnectorActionAuditSourceResult {
  readonly connectorId?: string;
  readonly sourceId?: string;
  readonly status?: string;
  readonly runId?: string;
  readonly mode?: string;
  readonly returnedRecordCount?: number;
  readonly deletedItemCount?: number;
  readonly failedItemCount?: number;
  readonly warningCount?: number;
  readonly documentCount?: number;
  readonly chunkCount?: number;
  readonly rejectedRecordCount?: number;
}

interface DisabledConnectorState {
  readonly updatedAt?: string;
  readonly disabledConnectors?: readonly DisabledConnectorOverride[];
}

const DEFAULT_SCHEMA = "rag_core";
const ADMIN_CONNECTOR_ACTIONS_TABLE = "admin_connector_actions";
const ADMIN_CONNECTOR_DISABLED_TABLE = "admin_connector_disabled_overrides";

let postgresPool: Pool | undefined;

export async function getDisabledConnectorOverrides(): Promise<
  ReadonlyMap<string, DisabledConnectorOverride>
> {
  if (connectorAdminStateStorageKind() === "postgres") {
    return getDisabledConnectorOverridesFromPostgres();
  }

  const state = await readJson<DisabledConnectorState>(disabledConnectorsFile());
  const overrides = new Map<string, DisabledConnectorOverride>();
  for (const override of state?.disabledConnectors ?? []) {
    if (isDisabledConnectorOverride(override)) {
      overrides.set(override.id, override);
    }
  }
  return overrides;
}

export async function disableConnectorOverride(
  override: DisabledConnectorOverride
): Promise<DisabledConnectorOverride> {
  if (connectorAdminStateStorageKind() === "postgres") {
    await disableConnectorOverrideInPostgres(override);
    return override;
  }

  const overrides = new Map(await getDisabledConnectorOverrides());
  overrides.set(override.id, override);
  await writeDisabledConnectorOverrides([...overrides.values()]);
  return override;
}

export async function reenableConnectorOverride(connectorRecordId: string): Promise<boolean> {
  if (connectorAdminStateStorageKind() === "postgres") {
    return reenableConnectorOverrideInPostgres(connectorRecordId);
  }

  const overrides = new Map(await getDisabledConnectorOverrides());
  const existed = overrides.delete(connectorRecordId);
  if (existed) {
    await writeDisabledConnectorOverrides([...overrides.values()]);
  }
  return existed;
}

export async function appendConnectorActionAudit(
  record: ConnectorActionAuditRecord
): Promise<void> {
  if (connectorAdminStateStorageKind() === "postgres") {
    await appendConnectorActionAuditToPostgres(record);
    return;
  }

  await mkdir(/*turbopackIgnore: true*/ connectorAdminRoot(), { recursive: true });
  await appendFile(
    /*turbopackIgnore: true*/ connectorActionLogFile(),
    `${JSON.stringify(record)}\n`,
    "utf8"
  );
}

export async function getConnectorActionHistory(
  query: ConnectorActionHistoryQuery = {}
): Promise<ConnectorActionHistoryResult> {
  const limit = boundedInteger(query.limit, 20, 1, 100);
  const offset = boundedInteger(query.offset, 0, 0, 10_000);
  if (connectorAdminStateStorageKind() === "postgres") {
    return getConnectorActionHistoryFromPostgres({ ...query, limit, offset });
  }

  const read = await readConnectorActionLog();
  const filtered = read.records
    .filter((record) =>
      query.connectorRecordId ? record.connectorRecordId === query.connectorRecordId : true
    )
    .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
  const records = filtered.slice(offset, offset + limit);
  return {
    generatedAt: new Date().toISOString(),
    records,
    page: {
      limit,
      offset,
      hasMore: filtered.length > offset + limit,
      truncated: read.truncated,
      storageKind: "json_file"
    }
  };
}

export function getConnectorAdminStateStorageKind(): ConnectorAdminStateStorageKind {
  return connectorAdminStateStorageKind();
}

export function newConnectorActionId(): string {
  return `connector_action_${new Date().toISOString().replace(/[^0-9a-z]/gi, "")}_${randomUUID().slice(0, 8)}`;
}

async function writeDisabledConnectorOverrides(
  overrides: readonly DisabledConnectorOverride[]
): Promise<void> {
  await mkdir(/*turbopackIgnore: true*/ connectorAdminRoot(), { recursive: true });
  const filePath = disabledConnectorsFile();
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(
    /*turbopackIgnore: true*/ temporaryPath,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        disabledConnectors: [...overrides].sort((left, right) => left.id.localeCompare(right.id))
      },
      null,
      2
    ),
    "utf8"
  );
  await rename(/*turbopackIgnore: true*/ temporaryPath, /*turbopackIgnore: true*/ filePath);
}

async function getDisabledConnectorOverridesFromPostgres(): Promise<
  ReadonlyMap<string, DisabledConnectorOverride>
> {
  const pool = getPostgresPool();
  const result = await pool.query<{ override: DisabledConnectorOverride }>(
    `
      select override
      from ${qualifiedDisabledConnectorsTable()}
      order by disabled_at desc, id asc
    `
  );
  const overrides = new Map<string, DisabledConnectorOverride>();
  for (const row of result.rows) {
    if (isDisabledConnectorOverride(row.override)) {
      overrides.set(row.override.id, row.override);
    }
  }
  return overrides;
}

async function disableConnectorOverrideInPostgres(
  override: DisabledConnectorOverride
): Promise<void> {
  const pool = getPostgresPool();
  await pool.query(
    `
      insert into ${qualifiedDisabledConnectorsTable()} (
        id,
        company_id,
        connector_id,
        source_id,
        namespace_id,
        disabled_at,
        disabled_by,
        reason,
        override,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9::jsonb, now())
      on conflict (id) do update set
        company_id = excluded.company_id,
        connector_id = excluded.connector_id,
        source_id = excluded.source_id,
        namespace_id = excluded.namespace_id,
        disabled_at = excluded.disabled_at,
        disabled_by = excluded.disabled_by,
        reason = excluded.reason,
        override = excluded.override,
        updated_at = now()
    `,
    [
      override.id,
      override.companyId,
      override.connectorId,
      override.sourceId,
      override.namespaceId ?? null,
      override.disabledAt,
      override.disabledBy,
      override.reason ?? null,
      JSON.stringify(override)
    ]
  );
}

async function reenableConnectorOverrideInPostgres(connectorRecordId: string): Promise<boolean> {
  const pool = getPostgresPool();
  const result = await pool.query<{ id: string }>(
    `
      delete from ${qualifiedDisabledConnectorsTable()}
      where id = $1
      returning id
    `,
    [connectorRecordId]
  );
  return result.rowCount === 1;
}

async function appendConnectorActionAuditToPostgres(
  record: ConnectorActionAuditRecord
): Promise<void> {
  const pool = getPostgresPool();
  await pool.query(
    `
      insert into ${qualifiedConnectorActionsTable()} (
        action_id,
        action,
        status,
        requested_at,
        finished_at,
        requested_by,
        connector_record_id,
        company_id,
        connector_id,
        source_id,
        namespace_id,
        mode,
        delete_missing,
        command,
        result,
        error,
        record
      )
      values (
        $1, $2, $3, $4::timestamptz, $5::timestamptz, $6,
        $7, $8, $9, $10, $11, $12, $13, $14::text[], $15::jsonb, $16, $17::jsonb
      )
      on conflict (action_id) do update set
        action = excluded.action,
        status = excluded.status,
        requested_at = excluded.requested_at,
        finished_at = excluded.finished_at,
        requested_by = excluded.requested_by,
        connector_record_id = excluded.connector_record_id,
        company_id = excluded.company_id,
        connector_id = excluded.connector_id,
        source_id = excluded.source_id,
        namespace_id = excluded.namespace_id,
        mode = excluded.mode,
        delete_missing = excluded.delete_missing,
        command = excluded.command,
        result = excluded.result,
        error = excluded.error,
        record = excluded.record
    `,
    [
      record.actionId,
      record.action,
      record.status,
      record.requestedAt,
      record.finishedAt,
      record.requestedBy,
      record.connectorRecordId ?? null,
      record.companyId ?? null,
      record.connectorId ?? null,
      record.sourceId ?? null,
      record.namespaceId ?? null,
      record.mode ?? null,
      record.deleteMissing ?? null,
      record.command ?? null,
      record.result === undefined ? null : JSON.stringify(record.result),
      record.error ?? null,
      JSON.stringify(record)
    ]
  );
}

async function getConnectorActionHistoryFromPostgres(
  query: Required<Pick<ConnectorActionHistoryQuery, "limit" | "offset">> &
    Pick<ConnectorActionHistoryQuery, "connectorRecordId">
): Promise<ConnectorActionHistoryResult> {
  const pool = getPostgresPool();
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (query.connectorRecordId) {
    params.push(query.connectorRecordId);
    conditions.push(`connector_record_id = $${params.length}`);
  }
  const whereSql = conditions.length ? `where ${conditions.join(" and ")}` : "";
  const result = await pool.query<{ record: ConnectorActionAuditRecord }>(
    `
      select record
      from ${qualifiedConnectorActionsTable()}
      ${whereSql}
      order by requested_at desc, action_id desc
      limit $${params.length + 1}
      offset $${params.length + 2}
    `,
    [...params, query.limit + 1, query.offset]
  );
  const records = result.rows
    .map((row) => row.record)
    .filter(isConnectorActionAuditRecord)
    .slice(0, query.limit);
  return {
    generatedAt: new Date().toISOString(),
    records,
    page: {
      limit: query.limit,
      offset: query.offset,
      hasMore: result.rows.length > query.limit,
      truncated: false,
      storageKind: "postgres"
    }
  };
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  if (!existsSync(/*turbopackIgnore: true*/ filePath)) return undefined;
  try {
    return JSON.parse(await readFile(/*turbopackIgnore: true*/ filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function readConnectorActionLog(): Promise<{
  readonly records: readonly ConnectorActionAuditRecord[];
  readonly truncated: boolean;
}> {
  const filePath = connectorActionLogFile();
  if (!existsSync(/*turbopackIgnore: true*/ filePath)) return { records: [], truncated: false };
  let raw: string;
  try {
    raw = await readFile(/*turbopackIgnore: true*/ filePath, "utf8");
  } catch {
    return { records: [], truncated: false };
  }

  const maxBytes = boundedInteger(
    Number(process.env.RAG_ADMIN_CONNECTOR_ACTION_LOG_READ_BYTES),
    2_000_000,
    100_000,
    20_000_000
  );
  const truncated = Buffer.byteLength(raw, "utf8") > maxBytes;
  const visibleRaw = truncated ? raw.slice(-maxBytes) : raw;
  const lines = visibleRaw.split("\n");
  if (truncated) lines.shift();

  const records: ConnectorActionAuditRecord[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseActionAuditRecord(line);
    if (parsed) records.push(parsed);
  }
  return { records, truncated };
}

function parseActionAuditRecord(line: string): ConnectorActionAuditRecord | undefined {
  try {
    const value = JSON.parse(line) as ConnectorActionAuditRecord;
    return isConnectorActionAuditRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isDisabledConnectorOverride(value: unknown): value is DisabledConnectorOverride {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DisabledConnectorOverride).id === "string" &&
    typeof (value as DisabledConnectorOverride).companyId === "string" &&
    typeof (value as DisabledConnectorOverride).connectorId === "string" &&
    typeof (value as DisabledConnectorOverride).sourceId === "string" &&
    typeof (value as DisabledConnectorOverride).disabledAt === "string" &&
    typeof (value as DisabledConnectorOverride).disabledBy === "string"
  );
}

function isConnectorActionAuditRecord(value: unknown): value is ConnectorActionAuditRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ConnectorActionAuditRecord).actionId === "string" &&
    typeof (value as ConnectorActionAuditRecord).action === "string" &&
    typeof (value as ConnectorActionAuditRecord).status === "string" &&
    typeof (value as ConnectorActionAuditRecord).requestedAt === "string" &&
    typeof (value as ConnectorActionAuditRecord).finishedAt === "string" &&
    typeof (value as ConnectorActionAuditRecord).requestedBy === "string"
  );
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const candidate = value ?? Number.NaN;
  if (!Number.isFinite(candidate)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(candidate)));
}

function connectorAdminStateStorageKind(): ConnectorAdminStateStorageKind {
  const configured = process.env.RAG_ADMIN_CONNECTOR_STATE_KIND?.trim();
  if (configured === "postgres" || configured === "json_file") return configured;
  if (configured && configured !== "auto") {
    throw new Error("RAG_ADMIN_CONNECTOR_STATE_KIND must be one of postgres, json_file, or auto.");
  }
  return postgresConnectionString() === undefined ? "json_file" : "postgres";
}

function getPostgresPool(): Pool {
  const connectionString = postgresConnectionString();
  if (!connectionString) {
    throw new Error(
      "Postgres connector admin state requires RAG_ADMIN_CONNECTOR_POSTGRES_URL, RAG_ADMIN_CONNECTOR_POSTGRES_URL_ENV, RAG_POSTGRES_URL, or RAG_POSTGRES_URL_ENV."
    );
  }
  postgresPool ??= new pg.Pool({ connectionString });
  return postgresPool;
}

function postgresConnectionString(): string | undefined {
  const direct = process.env.RAG_ADMIN_CONNECTOR_POSTGRES_URL?.trim();
  if (direct) return direct;

  const adminPointer = process.env.RAG_ADMIN_CONNECTOR_POSTGRES_URL_ENV?.trim();
  if (adminPointer) {
    const referenced = process.env[adminPointer]?.trim();
    if (referenced) return referenced;
  }

  const productionPointer = process.env.RAG_POSTGRES_URL_ENV?.trim();
  if (productionPointer) {
    const referenced = process.env[productionPointer]?.trim();
    if (referenced) return referenced;
  }

  const productionDirect = process.env.RAG_POSTGRES_URL?.trim();
  return productionDirect ? productionDirect : undefined;
}

function qualifiedConnectorActionsTable(): string {
  return `${quoteIdentifier(postgresSchema())}.${quoteIdentifier(ADMIN_CONNECTOR_ACTIONS_TABLE)}`;
}

function qualifiedDisabledConnectorsTable(): string {
  return `${quoteIdentifier(postgresSchema())}.${quoteIdentifier(ADMIN_CONNECTOR_DISABLED_TABLE)}`;
}

function postgresSchema(): string {
  return assertSafeIdentifier(
    process.env.RAG_ADMIN_CONNECTOR_POSTGRES_SCHEMA?.trim() ||
      process.env.RAG_POSTGRES_SCHEMA?.trim() ||
      DEFAULT_SCHEMA,
    "Postgres connector admin schema"
  );
}

function quoteIdentifier(value: string): string {
  return `"${assertSafeIdentifier(value, "identifier").replace(/"/g, '""')}"`;
}

function assertSafeIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${label} must be a safe SQL identifier.`);
  }
  return value;
}

function connectorAdminRoot(): string {
  const configured = process.env.RAG_ADMIN_CONNECTOR_STATE_DIR?.trim();
  if (configured) {
    return path.resolve(/*turbopackIgnore: true*/ configured);
  }
  return path.join(/*turbopackIgnore: true*/ resolveRagRepoRoot(), ".rag", "admin-connectors");
}

function disabledConnectorsFile(): string {
  return path.join(/*turbopackIgnore: true*/ connectorAdminRoot(), "disabled-connectors.json");
}

function connectorActionLogFile(): string {
  return path.join(/*turbopackIgnore: true*/ connectorAdminRoot(), "actions.jsonl");
}
