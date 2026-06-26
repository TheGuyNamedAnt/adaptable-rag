import assert from "node:assert/strict";
import test from "node:test";

import type { CorpusRecord } from "../corpus/corpus-record.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import type { CorpusSourceConfig } from "../profiles/profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { FIXED_NOW, TEST_PRINCIPAL } from "../test-support/fixtures.js";
import type {
  SourceConnector,
  SourceConnectorSyncRequest,
  SourceConnectorSyncResult
} from "./source-connector.js";
import { InMemorySourceSyncLedgerStore } from "./sync-ledger.js";
import { SourceSyncRunner } from "./sync-runner.js";

const profile = assertValidProfile({
  ...genericDocsProfile,
  namespaceId: "test-namespace"
});
const source: CorpusSourceConfig = {
  id: "curated_docs",
  adapter: "sync-test",
  description: "Synced source fixture.",
  enabled: true,
  trustTierFloor: "trusted_internal",
  tags: ["curated"]
};

class FixtureSourceConnector implements SourceConnector {
  readonly id = "fixture-source";
  readonly description = "Fixture source connector.";
  readonly requests: SourceConnectorSyncRequest[] = [];
  private readonly results: SourceConnectorSyncResult[];

  constructor(results: readonly SourceConnectorSyncResult[]) {
    this.results = [...results];
  }

  async sync(request: SourceConnectorSyncRequest): Promise<SourceConnectorSyncResult> {
    this.requests.push(request);
    const result = this.results.shift();
    if (!result) {
      throw new Error("No fixture sync result configured.");
    }

    return result;
  }
}

