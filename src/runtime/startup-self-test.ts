import type { ContextBuildResult } from "../context/context-types.js";
import type { RagChunk } from "../documents/chunk.js";
import type { EmbeddingAdapter } from "../embeddings/embedding-types.js";
import type { VisualEmbeddingAdapter } from "../embeddings/visual-embedding-types.js";
import type { ChunkStore } from "../indexing/chunk-store.js";
import type { VectorStore } from "../indexing/vector-store.js";
import type { VisualVectorStore } from "../indexing/visual-vector-store.js";
import type { ModelAdapter } from "../model/model-types.js";
import type { ValidatedRagProfile } from "../profiles/profile-validation.js";
import type { Reranker } from "../retrieval/reranker.js";
import type { RetrievalCandidate } from "../retrieval/retrieval-types.js";
import { hashText } from "../shared/hash.js";
import { redactText } from "../shared/provider-boundary.js";
import type { LiveAssembledRagRuntime } from "./live-runtime-config.js";

type StartupModelInput = Parameters<ModelAdapter["generate"]>[0]["input"];
type StartupGenerationContract = StartupModelInput["contract"];
type StartupDraft = NonNullable<Awaited<ReturnType<ModelAdapter["generate"]>>["draft"]>;
type StartupGroundingJudgeRequest = Parameters<
  NonNullable<LiveAssembledRagRuntime["groundingJudge"]>["judge"]
>[0];
type StartupAnswerValidationResult = StartupGroundingJudgeRequest["validation"];

export type StartupSelfTestStatus = "passed" | "failed";
export type StartupSelfTestCheckStatus = "passed" | "failed" | "skipped";
export type StartupSelfTestCheckKind = "capability" | "provider_probe" | "storage";

export interface StartupSelfTestOptions {
  readonly probeProviders?: boolean;
  readonly requestedAt?: string;
}

export interface StartupSelfTestCheck {
  readonly id: string;
  readonly kind: StartupSelfTestCheckKind;
  readonly status: StartupSelfTestCheckStatus;
  readonly message: string;
  readonly provider?: string;
  readonly modelName?: string;
  readonly warnings?: readonly string[];
}

export interface StartupSelfTestResult {
  readonly status: StartupSelfTestStatus;
  readonly checkedAt: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly retrievalMode: ValidatedRagProfile["retrieval"]["mode"];
  readonly probeProviders: boolean;
  readonly checkCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
  readonly checks: readonly StartupSelfTestCheck[];
}

export interface StartupSelfTestTarget {
  readonly profile: ValidatedRagProfile;
  readonly runtime: LiveAssembledRagRuntime;
  readonly chunkStore?: ChunkStore;
  readonly vectorStore?: VectorStore;
  readonly visualVectorStore?: VisualVectorStore;
}

export async function runStartupSelfTest(
  target: StartupSelfTestTarget,
  options: StartupSelfTestOptions = {}
): Promise<StartupSelfTestResult> {
  const checkedAt = options.requestedAt ?? new Date().toISOString();
  const probeProviders = options.probeProviders === true;
  const checks: StartupSelfTestCheck[] = [
    ...capabilityChecks(target),
    ...(await storageChecks(target)),
    ...(probeProviders
      ? await providerProbeChecks(target, checkedAt)
      : skippedProviderProbes(target))
  ];
  const failedCount = checks.filter((check) => check.status === "failed").length;
  const skippedCount = checks.filter((check) => check.status === "skipped").length;

  return {
    status: failedCount === 0 ? "passed" : "failed",
    checkedAt,
    profileId: target.profile.id,
    namespaceId: target.profile.namespaceId,
    retrievalMode: target.profile.retrieval.mode,
    probeProviders,
    checkCount: checks.length,
    failedCount,
    skippedCount,
    checks
  };
}

async function storageChecks(
  target: StartupSelfTestTarget
): Promise<readonly StartupSelfTestCheck[]> {
  const checks: StartupSelfTestCheck[] = [];
  checks.push(...(await optionalReadinessChecks("index", target.chunkStore)));
  checks.push(...(await optionalReadinessChecks("vector", target.vectorStore)));
  checks.push(...(await optionalReadinessChecks("visual_vector", target.visualVectorStore)));
  return checks;
}

