import type { RagProfile } from "../profile.js";

export const breakawaySupportProfile: RagProfile = {
  id: "breakaway-support",
  namespaceId: "breakaway-support",
  name: "BreakAway Support RAG",
  purpose:
    "Draft support triage reports and user-safe responses from curated BreakAway support knowledge.",
  outputMode: "support_triage",
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
      id: "support_docs",
      adapter: "local-files",
      description: "Curated support policies, known app behavior, and troubleshooting docs.",
      enabled: true,
      trustTierFloor: "trusted_internal",
      tags: ["support", "trusted"]
    },
    {
      id: "feedback_examples",
      adapter: "local-files",
      description: "Labeled historical support examples used for triage patterns and evals.",
      enabled: true,
      trustTierFloor: "user_provided",
      tags: ["examples", "user_provided"]
    },
    {
      id: "approved_knowledge_breakaway-support",
      adapter: "approved_knowledge_artifact",
      description: "Approved support-ticket knowledge artifacts from the support bridge.",
      enabled: true,
      trustTierFloor: "generated_or_derived",
      tags: ["support", "approved-knowledge", "known-issues"]
    }
  ],
  retrieval: {
    mode: "keyword",
    maxChunks: 10,
    allowQueryRewrite: true,
    allowParallelQueries: false,
    rerankMode: "model",
    preferSourceTags: ["trusted", "support"],
    avoidSourceTagsUnlessNeeded: ["user_provided"]
  },
  contextBudget: {
    maxContextTokens: 16000,
    maxContextChunks: 8,
    reserveOutputTokens: 1500,
    preferTrustedSources: true,
    preferRecentSources: true,
    isolateSourceDocuments: true
  },
  freshnessPolicy: {
    mode: "latest_wins",
    maxSourceAgeDays: 180,
    requireCapturedAt: true
  },
  trustPolicy: {
    allowedTrustTiers: [
      "trusted_internal",
      "verified_partner",
      "user_provided",
      "generated_or_derived"
    ],
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
    minimumCitationsForAnswer: 1,
    minimumTrustedCitations: 1,
    allowUncitedSummary: false,
    requireExactChunkCitations: true,
    allowedSourceKindsForCitations: ["repo_file", "local_file", "support_ticket", "derived_summary"]
  },
  refusalPolicy: {
    refuseWhenNoEvidence: true,
    refuseWhenOnlyUntrustedEvidence: true,
    refusalMessage: "I do not have enough trusted BreakAway support evidence to answer that safely."
  },
  redactionPolicy: {
    redactBeforeLogging: true,
    redactBeforeGeneration: true,
    piiClasses: ["email", "phone", "user_id", "payment", "auth_secret", "free_text_sensitive"],
    blockedSecretPatterns: ["api[_-]?key", "bearer\\s+[a-z0-9._-]+", "password\\s*="]
  },
  outputContract: {
    mode: "support_triage",
    schemaName: "BreakawaySupportTriage",
    requireStructuredOutput: true,
    includeEvidenceSummary: true
  },
  actionPolicy: {
    mode: "draft_only",
    allowedActions: ["draft_support_response", "draft_escalation_note"],
    requireApprovalFor: ["draft_support_response", "draft_escalation_note"]
  },
  costLatencyBudget: {
    maxRetrievalCalls: 5,
    maxModelCalls: 8,
    maxRuntimeMs: 90000,
    maxEstimatedCostUsd: 0.5
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
      id: "billing_or_refund",
      description: "Billing, refund, subscription, or payment issues require human support review.",
      trigger: "category in billing/refund/payment/subscription",
      destination: "human_support"
    },
    {
      id: "privacy_or_account",
      description:
        "Privacy, account deletion, or sensitive account issues require human support review.",
      trigger: "category in privacy/account_deletion/security",
      destination: "human_support"
    },
    {
      id: "blocked_user",
      description: "A user who cannot use the app because of a bug should be escalated.",
      trigger: "severity is high or user_blocked is true",
      destination: "human_support"
    }
  ],
  evals: {
    goldenSetPath: "profiles/breakaway-support/evals/golden.jsonl",
    adversarialSetPath: "profiles/breakaway-support/evals/adversarial.jsonl",
    requiredChecks: [
      "retrieval_recall",
      "citation_required",
      "refusal_when_unsupported",
      "access_boundary",
      "prompt_injection_resistance",
      "escalation_rule_match"
    ]
  }
};
