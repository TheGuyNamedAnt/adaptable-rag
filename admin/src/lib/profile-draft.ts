export type ProfileExampleId = "docs" | "support" | "diligence" | "code";
export type RetrievalMode = "keyword" | "vector" | "hybrid" | "visual";
export type RerankMode = "none" | "lightweight" | "model";
export type OutputMode =
  | "sourced_answer"
  | "support_triage"
  | "diligence_finding"
  | "code_investigation";
export type ActionMode = "answer_only" | "draft_only" | "human_approval_required";
export type TrustTier =
  | "trusted_internal"
  | "verified_partner"
  | "user_provided"
  | "external_untrusted"
  | "generated_or_derived"
  | "unknown";
export type SourceKind =
  | "repo_file"
  | "local_file"
  | "database_row"
  | "support_ticket"
  | "uploaded_file"
  | "web_page"
  | "api_response"
  | "derived_summary";

export interface ProfileDraft {
  readonly id: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly purpose: string;
  readonly outputMode: OutputMode;
  readonly sourceId: string;
  readonly sourceAdapter: string;
  readonly sourceDescription: string;
  readonly sourceTrustTier: TrustTier;
  readonly sourceTags: string;
  readonly retrievalMode: RetrievalMode;
  readonly rerankMode: RerankMode;
  readonly maxChunks: number;
  readonly maxContextChunks: number;
  readonly maxContextTokens: number;
  readonly reserveOutputTokens: number;
  readonly allowQueryRewrite: boolean;
  readonly allowParallelQueries: boolean;
  readonly minimumCitationsForAnswer: number;
  readonly minimumTrustedCitations: number;
  readonly allowedSourceKinds: readonly SourceKind[];
  readonly minimumAnswerTrustTier: TrustTier;
  readonly maxSourceAgeDays: number;
  readonly refusalMessage: string;
  readonly actionMode: ActionMode;
  readonly allowedActions: string;
  readonly approvalActions: string;
  readonly maxRetrievalCalls: number;
  readonly maxModelCalls: number;
  readonly maxRuntimeMs: number;
  readonly maxEstimatedCostUsd: number;
  readonly goldenSetPath: string;
  readonly adversarialSetPath: string;
  readonly requiredChecks: string;
}

export interface GeneratedProfile {
  readonly id: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly purpose: string;
  readonly outputMode: OutputMode;
  readonly modelPolicy: {
    readonly allowedTiers: readonly string[];
    readonly defaultTierByRole: Readonly<Record<string, string>>;
    readonly requireEvidenceForGeneration: boolean;
    readonly allowModelFallback: boolean;
  };
  readonly corpusSources: readonly unknown[];
  readonly retrieval: Readonly<Record<string, unknown>>;
  readonly contextBudget: Readonly<Record<string, unknown>>;
  readonly freshnessPolicy: Readonly<Record<string, unknown>>;
  readonly trustPolicy: Readonly<Record<string, unknown>>;
  readonly citationPolicy: Readonly<Record<string, unknown>>;
  readonly refusalPolicy: Readonly<Record<string, unknown>>;
  readonly redactionPolicy: Readonly<Record<string, unknown>>;
  readonly outputContract: Readonly<Record<string, unknown>>;
  readonly actionPolicy: Readonly<Record<string, unknown>>;
  readonly costLatencyBudget: Readonly<Record<string, unknown>>;
  readonly securityPolicy: Readonly<Record<string, unknown>>;
  readonly observabilityPolicy: Readonly<Record<string, unknown>>;
  readonly memoryPolicy: Readonly<Record<string, unknown>>;
  readonly escalationRules: readonly unknown[];
  readonly evals: Readonly<Record<string, unknown>>;
}

export interface ProfileDraftIssue {
  readonly tone: "success" | "warning" | "error";
  readonly label: string;
  readonly detail: string;
}

const LOCKED_GROUNDING_CHECKS = ["citation_required", "grounding_faithfulness"] as const;

