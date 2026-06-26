import { performance } from "node:perf_hooks";

import type { AccessScope, RequestPrincipal } from "../security/access-scope.js";
import type { IndexFilter } from "../indexing/index-types.js";
import type { GraphExtractionBatch, GraphRelationKind } from "./graph-types.js";
import type { GraphStore } from "./in-memory-graph-store.js";
import { ownershipGraphOntology } from "./ownership-ontology.js";

export interface GraphStoreBenchmarkOptions {
  readonly store: GraphStore;
  readonly storeKind: string;
  readonly entityCount?: number;
  readonly relationCount?: number;
  readonly pageSize?: number;
  readonly sampleCount?: number;
  readonly namespaceId?: string;
  readonly tenantId?: string;
  readonly generatedAt?: string;
  readonly thresholds?: GraphStoreBenchmarkThresholds;
}

export interface GraphStoreBenchmarkThresholds {
  readonly maxWriteMs?: number;
  readonly maxEntityLookupP95Ms?: number;
  readonly maxRelationLookupP95Ms?: number;
  readonly maxEntityPageP95Ms?: number;
  readonly maxRelationPageP95Ms?: number;
  readonly maxEntityPageTotalMs?: number;
  readonly maxRelationPageTotalMs?: number;
}

export interface GraphStoreBenchmarkReport {
  readonly schemaVersion: 1;
  readonly status: "passed" | "failed";
  readonly generatedAt: string;
  readonly storeKind: string;
  readonly parameters: {
    readonly entityCount: number;
    readonly relationCount: number;
    readonly pageSize: number;
    readonly sampleCount: number;
    readonly namespaceId: string;
    readonly tenantId: string;
  };
  readonly write: {
    readonly durationMs: number;
    readonly entityCount: number;
    readonly relationCount: number;
  };
  readonly reads: {
    readonly entityLookup: GraphStoreBenchmarkMetric;
    readonly relationLookup: GraphStoreBenchmarkMetric;
    readonly entityPage: GraphStoreBenchmarkPageMetric;
    readonly relationPage: GraphStoreBenchmarkPageMetric;
  };
  readonly thresholds: GraphStoreBenchmarkThresholds;
  readonly violations: readonly GraphStoreBenchmarkViolation[];
}

export interface GraphStoreBenchmarkMetric {
  readonly sampleCount: number;
  readonly totalMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly meanMs: number;
  readonly p95Ms: number;
  readonly minResultCount: number;
  readonly maxResultCount: number;
}

export interface GraphStoreBenchmarkPageMetric extends GraphStoreBenchmarkMetric {
  readonly pageCount: number;
  readonly totalResultCount: number;
}

export interface GraphStoreBenchmarkViolation {
  readonly signalName: string;
  readonly observedValue: number;
  readonly threshold: number;
  readonly message: string;
}

const DEFAULT_ENTITY_COUNT = 2_000;
const DEFAULT_RELATION_COUNT = 4_000;
const DEFAULT_PAGE_SIZE = 250;
const DEFAULT_SAMPLE_COUNT = 25;
const DEFAULT_NAMESPACE_ID = "graph-benchmark";
const DEFAULT_TENANT_ID = "tenant_benchmark";
const BENCHMARK_SOURCE_ID = "graph_benchmark";