async function optionalReadinessChecks(
  prefix: string,
  value: unknown
): Promise<readonly StartupSelfTestCheck[]> {
  if (!hasReadinessCheck(value)) {
    return [
      skipped(
        `${prefix}_storage_readiness`,
        "storage",
        "Storage backend does not expose an extended readiness check."
      )
    ];
  }

  try {
    const result = await value.readinessCheck();
    return result.checks.map((check) =>
      check.status === "passed"
        ? passed(`${prefix}_${check.id}`, "storage", check.message)
        : failed(`${prefix}_${check.id}`, "storage", check.message)
    );
  } catch (error) {
    return [
      failed(
        `${prefix}_storage_readiness`,
        "storage",
        error instanceof Error ? error.message : "Storage readiness check failed."
      )
    ];
  }
}

function hasReadinessCheck(value: unknown): value is {
  readonly readinessCheck: () => Promise<{
    readonly checks: readonly {
      readonly id: string;
      readonly status: "passed" | "failed";
      readonly message: string;
    }[];
  }>;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readinessCheck?: unknown }).readinessCheck === "function"
  );
}

function capabilityChecks(target: StartupSelfTestTarget): readonly StartupSelfTestCheck[] {
  const checks: StartupSelfTestCheck[] = [];
  const mode = target.profile.retrieval.mode;
  const retrieverModes = target.runtime.retriever.capabilities.modes;

  checks.push(
    retrieverModes.includes(mode)
      ? passed("retriever_supports_profile_mode", "capability", `Retriever can serve ${mode}.`)
      : failed(
          "retriever_supports_profile_mode",
          "capability",
          `Retriever cannot serve profile retrieval mode ${mode}.`
        )
  );

  if (mode === "vector" || mode === "hybrid") {
    checks.push(
      target.runtime.embeddingAdapter && target.vectorStore
        ? passed(
            "vector_retrieval_components",
            "capability",
            "Vector retrieval has an embedding adapter and vector store."
          )
        : failed(
            "vector_retrieval_components",
            "capability",
            "Vector retrieval requires an embedding adapter and vector store."
          )
    );
  } else {
    checks.push(
      skipped(
        "vector_retrieval_components",
        "capability",
        `Profile retrieval mode ${mode} does not require vector retrieval components.`
      )
    );
  }

  checks.push(vectorDimensionCheck(target.runtime.embeddingAdapter, target.vectorStore));

  if (mode === "visual") {
    checks.push(
      target.runtime.visualEmbeddingAdapter && target.visualVectorStore
        ? passed(
            "visual_retrieval_components",
            "capability",
            "Visual retrieval has a visual embedding adapter and visual vector store."
          )
        : failed(
            "visual_retrieval_components",
            "capability",
            "Visual retrieval requires a visual embedding adapter and visual vector store."
          )
    );
  } else {
    checks.push(
      skipped(
        "visual_retrieval_components",
        "capability",
        `Profile retrieval mode ${mode} does not require visual retrieval components.`
      )
    );
  }

  checks.push(
    vectorDimensionCheck(
      target.runtime.visualEmbeddingAdapter,
      target.visualVectorStore,
      "visual_vector_dimensions_match_adapter"
    )
  );

  if (target.profile.retrieval.rerankMode === "model") {
    checks.push(
      target.runtime.reranker?.mode === "model"
        ? passed("model_reranker_configured", "capability", "Model reranker is configured.")
        : failed(
            "model_reranker_configured",
            "capability",
            "Profile requires model reranking but no model reranker is configured."
          )
    );
  } else {
    checks.push(
      skipped(
        "model_reranker_configured",
        "capability",
        `Profile rerank mode is ${target.profile.retrieval.rerankMode}.`
      )
    );
  }

  checks.push(
    target.runtime.groundingJudge
      ? passed("grounding_judge_configured", "capability", "Grounding judge is configured.")
      : skipped(
          "grounding_judge_configured",
          "capability",
          "No grounding judge is configured for this runtime."
        )
  );

  return checks;
}

function vectorDimensionCheck(
  adapter: { readonly dimensions: number } | undefined,
  store: { readonly capabilities: { readonly dimensions?: number } } | undefined,
  id = "vector_dimensions_match_adapter"
): StartupSelfTestCheck {
  if (!adapter || !store) {
    return skipped(id, "capability", "Dimension check skipped because one side is not configured.");
  }

  const storeDimensions = store.capabilities.dimensions;
  if (storeDimensions === undefined) {
    return passed(id, "capability", "Store does not declare fixed dimensions.");
  }

  return storeDimensions === adapter.dimensions
    ? passed(id, "capability", `Store dimensions match adapter dimensions ${adapter.dimensions}.`)
    : failed(
        id,
        "capability",
        `Store dimensions ${storeDimensions} do not match adapter dimensions ${adapter.dimensions}.`
      );
}