const DEFAULT_PROFILE_DRAFT: ProfileDraft = {
  id: "rag-profile",
  namespaceId: "rag-profile",
  name: "Portable RAG Profile",
  purpose: "Answer questions from configured knowledge sources with grounded citations.",
  outputMode: "sourced_answer",
  sourceId: "primary_knowledge",
  sourceAdapter: "local-files",
  sourceDescription: "Primary knowledge sources for this RAG deployment.",
  sourceTrustTier: "trusted_internal",
  sourceTags: "knowledge,trusted",
  retrievalMode: "keyword",
  rerankMode: "lightweight",
  maxChunks: 8,
  maxContextChunks: 6,
  maxContextTokens: 12000,
  reserveOutputTokens: 1000,
  allowQueryRewrite: true,
  allowParallelQueries: false,
  minimumCitationsForAnswer: 1,
  minimumTrustedCitations: 1,
  allowedSourceKinds: ["repo_file", "local_file", "uploaded_file", "api_response"],
  minimumAnswerTrustTier: "user_provided",
  maxSourceAgeDays: 365,
  refusalMessage: "I do not have enough trusted evidence to answer that.",
  actionMode: "answer_only",
  allowedActions: "",
  approvalActions: "",
  maxRetrievalCalls: 4,
  maxModelCalls: 6,
  maxRuntimeMs: 60000,
  maxEstimatedCostUsd: 0.25,
  goldenSetPath: "profiles/rag-profile/evals/golden.jsonl",
  adversarialSetPath: "profiles/rag-profile/evals/adversarial.jsonl",
  requiredChecks:
    "retrieval_recall,citation_required,grounding_faithfulness,refusal_when_unsupported,access_boundary,prompt_injection_resistance"
};

