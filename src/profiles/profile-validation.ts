import { HIGH_RISK_TRUST_TIERS, TRUST_TIERS, type TrustTier } from "../documents/trust-tier.js";
import type { EscalationRule, ModelRole, RagProfile } from "./profile.js";
import {
  isImplementedRerankMode,
  isImplementedRetrievalMode
} from "../shared/engine-capabilities.js";

declare const VALIDATED_RAG_PROFILE_BRAND: unique symbol;

export type ValidatedRagProfile = RagProfile & {
  readonly [VALIDATED_RAG_PROFILE_BRAND]: true;
};

export type ProfileValidationSeverity = "error" | "warning";

export type ProfileValidationCode =
  | "missing_profile_identity"
  | "missing_enabled_corpus"
  | "duplicate_corpus_source"
  | "invalid_corpus_source"
  | "unsafe_model_policy"
  | "unsupported_retrieval_mode"
  | "invalid_retrieval_budget"
  | "invalid_context_budget"
  | "unsafe_freshness_policy"
  | "unsafe_citation_policy"
  | "unsafe_refusal_policy"
  | "unsafe_trust_policy"
  | "unsafe_redaction_policy"
  | "unsafe_output_contract"
  | "unsafe_action_policy"
  | "invalid_cost_latency_budget"
  | "unsafe_security_policy"
  | "unsafe_observability_policy"
  | "unsafe_memory_policy"
  | "missing_eval_check"
  | "invalid_escalation_rule";

export interface ProfileValidationIssue {
  readonly severity: ProfileValidationSeverity;
  readonly code: ProfileValidationCode;
  readonly path: string;
  readonly message: string;
}

export interface ProfileValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ProfileValidationIssue[];
  readonly errors: readonly ProfileValidationIssue[];
  readonly warnings: readonly ProfileValidationIssue[];
}

export const REQUIRED_EVAL_CHECKS = [
  "retrieval_recall",
  "citation_required",
  "refusal_when_unsupported",
  "access_boundary",
  "prompt_injection_resistance"
] as const;

const MAX_CHUNKS_LIMIT = 30;
const MAX_CONTEXT_TOKENS_LIMIT = 120_000;
const MAX_MODEL_CALLS_LIMIT = 30;
const MAX_RETRIEVAL_CALLS_LIMIT = 50;
const REQUIRED_MODEL_ROLES = [
  "query_planning",
  "context_evaluation",
  "answer_generation",
  "grounding_judge",
  "redaction"
] as const satisfies readonly ModelRole[];

export function validateProfile(profile: RagProfile): ProfileValidationResult {
  const issues: ProfileValidationIssue[] = [];

  validateIdentity(profile, issues);
  validateModelPolicy(profile, issues);
  validateCorpusSources(profile, issues);
  validateRetrieval(profile, issues);
  validateContextBudget(profile, issues);
  validateFreshnessPolicy(profile, issues);
  validateCitationPolicy(profile, issues);
  validateRefusalPolicy(profile, issues);
  validateTrustPolicy(profile, issues);
  validateRedactionPolicy(profile, issues);
  validateOutputContract(profile, issues);
  validateActionPolicy(profile, issues);
  validateCostLatencyBudget(profile, issues);
  validateSecurityPolicy(profile, issues);
  validateObservabilityPolicy(profile, issues);
  validateMemoryPolicy(profile, issues);
  validateEvals(profile, issues);
  validateEscalationRules(profile.escalationRules, issues);

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");

  return {
    valid: errors.length === 0,
    issues,
    errors,
    warnings
  };
}

export function assertValidProfile(profile: RagProfile): ValidatedRagProfile {
  const result = validateProfile(profile);

  if (!result.valid) {
    const details = result.errors.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
    throw new Error(`Invalid RAG profile "${profile.id}":\n${details}`);
  }

  return profile as ValidatedRagProfile;
}

function validateIdentity(profile: RagProfile, issues: ProfileValidationIssue[]): void {
  if (
    !profile.id.trim() ||
    !profile.namespaceId.trim() ||
    !profile.name.trim() ||
    !profile.purpose.trim()
  ) {
    issues.push({
      severity: "error",
      code: "missing_profile_identity",
      path: "profile",
      message: "Profile id, namespaceId, name, and purpose are required."
    });
  }
}