async function providerProbeChecks(
  target: StartupSelfTestTarget,
  requestedAt: string
): Promise<readonly StartupSelfTestCheck[]> {
  const checks: StartupSelfTestCheck[] = [];

  checks.push(await probeModel(target.runtime.model, target.profile, requestedAt));

  if (target.runtime.embeddingAdapter) {
    checks.push(await probeEmbedding(target.runtime.embeddingAdapter, requestedAt));
  } else {
    checks.push(
      skipped("embedding_provider_probe", "provider_probe", "No embedding adapter is configured.")
    );
  }

  if (target.runtime.visualEmbeddingAdapter) {
    checks.push(
      await probeVisualEmbeddingAssets(target.runtime.visualEmbeddingAdapter, requestedAt)
    );
    checks.push(
      await probeVisualEmbeddingQuery(target.runtime.visualEmbeddingAdapter, requestedAt)
    );
  } else {
    checks.push(
      skipped(
        "visual_embedding_provider_asset_probe",
        "provider_probe",
        "No visual embedding adapter is configured."
      ),
      skipped(
        "visual_embedding_provider_query_probe",
        "provider_probe",
        "No visual embedding adapter is configured."
      )
    );
  }

  if (target.runtime.reranker?.mode === "model") {
    checks.push(await probeReranker(target.runtime.reranker, target.profile, requestedAt));
  } else {
    checks.push(
      skipped("rerank_provider_probe", "provider_probe", "No model reranker is configured.")
    );
  }

  if (target.runtime.groundingJudge) {
    checks.push(await probeGroundingJudge(target, requestedAt));
  } else {
    checks.push(
      skipped(
        "grounding_judge_provider_probe",
        "provider_probe",
        "No grounding judge is configured."
      )
    );
  }

  return checks;
}

function skippedProviderProbes(target: StartupSelfTestTarget): readonly StartupSelfTestCheck[] {
  return [
    skipped("model_provider_probe", "provider_probe", "Provider probes were not requested."),
    skipped("embedding_provider_probe", "provider_probe", "Provider probes were not requested."),
    skipped(
      "visual_embedding_provider_asset_probe",
      "provider_probe",
      target.runtime.visualEmbeddingAdapter
        ? "Provider probes were not requested."
        : "No visual embedding adapter is configured."
    ),
    skipped(
      "visual_embedding_provider_query_probe",
      "provider_probe",
      target.runtime.visualEmbeddingAdapter
        ? "Provider probes were not requested."
        : "No visual embedding adapter is configured."
    ),
    skipped("rerank_provider_probe", "provider_probe", "Provider probes were not requested."),
    skipped(
      "grounding_judge_provider_probe",
      "provider_probe",
      "Provider probes were not requested."
    )
  ];
}

async function probeModel(
  model: ModelAdapter,
  profile: ValidatedRagProfile,
  requestedAt: string
): Promise<StartupSelfTestCheck> {
  try {
    const result = await model.generate({
      requestId: "startup_model_probe",
      profileId: profile.id,
      namespaceId: profile.namespaceId,
      modelTier: profile.modelPolicy.defaultTierByRole.answer_generation,
      input: {
        question: "RAG startup self-test.",
        contextText: "[SOURCE startup_probe_chunk]\nStartup self-test evidence.\n[/SOURCE]",
        groundingRules: ["Return only a minimal sourced answer for startup validation."],
        contract: startupContract()
      },
      requestedAt
    });

    if (result.status === "failed" || result.draft === undefined) {
      return failedProvider(
        "model_provider_probe",
        model,
        result.errorMessage ?? "Model provider did not return a usable draft.",
        result.warnings
      );
    }

    return passedProvider(
      "model_provider_probe",
      model,
      "Model provider returned a parseable startup draft.",
      result.warnings
    );
  } catch (error) {
    return failedProvider(
      "model_provider_probe",
      model,
      safeErrorMessage(error, "Model provider startup probe failed.")
    );
  }
}