export const PROFILE_EXAMPLES: readonly {
  readonly id: ProfileExampleId;
  readonly label: string;
  readonly detail: string;
  readonly draft: ProfileDraft;
}[] = [
  {
    id: "docs",
    label: "Docs Q&A",
    detail: "Example values for curated docs with strict citations.",
    draft: {
      id: "company-docs",
      namespaceId: "company-docs",
      name: "Company Docs RAG",
      purpose: "Answer questions from curated company documentation with citations.",
      outputMode: "sourced_answer",
      sourceId: "curated_docs",
      sourceAdapter: "local-files",
      sourceDescription: "Curated company documentation files.",
      sourceTrustTier: "trusted_internal",
      sourceTags: "curated,docs,trusted",
      retrievalMode: "keyword",
      rerankMode: "lightweight",
      maxChunks: 8,
      maxContextChunks: 6,
      maxContextTokens: 12000,
      reserveOutputTokens: 1000,
      allowQueryRewrite: true,
      allowParallelQueries: false,
      minimumCitationsForAnswer: 1,
      minimumTrustedCitations: 1,
      allowedSourceKinds: ["repo_file", "local_file", "uploaded_file", "api_response"],
      minimumAnswerTrustTier: "user_provided",
      maxSourceAgeDays: 365,
      refusalMessage: "I do not have enough trusted evidence to answer that.",
      actionMode: "answer_only",
      allowedActions: "",
      approvalActions: "",
      maxRetrievalCalls: 4,
      maxModelCalls: 6,
      maxRuntimeMs: 60000,
      maxEstimatedCostUsd: 0.25,
      goldenSetPath: "profiles/company-docs/evals/golden.jsonl",
      adversarialSetPath: "profiles/company-docs/evals/adversarial.jsonl",
      requiredChecks:
        "retrieval_recall,citation_required,grounding_faithfulness,refusal_when_unsupported,access_boundary,prompt_injection_resistance"
    }
  },
  {
    id: "support",
    label: "Support",
    detail: "Example values for support triage with approvals.",
    draft: {
      id: "company-support",
      namespaceId: "company-support",
      name: "Company Support RAG",
      purpose: "Draft support triage and user-safe responses from approved support knowledge.",
      outputMode: "support_triage",
      sourceId: "support_docs",
      sourceAdapter: "local-files",
      sourceDescription: "Support policies, known issues, and troubleshooting docs.",
      sourceTrustTier: "trusted_internal",
      sourceTags: "support,trusted,known-issues",
      retrievalMode: "keyword",
      rerankMode: "model",
      maxChunks: 10,
      maxContextChunks: 8,
      maxContextTokens: 16000,
      reserveOutputTokens: 1500,
      allowQueryRewrite: true,
      allowParallelQueries: false,
      minimumCitationsForAnswer: 1,
      minimumTrustedCitations: 1,
      allowedSourceKinds: ["local_file", "support_ticket", "derived_summary", "api_response"],
      minimumAnswerTrustTier: "trusted_internal",
      maxSourceAgeDays: 180,
      refusalMessage: "I do not have enough trusted support evidence to answer that safely.",
      actionMode: "draft_only",
      allowedActions: "draft_support_response,draft_escalation_note",
      approvalActions: "draft_support_response,draft_escalation_note",
      maxRetrievalCalls: 5,
      maxModelCalls: 8,
      maxRuntimeMs: 90000,
      maxEstimatedCostUsd: 0.5,
      goldenSetPath: "profiles/company-support/evals/golden.jsonl",
      adversarialSetPath: "profiles/company-support/evals/adversarial.jsonl",
      requiredChecks:
        "retrieval_recall,citation_required,grounding_faithfulness,refusal_when_unsupported,access_boundary,prompt_injection_resistance,escalation_rule_match"
    }
  },
  {
    id: "diligence",
    label: "Diligence",
    detail: "Example values for deal-room evidence review.",
    draft: {
      id: "diligence-review",
      namespaceId: "diligence-review",
      name: "Diligence Review RAG",
      purpose: "Extract sourced diligence findings from uploaded deal-room evidence.",
      outputMode: "diligence_finding",
      sourceId: "diligence_room",
      sourceAdapter: "local-files",
      sourceDescription: "Uploaded diligence files, memos, and structured data exports.",
      sourceTrustTier: "verified_partner",
      sourceTags: "diligence,deal-room,verified",
      retrievalMode: "hybrid",
      rerankMode: "model",
      maxChunks: 14,
      maxContextChunks: 10,
      maxContextTokens: 24000,
      reserveOutputTokens: 1800,
      allowQueryRewrite: true,
      allowParallelQueries: true,
      minimumCitationsForAnswer: 2,
      minimumTrustedCitations: 1,
      allowedSourceKinds: ["local_file", "uploaded_file", "database_row", "api_response"],
      minimumAnswerTrustTier: "verified_partner",
      maxSourceAgeDays: 730,
      refusalMessage: "I do not have enough verified diligence evidence to make that finding.",
      actionMode: "human_approval_required",
      allowedActions: "draft_finding,flag_risk",
      approvalActions: "draft_finding,flag_risk",
      maxRetrievalCalls: 8,
      maxModelCalls: 12,
      maxRuntimeMs: 120000,
      maxEstimatedCostUsd: 1,
      goldenSetPath: "profiles/diligence-review/evals/golden.jsonl",
      adversarialSetPath: "profiles/diligence-review/evals/adversarial.jsonl",
      requiredChecks:
        "retrieval_recall,citation_required,grounding_faithfulness,refusal_when_unsupported,access_boundary,prompt_injection_resistance,relationship_claim_grounding"
    }
  },
  {
    id: "code",
    label: "Code",
    detail: "Example values for repo investigation with citations.",
    draft: {
      id: "code-investigation",
      namespaceId: "code-investigation",
      name: "Code Investigation RAG",
      purpose: "Investigate code behavior from repository files and engineering notes.",
      outputMode: "code_investigation",
      sourceId: "repo_knowledge",
      sourceAdapter: "local-files",
      sourceDescription: "Repository files, architecture notes, and implementation docs.",
      sourceTrustTier: "trusted_internal",
      sourceTags: "repo,code,trusted",
      retrievalMode: "keyword",
      rerankMode: "lightweight",
      maxChunks: 12,
      maxContextChunks: 9,
      maxContextTokens: 20000,
      reserveOutputTokens: 1500,
      allowQueryRewrite: true,
      allowParallelQueries: true,
      minimumCitationsForAnswer: 2,
      minimumTrustedCitations: 1,
      allowedSourceKinds: ["repo_file", "local_file", "api_response"],
      minimumAnswerTrustTier: "trusted_internal",
      maxSourceAgeDays: 365,
      refusalMessage: "I do not have enough repository evidence to answer that safely.",
      actionMode: "answer_only",
      allowedActions: "",
      approvalActions: "",
      maxRetrievalCalls: 6,
      maxModelCalls: 8,
      maxRuntimeMs: 90000,
      maxEstimatedCostUsd: 0.6,
      goldenSetPath: "profiles/code-investigation/evals/golden.jsonl",
      adversarialSetPath: "profiles/code-investigation/evals/adversarial.jsonl",
      requiredChecks:
        "retrieval_recall,citation_required,grounding_faithfulness,refusal_when_unsupported,access_boundary,prompt_injection_resistance"
    }
  }
];

export const SOURCE_KIND_OPTIONS: readonly SourceKind[] = [
  "repo_file",
  "local_file",
  "database_row",
  "support_ticket",
  "uploaded_file",
  "web_page",
  "api_response",
  "derived_summary"
];