export function runGraphStoreBenchmark(
  options: GraphStoreBenchmarkOptions
): GraphStoreBenchmarkReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const entityCount = options.entityCount ?? DEFAULT_ENTITY_COUNT;
  const relationCount = options.relationCount ?? DEFAULT_RELATION_COUNT;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const sampleCount = options.sampleCount ?? DEFAULT_SAMPLE_COUNT;
  const namespaceId = options.namespaceId ?? DEFAULT_NAMESPACE_ID;
  const tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
  const thresholds = options.thresholds ?? {};
  assertBenchmarkParameters({
    entityCount,
    relationCount,
    pageSize,
    sampleCount,
    namespaceId,
    tenantId
  });
  assertBenchmarkTimestamp(generatedAt);

  const batch = buildGraphStoreBenchmarkBatch({
    entityCount,
    relationCount,
    namespaceId,
    tenantId,
    createdAt: generatedAt
  });
  const filter = benchmarkFilter({ namespaceId, tenantId });
  const writeMeasurement = measure(() => options.store.addExtractionBatch(batch));
  const idWidth = String(Math.max(entityCount, relationCount)).length;
  const entityLookup = benchmarkEntityLookup({
    store: options.store,
    filter,
    entityCount,
    sampleCount,
    idWidth
  });
  const relationLookup = benchmarkRelationLookup({
    store: options.store,
    filter,
    relationCount,
    sampleCount
  });
  const entityPage = benchmarkEntityPages({
    store: options.store,
    filter,
    pageSize
  });
  const relationPage = benchmarkRelationPages({
    store: options.store,
    filter,
    pageSize
  });
  const violations = benchmarkViolations({
    thresholds,
    writeMs: writeMeasurement.durationMs,
    entityLookup,
    relationLookup,
    entityPage,
    relationPage
  });

  return {
    schemaVersion: 1,
    status: violations.length === 0 ? "passed" : "failed",
    generatedAt,
    storeKind: options.storeKind,
    parameters: {
      entityCount,
      relationCount,
      pageSize,
      sampleCount,
      namespaceId,
      tenantId
    },
    write: {
      durationMs: roundMs(writeMeasurement.durationMs),
      entityCount: writeMeasurement.result.entityCount,
      relationCount: writeMeasurement.result.relationCount
    },
    reads: {
      entityLookup,
      relationLookup,
      entityPage,
      relationPage
    },
    thresholds,
    violations
  };
}

export function buildGraphStoreBenchmarkBatch(input: {
  readonly entityCount: number;
  readonly relationCount: number;
  readonly namespaceId: string;
  readonly tenantId: string;
  readonly createdAt: string;
}): GraphExtractionBatch {
  assertBenchmarkParameters({
    entityCount: input.entityCount,
    relationCount: input.relationCount,
    pageSize: 1,
    sampleCount: 1,
    namespaceId: input.namespaceId,
    tenantId: input.tenantId
  });
  assertBenchmarkTimestamp(input.createdAt);

  const accessScope: AccessScope = {
    tenantId: input.tenantId,
    namespaceId: input.namespaceId,
    tags: ["benchmark"]
  };
  const parent = {
    id: "entity_parent",
    namespaceId: input.namespaceId,
    kind: "legal_entity" as const,
    name: "Benchmark Parent LLC",
    normalizedName: "benchmark parent",
    aliases: ["benchmark-parent"],
    confidence: 1,
    trustTier: "trusted_internal" as const,
    accessScope,
    evidence: [benchmarkEvidence("entity_parent")],
    status: "approved" as const,
    createdAt: timestampForIndex(input.createdAt, 0)
  };
  const childCount = input.entityCount - 1;
  const idWidth = String(Math.max(input.entityCount, input.relationCount)).length;
  const children = Array.from({ length: childCount }, (_, index) => {
    const serial = paddedIndex(index, idWidth);
    return {
      id: `entity_child_${serial}`,
      namespaceId: input.namespaceId,
      kind: "legal_entity" as const,
      name: `Benchmark Child ${serial} LLC`,
      normalizedName: `benchmark child ${serial}`,
      aliases: [`benchmark-child-${serial}`],
      confidence: 0.96,
      trustTier: "trusted_internal" as const,
      accessScope,
      evidence: [benchmarkEvidence(`entity_child_${serial}`)],
      status: "approved" as const,
      createdAt: timestampForIndex(input.createdAt, index + 1)
    };
  });
  const relations = Array.from({ length: input.relationCount }, (_, index) => {
    const serial = paddedIndex(index, idWidth);
    const target = children[index % childCount];
    if (target === undefined) {
      throw new Error("Graph benchmark relation target generation failed.");
    }

    return {
      id: `rel_parent_owns_child_${serial}`,
      namespaceId: input.namespaceId,
      relationKind: "owns" as GraphRelationKind,
      sourceEntityId: parent.id,
      targetEntityId: target.id,
      factStrength: "explicit_fact" as const,
      confidence: 0.95,
      trustTier: "trusted_internal" as const,
      accessScope,
      evidence: [benchmarkEvidence(`rel_parent_owns_child_${serial}`)],
      temporal: { observedAt: input.createdAt },
      verificationStatus: "supported" as const,
      status: "approved" as const,
      createdAt: timestampForIndex(input.createdAt, index + 1)
    };
  });

  return {
    id: `graph_benchmark_${input.createdAt.replace(/[^0-9a-z]/gi, "")}`,
    namespaceId: input.namespaceId,
    ontology: ownershipGraphOntology,
    entities: [parent, ...children],
    relations,
    createdAt: input.createdAt
  };
}

