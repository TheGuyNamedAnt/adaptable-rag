import type { Pool, PoolConfig } from "pg";
import pg from "pg";

export const SOURCE_SYNC_LEDGER_SCHEMA_VERSION = 1;

export type SourceSyncLedgerStatus = "succeeded" | "partial" | "failed";
export type SourceSyncLedgerEntryStatus = "active" | "deleted" | "failed";
export type SourceSyncLedgerEntryAction =
  | "created"
  | "updated"
  | "unchanged"
  | "deleted"
  | "failed";

export interface SourceSyncLedgerKey {
  readonly connectorId: string;
  readonly sourceId: string;
  readonly namespaceId: string;
}

export interface SourceSyncLedgerEntry {
  readonly sourceItemId: string;
  readonly recordId?: string;
  readonly status: SourceSyncLedgerEntryStatus;
  readonly lastAction: SourceSyncLedgerEntryAction;
  readonly version?: string;
  readonly contentHash?: string;
  readonly accessScopeHash?: string;
  readonly sourceAclHash?: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly lastChangedAt?: string;
  readonly deletedAt?: string;
  readonly failureCount: number;
  readonly lastErrorCode?: string;
  readonly retryable?: boolean;
}

export interface SourceSyncLedgerMetrics {
  readonly entryCount: number;
  readonly activeCount: number;
  readonly deletedCount: number;
  readonly failedCount: number;
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly unchangedCount: number;
  readonly tombstonedMissingCount: number;
}

export interface SourceSyncLedger {
  readonly schemaVersion: typeof SOURCE_SYNC_LEDGER_SCHEMA_VERSION;
  readonly ledgerId: string;
  readonly generatedAt: string;
  readonly status: SourceSyncLedgerStatus;
  readonly connectorId: string;
  readonly sourceId: string;
  readonly namespaceId: string;
  readonly cursor?: string;
  readonly entries: readonly SourceSyncLedgerEntry[];
  readonly metrics: SourceSyncLedgerMetrics;
  readonly evidenceBoundary: readonly string[];
}

export interface SourceSyncLedgerStore {
  load(
    key: SourceSyncLedgerKey
  ): Promise<SourceSyncLedger | undefined> | SourceSyncLedger | undefined;
  save(ledger: SourceSyncLedger): Promise<void> | void;
}

export class InMemorySourceSyncLedgerStore implements SourceSyncLedgerStore {
  private readonly ledgers = new Map<string, SourceSyncLedger>();

  load(key: SourceSyncLedgerKey): SourceSyncLedger | undefined {
    return this.ledgers.get(ledgerKey(key));
  }

  save(ledger: SourceSyncLedger): void {
    this.ledgers.set(
      ledgerKey({
        connectorId: ledger.connectorId,
        sourceId: ledger.sourceId,
        namespaceId: ledger.namespaceId
      }),
      ledger
    );
  }
}

export interface PostgresSourceSyncLedgerStoreOptions {
  readonly connectionString?: string;
  readonly pool?: Pool;
  readonly poolConfig?: PoolConfig;
  readonly schema?: string;
}

const DEFAULT_SCHEMA = "rag_core";

export class PostgresSourceSyncLedgerStore implements SourceSyncLedgerStore {
  private readonly pool: Pool;
  private readonly schema: string;

  constructor(options: PostgresSourceSyncLedgerStoreOptions) {
    if (!options.pool && !options.connectionString && !options.poolConfig) {
      throw new Error(
        "PostgresSourceSyncLedgerStore requires pool, connectionString, or poolConfig."
      );
    }

    this.pool =
      options.pool ??
      new pg.Pool({
        ...(options.poolConfig ?? {}),
        ...(options.connectionString === undefined
          ? {}
          : { connectionString: options.connectionString })
      });
    this.schema = assertSafeIdentifier(options.schema ?? DEFAULT_SCHEMA, "schema");
  }

  async load(key: SourceSyncLedgerKey): Promise<SourceSyncLedger | undefined> {
    const result = await this.pool.query<PostgresSourceSyncLedgerRow>(
      `select ledger from ${this.q("source_sync_ledgers")}
       where connector_id = $1 and source_id = $2 and namespace_id = $3`,
      [key.connectorId, key.sourceId, key.namespaceId]
    );
    const ledger = result.rows[0]?.ledger;
    return ledger === undefined ? undefined : normalizeLedger(ledger);
  }