test("source sync returns new records and writes a safe ledger", async () => {
  const connector = new FixtureSourceConnector([
    {
      sourceId: source.id,
      nextCursor: "cursor_1",
      complete: true,
      items: [
        { operation: "upsert", sourceItemId: "source_item_a", version: "1", record: record("a") },
        { operation: "upsert", sourceItemId: "source_item_b", version: "1", record: record("b") }
      ]
    }
  ]);
  const runner = new SourceSyncRunner({ connector, now: () => FIXED_NOW });

  const result = await runner.sync({
    profile,
    source,
    requestedBy: TEST_PRINCIPAL,
    mode: "full",
    runId: "sync_first",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    result.records.map((entry) => entry.id),
    ["doc_a", "doc_b"]
  );
  assert.equal(result.deleted.length, 0);
  assert.equal(result.ledger.cursor, "cursor_1");
  assert.equal(result.ledger.metrics.activeCount, 2);
  assert.deepEqual(
    result.ledger.entries.map((entry) => entry.lastAction),
    ["created", "created"]
  );
  assert.equal(JSON.stringify(result.ledger).includes("Body for"), false);
});

test("source sync skips unchanged records through the previous ledger", async () => {
  const store = new InMemorySourceSyncLedgerStore();
  const connector = new FixtureSourceConnector([
    {
      sourceId: source.id,
      nextCursor: "cursor_1",
      complete: true,
      items: [
        { operation: "upsert", sourceItemId: "source_item_a", version: "1", record: record("a") }
      ]
    },
    {
      sourceId: source.id,
      nextCursor: "cursor_2",
      complete: true,
      items: [
        { operation: "upsert", sourceItemId: "source_item_a", version: "1", record: record("a") }
      ]
    }
  ]);
  const runner = new SourceSyncRunner({ connector, ledgerStore: store, now: () => FIXED_NOW });

  const first = await runner.sync({
    profile,
    source,
    requestedBy: TEST_PRINCIPAL,
    mode: "full",
    runId: "sync_first",
    requestedAt: FIXED_NOW
  });
  const second = await runner.sync({
    profile,
    source,
    requestedBy: TEST_PRINCIPAL,
    mode: "delta",
    runId: "sync_second",
    requestedAt: "2026-06-23T00:05:00.000Z"
  });

  assert.equal(first.records.length, 1);
  assert.equal(second.records.length, 0);
  assert.equal(second.metrics.skippedUnchangedCount, 1);
  assert.equal(second.ledger.entries[0]?.lastAction, "unchanged");
  assert.equal(connector.requests[1]?.previousCursor, "cursor_1");
});

test("source sync returns changed records and explicit deletes", async () => {
  const connector = new FixtureSourceConnector([
    {
      sourceId: source.id,
      complete: true,
      items: [
        { operation: "upsert", sourceItemId: "source_item_a", version: "1", record: record("a") },
        { operation: "upsert", sourceItemId: "source_item_b", version: "1", record: record("b") }
      ]
    },
    {
      sourceId: source.id,
      complete: false,
      items: [
        {
          operation: "upsert",
          sourceItemId: "source_item_a",
          version: "2",
          record: record("a", "Updated body for A.")
        },
        {
          operation: "delete",
          sourceItemId: "source_item_b",
          recordId: "doc_b",
          deletedAt: "2026-06-23T00:10:00.000Z"
        }
      ]
    }
  ]);
  const runner = new SourceSyncRunner({ connector, now: () => FIXED_NOW });
  const first = await runner.sync({
    profile,
    source,
    requestedBy: TEST_PRINCIPAL,
    mode: "full",
    runId: "sync_first",
    requestedAt: FIXED_NOW
  });
  const second = await runner.sync({
    profile,
    source,
    requestedBy: TEST_PRINCIPAL,
    mode: "delta",
    previousLedger: first.ledger,
    runId: "sync_second",
    requestedAt: "2026-06-23T00:10:00.000Z"
  });

  assert.deepEqual(
    second.records.map((entry) => entry.id),
    ["doc_a"]
  );
  assert.deepEqual(second.deleted, [
    {
      sourceItemId: "source_item_b",
      recordId: "doc_b",
      deletedAt: "2026-06-23T00:10:00.000Z"
    }
  ]);
  assert.deepEqual(
    second.ledger.entries.map((entry) => [entry.sourceItemId, entry.status, entry.lastAction]),
    [
      ["source_item_a", "active", "updated"],
      ["source_item_b", "deleted", "deleted"]
    ]
  );
});

test("source sync tombstones missing items on complete full syncs", async () => {
  const connector = new FixtureSourceConnector([
    {
      sourceId: source.id,
      complete: true,
      items: [
        { operation: "upsert", sourceItemId: "source_item_a", version: "1", record: record("a") },
        { operation: "upsert", sourceItemId: "source_item_b", version: "1", record: record("b") }
      ]
    },
    {
      sourceId: source.id,
      complete: true,
      items: [
        { operation: "upsert", sourceItemId: "source_item_a", version: "1", record: record("a") }
      ]
    }
  ]);
  const runner = new SourceSyncRunner({ connector, now: () => FIXED_NOW });
  const first = await runner.sync({
    profile,
    source,
    requestedBy: TEST_PRINCIPAL,
    mode: "full",
    runId: "sync_first",
    requestedAt: FIXED_NOW
  });
  const second = await runner.sync({
    profile,
    source,
    requestedBy: TEST_PRINCIPAL,
    mode: "full",
    previousLedger: first.ledger,
    runId: "sync_second",
    requestedAt: "2026-06-23T00:15:00.000Z"
  });

  assert.deepEqual(
    second.deleted.map((entry) => entry.sourceItemId),
    ["source_item_b"]
  );
  assert.equal(second.metrics.tombstonedMissingCount, 1);
  assert.equal(
    second.ledger.entries.find((entry) => entry.sourceItemId === "source_item_b")?.status,
    "deleted"
  );
});

test("source sync keeps retry state for failed items without deleting previous records", async () => {
  const connector = new FixtureSourceConnector([
    {
      sourceId: source.id,
      complete: true,
      items: [
        { operation: "upsert", sourceItemId: "source_item_a", version: "1", record: record("a") }
      ]
    },
    {
      sourceId: source.id,
      complete: false,
      items: [
        {
          operation: "error",
          sourceItemId: "source_item_a",
          errorCode: "source_timeout",
          message: "Source timed out.",
          retryable: true
        }
      ]
    }
  ]);
  const runner = new SourceSyncRunner({ connector, now: () => FIXED_NOW });
  const first = await runner.sync({
    profile,
    source,
    requestedBy: TEST_PRINCIPAL,
    mode: "full",
    runId: "sync_first",
    requestedAt: FIXED_NOW
  });
  const second = await runner.sync({
    profile,
    source,
    requestedBy: TEST_PRINCIPAL,
    mode: "delta",
    previousLedger: first.ledger,
    runId: "sync_second",
    requestedAt: "2026-06-23T00:20:00.000Z"
  });

  assert.equal(second.status, "partial");
  assert.equal(second.records.length, 0);
  assert.equal(second.deleted.length, 0);
  assert.deepEqual(second.failed, [
    {
      sourceItemId: "source_item_a",
      recordId: "doc_a",
      errorCode: "source_timeout",
      message: "Source timed out.",
      retryable: true
    }
  ]);
  assert.equal(second.ledger.entries[0]?.status, "failed");
  assert.equal(second.ledger.entries[0]?.failureCount, 1);
});

function record(suffix: string, body = `Body for ${suffix}.`): CorpusRecord {
  return {
    id: `doc_${suffix}`,
    sourceId: source.id,
    sourceKind: "local_file",
    title: `Document ${suffix}`,
    body,
    trustTier: "trusted_internal",
    sensitivity: "internal",
    accessScope: {
      tenantId: TEST_PRINCIPAL.tenantId,
      namespaceId: profile.namespaceId,
      tags: ["support"]
    },
    capturedAt: FIXED_NOW,
    checksum: `checksum_${suffix}`
  };
}
