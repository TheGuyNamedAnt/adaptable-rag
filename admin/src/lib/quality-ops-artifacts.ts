import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveRagRepoRoot } from "@/lib/repo-root";

export interface ParserBenchmarkArtifact {
  readonly dataset?: string;
  readonly status?: string;
  readonly caseCount?: number;
  readonly passedCount?: number;
  readonly failedCount?: number;
  readonly averageTextSimilarity?: number;
  readonly averageLayoutRecall?: number;
  readonly averageTableRecall?: number;
  readonly averageFormulaRecall?: number;
  readonly averageReadingOrderScore?: number;
  readonly cases?: readonly ParserBenchmarkCaseArtifact[];
}

export interface ParserBenchmarkCaseArtifact {
  readonly caseId?: string;
  readonly status?: string;
  readonly textSimilarity?: number;
  readonly layoutRecall?: number;
  readonly tableRecall?: number;
  readonly formulaRecall?: number;
  readonly readingOrderScore?: number;
  readonly warnings?: readonly string[];
}

export interface DocumentQaBenchmarkArtifact {
  readonly benchmarkMode?: string;
  readonly dataset?: string;
  readonly status?: string;
  readonly caseCount?: number;
  readonly passedCount?: number;
  readonly failedCount?: number;
  readonly answerFoundCount?: number;
  readonly averageBestAnswerSimilarity?: number;
  readonly averageBestAnlsScore?: number;
  readonly relaxedAccuracy?: number;
  readonly ragMetrics?: {
    readonly parserFailureCount?: number;
    readonly ingestionFailureCount?: number;
    readonly retrievalFailureCount?: number;
    readonly citationFailureCount?: number;
    readonly answerGenerationFailureCount?: number;
    readonly answerMatchCount?: number;
    readonly citationCorrectCount?: number;
    readonly averageRetrievedChunkCount?: number;
  };
  readonly cases?: readonly DocumentQaBenchmarkCaseArtifact[];
}

export interface DocumentQaBenchmarkCaseArtifact {
  readonly caseId?: string;
  readonly status?: string;
  readonly failureStage?: string;
  readonly question?: string;
  readonly answerFoundInParsedText?: boolean;
  readonly answerMatch?: boolean;
  readonly citationCorrect?: boolean;
  readonly bestAnswerSimilarity?: number;
  readonly bestAnlsScore?: number;
  readonly warnings?: readonly string[];
}

export interface ParserExtractionAuditArtifact {
  readonly status?: string;
  readonly generatedAt?: string;
  readonly sourceId?: string;
  readonly acceptedDocumentCount?: number;
  readonly rejectedRecordCount?: number;
  readonly adapterWarningCount?: number;
  readonly normalizationIssueCount?: number;
  readonly extractionAudit?: {
    readonly status?: string;
    readonly summary?: Record<string, unknown>;
  };
  readonly searchability?: {
    readonly passed?: number;
    readonly failed?: number;
    readonly queries?: number;
  };
}

export interface ParserQualityArtifact {
  readonly status?: string;
  readonly generatedAt?: string;
  readonly sourcesPath?: string;
  readonly sourceId?: string;
  readonly loadedRecordCount?: number;
  readonly acceptedDocumentCount?: number;
  readonly rejectedRecordCount?: number;
  readonly adapterWarningCount?: number;
  readonly normalizationIssueCount?: number;
  readonly parserQuality?: {
    readonly documentCount?: number;
    readonly tracedDocumentCount?: number;
    readonly untracedDocumentCount?: number;
    readonly averageSelectedScore?: number;
    readonly lowScoreDocumentCount?: number;
    readonly failedResultSelectedCount?: number;
    readonly fallbackSelectedCount?: number;
    readonly failedAttemptCount?: number;
    readonly rejectedAttemptCount?: number;
    readonly skippedCandidateCount?: number;
    readonly tableStructureMissingCount?: number;
    readonly visualAssetsMissingCount?: number;
    readonly layoutMissingForComplexDocumentCount?: number;
    readonly markdownSelectedForLayoutRiskCount?: number;
    readonly warningCount?: number;
    readonly readiness?: {
      readonly status?: string;
      readonly tracedDocumentCount?: number;
      readonly minimumTracedDocumentsForTesting?: number;
      readonly recommendedTracedDocumentsForBaseline?: number;
      readonly message?: string;
    };
  };
  readonly parserQualityWarnings?: readonly ParserQualityWarningArtifact[];
  readonly fileTypes?: readonly ParserQualityFileTypeArtifact[];
}

