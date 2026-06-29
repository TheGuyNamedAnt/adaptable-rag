"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Clipboard, FileUp, FolderUp, RefreshCw, Trash2, UploadCloud } from "lucide-react";
import { EmptyState, ErrorBanner, MetricCard, SectionCard, StatusPill } from "@/components/ui";
import { formatNumber, formatTime, statusTone, truncateMiddle } from "@/lib/format";
import type { AdminUploadResponse } from "@/lib/upload-types";

interface UploadCorpusPanelProps {
  readonly defaultTenantId?: string;
  readonly defaultNamespaceId?: string;
  readonly defaultUserId?: string;
  readonly defaultRoles?: string;
  readonly defaultTags?: string;
  readonly defaultSourceId?: string;
  readonly disabledReason?: string;
}

interface PendingUploadFile {
  readonly id: string;
  readonly file: File;
  readonly relativePath: string;
  readonly source: "files" | "folder" | "drop" | "paste";
}

interface FileSystemEntryLike {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly name: string;
}

interface FileSystemFileEntryLike extends FileSystemEntryLike {
  file(success: (file: File) => void, error?: (error: DOMException) => void): void;
}

interface FileSystemDirectoryEntryLike extends FileSystemEntryLike {
  createReader(): {
    readEntries(
      success: (entries: readonly FileSystemEntryLike[]) => void,
      error?: (error: DOMException) => void
    ): void;
  };
}