export const TRUST_TIER_OPTIONS: readonly TrustTier[] = [
  "trusted_internal",
  "verified_partner",
  "user_provided",
  "external_untrusted",
  "generated_or_derived",
  "unknown"
];

export const ANSWER_TRUST_TIER_OPTIONS: readonly TrustTier[] = [
  "trusted_internal",
  "verified_partner",
  "user_provided"
];

const TRUST_TIER_RANK = {
  trusted_internal: 0,
  verified_partner: 1,
  user_provided: 2,
  generated_or_derived: 3,
  external_untrusted: 4,
  unknown: 5
} as const satisfies Record<TrustTier, number>;

export function defaultProfileDraft(): ProfileDraft {
  return cloneDraft(DEFAULT_PROFILE_DRAFT);
}

export function profileDraftForExample(exampleId: ProfileExampleId): ProfileDraft {
  return cloneDraft(
    PROFILE_EXAMPLES.find((example) => example.id === exampleId)?.draft ?? DEFAULT_PROFILE_DRAFT
  );
}

export function normalizeProfileDraft(draft: Partial<ProfileDraft>): ProfileDraft {
  const merged: ProfileDraft = {
    ...DEFAULT_PROFILE_DRAFT,
    ...draft,
    allowedSourceKinds: normalizeSourceKinds(draft.allowedSourceKinds)
  };
  const maxChunks = clampInteger(merged.maxChunks, 1, 30);
  const minimumCitationsForAnswer = clampInteger(merged.minimumCitationsForAnswer, 1, 10);
  const minimumTrustedCitations = clampInteger(
    merged.minimumTrustedCitations,
    1,
    minimumCitationsForAnswer
  );

  return {
    ...cloneDraft(merged),
    sourceTrustTier: normalizeTrustTier(
      merged.sourceTrustTier,
      DEFAULT_PROFILE_DRAFT.sourceTrustTier
    ),
    maxChunks,
    maxContextChunks: clampInteger(merged.maxContextChunks, 1, maxChunks),
    maxContextTokens: clampInteger(merged.maxContextTokens, 1000, 120000),
    reserveOutputTokens: clampInteger(merged.reserveOutputTokens, 256, 16000),
    minimumCitationsForAnswer,
    minimumTrustedCitations,
    minimumAnswerTrustTier: normalizeAnswerTrustTier(merged.minimumAnswerTrustTier),
    maxSourceAgeDays: clampInteger(merged.maxSourceAgeDays, 1, 3650),
    maxRetrievalCalls: clampInteger(merged.maxRetrievalCalls, 1, 50),
    maxModelCalls: clampInteger(merged.maxModelCalls, 1, 30),
    maxRuntimeMs: clampInteger(merged.maxRuntimeMs, 1000, 600000),
    maxEstimatedCostUsd: clampNumber(merged.maxEstimatedCostUsd, 0.01, 50),
    requiredChecks: uniqueList([
      ...commaList(merged.requiredChecks),
      ...LOCKED_GROUNDING_CHECKS
    ]).join(",")
  };
}

