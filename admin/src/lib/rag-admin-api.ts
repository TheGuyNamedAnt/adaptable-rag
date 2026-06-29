import "server-only";

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AdminAnswerRequest, AdminAnswerResponse } from "@/lib/rag-answer-types";
import { resolveRagRepoRoot } from "@/lib/repo-root";
import type { AdminUploadIngestionSummary } from "@/lib/upload-types";

const execFileAsync = promisify(execFile);

export interface Availability<T> {
  readonly status: "available" | "unavailable";
  readonly data?: T;
  readonly error?: string;
  readonly command?: readonly string[];
  readonly url?: string;
}

export interface ProductionHealth {
  readonly status?: string;
  readonly profileId?: string;
  readonly namespaceId?: string;
  readonly retrievalMode?: string;
  readonly index?: {
    readonly storageKind?: string;
    readonly durable?: boolean;
    readonly documentCount?: number;
    readonly chunkCount?: number;
  };
  readonly vector?: {
    readonly storageKind?: string;
    readonly durable?: boolean;
    readonly dimensions?: number;
  };
  readonly visualVector?: {
    readonly storageKind?: string;
    readonly durable?: boolean;
    readonly dimensions?: number;
  };
  readonly sourceSyncLedger?: {
    readonly storageKind?: string;
    readonly durable?: boolean;
  };
  readonly providers?: Record<string, ProviderSummary | undefined>;
}

export interface ProviderSummary {
  readonly id?: string;
  readonly provider?: string;
  readonly modelName?: string;
}

export interface ReadyResponse {
  readonly status?: string;
  readonly ready?: boolean;
  readonly health?: ProductionHealth;
}

export interface RuntimeDoctorResult {
  readonly status?: string;
  readonly checkedAt?: string;
  readonly health?: ProductionHealth;
  readonly selfTest?: {
    readonly status?: string;
    readonly checkedAt?: string;
    readonly profileId?: string;
    readonly namespaceId?: string;
    readonly retrievalMode?: string;
    readonly probeProviders?: boolean;
    readonly checkCount?: number;
    readonly failedCount?: number;
    readonly skippedCount?: number;
    readonly checks?: readonly RuntimeDoctorCheck[];
  };
  readonly recommendations?: readonly string[];
  readonly companyDeployment?: unknown;
}

export interface RuntimeDoctorCheck {
  readonly id?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly message?: string;
  readonly provider?: string;
  readonly modelName?: string;
  readonly warnings?: readonly string[];
}

export interface HttpMetrics {
  readonly startedAt?: string;
  readonly uptimeMs?: number;
  readonly ready?: boolean;
  readonly draining?: boolean;
  readonly totalRequests?: number;
  readonly activeRequests?: number;
  readonly completedRequests?: number;
  readonly byStatusCode?: Record<string, number>;
  readonly byRoute?: Record<string, number>;
  readonly byOutcome?: Record<string, number>;
  readonly authDenied?: number;
  readonly rateLimited?: number;
  readonly answerSucceeded?: number;
  readonly answerRefused?: number;
  readonly answerFailed?: number;
  readonly requestErrors?: number;
  readonly serverErrors?: number;
}

export interface IngestionJobRecord {
  readonly jobId: string;
  readonly runId: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly sourceIds: readonly string[];
  readonly status: string;
  readonly stage: string;
  readonly attempt: number;
  readonly requestedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly updatedAt: string;
  readonly counts?: Record<string, number>;
  readonly errorName?: string;
  readonly errorMessage?: string;
}

export interface IngestionCheckpointRecord {
  readonly jobId: string;
  readonly checkpointId: string;
  readonly sequence: number;
  readonly stage: string;
  readonly checkpoint: Record<string, unknown>;
  readonly recordedAt: string;
}

export interface IngestionSourceProgressRecord {
  readonly jobId: string;
  readonly sourceId: string;
  readonly status: string;
  readonly loadedDocumentCount: number;
  readonly acceptedDocumentCount: number;
  readonly failedDocumentCount: number;
  readonly skippedDocumentCount: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly updatedAt: string;
  readonly errorMessage?: string;
}

export interface IngestionDocumentProgressRecord {
  readonly jobId: string;
  readonly sourceId: string;
  readonly documentId: string;
  readonly status: string;
  readonly chunkCount: number;
  readonly retryable: boolean;
  readonly attempt: number;
  readonly failureStage?: string;
  readonly failurePhase?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly updatedAt: string;
  readonly errorMessage?: string;
}