export function renderGraphStoreBenchmarkMarkdown(report: GraphStoreBenchmarkReport): string {
  const lines = [
    `# Graph Store Benchmark`,
    ``,
    `Status: **${report.status}**`,
    ``,
    `- Store: \`${report.storeKind}\``,
    `- Generated: \`${report.generatedAt}\``,
    `- Entities: ${report.parameters.entityCount}`,
    `- Relations: ${report.parameters.relationCount}`,
    `- Page size: ${report.parameters.pageSize}`,
    `- Samples: ${report.parameters.sampleCount}`,
    ``,
    `| Signal | Value |`,
    `| --- | ---: |`,
    `| Write total | ${formatMs(report.write.durationMs)} |`,
    `| Entity lookup p95 | ${formatMs(report.reads.entityLookup.p95Ms)} |`,
    `| Relation lookup p95 | ${formatMs(report.reads.relationLookup.p95Ms)} |`,
    `| Entity page p95 | ${formatMs(report.reads.entityPage.p95Ms)} |`,
    `| Entity page total | ${formatMs(report.reads.entityPage.totalMs)} |`,
    `| Relation page p95 | ${formatMs(report.reads.relationPage.p95Ms)} |`,
    `| Relation page total | ${formatMs(report.reads.relationPage.totalMs)} |`
  ];

  if (report.violations.length > 0) {
    lines.push(``, `## Violations`, ``);
    for (const violation of report.violations) {
      lines.push(`- ${violation.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function benchmarkEntityLookup(input: {
  readonly store: GraphStore;
  readonly filter: IndexFilter;
  readonly entityCount: number;
  readonly sampleCount: number;
  readonly idWidth: number;
}): GraphStoreBenchmarkMetric {
  const samples = sampleIndexes(input.entityCount - 1, input.sampleCount);
  const durations: number[] = [];
  const resultCounts: number[] = [];

  for (const sample of samples) {
    const serial = paddedIndex(sample, input.idWidth);
    const measured = measure(() =>
      input.store.queryEntities
        ? input.store.queryEntities({
            filter: input.filter,
            entityName: `Benchmark Child ${serial} LLC`,
            limit: 5
          })
        : input.store
            .findEntities(input.filter)
            .filter((entity) => entity.name === `Benchmark Child ${serial} LLC`)
            .slice(0, 5)
    );
    durations.push(measured.durationMs);
    resultCounts.push(measured.result.length);
  }

  return metric(durations, resultCounts);
}

function benchmarkRelationLookup(input: {
  readonly store: GraphStore;
  readonly filter: IndexFilter;
  readonly relationCount: number;
  readonly sampleCount: number;
}): GraphStoreBenchmarkMetric {
  const samples = sampleIndexes(input.relationCount, input.sampleCount);
  const durations: number[] = [];
  const resultCounts: number[] = [];

  for (const _sample of samples) {
    const measured = measure(() =>
      input.store.findRelations({
        filter: input.filter,
        entityId: "entity_parent",
        relationKinds: ["owns"],
        limit: 25
      })
    );
    durations.push(measured.durationMs);
    resultCounts.push(measured.result.length);
  }

  return metric(durations, resultCounts);
}

function benchmarkEntityPages(input: {
  readonly store: GraphStore;
  readonly filter: IndexFilter;
  readonly pageSize: number;
}): GraphStoreBenchmarkPageMetric {
  if (!input.store.pageEntities) {
    throw new Error("Graph store does not support entity cursor pagination.");
  }

  const durations: number[] = [];
  const resultCounts: number[] = [];
  let totalResultCount = 0;
  let cursor: string | undefined;
  do {
    const measured = measure(() =>
      input.store.pageEntities!({
        filter: input.filter,
        limit: input.pageSize,
        ...(cursor === undefined ? {} : { cursor })
      })
    );
    cursor = measured.result.nextCursor;
    durations.push(measured.durationMs);
    resultCounts.push(measured.result.entities.length);
    totalResultCount += measured.result.entities.length;
  } while (cursor !== undefined);

  return {
    ...metric(durations, resultCounts),
    pageCount: durations.length,
    totalResultCount
  };
}

function benchmarkRelationPages(input: {
  readonly store: GraphStore;
  readonly filter: IndexFilter;
  readonly pageSize: number;
}): GraphStoreBenchmarkPageMetric {
  if (!input.store.pageRelations) {
    throw new Error("Graph store does not support relation cursor pagination.");
  }

  const durations: number[] = [];
  const resultCounts: number[] = [];
  let totalResultCount = 0;
  let cursor: string | undefined;
  do {
    const measured = measure(() =>
      input.store.pageRelations!({
        filter: input.filter,
        entityId: "entity_parent",
        relationKinds: ["owns"],
        limit: input.pageSize,
        ...(cursor === undefined ? {} : { cursor })
      })
    );
    cursor = measured.result.nextCursor;
    durations.push(measured.durationMs);
    resultCounts.push(measured.result.relations.length);
    totalResultCount += measured.result.relations.length;
  } while (cursor !== undefined);

  return {
    ...metric(durations, resultCounts),
    pageCount: durations.length,
    totalResultCount
  };
}

function benchmarkViolations(input: {
  readonly thresholds: GraphStoreBenchmarkThresholds;
  readonly writeMs: number;
  readonly entityLookup: GraphStoreBenchmarkMetric;
  readonly relationLookup: GraphStoreBenchmarkMetric;
  readonly entityPage: GraphStoreBenchmarkPageMetric;
  readonly relationPage: GraphStoreBenchmarkPageMetric;
}): readonly GraphStoreBenchmarkViolation[] {
  return [
    violation("write.durationMs", input.writeMs, input.thresholds.maxWriteMs),
    violation(
      "reads.entityLookup.p95Ms",
      input.entityLookup.p95Ms,
      input.thresholds.maxEntityLookupP95Ms
    ),
    violation(
      "reads.relationLookup.p95Ms",
      input.relationLookup.p95Ms,
      input.thresholds.maxRelationLookupP95Ms
    ),
    violation(
      "reads.entityPage.p95Ms",
      input.entityPage.p95Ms,
      input.thresholds.maxEntityPageP95Ms
    ),
    violation(
      "reads.relationPage.p95Ms",
      input.relationPage.p95Ms,
      input.thresholds.maxRelationPageP95Ms
    ),
    violation(
      "reads.entityPage.totalMs",
      input.entityPage.totalMs,
      input.thresholds.maxEntityPageTotalMs
    ),
    violation(
      "reads.relationPage.totalMs",
      input.relationPage.totalMs,
      input.thresholds.maxRelationPageTotalMs
    )
  ].filter((entry): entry is GraphStoreBenchmarkViolation => entry !== undefined);
}

function violation(
  signalName: string,
  observedValue: number,
  threshold: number | undefined
): GraphStoreBenchmarkViolation | undefined {
  if (threshold === undefined || observedValue <= threshold) {
    return undefined;
  }

  return {
    signalName,
    observedValue: roundMs(observedValue),
    threshold,
    message: `${signalName} ${formatMs(observedValue)} exceeded threshold ${formatMs(threshold)}.`
  };
}

function measure<T>(action: () => T): { readonly durationMs: number; readonly result: T } {
  const startedAt = performance.now();
  const result = action();
  return {
    durationMs: performance.now() - startedAt,
    result
  };
}

function metric(
  durations: readonly number[],
  resultCounts: readonly number[]
): GraphStoreBenchmarkMetric {
  return {
    sampleCount: durations.length,
    totalMs: roundMs(durations.reduce((total, duration) => total + duration, 0)),
    minMs: roundMs(Math.min(...durations)),
    maxMs: roundMs(Math.max(...durations)),
    meanMs: roundMs(durations.reduce((total, duration) => total + duration, 0) / durations.length),
    p95Ms: roundMs(percentile(durations, 0.95)),
    minResultCount: Math.min(...resultCounts),
    maxResultCount: Math.max(...resultCounts)
  };
}

function percentile(values: readonly number[], percentileValue: number): number {
  const sorted = [...values].sort((first, second) => first - second);
  const index = Math.max(0, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] ?? 0;
}

function sampleIndexes(size: number, sampleCount: number): readonly number[] {
  if (size < 1) {
    return [];
  }

  const count = Math.min(size, sampleCount);
  if (count === 1) {
    return [0];
  }

  return Array.from({ length: count }, (_, index) =>
    Math.min(size - 1, Math.floor((index * (size - 1)) / (count - 1)))
  );
}

function benchmarkFilter(input: {
  readonly namespaceId: string;
  readonly tenantId: string;
}): IndexFilter {
  const principal: RequestPrincipal = {
    userId: "graph_benchmark_user",
    tenantId: input.tenantId,
    namespaceIds: [input.namespaceId],
    teamIds: [],
    roles: [],
    tags: ["benchmark"]
  };

  return {
    namespaceId: input.namespaceId,
    tenantId: input.tenantId,
    principal
  };
}

function benchmarkEvidence(
  id: string
): GraphExtractionBatch["entities"][number]["evidence"][number] {
  return {
    chunkId: `chunk_${id}`,
    documentId: "doc_graph_benchmark",
    sourceId: BENCHMARK_SOURCE_ID,
    citation: {
      sourceId: BENCHMARK_SOURCE_ID,
      chunkId: `chunk_${id}`,
      title: "Graph benchmark fixture",
      locator: id
    },
    quoteHash: `hash_${id}`
  };
}

function assertBenchmarkParameters(input: {
  readonly entityCount: number;
  readonly relationCount: number;
  readonly pageSize: number;
  readonly sampleCount: number;
  readonly namespaceId: string;
  readonly tenantId: string;
}): void {
  if (!Number.isInteger(input.entityCount) || input.entityCount < 2) {
    throw new Error("Graph benchmark entityCount must be an integer >= 2.");
  }
  if (!Number.isInteger(input.relationCount) || input.relationCount < 1) {
    throw new Error("Graph benchmark relationCount must be an integer >= 1.");
  }
  if (!Number.isInteger(input.pageSize) || input.pageSize < 1) {
    throw new Error("Graph benchmark pageSize must be an integer >= 1.");
  }
  if (!Number.isInteger(input.sampleCount) || input.sampleCount < 1) {
    throw new Error("Graph benchmark sampleCount must be an integer >= 1.");
  }
  if (!input.namespaceId.trim()) {
    throw new Error("Graph benchmark namespaceId is required.");
  }
  if (!input.tenantId.trim()) {
    throw new Error("Graph benchmark tenantId is required.");
  }
}

function assertBenchmarkTimestamp(value: string): void {
  if (!value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new Error("Graph benchmark generatedAt/createdAt must be a valid timestamp.");
  }
}

function timestampForIndex(baseTimestamp: string, index: number): string {
  return new Date(Date.parse(baseTimestamp) + index).toISOString();
}

function paddedIndex(index: number, width: number): string {
  return String(index).padStart(width, "0");
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatMs(value: number): string {
  return `${roundMs(value).toFixed(3)}ms`;
}