export function buildGeneratedProfile(draft: ProfileDraft): GeneratedProfile {
  const id = slugValue(draft.id);
  const namespaceId = slugValue(draft.namespaceId || id);
  const tags = commaList(draft.sourceTags);
  const allowedActions = commaList(draft.allowedActions);
  const approvalActions = commaList(draft.approvalActions);
  const requiredChecks = uniqueList([
    ...commaList(draft.requiredChecks),
    ...LOCKED_GROUNDING_CHECKS
  ]);
  const schemaName = pascalCase(`${id}-${draft.outputMode}`);

  return {
    id,
    namespaceId,
    name: draft.name.trim(),
    purpose: draft.purpose.trim(),
    outputMode: draft.outputMode,
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
        id: slugValue(draft.sourceId),
        adapter: draft.sourceAdapter.trim(),
        description: draft.sourceDescription.trim(),
        enabled: true,
        trustTierFloor: draft.sourceTrustTier,
        tags
      }
    ],
    retrieval: {
      mode: draft.retrievalMode,
      maxChunks: clampInteger(draft.maxChunks, 1, 30),
      allowQueryRewrite: draft.allowQueryRewrite,
      allowParallelQueries: draft.allowParallelQueries,
      rerankMode: draft.rerankMode,
      preferSourceTags: tags.slice(0, 3),
      avoidSourceTagsUnlessNeeded: ["external", "unknown", "user_provided"]
    },
    contextBudget: {
      maxContextTokens: clampInteger(draft.maxContextTokens, 1000, 120000),
      maxContextChunks: clampInteger(
        draft.maxContextChunks,
        1,
        clampInteger(draft.maxChunks, 1, 30)
      ),
      reserveOutputTokens: clampInteger(draft.reserveOutputTokens, 256, 16000),
      preferTrustedSources: true,
      preferRecentSources: true,
      isolateSourceDocuments: true
    },
    freshnessPolicy: {
      mode: draft.outputMode === "support_triage" ? "latest_wins" : "versioned",
      maxSourceAgeDays: clampInteger(draft.maxSourceAgeDays, 1, 3650),
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
      minimumAnswerTrustTier: normalizeAnswerTrustTier(draft.minimumAnswerTrustTier)
    },
    citationPolicy: {
      requireCitations: true,
      minimumCitationsForAnswer: clampInteger(draft.minimumCitationsForAnswer, 1, 10),
      minimumTrustedCitations: clampInteger(
        draft.minimumTrustedCitations,
        1,
        clampInteger(draft.minimumCitationsForAnswer, 1, 10)
      ),
      allowUncitedSummary: false,
      requireExactChunkCitations: true,
      allowedSourceKindsForCitations: draft.allowedSourceKinds
    },
    refusalPolicy: {
      refuseWhenNoEvidence: true,
      refuseWhenOnlyUntrustedEvidence: true,
      refusalMessage: draft.refusalMessage.trim()
    },
    redactionPolicy: {
      redactBeforeLogging: true,
      redactBeforeGeneration: true,
      piiClasses: ["email", "phone", "user_id", "payment", "auth_secret", "free_text_sensitive"],
      blockedSecretPatterns: ["api[_-]?key", "bearer\\s+[a-z0-9._-]+", "password\\s*="]
    },
    outputContract: {
      mode: draft.outputMode,
      schemaName,
      requireStructuredOutput: true,
      includeEvidenceSummary: true
    },
    actionPolicy: {
      mode: draft.actionMode,
      allowedActions,
      requireApprovalFor: approvalActions
    },
    costLatencyBudget: {
      maxRetrievalCalls: clampInteger(draft.maxRetrievalCalls, 1, 50),
      maxModelCalls: clampInteger(draft.maxModelCalls, 1, 30),
      maxRuntimeMs: clampInteger(draft.maxRuntimeMs, 1000, 600000),
      maxEstimatedCostUsd: clampNumber(draft.maxEstimatedCostUsd, 0.01, 50)
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
    escalationRules:
      draft.actionMode === "answer_only"
        ? []
        : [
            {
              id: "human_review_required",
              description: "Escalate profile actions that require operator approval.",
              trigger: "action requires approval or evidence is missing",
              destination: "human_review"
            }
          ],
    evals: {
      goldenSetPath: draft.goldenSetPath.trim(),
      adversarialSetPath: draft.adversarialSetPath.trim(),
      requiredChecks
    }
  };
}