export interface InspectIngestionRunResult {
  readonly job: IngestionJobRecord;
  readonly summary: {
    readonly jobId: string;
    readonly runId: string;
    readonly tenantId: string;
    readonly namespaceId: string;
    readonly sourceIds: readonly string[];
    readonly status: string;
    readonly stage: string;
    readonly attempt: number;
    readonly requestedAt: string;
    readonly startedAt?: string;
    readonly finishedAt?: string;
    readonly durationMs?: number;
    readonly updatedAt: string;
    readonly currentCheckpointPhase?: string;
    readonly failed: boolean;
    readonly counts?: Record<string, number>;
    readonly errorName?: string;
    readonly errorMessage?: string;
  };
  readonly checkpoints: readonly IngestionCheckpointRecord[];
  readonly latestCheckpoint?: IngestionCheckpointRecord;
  readonly sources: readonly IngestionSourceProgressRecord[];
  readonly documents: readonly IngestionDocumentProgressRecord[];
  readonly failedDocuments: readonly IngestionDocumentProgressRecord[];
  readonly skippedDocuments: readonly IngestionDocumentProgressRecord[];
  readonly acceptedDocuments: readonly IngestionDocumentProgressRecord[];
  readonly counts: {
    readonly checkpointCount: number;
    readonly sourceCount: number;
    readonly documentCount: number;
    readonly failedDocumentCount: number;
    readonly skippedDocumentCount: number;
    readonly acceptedDocumentCount: number;
    readonly retryableFailureCount: number;
  };
  readonly page: {
    readonly checkpointLimit: number;
    readonly checkpointOffset: number;
    readonly checkpointHasMore: boolean;
    readonly documentLimit: number;
    readonly documentOffset: number;
    readonly documentHasMore: boolean;
    readonly sourceId?: string;
    readonly documentStatuses?: readonly string[];
  };
}

export interface SourceHealthRecord {
  readonly jobId: string;
  readonly sourceId: string;
  readonly status: string;
  readonly health: string;
  readonly loadedDocumentCount: number;
  readonly acceptedDocumentCount: number;
  readonly failedDocumentCount: number;
  readonly skippedDocumentCount: number;
  readonly updatedAt: string;
  readonly errorMessage?: string;
}

export interface SourceHealthResult {
  readonly jobId: string;
  readonly sources: readonly SourceHealthRecord[];
}

export interface OverviewResult {
  readonly status: "available" | "partial" | "unavailable";
  readonly generatedAt: string;
  readonly health: ProductionHealth | undefined;
  readonly ready: ReadyResponse | undefined;
  readonly metrics: HttpMetrics | undefined;
  readonly recentJobs: readonly IngestionJobRecord[];
  readonly errors: readonly string[];
  readonly endpoints: {
    readonly baseUrl: string;
    readonly repoRoot: string;
  };
}

export interface ShellOverviewResult {
  readonly status: "available" | "partial" | "unavailable";
  readonly health: ProductionHealth | undefined;
  readonly ready: ReadyResponse | undefined;
}

export interface IngestionJobsQuery {
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly status?: string;
  readonly limit?: number;
}

export interface IngestionJobDetailQuery {
  readonly sourceId?: string;
  readonly documentStatus?: readonly string[];
  readonly documentLimit?: number;
  readonly documentOffset?: number;
  readonly checkpointLimit?: number;
  readonly checkpointOffset?: number;
}

export interface AdminIndexGenerationManifest {
  readonly generationId: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly profileId: string;
  readonly status: string;
  readonly embeddingProvider: string;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
  readonly embeddingConfigHash: string;
  readonly embeddingIndexConfigHash: string;
  readonly chunkingPolicyId: string;
  readonly chunkingPolicyVersion: number;
  readonly chunkerVersion?: string;
  readonly createdAt: string;
  readonly promotedAt?: string;
  readonly deprecatedAt?: string;
  readonly evalReportUri?: string;
  readonly metadata?: Record<string, string | number | boolean>;
}

export interface AdminIndexGenerationListQuery {
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly statuses?: readonly string[];
  readonly limit?: number;
}

export interface AdminIndexGenerationListResult {
  readonly manifests: readonly AdminIndexGenerationManifest[];
  readonly count: number;
  readonly filter: Record<string, unknown>;
}

export interface AdminGenerationEvalResult {
  readonly evalId: string;
  readonly status: string;
  readonly recordedAt: string;
  readonly reportUri?: string;
  readonly summary?: string;
}

