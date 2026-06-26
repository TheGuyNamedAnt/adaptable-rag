import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import {
  PostgresSourceSyncLedgerStore,
  SOURCE_SYNC_LEDGER_SCHEMA_VERSION,
  sourceSyncLedgerEvidenceBoundary,
  sourceSyncLedgerMetrics,
  type SourceSyncLedger
} from "./sync-ledger.js";

test("postgres source sync ledger store saves ledger and normalized entries", async () => {
  const ledger = fixtureLedger();
  const pool = new FakePgPool(ledger);
  const store = new PostgresSourceSyncLedgerStore({
    pool: pool as unknown as Pool
  });

  await store.save(ledger);
  const loaded = await store.load({
    connectorId: ledger.connectorId,
    sourceId: ledger.sourceId,
    namespaceId: ledger.namespaceId
  });

  assert.deepEqual(loaded, ledger);
  assert.equal(pool.client.commands[0], "begin");
  assert.equal(pool.client.commands.at(-1), "commit");
  assert.equal(pool.entryInserts.length, 2);
  assert.deepEqual(
    pool.entryInserts.map((insert) => [insert[3], insert[4], insert[5], insert[6]]),
    [
      ["source_item_active", "doc_active", "active", "created"],
      ["source_item_deleted", "doc_deleted", "deleted", "deleted"]
    ]
  );
});

function fixtureLedger(): SourceSyncLedger {
  const entries: SourceSyncLedger["entries"] = [
    {
      sourceItemId: "source_item_active",
      recordId: "doc_active",
      status: "active",
      lastAction: "created",
      version: "1",
      contentHash: "content_hash",
      accessScopeHash: "access_hash",
      firstSeenAt: "2026-06-26T10:00:00.000Z",
      lastSeenAt: "2026-06-26T10:00:00.000Z",
      lastChangedAt: "2026-06-26T10:00:00.000Z",
      failureCount: 0
    },
    {
      sourceItemId: "source_item_deleted",
      recordId: "doc_deleted",
      status: "deleted",
      lastAction: "deleted",
      firstSeenAt: "2026-06-25T10:00:00.000Z",
      lastSeenAt: "2026-06-26T10:00:00.000Z",
      deletedAt: "2026-06-26T10:00:00.000Z",
      failureCount: 0
    }
  ];

  return {
    schemaVersion: SOURCE_SYNC_LEDGER_SCHEMA_VERSION,
    ledgerId: "sync_run_ledger",
    generatedAt: "2026-06-26T10:00:00.000Z",
    status: "succeeded",
    connectorId: "drive",
    sourceId: "curated_docs",
    namespaceId: "support",
    cursor: "cursor_1",
    entries,
    metrics: sourceSyncLedgerMetrics(entries),
    evidenceBoundary: sourceSyncLedgerEvidenceBoundary()
  };
}

class FakePgPool {
  readonly client: FakePgClient;
  readonly entryInserts: unknown[][] = [];

  constructor(private readonly ledger: SourceSyncLedger) {
    this.client = new FakePgClient(this);
  }

  async connect(): Promise<FakePgClient> {
    return this.client;
  }

  async query(_sql: string, _params?: readonly unknown[]): Promise<{ rows: readonly unknown[] }> {
    return { rows: [{ ledger: this.ledger }] };
  }
}

class FakePgClient {
  readonly commands: string[] = [];

  constructor(private readonly pool: FakePgPool) {}

  async query(sql: string, params?: readonly unknown[]): Promise<{ rows: readonly unknown[] }> {
    const normalized = sql.trim().toLowerCase();
    if (normalized === "begin" || normalized === "commit" || normalized === "rollback") {
      this.commands.push(normalized);
      return { rows: [] };
    }

    if (normalized.startsWith("insert into") && normalized.includes("source_sync_ledger_entries")) {
      this.pool.entryInserts.push([...(params ?? [])]);
    }

    return { rows: [] };
  }

  release(): void {}
}
