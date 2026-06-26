import type { RagProfile } from "../profile.js";

export const ultimateDefaultProfile: RagProfile = {
  id: "ultimate-default",
  namespaceId: "ultimate-default",
  name: "Ultimate Default RAG",
  purpose:
    "Strict production baseline for a sourced, adversarially aware, profile-driven RAG system.",
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
      description: "Curated local documents for a strict default RAG profile.",
      enabled: true,
      trustTierFloor: "trusted_internal",
      tags: ["curated", "trusted"]
    }
  ],
  retrieval: {
    mode: "keyword",
    maxChunks: 16,
    allowQueryRewrite: true,
    allowParallelQueries: true,
    rerankMode: "model",
    preferSourceTags: ["trusted", "curated"],
    avoidSourceTagsUnlessNeeded: ["external", "user_provided"]
  },
  contextBudget: {
    maxContextTokens: 24000,
    maxContextChunks: 10,
    reserveOutputTokens: 2000,
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
    minimumAnswerTrustTier: "trusted_internal"
  },
  citationPolicy: {
    requireCitations: true,
    minimumCitationsForAnswer: 2,
    minimumTrustedCitations: 1,
    allowUncitedSummary: false,
    requireExactChunkCitations: true,
    allowedSourceKindsForCitations: [
      "repo_file",
      "local_file",
      "database_row",
      "support_ticket",
      "uploaded_file",
      "web_page",
      "api_response"
    ]
  },
  refusalPolicy: {
    refuseWhenNoEvidence: true,
    refuseWhenOnlyUntrustedEvidence: true,
    refusalMessage: "I do not have enough trusted, citable evidence to answer that safely."
  },
  redactionPolicy: {
    redactBeforeLogging: true,
    redactBeforeGeneration: true,
    piiClasses: [
      "email",
      "phone",
      "user_id",
      "payment",
      "auth_secret",
      "health",
      "free_text_sensitive"
    ],
    blockedSecretPatterns: ["api[_-]?key", "bearer\\s+[a-z0-9._-]+", "password\\s*="]
  },
  outputContract: {
    mode: "sourced_answer",
    schemaName: "UltimateSourcedAnswer",
    requireStructuredOutput: true,
    includeEvidenceSummary: true
  },
  actionPolicy: {
    mode: "answer_only",
    allowedActions: [],
    requireApprovalFor: []
  },
  costLatencyBudget: {
    maxRetrievalCalls: 8,
    maxModelCalls: 12,
    maxRuntimeMs: 120000,
    maxEstimatedCostUsd: 1
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
  escalationRules: [
    {
      id: "unsupported_or_conflicting_evidence",
      description: "Escalate when evidence is missing, conflicting, or only untrusted.",
      trigger: "no_evidence or conflicting_evidence or only_untrusted_evidence",
      destination: "human_review"
    }
  ],
  evals: {
    goldenSetPath: "profiles/ultimate-default/evals/golden.jsonl",
    adversarialSetPath: "profiles/ultimate-default/evals/adversarial.jsonl",
    requiredChecks: [
      "retrieval_recall",
      "citation_required",
      "refusal_when_unsupported",
      "access_boundary",
      "prompt_injection_resistance",
      "grounding_faithfulness",
      "redaction_required",
      "cost_budget",
      "visual_retrieval",
      "relationship_claim_grounding",
      "extraction_quality"
    ]
  }
};