export function UploadCorpusPanel({
  defaultTenantId = "tenant_1",
  defaultNamespaceId = "generic-docs",
  defaultUserId = "admin_operator",
  defaultRoles = "reader",
  defaultTags = "",
  defaultSourceId = "curated_docs",
  disabledReason
}: UploadCorpusPanelProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [tenantId, setTenantId] = useState(defaultTenantId);
  const [namespaceId, setNamespaceId] = useState(defaultNamespaceId);
  const [userId, setUserId] = useState(defaultUserId);
  const [roles, setRoles] = useState(defaultRoles);
  const [tags, setTags] = useState(defaultTags);
  const [sourceId, setSourceId] = useState(defaultSourceId);
  const [overwriteMode, setOverwriteMode] = useState<"replace" | "reject">("replace");
  const [pendingFiles, setPendingFiles] = useState<readonly PendingUploadFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AdminUploadResponse | null>(null);

  useEffect(() => setTenantId(defaultTenantId), [defaultTenantId]);
  useEffect(() => setNamespaceId(defaultNamespaceId), [defaultNamespaceId]);
  useEffect(() => setUserId(defaultUserId), [defaultUserId]);
  useEffect(() => setRoles(defaultRoles), [defaultRoles]);
  useEffect(() => setTags(defaultTags), [defaultTags]);
  useEffect(() => setSourceId(defaultSourceId), [defaultSourceId]);

  const totalBytes = useMemo(
    () => pendingFiles.reduce((total, pendingFile) => total + pendingFile.file.size, 0),
    [pendingFiles]
  );
  const folderCount = useMemo(
    () =>
      new Set(
        pendingFiles
          .map((pendingFile) => pendingFile.relativePath.split("/").slice(0, -1).join("/"))
          .filter(Boolean)
      ).size,
    [pendingFiles]
  );
  const uploadBlock = uploadBlockReason({
    pendingFileCount: pendingFiles.length,
    tenantId,
    namespaceId,
    userId,
    sourceId,
    disabledReason
  });
  const uploadDisabled = disabledReason !== undefined;

  const enqueueFiles = useCallback(
    (files: readonly PendingUploadFile[]) => {
      if (uploadDisabled) return;
      setPendingFiles((current) => mergePendingFiles(current, files));
      if (files.length > 0) {
        setResult(null);
        setError(null);
      }
    },
    [uploadDisabled]
  );

  const enqueueDataTransfer = useCallback(
    async (dataTransfer: DataTransfer) => {
      enqueueFiles(await pendingFilesFromDataTransfer(dataTransfer));
    },
    [enqueueFiles]
  );

  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const handleDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDragging(true);
    };
    const handleDrop = (event: DragEvent) => {
      if (!event.dataTransfer || !hasFiles(event)) return;
      event.preventDefault();
      setDragging(false);
      void enqueueDataTransfer(event.dataTransfer);
    };
    const handleDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDragging(false);
    };
    const handlePaste = (event: ClipboardEvent) => {
      if (!event.clipboardData || event.clipboardData.files.length === 0) return;
      event.preventDefault();
      enqueueFiles(pendingFilesFromFileList(event.clipboardData.files, "paste"));
    };

    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("drop", handleDrop);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("paste", handlePaste);
    return () => {
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("drop", handleDrop);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("paste", handlePaste);
    };
  }, [enqueueDataTransfer, enqueueFiles]);

  async function submitUpload() {
    if (pendingFiles.length === 0) return;
    setUploading(true);
    setError(null);
    setResult(null);
    try {
      const formData = new FormData();
      formData.set("tenantId", tenantId);
      formData.set("namespaceId", namespaceId);
      formData.set("userId", userId);
      formData.set("roles", roles);
      formData.set("tags", tags);
      formData.set("sourceId", sourceId);
      formData.set("overwriteMode", overwriteMode);
      for (const pendingFile of pendingFiles) {
        formData.append("files", pendingFile.file, pendingFile.relativePath);
        formData.append("relativePaths", pendingFile.relativePath);
      }

      const response = await fetch("/api/rag/uploads", {
        method: "POST",
        body: formData
      });
      const json = (await response.json()) as AdminUploadResponse | UploadErrorResponse;
      if (!response.ok || "error" in json) {
        throw new Error("error" in json ? json.error.message : "Upload failed.");
      }
      setResult(json);
      if (json.ingestion.status === "available") {
        setPendingFiles([]);
      }
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <SectionCard
      title="Upload Knowledge"
      description="Files are written to an admin-managed source and indexed through the production ingestion path."
    >
      <div className="space-y-3">
        <div
          className={`rounded-lg border border-dashed p-4 ${
            dragging ? "border-primary bg-primary/10" : "border-card bg-background"
          }`}
        >
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-card text-text-secondary">
              <UploadCloud className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {dragging ? "Drop to queue upload" : "Drop files or folders"}
              </div>
              <div className="mt-1 text-xs text-text-muted">
                {formatNumber(pendingFiles.length)} file(s) queued
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadDisabled}
                className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-card bg-surface px-3 py-2 text-sm text-text-secondary hover:border-primary/30 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <FileUp className="h-4 w-4" aria-hidden="true" />
                Files
              </button>
              <button
                type="button"
                onClick={() => folderInputRef.current?.click()}
                disabled={uploadDisabled}
                className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-card bg-surface px-3 py-2 text-sm text-text-secondary hover:border-primary/30 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <FolderUp className="h-4 w-4" aria-hidden="true" />
                Folder
              </button>
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              enqueueFiles(pendingFilesFromFileList(event.currentTarget.files, "files"));
              event.currentTarget.value = "";
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              enqueueFiles(pendingFilesFromFileList(event.currentTarget.files, "folder"));
              event.currentTarget.value = "";
            }}
            {...{ webkitdirectory: "", directory: "" }}
          />
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Files" value={formatNumber(pendingFiles.length)} />
          <MetricCard label="Folders" value={formatNumber(folderCount)} />
          <MetricCard label="Size" value={formatBytes(totalBytes)} />
          <MetricCard label="Mode" value={overwriteMode} tone="primary" />
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <UploadField label="Tenant" value={tenantId} onChange={setTenantId} />
          <UploadField label="Namespace" value={namespaceId} onChange={setNamespaceId} />
          <UploadField label="User" value={userId} onChange={setUserId} />
          <UploadField label="Source" value={sourceId} onChange={setSourceId} />
          <UploadField label="Roles" value={roles} onChange={setRoles} />
          <UploadField label="Tags" value={tags} onChange={setTags} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setOverwriteMode(overwriteMode === "replace" ? "reject" : "replace")}
              className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-card bg-surface px-3 py-2 text-sm text-text-secondary hover:border-primary/30"
            >
              <Clipboard className="h-4 w-4" aria-hidden="true" />
              {overwriteMode === "replace" ? "Replace existing" : "Reject duplicates"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPendingFiles([]);
                setResult(null);
                setError(null);
              }}
              disabled={pendingFiles.length === 0 && !result && !error}
              className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-card bg-surface px-3 py-2 text-sm text-text-secondary hover:border-primary/30 disabled:opacity-40"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Clear
            </button>
          </div>
          <button
            type="button"
            onClick={() => void submitUpload()}
            disabled={uploading || uploadBlock !== undefined}
            title={uploadBlock?.title ?? "Upload files and start ingestion"}
            className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-text-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {uploading ? (
              <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <UploadCloud className="h-4 w-4" aria-hidden="true" />
            )}
            Upload and ingest
          </button>
        </div>

        {uploadBlock ? (
          <div className="rounded-lg border border-warning/20 bg-warning/10 p-3 text-xs leading-5 text-warning">
            <span className="font-medium">{uploadBlock.title}</span>
            <span className="block">{uploadBlock.detail}</span>
          </div>
        ) : null}
        {pendingFiles.length > 0 ? <PendingFileList files={pendingFiles} /> : null}
        {error ? <ErrorBanner message={error} /> : null}
        {result ? <UploadResult result={result} /> : null}
      </div>
    </SectionCard>
  );
}

