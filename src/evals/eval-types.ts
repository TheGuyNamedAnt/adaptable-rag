import type { ContextEvidenceStatus, ContextRejectionCode } from "../context/context-types.js";
import type { CorpusRecord } from "../corpus/corpus-record.js";
import type { SourceKind } from "../documents/provenance.js";
import type { ChunkSafetyFlag } from "../documents/chunk.js";
import type { TrustTier } from "../documents/trust-tier.js";
import type { IndexFilter } from "../indexing/index-types.js";
import type { RagRunStatus } from "../observability/trace.js";
import type { RagRunTrace } from "../observability/trace.js";
import type { RetrievalMode } from "../retrieval/retrieval-types.js";
import type { AdaptiveRetrievalStrategy } from "../retrieval/retrieval-types.js";
import type {
  LocalEvalKnowledgeMapEntityFixture,
  LocalEvalKnowledgeMapFixture,
  LocalEvalKnowledgeMapRelationFixture
} from "../runtime/eval-knowledge-map.js";
import type { RequestPrincipal } from "../security/access-scope.js";

export const RUNTIME_EVAL_CHECKS = [
  "retrieval_recall",
  "citation_required",
  "refusal_when_unsupported",
  "access_boundary",
  "prompt_injection_resistance",
  "escalation_rule_match",
  "grounding_faithfulness",
  "redaction_required",
  "cost_budget",
  "visual_retrieval",
  "layout_relation_recall",
  "table_caption_preservation",
  "relationship_claim_grounding",
  "relationship_claim_not_grounded",
  "extraction_quality",
  "query_planning",
  "evidence_strategy"
] as const;

export type RuntimeEvalCheck = (typeof RUNTIME_EVAL_CHECKS)[number];
export type RagEvalCheck = RuntimeEvalCheck | string;
export type EvalRetrievalMode = "profile" | "keyword" | "visual";
export type EvalQueryIntentKind =
  | "general"
  | "definition"
  | "troubleshooting"
  | "comparison"
  | "policy"
  | "relationship"
  | "freshness"
  | "table"
  | "visual"
  | "procedural";
export type EvalQuerySourceHint =
  | "docs"
  | "support"
  | "tickets"
  | "incidents"
  | "tables"
  | "visuals"
  | "graph"
  | "recent";
export type EvalGraphQueryRoute = "none" | "graph_optional" | "graph_required";

export type EvalIndexFilterOverrides = Partial<
  Pick<
    IndexFilter,
    | "documentIds"
    | "chunkIds"
    | "sourceIds"
    | "sourceKinds"
    | "trustTiers"
    | "includeSafetyFlags"
    | "excludeSafetyFlags"
    | "accessTags"
    | "limit"
  >
>;

export interface RagEvalExpectation {
  readonly status?: RagRunStatus;
  readonly retrievedDocumentIds?: readonly string[];
  readonly notRetrievedDocumentIds?: readonly string[];
  readonly minimumRetrievedChunks?: number;
  readonly minimumCitations?: number;
  readonly requiredContextStatus?: ContextEvidenceStatus;
  readonly requiredRejectionCodes?: readonly ContextRejectionCode[];
  readonly minimumRedactions?: number;
  readonly redactedTextMustNotContain?: readonly string[];
  readonly requiredEscalationRuleIds?: readonly string[];
  readonly maximumEstimatedCostUsd?: number;
  readonly requiredRetrievalMode?: RetrievalMode;
  readonly minimumVisualCitations?: number;
  readonly requiredCitationLayoutRegionIds?: readonly string[];
  readonly requiredLayoutRelationIds?: readonly string[];
  readonly requiredRelationshipPaths?: readonly RagEvalRelationshipPathExpectation[];
  readonly forbiddenRelationshipPaths?: readonly RagEvalRelationshipPathExpectation[];
  readonly staleSourceRefusalExpected?: boolean;
  readonly requiredPrimaryIntent?: EvalQueryIntentKind;
  readonly requiredSecondaryIntents?: readonly EvalQueryIntentKind[];
  readonly requiredSourceHints?: readonly EvalQuerySourceHint[];
  readonly requiredGraphRoute?: EvalGraphQueryRoute;
  readonly requiredAdaptiveRetryStrategy?: AdaptiveRetrievalStrategy;
  readonly requiredAdaptiveDiagnosisCode?: string;
  readonly requiredFreshnessTraceApplied?: boolean;
  readonly minimumFreshnessBoostedCandidates?: number;
}