export interface AdminGenerationPromotionRecord {
  readonly promotionId: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly candidateGenerationId: string;
  readonly previousActiveGenerationId?: string;
  readonly requiredEvalIds: readonly string[];
  readonly actions: readonly string[];
  readonly plannedAt: string;
  readonly status: string;
  readonly evalResults: readonly AdminGenerationEvalResult[];
  readonly updatedAt: string;
  readonly promotedAt?: string;
  readonly failureReason?: string;
}

export interface AdminGenerationPromotionPlanInput {
  readonly promotionId: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly profileId?: string;
  readonly generationId: string;
  readonly activeGenerationId?: string;
  readonly embeddingProvider: string;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
  readonly embeddingConfigHash: string;
  readonly embeddingIndexConfigHash: string;
  readonly chunkingPolicyId: string;
  readonly chunkingPolicyVersion: number;
  readonly chunkerVersion?: string;
  readonly requiredEvalIds?: readonly string[];
  readonly archivePrevious?: boolean;
  readonly dryRun?: boolean;
  readonly replace?: boolean;
  readonly requestedAt?: string;
  readonly evalReportUri?: string;
}

export interface AdminGenerationPromotionPlanResult {
  readonly status: string;
  readonly dryRun: boolean;
  readonly promotionId: string;
  readonly candidateGeneration: AdminIndexGenerationManifest;
  readonly activeGeneration?: AdminIndexGenerationManifest;
  readonly promotion: AdminGenerationPromotionRecord | Record<string, unknown>;
}

export interface AdminRecordGenerationEvalInput {
  readonly promotionId: string;
  readonly evalId: string;
  readonly evalStatus: "passed" | "failed";
  readonly recordedAt?: string;
  readonly requestedAt?: string;
  readonly reportUri?: string;
  readonly summary?: string;
}

export interface AdminPromoteGenerationInput {
  readonly promotionId: string;
  readonly promotedAt?: string;
  readonly requestedAt?: string;
}

export interface AdminUploadedLocalFilesIngestInput {
  readonly sourceConfigPath: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly sourceId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  readonly tags: readonly string[];
  readonly overwriteMode?: "reject" | "replace";
  readonly runId?: string;
  readonly requestedAt?: string;
}

export type AdminConnectorSyncMode = "delta" | "full";

export interface AdminCompanyConnectorSyncInput {
  readonly companyId: string;
  readonly connectorId: string;
  readonly sourceId: string;
  readonly namespaceId?: string;
  readonly mode: AdminConnectorSyncMode;
  readonly deleteMissing?: boolean;
  readonly overwriteMode?: "reject" | "replace";
  readonly tenantId?: string;
  readonly userId?: string;
  readonly roles?: readonly string[];
  readonly tags?: readonly string[];
  readonly teamIds?: readonly string[];
  readonly runId?: string;
  readonly requestedAt?: string;
}

export interface AdminCompanySyncResult {
  readonly status?: string;
  readonly runId?: string;
  readonly mode?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly companyDeployment?: unknown;
  readonly connectorCount?: number;
  readonly sourceCount?: number;
  readonly results?: readonly AdminCompanySyncSourceResult[];
  readonly metrics?: AdminCompanySyncMetrics;
}

export interface AdminCompanySyncSourceResult {
  readonly status?: string;
  readonly connectorId?: string;
  readonly sourceSystem?: string;
  readonly adapterId?: string;
  readonly sourceId?: string;
  readonly runId?: string;
  readonly mode?: string;
  readonly complete?: boolean;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly sync?: {
    readonly status?: string;
    readonly listedItemCount?: number;
    readonly returnedRecordCount?: number;
    readonly deletedItemCount?: number;
    readonly failedItemCount?: number;
    readonly skippedUnchangedCount?: number;
    readonly tombstonedMissingCount?: number;
    readonly warningCount?: number;
    readonly warningCodes?: readonly string[];
  };
  readonly ingest?: {
    readonly documentCount?: number;
    readonly chunkCount?: number;
    readonly rejectedRecordCount?: number;
    readonly normalizationIssueCount?: number;
  };
  readonly deletePropagation?: {
    readonly status?: string;
    readonly propagatedDocumentCount?: number;
    readonly deletedDocumentCount?: number;
    readonly deletedChunkCount?: number;
    readonly errorCount?: number;
  };
  readonly postIngest?: {
    readonly status?: string;
    readonly warningCodes?: readonly string[];
    readonly indexedVectorCount?: number;
    readonly indexedRelationVectorCount?: number;
    readonly indexedVisualVectorCount?: number;
    readonly knowledgeEntityCount?: number;
    readonly knowledgeRelationCount?: number;
  };
  readonly warningCodes?: readonly string[];
  readonly metrics?: Record<string, number | undefined>;
}