  async save(ledger: SourceSyncLedger): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into ${this.q("source_sync_ledgers")} (
          connector_id, source_id, namespace_id, ledger_id, status, cursor,
          generated_at, metrics, ledger, updated_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $7)
        on conflict (connector_id, source_id, namespace_id) do update set
          ledger_id = excluded.ledger_id,
          status = excluded.status,
          cursor = excluded.cursor,
          generated_at = excluded.generated_at,
          metrics = excluded.metrics,
          ledger = excluded.ledger,
          updated_at = excluded.updated_at`,
        [
          ledger.connectorId,
          ledger.sourceId,
          ledger.namespaceId,
          ledger.ledgerId,
          ledger.status,
          ledger.cursor ?? null,
          ledger.generatedAt,
          JSON.stringify(ledger.metrics),
          JSON.stringify(ledger)
        ]
      );
      await client.query(
        `delete from ${this.q("source_sync_ledger_entries")}
         where connector_id = $1 and source_id = $2 and namespace_id = $3`,
        [ledger.connectorId, ledger.sourceId, ledger.namespaceId]
      );
      for (const entry of ledger.entries) {
        await client.query(
          `insert into ${this.q("source_sync_ledger_entries")} (
            connector_id, source_id, namespace_id, source_item_id, record_id,
            status, last_action, version, content_hash, access_scope_hash,
            source_acl_hash, first_seen_at, last_seen_at, last_changed_at,
            deleted_at, failure_count, last_error_code, retryable, entry
          ) values (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12, $13, $14,
            $15, $16, $17, $18, $19::jsonb
          )`,
          [
            ledger.connectorId,
            ledger.sourceId,
            ledger.namespaceId,
            entry.sourceItemId,
            entry.recordId ?? null,
            entry.status,
            entry.lastAction,
            entry.version ?? null,
            entry.contentHash ?? null,
            entry.accessScopeHash ?? null,
            entry.sourceAclHash ?? null,
            entry.firstSeenAt,
            entry.lastSeenAt,
            entry.lastChangedAt ?? null,
            entry.deletedAt ?? null,
            entry.failureCount,
            entry.lastErrorCode ?? null,
            entry.retryable ?? null,
            JSON.stringify(entry)
          ]
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private q(tableName: string): string {
    return `"${this.schema}"."${assertSafeIdentifier(tableName, "table")}"`;
  }
}

export function sourceSyncLedgerEvidenceBoundary(): readonly string[] {
  return [
    "Includes source item ids, corpus record ids, source ids, connector ids, namespace ids, safe hashes, sync status, cursor, retry flags, and operational counts.",
    "Excludes source bodies, raw source ACL payloads, raw credentials, bearer tokens, API keys, and full principal claims.",
    "Deleted entries are tombstones for downstream delete propagation; failed entries preserve retry state without deleting previously indexed knowledge."
  ];
}

export function sourceSyncLedgerMetrics(
  entries: readonly SourceSyncLedgerEntry[]
): SourceSyncLedgerMetrics {
  return {
    entryCount: entries.length,
    activeCount: entries.filter((entry) => entry.status === "active").length,
    deletedCount: entries.filter((entry) => entry.status === "deleted").length,
    failedCount: entries.filter((entry) => entry.status === "failed").length,
    createdCount: entries.filter((entry) => entry.lastAction === "created").length,
    updatedCount: entries.filter((entry) => entry.lastAction === "updated").length,
    unchangedCount: entries.filter((entry) => entry.lastAction === "unchanged").length,
    tombstonedMissingCount: entries.filter(
      (entry) => entry.lastAction === "deleted" && entry.deletedAt === entry.lastSeenAt
    ).length
  };
}

function ledgerKey(key: SourceSyncLedgerKey): string {
  return `${key.namespaceId}:${key.connectorId}:${key.sourceId}`;
}

interface PostgresSourceSyncLedgerRow {
  readonly ledger: SourceSyncLedger;
}

function normalizeLedger(value: SourceSyncLedger): SourceSyncLedger {
  return {
    ...value,
    entries: [...value.entries],
    evidenceBoundary: [...value.evidenceBoundary]
  };
}

function assertSafeIdentifier(value: string, label: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Postgres source sync ledger ${label} must be a safe SQL identifier.`);
  }
  return value;
}
