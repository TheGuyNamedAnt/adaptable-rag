import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveRagRepoRoot } from "@/lib/repo-root";

export interface GraphArtifacts {
  readonly generatedAt: string;
  readonly paths: GraphArtifactPaths;
  readonly artifactStates: Readonly<Record<keyof GraphArtifactPaths, GraphArtifactReadState>>;
  readonly benchmark?: GraphBenchmarkArtifact;
  readonly batchImport?: GraphBatchImportArtifact;
}

export interface GraphArtifactPaths {
  readonly benchmark: string;
  readonly batchImport: string;
}

export interface GraphArtifactReadState {
  readonly label: string;
  readonly path: string;
  readonly status: "available" | "missing" | "invalid";
  readonly error?: string;
}

export interface GraphBenchmarkArtifact {
  readonly schemaVersion?: number;
  readonly status?: string;
  readonly generatedAt?: string;
  readonly storeKind?: string;
  readonly parameters?: {
    readonly entityCount?: number;
    readonly relationCount?: number;
    readonly pageSize?: number;
    readonly sampleCount?: number;
    readonly namespaceId?: string;
    readonly tenantId?: string;
  };
  readonly write?: {
    readonly durationMs?: number;
    readonly entityCount?: number;
    readonly relationCount?: number;
  };
  readonly reads?: {
    readonly entityLookup?: GraphBenchmarkMetricArtifact;
    readonly relationLookup?: GraphBenchmarkMetricArtifact;
    readonly entityPage?: GraphBenchmarkPageMetricArtifact;
    readonly relationPage?: GraphBenchmarkPageMetricArtifact;
  };
  readonly thresholds?: Record<string, number | undefined>;
  readonly violations?: readonly GraphThresholdViolationArtifact[];
}

export interface GraphBenchmarkMetricArtifact {
  readonly sampleCount?: number;
  readonly totalMs?: number;
  readonly minMs?: number;
  readonly maxMs?: number;
  readonly meanMs?: number;
  readonly p95Ms?: number;
  readonly minResultCount?: number;
  readonly maxResultCount?: number;
}

export interface GraphBenchmarkPageMetricArtifact extends GraphBenchmarkMetricArtifact {
  readonly pageCount?: number;
  readonly totalResultCount?: number;
}

export interface GraphBatchImportArtifact {
  readonly schemaVersion?: number;
  readonly importId?: string;
  readonly status?: string;
  readonly stopReason?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly metrics?: {
    readonly sourceBatchCount?: number;
    readonly skippedBatchCount?: number;
    readonly attemptedBatchCount?: number;
    readonly completedBatchCount?: number;
    readonly failedBatchCount?: number;
    readonly storedEntityCount?: number;
    readonly storedRelationCount?: number;
    readonly totalWriteMs?: number;
    readonly maxBatchWriteMs?: number;
    readonly p95BatchWriteMs?: number;
  };
  readonly writes?: readonly GraphBatchImportWriteArtifact[];
  readonly failures?: readonly GraphBatchImportFailureArtifact[];
  readonly thresholdViolations?: readonly GraphThresholdViolationArtifact[];
  readonly checkpoint?: {
    readonly importId?: string;
    readonly status?: string;
    readonly updatedAt?: string;
    readonly completedBatchIds?: readonly string[];
    readonly failedBatches?: readonly GraphBatchImportFailureArtifact[];
  };
}

export interface GraphBatchImportWriteArtifact {
  readonly batchId?: string;
  readonly attemptCount?: number;
  readonly durationMs?: number;
  readonly entityCount?: number;
  readonly relationCount?: number;
}

export interface GraphBatchImportFailureArtifact {
  readonly batchId?: string;
  readonly attempts?: number;
  readonly message?: string;
  readonly failedAt?: string;
}

export interface GraphThresholdViolationArtifact {
  readonly signalName?: string;
  readonly observedValue?: number;
  readonly threshold?: number;
  readonly message?: string;
}

export async function getGraphArtifacts(): Promise<GraphArtifacts> {
  const paths = artifactPaths();
  const [benchmarkResult, batchImportResult] = await Promise.all([
    readJson<GraphBenchmarkArtifact>("Store benchmark", paths.benchmark),
    readJson<GraphBatchImportArtifact>("Batch import", paths.batchImport)
  ]);

  return {
    generatedAt: new Date().toISOString(),
    paths,
    artifactStates: {
      benchmark: benchmarkResult.state,
      batchImport: batchImportResult.state
    },
    ...(benchmarkResult.value === undefined ? {} : { benchmark: benchmarkResult.value }),
    ...(batchImportResult.value === undefined ? {} : { batchImport: batchImportResult.value })
  };
}

async function readJson<T>(
  label: string,
  filePath: string
): Promise<{ readonly state: GraphArtifactReadState; readonly value?: T }> {
  try {
    const value = JSON.parse(await readFile(/*turbopackIgnore: true*/ filePath, "utf8")) as T;
    return {
      state: { label, path: filePath, status: "available" },
      value
    };
  } catch (error) {
    if (isNotFound(error)) {
      return { state: { label, path: filePath, status: "missing" } };
    }
    return {
      state: {
        label,
        path: filePath,
        status: "invalid",
        error: artifactErrorMessage(error)
      }
    };
  }
}

function artifactPaths(): GraphArtifactPaths {
  const root = repoRoot();
  return {
    benchmark:
      process.env.RAG_ADMIN_GRAPH_BENCHMARK_REPORT ??
      path.join(
        /*turbopackIgnore: true*/ root,
        ".rag",
        "graph-benchmark",
        "latest",
        "benchmark.json"
      ),
    batchImport:
      process.env.RAG_ADMIN_GRAPH_IMPORT_REPORT ??
      path.join(/*turbopackIgnore: true*/ root, ".rag", "graph-import", "latest", "import.json")
  };
}

function repoRoot(): string {
  return resolveRagRepoRoot();
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code === "ENOENT"
    : false;
}

function artifactErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.slice(0, 800)
    : "Artifact could not be parsed.";
}