export interface AdminCompanySyncMetrics {
  readonly syncedRecordCount?: number;
  readonly syncedDeleteCount?: number;
  readonly syncFailedItemCount?: number;
  readonly ingestedDocumentCount?: number;
  readonly ingestedChunkCount?: number;
  readonly rejectedRecordCount?: number;
  readonly indexedVectorCount?: number;
  readonly indexedRelationVectorCount?: number;
  readonly indexedVisualVectorCount?: number;
  readonly knowledgeEntityCount?: number;
  readonly knowledgeRelationCount?: number;
  readonly propagatedDeleteCount?: number;
  readonly deletedDocumentCount?: number;
  readonly deletedChunkCount?: number;
  readonly ledgerSavedCount?: number;
}

export async function getShellOverview(): Promise<ShellOverviewResult> {
  const [healthResult, readyResult] = await Promise.all([
    fetchRagJson<ProductionHealth>("/health"),
    fetchRagJson<ReadyResponse>("/ready")
  ]);
  const availableCount = [healthResult, readyResult].filter(
    (result) => result.status === "available"
  ).length;

  return {
    status: availableCount === 2 ? "available" : availableCount > 0 ? "partial" : "unavailable",
    health: healthResult.data ?? readyResult.data?.health,
    ready: readyResult.data
  };
}

export async function getOverview(): Promise<OverviewResult> {
  const [healthResult, readyResult, metricsResult, jobsResult] = await Promise.all([
    fetchRagJson<ProductionHealth>("/health"),
    fetchRagJson<ReadyResponse>("/ready"),
    fetchRagJson<HttpMetrics>("/metrics"),
    getIngestionJobs({ limit: 5 })
  ]);
  const errors = [
    healthResult.error,
    readyResult.error,
    metricsResult.error,
    jobsResult.error
  ].filter((error): error is string => Boolean(error));
  const availableCount = [healthResult, readyResult, metricsResult, jobsResult].filter(
    (result) => result.status === "available"
  ).length;

  return {
    status: availableCount === 4 ? "available" : availableCount > 0 ? "partial" : "unavailable",
    generatedAt: new Date().toISOString(),
    health: healthResult.data ?? readyResult.data?.health,
    ready: readyResult.data,
    metrics: metricsResult.data,
    recentJobs: jobsResult.data ?? [],
    errors,
    endpoints: {
      baseUrl: ragBaseUrl(),
      repoRoot: repoRoot()
    }
  };
}

export async function getRuntimeDoctor(
  options: {
    readonly probeProviders?: boolean;
  } = {}
): Promise<Availability<RuntimeDoctorResult>> {
  const args = ["doctor"];
  if (options.probeProviders !== undefined) {
    args.push("--probe-providers", options.probeProviders ? "true" : "false");
  }
  return runCliJson<RuntimeDoctorResult>(args, {
    allowNonZeroJson: true,
    errorFallback: "RAG service doctor command failed."
  });
}

export async function getIngestionJobs(
  query: IngestionJobsQuery = {}
): Promise<Availability<readonly IngestionJobRecord[]>> {
  const args = ["inspect-ingestion-jobs"];
  if (query.tenantId) args.push("--tenant-id", query.tenantId);
  if (query.namespaceId) args.push("--namespace-id", query.namespaceId);
  if (query.status) args.push("--status", query.status);
  args.push("--limit", String(query.limit ?? 20));
  return runCliJson<readonly IngestionJobRecord[]>(args);
}

export async function getIngestionJobDetail(
  jobId: string,
  query: IngestionJobDetailQuery = {}
): Promise<Availability<InspectIngestionRunResult>> {
  const args = ["inspect-ingestion-job", "--job-id", jobId];
  if (query.sourceId) args.push("--source-id", query.sourceId);
  for (const status of query.documentStatus ?? []) {
    args.push("--document-status", status);
  }
  args.push("--document-limit", String(query.documentLimit ?? 50));
  args.push("--document-offset", String(query.documentOffset ?? 0));
  args.push("--checkpoint-limit", String(query.checkpointLimit ?? 20));
  args.push("--checkpoint-offset", String(query.checkpointOffset ?? 0));
  return runCliJson<InspectIngestionRunResult>(args);
}