function validateCorpusSources(profile: RagProfile, issues: ProfileValidationIssue[]): void {
  const enabledSources = profile.corpusSources.filter((source) => source.enabled);
  if (enabledSources.length === 0) {
    issues.push({
      severity: "error",
      code: "missing_enabled_corpus",
      path: "corpusSources",
      message: "At least one corpus source must be enabled."
    });
  }

  const seenSourceIds = new Set<string>();
  for (const [index, source] of profile.corpusSources.entries()) {
    const path = `corpusSources[${index}]`;
    if (!source.id.trim() || !source.adapter.trim() || !source.description.trim()) {
      issues.push({
        severity: "error",
        code: "invalid_corpus_source",
        path,
        message: "Corpus source id, adapter, and description are required."
      });
    }

    if (seenSourceIds.has(source.id)) {
      issues.push({
        severity: "error",
        code: "duplicate_corpus_source",
        path: `${path}.id`,
        message: `Duplicate corpus source id "${source.id}".`
      });
    }
    seenSourceIds.add(source.id);

    if (source.trustTierOverride && !isKnownTrustTier(source.trustTierOverride)) {
      issues.push({
        severity: "error",
        code: "invalid_corpus_source",
        path: `${path}.trustTierOverride`,
        message: `Unknown trust tier "${source.trustTierOverride}".`
      });
    }

    if (source.trustTierFloor && !isKnownTrustTier(source.trustTierFloor)) {
      issues.push({
        severity: "error",
        code: "invalid_corpus_source",
        path: `${path}.trustTierFloor`,
        message: `Unknown trust tier "${source.trustTierFloor}".`
      });
    }
  }
}

function validateModelPolicy(profile: RagProfile, issues: ProfileValidationIssue[]): void {
  if (profile.modelPolicy.allowedTiers.length === 0) {
    issues.push({
      severity: "error",
      code: "unsafe_model_policy",
      path: "modelPolicy.allowedTiers",
      message: "At least one model tier must be allowed."
    });
  }

  if (!profile.modelPolicy.requireEvidenceForGeneration) {
    issues.push({
      severity: "error",
      code: "unsafe_model_policy",
      path: "modelPolicy.requireEvidenceForGeneration",
      message: "Answer generation must require evidence."
    });
  }

  for (const role of REQUIRED_MODEL_ROLES) {
    const tier = profile.modelPolicy.defaultTierByRole[role];
    if (!profile.modelPolicy.allowedTiers.includes(tier)) {
      issues.push({
        severity: "error",
        code: "unsafe_model_policy",
        path: `modelPolicy.defaultTierByRole.${role}`,
        message: `Default tier "${tier}" for role "${role}" is not in allowedTiers.`
      });
    }
  }
}

function validateRetrieval(profile: RagProfile, issues: ProfileValidationIssue[]): void {
  if (!isImplementedRetrievalMode(profile.retrieval.mode)) {
    issues.push({
      severity: "error",
      code: "unsupported_retrieval_mode",
      path: "retrieval.mode",
      message: `Retrieval mode "${profile.retrieval.mode}" is not implemented by this engine.`
    });
  }

  if (!isImplementedRerankMode(profile.retrieval.rerankMode)) {
    issues.push({
      severity: "error",
      code: "unsupported_retrieval_mode",
      path: "retrieval.rerankMode",
      message: `Rerank mode "${profile.retrieval.rerankMode}" is not implemented by this engine.`
    });
  }

  if (profile.retrieval.maxChunks < 1 || profile.retrieval.maxChunks > MAX_CHUNKS_LIMIT) {
    issues.push({
      severity: "error",
      code: "invalid_retrieval_budget",
      path: "retrieval.maxChunks",
      message: `maxChunks must be between 1 and ${MAX_CHUNKS_LIMIT}.`
    });
  }
}