export interface ParserQualityWarningArtifact {
  readonly documentId?: string;
  readonly sourceId?: string;
  readonly code?: string;
  readonly message?: string;
}

export interface ParserQualityFileTypeArtifact {
  readonly extension?: string;
  readonly contentType?: string;
  readonly documentCount?: number;
  readonly tracedDocumentCount?: number;
  readonly averageSelectedScore?: number;
  readonly lowScoreDocumentCount?: number;
  readonly fallbackSelectedCount?: number;
  readonly failedAttemptCount?: number;
  readonly rejectedAttemptCount?: number;
  readonly selectedParsers?: Record<string, number | undefined>;
}

export interface IngestionIntegrityArtifact {
  readonly status?: string;
  readonly generatedAt?: string;
  readonly sourceId?: string;
  readonly runId?: string;
  readonly counts?: {
    readonly loadedSourceCount?: number;
    readonly acceptedDocumentCount?: number;
    readonly acceptedChunkCount?: number;
    readonly rejectedRecordCount?: number;
    readonly adapterWarningCount?: number;
    readonly normalizationIssueCount?: number;
    readonly parserQualityWarningCount?: number;
    readonly searchableArtifactWarningCount?: number;
    readonly chunkingWarningCount?: number;
  };
  readonly integrity?: {
    readonly status?: string;
    readonly errorCount?: number;
    readonly warningCount?: number;
    readonly issueCount?: number;
    readonly counts?: Record<string, number | undefined>;
    readonly searchableUnitCounts?: Record<string, number | undefined>;
    readonly issues?: readonly IngestionIntegrityIssueArtifact[];
  };
}

export interface IngestionIntegrityIssueArtifact {
  readonly severity?: string;
  readonly code?: string;
  readonly documentId?: string;
  readonly chunkId?: string;
  readonly sourceId?: string;
  readonly pageNumber?: number;
  readonly message?: string;
}

export interface EmbeddingMigrationArtifact {
  readonly status?: string;
  readonly baselineGeneratedAt?: string;
  readonly candidateGeneratedAt?: string;
  readonly thresholds?: Record<string, number | undefined>;
  readonly deltas?: readonly EmbeddingMigrationDeltaArtifact[];
  readonly failures?: readonly string[];
}

export interface EmbeddingMigrationDeltaArtifact {
  readonly metric?: string;
  readonly baseline?: number;
  readonly candidate?: number;
  readonly change?: number;
}

export interface ProviderSmokeArtifact {
  readonly status?: string;
  readonly runId?: string;
  readonly checkedAt?: string;
  readonly profileId?: string;
  readonly namespaceId?: string;
  readonly retrievalMode?: string;
  readonly requiredProviders?: readonly string[];
  readonly summary?: {
    readonly requiredProviderCount?: number;
    readonly passedRequiredProviderCount?: number;
    readonly failedRequiredProviderCount?: number;
    readonly providerProbeCheckCount?: number;
    readonly failedProviderProbeCheckCount?: number;
    readonly skippedProviderProbeCheckCount?: number;
  };
  readonly failures?: readonly string[];
  readonly warnings?: readonly string[];
  readonly providerCoverage?: readonly ProviderSmokeCoverageArtifact[];
  readonly selfTest?: {
    readonly status?: string;
    readonly failedCount?: number;
    readonly warningCount?: number;
    readonly checks?: readonly ProviderSmokeSelfTestCheckArtifact[];
  };
}