export async function getSourceHealth(
  jobId: string,
  sourceId?: string
): Promise<Availability<SourceHealthResult>> {
  const args = ["inspect-source-health", "--job-id", jobId];
  if (sourceId) args.push("--source-id", sourceId);
  return runCliJson<SourceHealthResult>(args);
}

export async function getIndexGenerations(
  query: AdminIndexGenerationListQuery = {}
): Promise<Availability<AdminIndexGenerationListResult>> {
  const args = ["inspect-index-generations"];
  if (query.tenantId) args.push("--tenant-id", query.tenantId);
  if (query.namespaceId) args.push("--namespace-id", query.namespaceId);
  for (const status of query.statuses ?? []) {
    args.push("--generation-status", status);
  }
  args.push("--limit", String(query.limit ?? 20));
  return runCliJson<AdminIndexGenerationListResult>(args);
}

export async function getGenerationPromotion(
  promotionId: string
): Promise<Availability<AdminGenerationPromotionRecord>> {
  return runCliJson<AdminGenerationPromotionRecord>([
    "inspect-generation-promotion",
    "--promotion-id",
    promotionId
  ]);
}

export async function planGenerationPromotion(
  input: AdminGenerationPromotionPlanInput
): Promise<Availability<AdminGenerationPromotionPlanResult>> {
  const args = [
    "plan-generation-promotion",
    "--promotion-id",
    input.promotionId,
    "--tenant-id",
    input.tenantId,
    "--namespace-id",
    input.namespaceId,
    "--generation-id",
    input.generationId,
    "--embedding-provider",
    input.embeddingProvider,
    "--embedding-model",
    input.embeddingModel,
    "--embedding-dimensions",
    String(input.embeddingDimensions),
    "--embedding-config-hash",
    input.embeddingConfigHash,
    "--embedding-index-config-hash",
    input.embeddingIndexConfigHash,
    "--chunking-policy-id",
    input.chunkingPolicyId,
    "--chunking-policy-version",
    String(input.chunkingPolicyVersion)
  ];
  if (input.profileId) args.push("--profile-id", input.profileId);
  if (input.activeGenerationId) args.push("--active-generation-id", input.activeGenerationId);
  if (input.chunkerVersion) args.push("--chunker-version", input.chunkerVersion);
  for (const evalId of input.requiredEvalIds ?? []) args.push("--required-eval-id", evalId);
  if (input.archivePrevious !== undefined) {
    args.push("--archive-previous", input.archivePrevious ? "true" : "false");
  }
  if (input.dryRun !== undefined) args.push("--dry-run", input.dryRun ? "true" : "false");
  if (input.replace !== undefined) args.push("--replace", input.replace ? "true" : "false");
  if (input.requestedAt) args.push("--requested-at", input.requestedAt);
  if (input.evalReportUri) args.push("--eval-report-uri", input.evalReportUri);
  return runCliJson<AdminGenerationPromotionPlanResult>(args);
}

export async function recordGenerationEval(
  input: AdminRecordGenerationEvalInput
): Promise<Availability<AdminGenerationPromotionRecord>> {
  const args = [
    "record-generation-eval",
    "--promotion-id",
    input.promotionId,
    "--eval-id",
    input.evalId,
    "--eval-status",
    input.evalStatus
  ];
  if (input.recordedAt) args.push("--recorded-at", input.recordedAt);
  if (input.requestedAt) args.push("--requested-at", input.requestedAt);
  if (input.reportUri) args.push("--report-uri", input.reportUri);
  if (input.summary) args.push("--summary", input.summary);
  return runCliJson<AdminGenerationPromotionRecord>(args);
}

export async function promoteGeneration(
  input: AdminPromoteGenerationInput
): Promise<Availability<AdminGenerationPromotionRecord>> {
  const args = ["promote-generation", "--promotion-id", input.promotionId];
  if (input.promotedAt) args.push("--promoted-at", input.promotedAt);
  if (input.requestedAt) args.push("--requested-at", input.requestedAt);
  return runCliJson<AdminGenerationPromotionRecord>(args, {
    allowNonZeroJson: true,
    errorFallback: "RAG generation promotion command failed."
  });
}

export async function postAnswer(
  request: AdminAnswerRequest
): Promise<Availability<AdminAnswerResponse>> {
  return fetchRagJson<AdminAnswerResponse>("/answer", {
    method: "POST",
    body: JSON.stringify(request)
  });
}

