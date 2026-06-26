import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryGraphStore } from "./in-memory-graph-store.js";
import {
  buildGraphStoreBenchmarkBatch,
  renderGraphStoreBenchmarkMarkdown,
  runGraphStoreBenchmark
} from "./graph-store-benchmark.js";

const FIXED_NOW = "2026-06-25T00:00:00.000Z";

test("graph store benchmark measures write, lookup, and cursor page metrics", () => {
  const report = runGraphStoreBenchmark({
    store: new InMemoryGraphStore(),
    storeKind: "memory",
    entityCount: 40,
    relationCount: 80,
    pageSize: 11,
    sampleCount: 5,
    generatedAt: FIXED_NOW,
    thresholds: {
      maxWriteMs: 10_000,
      maxEntityLookupP95Ms: 10_000,
      maxRelationLookupP95Ms: 10_000,
      maxEntityPageP95Ms: 10_000,
      maxRelationPageP95Ms: 10_000
    }
  });

  assert.equal(report.status, "passed");
  assert.equal(report.write.entityCount, 40);
  assert.equal(report.write.relationCount, 80);
  assert.equal(report.reads.entityLookup.sampleCount, 5);
  assert.equal(report.reads.relationLookup.sampleCount, 5);
  assert.equal(report.reads.entityPage.totalResultCount, 40);
  assert.equal(report.reads.relationPage.totalResultCount, 80);
  assert.equal(report.violations.length, 0);
});

test("graph store benchmark reports threshold violations without hiding metrics", () => {
  const report = runGraphStoreBenchmark({
    store: new InMemoryGraphStore(),
    storeKind: "memory",
    entityCount: 10,
    relationCount: 10,
    pageSize: 5,
    sampleCount: 2,
    generatedAt: FIXED_NOW,
    thresholds: {
      maxWriteMs: -1
    }
  });

  assert.equal(report.status, "failed");
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0]?.signalName, "write.durationMs");
  assert.equal(report.write.entityCount, 10);
  assert.equal(report.reads.relationPage.totalResultCount, 10);
});

test("graph store benchmark rejects invalid fixture timestamps", () => {
  assert.throws(
    () =>
      runGraphStoreBenchmark({
        store: new InMemoryGraphStore(),
        storeKind: "memory",
        entityCount: 10,
        relationCount: 10,
        pageSize: 5,
        sampleCount: 2,
        generatedAt: "not-a-date"
      }),
    /valid timestamp/u
  );
});

test("graph store benchmark fixture validates generated graph batches", () => {
  const batch = buildGraphStoreBenchmarkBatch({
    entityCount: 5,
    relationCount: 8,
    namespaceId: "bench",
    tenantId: "tenant_bench",
    createdAt: FIXED_NOW
  });

  assert.equal(batch.entities.length, 5);
  assert.equal(batch.relations.length, 8);
  assert.equal(batch.relations[0]?.sourceEntityId, "entity_parent");
  assert.equal(batch.relations[0]?.targetEntityId, "entity_child_0");
});

test("graph store benchmark markdown includes status and key timings", () => {
  const report = runGraphStoreBenchmark({
    store: new InMemoryGraphStore(),
    storeKind: "memory",
    entityCount: 10,
    relationCount: 10,
    pageSize: 5,
    sampleCount: 2,
    generatedAt: FIXED_NOW
  });
  const markdown = renderGraphStoreBenchmarkMarkdown(report);

  assert.match(markdown, /Graph Store Benchmark/u);
  assert.match(markdown, /Entity lookup p95/u);
  assert.match(markdown, /Relation page total/u);
});