async function probeEmbedding(
  adapter: EmbeddingAdapter,
  requestedAt: string
): Promise<StartupSelfTestCheck> {
  try {
    const result = await adapter.embed({
      inputs: [{ id: "startup_embedding_probe", text: "RAG startup self-test." }],
      requestedAt
    });

    if (result.status === "failed" || result.embeddings.length !== 1) {
      return failedProvider(
        "embedding_provider_probe",
        adapter,
        result.errorMessage ?? "Embedding provider did not return one startup vector.",
        result.warnings
      );
    }

    const vector = result.embeddings[0]?.vector;
    if (vector?.length !== adapter.dimensions) {
      return failedProvider(
        "embedding_provider_probe",
        adapter,
        "Embedding provider vector dimensions do not match adapter dimensions.",
        result.warnings
      );
    }

    return passedProvider(
      "embedding_provider_probe",
      adapter,
      "Embedding provider returned one valid startup vector.",
      result.warnings
    );
  } catch (error) {
    return failedProvider(
      "embedding_provider_probe",
      adapter,
      safeErrorMessage(error, "Embedding provider startup probe failed.")
    );
  }
}

async function probeVisualEmbeddingAssets(
  adapter: VisualEmbeddingAdapter,
  requestedAt: string
): Promise<StartupSelfTestCheck> {
  try {
    const result = await adapter.embedVisualAssets({
      inputs: [
        {
          id: "startup_visual_asset_probe",
          chunkId: "startup_probe_chunk",
          documentId: "startup_probe_document",
          mediaType: "text/plain",
          visualAssetId: "startup_probe_asset",
          text: "RAG startup visual self-test."
        }
      ],
      requestedAt
    });

    if (result.status === "failed" || result.embeddings.length !== 1) {
      return failedProvider(
        "visual_embedding_provider_asset_probe",
        adapter,
        result.errorMessage ?? "Visual embedding provider did not return one startup embedding.",
        result.warnings
      );
    }

    const invalid = result.embeddings[0]?.vectors.some(
      (vector) => vector.length !== adapter.dimensions
    );
    if (invalid) {
      return failedProvider(
        "visual_embedding_provider_asset_probe",
        adapter,
        "Visual embedding provider asset vectors do not match adapter dimensions.",
        result.warnings
      );
    }

    return passedProvider(
      "visual_embedding_provider_asset_probe",
      adapter,
      "Visual embedding provider returned one valid asset embedding.",
      result.warnings
    );
  } catch (error) {
    return failedProvider(
      "visual_embedding_provider_asset_probe",
      adapter,
      safeErrorMessage(error, "Visual asset embedding provider startup probe failed.")
    );
  }
}

async function probeVisualEmbeddingQuery(
  adapter: VisualEmbeddingAdapter,
  requestedAt: string
): Promise<StartupSelfTestCheck> {
  try {
    const result = await adapter.embedQuery({
      query: "RAG startup visual self-test.",
      requestedAt
    });

    if (result.status === "failed" || result.vectors.length === 0) {
      return failedProvider(
        "visual_embedding_provider_query_probe",
        adapter,
        result.errorMessage ?? "Visual embedding provider did not return query vectors.",
        result.warnings
      );
    }

    if (result.vectors.some((vector) => vector.length !== adapter.dimensions)) {
      return failedProvider(
        "visual_embedding_provider_query_probe",
        adapter,
        "Visual embedding provider query vectors do not match adapter dimensions.",
        result.warnings
      );
    }

    return passedProvider(
      "visual_embedding_provider_query_probe",
      adapter,
      "Visual embedding provider returned valid query vectors.",
      result.warnings
    );
  } catch (error) {
    return failedProvider(
      "visual_embedding_provider_query_probe",
      adapter,
      safeErrorMessage(error, "Visual query embedding provider startup probe failed.")
    );
  }
}

async function probeReranker(
  reranker: Reranker,
  profile: ValidatedRagProfile,
  requestedAt: string
): Promise<StartupSelfTestCheck> {
  const candidate = startupCandidate(profile, requestedAt);
  try {
    const result = await reranker.rerank({
      profile: {
        id: profile.id,
        namespaceId: profile.namespaceId,
        modelTier: profile.modelPolicy.defaultTierByRole.context_evaluation,
        allowModelFallback: false
      },
      query: "RAG startup self-test.",
      candidates: [candidate],
      topK: 1,
      rerankId: "startup_rerank_probe",
      requestedAt
    });

    if (result.candidates.length !== 1) {
      return failed(
        "rerank_provider_probe",
        "provider_probe",
        "Rerank provider did not return one startup candidate.",
        {
          ...(result.trace.provider === undefined ? {} : { provider: result.trace.provider }),
          ...(result.trace.modelName === undefined ? {} : { modelName: result.trace.modelName }),
          warnings: result.trace.warningCodes
        }
      );
    }

    return passed(
      "rerank_provider_probe",
      "provider_probe",
      "Rerank provider returned one startup score.",
      {
        ...(result.trace.provider === undefined ? {} : { provider: result.trace.provider }),
        ...(result.trace.modelName === undefined ? {} : { modelName: result.trace.modelName }),
        warnings: result.trace.warningCodes
      }
    );
  } catch (error) {
    return failed(
      "rerank_provider_probe",
      "provider_probe",
      safeErrorMessage(error, "Rerank provider startup probe failed.")
    );
  }
}