export async function ingestUploadedLocalFiles(
  input: AdminUploadedLocalFilesIngestInput
): Promise<Availability<AdminUploadIngestionSummary>> {
  const args = [
    "ingest",
    "--tenant-id",
    input.tenantId,
    "--namespace-id",
    input.namespaceId,
    "--user-id",
    input.userId,
    "--principal-namespace-id",
    input.namespaceId,
    "--source-id",
    input.sourceId,
    "--overwrite",
    input.overwriteMode ?? "replace"
  ];
  for (const role of input.roles) args.push("--role", role);
  for (const tag of input.tags) args.push("--tag", tag);
  if (input.runId) args.push("--run-id", input.runId);
  if (input.requestedAt) args.push("--requested-at", input.requestedAt);

  return runCliJson<AdminUploadIngestionSummary>(args, {
    env: uploadIngestEnv(input.sourceConfigPath)
  });
}

export async function runCompanyConnectorSync(
  input: AdminCompanyConnectorSyncInput
): Promise<Availability<AdminCompanySyncResult>> {
  const requestedAt = input.requestedAt ?? new Date().toISOString();
  const namespaceId =
    input.namespaceId ?? process.env.RAG_ADMIN_SYNC_NAMESPACE_ID ?? "generic-docs";
  const tenantId =
    input.tenantId ??
    process.env.RAG_ADMIN_SYNC_TENANT_ID ??
    `tenant_${safeCliId(input.companyId)}`;
  const userId = input.userId ?? process.env.RAG_ADMIN_SYNC_USER_ID ?? "admin_connector_sync";
  const roles = input.roles ?? envList("RAG_ADMIN_SYNC_ROLES", ["admin", "support", "reader"]);
  const tags = input.tags ?? envList("RAG_ADMIN_SYNC_TAGS", ["admin-sync", "trusted"]);
  const teamIds = input.teamIds ?? envList("RAG_ADMIN_SYNC_TEAM_IDS", []);
  const runId =
    input.runId ??
    `admin_connector_${input.mode}_${safeCliId(input.connectorId)}_${safeCliId(requestedAt)}`;
  const deleteMissing = input.deleteMissing ?? input.mode === "full";

  const args = [
    "sync",
    "--mode",
    input.mode,
    "--tenant-id",
    tenantId,
    "--namespace-id",
    namespaceId,
    "--user-id",
    userId,
    "--principal-namespace-id",
    namespaceId,
    "--connector-id",
    input.connectorId,
    "--source-id",
    input.sourceId,
    "--delete-missing",
    deleteMissing ? "true" : "false",
    "--overwrite",
    input.overwriteMode ?? "replace",
    "--run-id",
    runId,
    "--requested-at",
    requestedAt
  ];
  for (const role of roles) args.push("--role", role);
  for (const tag of tags) args.push("--tag", tag);
  for (const teamId of teamIds) args.push("--team-id", teamId);

  return runCliJson<AdminCompanySyncResult>(args, {
    env: companySyncEnv({
      companyId: input.companyId,
      namespaceId
    }),
    allowNonZeroJson: true,
    errorFallback: "RAG company connector sync command failed."
  });
}

function uploadIngestEnv(sourceConfigPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RAG_HTTP_AUTH_MODE: process.env.RAG_HTTP_AUTH_MODE ?? "disabled",
    RAG_MODEL_PROVIDER: process.env.RAG_MODEL_PROVIDER ?? "json-chat",
    RAG_MODEL_MODEL_NAME: process.env.RAG_MODEL_MODEL_NAME ?? "ingest-placeholder",
    RAG_MODEL_ENDPOINT:
      process.env.RAG_MODEL_ENDPOINT ?? "https://provider.example.invalid/v1/chat",
    RAG_MODEL_API_KEY: process.env.RAG_MODEL_API_KEY ?? "ingest-placeholder",
    RAG_RERANK_PROVIDER: process.env.RAG_RERANK_PROVIDER ?? "json-chat",
    RAG_RERANK_MODEL_NAME: process.env.RAG_RERANK_MODEL_NAME ?? "rerank-placeholder",
    RAG_RERANK_ENDPOINT:
      process.env.RAG_RERANK_ENDPOINT ?? "https://provider.example.invalid/v1/rerank",
    RAG_RERANK_API_KEY: process.env.RAG_RERANK_API_KEY ?? "rerank-placeholder",
    RAG_APP_EMBEDDING_MODE: process.env.RAG_APP_EMBEDDING_MODE ?? "disabled",
    RAG_APP_VISUAL_EMBEDDING_MODE: process.env.RAG_APP_VISUAL_EMBEDDING_MODE ?? "disabled",
    RAG_APP_GROUNDING_JUDGE_MODE: process.env.RAG_APP_GROUNDING_JUDGE_MODE ?? "disabled",
    RAG_LOCAL_FILES_SOURCES_PATH: sourceConfigPath
  };
}

