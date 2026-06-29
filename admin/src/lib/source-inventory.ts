import "server-only";

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveRagRepoRoot } from "@/lib/repo-root";
import type { AdminUploadResponse } from "@/lib/upload-types";

export interface SourceInventoryRecord {
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly origin: "upload" | "job" | "connector";
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly trustTier?: string;
  readonly sensitivity?: string;
  readonly owner?: string;
  readonly latestBatchId?: string;
  readonly latestUploadedAt?: string;
  readonly batchCount: number;
  readonly storedFileCount: number;
  readonly skippedFileCount: number;
  readonly totalBytes: number;
  readonly roles: readonly string[];
  readonly tags: readonly string[];
}

export interface SourceInventoryBatch {
  readonly batchId: string;
  readonly sourceId: string;
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly sourceKind: string;
  readonly uploadedAt?: string;
  readonly owner?: string;
  readonly status?: string;
  readonly ingestionStatus?: string;
  readonly runId?: string;
  readonly storedFileCount: number;
  readonly skippedFileCount: number;
  readonly totalBytes: number;
  readonly documentsAccepted?: number;
  readonly chunksAccepted?: number;
  readonly roles: readonly string[];
  readonly tags: readonly string[];
}

export interface SourceInventoryResult {
  readonly generatedAt: string;
  readonly sources: readonly SourceInventoryRecord[];
  readonly batches: readonly SourceInventoryBatch[];
}

interface LocalFilesSourceConfig {
  readonly sources?: readonly unknown[];
}

interface LocalFilesSourceEntry {
  readonly sourceId?: string;
  readonly sourceKind?: string;
  readonly trustTier?: string;
  readonly sensitivity?: string;
  readonly capturedAt?: string;
  readonly owner?: string;
  readonly accessScope?: {
    readonly tenantId?: string;
    readonly namespaceId?: string;
    readonly roles?: readonly string[];
    readonly tags?: readonly string[];
  };
  readonly metadata?: {
    readonly uploadBatchId?: string;
    readonly uploadedAt?: string;
    readonly storedFileCount?: number;
  };
}

export async function getSourceInventory(): Promise<SourceInventoryResult> {
  const uploadBatches = await readUploadBatches();
  const sources = sourceRecordsFromBatches(uploadBatches);
  return {
    generatedAt: new Date().toISOString(),
    sources,
    batches: uploadBatches
  };
}

async function readUploadBatches(): Promise<readonly SourceInventoryBatch[]> {
  const root = uploadRoot();
  if (!existsSync(/*turbopackIgnore: true*/ root)) return [];

  const entries = await readdir(/*turbopackIgnore: true*/ root, { withFileTypes: true });
  const batches = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        readUploadBatch(path.join(/*turbopackIgnore: true*/ root, entry.name), entry.name)
      )
  );
  return batches
    .filter((batch): batch is SourceInventoryBatch => batch !== undefined)
    .sort((left, right) => compareIsoDesc(left.uploadedAt, right.uploadedAt));
}

async function readUploadBatch(
  batchDir: string,
  fallbackBatchId: string
): Promise<SourceInventoryBatch | undefined> {
  const [summary, config] = await Promise.all([
    readJsonFile<AdminUploadResponse>(
      path.join(/*turbopackIgnore: true*/ batchDir, "upload-summary.json")
    ),
    readJsonFile<LocalFilesSourceConfig>(
      path.join(/*turbopackIgnore: true*/ batchDir, "local-files.sources.json")
    )
  ]);
  const source = firstLocalSource(config);
  const sourceId = summary?.sourceId ?? source?.sourceId;
  if (!sourceId) return undefined;

  const batchId = summary?.batchId ?? source?.metadata?.uploadBatchId ?? fallbackBatchId;
  const uploadedAt =
    source?.metadata?.uploadedAt ??
    source?.capturedAt ??
    summary?.ingestion.data?.startedAt ??
    summary?.ingestion.data?.finishedAt;
  const counts = summary?.ingestion.data?.counts;

  return {
    batchId,
    sourceId,
    tenantId: summary?.tenantId ?? source?.accessScope?.tenantId,
    namespaceId: summary?.namespaceId ?? source?.accessScope?.namespaceId,
    sourceKind: source?.sourceKind ?? "uploaded_file",
    uploadedAt,
    owner: source?.owner,
    status: summary?.status ?? "uploaded",
    ingestionStatus: summary?.ingestion.status,
    runId: summary?.ingestion.data?.runId,
    storedFileCount: summary?.storedFiles.length ?? source?.metadata?.storedFileCount ?? 0,
    skippedFileCount: summary?.skippedFiles.length ?? 0,
    totalBytes: summary?.totalBytes ?? 0,
    documentsAccepted: counts?.documentsAccepted,
    chunksAccepted: counts?.chunksAccepted,
    roles: source?.accessScope?.roles ?? [],
    tags: source?.accessScope?.tags ?? []
  };
}

function firstLocalSource(
  config: LocalFilesSourceConfig | undefined
): LocalFilesSourceEntry | undefined {
  const first = config?.sources?.[0];
  if (!isRecord(first)) return undefined;
  return first as LocalFilesSourceEntry;
}

function sourceRecordsFromBatches(
  batches: readonly SourceInventoryBatch[]
): readonly SourceInventoryRecord[] {
  const grouped = new Map<string, SourceInventoryBatch[]>();
  for (const batch of batches) {
    grouped.set(batch.sourceId, [...(grouped.get(batch.sourceId) ?? []), batch]);
  }

  return [...grouped.entries()]
    .map(([sourceId, sourceBatches]) => {
      const sorted = [...sourceBatches].sort((left, right) =>
        compareIsoDesc(left.uploadedAt, right.uploadedAt)
      );
      const latest = sorted[0];
      return {
        sourceId,
        sourceKind: latest?.sourceKind ?? "uploaded_file",
        origin: "upload" as const,
        tenantId: latest?.tenantId,
        namespaceId: latest?.namespaceId,
        latestBatchId: latest?.batchId,
        latestUploadedAt: latest?.uploadedAt,
        owner: latest?.owner,
        batchCount: sorted.length,
        storedFileCount: sorted.reduce((total, batch) => total + batch.storedFileCount, 0),
        skippedFileCount: sorted.reduce((total, batch) => total + batch.skippedFileCount, 0),
        totalBytes: sorted.reduce((total, batch) => total + batch.totalBytes, 0),
        roles: latest?.roles ?? [],
        tags: latest?.tags ?? []
      };
    })
    .sort((left, right) => compareIsoDesc(left.latestUploadedAt, right.latestUploadedAt));
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(/*turbopackIgnore: true*/ filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function uploadRoot(): string {
  const configured = process.env.RAG_ADMIN_UPLOAD_DIR?.trim();
  if (configured) {
    return path.resolve(/*turbopackIgnore: true*/ configured);
  }
  return path.join(/*turbopackIgnore: true*/ resolveRagRepoRoot(), ".rag", "admin-uploads");
}

function compareIsoDesc(left: string | undefined, right: string | undefined): number {
  return timeValue(right) - timeValue(left);
}

function timeValue(value: string | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