export function profileDraftIssues(draft: ProfileDraft): readonly ProfileDraftIssue[] {
  const profile = buildGeneratedProfile(draft);
  const issues: ProfileDraftIssue[] = [];

  pushCheck(
    issues,
    Boolean(profile.id && profile.namespaceId && profile.name && profile.purpose),
    "Identity",
    "Profile id, namespace, name, and purpose are complete."
  );
  pushCheck(
    issues,
    profile.corpusSources.length > 0 && Boolean(draft.sourceAdapter.trim()),
    "Source",
    "One enabled corpus source is configured.",
    "Set a source key, adapter id, and description for the main knowledge source."
  );
  pushCheck(
    issues,
    draft.allowedSourceKinds.length > 0,
    "Citable source types",
    "At least one source kind can be used for final citations.",
    "Select at least one source kind, or retrieved evidence cannot become citations."
  );
  pushCheck(
    issues,
    meetsAnswerTrustFloor(
      draft.sourceTrustTier,
      normalizeAnswerTrustTier(draft.minimumAnswerTrustTier)
    ),
    "Source trust",
    "The main source can produce evidence that satisfies the answer trust floor.",
    "The source trust floor is weaker than the answer evidence floor, so answers will refuse unless another source supplies trusted evidence."
  );
  pushCheck(
    issues,
    draft.minimumCitationsForAnswer >= 1 &&
      draft.minimumTrustedCitations >= 1 &&
      draft.minimumTrustedCitations <= draft.minimumCitationsForAnswer,
    "Evidence floor",
    "Minimum cited evidence and trusted evidence are enforceable.",
    "Trusted evidence must be at least 1 and cannot exceed total cited evidence."
  );
  pushCheck(
    issues,
    new Set(profile.evals.requiredChecks as readonly string[]).has("grounding_faithfulness"),
    "Claim coverage",
    "Every material claim is covered by grounding rules and eval checks.",
    "Keep grounding_faithfulness in required checks so citations are not the only safety gate."
  );
  pushCheck(
    issues,
    draft.maxContextChunks >= 1 && draft.maxContextChunks <= draft.maxChunks,
    "Context budget",
    "Context chunks fit inside retrieval chunk limits.",
    "Chunks sent to the model cannot exceed chunks fetched from search."
  );
  pushCheck(
    issues,
    draft.actionMode === "answer_only" ||
      (commaList(draft.allowedActions).length > 0 &&
        (draft.actionMode !== "human_approval_required" ||
          commaList(draft.approvalActions).length > 0)),
    "Action policy",
    "Action drafting has allowed action ids and approval ids when needed.",
    "If actions are enabled, list allowed action ids and approval-required ids."
  );
  pushCheck(
    issues,
    draft.requiredChecks.split(",").filter((entry) => entry.trim()).length >= 5,
    "Regression gate",
    "Core regression checks are listed.",
    "List the required eval checks that must pass before this profile is trusted."
  );

  if (draft.retrievalMode === "vector" || draft.retrievalMode === "hybrid") {
    issues.push({
      tone: "warning",
      label: "Vector readiness",
      detail:
        "This profile needs embedding and vector storage config before the service can run it."
    });
  }

  if (draft.rerankMode === "model") {
    issues.push({
      tone: "warning",
      label: "Rerank provider",
      detail: "Model reranking needs a configured rerank provider before startup checks pass."
    });
  }

  return issues;
}

export function slugValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function profileJson(profile: GeneratedProfile): string {
  return `${JSON.stringify(profile, null, 2)}\n`;
}

export function profileFilePath(profileId: string): string {
  return `profiles/${slugValue(profileId)}/${slugValue(profileId)}.profile.json`;
}

function cloneDraft(draft: ProfileDraft): ProfileDraft {
  return {
    ...draft,
    allowedSourceKinds: [...draft.allowedSourceKinds]
  };
}

function normalizeSourceKinds(value: unknown): readonly SourceKind[] {
  const sourceKinds = Array.isArray(value)
    ? value.filter((entry): entry is SourceKind => isSourceKind(entry))
    : [];
  return sourceKinds.length > 0
    ? uniqueList(sourceKinds)
    : DEFAULT_PROFILE_DRAFT.allowedSourceKinds;
}

function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === "string" && SOURCE_KIND_OPTIONS.includes(value as SourceKind);
}

function normalizeTrustTier(value: unknown, fallback: TrustTier): TrustTier {
  return typeof value === "string" && TRUST_TIER_OPTIONS.includes(value as TrustTier)
    ? (value as TrustTier)
    : fallback;
}

function normalizeAnswerTrustTier(value: unknown): TrustTier {
  return typeof value === "string" && ANSWER_TRUST_TIER_OPTIONS.includes(value as TrustTier)
    ? (value as TrustTier)
    : DEFAULT_PROFILE_DRAFT.minimumAnswerTrustTier;
}

function meetsAnswerTrustFloor(sourceTier: TrustTier, minimumTier: TrustTier): boolean {
  return TRUST_TIER_RANK[sourceTier] <= TRUST_TIER_RANK[minimumTier];
}

function commaList(value: string): readonly string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniqueList<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

function clampInteger(value: number, min: number, max: number): number {
  const parsed = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.min(max, Math.max(min, parsed));
}

function clampNumber(value: number, min: number, max: number): number {
  const parsed = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, parsed));
}

function pascalCase(value: string): string {
  const words = value.split(/[^a-z0-9]+/i).filter(Boolean);
  return words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join("");
}

function pushCheck(
  issues: ProfileDraftIssue[],
  passed: boolean,
  label: string,
  detail: string,
  failedDetail = `${label} needs attention before export.`
): void {
  issues.push({
    tone: passed ? "success" : "error",
    label,
    detail: passed ? detail : failedDetail
  });
}
