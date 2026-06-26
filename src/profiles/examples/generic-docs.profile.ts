import type { RagProfile } from "../profile.js";

export const genericDocsProfile: RagProfile = {
  id: "generic-docs",
  namespaceId: "generic-docs",
  name: "Generic Docs RAG",
  purpose: "Answer questions from curated documentation with citations.",
  outputMode: "sourced_answer",
  modelPolicy: {
    allowedTiers: ["fast", "balanced", "strong", "judge"],
    defaultTierByRole: {
      query_planning: "balanced",
      context_evaluation: "strong",
      answer_generation: "strong",
      grounding_judge: "judge",
      redaction: "fast"
    },
    requireEvidenceForGeneration: true,
    allowModelFallback: true
  },
  corpusSources: [
    {
      id: "curated_docs",
      adapter: "local-files",
      description: "Curated local documentation files.",
      enabled: true,
      trustTierFloor: "trusted_internal",
      tags: ["curated", "docs"]
    }
  ],
  retrieval: {
    mode: "keyword",
    maxChunks: 8,
    allowQueryRewrite: true,
    allowParallelQueries: false,
    rerankMode: "lightweight",
    preferSourceTags: ["curated"],
    avoidSourceTagsUnlessNeeded: ["external"]
  },
  contextBudget: {
    maxContextTokens: 12000,
    maxContextChunks: 6,
    reserveOutputTokens: 1000,
    preferTrustedSources: true,
    preferRecentSources: true,
    isolateSourceDocuments: true
  },
  freshnessPolicy: {
    mode: "versioned",
    maxSourceAgeDays: 365,
    requireCapturedAt: true
  },
  trustPolicy: {
    allowedTrustTiers: ["trusted_internal", "verified_partner", "user_provided"],
    requireHumanReviewFor: [
      "user_provided",
      "external_untrusted",
      "generated_or_derived",
      "unknown"
    ],
    minimumAnswerTrustTier: "user_provided"
  },
  citationPolicy: {
    requireCitations: true,
    minimumCitationsForAnswer: 1,
    minimumTrustedCitations: 1,
    allowUncitedSummary: false,
    requireExactChunkCitations: true,
    allowedSourceKindsForCitations: ["repo_file", "local_file", "api_response"]
  },
  refusalPolicy: {
    refuseWhenNoEvidence: true,
    refuseWhenOnlyUntrustedEvidence: true,
    refusalMessage: "I do not have enough trusted evidence to answer that."
  },
  redactionPolicy: {
    redactBeforeLogging: true,
    redactBeforeGeneration: true,
    piiClasses: ["email", "phone", "user_id", "payment", "auth_secret", "free_text_sensitive"],
    blockedSecretPatterns: ["api[_-]?key", "bearer\\s+[a-z0-9._-]+", "password\\s*="]
  },
  outputContract: {
    mode: "sourced_answer",
    schemaName: "GenericSourcedAnswer",
    requireStructuredOutput: true,
    includeEvidenceSummary: true
  },
  actionPolicy: {
    mode: "answer_only",
    allowedActions: [],
    requireApprovalFor: []
  },
  costLatencyBudget: {
    maxRetrievalCalls: 4,
    maxModelCalls: 6,
    maxRuntimeMs: 60000,
    maxEstimatedCostUsd: 0.25
  },
  securityPolicy: {
    treatRetrievedTextAsUntrustedInstructions: true,
    promptInjectionScanning: "strict",
    isolateRetrievedSources: true,
    blockRawVectorAccess: true
  },
  observabilityPolicy: {
    level: "standard",
    includeRetrievedTextInLogs: false,
    includeRejectedChunksInTrace: true,
    redactTracePayloads: true
  },
  memoryPolicy: {
    mode: "session",
    persistRetrievedFacts: false,
    requireHumanReviewForLongTermWrites: true
  },
  escalationRules: [],
  evals: {
    goldenSetPath: "profiles/generic-docs/evals/golden.jsonl",
    adversarialSetPath: "profiles/generic-docs/evals/adversarial.jsonl",
    requiredChecks: [
      "retrieval_recall",
      "citation_required",
      "refusal_when_unsupported",
      "access_boundary",
      "prompt_injection_resistance"
    ]
  }
};
