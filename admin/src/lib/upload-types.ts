export type AdminUploadStatus = "ingested" | "uploaded_with_ingestion_error";

export interface AdminUploadStoredFile {
  readonly relativePath: string;
  readonly sizeBytes: number;
}

export interface AdminUploadSkippedFile {
  readonly relativePath: string;
  readonly reason: string;
}

export interface AdminUploadIngestionSummary {
  readonly status?: string;
  readonly runId?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly loadedSourceIds?: readonly string[];
  readonly counts?: {
    readonly documentsAccepted?: number;
    readonly chunksAccepted?: number;
    readonly recordsRejected?: number;
    readonly indexWritesAccepted?: number;
    readonly indexWritesRejected?: number;
    readonly adapterWarnings?: number;
    readonly normalizationIssues?: number;
    readonly parserQualityWarnings?: number;
    readonly chunkingWarnings?: number;
  };
  readonly index?: {
    readonly storageKind?: string;
    readonly durable?: boolean;
    readonly documentCount?: number;
    readonly chunkCount?: number;
  };
}

export interface AdminUploadIngestionResult {
  readonly status: "available" | "unavailable";
  readonly data?: AdminUploadIngestionSummary;
  readonly error?: string;
  readonly command?: readonly string[];
}

export interface AdminUploadRuntimeNote {
  readonly indexStorageKind?: string;
  readonly reloadRecommended: boolean;
  readonly message?: string;
}

export interface AdminUploadResponse {
  readonly status: AdminUploadStatus;
  readonly batchId: string;
  readonly sourceId: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly rootDir: string;
  readonly sourceConfigPath: string;
  readonly storedFiles: readonly AdminUploadStoredFile[];
  readonly skippedFiles: readonly AdminUploadSkippedFile[];
  readonly totalBytes: number;
  readonly ingestion: AdminUploadIngestionResult;
  readonly runtime: AdminUploadRuntimeNote;
}