async function probeGroundingJudge(
  target: StartupSelfTestTarget,
  requestedAt: string
): Promise<StartupSelfTestCheck> {
  const context = startupContext(target.profile, requestedAt);
  const draft: StartupDraft = {
    answer: "Startup self-test evidence is present.",
    citationChunkIds: ["startup_probe_chunk"],
    evidenceSummary: "Startup self-test evidence is present.",
    confidence: "high"
  };
  const validation = startupValidation(target.profile, context, requestedAt);

  try {
    const result = await target.runtime.groundingJudge?.judge({
      profile: target.profile,
      context,
      question: "RAG startup self-test.",
      draft,
      validation,
      judgeId: "startup_grounding_judge_probe",
      requestedAt
    });

    if (result === undefined || result.verdict === "failed") {
      return failed(
        "grounding_judge_provider_probe",
        "provider_probe",
        "Grounding judge did not return a safe startup verdict."
      );
    }

    return passed(
      "grounding_judge_provider_probe",
      "provider_probe",
      "Grounding judge returned a safe startup verdict.",
      {
        provider: result.provider,
        modelName: result.modelName,
        warnings: result.warnings
      }
    );
  } catch (error) {
    return failed(
      "grounding_judge_provider_probe",
      "provider_probe",
      safeErrorMessage(error, "Grounding judge startup probe failed.")
    );
  }
}

function startupContract(): StartupGenerationContract {
  return {
    schemaName: "StartupSelfTestSourcedAnswer",
    outputMode: "sourced_answer",
    requireStructuredOutput: true,
    requireCitations: true,
    requireEvidenceSummary: true,
    allowedCitationChunkIds: ["startup_probe_chunk"],
    minimumCitations: 1,
    minimumTrustedCitations: 1,
    maxOutputTokens: 128,
    actionMode: "answer_only",
    allowedActions: [],
    requireApprovalFor: []
  };
}

function startupCandidate(profile: ValidatedRagProfile, requestedAt: string): RetrievalCandidate {
  const chunk = startupChunk(profile, requestedAt);
  return {
    chunk,
    score: 1,
    rank: 1,
    matchedTerms: ["startup"],
    citation: chunk.citation,
    reasons: ["startup_self_test"]
  };
}

function startupContext(profile: ValidatedRagProfile, requestedAt: string): ContextBuildResult {
  const candidate = startupCandidate(profile, requestedAt);
  const block = {
    index: 0,
    boundaryLabel: "SOURCE startup_probe_chunk",
    chunkId: candidate.chunk.id,
    documentId: candidate.chunk.documentId,
    namespaceId: profile.namespaceId,
    text: candidate.chunk.text,
    textHash: candidate.chunk.textHash,
    tokenEstimate: 8,
    score: candidate.score,
    retrievalRank: candidate.rank,
    matchedTerms: candidate.matchedTerms,
    citation: candidate.citation,
    provenance: candidate.chunk.provenance,
    safetyFlags: [],
    requiresHumanReview: false,
    redacted: false
  };

  return {
    blocks: [block],
    citations: [candidate.citation],
    rejected: [],
    evidence: {
      status: "answerable",
      canAttemptAnswer: true,
      blockCount: 1,
      citationCount: 1,
      trustedCitationCount: 1,
      requiresHumanReviewCount: 0,
      sourceIds: ["startup_self_test"],
      trustTiers: ["trusted_internal"]
    },
    trace: {
      contextId: "startup_context_probe",
      retrievalId: "startup_retrieval_probe",
      profileId: profile.id,
      namespaceId: profile.namespaceId,
      startedAt: requestedAt,
      finishedAt: requestedAt,
      candidateCount: 1,
      blockCount: 1,
      rejectedCount: 0,
      totalTokenEstimate: 8,
      redactionCount: 0,
      maxContextTokens: profile.contextBudget.maxContextTokens,
      maxContextChunks: profile.contextBudget.maxContextChunks,
      sourceIds: ["startup_self_test"],
      chunkIds: ["startup_probe_chunk"],
      rejectionCodes: []
    },
    totalTokenEstimate: 8
  };
}

