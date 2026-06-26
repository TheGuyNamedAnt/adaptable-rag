import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FIXED_NOW } from "../test-support/fixtures.js";
import {
  chunkGraphExtractionBatch,
  importGraphBatches,
  JsonFileGraphBatchImportCheckpointStore,
  renderGraphBatchImportMarkdown
} from "./graph-batch-import.js";
import { buildGraphStoreBenchmarkBatch } from "./graph-store-benchmark.js";
import type { GraphExtractionBatch } from "./graph-types.js";
import { validateGraphExtractionBatch } from "./graph-validation.js";
import { InMemoryGraphStore, type GraphStoreWriteResult } from "./in-memory-graph-store.js";

test("graph batch chunker emits valid entity and relation chunks", () => {
  const batch = makeBenchmarkBatch();
  const chunks = [
    ...chunkGraphExtractionBatch(batch, {
      maxEntitiesPerBatch: 3,
      maxRelationsPerBatch: 2
    })
  ];

  assert.equal(chunks.length > 1, true);
  assert.equal(
    chunks.every((chunk) => validateGraphExtractionBatch(chunk).valid),
    true
  );
  assert.equal(
    chunks
      .filter((chunk) => chunk.relations.length > 0)
      .every((chunk) => chunk.entities.some((entity) => entity.id === "entity_parent")),
    true
  );
});

test("graph batch importer writes chunks and resumes from a durable checkpoint", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "graph-batch-import-"));
  try {
    const checkpointStore = new JsonFileGraphBatchImportCheckpointStore({
      filePath: path.join(directory, "checkpoint.json")
    });
    const store = new InMemoryGraphStore();
    const chunks = [
      ...chunkGraphExtractionBatch(makeBenchmarkBatch(), {
        maxEntitiesPerBatch: 4,
        maxRelationsPerBatch: 3
      })
    ];

    const first = await importGraphBatches({
      store,
      batches: chunks.slice(0, 2),
      importId: "import_resume",
      requestedAt: FIXED_NOW,
      checkpointStore,
      now: () => FIXED_NOW
    });
    const second = await importGraphBatches({
      store,
      batches: chunks,
      importId: "import_resume",
      requestedAt: FIXED_NOW,
      checkpointStore,
      now: () => FIXED_NOW
    });

    assert.equal(first.status, "succeeded");
    assert.equal(second.status, "succeeded");
    assert.equal(second.metrics.skippedBatchCount, 2);
    assert.equal(checkpointStore.read()?.metrics.completedBatchCount, chunks.length);
    assert.equal(store.snapshot().entities.length, 6);
    assert.equal(store.snapshot().relations.length, 10);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("graph batch importer retries transient graph store failures", async () => {
  const store = new FlakyGraphStore("Bearer abc123 api_key=secret");
  const chunk = [
    ...chunkGraphExtractionBatch(makeBenchmarkBatch(), {
      maxEntitiesPerBatch: 6,
      maxRelationsPerBatch: 10,
      includeEntityOnlyBatches: false
    })
  ][0];
  if (!chunk) {
    throw new Error("Fixture requires a chunk.");
  }

  const result = await importGraphBatches({
    store,
    batches: [chunk],
    importId: "import_retry",
    requestedAt: FIXED_NOW,
    maxAttempts: 2,
    now: () => FIXED_NOW
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.writes[0]?.attemptCount, 2);
  assert.equal(result.failures.length, 0);
});

test("graph batch importer records failures and threshold violations", async () => {
  const batch = makeBenchmarkBatch();
  const invalid = {
    ...batch,
    id: "invalid_relation_chunk",
    entities: [],
    relations: [batch.relations[0]!]
  };

  const result = await importGraphBatches({
    store: new InMemoryGraphStore(),
    batches: [invalid],
    importId: "import_threshold",
    requestedAt: FIXED_NOW,
    continueOnError: true,
    thresholds: {
      maxFailedBatches: 0
    },
    now: () => FIXED_NOW
  });
  const markdown = renderGraphBatchImportMarkdown(result);

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "threshold_exceeded");
  assert.equal(result.failures.length, 1);
  assert.equal(result.thresholdViolations[0]?.signalName, "failures.unresolvedBatchCount");
  assert.match(markdown, /Graph Batch Import/u);
  assert.match(markdown, /Threshold Violations/u);
});

function makeBenchmarkBatch(): GraphExtractionBatch {
  return buildGraphStoreBenchmarkBatch({
    entityCount: 6,
    relationCount: 10,
    namespaceId: "test-namespace",
    tenantId: "tenant_1",
    createdAt: FIXED_NOW
  });
}

class FlakyGraphStore extends InMemoryGraphStore {
  private failed = false;

  constructor(private readonly message: string) {
    super();
  }

  override addExtractionBatch(batch: GraphExtractionBatch): GraphStoreWriteResult {
    if (!this.failed) {
      this.failed = true;
      throw new Error(this.message);
    }

    return super.addExtractionBatch(batch);
  }
}
