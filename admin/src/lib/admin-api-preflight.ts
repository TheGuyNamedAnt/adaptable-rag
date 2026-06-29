import "server-only";

import type { AdminGenerationPromotionRecord, ShellOverviewResult } from "@/lib/rag-admin-api";
import type { AdminAnswerRequest } from "@/lib/rag-answer-types";

export interface AdminPreflightFailure {
  readonly name: string;
  readonly code: string;
  readonly message: string;
  readonly actionHref?: string;
  readonly actionLabel?: string;
  readonly details?: Record<string, unknown>;
}

export interface AdminPreflightResult {
  readonly status: "passed" | "failed";
  readonly httpStatus: number;
  readonly failure?: AdminPreflightFailure;
  readonly details?: Record<string, unknown>;
}

export interface AdminUploadScopeInput {
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly userId?: string;
  readonly sourceId?: string;
}

export function adminPreflightErrorBody(failure: AdminPreflightFailure) {
  return {
    status: "rejected",
    error: {
      name: failure.name,
      message: failure.message,
      preflight: failure
    }
  };
}

export function answerPreflightFromShell(overview: ShellOverviewResult): AdminPreflightResult {
  const health = overview.health ?? overview.ready?.health;
  const serviceReady = overview.ready?.ready === true || health?.status === "ready";
  const documentCount = health?.index?.documentCount ?? 0;
  const chunkCount = health?.index?.chunkCount ?? 0;
  const details = {
    serviceStatus: overview.status,
    ready: overview.ready?.ready === true,
    healthStatus: health?.status ?? "unknown",
    documentCount,
    chunkCount,
    profileId: health?.profileId ?? "unknown",
    namespaceId: health?.namespaceId ?? "unknown"
  };

  if (!serviceReady) {
    return {
      status: "failed",
      httpStatus: 503,
      failure: {
        name: "RagServiceNotReady",
        code: "rag_service_not_ready",
        message: "Start the RAG service before running answer tests.",
        actionHref: "/storage",
        actionLabel: "Open Storage",
        details
      }
    };
  }

  if (documentCount <= 0 || chunkCount <= 0) {
    return {
      status: "failed",
      httpStatus: 409,
      failure: {
        name: "RagKnowledgeMissing",
        code: "rag_knowledge_missing",
        message: "Load knowledge before testing answers. The index has no documents or chunks.",
        actionHref: "/ingestion",
        actionLabel: "Add Knowledge",
        details
      }
    };
  }

  return {
    status: "passed",
    httpStatus: 200,
    details
  };
}

export function answerRequestPreflight(request: unknown): AdminPreflightFailure | undefined {
  const candidate =
    typeof request === "object" && request !== null ? (request as Partial<AdminAnswerRequest>) : {};
  const question =
    typeof candidate.question === "string" && candidate.question.trim()
      ? candidate.question.trim()
      : "";

  if (question) return undefined;

  return {
    name: "AnswerQuestionMissing",
    code: "answer_question_missing",
    message: "Enter a question before running an answer test.",
    actionHref: "/answer-lab",
    actionLabel: "Open Test Answer",
    details: {
      missingFields: ["question"]
    }
  };
}

export function uploadFilesPreflight(fileCount: number): AdminPreflightFailure | undefined {
  if (fileCount > 0) return undefined;

  return {
    name: "NoFilesUploaded",
    code: "upload_files_missing",
    message: "Choose files before uploading.",
    actionHref: "/ingestion",
    actionLabel: "Add Files",
    details: {
      fileCount
    }
  };
}

export function uploadScopePreflight(
  scope: AdminUploadScopeInput
): AdminPreflightFailure | undefined {
  const missing = [
    scope.tenantId?.trim() ? undefined : "tenant",
    scope.namespaceId?.trim() ? undefined : "namespace",
    scope.userId?.trim() ? undefined : "user",
    scope.sourceId?.trim() ? undefined : "source"
  ].filter((field): field is string => field !== undefined);

  if (missing.length === 0) return undefined;

  return {
    name: "UploadScopeIncomplete",
    code: "upload_scope_incomplete",
    message: `Complete upload scope before ingestion. Missing ${missing.join(", ")}.`,
    actionHref: "/ingestion",
    actionLabel: "Complete Scope",
    details: {
      missingFields: missing
    }
  };
}

export function invalidUploadScopePreflight(
  invalidFields: readonly string[]
): AdminPreflightFailure {
  return {
    name: "UploadScopeInvalid",
    code: "upload_scope_invalid",
    message: `Upload scope contains invalid identifiers: ${invalidFields.join(", ")}.`,
    actionHref: "/ingestion",
    actionLabel: "Fix Scope",
    details: {
      invalidFields
    }
  };
}

export function generationPromotionPreflight(
  promotion: AdminGenerationPromotionRecord
): AdminPreflightResult {
  const resultById = new Map(promotion.evalResults.map((result) => [result.evalId, result]));
  const failedEvalIds = promotion.requiredEvalIds.filter(
    (evalId) => resultById.get(evalId)?.status === "failed"
  );
  const missingEvalIds = promotion.requiredEvalIds.filter(
    (evalId) => resultById.get(evalId)?.status !== "passed"
  );
  const details = {
    promotionId: promotion.promotionId,
    status: promotion.status,
    tenantId: promotion.tenantId,
    namespaceId: promotion.namespaceId,
    candidateGenerationId: promotion.candidateGenerationId,
    requiredEvalIds: promotion.requiredEvalIds,
    failedEvalIds,
    missingEvalIds
  };

  if (promotion.status === "ready") {
    return {
      status: "passed",
      httpStatus: 200,
      details
    };
  }

  const message =
    failedEvalIds.length > 0
      ? `Promotion is blocked by failed evals: ${failedEvalIds.join(", ")}.`
      : missingEvalIds.length > 0
        ? `Promotion is blocked until required evals pass: ${missingEvalIds.join(", ")}.`
        : `Promotion status is ${promotion.status}; inspect the saved plan before promoting.`;

  return {
    status: "failed",
    httpStatus: 409,
    failure: {
      name: "GenerationPromotionNotReady",
      code: "generation_promotion_not_ready",
      message,
      actionHref: "/quality-ops",
      actionLabel: "Review Promotion",
      details
    }
  };
}