function validateContextBudget(profile: RagProfile, issues: ProfileValidationIssue[]): void {
  if (
    profile.contextBudget.maxContextTokens < 1_000 ||
    profile.contextBudget.maxContextTokens > MAX_CONTEXT_TOKENS_LIMIT
  ) {
    issues.push({
      severity: "error",
      code: "invalid_context_budget",
      path: "contextBudget.maxContextTokens",
      message: `maxContextTokens must be between 1000 and ${MAX_CONTEXT_TOKENS_LIMIT}.`
    });
  }

  if (
    profile.contextBudget.maxContextChunks < 1 ||
    profile.contextBudget.maxContextChunks > profile.retrieval.maxChunks
  ) {
    issues.push({
      severity: "error",
      code: "invalid_context_budget",
      path: "contextBudget.maxContextChunks",
      message: "maxContextChunks must be at least 1 and no greater than retrieval.maxChunks."
    });
  }

  if (profile.contextBudget.reserveOutputTokens < 256) {
    issues.push({
      severity: "error",
      code: "invalid_context_budget",
      path: "contextBudget.reserveOutputTokens",
      message: "reserveOutputTokens must leave enough space for a useful answer."
    });
  }

  if (!profile.contextBudget.preferTrustedSources) {
    issues.push({
      severity: "warning",
      code: "invalid_context_budget",
      path: "contextBudget.preferTrustedSources",
      message: "Production profiles should prefer trusted sources in context selection."
    });
  }

  if (!profile.contextBudget.isolateSourceDocuments) {
    issues.push({
      severity: "error",
      code: "invalid_context_budget",
      path: "contextBudget.isolateSourceDocuments",
      message: "Retrieved source documents must be isolated in context."
    });
  }
}

function validateFreshnessPolicy(profile: RagProfile, issues: ProfileValidationIssue[]): void {
  if (
    profile.freshnessPolicy.maxSourceAgeDays !== undefined &&
    profile.freshnessPolicy.maxSourceAgeDays < 1
  ) {
    issues.push({
      severity: "error",
      code: "unsafe_freshness_policy",
      path: "freshnessPolicy.maxSourceAgeDays",
      message: "maxSourceAgeDays must be positive when provided."
    });
  }

  if (
    (profile.freshnessPolicy.mode === "latest_wins" ||
      profile.freshnessPolicy.mode === "as_of_date" ||
      profile.freshnessPolicy.mode === "versioned") &&
    !profile.freshnessPolicy.requireCapturedAt
  ) {
    issues.push({
      severity: "error",
      code: "unsafe_freshness_policy",
      path: "freshnessPolicy.requireCapturedAt",
      message: "Freshness-aware modes require capturedAt metadata."
    });
  }
}

function validateCitationPolicy(profile: RagProfile, issues: ProfileValidationIssue[]): void {
  if (!profile.citationPolicy.requireCitations) {
    issues.push({
      severity: "error",
      code: "unsafe_citation_policy",
      path: "citationPolicy.requireCitations",
      message: "Production RAG profiles must require citations."
    });
  }

  if (profile.citationPolicy.minimumCitationsForAnswer < 1) {
    issues.push({
      severity: "error",
      code: "unsafe_citation_policy",
      path: "citationPolicy.minimumCitationsForAnswer",
      message: "Production RAG profiles must require at least one citation for supported answers."
    });
  }

  if (profile.citationPolicy.minimumTrustedCitations < 1) {
    issues.push({
      severity: "error",
      code: "unsafe_citation_policy",
      path: "citationPolicy.minimumTrustedCitations",
      message: "Production RAG profiles must require at least one trusted citation."
    });
  }

  if (
    profile.citationPolicy.minimumTrustedCitations >
    profile.citationPolicy.minimumCitationsForAnswer
  ) {
    issues.push({
      severity: "error",
      code: "unsafe_citation_policy",
      path: "citationPolicy.minimumTrustedCitations",
      message: "minimumTrustedCitations cannot exceed minimumCitationsForAnswer."
    });
  }

  if (profile.citationPolicy.allowUncitedSummary) {
    issues.push({
      severity: "error",
      code: "unsafe_citation_policy",
      path: "citationPolicy.allowUncitedSummary",
      message: "Uncited summaries are not allowed in the production core."
    });
  }

  if (!profile.citationPolicy.requireExactChunkCitations) {
    issues.push({
      severity: "error",
      code: "unsafe_citation_policy",
      path: "citationPolicy.requireExactChunkCitations",
      message: "Production RAG profiles must cite exact chunks."
    });
  }

  if (profile.citationPolicy.allowedSourceKindsForCitations.length === 0) {
    issues.push({
      severity: "error",
      code: "unsafe_citation_policy",
      path: "citationPolicy.allowedSourceKindsForCitations",
      message: "At least one source kind must be allowed for citations."
    });
  }
}