function companySyncEnv(input: {
  readonly companyId: string;
  readonly namespaceId: string;
}): NodeJS.ProcessEnv {
  const companyModulePath = defaultCompanyModulePath(input.companyId);
  const companyDeploymentExport =
    process.env.RAG_COMPANY_DEPLOYMENT_EXPORT ??
    (input.companyId === "acme" ? "acmeSupportDeployment" : undefined);
  const companyUseCaseId =
    process.env.RAG_COMPANY_USE_CASE_ID ?? (input.companyId === "acme" ? "support" : undefined);

  return {
    ...process.env,
    RAG_HTTP_AUTH_MODE: process.env.RAG_HTTP_AUTH_MODE ?? "disabled",
    RAG_MODEL_PROVIDER: process.env.RAG_MODEL_PROVIDER ?? "json-chat",
    RAG_MODEL_MODEL_NAME: process.env.RAG_MODEL_MODEL_NAME ?? "sync-placeholder",
    RAG_MODEL_ENDPOINT:
      process.env.RAG_MODEL_ENDPOINT ?? "https://provider.example.invalid/v1/chat",
    RAG_MODEL_API_KEY: process.env.RAG_MODEL_API_KEY ?? "sync-placeholder",
    RAG_RERANK_PROVIDER: process.env.RAG_RERANK_PROVIDER ?? "json-chat",
    RAG_RERANK_MODEL_NAME: process.env.RAG_RERANK_MODEL_NAME ?? "rerank-placeholder",
    RAG_RERANK_ENDPOINT:
      process.env.RAG_RERANK_ENDPOINT ?? "https://provider.example.invalid/v1/rerank",
    RAG_RERANK_API_KEY: process.env.RAG_RERANK_API_KEY ?? "rerank-placeholder",
    RAG_APP_EMBEDDING_MODE: process.env.RAG_APP_EMBEDDING_MODE ?? "disabled",
    RAG_APP_VISUAL_EMBEDDING_MODE: process.env.RAG_APP_VISUAL_EMBEDDING_MODE ?? "disabled",
    RAG_APP_GROUNDING_JUDGE_MODE: process.env.RAG_APP_GROUNDING_JUDGE_MODE ?? "disabled",
    RAG_COMPANY_ID: process.env.RAG_COMPANY_ID ?? input.companyId,
    RAG_COMPANY_NAMESPACE_ID: process.env.RAG_COMPANY_NAMESPACE_ID ?? input.namespaceId,
    ...(companyModulePath === undefined ? {} : { RAG_COMPANY_MODULE_PATH: companyModulePath }),
    ...(companyDeploymentExport === undefined
      ? {}
      : { RAG_COMPANY_DEPLOYMENT_EXPORT: companyDeploymentExport }),
    ...(companyUseCaseId === undefined ? {} : { RAG_COMPANY_USE_CASE_ID: companyUseCaseId })
  };
}

function defaultCompanyModulePath(companyId: string): string | undefined {
  if (process.env.RAG_COMPANY_MODULE_PATH?.trim()) {
    return process.env.RAG_COMPANY_MODULE_PATH.trim();
  }
  if (companyId !== "acme") return undefined;

  const acmeExamplePath = path.join(
    /*turbopackIgnore: true*/ repoRoot(),
    "dist",
    "company",
    "examples",
    "acme-support.company.js"
  );
  return existsSync(/*turbopackIgnore: true*/ acmeExamplePath) ? acmeExamplePath : undefined;
}

async function fetchRagJson<T>(
  pathname: string,
  init: { readonly method?: "GET" | "POST"; readonly body?: string } = {}
): Promise<Availability<T>> {
  const url = `${ragBaseUrl()}${pathname}`;
  try {
    const response = await fetch(url, {
      method: init.method ?? "GET",
      cache: "no-store",
      headers: ragHttpHeaders(init.body !== undefined),
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(adminTimeoutMs())
    });
    const json = (await response.json()) as T;
    if (!response.ok) {
      return {
        status: "unavailable",
        error: safeResponseError(
          json,
          `RAG HTTP endpoint ${pathname} returned ${response.status}.`
        ),
        url
      };
    }
    return { status: "available", data: json, url };
  } catch (error) {
    return {
      status: "unavailable",
      error: safeErrorMessage(error, `RAG HTTP endpoint ${pathname} is unavailable.`),
      url
    };
  }
}

