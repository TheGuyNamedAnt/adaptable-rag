import type { TrustPolicy, TrustTier } from "../documents/trust-tier.js";
import type { SourceKind } from "../documents/provenance.js";

export type RetrievalMode = "keyword" | "vector" | "hybrid" | "visual";

export type RerankMode = "none" | "lightweight" | "model";

export type ModelRole =
  | "query_planning"
  | "context_evaluation"
  | "answer_generation"
  | "grounding_judge"
  | "redaction";

export type ModelTier = "fast" | "balanced" | "strong" | "judge";

export type OutputMode =
  | "sourced_answer"
  | "support_triage"
  | "diligence_finding"
  | "code_investigation";

export type FreshnessMode = "none" | "latest_wins" | "as_of_date" | "versioned";

export type PiiClass =
  | "email"
  | "phone"
  | "user_id"
  | "payment"
  | "auth_secret"
  | "health"
  | "free_text_sensitive";

export type ActionMode = "answer_only" | "draft_only" | "human_approval_required";

export type ObservabilityLevel = "standard" | "debug";

export type MemoryMode = "disabled" | "session" | "long_term";

export type PromptInjectionScanMode = "standard" | "strict";

export interface CorpusSourceConfig {
  readonly id: string;
  readonly adapter: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly trustTierOverride?: TrustTier;
  readonly trustTierFloor?: TrustTier;
  readonly tags?: readonly string[];
}

export interface CitationPolicy {
  readonly requireCitations: boolean;
  readonly minimumCitationsForAnswer: number;
  readonly minimumTrustedCitations: number;
  readonly allowUncitedSummary: boolean;
  readonly requireExactChunkCitations: boolean;
  readonly allowedSourceKindsForCitations: readonly SourceKind[];
}

export interface RefusalPolicy {
  readonly refuseWhenNoEvidence: boolean;
  readonly refuseWhenOnlyUntrustedEvidence: boolean;
  readonly refusalMessage: string;
}

export interface EscalationRule {
  readonly id: string;
  readonly description: string;
  readonly trigger: string;
  readonly destination: string;
}

export interface ModelPolicy {
  readonly allowedTiers: readonly ModelTier[];
  readonly defaultTierByRole: Readonly<Record<ModelRole, ModelTier>>;
  readonly requireEvidenceForGeneration: boolean;
  readonly allowModelFallback: boolean;
}

export interface ContextBudget {
  readonly maxContextTokens: number;
  readonly maxContextChunks: number;
  readonly reserveOutputTokens: number;
  readonly preferTrustedSources: boolean;
  readonly preferRecentSources: boolean;
  readonly isolateSourceDocuments: boolean;
}

export interface FreshnessPolicy {
  readonly mode: FreshnessMode;
  readonly maxSourceAgeDays?: number;
  readonly requireCapturedAt: boolean;
}

export interface RedactionPolicy {
  readonly redactBeforeLogging: boolean;
  readonly redactBeforeGeneration: boolean;
  readonly piiClasses: readonly PiiClass[];
  readonly blockedSecretPatterns: readonly string[];
}

export interface OutputContract {
  readonly mode: OutputMode;
  readonly schemaName: string;
  readonly requireStructuredOutput: boolean;
  readonly includeEvidenceSummary: boolean;
}

export interface ActionPolicy {
  readonly mode: ActionMode;
  readonly allowedActions: readonly string[];
  readonly requireApprovalFor: readonly string[];
}

export interface CostLatencyBudget {
  readonly maxRetrievalCalls: number;
  readonly maxModelCalls: number;
  readonly maxRuntimeMs: number;
  readonly maxEstimatedCostUsd: number;
}

export interface SecurityPolicy {
  readonly treatRetrievedTextAsUntrustedInstructions: boolean;
  readonly promptInjectionScanning: PromptInjectionScanMode;
  readonly isolateRetrievedSources: boolean;
  readonly blockRawVectorAccess: boolean;
}

export interface ObservabilityPolicy {
  readonly level: ObservabilityLevel;
  readonly includeRetrievedTextInLogs: boolean;
  readonly includeRejectedChunksInTrace: boolean;
  readonly redactTracePayloads: boolean;
}

export interface MemoryPolicy {
  readonly mode: MemoryMode;
  readonly persistRetrievedFacts: boolean;
  readonly requireHumanReviewForLongTermWrites: boolean;
}

export interface RagProfile {
  readonly id: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly purpose: string;
  readonly outputMode: OutputMode;
  readonly modelPolicy: ModelPolicy;
  readonly corpusSources: readonly CorpusSourceConfig[];
  readonly retrieval: {
    readonly mode: RetrievalMode;
    readonly maxChunks: number;
    readonly allowQueryRewrite: boolean;
    readonly allowParallelQueries: boolean;
    readonly rerankMode: RerankMode;
    readonly preferSourceTags?: readonly string[];
    readonly avoidSourceTagsUnlessNeeded?: readonly string[];
  };
  readonly contextBudget: ContextBudget;
  readonly freshnessPolicy: FreshnessPolicy;
  readonly trustPolicy: TrustPolicy;
  readonly citationPolicy: CitationPolicy;
  readonly refusalPolicy: RefusalPolicy;
  readonly redactionPolicy: RedactionPolicy;
  readonly outputContract: OutputContract;
  readonly actionPolicy: ActionPolicy;
  readonly costLatencyBudget: CostLatencyBudget;
  readonly securityPolicy: SecurityPolicy;
  readonly observabilityPolicy: ObservabilityPolicy;
  readonly memoryPolicy: MemoryPolicy;
  readonly escalationRules: readonly EscalationRule[];
  readonly evals: {
    readonly goldenSetPath: string;
    readonly adversarialSetPath: string;
    readonly requiredChecks: readonly string[];
  };
}