function validateRefusalPolicy(profile: RagProfile, issues: ProfileValidationIssue[]): void {
  if (!profile.refusalPolicy.refuseWhenNoEvidence) {
    issues.push({
      severity: "error",
      code: "unsafe_refusal_policy",
      path: "refusalPolicy.refuseWhenNoEvidence",
      message: "Profiles must refuse when no supporting evidence is available."
    });
  }

  if (!profile.refusalPolicy.refuseWhenOnlyUntrustedEvidence) {
    issues.push({
      severity: "error",
      code: "unsafe_refusal_policy",
      path: "refusalPolicy.refuseWhenOnlyUntrustedEvidence",
      message: "Profiles must refuse or escalate when only untrusted evidence is available."
    });
  }

  if (!profile.refusalPolicy.refusalMessage.trim()) {
    issues.push({
      severity: "error",
      code: "unsafe_refusal_policy",
      path: "refusalPolicy.refusalMessage",
      message: "Profiles need an explicit refusal message."
    });
  }
}

function validateTrustPolicy(profile: RagProfile, issues: ProfileValidationIssue[]): void {
  if (profile.trustPolicy.allowedTrustTiers.length === 0) {
    issues.push({
      severity: "error",
      code: "unsafe_trust_policy",
      path: "trustPolicy.allowedTrustTiers",
      message: "At least one allowed trust tier is required."
    });
  }

  if (!profile.trustPolicy.allowedTrustTiers.includes(profile.trustPolicy.minimumAnswerTrustTier)) {
    issues.push({
      severity: "error",
      code: "unsafe_trust_policy",
      path: "trustPolicy.minimumAnswerTrustTier",
      message: "minimumAnswerTrustTier must be included in allowedTrustTiers."
    });
  }

  for (const tier of profile.trustPolicy.allowedTrustTiers) {
    if (!isKnownTrustTier(tier)) {
      issues.push({
        severity: "error",
        code: "unsafe_trust_policy",
        path: "trustPolicy.allowedTrustTiers",
        message: `Unknown allowed trust tier "${tier}".`
      });
    }
  }

  for (const tier of HIGH_RISK_TRUST_TIERS) {
    if (!profile.trustPolicy.requireHumanReviewFor.includes(tier)) {
      issues.push({
        severity: "warning",
        code: "unsafe_trust_policy",
        path: "trustPolicy.requireHumanReviewFor",
        message: `High-risk trust tier "${tier}" should require human review.`
      });
    }
  }

  if (
    profile.trustPolicy.minimumAnswerTrustTier === "external_untrusted" ||
    profile.trustPolicy.minimumAnswerTrustTier === "unknown"
  ) {
    issues.push({
      severity: "error",
      code: "unsafe_trust_policy",
      path: "trustPolicy.minimumAnswerTrustTier",
      message: "External untrusted or unknown evidence cannot be the minimum answer trust tier."
    });
  }
}

function validateRedactionPolicy(profile: RagProfile, issues: ProfileValidationIssue[]): void {
  if (!profile.redactionPolicy.redactBeforeLogging) {
    issues.push({
      severity: "error",
      code: "unsafe_redaction_policy",
      path: "redactionPolicy.redactBeforeLogging",
      message: "Profiles must redact sensitive data before logging."
    });
  }

  if (!profile.redactionPolicy.redactBeforeGeneration) {
    issues.push({
      severity: "warning",
      code: "unsafe_redaction_policy",
      path: "redactionPolicy.redactBeforeGeneration",
      message:
        "Profiles should redact sensitive data before generation unless domain-specific evidence requires otherwise."
    });
  }

  if (!profile.redactionPolicy.piiClasses.includes("auth_secret")) {
    issues.push({
      severity: "error",
      code: "unsafe_redaction_policy",
      path: "redactionPolicy.piiClasses",
      message: "auth_secret must be included in redaction classes."
    });
  }
}