export interface RagEvalRelationshipPathExpectation {
  readonly depth?: number;
  readonly ordered?: boolean;
  readonly requireEdgeEvidence?: boolean;
  readonly edges: readonly RagEvalRelationshipEdgeExpectation[];
}

export interface RagEvalRelationshipEdgeExpectation {
  readonly relationType?: string;
  readonly fromEntityId?: string;
  readonly toEntityId?: string;
  readonly fromName?: string;
  readonly toName?: string;
}

export interface RagEvalModelOptions {
  readonly estimatedCostUsd?: number;
  readonly citationDocumentIds?: readonly string[];
  readonly answer?: string;
  readonly evidenceSummary?: string;
}

export interface RagEvalExtractionFixture {
  readonly ontology?: LocalEvalKnowledgeMapFixture["ontology"];
  readonly expectedEntities: readonly RagEvalKnowledgeMapEntityFixture[];
  readonly expectedRelations: readonly RagEvalKnowledgeMapRelationFixture[];
  readonly actualEntities?: readonly RagEvalKnowledgeMapEntityFixture[];
  readonly actualRelations?: readonly RagEvalKnowledgeMapRelationFixture[];
  readonly forbiddenRelations?: readonly RagEvalRelationshipEdgeExpectation[];
  readonly minimumEntityRecall?: number;
  readonly minimumRelationRecall?: number;
  readonly maximumExtraEntities?: number;
  readonly maximumExtraRelations?: number;
}

export interface RagEvalCase {
  readonly id: string;
  readonly description?: string;
  readonly checks: readonly RagEvalCheck[];
  readonly query: string;
  readonly principal: RequestPrincipal;
  readonly corpus: readonly CorpusRecord[];
  readonly knowledgeMap?: RagEvalKnowledgeMapFixture;
  readonly extraction?: RagEvalExtractionFixture;
  readonly expect: RagEvalExpectation;
  readonly retrievalMode?: EvalRetrievalMode;
  readonly topK?: number;
  readonly filter?: EvalIndexFilterOverrides;
  readonly model?: RagEvalModelOptions;
}

export type RagEvalKnowledgeMapFixture = LocalEvalKnowledgeMapFixture;
export type RagEvalKnowledgeMapEntityFixture = LocalEvalKnowledgeMapEntityFixture;
export type RagEvalKnowledgeMapRelationFixture = LocalEvalKnowledgeMapRelationFixture;

export type RagEvalSetKind = "golden" | "adversarial";

export interface LoadedRagEvalCase extends RagEvalCase {
  readonly filePath: string;
  readonly lineNumber: number;
  readonly setKind: RagEvalSetKind;
}

export interface RagEvalCaseResult {
  readonly id: string;
  readonly setKind: RagEvalSetKind;
  readonly checks: readonly RagEvalCheck[];
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly status?: RagRunStatus;
  readonly contextStatus?: ContextEvidenceStatus;
  readonly retrievalMode?: RetrievalMode;
  readonly retrievedDocumentIds: readonly string[];
  readonly finalCitationCount: number;
  readonly visualCitationCount?: number;
  readonly traceId?: string;
  readonly trace?: RagRunTrace;
  readonly metrics?: RagEvalCaseMetrics;
}

export interface RagEvalCaseMetrics {
  readonly recallAtK?: number;
  readonly mrr?: number;
  readonly citationPrecision?: number;
  readonly citationRecall?: number;
  readonly refusalCorrectness?: boolean;
  readonly accessBoundaryCorrectness?: boolean;
  readonly staleSourceRefusal?: boolean;
  readonly parserQualityImpact?: number;
  readonly graphPathGrounding?: number;
  readonly latencyMs?: number;
  readonly estimatedCostUsd?: number;
}

export interface RagEvalSuiteResult {
  readonly profileId: string;
  readonly namespaceId: string;
  readonly passed: boolean;
  readonly goldenSetPath: string;
  readonly adversarialSetPath: string;
  readonly requiredChecks: readonly string[];
  readonly coveredChecks: readonly string[];
  readonly missingRequiredChecks: readonly string[];
  readonly caseCount: number;
  readonly failures: readonly string[];
  readonly cases: readonly RagEvalCaseResult[];
}

export interface RagEvalRunSummary {
  readonly passed: boolean;
  readonly suiteCount: number;
  readonly caseCount: number;
  readonly failures: readonly string[];
  readonly suites: readonly RagEvalSuiteResult[];
}

export type EvalJsonSourceKind = SourceKind;
export type EvalJsonTrustTier = TrustTier;
export type EvalJsonChunkSafetyFlag = ChunkSafetyFlag;
