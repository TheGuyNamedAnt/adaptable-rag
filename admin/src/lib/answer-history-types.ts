import type { AdminAnswerResponse } from "@/lib/rag-answer-types";

export interface AdminAnswerRunSafeRequest {
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly principalNamespaceCount: number;
  readonly principalTeamCount: number;
  readonly principalRoleCount: number;
  readonly principalTagCount: number;
  readonly sourceFilterCount: number;
  readonly documentFilterCount: number;
  readonly chunkFilterCount: number;
  readonly topK?: number;
  readonly candidatePoolLimit?: number;
  readonly includeRejected: boolean;
}

export interface AdminAnswerRunSummary {
  readonly savedAt: string;
  readonly runId: string;
  readonly traceId: string;
  readonly status: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly tenantId: string;
  readonly questionHash: string;
  readonly retrievalMode?: string;
  readonly candidatePoolSize?: number;
  readonly returnedCount?: number;
  readonly retrievalRejectedCount?: number;
  readonly contextStatus?: string;
  readonly contextBlockCount?: number;
  readonly contextRejectedCount?: number;
  readonly finalCitationCount: number;
  readonly rejectedChunkCount: number;
  readonly eventCount: number;
  readonly hasAnswer: boolean;
  readonly answerRedacted: boolean;
  readonly hasEvidenceSummary: boolean;
  readonly evidenceSummaryRedacted: boolean;
}

export interface AdminAnswerRunDetail extends AdminAnswerRunSummary {
  readonly request: AdminAnswerRunSafeRequest;
  readonly response: AdminAnswerResponse;
  readonly rejectedEvidence: AdminRejectedEvidenceSummary;
}

export interface AdminAnswerRunList {
  readonly runs: readonly AdminAnswerRunSummary[];
  readonly page: {
    readonly limit: number;
    readonly offset: number;
    readonly hasMore: boolean;
    readonly total: number;
    readonly storageKind: AdminAnswerRunHistoryStorageKind;
  };
  readonly filters: AdminAnswerRunListFilter;
}

export type AdminAnswerRunHistoryStorageKind = "postgres" | "json_file";

export interface AdminAnswerRunListFilter {
  readonly status?: string;
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly runId?: string;
  readonly traceId?: string;
  readonly rejectionCode?: string;
  readonly from?: string;
  readonly to?: string;
}

export type AdminRejectedEvidenceStage = "retrieval" | "context" | "unknown";

export interface AdminRejectedEvidenceSummary {
  readonly totalRejectedChunkIds: number;
  readonly retrievalRejectedCount: number;
  readonly contextRejectedCount: number;
  readonly rejectionCodes: readonly string[];
  readonly items: readonly AdminRejectedEvidenceItem[];
}

export interface AdminRejectedEvidenceItem {
  readonly id: string;
  readonly stage: AdminRejectedEvidenceStage;
  readonly at?: string;
  readonly chunkId?: string;
  readonly documentId?: string;
  readonly code?: string;
  readonly message: string;
  readonly dataKeys: readonly string[];
}