function startupValidation(
  profile: ValidatedRagProfile,
  context: ContextBuildResult,
  requestedAt: string
): StartupAnswerValidationResult {
  return {
    valid: true,
    issues: [],
    errors: [],
    warnings: [],
    citedChunkIds: ["startup_probe_chunk"],
    unknownCitationChunkIds: [],
    trace: {
      contextId: context.trace.contextId,
      retrievalId: context.trace.retrievalId,
      profileId: profile.id,
      namespaceId: profile.namespaceId,
      startedAt: requestedAt,
      finishedAt: requestedAt,
      citedChunkIds: ["startup_probe_chunk"],
      unknownCitationChunkIds: [],
      errorCount: 0,
      warningCount: 0,
      relationshipPathCitationCount: 0,
      relationshipPathEdgeCount: 0,
      relationshipPathMaxDepth: 0,
      invalidRelationshipPathCount: 0,
      missingRelationshipEdgeEvidenceCount: 0
    }
  };
}

function startupChunk(profile: ValidatedRagProfile, requestedAt: string): RagChunk {
  const text = "Startup self-test evidence is present.";
  const textHash = hashText(text);
  return {
    id: "startup_probe_chunk",
    documentId: "startup_probe_document",
    namespaceId: profile.namespaceId,
    text,
    index: 0,
    textHash,
    characterStart: 0,
    characterEnd: text.length,
    tokenEstimate: 8,
    safetyFlags: [],
    provenance: {
      sourceId: "startup_self_test",
      sourceKind: "derived_summary",
      title: "Startup Self-Test",
      ingestedAt: requestedAt,
      capturedAt: requestedAt,
      trustTier: "trusted_internal",
      sensitivity: "internal",
      checksum: textHash
    },
    citation: {
      sourceId: "startup_self_test",
      chunkId: "startup_probe_chunk",
      title: "Startup Self-Test",
      locator: "startup self-test"
    },
    accessScope: {
      tenantId: "startup_tenant",
      namespaceId: profile.namespaceId
    }
  };
}

function passed(
  id: string,
  kind: StartupSelfTestCheckKind,
  message: string,
  details: {
    readonly provider?: string;
    readonly modelName?: string;
    readonly warnings?: readonly string[];
  } = {}
): StartupSelfTestCheck {
  return {
    id,
    kind,
    status: "passed",
    message,
    ...providerDetails(details)
  };
}

function failed(
  id: string,
  kind: StartupSelfTestCheckKind,
  message: string,
  details: {
    readonly provider?: string;
    readonly modelName?: string;
    readonly warnings?: readonly string[];
  } = {}
): StartupSelfTestCheck {
  return {
    id,
    kind,
    status: "failed",
    message: redactText(message),
    ...providerDetails(details)
  };
}

function skipped(
  id: string,
  kind: StartupSelfTestCheckKind,
  message: string
): StartupSelfTestCheck {
  return {
    id,
    kind,
    status: "skipped",
    message
  };
}

function passedProvider(
  id: string,
  provider: { readonly provider: string; readonly modelName: string },
  message: string,
  warnings: readonly string[] = []
): StartupSelfTestCheck {
  return passed(id, "provider_probe", message, {
    provider: provider.provider,
    modelName: provider.modelName,
    warnings
  });
}

function failedProvider(
  id: string,
  provider: { readonly provider: string; readonly modelName: string },
  message: string,
  warnings: readonly string[] = []
): StartupSelfTestCheck {
  return failed(id, "provider_probe", message, {
    provider: provider.provider,
    modelName: provider.modelName,
    warnings
  });
}

function providerDetails(details: {
  readonly provider?: string;
  readonly modelName?: string;
  readonly warnings?: readonly string[];
}): {
  readonly provider?: string;
  readonly modelName?: string;
  readonly warnings?: readonly string[];
} {
  return {
    ...(details.provider === undefined ? {} : { provider: details.provider }),
    ...(details.modelName === undefined ? {} : { modelName: details.modelName }),
    ...(details.warnings === undefined || details.warnings.length === 0
      ? {}
      : { warnings: details.warnings.map((warning) => redactText(warning)) })
  };
}

function safeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return redactText(error.message);
  }

  return fallback;
}