export interface ProviderSmokeCoverageArtifact {
  readonly provider?: string;
  readonly required?: boolean;
  readonly status?: string;
  readonly checkIds?: readonly string[];
  readonly failedCheckIds?: readonly string[];
  readonly skippedCheckIds?: readonly string[];
  readonly warnings?: readonly string[];
}

export interface ProviderSmokeSelfTestCheckArtifact {
  readonly id?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly provider?: string;
  readonly modelName?: string;
  readonly message?: string;
}

export interface VectorCleanupArtifact {
  readonly mode?: string;
  readonly snapshotPath?: string;
  readonly keepEmbeddingConfigHashes?: readonly string[];
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly inventory?: readonly VectorCleanupInventoryArtifact[];
  readonly deleteVectorIds?: readonly string[];
  readonly deleteCount?: number;
  readonly keepCount?: number;
}

export interface VectorCleanupInventoryArtifact {
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly embeddingProvider?: string;
  readonly embeddingModel?: string;
  readonly embeddingConfigHash?: string;
  readonly embeddingIndexConfigHash?: string;
  readonly vectorCount?: number;
  readonly documentCount?: number;
}

export interface QualityOpsArtifacts {
  readonly generatedAt: string;
  readonly paths: QualityOpsArtifactPaths;
  readonly artifactStates: Readonly<
    Record<keyof QualityOpsArtifactPaths, QualityOpsArtifactReadState>
  >;
  readonly parserBenchmark?: ParserBenchmarkArtifact;
  readonly documentQaBenchmark?: DocumentQaBenchmarkArtifact;
  readonly parserExtractionAudit?: ParserExtractionAuditArtifact;
  readonly parserQuality?: ParserQualityArtifact;
  readonly ingestionIntegrity?: IngestionIntegrityArtifact;
  readonly embeddingMigration?: EmbeddingMigrationArtifact;
  readonly providerSmoke?: ProviderSmokeArtifact;
  readonly vectorCleanup?: VectorCleanupArtifact;
}

export interface QualityOpsArtifactReadState {
  readonly label: string;
  readonly path: string;
  readonly status: "available" | "missing" | "invalid";
  readonly error?: string;
}

export interface QualityOpsArtifactPaths {
  readonly parserBenchmark: string;
  readonly documentQaBenchmark: string;
  readonly parserExtractionAudit: string;
  readonly parserQuality: string;
  readonly ingestionIntegrity: string;
  readonly embeddingMigration: string;
  readonly providerSmoke: string;
  readonly vectorCleanup: string;
}