function validateOutputContract(profile: RagProfile, issues: ProfileValidationIssue[]): void {
  if (profile.outputContract.mode !== profile.outputMode) {
    issues.push({
      severity: "error",
      code: "unsafe_output_contract",
      path: "outputContract.mode",
      message: "outputContract.mode must match profile.outputMode."
    });
  }

  if (!profile.outputContract.schemaName.trim()) {
    issues.push({
      severity: "error",
      code: "unsafe_output_contract",
      path: "outputContract.schemaName",
      message: "Profiles must declare an output schema name."
    });
  }
}

function validateActionPolicy(profile: RagProfile, issues: ProfileValidationIssue[]): void {
  if (
    profile.actionPolicy.mode === "answer_only" &&
    profile.actionPolicy.allowedActions.length > 0
  ) {
    issues.push({
      severity: "error",
      code: "unsafe_action_policy",
      path: "actionPolicy.allowedActions",
      message: "answer_only profiles cannot allow actions."
    });
  }

  if (
    profile.actionPolicy.mode === "human_approval_required" &&
    profile.actionPolicy.allowedActions.some(
      (action) => !profile.actionPolicy.requireApprovalFor.includes(action)
    )
  ) {
    issues.push({
      severity: "error",
      code: "unsafe_action_policy",
      path: "actionPolicy.requireApprovalFor",
      message: "Every allowed action must require approval in human_approval_required mode."
    });
  }
}

function validateCostLatencyBudget(profile: RagProfile, issues: ProfileValidationIssue[]): void {
  if (
    profile.costLatencyBudget.maxRetrievalCalls < 1 ||
    profile.costLatencyBudget.maxRetrievalCalls > MAX_RETRIEVAL_CALLS_LIMIT
  ) {
    issues.push({
      severity: "error",
      code: "invalid_cost_latency_budget",
      path: "costLatencyBudget.maxRetrievalCalls",
      message: `maxRetrievalCalls must be between 1 and ${MAX_RETRIEVAL_CALLS_LIMIT}.`
    });
  }

  if (
    profile.costLatencyBudget.maxModelCalls < 1 ||
    profile.costLatencyBudget.maxModelCalls > MAX_MODEL_CALLS_LIMIT
  ) {
    issues.push({
      severity: "error",
      code: "invalid_cost_latency_budget",
      path: "costLatencyBudget.maxModelCalls",
      message: `maxModelCalls must be between 1 and ${MAX_MODEL_CALLS_LIMIT}.`
    });
  }

  if (profile.costLatencyBudget.maxRuntimeMs < 1_000) {
    issues.push({
      severity: "error",
      code: "invalid_cost_latency_budget",
      path: "costLatencyBudget.maxRuntimeMs",
      message: "maxRuntimeMs must be at least 1000."
    });
  }

  if (profile.costLatencyBudget.maxEstimatedCostUsd <= 0) {
    issues.push({
      severity: "error",
      code: "invalid_cost_latency_budget",
      path: "costLatencyBudget.maxEstimatedCostUsd",
      message: "maxEstimatedCostUsd must be positive."
    });
  }
}

function validateSecurityPolicy(profile: RagProfile, issues: ProfileValidationIssue[]): void {
  if (!profile.securityPolicy.treatRetrievedTextAsUntrustedInstructions) {
    issues.push({
      severity: "error",
      code: "unsafe_security_policy",
      path: "securityPolicy.treatRetrievedTextAsUntrustedInstructions",
      message: "Retrieved text must be treated as untrusted instructions."
    });
  }

  if (!profile.securityPolicy.isolateRetrievedSources) {
    issues.push({
      severity: "error",
      code: "unsafe_security_policy",
      path: "securityPolicy.isolateRetrievedSources",
      message: "Retrieved sources must be isolated from each other."
    });
  }

  if (!profile.securityPolicy.blockRawVectorAccess) {
    issues.push({
      severity: "error",
      code: "unsafe_security_policy",
      path: "securityPolicy.blockRawVectorAccess",
      message: "Profiles cannot expose raw vectors."
    });
  }
}

