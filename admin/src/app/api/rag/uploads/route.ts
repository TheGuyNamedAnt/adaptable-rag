import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  adminPreflightErrorBody,
  invalidUploadScopePreflight,
  uploadFilesPreflight,
  uploadScopePreflight
} from "@/lib/admin-api-preflight";
import { getUploadShellOverview, ingestUploadedLocalFiles } from "@/lib/upload-ingest-api";
import type {
  AdminUploadResponse,
  AdminUploadSkippedFile,
  AdminUploadStoredFile
} from "@/lib/upload-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_ROLE = "reader";
const DEFAULT_MAX_FILE_COUNT = 1_000;
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules"
]);

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      {
        error: {
          name: "InvalidMultipartBody",
          message: "Upload body must be multipart form data."
        }
      },
      { status: 400 }
    );
  }

  const uploadedFiles = formData.getAll("files").filter(isUploadFile);
  const relativePaths = formData.getAll("relativePaths").map((value) => String(value));
  const fileFailure = uploadFilesPreflight(uploadedFiles.length);
  if (fileFailure) {
    return NextResponse.json(adminPreflightErrorBody(fileFailure), { status: 400 });
  }

  const rawSourceId = formString(formData, "sourceId");
  const rawTenantId = formString(formData, "tenantId");
  const rawNamespaceId = formString(formData, "namespaceId");
  const rawUserId = formString(formData, "userId");
  const scopeFailure = uploadScopePreflight({
    sourceId: rawSourceId,
    tenantId: rawTenantId,
    namespaceId: rawNamespaceId,
    userId: rawUserId
  });
  if (scopeFailure) {
    return NextResponse.json(adminPreflightErrorBody(scopeFailure), { status: 409 });
  }

  const requestedAt = new Date().toISOString();
  const batchId = `upload_${requestedAt.replace(/[^0-9a-z]/gi, "")}_${randomUUID().slice(0, 8)}`;
  const batchDir = path.join(/*turbopackIgnore: true*/ uploadRoot(), batchId);
  const filesDir = path.join(/*turbopackIgnore: true*/ batchDir, "files");
  const sourceConfigPath = path.join(
    /*turbopackIgnore: true*/ batchDir,
    "local-files.sources.json"
  );
  const maxFileCount = positiveEnvInteger(
    "RAG_ADMIN_UPLOAD_MAX_FILE_COUNT",
    DEFAULT_MAX_FILE_COUNT
  );
  const maxFileBytes = positiveEnvInteger(
    "RAG_ADMIN_UPLOAD_MAX_FILE_BYTES",
    DEFAULT_MAX_FILE_BYTES
  );
  const maxTotalBytes = positiveEnvInteger(
    "RAG_ADMIN_UPLOAD_MAX_TOTAL_BYTES",
    DEFAULT_MAX_TOTAL_BYTES
  );
  const sourceId = cleanIdentifier(rawSourceId ?? "");
  const tenantId = cleanIdentifier(rawTenantId ?? "");
  const namespaceId = cleanIdentifier(rawNamespaceId ?? "");
  const userId = cleanIdentifier(rawUserId ?? "");
  const invalidScopeFields = [
    sourceId ? undefined : "source",
    tenantId ? undefined : "tenant",
    namespaceId ? undefined : "namespace",
    userId ? undefined : "user"
  ].filter((field): field is string => field !== undefined);
  if (invalidScopeFields.length > 0) {
    return NextResponse.json(
      adminPreflightErrorBody(invalidUploadScopePreflight(invalidScopeFields)),
      { status: 409 }
    );
  }
  const roles = listField(formString(formData, "roles")).length
    ? listField(formString(formData, "roles"))
    : [DEFAULT_ROLE];
  const tags = uniqueSorted(["admin-upload", ...listField(formString(formData, "tags"))]);
  const overwriteMode = formString(formData, "overwriteMode") === "reject" ? "reject" : "replace";

  const storedFiles: AdminUploadStoredFile[] = [];
  const skippedFiles: AdminUploadSkippedFile[] = [];
  const usedPaths = new Set<string>();
  let totalBytes = 0;

  await mkdir(filesDir, { recursive: true });

  for (const [index, file] of uploadedFiles.entries()) {
    const rawRelativePath = relativePaths[index] || file.name || `file_${index + 1}`;
    const safeRelativePath = safeUploadRelativePath(rawRelativePath, file.name);
    const relativePath = uniqueRelativePath(safeRelativePath, usedPaths);

    if (index >= maxFileCount) {
      skippedFiles.push({ relativePath, reason: `Skipped after max file count ${maxFileCount}.` });
      continue;
    }
    if (shouldSkipUploadPath(relativePath)) {
      skippedFiles.push({ relativePath, reason: "Skipped hidden or generated path." });
      continue;
    }
    if (file.size > maxFileBytes) {
      skippedFiles.push({
        relativePath,
        reason: `Skipped ${file.size} byte file over max ${maxFileBytes}.`
      });
      continue;
    }
    if (totalBytes + file.size > maxTotalBytes) {
      skippedFiles.push({
        relativePath,
        reason: `Skipped because batch would exceed max total ${maxTotalBytes}.`
      });
      continue;
    }

    const outputPath = path.resolve(/*turbopackIgnore: true*/ filesDir, relativePath);
    if (!isInsideDirectory(filesDir, outputPath)) {
      skippedFiles.push({ relativePath, reason: "Skipped unsafe relative path." });
      continue;
    }

    await mkdir(/*turbopackIgnore: true*/ path.dirname(outputPath), { recursive: true });
    await writeFile(/*turbopackIgnore: true*/ outputPath, Buffer.from(await file.arrayBuffer()));
    totalBytes += file.size;
    storedFiles.push({ relativePath, sizeBytes: file.size });
  }

  if (storedFiles.length === 0) {
    return NextResponse.json(
      {
        error: {
          name: "NoAcceptedFiles",
          message: "No files were accepted for upload.",
          skippedFiles
        }
      },
      { status: 400 }
    );
  }

  await writeFile(
    /*turbopackIgnore: true*/ sourceConfigPath,
    JSON.stringify(
      {
        sources: [
          {
            sourceId,
            rootDir: filesDir,
            recursive: true,
            sourceKind: "uploaded_file",
            trustTier: "trusted_internal",
            sensitivity: "internal",
            includeHidden: false,
            followSymlinks: false,
            maxFileBytes,
            accessScope: {
              tenantId,
              namespaceId,
              roles,
              tags
            },
            capturedAt: requestedAt,
            owner: userId,
            metadata: {
              uploadBatchId: batchId,
              uploadedBy: userId,
              uploadedAt: requestedAt,
              storedFileCount: storedFiles.length
            }
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const runId = `admin_upload_${requestedAt.replace(/[^0-9a-z]/gi, "")}`;
  const ingestion = await ingestUploadedLocalFiles({
    sourceConfigPath,
    tenantId,
    namespaceId,
    sourceId,
    userId,
    roles,
    tags,
    overwriteMode,
    runId,
    requestedAt
  });
  const response: AdminUploadResponse = {
    status: ingestion.status === "available" ? "ingested" : "uploaded_with_ingestion_error",
    batchId,
    sourceId,
    tenantId,
    namespaceId,
    rootDir: filesDir,
    sourceConfigPath,
    storedFiles,
    skippedFiles,
    totalBytes,
    ingestion: {
      status: ingestion.status,
      ...(ingestion.data === undefined ? {} : { data: ingestion.data }),
      ...(ingestion.error === undefined ? {} : { error: ingestion.error }),
      ...(ingestion.command === undefined ? {} : { command: ingestion.command })
    },
    runtime: await runtimeNote()
  };

  await writeFile(
    path.join(/*turbopackIgnore: true*/ batchDir, "upload-summary.json"),
    JSON.stringify(response, null, 2),
    "utf8"
  );

  return NextResponse.json(response);
}

function isUploadFile(value: FormDataEntryValue): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    "name" in value &&
    "size" in value
  );
}

function formString(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function listField(value: string | undefined): readonly string[] {
  if (!value) return [];
  return uniqueSorted(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

function cleanIdentifier(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, "_")
    .slice(0, 128);
  return cleaned;
}

function safeUploadRelativePath(value: string, fallbackName: string): string {
  const withoutDrive = value.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
  const segments = withoutDrive
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== ".");
  if (segments.length === 0) {
    return fallbackName || "uploaded_file";
  }
  if (segments.some((segment) => segment === ".." || segment.includes("\0"))) {
    return fallbackName || "uploaded_file";
  }
  return segments.join("/");
}

function uniqueRelativePath(relativePath: string, usedPaths: Set<string>): string {
  if (!usedPaths.has(relativePath)) {
    usedPaths.add(relativePath);
    return relativePath;
  }
  const parsed = path.posix.parse(relativePath.replace(/\\/g, "/"));
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = path.posix.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    if (!usedPaths.has(candidate)) {
      usedPaths.add(candidate);
      return candidate;
    }
  }
  throw new Error("Could not create a unique upload path.");
}

function shouldSkipUploadPath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.some((segment) => segment.startsWith(".") || EXCLUDED_DIRECTORIES.has(segment));
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function uploadRoot(): string {
  const configured = process.env.RAG_ADMIN_UPLOAD_DIR?.trim();
  if (configured) {
    return path.resolve(/*turbopackIgnore: true*/ configured);
  }
  return path.join(/*turbopackIgnore: true*/ process.cwd(), ".rag", "admin-uploads");
}

function positiveEnvInteger(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

async function runtimeNote() {
  try {
    const overview = await getUploadShellOverview();
    const indexStorageKind = overview.health?.index?.storageKind;
    const reloadRecommended = indexStorageKind === "json_file" || indexStorageKind === "memory";
    return {
      ...(indexStorageKind === undefined ? {} : { indexStorageKind }),
      reloadRecommended,
      ...(reloadRecommended
        ? {
            message:
              "The active RAG service may need a restart before JSON-file or memory-backed answers see newly uploaded chunks."
          }
        : {})
    };
  } catch {
    return { reloadRecommended: false };
  }
}
