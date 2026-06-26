export type ProfileFieldEnforcementStatus =
  | "runtime_enforced"
  | "validation_enforced"
  | "declarative";

export interface ProfileFieldEnforcementRecord {
  readonly path: string;
  readonly status: ProfileFieldEnforcementStatus;
  readonly owner: string;
  readonly reason: string;
}

export const PROFILE_FIELD_ENFORCEMENT = [
  enforced(
    "id",
    "profiles/profile-validation.ts",
    "Validated before registration and copied into traces."
  ),
  enforced(
    "namespaceId",
    "profiles/profile-validation.ts",
    "Validated and enforced across corpus, retrieval, context, and answer boundaries."
  ),
  declarative("name", "product", "Human-readable profile label."),
  declarative("purpose", "product", "Human-readable profile intent."),
  enforced(
    "outputMode",
    "profiles/profile-validation.ts",
    "Validated against outputContract.mode."
  ),

  enforced(
    "modelPolicy.allowedTiers[]",
    "profiles/profile-validation.ts",
    "Every default model role tier must be allowed."
  ),
  declarative(
    "modelPolicy.defaultTierByRole.query_planning",
    "future-query-planner",
    "Query-planning model execution is not implemented yet."
  ),
  declarative(
    "modelPolicy.defaultTierByRole.context_evaluation",
    "future-context-judge",
    "Context-evaluation model execution is not implemented yet."
  ),
  enforced(
    "modelPolicy.defaultTierByRole.answer_generation",
    "generation/generation-orchestrator.ts",
    "Used to choose the answer-generation model tier."
  ),
  enforced(
    "modelPolicy.defaultTierByRole.grounding_judge",
    "answer/grounding-judge.ts + generation/generation-orchestrator.ts",
    "Used by model-backed grounding judge when configured."
  ),
  declarative(
    "modelPolicy.defaultTierByRole.redaction",
    "future-redaction-model",
    "Model-backed redaction is not implemented yet."
  ),
  enforced(
    "modelPolicy.requireEvidenceForGeneration",
    "answer/grounding-gate.ts",
    "Blocks generation when context evidence is missing."
  ),
  declarative(
    "modelPolicy.allowModelFallback",
    "future-provider-routing",
    "Fallback provider routing is not implemented yet."
  ),

  enforced("corpusSources[].id", "corpus/normalize.ts", "Records must match a declared source id."),
  enforced(
    "corpusSources[].adapter",
    "corpus/normalize.ts",
    "Runtime source config must match the profile declaration."
  ),
  declarative("corpusSources[].description", "product", "Human-readable source description."),
  enforced(
    "corpusSources[].enabled",
    "corpus/normalize.ts",
    "Disabled sources cannot ingest records."
  ),
  enforced(
    "corpusSources[].trustTierOverride",
    "corpus/normalize.ts",
    "Overrides can downgrade trust but cannot upgrade it."
  ),
  enforced(
    "corpusSources[].trustTierFloor",
    "corpus/normalize.ts",
    "Sources cannot normalize records above their configured trust floor."
  ),
  declarative(
    "corpusSources[].tags[]",
    "future-source-routing",
    "Source-tag routing is not implemented yet."
  ),

  enforced(
    "retrieval.mode",
    "profiles/profile-validation.ts",
    "Only retrieval modes implemented by engine-capabilities are accepted."
  ),
  enforced(
    "retrieval.maxChunks",
    "runtime/rag-answer-runtime.ts",
    "Default topK for runtime answer retrieval."
  ),
  enforced(
    "retrieval.allowQueryRewrite",
    "query/default-query-planner.ts + runtime/rag-answer-runtime.ts",
    "Controls whether the runtime may add rewritten low-level/high-level retrieval queries."
  ),
  enforced(
    "retrieval.allowParallelQueries",
    "query/default-query-planner.ts + runtime/rag-answer-runtime.ts",
    "Controls whether query planning may execute multiple retrieval queries for one answer run."
  ),
  enforced(
    "retrieval.rerankMode",
    "runtime/rag-runtime-factory.ts + retrieval/reranking-retriever.ts",
    "Controls whether retrieval is reranked and requires a configured reranker for model mode."
  ),
  enforced(
    "retrieval.preferSourceTags[]",
    "context/context-builder.ts",
    "Preferred source/access tags are ranked before trust and recency during context selection."
  ),
  enforced(
    "retrieval.avoidSourceTagsUnlessNeeded[]",
    "context/context-builder.ts",
    "Avoided source/access tags are ranked behind non-avoided candidates during context selection."
  ),

  enforced(
    "contextBudget.maxContextTokens",
    "context/context-builder.ts",
    "Caps generation context token estimate."
  ),
  enforced(
    "contextBudget.maxContextChunks",
    "context/context-builder.ts",
    "Caps generation context chunks."
  ),
  enforced(
    "contextBudget.reserveOutputTokens",
    "answer/grounding-gate.ts",
    "Sets the generation output token budget."
  ),
  enforced(
    "contextBudget.preferTrustedSources",
    "context/context-builder.ts",
    "Sorts candidates by trust before context selection."
  ),
  enforced(
    "contextBudget.preferRecentSources",
    "context/context-builder.ts",
    "Sorts candidates by source recency before context selection."
  ),
  enforced(
    "contextBudget.isolateSourceDocuments",
    "context/context-builder.ts",
    "Controls source block boundary labels."
  ),

  enforced(
    "freshnessPolicy.mode",
    "context/context-builder.ts",
    "Controls freshness rejection behavior."
  ),
  enforced(
    "freshnessPolicy.maxSourceAgeDays",
    "context/context-builder.ts",
    "Rejects stale source chunks."
  ),
  enforced(
    "freshnessPolicy.requireCapturedAt",
    "corpus/normalize.ts + context/context-builder.ts",
    "Required at ingest and again before context use."
  ),

  enforced(
    "trustPolicy.allowedTrustTiers[]",
    "context/context-builder.ts",
    "Rejects disallowed trust tiers before context."
  ),
  enforced(
    "trustPolicy.requireHumanReviewFor[]",
    "context/context-builder.ts + answer/grounding-gate.ts",
    "Marks evidence and generation as human-review required."
  ),
  enforced(
    "trustPolicy.minimumAnswerTrustTier",
    "context/context-builder.ts + answer/grounding-gate.ts",
    "Determines answerable evidence and citation trust."
  ),

  enforced(
    "citationPolicy.requireCitations",
    "answer/grounding-gate.ts",
    "Requires citations in generated drafts."
  ),
  enforced(
    "citationPolicy.minimumCitationsForAnswer",
    "context/context-builder.ts + answer/grounding-gate.ts",
    "Enforces minimum citation count."
  ),
  enforced(
    "citationPolicy.minimumTrustedCitations",
    "context/context-builder.ts + answer/grounding-gate.ts",
    "Enforces minimum trusted citation count."
  ),
  enforced(
    "citationPolicy.allowUncitedSummary",
    "profiles/profile-validation.ts",
    "Rejected by validation in the production core."
  ),
  enforced(
    "citationPolicy.requireExactChunkCitations",
    "context/context-builder.ts",
    "Rejects chunks without exact citation pointers."
  ),
  enforced(
    "citationPolicy.allowedSourceKindsForCitations[]",
    "context/context-builder.ts",
    "Rejects disallowed source kinds before context."
  ),

  enforced(
    "refusalPolicy.refuseWhenNoEvidence",
    "context/context-builder.ts + answer/grounding-gate.ts",
    "Turns no evidence into refusal."
  ),
  enforced(
    "refusalPolicy.refuseWhenOnlyUntrustedEvidence",
    "context/context-builder.ts",
    "Treats untrusted-only evidence as insufficient."
  ),
  enforced(
    "refusalPolicy.refusalMessage",
    "answer/grounding-gate.ts",
    "Used in refusal responses."
  ),

  enforced(
    "redactionPolicy.redactBeforeLogging",
    "profiles/profile-validation.ts",
    "Required by validation; runtime traces avoid raw payloads."
  ),
  enforced(
    "redactionPolicy.redactBeforeGeneration",
    "context/context-builder.ts",
    "Controls context redaction before generation."
  ),
  enforced(
    "redactionPolicy.piiClasses[]",
    "context/context-builder.ts",
    "Controls built-in PII redaction classes."
  ),
  enforced(
    "redactionPolicy.blockedSecretPatterns[]",
    "context/context-builder.ts",
    "Controls custom secret redaction patterns."
  ),

  enforced(
    "outputContract.mode",
    "profiles/profile-validation.ts + answer/grounding-gate.ts",
    "Validated against outputMode and copied into the generation contract."
  ),
  enforced(
    "outputContract.schemaName",
    "answer/grounding-gate.ts",
    "Copied into the generation contract."
  ),
  enforced(
    "outputContract.requireStructuredOutput",
    "answer/grounding-gate.ts",
    "Copied into the generation contract."
  ),
  enforced(
    "outputContract.includeEvidenceSummary",
    "answer/grounding-gate.ts",
    "Requires evidence summaries in generated drafts."
  ),

  enforced(
    "actionPolicy.mode",
    "answer/grounding-gate.ts",
    "Controls generation review status and contract action mode."
  ),
  enforced(
    "actionPolicy.allowedActions[]",
    "answer/grounding-gate.ts",
    "Rejects drafts requesting disallowed actions."
  ),
  enforced(
    "actionPolicy.requireApprovalFor[]",
    "answer/grounding-gate.ts",
    "Marks approved actions as requiring human approval."
  ),

  enforced(
    "costLatencyBudget.maxRetrievalCalls",
    "runtime/rag-answer-runtime.ts",
    "Checked before runtime retrieval calls."
  ),
  enforced(
    "costLatencyBudget.maxModelCalls",
    "budget/budget-meter.ts",
    "BudgetMeter tracks model call count."
  ),
  enforced(
    "costLatencyBudget.maxRuntimeMs",
    "budget/budget-meter.ts",
    "BudgetMeter checks model latency."
  ),
  enforced(
    "costLatencyBudget.maxEstimatedCostUsd",
    "budget/budget-meter.ts",
    "BudgetMeter checks cumulative estimated model cost."
  ),

  enforced(
    "securityPolicy.treatRetrievedTextAsUntrustedInstructions",
    "context/context-builder.ts + answer/grounding-gate.ts",
    "Controls rendered source warning and grounding rules."
  ),
  enforced(
    "securityPolicy.promptInjectionScanning",
    "context/context-builder.ts",
    "Strict mode rejects prompt-injection flagged chunks."
  ),
  enforced(
    "securityPolicy.isolateRetrievedSources",
    "context/context-builder.ts + answer/grounding-gate.ts",
    "Controls source isolation rendering and grounding rules."
  ),
  enforced(
    "securityPolicy.blockRawVectorAccess",
    "profiles/profile-validation.ts",
    "Required until vector storage exists."
  ),

  declarative(
    "observabilityPolicy.level",
    "future-trace-verbosity",
    "Trace verbosity levels are not implemented yet; current safe trace shape is fixed."
  ),
  enforced(
    "observabilityPolicy.includeRetrievedTextInLogs",
    "profiles/profile-validation.ts",
    "Unsafe raw retrieved-text logging is warned against."
  ),
  enforced(
    "observabilityPolicy.includeRejectedChunksInTrace",
    "context/context-builder.ts + runtime/rag-answer-runtime.ts",
    "Controls rejected-candidate trace/detail inclusion."
  ),
  enforced(
    "observabilityPolicy.redactTracePayloads",
    "runtime/rag-answer-runtime.ts",
    "Runtime trace stores hashes/ids/counts rather than raw payloads."
  ),

  enforced(
    "memoryPolicy.mode",
    "profiles/profile-validation.ts",
    "Validated with memory write flags."
  ),
  enforced(
    "memoryPolicy.persistRetrievedFacts",
    "profiles/profile-validation.ts",
    "Cannot persist facts when memory is disabled."
  ),
  enforced(
    "memoryPolicy.requireHumanReviewForLongTermWrites",
    "profiles/profile-validation.ts",
    "Required for long-term memory mode."
  ),

  enforced(
    "escalationRules[].id",
    "evals/human-review-queue.ts",
    "Copied into human review queue route evidence."
  ),
  enforced(
    "escalationRules[].description",
    "evals/human-review-queue.ts",
    "Rendered into human review queue route evidence."
  ),
  enforced(
    "escalationRules[].trigger",
    "evals/human-review-queue.ts",
    "Preserved as the human-readable routing condition on queue items."
  ),
  enforced(
    "escalationRules[].destination",
    "evals/human-review-queue.ts",
    "Used as the queue destination for profile-scoped human review items."
  ),

  enforced("evals.goldenSetPath", "evals/eval-runner.ts", "Loaded by the profile eval runner."),
  enforced(
    "evals.adversarialSetPath",
    "evals/eval-runner.ts",
    "Loaded by the profile eval runner."
  ),
  enforced(
    "evals.requiredChecks[]",
    "evals/eval-runner.ts",
    "The eval runner fails a suite when declared required checks are not covered."
  )
] as const satisfies readonly ProfileFieldEnforcementRecord[];

export function profileFieldEnforcement(path: string): ProfileFieldEnforcementRecord | undefined {
  return PROFILE_FIELD_ENFORCEMENT.find((entry) => entry.path === path);
}

export function declarativeProfileFields(): readonly ProfileFieldEnforcementRecord[] {
  return PROFILE_FIELD_ENFORCEMENT.filter((entry) => entry.status === "declarative");
}

function enforced(path: string, owner: string, reason: string): ProfileFieldEnforcementRecord {
  return {
    path,
    status: owner.startsWith("profiles/profile-validation.ts")
      ? "validation_enforced"
      : "runtime_enforced",
    owner,
    reason
  };
}

function declarative(path: string, owner: string, reason: string): ProfileFieldEnforcementRecord {
  return {
    path,
    status: "declarative",
    owner,
    reason
  };
}