function validateObservabilityPolicy(profile: RagProfile, issues: ProfileValidationIssue[]): void {
  if (profile.observabilityPolicy.includeRetrievedTextInLogs) {
    issues.push({
      severity: "warning",
      code: "unsafe_observability_policy",
      path: "observabilityPolicy.includeRetrievedTextInLogs",
      message: "Logging retrieved text increases data exposure risk."
    });
  }

  if (!profile.observabilityPolicy.includeRejectedChunksInTrace) {
    issues.push({
      severity: "warning",
      code: "unsafe_observability_policy",
      path: "observabilityPolicy.includeRejectedChunksInTrace",
      message: "Rejected chunks should usually be traced for debugging and security review."
    });
  }

  if (!profile.observabilityPolicy.redactTracePayloads) {
    issues.push({
      severity: "error",
      code: "unsafe_observability_policy",
      path: "observabilityPolicy.redactTracePayloads",
      message: "Trace payloads must be redacted."
    });
  }
}

function validateMemoryPolicy(profile: RagProfile, issues: ProfileValidationIssue[]): void {
  if (profile.memoryPolicy.mode === "disabled" && profile.memoryPolicy.persistRetrievedFacts) {
    issues.push({
      severity: "error",
      code: "unsafe_memory_policy",
      path: "memoryPolicy.persistRetrievedFacts",
      message: "Disabled memory cannot persist retrieved facts."
    });
  }

  if (
    profile.memoryPolicy.mode === "long_term" &&
    !profile.memoryPolicy.requireHumanReviewForLongTermWrites
  ) {
    issues.push({
      severity: "error",
      code: "unsafe_memory_policy",
      path: "memoryPolicy.requireHumanReviewForLongTermWrites",
      message: "Long-term memory writes require human review."
    });
  }
}

function validateEvals(profile: RagProfile, issues: ProfileValidationIssue[]): void {
  if (!profile.evals.goldenSetPath.trim()) {
    issues.push({
      severity: "error",
      code: "missing_eval_check",
      path: "evals.goldenSetPath",
      message: "Profiles must declare a golden eval set path."
    });
  }

  if (!profile.evals.adversarialSetPath.trim()) {
    issues.push({
      severity: "error",
      code: "missing_eval_check",
      path: "evals.adversarialSetPath",
      message: "Profiles must declare an adversarial eval set path."
    });
  }

  for (const requiredCheck of REQUIRED_EVAL_CHECKS) {
    if (!profile.evals.requiredChecks.includes(requiredCheck)) {
      issues.push({
        severity: "error",
        code: "missing_eval_check",
        path: "evals.requiredChecks",
        message: `Missing required eval check "${requiredCheck}".`
      });
    }
  }
}

function validateEscalationRules(
  rules: readonly EscalationRule[],
  issues: ProfileValidationIssue[]
): void {
  const seenRuleIds = new Set<string>();

  for (const [index, rule] of rules.entries()) {
    const path = `escalationRules[${index}]`;
    if (
      !rule.id.trim() ||
      !rule.description.trim() ||
      !rule.trigger.trim() ||
      !rule.destination.trim()
    ) {
      issues.push({
        severity: "error",
        code: "invalid_escalation_rule",
        path,
        message: "Escalation rule id, description, trigger, and destination are required."
      });
    }

    if (seenRuleIds.has(rule.id)) {
      issues.push({
        severity: "error",
        code: "invalid_escalation_rule",
        path: `${path}.id`,
        message: `Duplicate escalation rule id "${rule.id}".`
      });
    }
    seenRuleIds.add(rule.id);
  }
}

function isKnownTrustTier(value: TrustTier): boolean {
  return TRUST_TIERS.some((tier) => tier === value);
}