function ragHttpHeaders(hasBody: boolean): HeadersInit {
  const token = ragHttpAuthToken();
  return {
    ...(hasBody ? { "content-type": "application/json" } : {}),
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
  };
}

function ragHttpAuthToken(): string | undefined {
  const tokenEnv = process.env.RAG_ADMIN_RAG_AUTH_TOKEN_ENV;
  const tokenFromPointer = tokenEnv ? process.env[tokenEnv]?.trim() : undefined;
  const token = tokenFromPointer ?? process.env.RAG_ADMIN_RAG_AUTH_TOKEN?.trim();
  return token ? token : undefined;
}

async function runCliJson<T>(
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly allowNonZeroJson?: boolean;
    readonly errorFallback?: string;
  } = {}
): Promise<Availability<T>> {
  const root = repoRoot();
  const cliPath = ragCliPath(root);
  const command = [process.execPath, cliPath, ...args];

  if (!existsSync(/*turbopackIgnore: true*/ cliPath)) {
    return {
      status: "unavailable",
      error:
        "RAG service CLI has not been built yet. Run npm run build in the RAG repo before using CLI-backed admin views.",
      command
    };
  }

  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: root,
      env: options.env ?? process.env,
      timeout: adminTimeoutMs(),
      maxBuffer: 1024 * 1024 * 4
    });
    return {
      status: "available",
      data: JSON.parse(result.stdout) as T,
      command
    };
  } catch (error) {
    const data = options.allowNonZeroJson ? tryParseCliJson<T>(cliStdout(error)) : undefined;
    if (data !== undefined) {
      return {
        status: "available",
        data,
        error: safeErrorMessage(error, options.errorFallback ?? "RAG CLI command failed."),
        command
      };
    }
    return {
      status: "unavailable",
      error: safeErrorMessage(error, options.errorFallback ?? "RAG CLI inspection command failed."),
      command
    };
  }
}

function ragBaseUrl(): string {
  return (process.env.RAG_ADMIN_RAG_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
}

function repoRoot(): string {
  return resolveRagRepoRoot();
}

function ragCliPath(root: string): string {
  return path.resolve(
    /*turbopackIgnore: true*/
    process.env.RAG_ADMIN_CLI_PATH ??
      path.join(/*turbopackIgnore: true*/ root, "dist", "runtime", "production-cli.js")
  );
}

function adminTimeoutMs(): number {
  const configured = Number(process.env.RAG_ADMIN_TIMEOUT_MS ?? "12000");
  return Number.isFinite(configured) && configured > 0 ? configured : 12000;
}

function cliStdout(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("stdout" in error)) return undefined;
  const stdout = (error as { stdout?: unknown }).stdout;
  return typeof stdout === "string" ? stdout : undefined;
}

function tryParseCliJson<T>(value: string | undefined): T | undefined {
  if (!value?.trim()) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function safeErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim()) return redactedCliOutput(stderr);
  }
  if (typeof error === "object" && error !== null && "stdout" in error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === "string" && stdout.trim()) return redactedCliOutput(stdout);
  }
  if (error instanceof Error && error.message.trim()) {
    return redactOperationalText(error.message);
  }
  return fallback;
}

function safeResponseError(value: unknown, fallback: string): string {
  if (typeof value === "object" && value !== null && "error" in value) {
    const error = (value as { error?: { name?: unknown; message?: unknown } }).error;
    const message = typeof error?.message === "string" ? error.message : undefined;
    const name = typeof error?.name === "string" ? error.name : undefined;
    if (message) {
      return redactOperationalText(name ? `${name}: ${message}` : message);
    }
  }
  return fallback;
}

function redactedCliOutput(value: string): string {
  try {
    const parsed = JSON.parse(value) as { error?: { message?: string; name?: string } };
    if (parsed.error?.message) {
      return redactOperationalText(
        parsed.error.name ? `${parsed.error.name}: ${parsed.error.message}` : parsed.error.message
      );
    }
  } catch {
    return redactOperationalText(value);
  }
  return redactOperationalText(value);
}

function redactOperationalText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|secret|password)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgres://[redacted]@")
    .slice(0, 1200);
}

function displayPath(value: string): string {
  return value.replace(repoRoot(), ".");
}

function envList(key: string, fallback: readonly string[]): readonly string[] {
  const value = process.env[key]?.trim();
  if (!value) return fallback;
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length ? entries : fallback;
}

function safeCliId(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9_.:-]/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 96) || "id"
  );
}