function UploadField({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-text-muted">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-card bg-background px-3 py-2 text-xs"
      />
    </label>
  );
}

function PendingFileList({ files }: { files: readonly PendingUploadFile[] }) {
  return (
    <div className="max-h-48 overflow-y-auto rounded-lg border border-card bg-background">
      {files.slice(0, 80).map((pendingFile) => (
        <div
          key={pendingFile.id}
          className="flex items-center justify-between gap-3 border-b border-card px-3 py-2 last:border-0"
        >
          <div className="min-w-0">
            <div className="truncate text-xs font-medium">
              {truncateMiddle(pendingFile.relativePath, 68)}
            </div>
            <div className="text-[11px] text-text-muted">{pendingFile.source}</div>
          </div>
          <div className="shrink-0 text-xs text-text-muted">
            {formatBytes(pendingFile.file.size)}
          </div>
        </div>
      ))}
      {files.length > 80 ? (
        <div className="px-3 py-2 text-xs text-text-muted">
          {formatNumber(files.length - 80)} more queued
        </div>
      ) : null}
    </div>
  );
}

function UploadResult({ result }: { result: AdminUploadResponse }) {
  const counts = result.ingestion.data?.counts;
  const runId = result.ingestion.data?.runId;
  return (
    <div className="space-y-3 rounded-lg border border-card bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill label={result.status} tone={statusTone(result.status)} />
        <StatusPill
          label={result.ingestion.status}
          tone={result.ingestion.status === "available" ? "success" : "error"}
        />
        {runId ? <StatusPill label={truncateMiddle(runId, 42)} tone="primary" /> : null}
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Stored" value={formatNumber(result.storedFiles.length)} tone="success" />
        <MetricCard
          label="Skipped"
          value={formatNumber(result.skippedFiles.length)}
          tone={result.skippedFiles.length ? "warning" : "default"}
        />
        <MetricCard label="Documents" value={formatNumber(counts?.documentsAccepted)} />
        <MetricCard label="Chunks" value={formatNumber(counts?.chunksAccepted)} />
      </div>

      <div className="flex flex-wrap gap-2">
        <Link
          className="inline-flex min-h-9 items-center rounded-lg border border-card bg-surface px-3 py-2 text-sm text-text-secondary hover:border-primary/30"
          href={sourceHref(result.sourceId)}
        >
          Open source
        </Link>
        <Link
          className="inline-flex min-h-9 items-center rounded-lg border border-card bg-surface px-3 py-2 text-sm text-text-secondary hover:border-primary/30"
          href={corpusHref(result.tenantId, result.namespaceId)}
        >
          Open corpus runs
        </Link>
      </div>

      {result.ingestion.error ? <ErrorBanner message={result.ingestion.error} /> : null}
      {result.runtime.message ? (
        <div className="rounded-lg border border-warning/20 bg-warning/10 p-3 text-xs text-warning">
          {result.runtime.message}
        </div>
      ) : null}

      <div className="grid gap-2 text-xs text-text-muted md:grid-cols-2">
        <div>Batch: {truncateMiddle(result.batchId, 56)}</div>
        <div>Source: {result.sourceId}</div>
        <div>Finished: {formatTime(result.ingestion.data?.finishedAt)}</div>
        <div>Index: {result.ingestion.data?.index?.storageKind ?? "n/a"}</div>
      </div>

      {result.skippedFiles.length > 0 ? (
        <div className="space-y-1">
          {result.skippedFiles.slice(0, 5).map((skipped) => (
            <div key={`${skipped.relativePath}:${skipped.reason}`} className="text-xs text-warning">
              {truncateMiddle(skipped.relativePath, 60)}: {skipped.reason}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function sourceHref(sourceId: string): string {
  return `/sources?sourceId=${encodeURIComponent(sourceId)}`;
}

function corpusHref(tenantId: string, namespaceId: string): string {
  const params = new URLSearchParams({ tenantId, namespaceId });
  return `/ingestion?${params.toString()}`;
}

async function pendingFilesFromDataTransfer(
  dataTransfer: DataTransfer
): Promise<readonly PendingUploadFile[]> {
  const entries = Array.from(dataTransfer.items)
    .map((item) => entryFromDataTransferItem(item))
    .filter((entry): entry is FileSystemEntryLike => Boolean(entry));

  if (entries.length === 0) {
    return pendingFilesFromFileList(dataTransfer.files, "drop");
  }

  const files: PendingUploadFile[] = [];
  for (const entry of entries) {
    files.push(...(await pendingFilesFromEntry(entry, "", "drop")));
  }
  return files;
}

async function pendingFilesFromEntry(
  entry: FileSystemEntryLike,
  parentPath: string,
  source: PendingUploadFile["source"]
): Promise<readonly PendingUploadFile[]> {
  if (entry.isFile) {
    const file = await fileFromEntry(entry as FileSystemFileEntryLike);
    const relativePath = joinRelativePath(parentPath, file.name);
    return [pendingUploadFile(file, relativePath, source)];
  }

  if (!entry.isDirectory) return [];
  const directory = entry as FileSystemDirectoryEntryLike;
  const nextParent = joinRelativePath(parentPath, directory.name);
  const entries = await readAllDirectoryEntries(directory);
  const nested = await Promise.all(
    entries.map((nestedEntry) => pendingFilesFromEntry(nestedEntry, nextParent, source))
  );
  return nested.flat();
}

function entryFromDataTransferItem(item: DataTransferItem): FileSystemEntryLike | null {
  const withEntry = item as DataTransferItem & { readonly webkitGetAsEntry?: () => unknown };
  return (withEntry.webkitGetAsEntry?.() as FileSystemEntryLike | null | undefined) ?? null;
}

function pendingFilesFromFileList(
  fileList: FileList | null,
  source: PendingUploadFile["source"]
): readonly PendingUploadFile[] {
  if (!fileList) return [];
  return Array.from(fileList).map((file) =>
    pendingUploadFile(file, relativePathForFile(file), source)
  );
}

function pendingUploadFile(
  file: File,
  relativePath: string,
  source: PendingUploadFile["source"]
): PendingUploadFile {
  return {
    id: `${source}:${relativePath}:${file.size}:${file.lastModified}:${Math.random().toString(16).slice(2)}`,
    file,
    relativePath,
    source
  };
}

function mergePendingFiles(
  current: readonly PendingUploadFile[],
  incoming: readonly PendingUploadFile[]
): readonly PendingUploadFile[] {
  const used = new Set(current.map((file) => file.relativePath));
  const merged = [...current];
  for (const file of incoming) {
    const relativePath = uniqueClientRelativePath(cleanClientRelativePath(file.relativePath), used);
    merged.push({ ...file, relativePath });
  }
  return merged;
}

function relativePathForFile(file: File): string {
  const withPath = file as File & { readonly webkitRelativePath?: string };
  return withPath.webkitRelativePath?.trim() || file.name || "uploaded_file";
}

function cleanClientRelativePath(value: string): string {
  const segments = value
    .replace(/\\/g, "/")
    .replace(/^[A-Za-z]:/, "")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..");
  return segments.length === 0 ? "uploaded_file" : segments.join("/");
}

function uploadBlockReason(input: {
  readonly pendingFileCount: number;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly userId: string;
  readonly sourceId: string;
  readonly disabledReason?: string;
}): { readonly title: string; readonly detail: string } | undefined {
  if (input.disabledReason) {
    return {
      title: "Upload ingestion is unavailable",
      detail: input.disabledReason
    };
  }

  if (input.pendingFileCount === 0) {
    return {
      title: "Choose files before uploading",
      detail: "The upload action is blocked until at least one file or folder is queued."
    };
  }

  const missing = [
    input.tenantId.trim() ? undefined : "tenant",
    input.namespaceId.trim() ? undefined : "namespace",
    input.userId.trim() ? undefined : "user",
    input.sourceId.trim() ? undefined : "source"
  ].filter((value): value is string => Boolean(value));

  if (missing.length > 0) {
    return {
      title: "Complete upload scope",
      detail: `Missing ${missing.join(", ")}. Ingestion needs scope before it can write source records, documents, chunks, and vectors.`
    };
  }

  return undefined;
}

function uniqueClientRelativePath(relativePath: string, used: Set<string>): string {
  if (!used.has(relativePath)) {
    used.add(relativePath);
    return relativePath;
  }
  const slashIndex = relativePath.lastIndexOf("/");
  const directory = slashIndex >= 0 ? relativePath.slice(0, slashIndex + 1) : "";
  const fileName = slashIndex >= 0 ? relativePath.slice(slashIndex + 1) : relativePath;
  const dotIndex = fileName.lastIndexOf(".");
  const base = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  const extension = dotIndex > 0 ? fileName.slice(dotIndex) : "";
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${directory}${base}-${index}${extension}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  return `${directory}${base}-${Date.now()}${extension}`;
}

function joinRelativePath(parentPath: string, name: string): string {
  return [parentPath, name].filter(Boolean).join("/");
}

function fileFromEntry(entry: FileSystemFileEntryLike): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

async function readAllDirectoryEntries(
  directory: FileSystemDirectoryEntryLike
): Promise<readonly FileSystemEntryLike[]> {
  const reader = directory.createReader();
  const entries: FileSystemEntryLike[] = [];
  while (true) {
    const batch = await new Promise<readonly FileSystemEntryLike[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "n/a";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

interface UploadErrorResponse {
  readonly error: {
    readonly name?: string;
    readonly message: string;
  };
}