export async function getQualityOpsArtifacts(): Promise<QualityOpsArtifacts> {
  const paths = artifactPaths();
  const [
    parserBenchmarkResult,
    documentQaBenchmarkResult,
    parserExtractionAuditResult,
    parserQualityResult,
    ingestionIntegrityResult,
    embeddingMigrationResult,
    providerSmokeResult,
    vectorCleanupResult
  ] = await Promise.all([
    readJson<ParserBenchmarkArtifact>("Parser benchmark", paths.parserBenchmark),
    readJson<DocumentQaBenchmarkArtifact>("Document QA benchmark", paths.documentQaBenchmark),
    readJson<ParserExtractionAuditArtifact>("Parser extraction audit", paths.parserExtractionAudit),
    readJson<ParserQualityArtifact>("Parser quality", paths.parserQuality),
    readJson<IngestionIntegrityArtifact>("Ingestion integrity", paths.ingestionIntegrity),
    readJson<EmbeddingMigrationArtifact>("Embedding migration", paths.embeddingMigration),
    readJson<ProviderSmokeArtifact>("Provider smoke", paths.providerSmoke),
    readJson<VectorCleanupArtifact>("Vector cleanup", paths.vectorCleanup)
  ]);

  return {
    generatedAt: new Date().toISOString(),
    paths,
    artifactStates: {
      parserBenchmark: parserBenchmarkResult.state,
      documentQaBenchmark: documentQaBenchmarkResult.state,
      parserExtractionAudit: parserExtractionAuditResult.state,
      parserQuality: parserQualityResult.state,
      ingestionIntegrity: ingestionIntegrityResult.state,
      embeddingMigration: embeddingMigrationResult.state,
      providerSmoke: providerSmokeResult.state,
      vectorCleanup: vectorCleanupResult.state
    },
    ...(parserBenchmarkResult.value === undefined
      ? {}
      : { parserBenchmark: parserBenchmarkResult.value }),
    ...(documentQaBenchmarkResult.value === undefined
      ? {}
      : { documentQaBenchmark: documentQaBenchmarkResult.value }),
    ...(parserExtractionAuditResult.value === undefined
      ? {}
      : { parserExtractionAudit: parserExtractionAuditResult.value }),
    ...(parserQualityResult.value === undefined
      ? {}
      : { parserQuality: parserQualityResult.value }),
    ...(ingestionIntegrityResult.value === undefined
      ? {}
      : { ingestionIntegrity: ingestionIntegrityResult.value }),
    ...(embeddingMigrationResult.value === undefined
      ? {}
      : { embeddingMigration: embeddingMigrationResult.value }),
    ...(providerSmokeResult.value === undefined
      ? {}
      : { providerSmoke: providerSmokeResult.value }),
    ...(vectorCleanupResult.value === undefined ? {} : { vectorCleanup: vectorCleanupResult.value })
  };
}

async function readJson<T>(
  label: string,
  filePath: string
): Promise<{ readonly state: QualityOpsArtifactReadState; readonly value?: T }> {
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

function artifactPaths(): QualityOpsArtifactPaths {
  const root = repoRoot();
  return {
    parserBenchmark:
      process.env.RAG_ADMIN_PARSER_BENCHMARK_REPORT ??
      path.join(
        /*turbopackIgnore: true*/ root,
        ".rag",
        "parser-benchmarks",
        "latest",
        "parser-benchmark.json"
      ),
    documentQaBenchmark:
      process.env.RAG_ADMIN_DOCUMENT_QA_BENCHMARK_REPORT ??
      path.join(
        /*turbopackIgnore: true*/ root,
        ".rag",
        "document-qa-benchmarks",
        "latest",
        "document-qa-benchmark.json"
      ),
    parserExtractionAudit:
      process.env.RAG_ADMIN_PARSER_EXTRACTION_AUDIT_REPORT ??
      path.join(
        /*turbopackIgnore: true*/ root,
        ".rag",
        "parser-extraction-audit",
        "latest",
        "parser-extraction-audit-summary.json"
      ),
    parserQuality:
      process.env.RAG_ADMIN_PARSER_QUALITY_REPORT ??
      path.join(
        /*turbopackIgnore: true*/ root,
        ".rag",
        "parser-quality",
        "latest",
        "parser-quality.json"
      ),
    ingestionIntegrity:
      process.env.RAG_ADMIN_INGESTION_INTEGRITY_REPORT ??
      path.join(
        /*turbopackIgnore: true*/ root,
        ".rag",
        "ingestion-integrity",
        "latest",
        "ingestion-integrity.json"
      ),
    embeddingMigration:
      process.env.RAG_ADMIN_EMBEDDING_MIGRATION_REPORT ??
      path.join(/*turbopackIgnore: true*/ root, ".rag", "embedding-migration", "report.json"),
    providerSmoke:
      process.env.RAG_ADMIN_PROVIDER_SMOKE_REPORT ??
      path.join(/*turbopackIgnore: true*/ root, ".rag", "provider-smoke", "latest", "smoke.json"),
    vectorCleanup:
      process.env.RAG_ADMIN_VECTOR_CLEANUP_PLAN ??
      path.join(/*turbopackIgnore: true*/ root, ".rag", "vector-cleanup", "plan.json")
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
