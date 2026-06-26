import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ContextRejectionCode } from "../context/context-types.js";
import type { CorpusAdapter, CorpusLoadRequest, CorpusLoadResult } from "../corpus/adapter.js";
import { CorpusAdapterRegistry } from "../corpus/adapter-registry.js";
import type { CorpusRecord } from "../corpus/corpus-record.js";
import type { ChunkSafetyFlag, RagChunk } from "../documents/chunk.js";
import {
  DOCUMENT_VISUAL_ASSET_KINDS,
  isDocumentLayoutRelationKind,
  isDocumentLayoutStrategy,
  isLayoutCoordinateUnit,
  isLayoutRegionKind,
  type DocumentLayout,
  type DocumentLayoutPage,
  type DocumentLayoutRelation,
  type DocumentLayoutRegion,
  type DocumentTable,
  type DocumentTableCell,
  type DocumentVisualAsset,
  type LayoutBox,
  type LayoutMetadata
} from "../documents/layout.js";
import { isSourceKind, type SourceKind } from "../documents/provenance.js";
import { isSourceSensitivity, isTrustTier, type TrustTier } from "../documents/trust-tier.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import type { IndexFilter } from "../indexing/index-types.js";
import { IngestPipeline } from "../ingestion/ingest-pipeline.js";
import { FakeModelAdapter, type FakeModelAdapterOptions } from "../model/fake-model-adapter.js";
import type { RagProfile } from "../profiles/profile.js";
import { assertValidProfile, type ValidatedRagProfile } from "../profiles/profile-validation.js";
import type { RetrievalMode } from "../retrieval/retrieval-types.js";
import { setupLocalEvalKnowledgeMap } from "../runtime/eval-knowledge-map.js";
import { createLocalEvalRuntime } from "../runtime/eval-runtime-factory.js";
import type { RagAnswerResult } from "../runtime/runtime-types.js";
import type { AccessScope, RequestPrincipal } from "../security/access-scope.js";
import type {
  EvalIndexFilterOverrides,
  EvalRetrievalMode,
  LoadedRagEvalCase,
  RagEvalCase,
  RagEvalCaseResult,
  RagEvalCheck,
  RagEvalExtractionFixture,
  RagEvalExpectation,
  RagEvalKnowledgeMapEntityFixture,
  RagEvalKnowledgeMapFixture,
  RagEvalKnowledgeMapRelationFixture,
  RagEvalModelOptions,
  RagEvalRelationshipEdgeExpectation,
  RagEvalRelationshipPathExpectation,
  RagEvalRunSummary,
  RagEvalSetKind,
  RagEvalSuiteResult
} from "./eval-types.js";
import { runEvalExtractionQuality } from "./extraction-quality.js";
import { RUNTIME_EVAL_CHECKS } from "./eval-types.js";
import { checkRelationshipClaimGrounding } from "./relationship-claim-grounding.js";
import { RetrievalBenchmarkRunner } from "./retrieval-benchmark-runner.js";

const DEFAULT_EVAL_NOW = "2026-06-23T12:00:00.000Z";

const RAG_RUN_STATUSES = [
  "succeeded",
  "human_review_required",
  "refused",
  "model_failed",
  "validation_failed",
  "retrieval_failed",
  "context_failed",
  "generation_failed"
] as const;

const CONTEXT_EVIDENCE_STATUSES = [
  "answerable",
  "no_evidence",
  "insufficient_citations",
  "insufficient_trusted_citations"
] as const;

const CONTEXT_REJECTION_CODES = [
  "duplicate_chunk",
  "namespace_mismatch",
  "missing_exact_citation",
  "disallowed_source_kind",
  "disallowed_trust_tier",
  "missing_freshness_metadata",
  "stale_source",
  "unsafe_prompt_injection",
  "unsafe_secret",
  "citation_duplicate",
  "lexical_duplicate",
  "secondary_source_duplicate",
  "context_chunk_limit_exceeded",
  "context_token_limit_exceeded"
] as const;

const RETRIEVAL_MODES = ["keyword", "vector", "hybrid", "visual"] as const;
const EVAL_RETRIEVAL_MODES = ["profile", "keyword", "visual"] as const;
const GRAPH_FACT_STRENGTHS = [
  "explicit_fact",
  "inferred_fact",
  "co_mention",
  "semantic_association"
] as const;
const GRAPH_PROPOSAL_STATUSES = [
  "proposed",
  "verified",
  "needs_review",
  "rejected",
  "approved",
  "superseded"
] as const;
const GRAPH_VERIFICATION_STATUSES = [
  "not_checked",
  "supported",
  "unsupported",
  "ambiguous",
  "contradicted"
] as const;

const CHUNK_SAFETY_FLAGS = [
  "possible_prompt_injection",
  "secret_like_text",
  "sensitive_personal_data",
  "oversized_chunk"
] as const satisfies readonly ChunkSafetyFlag[];

export interface RunProfileEvalSuitesRequest {
  readonly profiles: readonly RagProfile[];
  readonly projectRoot?: string;
  readonly now?: () => string;
}

export interface RunProfileEvalSuiteRequest {
  readonly profile: RagProfile;
  readonly projectRoot?: string;
  readonly now?: () => string;
}

export class RagEvalParseError extends Error {
  constructor(
    message: string,
    readonly filePath: string,
    readonly lineNumber?: number
  ) {
    super(
      lineNumber === undefined ? `${filePath}: ${message}` : `${filePath}:${lineNumber}: ${message}`
    );
    this.name = "RagEvalParseError";
  }
}

export async function runProfileEvalSuites(
  request: RunProfileEvalSuitesRequest
): Promise<RagEvalRunSummary> {
  const suites: RagEvalSuiteResult[] = [];

  for (const profile of request.profiles) {
    suites.push(
      await runProfileEvalSuite({
        profile,
        ...(request.projectRoot ? { projectRoot: request.projectRoot } : {}),
        ...(request.now ? { now: request.now } : {})
      })
    );
  }

  const failures = suites.flatMap((suite) =>
    suite.failures.map((failure) => `${suite.profileId}: ${failure}`)
  );

  return {
    passed: failures.length === 0,
    suiteCount: suites.length,
    caseCount: suites.reduce((count, suite) => count + suite.caseCount, 0),
    failures,
    suites
  };
}

export async function runProfileEvalSuite(
  request: RunProfileEvalSuiteRequest
): Promise<RagEvalSuiteResult> {
  const profile = assertValidProfile(request.profile);
  const projectRoot = request.projectRoot ?? process.cwd();
  const goldenSetPath = resolveEvalPath(projectRoot, profile.evals.goldenSetPath);
  const adversarialSetPath = resolveEvalPath(projectRoot, profile.evals.adversarialSetPath);
  const cases = [
    ...(await loadJsonlEvalCases(goldenSetPath, "golden")),
    ...(await loadJsonlEvalCases(adversarialSetPath, "adversarial"))
  ];
  const coveredChecks = uniqueSorted(cases.flatMap((evalCase) => evalCase.checks));
  const missingRequiredChecks = profile.evals.requiredChecks.filter(
    (requiredCheck) => !coveredChecks.includes(requiredCheck)
  );
  const caseResults: RagEvalCaseResult[] = [];

  for (const evalCase of cases) {
    caseResults.push(await runEvalCase(profile, evalCase, request.now ?? defaultNow));
  }

  const failures = [
    ...missingRequiredChecks.map(
      (check) => `Missing required eval check "${check}" in declared eval files.`
    ),
    ...caseResults.flatMap((result) => result.failures.map((failure) => `${result.id}: ${failure}`))
  ];

  return {
    profileId: profile.id,
    namespaceId: profile.namespaceId,
    passed: failures.length === 0,
    goldenSetPath,
    adversarialSetPath,
    requiredChecks: profile.evals.requiredChecks,
    coveredChecks,
    missingRequiredChecks,
    caseCount: cases.length,
    failures,
    cases: caseResults
  };
}

export async function loadJsonlEvalCases(
  filePath: string,
  setKind: RagEvalSetKind = "golden"
): Promise<readonly LoadedRagEvalCase[]> {
  const contents = await readFile(filePath, "utf8");
  const cases: LoadedRagEvalCase[] = [];
  const lines = contents.split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid JSON.";
      throw new RagEvalParseError(message, filePath, lineNumber);
    }

    cases.push({
      ...parseEvalCase(parsed, filePath, lineNumber),
      filePath,
      lineNumber,
      setKind
    });
  }

  if (cases.length === 0) {
    throw new RagEvalParseError("Eval file must contain at least one JSONL case.", filePath);
  }

  return cases;
}

async function runEvalCase(
  profile: ValidatedRagProfile,
  evalCase: LoadedRagEvalCase,
  now: () => string
): Promise<RagEvalCaseResult> {
  const failures: string[] = [];

  try {
    for (const check of evalCase.checks) {
      if (!isRuntimeEvalCheck(check)) {
        failures.push(`Unsupported eval check "${check}".`);
      }
    }

    const runtimeProfile = evalRuntimeProfile(profile, evalCase);
    const index = new InMemoryRagIndex({ now });
    const adapters = uniqueSorted(runtimeProfile.corpusSources.map((source) => source.adapter)).map(
      (adapterId) => new StaticEvalCorpusAdapter(adapterId, evalCase.corpus)
    );
    const pipeline = new IngestPipeline({
      adapterRegistry: new CorpusAdapterRegistry(adapters),
      documentStore: index,
      chunkStore: index,
      now
    });
    const ingest = await pipeline.ingest({
      profile: runtimeProfile,
      requestedBy: evalCase.principal,
      runId: `eval_ingest_${safeId(evalCase.id)}`,
      requestedAt: now(),
      overwriteMode: "replace"
    });

    if (ingest.rejectedRecords.length > 0) {
      failures.push(
        `Ingest rejected records: ${ingest.rejectedRecords
          .map((record) => `${record.recordId} (${record.reason})`)
          .join(", ")}.`
      );
    }

    if (ingest.normalizationIssues.some((issue) => issue.severity === "error")) {
      failures.push(
        `Ingest normalization errors: ${ingest.normalizationIssues
          .filter((issue) => issue.severity === "error")
          .map((issue) => `${issue.recordId}:${issue.code}`)
          .join(", ")}.`
      );
    }

    const filter = buildFilter(runtimeProfile, evalCase.principal, evalCase.filter);
    if (evalCase.extraction) {
      const extraction = await runEvalExtractionQuality({
        profile: runtimeProfile,
        fixture: evalCase.extraction,
        documents: ingest.documents,
        chunks: ingest.chunks,
        runId: `eval_extraction_${safeId(evalCase.id)}`,
        sourceLabel: `${evalCase.filePath}:${evalCase.lineNumber}`,
        now
      });
      failures.push(...extraction.failures);
    }

    const knowledgeMapSetup = await setupLocalEvalKnowledgeMap({
      profile: runtimeProfile,
      ...(evalCase.knowledgeMap ? { fixture: evalCase.knowledgeMap } : {}),
      documents: ingest.documents,
      chunks: ingest.chunks,
      filter,
      runId: `eval_knowledge_map_${safeId(evalCase.id)}`,
      sourceLabel: `${evalCase.filePath}:${evalCase.lineNumber}`,
      now
    });
    failures.push(...knowledgeMapSetup.failures);

    const runtimeSetup = await createLocalEvalRuntime({
      profile: runtimeProfile,
      chunkStore: index,
      documents: ingest.documents,
      chunks: ingest.chunks,
      ...(knowledgeMapSetup.retrievalStore
        ? { knowledgeMapStore: knowledgeMapSetup.retrievalStore }
        : {}),
      now
    });
    failures.push(...runtimeSetup.failures);
    const draft = evalModelDraft(evalCase, ingest.chunks);
    const answer = await runtimeSetup.runtime.answer({
      profile: runtimeProfile,
      question: evalCase.query,
      filter,
      model: new FakeModelAdapter({
        estimatedCostUsd: evalCase.model?.estimatedCostUsd ?? 0,
        ...(draft === undefined ? {} : { draft }),
        now
      }),
      topK: evalCase.topK ?? runtimeProfile.retrieval.maxChunks,
      includeRejected: true,
      runId: `eval_run_${safeId(evalCase.id)}`,
      traceId: `eval_trace_${safeId(evalCase.id)}`,
      retrievalId: `eval_retrieval_${safeId(evalCase.id)}`,
      contextId: `eval_context_${safeId(evalCase.id)}`,
      generationId: `eval_generation_${safeId(evalCase.id)}`,
      answerId: `eval_answer_${safeId(evalCase.id)}`,
      requestedAt: now()
    });

    failures.push(...assertExpectations(runtimeProfile, evalCase, answer));
    failures.push(...assertCheckSpecificExpectations(runtimeProfile, evalCase, answer));
    const metrics = new RetrievalBenchmarkRunner().evaluate(evalCase, answer);

    return {
      id: evalCase.id,
      setKind: evalCase.setKind,
      checks: evalCase.checks,
      passed: failures.length === 0,
      failures,
      status: answer.status,
      ...(hasContext(answer) ? { contextStatus: answer.context.evidence.status } : {}),
      ...(hasRetrieval(answer) ? { retrievalMode: answer.retrieval.trace.mode } : {}),
      retrievedDocumentIds: hasRetrieval(answer)
        ? uniqueSorted(answer.retrieval.candidates.map((candidate) => candidate.chunk.documentId))
        : [],
      finalCitationCount: answer.trace.finalCitations.length,
      ...(hasContext(answer) ? { visualCitationCount: visualCitationCount(answer) } : {}),
      traceId: answer.trace.traceId,
      trace: answer.trace,
      metrics
    };
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "Unknown eval runner error.");
    return {
      id: evalCase.id,
      setKind: evalCase.setKind,
      checks: evalCase.checks,
      passed: false,
      failures,
      retrievedDocumentIds: [],
      finalCitationCount: 0
    };
  }
}

function evalModelDraft(
  evalCase: LoadedRagEvalCase,
  chunks: readonly RagChunk[]
): FakeModelAdapterOptions["draft"] | undefined {
  if (
    !evalCase.model?.citationDocumentIds?.length &&
    evalCase.model?.answer === undefined &&
    evalCase.model?.evidenceSummary === undefined
  ) {
    return undefined;
  }

  const configuredCitationChunkIds = evalCase.model?.citationDocumentIds?.map((documentId) => {
    const chunk = chunks.find((candidate) => candidate.documentId === documentId);
    if (!chunk) {
      throw new RagEvalParseError(
        `model.citationDocumentIds references document "${documentId}" with no accepted chunk.`,
        evalCase.filePath,
        evalCase.lineNumber
      );
    }
    return chunk.id;
  });

  return (request) => {
    const fallbackCitationChunkIds = request.input.contract.allowedCitationChunkIds.slice(
      0,
      Math.max(1, request.input.contract.minimumCitations)
    );
    const citationChunkIds = configuredCitationChunkIds ?? fallbackCitationChunkIds;

    return {
      answer: evalCase.model?.answer ?? "Generated answer from approved context.",
      citationChunkIds,
      ...(evalCase.model?.evidenceSummary || request.input.contract.requireEvidenceSummary
        ? {
            evidenceSummary:
              evalCase.model?.evidenceSummary ??
              "The answer is based on the approved context blocks."
          }
        : {}),
      confidence: "medium"
    };
  };
}

function evalRuntimeProfile(
  profile: ValidatedRagProfile,
  evalCase: LoadedRagEvalCase
): ValidatedRagProfile {
  if (!evalCase.retrievalMode || evalCase.retrievalMode === "profile") {
    return profile;
  }

  return assertValidProfile({
    ...profile,
    retrieval: {
      ...profile.retrieval,
      mode: evalCase.retrievalMode,
      rerankMode: "none"
    }
  });
}

function assertExpectations(
  profile: ValidatedRagProfile,
  evalCase: LoadedRagEvalCase,
  answer: RagAnswerResult
): readonly string[] {
  const failures: string[] = [];
  const expected = evalCase.expect;

  if (expected.status && answer.status !== expected.status) {
    failures.push(`Expected status "${expected.status}" but got "${answer.status}".`);
  }

  if (hasRetrieval(answer)) {
    const retrievedDocumentIds = uniqueSorted(
      answer.retrieval.candidates.map((candidate) => candidate.chunk.documentId)
    );
    if (
      expected.requiredRetrievalMode !== undefined &&
      answer.retrieval.trace.mode !== expected.requiredRetrievalMode
    ) {
      failures.push(
        `Expected retrieval mode "${expected.requiredRetrievalMode}" but got "${answer.retrieval.trace.mode}".`
      );
    }
    for (const documentId of expected.retrievedDocumentIds ?? []) {
      if (!retrievedDocumentIds.includes(documentId)) {
        failures.push(`Expected retrieved document "${documentId}".`);
      }
    }
    for (const documentId of expected.notRetrievedDocumentIds ?? []) {
      if (retrievedDocumentIds.includes(documentId)) {
        failures.push(`Document "${documentId}" was retrieved but should have been denied.`);
      }
    }
    if (
      expected.minimumRetrievedChunks !== undefined &&
      answer.retrieval.candidates.length < expected.minimumRetrievedChunks
    ) {
      failures.push(
        `Expected at least ${expected.minimumRetrievedChunks} retrieved chunks but got ${answer.retrieval.candidates.length}.`
      );
    }
  } else if (
    expected.requiredRetrievalMode !== undefined ||
    expected.retrievedDocumentIds?.length ||
    expected.notRetrievedDocumentIds?.length ||
    expected.minimumRetrievedChunks !== undefined
  ) {
    failures.push("Expected retrieval assertions, but answer failed before retrieval completed.");
  }

  if (hasContext(answer)) {
    if (
      expected.minimumCitations !== undefined &&
      answer.context.citations.length < expected.minimumCitations
    ) {
      failures.push(
        `Expected at least ${expected.minimumCitations} context citations but got ${answer.context.citations.length}.`
      );
    }

    if (
      expected.requiredContextStatus &&
      answer.context.evidence.status !== expected.requiredContextStatus
    ) {
      failures.push(
        `Expected context status "${expected.requiredContextStatus}" but got "${answer.context.evidence.status}".`
      );
    }

    for (const rejectionCode of expected.requiredRejectionCodes ?? []) {
      if (!answer.context.rejected.some((rejection) => rejection.code === rejectionCode)) {
        failures.push(`Expected context rejection code "${rejectionCode}".`);
      }
    }

    if (
      expected.minimumRedactions !== undefined &&
      answer.context.trace.redactionCount < expected.minimumRedactions
    ) {
      failures.push(
        `Expected at least ${expected.minimumRedactions} redactions but got ${answer.context.trace.redactionCount}.`
      );
    }

    for (const forbidden of expected.redactedTextMustNotContain ?? []) {
      if (answer.context.blocks.some((block) => block.text.includes(forbidden))) {
        failures.push(`Redacted context still contains forbidden text "${forbidden}".`);
      }
    }

    if (
      expected.minimumVisualCitations !== undefined &&
      visualCitationCount(answer) < expected.minimumVisualCitations
    ) {
      failures.push(
        `Expected at least ${expected.minimumVisualCitations} visual citations but got ${visualCitationCount(answer)}.`
      );
    }

    for (const regionId of expected.requiredCitationLayoutRegionIds ?? []) {
      if (
        !answer.context.citations.some((citation) =>
          (citation.layoutRegionIds ?? []).includes(regionId)
        )
      ) {
        failures.push(`Expected citation layout region "${regionId}".`);
      }
    }
  } else if (
    expected.minimumCitations !== undefined ||
    expected.requiredContextStatus ||
    expected.requiredRejectionCodes?.length ||
    expected.minimumRedactions !== undefined ||
    expected.redactedTextMustNotContain?.length ||
    expected.minimumVisualCitations !== undefined ||
    expected.requiredCitationLayoutRegionIds?.length
  ) {
    failures.push("Expected context assertions, but answer failed before context completed.");
  }

  for (const ruleId of expected.requiredEscalationRuleIds ?? []) {
    if (!profile.escalationRules.some((rule) => rule.id === ruleId)) {
      failures.push(`Expected profile escalation rule "${ruleId}".`);
    }
  }

  if (expected.maximumEstimatedCostUsd !== undefined) {
    if (!hasGeneration(answer) || !answer.generation.model) {
      failures.push("Expected cost assertion, but generation model result is missing.");
    } else if (answer.generation.model.cost.amountUsd > expected.maximumEstimatedCostUsd) {
      failures.push(
        `Expected model cost <= ${expected.maximumEstimatedCostUsd}, got ${answer.generation.model.cost.amountUsd}.`
      );
    }
  }

  return failures;
}

function assertCheckSpecificExpectations(
  profile: ValidatedRagProfile,
  evalCase: LoadedRagEvalCase,
  answer: RagAnswerResult
): readonly string[] {
  const failures: string[] = [];

  for (const check of evalCase.checks) {
    switch (check) {
      case "retrieval_recall":
        if (!evalCase.expect.retrievedDocumentIds?.length) {
          failures.push("retrieval_recall requires expect.retrievedDocumentIds.");
        }
        break;
      case "citation_required":
        if (!hasContext(answer)) {
          failures.push("citation_required requires a completed context.");
        } else if (
          answer.context.citations.length < profile.citationPolicy.minimumCitationsForAnswer
        ) {
          failures.push(
            `citation_required expected at least ${profile.citationPolicy.minimumCitationsForAnswer} citations.`
          );
        }
        break;
      case "refusal_when_unsupported":
        if (answer.status !== "refused") {
          failures.push(
            `refusal_when_unsupported expected refused status, got "${answer.status}".`
          );
        }
        break;
      case "access_boundary":
        if (!evalCase.expect.notRetrievedDocumentIds?.length) {
          failures.push("access_boundary requires expect.notRetrievedDocumentIds.");
        }
        if (answer.status !== "refused") {
          failures.push(`access_boundary expected refused status, got "${answer.status}".`);
        }
        break;
      case "prompt_injection_resistance":
        assertRequiredRejection(
          answer,
          "unsafe_prompt_injection",
          "prompt_injection_resistance",
          failures
        );
        if (answer.status !== "refused") {
          failures.push(
            `prompt_injection_resistance expected refused status, got "${answer.status}".`
          );
        }
        break;
      case "escalation_rule_match":
        if (!evalCase.expect.requiredEscalationRuleIds?.length) {
          failures.push("escalation_rule_match requires expect.requiredEscalationRuleIds.");
        }
        break;
      case "grounding_faithfulness":
        failures.push(...assertGroundedGeneration(answer));
        break;
      case "redaction_required":
        if (!hasContext(answer) || answer.context.trace.redactionCount < 1) {
          failures.push("redaction_required expected at least one context redaction.");
        }
        if (!evalCase.expect.redactedTextMustNotContain?.length) {
          failures.push("redaction_required requires expect.redactedTextMustNotContain.");
        }
        break;
      case "cost_budget":
        failures.push(...assertCostBudget(profile, answer));
        break;
      case "visual_retrieval":
        failures.push(...assertVisualRetrieval(evalCase, answer));
        break;
      case "layout_relation_recall":
        failures.push(...assertLayoutRelationRecall(evalCase, answer));
        break;
      case "table_caption_preservation":
        failures.push(...assertTableCaptionPreservation(evalCase, answer));
        break;
      case "relationship_claim_grounding":
        failures.push(...assertRelationshipClaimGrounding(evalCase, answer));
        break;
      case "relationship_claim_not_grounded":
        failures.push(...assertRelationshipClaimNotGrounded(evalCase, answer));
        break;
      case "extraction_quality":
        if (!evalCase.extraction) {
          failures.push("extraction_quality requires an extraction fixture.");
        }
        break;
      default:
        break;
    }
  }

  return failures;
}

function assertLayoutRelationRecall(
  evalCase: LoadedRagEvalCase,
  answer: RagAnswerResult
): readonly string[] {
  const failures: string[] = [];
  if (!evalCase.expect.requiredLayoutRelationIds?.length) {
    failures.push("layout_relation_recall requires expect.requiredLayoutRelationIds.");
  }
  if (!evalCase.expect.requiredCitationLayoutRegionIds?.length) {
    failures.push("layout_relation_recall requires expect.requiredCitationLayoutRegionIds.");
  }
  if (!hasContext(answer)) {
    failures.push("layout_relation_recall requires completed context.");
    return failures;
  }
  for (const regionId of evalCase.expect.requiredCitationLayoutRegionIds ?? []) {
    if (
      !answer.context.citations.some((citation) =>
        (citation.layoutRegionIds ?? []).includes(regionId)
      )
    ) {
      failures.push(`layout_relation_recall expected cited related region "${regionId}".`);
    }
  }
  return failures;
}

function assertTableCaptionPreservation(
  evalCase: LoadedRagEvalCase,
  answer: RagAnswerResult
): readonly string[] {
  const failures: string[] = [];
  if (!evalCase.expect.requiredCitationLayoutRegionIds?.length) {
    failures.push("table_caption_preservation requires expect.requiredCitationLayoutRegionIds.");
  }
  if (!hasContext(answer)) {
    failures.push("table_caption_preservation requires completed context.");
    return failures;
  }
  for (const regionId of evalCase.expect.requiredCitationLayoutRegionIds ?? []) {
    if (
      !answer.context.citations.some((citation) =>
        (citation.layoutRegionIds ?? []).includes(regionId)
      )
    ) {
      failures.push(
        `table_caption_preservation expected cited table/caption region "${regionId}".`
      );
    }
  }
  return failures;
}

function assertRelationshipClaimGrounding(
  evalCase: LoadedRagEvalCase,
  answer: RagAnswerResult
): readonly string[] {
  if (!evalCase.expect.requiredRelationshipPaths?.length) {
    return ["relationship_claim_grounding requires expect.requiredRelationshipPaths."];
  }

  if (!hasContext(answer) || !hasGeneration(answer)) {
    return ["relationship_claim_grounding requires completed context and generation."];
  }

  const validation = answer.generation.validation;
  const grounding = checkRelationshipClaimGrounding({
    contextBlocks: answer.context.blocks,
    citedChunkIds: validation?.citedChunkIds ?? answer.generation.draft?.citationChunkIds ?? [],
    expectedPaths: evalCase.expect.requiredRelationshipPaths
  });
  const failures = [...grounding.failures];

  if (validation && !validation.valid) {
    failures.push("relationship_claim_grounding expected deterministic validation to pass.");
  }

  return failures;
}

function assertRelationshipClaimNotGrounded(
  evalCase: LoadedRagEvalCase,
  answer: RagAnswerResult
): readonly string[] {
  if (!evalCase.expect.forbiddenRelationshipPaths?.length) {
    return ["relationship_claim_not_grounded requires expect.forbiddenRelationshipPaths."];
  }

  if (!hasContext(answer) || !hasGeneration(answer)) {
    return [];
  }

  const validation = answer.generation.validation;
  const grounding = checkRelationshipClaimGrounding({
    contextBlocks: answer.context.blocks,
    citedChunkIds: validation?.citedChunkIds ?? answer.generation.draft?.citationChunkIds ?? [],
    expectedPaths: evalCase.expect.forbiddenRelationshipPaths
  });

  if (grounding.matchedPathCount > 0) {
    return [
      `relationship_claim_not_grounded found ${grounding.matchedPathCount} forbidden relationship path(s) in cited evidence.`
    ];
  }

  return [];
}

function assertGroundedGeneration(answer: RagAnswerResult): readonly string[] {
  if (!hasGeneration(answer)) {
    return ["grounding_faithfulness requires a completed generation."];
  }

  const failures: string[] = [];
  const validation = answer.generation.validation;
  if (!validation?.valid) {
    failures.push("grounding_faithfulness expected generation validation to pass.");
  }

  if ((validation?.unknownCitationChunkIds.length ?? 0) > 0) {
    failures.push(
      `grounding_faithfulness found unknown citations: ${validation?.unknownCitationChunkIds.join(", ")}.`
    );
  }

  const allowedChunkIds = new Set(answer.context.blocks.map((block) => block.chunkId));
  for (const citationChunkId of answer.generation.draft?.citationChunkIds ?? []) {
    if (!allowedChunkIds.has(citationChunkId)) {
      failures.push(`grounding_faithfulness cited unapproved chunk "${citationChunkId}".`);
    }
  }

  return failures;
}

function assertCostBudget(
  profile: ValidatedRagProfile,
  answer: RagAnswerResult
): readonly string[] {
  if (!hasGeneration(answer) || !answer.generation.model) {
    return ["cost_budget requires a completed generation model result."];
  }

  const failures: string[] = [];
  const modelCost = answer.generation.model.cost.amountUsd;
  if (modelCost > profile.costLatencyBudget.maxEstimatedCostUsd) {
    failures.push(
      `cost_budget expected model cost <= profile budget ${profile.costLatencyBudget.maxEstimatedCostUsd}, got ${modelCost}.`
    );
  }

  const budgetWarnings = answer.generation.warnings.filter((warning) =>
    warning.code.startsWith("budget_")
  );
  if (budgetWarnings.length > 0) {
    failures.push(
      `cost_budget expected no budget warnings, got ${budgetWarnings
        .map((warning) => warning.code)
        .join(", ")}.`
    );
  }

  return failures;
}

function assertVisualRetrieval(
  evalCase: LoadedRagEvalCase,
  answer: RagAnswerResult
): readonly string[] {
  const failures: string[] = [];

  if (!evalCase.expect.retrievedDocumentIds?.length) {
    failures.push("visual_retrieval requires expect.retrievedDocumentIds.");
  }

  if (
    evalCase.expect.minimumVisualCitations === undefined &&
    !evalCase.expect.requiredCitationLayoutRegionIds?.length
  ) {
    failures.push(
      "visual_retrieval requires expect.minimumVisualCitations or expect.requiredCitationLayoutRegionIds."
    );
  }

  if (!hasRetrieval(answer)) {
    failures.push("visual_retrieval requires completed retrieval.");
    return failures;
  }

  if (answer.retrieval.trace.mode !== "visual") {
    failures.push(`visual_retrieval expected visual mode, got "${answer.retrieval.trace.mode}".`);
  }

  if (answer.retrieval.candidates.length === 0) {
    failures.push("visual_retrieval expected at least one retrieved visual candidate.");
  }

  if (
    !answer.retrieval.candidates.some((candidate) => hasVisualCitationEvidence(candidate.citation))
  ) {
    failures.push("visual_retrieval expected retrieved candidates to carry visual evidence.");
  }

  if (!hasContext(answer)) {
    failures.push("visual_retrieval requires completed context.");
    return failures;
  }

  if (visualCitationCount(answer) < 1) {
    failures.push("visual_retrieval expected at least one context citation with visual evidence.");
  }

  return failures;
}

function visualCitationCount(answer: RagAnswerResult): number {
  if (!hasContext(answer)) {
    return 0;
  }

  return answer.context.citations.filter(hasVisualCitationEvidence).length;
}

function hasVisualCitationEvidence(citation: {
  readonly visualAssetId?: string;
  readonly visualAsset?: { readonly id?: string };
  readonly pageNumber?: number;
  readonly boundingBoxes?: readonly unknown[];
  readonly layoutRegionIds?: readonly string[];
}): boolean {
  return (
    citation.visualAssetId !== undefined ||
    citation.visualAsset?.id !== undefined ||
    citation.pageNumber !== undefined ||
    (citation.boundingBoxes?.length ?? 0) > 0 ||
    (citation.layoutRegionIds?.length ?? 0) > 0
  );
}

function assertRequiredRejection(
  answer: RagAnswerResult,
  code: ContextRejectionCode,
  label: string,
  failures: string[]
): void {
  if (!hasContext(answer)) {
    failures.push(`${label} requires a completed context.`);
    return;
  }

  if (!answer.context.rejected.some((rejection) => rejection.code === code)) {
    failures.push(`${label} expected context rejection "${code}".`);
  }
}

function buildFilter(
  profile: ValidatedRagProfile,
  principal: RequestPrincipal,
  overrides: EvalIndexFilterOverrides | undefined
): IndexFilter {
  return {
    namespaceId: profile.namespaceId,
    tenantId: principal.tenantId,
    principal,
    ...(overrides?.documentIds ? { documentIds: overrides.documentIds } : {}),
    ...(overrides?.chunkIds ? { chunkIds: overrides.chunkIds } : {}),
    ...(overrides?.sourceIds ? { sourceIds: overrides.sourceIds } : {}),
    ...(overrides?.sourceKinds ? { sourceKinds: overrides.sourceKinds } : {}),
    ...(overrides?.trustTiers ? { trustTiers: overrides.trustTiers } : {}),
    ...(overrides?.includeSafetyFlags ? { includeSafetyFlags: overrides.includeSafetyFlags } : {}),
    ...(overrides?.excludeSafetyFlags ? { excludeSafetyFlags: overrides.excludeSafetyFlags } : {}),
    ...(overrides?.accessTags ? { accessTags: overrides.accessTags } : {}),
    ...(overrides?.limit !== undefined ? { limit: overrides.limit } : {})
  };
}

function parseEvalCase(value: unknown, filePath: string, lineNumber: number): RagEvalCase {
  const record = requiredRecord(value, filePath, lineNumber, "case");
  const id = requiredString(record, "id", filePath, lineNumber);
  const checks = requiredStringArray(record, "checks", filePath, lineNumber);
  const query = requiredString(record, "query", filePath, lineNumber);
  const principal = parsePrincipal(record["principal"], filePath, lineNumber);
  const corpus = requiredArray(record, "corpus", filePath, lineNumber).map((entry, index) =>
    parseCorpusRecord(entry, filePath, lineNumber, `corpus[${index}]`)
  );
  const knowledgeMap = parseKnowledgeMapFixture(record["knowledgeMap"], filePath, lineNumber);
  const extraction = parseExtractionFixture(record["extraction"], filePath, lineNumber);
  const expectation = parseExpectation(record["expect"], filePath, lineNumber);
  const model = parseModelOptions(record["model"], filePath, lineNumber);
  const topK = optionalPositiveInteger(record, "topK", filePath, lineNumber);
  const filter = parseFilterOverrides(record["filter"], filePath, lineNumber);
  const retrievalMode = parseEvalRetrievalMode(record["retrievalMode"], filePath, lineNumber);

  if (checks.length === 0) {
    throw new RagEvalParseError("checks must contain at least one check.", filePath, lineNumber);
  }

  if (corpus.length === 0) {
    throw new RagEvalParseError("corpus must contain at least one record.", filePath, lineNumber);
  }

  return {
    id,
    ...(optionalString(record, "description", filePath, lineNumber)
      ? {
          description: optionalString(record, "description", filePath, lineNumber) as string
        }
      : {}),
    checks,
    query,
    principal,
    corpus,
    ...(knowledgeMap ? { knowledgeMap } : {}),
    ...(extraction ? { extraction } : {}),
    expect: expectation,
    ...(retrievalMode ? { retrievalMode } : {}),
    ...(topK !== undefined ? { topK } : {}),
    ...(filter ? { filter } : {}),
    ...(model ? { model } : {})
  };
}

function parsePrincipal(value: unknown, filePath: string, lineNumber: number): RequestPrincipal {
  const record = requiredRecord(value, filePath, lineNumber, "principal");
  return {
    userId: requiredString(record, "userId", filePath, lineNumber),
    tenantId: requiredString(record, "tenantId", filePath, lineNumber),
    namespaceIds: requiredStringArray(record, "namespaceIds", filePath, lineNumber),
    teamIds: requiredStringArray(record, "teamIds", filePath, lineNumber),
    roles: requiredStringArray(record, "roles", filePath, lineNumber),
    tags: requiredStringArray(record, "tags", filePath, lineNumber)
  };
}

function parseEvalRetrievalMode(
  value: unknown,
  filePath: string,
  lineNumber: number
): EvalRetrievalMode | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !includesString(EVAL_RETRIEVAL_MODES, value)) {
    throw new RagEvalParseError(
      `retrievalMode must be one of ${EVAL_RETRIEVAL_MODES.join(", ")}.`,
      filePath,
      lineNumber
    );
  }

  return value;
}

function parseKnowledgeMapFixture(
  value: unknown,
  filePath: string,
  lineNumber: number
): RagEvalKnowledgeMapFixture | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = requiredRecord(value, filePath, lineNumber, "knowledgeMap");
  const ontology = parseKnowledgeMapOntology(record["ontology"], filePath, lineNumber);
  const entities = requiredArray(record, "entities", filePath, lineNumber).map((entry, index) =>
    parseKnowledgeMapEntity(entry, filePath, lineNumber, `knowledgeMap.entities[${index}]`)
  );
  const relations = requiredArray(record, "relations", filePath, lineNumber).map((entry, index) =>
    parseKnowledgeMapRelation(entry, filePath, lineNumber, `knowledgeMap.relations[${index}]`)
  );

  if (entities.length === 0) {
    throw new RagEvalParseError(
      "knowledgeMap.entities must contain at least one entity.",
      filePath,
      lineNumber
    );
  }

  if (relations.length === 0) {
    throw new RagEvalParseError(
      "knowledgeMap.relations must contain at least one relation.",
      filePath,
      lineNumber
    );
  }

  return {
    ...(ontology ? { ontology } : {}),
    entities,
    relations,
    ...optionalStringArrayRecord(record, "expectedVisibleEntityIds", filePath, lineNumber),
    ...optionalStringArrayRecord(record, "expectedVisibleRelationIds", filePath, lineNumber)
  };
}

function parseExtractionFixture(
  value: unknown,
  filePath: string,
  lineNumber: number
): RagEvalExtractionFixture | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = requiredRecord(value, filePath, lineNumber, "extraction");
  const ontology = parseKnowledgeMapOntology(record["ontology"], filePath, lineNumber);
  const expectedEntities = requiredArray(record, "expectedEntities", filePath, lineNumber).map(
    (entry, index) =>
      parseKnowledgeMapEntity(entry, filePath, lineNumber, `extraction.expectedEntities[${index}]`)
  );
  const expectedRelations = requiredArray(record, "expectedRelations", filePath, lineNumber).map(
    (entry, index) =>
      parseKnowledgeMapRelation(
        entry,
        filePath,
        lineNumber,
        `extraction.expectedRelations[${index}]`
      )
  );
  const actualEntities = optionalArray(record, "actualEntities", filePath, lineNumber)?.map(
    (entry, index) =>
      parseKnowledgeMapEntity(entry, filePath, lineNumber, `extraction.actualEntities[${index}]`)
  );
  const actualRelations = optionalArray(record, "actualRelations", filePath, lineNumber)?.map(
    (entry, index) =>
      parseKnowledgeMapRelation(entry, filePath, lineNumber, `extraction.actualRelations[${index}]`)
  );
  const forbiddenRelations = optionalArray(record, "forbiddenRelations", filePath, lineNumber)?.map(
    (entry, index) =>
      parseRelationshipEdgeExpectation(
        entry,
        filePath,
        lineNumber,
        `extraction.forbiddenRelations[${index}]`
      )
  );
  const minimumEntityRecall = optionalRatio(record, "minimumEntityRecall", filePath, lineNumber);
  const minimumRelationRecall = optionalRatio(
    record,
    "minimumRelationRecall",
    filePath,
    lineNumber
  );
  const maximumExtraEntities = optionalNonNegativeInteger(
    record,
    "maximumExtraEntities",
    filePath,
    lineNumber
  );
  const maximumExtraRelations = optionalNonNegativeInteger(
    record,
    "maximumExtraRelations",
    filePath,
    lineNumber
  );

  if (expectedEntities.length === 0 && expectedRelations.length === 0) {
    throw new RagEvalParseError(
      "extraction must include at least one expected entity or relation.",
      filePath,
      lineNumber
    );
  }

  if (actualEntities !== undefined && actualRelations === undefined) {
    throw new RagEvalParseError(
      "extraction.actualEntities requires extraction.actualRelations so the extracted batch is explicit.",
      filePath,
      lineNumber
    );
  }

  if (actualRelations !== undefined && actualEntities === undefined) {
    throw new RagEvalParseError(
      "extraction.actualRelations requires extraction.actualEntities so relation endpoints can be resolved.",
      filePath,
      lineNumber
    );
  }

  return {
    ...(ontology ? { ontology } : {}),
    expectedEntities,
    expectedRelations,
    ...(actualEntities === undefined ? {} : { actualEntities }),
    ...(actualRelations === undefined ? {} : { actualRelations }),
    ...(forbiddenRelations === undefined ? {} : { forbiddenRelations }),
    ...(minimumEntityRecall === undefined ? {} : { minimumEntityRecall }),
    ...(minimumRelationRecall === undefined ? {} : { minimumRelationRecall }),
    ...(maximumExtraEntities === undefined ? {} : { maximumExtraEntities }),
    ...(maximumExtraRelations === undefined ? {} : { maximumExtraRelations })
  };
}

function parseKnowledgeMapOntology(
  value: unknown,
  filePath: string,
  lineNumber: number
): RagEvalKnowledgeMapFixture["ontology"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = requiredRecord(value, filePath, lineNumber, "knowledgeMap.ontology");
  const entityKinds = requiredStringArray(record, "entityKinds", filePath, lineNumber).map((kind) =>
    parseGraphEntityKind(kind, filePath, lineNumber, "knowledgeMap.ontology.entityKinds")
  );
  const relationKinds = requiredStringArray(record, "relationKinds", filePath, lineNumber).map(
    (kind) =>
      parseGraphRelationKind(kind, filePath, lineNumber, "knowledgeMap.ontology.relationKinds")
  );

  if (entityKinds.length === 0 || relationKinds.length === 0) {
    throw new RagEvalParseError(
      "knowledgeMap.ontology entityKinds and relationKinds must be non-empty.",
      filePath,
      lineNumber
    );
  }

  return {
    id: requiredString(record, "id", filePath, lineNumber),
    entityKinds,
    relationKinds,
    requiredEvidenceForRelations: requiredBoolean(
      record,
      "requiredEvidenceForRelations",
      filePath,
      lineNumber
    ),
    allowInferredRelations: requiredBoolean(record, "allowInferredRelations", filePath, lineNumber)
  };
}

function parseKnowledgeMapEntity(
  value: unknown,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): RagEvalKnowledgeMapEntityFixture {
  const record = requiredRecord(value, filePath, lineNumber, pathLabel);
  const kind = parseGraphEntityKind(
    requiredString(record, "kind", filePath, lineNumber),
    filePath,
    lineNumber,
    `${pathLabel}.kind`
  );
  const trustTier = parseOptionalTrustTier(record, "trustTier", filePath, lineNumber, pathLabel);
  const status = parseOptionalGraphProposalStatus(
    record,
    "status",
    filePath,
    lineNumber,
    pathLabel
  );
  const accessScope =
    record["accessScope"] === undefined
      ? undefined
      : parseAccessScope(record["accessScope"], filePath, lineNumber, `${pathLabel}.accessScope`);

  return {
    id: requiredString(record, "id", filePath, lineNumber),
    kind,
    name: requiredString(record, "name", filePath, lineNumber),
    ...optionalTrimmedStringRecord(record, "normalizedName", filePath, lineNumber),
    ...optionalStringArrayRecord(record, "aliases", filePath, lineNumber),
    evidenceDocumentIds: requiredNonEmptyStringArray(
      record,
      "evidenceDocumentIds",
      filePath,
      lineNumber,
      pathLabel
    ),
    ...(record["confidence"] === undefined
      ? {}
      : { confidence: parseConfidence(record, "confidence", filePath, lineNumber, pathLabel) }),
    ...(trustTier ? { trustTier } : {}),
    ...(accessScope ? { accessScope } : {}),
    ...(status ? { status } : {})
  };
}

function parseKnowledgeMapRelation(
  value: unknown,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): RagEvalKnowledgeMapRelationFixture {
  const record = requiredRecord(value, filePath, lineNumber, pathLabel);
  const relationKind = parseGraphRelationKind(
    requiredString(record, "relationKind", filePath, lineNumber),
    filePath,
    lineNumber,
    `${pathLabel}.relationKind`
  );
  const factStrength = parseOptionalEnum(
    record,
    "factStrength",
    GRAPH_FACT_STRENGTHS,
    filePath,
    lineNumber,
    pathLabel
  );
  const trustTier = parseOptionalTrustTier(record, "trustTier", filePath, lineNumber, pathLabel);
  const verificationStatus = parseOptionalEnum(
    record,
    "verificationStatus",
    GRAPH_VERIFICATION_STATUSES,
    filePath,
    lineNumber,
    pathLabel
  );
  const status = parseOptionalGraphProposalStatus(
    record,
    "status",
    filePath,
    lineNumber,
    pathLabel
  );
  const accessScope =
    record["accessScope"] === undefined
      ? undefined
      : parseAccessScope(record["accessScope"], filePath, lineNumber, `${pathLabel}.accessScope`);

  return {
    id: requiredString(record, "id", filePath, lineNumber),
    relationKind,
    sourceEntityId: requiredString(record, "sourceEntityId", filePath, lineNumber),
    targetEntityId: requiredString(record, "targetEntityId", filePath, lineNumber),
    evidenceDocumentIds: requiredNonEmptyStringArray(
      record,
      "evidenceDocumentIds",
      filePath,
      lineNumber,
      pathLabel
    ),
    ...(factStrength ? { factStrength } : {}),
    ...(record["confidence"] === undefined
      ? {}
      : { confidence: parseConfidence(record, "confidence", filePath, lineNumber, pathLabel) }),
    ...(trustTier ? { trustTier } : {}),
    ...(accessScope ? { accessScope } : {}),
    ...(verificationStatus ? { verificationStatus } : {}),
    ...(status ? { status } : {}),
    ...optionalTrimmedStringRecord(record, "observedAt", filePath, lineNumber)
  };
}

function parseGraphEntityKind(
  value: string,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): string {
  if (!isKnowledgeMapKind(value)) {
    throw new RagEvalParseError(`${pathLabel} has an invalid entity kind.`, filePath, lineNumber);
  }
  return value;
}

function parseGraphRelationKind(
  value: string,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): string {
  if (!isKnowledgeMapKind(value)) {
    throw new RagEvalParseError(`${pathLabel} has an invalid relation kind.`, filePath, lineNumber);
  }
  return value;
}

function isKnowledgeMapKind(value: string): boolean {
  return /^[a-z][a-z0-9_:-]{0,63}$/u.test(value.trim());
}

function parseCorpusRecord(
  value: unknown,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): CorpusRecord {
  const record = requiredRecord(value, filePath, lineNumber, pathLabel);
  const sourceKind = requiredString(record, "sourceKind", filePath, lineNumber);
  const trustTier = requiredString(record, "trustTier", filePath, lineNumber);
  const sensitivity = requiredString(record, "sensitivity", filePath, lineNumber);
  const body = requiredString(record, "body", filePath, lineNumber);

  if (!isSourceKind(sourceKind)) {
    throw new RagEvalParseError(
      `${pathLabel}.sourceKind is not a supported source kind.`,
      filePath,
      lineNumber
    );
  }

  if (!isTrustTier(trustTier)) {
    throw new RagEvalParseError(
      `${pathLabel}.trustTier is not a supported trust tier.`,
      filePath,
      lineNumber
    );
  }

  if (!isSourceSensitivity(sensitivity)) {
    throw new RagEvalParseError(
      `${pathLabel}.sensitivity is not a supported sensitivity.`,
      filePath,
      lineNumber
    );
  }

  const accessScope = parseAccessScope(
    record["accessScope"],
    filePath,
    lineNumber,
    `${pathLabel}.accessScope`
  );

  return {
    id: requiredString(record, "id", filePath, lineNumber),
    sourceId: requiredString(record, "sourceId", filePath, lineNumber),
    sourceKind,
    title: requiredString(record, "title", filePath, lineNumber),
    body,
    trustTier,
    sensitivity,
    accessScope,
    ...(optionalString(record, "originUri", filePath, lineNumber)
      ? {
          originUri: optionalString(record, "originUri", filePath, lineNumber) as string
        }
      : {}),
    ...(optionalString(record, "path", filePath, lineNumber)
      ? {
          path: optionalString(record, "path", filePath, lineNumber) as string
        }
      : {}),
    ...(optionalString(record, "owner", filePath, lineNumber)
      ? {
          owner: optionalString(record, "owner", filePath, lineNumber) as string
        }
      : {}),
    ...(optionalString(record, "capturedAt", filePath, lineNumber)
      ? {
          capturedAt: optionalString(record, "capturedAt", filePath, lineNumber) as string
        }
      : {}),
    ...(optionalString(record, "checksum", filePath, lineNumber)
      ? {
          checksum: optionalString(record, "checksum", filePath, lineNumber) as string
        }
      : {}),
    ...(record["layout"] === undefined
      ? {}
      : {
          layout: parseDocumentLayout(record["layout"], filePath, lineNumber, `${pathLabel}.layout`)
        })
  };
}

function parseAccessScope(
  value: unknown,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): AccessScope {
  const record = requiredRecord(value, filePath, lineNumber, pathLabel);
  return {
    tenantId: requiredString(record, "tenantId", filePath, lineNumber),
    namespaceId: requiredString(record, "namespaceId", filePath, lineNumber),
    ...optionalStringArrayRecord(record, "teamIds", filePath, lineNumber),
    ...optionalStringArrayRecord(record, "userIds", filePath, lineNumber),
    ...optionalStringArrayRecord(record, "roles", filePath, lineNumber),
    ...optionalStringArrayRecord(record, "tags", filePath, lineNumber)
  };
}

function parseDocumentLayout(
  value: unknown,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): DocumentLayout {
  const record = requiredRecord(value, filePath, lineNumber, pathLabel);
  const strategy = requiredString(record, "strategy", filePath, lineNumber);
  if (!isDocumentLayoutStrategy(strategy)) {
    throw new RagEvalParseError(`${pathLabel}.strategy is not supported.`, filePath, lineNumber);
  }

  const tables = optionalArray(record, "tables", filePath, lineNumber)?.map((entry, index) =>
    parseDocumentTable(entry, filePath, lineNumber, `${pathLabel}.tables[${index}]`)
  );
  const relations = optionalArray(record, "relations", filePath, lineNumber)?.map((entry, index) =>
    parseDocumentLayoutRelation(entry, filePath, lineNumber, `${pathLabel}.relations[${index}]`)
  );
  const visualAssets = optionalArray(record, "visualAssets", filePath, lineNumber)?.map(
    (entry, index) =>
      parseDocumentVisualAsset(entry, filePath, lineNumber, `${pathLabel}.visualAssets[${index}]`)
  );
  const warnings = optionalStringArray(record, "warnings", filePath, lineNumber);
  const metadata = parseLayoutMetadata(
    record["metadata"],
    filePath,
    lineNumber,
    `${pathLabel}.metadata`
  );
  const parserVersion = optionalString(record, "parserVersion", filePath, lineNumber);

  return {
    parserId: requiredString(record, "parserId", filePath, lineNumber),
    ...(parserVersion === undefined ? {} : { parserVersion }),
    strategy,
    pages: requiredArray(record, "pages", filePath, lineNumber).map((entry, index) =>
      parseDocumentLayoutPage(entry, filePath, lineNumber, `${pathLabel}.pages[${index}]`)
    ),
    regions: requiredArray(record, "regions", filePath, lineNumber).map((entry, index) =>
      parseDocumentLayoutRegion(entry, filePath, lineNumber, `${pathLabel}.regions[${index}]`)
    ),
    ...(relations === undefined ? {} : { relations }),
    ...(tables === undefined ? {} : { tables }),
    ...(visualAssets === undefined ? {} : { visualAssets }),
    ...(warnings === undefined ? {} : { warnings }),
    ...(metadata === undefined ? {} : { metadata })
  };
}

function parseDocumentLayoutPage(
  value: unknown,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): DocumentLayoutPage {
  const record = requiredRecord(value, filePath, lineNumber, pathLabel);
  const unit = parseLayoutCoordinateUnit(
    requiredString(record, "unit", filePath, lineNumber),
    filePath,
    lineNumber,
    `${pathLabel}.unit`
  );
  const rotationDegrees = optionalNumber(record, "rotationDegrees", filePath, lineNumber);
  const visualAssetId = optionalString(record, "visualAssetId", filePath, lineNumber);

  return {
    pageNumber: requiredNumber(record, "pageNumber", filePath, lineNumber),
    width: requiredNumber(record, "width", filePath, lineNumber),
    height: requiredNumber(record, "height", filePath, lineNumber),
    unit,
    ...(rotationDegrees === undefined ? {} : { rotationDegrees }),
    ...(visualAssetId === undefined ? {} : { visualAssetId })
  };
}

function parseDocumentLayoutRegion(
  value: unknown,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): DocumentLayoutRegion {
  const record = requiredRecord(value, filePath, lineNumber, pathLabel);
  const kind = parseLayoutRegionKind(
    requiredString(record, "kind", filePath, lineNumber),
    filePath,
    lineNumber,
    `${pathLabel}.kind`
  );
  const box =
    record["box"] === undefined
      ? undefined
      : parseLayoutBox(record["box"], filePath, lineNumber, `${pathLabel}.box`);
  const text = optionalString(record, "text", filePath, lineNumber);
  const characterStart = optionalNumber(record, "characterStart", filePath, lineNumber);
  const characterEnd = optionalNumber(record, "characterEnd", filePath, lineNumber);
  const parentId = optionalString(record, "parentId", filePath, lineNumber);
  const childrenIds = optionalStringArray(record, "childrenIds", filePath, lineNumber);
  const confidence = optionalNumber(record, "confidence", filePath, lineNumber);
  const metadata = parseLayoutMetadata(
    record["metadata"],
    filePath,
    lineNumber,
    `${pathLabel}.metadata`
  );

  return {
    id: requiredString(record, "id", filePath, lineNumber),
    kind,
    pageNumber: requiredNumber(record, "pageNumber", filePath, lineNumber),
    ...(box === undefined ? {} : { box }),
    ...(text === undefined ? {} : { text }),
    ...(characterStart === undefined ? {} : { characterStart }),
    ...(characterEnd === undefined ? {} : { characterEnd }),
    ...(parentId === undefined ? {} : { parentId }),
    ...(childrenIds === undefined ? {} : { childrenIds }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(metadata === undefined ? {} : { metadata })
  };
}

function parseDocumentLayoutRelation(
  value: unknown,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): DocumentLayoutRelation {
  const record = requiredRecord(value, filePath, lineNumber, pathLabel);
  const kind = requiredString(record, "kind", filePath, lineNumber);
  if (!isDocumentLayoutRelationKind(kind)) {
    throw new RagEvalParseError(`${pathLabel}.kind is not supported.`, filePath, lineNumber);
  }
  const confidence = optionalNumber(record, "confidence", filePath, lineNumber);
  const metadata = parseLayoutMetadata(
    record["metadata"],
    filePath,
    lineNumber,
    `${pathLabel}.metadata`
  );

  return {
    id: requiredString(record, "id", filePath, lineNumber),
    kind,
    fromRegionId: requiredString(record, "fromRegionId", filePath, lineNumber),
    toRegionId: requiredString(record, "toRegionId", filePath, lineNumber),
    ...(confidence === undefined ? {} : { confidence }),
    ...(metadata === undefined ? {} : { metadata })
  };
}

function parseDocumentTable(
  value: unknown,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): DocumentTable {
  const record = requiredRecord(value, filePath, lineNumber, pathLabel);
  const captionRegionId = optionalString(record, "captionRegionId", filePath, lineNumber);
  const box =
    record["box"] === undefined
      ? undefined
      : parseLayoutBox(record["box"], filePath, lineNumber, `${pathLabel}.box`);
  const summary = optionalString(record, "summary", filePath, lineNumber);
  const metadata = parseLayoutMetadata(
    record["metadata"],
    filePath,
    lineNumber,
    `${pathLabel}.metadata`
  );

  return {
    id: requiredString(record, "id", filePath, lineNumber),
    pageNumber: requiredNumber(record, "pageNumber", filePath, lineNumber),
    regionId: requiredString(record, "regionId", filePath, lineNumber),
    ...(captionRegionId === undefined ? {} : { captionRegionId }),
    ...(box === undefined ? {} : { box }),
    cells: requiredArray(record, "cells", filePath, lineNumber).map((entry, index) =>
      parseDocumentTableCell(entry, filePath, lineNumber, `${pathLabel}.cells[${index}]`)
    ),
    ...(summary === undefined ? {} : { summary }),
    ...(metadata === undefined ? {} : { metadata })
  };
}

function parseDocumentTableCell(
  value: unknown,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): DocumentTableCell {
  const record = requiredRecord(value, filePath, lineNumber, pathLabel);
  const rowSpan = optionalNumber(record, "rowSpan", filePath, lineNumber);
  const columnSpan = optionalNumber(record, "columnSpan", filePath, lineNumber);
  const text = optionalString(record, "text", filePath, lineNumber);
  const regionId = optionalString(record, "regionId", filePath, lineNumber);
  const box =
    record["box"] === undefined
      ? undefined
      : parseLayoutBox(record["box"], filePath, lineNumber, `${pathLabel}.box`);

  return {
    rowIndex: requiredNumber(record, "rowIndex", filePath, lineNumber),
    columnIndex: requiredNumber(record, "columnIndex", filePath, lineNumber),
    ...(rowSpan === undefined ? {} : { rowSpan }),
    ...(columnSpan === undefined ? {} : { columnSpan }),
    ...(text === undefined ? {} : { text }),
    ...(regionId === undefined ? {} : { regionId }),
    ...(box === undefined ? {} : { box })
  };
}

function parseDocumentVisualAsset(
  value: unknown,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): DocumentVisualAsset {
  const record = requiredRecord(value, filePath, lineNumber, pathLabel);
  const kind = requiredString(record, "kind", filePath, lineNumber);
  if (!includesString(DOCUMENT_VISUAL_ASSET_KINDS, kind)) {
    throw new RagEvalParseError(`${pathLabel}.kind is not supported.`, filePath, lineNumber);
  }

  const uri = optionalString(record, "uri", filePath, lineNumber);
  const checksum = optionalString(record, "checksum", filePath, lineNumber);
  const box =
    record["box"] === undefined
      ? undefined
      : parseLayoutBox(record["box"], filePath, lineNumber, `${pathLabel}.box`);
  const metadata = parseLayoutMetadata(
    record["metadata"],
    filePath,
    lineNumber,
    `${pathLabel}.metadata`
  );

  return {
    id: requiredString(record, "id", filePath, lineNumber),
    kind,
    pageNumber: requiredNumber(record, "pageNumber", filePath, lineNumber),
    mediaType: requiredString(record, "mediaType", filePath, lineNumber),
    ...(uri === undefined ? {} : { uri }),
    ...(checksum === undefined ? {} : { checksum }),
    ...(box === undefined ? {} : { box }),
    ...(metadata === undefined ? {} : { metadata })
  };
}

function parseLayoutBox(
  value: unknown,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): LayoutBox {
  const record = requiredRecord(value, filePath, lineNumber, pathLabel);
  return {
    pageNumber: requiredNumber(record, "pageNumber", filePath, lineNumber),
    x: requiredNumber(record, "x", filePath, lineNumber),
    y: requiredNumber(record, "y", filePath, lineNumber),
    width: requiredNumber(record, "width", filePath, lineNumber),
    height: requiredNumber(record, "height", filePath, lineNumber),
    unit: parseLayoutCoordinateUnit(
      requiredString(record, "unit", filePath, lineNumber),
      filePath,
      lineNumber,
      `${pathLabel}.unit`
    )
  };
}

function parseLayoutMetadata(
  value: unknown,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): LayoutMetadata | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = requiredRecord(value, filePath, lineNumber, pathLabel);
  const metadata: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
      throw new RagEvalParseError(
        `${pathLabel}.${key} must be a scalar value.`,
        filePath,
        lineNumber
      );
    }
    metadata[key] = entry;
  }

  return metadata;
}

function parseLayoutCoordinateUnit(
  value: string,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): LayoutBox["unit"] {
  if (!isLayoutCoordinateUnit(value)) {
    throw new RagEvalParseError(`${pathLabel} is not supported.`, filePath, lineNumber);
  }

  return value;
}

function parseLayoutRegionKind(
  value: string,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): DocumentLayoutRegion["kind"] {
  if (!isLayoutRegionKind(value)) {
    throw new RagEvalParseError(`${pathLabel} is not supported.`, filePath, lineNumber);
  }

  return value;
}

function parseExpectation(
  value: unknown,
  filePath: string,
  lineNumber: number
): RagEvalExpectation {
  const record = requiredRecord(value, filePath, lineNumber, "expect");
  const status = optionalString(record, "status", filePath, lineNumber);
  const requiredContextStatus = optionalString(
    record,
    "requiredContextStatus",
    filePath,
    lineNumber
  );
  const requiredRetrievalMode = optionalString(
    record,
    "requiredRetrievalMode",
    filePath,
    lineNumber
  );
  let expectedStatus: (typeof RAG_RUN_STATUSES)[number] | undefined;
  let expectedContextStatus: (typeof CONTEXT_EVIDENCE_STATUSES)[number] | undefined;
  let expectedRetrievalMode: RetrievalMode | undefined;

  if (status) {
    if (!includesString(RAG_RUN_STATUSES, status)) {
      throw new RagEvalParseError(`Unsupported expected status "${status}".`, filePath, lineNumber);
    }
    expectedStatus = status;
  }

  if (requiredContextStatus) {
    if (!includesString(CONTEXT_EVIDENCE_STATUSES, requiredContextStatus)) {
      throw new RagEvalParseError(
        `Unsupported expected context status "${requiredContextStatus}".`,
        filePath,
        lineNumber
      );
    }
    expectedContextStatus = requiredContextStatus;
  }

  if (requiredRetrievalMode) {
    if (!includesString(RETRIEVAL_MODES, requiredRetrievalMode)) {
      throw new RagEvalParseError(
        `Unsupported expected retrieval mode "${requiredRetrievalMode}".`,
        filePath,
        lineNumber
      );
    }
    expectedRetrievalMode = requiredRetrievalMode;
  }

  const rejectionCodes = optionalStringArray(
    record,
    "requiredRejectionCodes",
    filePath,
    lineNumber
  );
  const expectedRejectionCodes: ContextRejectionCode[] = [];
  for (const code of rejectionCodes ?? []) {
    if (!includesString(CONTEXT_REJECTION_CODES, code)) {
      throw new RagEvalParseError(
        `Unsupported context rejection code "${code}".`,
        filePath,
        lineNumber
      );
    }
    expectedRejectionCodes.push(code);
  }

  return {
    ...(expectedStatus ? { status: expectedStatus } : {}),
    ...optionalStringArrayRecord(record, "retrievedDocumentIds", filePath, lineNumber),
    ...optionalStringArrayRecord(record, "notRetrievedDocumentIds", filePath, lineNumber),
    ...optionalNumberRecord(record, "minimumRetrievedChunks", filePath, lineNumber),
    ...optionalNumberRecord(record, "minimumCitations", filePath, lineNumber),
    ...(expectedContextStatus ? { requiredContextStatus: expectedContextStatus } : {}),
    ...(rejectionCodes ? { requiredRejectionCodes: expectedRejectionCodes } : {}),
    ...optionalNumberRecord(record, "minimumRedactions", filePath, lineNumber),
    ...optionalStringArrayRecord(record, "redactedTextMustNotContain", filePath, lineNumber),
    ...optionalStringArrayRecord(record, "requiredEscalationRuleIds", filePath, lineNumber),
    ...optionalNumberRecord(record, "maximumEstimatedCostUsd", filePath, lineNumber),
    ...(expectedRetrievalMode ? { requiredRetrievalMode: expectedRetrievalMode } : {}),
    ...optionalNumberRecord(record, "minimumVisualCitations", filePath, lineNumber),
    ...optionalStringArrayRecord(record, "requiredCitationLayoutRegionIds", filePath, lineNumber),
    ...optionalStringArrayRecord(record, "requiredLayoutRelationIds", filePath, lineNumber),
    ...parseRelationshipPathExpectationRecord(record, filePath, lineNumber)
  };
}

function parseRelationshipPathExpectationRecord(
  record: Readonly<Record<string, unknown>>,
  filePath: string,
  lineNumber: number
): Readonly<Pick<RagEvalExpectation, "requiredRelationshipPaths" | "forbiddenRelationshipPaths">> {
  const requiredPaths = optionalArray(record, "requiredRelationshipPaths", filePath, lineNumber);
  const forbiddenPaths = optionalArray(record, "forbiddenRelationshipPaths", filePath, lineNumber);
  if (requiredPaths === undefined && forbiddenPaths === undefined) {
    return {};
  }

  return {
    ...(requiredPaths === undefined
      ? {}
      : {
          requiredRelationshipPaths: requiredPaths.map((entry, index) =>
            parseRelationshipPathExpectation(
              entry,
              filePath,
              lineNumber,
              `requiredRelationshipPaths[${index}]`
            )
          )
        }),
    ...(forbiddenPaths === undefined
      ? {}
      : {
          forbiddenRelationshipPaths: forbiddenPaths.map((entry, index) =>
            parseRelationshipPathExpectation(
              entry,
              filePath,
              lineNumber,
              `forbiddenRelationshipPaths[${index}]`
            )
          )
        })
  };
}

function parseRelationshipPathExpectation(
  value: unknown,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): RagEvalRelationshipPathExpectation {
  const record = requiredRecord(value, filePath, lineNumber, pathLabel);
  const depth = optionalPositiveInteger(record, "depth", filePath, lineNumber);
  const ordered = optionalBoolean(record, "ordered", filePath, lineNumber);
  const requireEdgeEvidence = optionalBoolean(record, "requireEdgeEvidence", filePath, lineNumber);
  const edges = requiredArray(record, "edges", filePath, lineNumber).map((entry, index) =>
    parseRelationshipEdgeExpectation(entry, filePath, lineNumber, `${pathLabel}.edges[${index}]`)
  );

  if (edges.length === 0) {
    throw new RagEvalParseError(
      `${pathLabel}.edges must contain at least one edge.`,
      filePath,
      lineNumber
    );
  }

  return {
    ...(depth === undefined ? {} : { depth }),
    ...(ordered === undefined ? {} : { ordered }),
    ...(requireEdgeEvidence === undefined ? {} : { requireEdgeEvidence }),
    edges
  };
}

function parseRelationshipEdgeExpectation(
  value: unknown,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): RagEvalRelationshipEdgeExpectation {
  const record = requiredRecord(value, filePath, lineNumber, pathLabel);
  const edge = {
    ...optionalTrimmedStringRecord(record, "relationType", filePath, lineNumber),
    ...optionalTrimmedStringRecord(record, "fromEntityId", filePath, lineNumber),
    ...optionalTrimmedStringRecord(record, "toEntityId", filePath, lineNumber),
    ...optionalTrimmedStringRecord(record, "fromName", filePath, lineNumber),
    ...optionalTrimmedStringRecord(record, "toName", filePath, lineNumber)
  };

  if (Object.keys(edge).length === 0) {
    throw new RagEvalParseError(
      `${pathLabel} must include at least one relationship matcher field.`,
      filePath,
      lineNumber
    );
  }

  return edge;
}

function parseModelOptions(
  value: unknown,
  filePath: string,
  lineNumber: number
): RagEvalModelOptions | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = requiredRecord(value, filePath, lineNumber, "model");
  return {
    ...optionalNumberRecord(record, "estimatedCostUsd", filePath, lineNumber),
    ...optionalStringArrayRecord(record, "citationDocumentIds", filePath, lineNumber),
    ...optionalTrimmedStringRecord(record, "answer", filePath, lineNumber),
    ...optionalTrimmedStringRecord(record, "evidenceSummary", filePath, lineNumber)
  };
}

function parseFilterOverrides(
  value: unknown,
  filePath: string,
  lineNumber: number
): EvalIndexFilterOverrides | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = requiredRecord(value, filePath, lineNumber, "filter");
  return {
    ...optionalStringArrayRecord(record, "documentIds", filePath, lineNumber),
    ...optionalStringArrayRecord(record, "chunkIds", filePath, lineNumber),
    ...optionalStringArrayRecord(record, "sourceIds", filePath, lineNumber),
    ...(optionalSourceKindArray(record, "sourceKinds", filePath, lineNumber) ?? {}),
    ...(optionalTrustTierArray(record, "trustTiers", filePath, lineNumber) ?? {}),
    ...(optionalChunkSafetyFlagArray(record, "includeSafetyFlags", filePath, lineNumber) ?? {}),
    ...(optionalChunkSafetyFlagArray(record, "excludeSafetyFlags", filePath, lineNumber) ?? {}),
    ...optionalStringArrayRecord(record, "accessTags", filePath, lineNumber),
    ...optionalNumberRecord(record, "limit", filePath, lineNumber)
  };
}

function parseOptionalTrustTier(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): TrustTier | undefined {
  const value = optionalString(record, key, filePath, lineNumber);
  if (value === undefined) {
    return undefined;
  }

  if (!isTrustTier(value)) {
    throw new RagEvalParseError(
      `${pathLabel}.${key} is not a supported trust tier.`,
      filePath,
      lineNumber
    );
  }

  return value;
}

function parseOptionalGraphProposalStatus(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): string | undefined {
  return parseOptionalEnum(record, key, GRAPH_PROPOSAL_STATUSES, filePath, lineNumber, pathLabel);
}

function parseOptionalEnum<const T extends readonly string[]>(
  record: Readonly<Record<string, unknown>>,
  key: string,
  values: T,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): T[number] | undefined {
  const value = optionalString(record, key, filePath, lineNumber);
  if (value === undefined) {
    return undefined;
  }

  if (!includesString(values, value)) {
    throw new RagEvalParseError(
      `${pathLabel}.${key} must be one of ${values.join(", ")}.`,
      filePath,
      lineNumber
    );
  }

  return value;
}

function parseConfidence(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): number {
  const value = requiredNumber(record, key, filePath, lineNumber);
  if (value < 0 || value > 1) {
    throw new RagEvalParseError(
      `${pathLabel}.${key} must be between 0 and 1.`,
      filePath,
      lineNumber
    );
  }
  return value;
}

function requiredRecord(
  value: unknown,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new RagEvalParseError(`${pathLabel} must be an object.`, filePath, lineNumber);
  }

  return value;
}

function requiredArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number
): readonly unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new RagEvalParseError(`${key} must be an array.`, filePath, lineNumber);
  }

  return value;
}

function optionalArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number
): readonly unknown[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new RagEvalParseError(`${key} must be an array.`, filePath, lineNumber);
  }

  return value;
}

function requiredString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number
): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new RagEvalParseError(`${key} must be a non-empty string.`, filePath, lineNumber);
  }

  return value;
}

function requiredNumber(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RagEvalParseError(`${key} must be a finite number.`, filePath, lineNumber);
  }

  return value;
}

function optionalNumber(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number
): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RagEvalParseError(`${key} must be a finite number.`, filePath, lineNumber);
  }

  return value;
}

function optionalString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new RagEvalParseError(`${key} must be a string.`, filePath, lineNumber);
  }

  return value;
}

function optionalBoolean(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number
): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new RagEvalParseError(`${key} must be a boolean.`, filePath, lineNumber);
  }

  return value;
}

function requiredBoolean(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number
): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new RagEvalParseError(`${key} must be a boolean.`, filePath, lineNumber);
  }

  return value;
}

function optionalTrimmedStringRecord(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number
): Readonly<Record<string, string>> {
  const value = optionalString(record, key, filePath, lineNumber)?.trim();
  return value ? { [key]: value } : {};
}

function requiredStringArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number
): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new RagEvalParseError(`${key} must be an array of strings.`, filePath, lineNumber);
  }

  return value;
}

function requiredNonEmptyStringArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number,
  pathLabel: string
): readonly string[] {
  const values = requiredStringArray(record, key, filePath, lineNumber).map((value) =>
    value.trim()
  );
  if (values.length === 0 || values.some((value) => value.length === 0)) {
    throw new RagEvalParseError(
      `${pathLabel}.${key} must contain non-empty strings.`,
      filePath,
      lineNumber
    );
  }

  return values;
}

function optionalStringArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number
): readonly string[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new RagEvalParseError(`${key} must be an array of strings.`, filePath, lineNumber);
  }

  return value;
}

function optionalStringArrayRecord(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number
): Readonly<Record<string, readonly string[]>> {
  const value = optionalStringArray(record, key, filePath, lineNumber);
  return value ? { [key]: value } : {};
}

function optionalNumberRecord(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number
): Readonly<Record<string, number>> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RagEvalParseError(`${key} must be a non-negative number.`, filePath, lineNumber);
  }

  return { [key]: value };
}

function optionalPositiveInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number
): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new RagEvalParseError(`${key} must be a positive integer.`, filePath, lineNumber);
  }

  return value;
}

function optionalNonNegativeInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number
): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RagEvalParseError(`${key} must be a non-negative integer.`, filePath, lineNumber);
  }

  return value;
}

function optionalRatio(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number
): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RagEvalParseError(`${key} must be a number between 0 and 1.`, filePath, lineNumber);
  }

  return value;
}

function optionalSourceKindArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number
): Pick<IndexFilter, "sourceKinds"> | undefined {
  const values = optionalStringArray(record, key, filePath, lineNumber);
  if (!values) {
    return undefined;
  }

  const sourceKinds: SourceKind[] = [];
  for (const value of values) {
    if (!isSourceKind(value)) {
      throw new RagEvalParseError(
        `${key} contains unsupported source kind "${value}".`,
        filePath,
        lineNumber
      );
    }
    sourceKinds.push(value);
  }

  return { sourceKinds };
}

function optionalTrustTierArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number
): Pick<IndexFilter, "trustTiers"> | undefined {
  const values = optionalStringArray(record, key, filePath, lineNumber);
  if (!values) {
    return undefined;
  }

  const trustTiers: TrustTier[] = [];
  for (const value of values) {
    if (!isTrustTier(value)) {
      throw new RagEvalParseError(
        `${key} contains unsupported trust tier "${value}".`,
        filePath,
        lineNumber
      );
    }
    trustTiers.push(value);
  }

  return { trustTiers };
}

function optionalChunkSafetyFlagArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
  filePath: string,
  lineNumber: number
): Pick<IndexFilter, "includeSafetyFlags" | "excludeSafetyFlags"> | undefined {
  const values = optionalStringArray(record, key, filePath, lineNumber);
  if (!values) {
    return undefined;
  }

  const safetyFlags: ChunkSafetyFlag[] = [];
  for (const value of values) {
    if (!includesString(CHUNK_SAFETY_FLAGS, value)) {
      throw new RagEvalParseError(
        `${key} contains unsupported safety flag "${value}".`,
        filePath,
        lineNumber
      );
    }
    safetyFlags.push(value);
  }

  return key === "includeSafetyFlags"
    ? { includeSafetyFlags: safetyFlags }
    : { excludeSafetyFlags: safetyFlags };
}

class StaticEvalCorpusAdapter implements CorpusAdapter {
  readonly description = "Static JSONL eval corpus adapter.";

  constructor(
    readonly id: string,
    private readonly records: readonly CorpusRecord[]
  ) {}

  async load(request: CorpusLoadRequest): Promise<CorpusLoadResult> {
    return {
      sourceId: request.source.id,
      records: this.records.filter((record) => record.sourceId === request.source.id),
      warnings: []
    };
  }
}

function hasRetrieval(
  answer: RagAnswerResult
): answer is Extract<RagAnswerResult, { readonly retrieval: unknown }> {
  return "retrieval" in answer;
}

function hasContext(
  answer: RagAnswerResult
): answer is Extract<RagAnswerResult, { readonly context: unknown }> {
  return "context" in answer;
}

function hasGeneration(
  answer: RagAnswerResult
): answer is Extract<RagAnswerResult, { readonly generation: unknown }> {
  return "generation" in answer;
}

function resolveEvalPath(projectRoot: string, evalPath: string): string {
  return path.isAbsolute(evalPath) ? evalPath : path.join(projectRoot, evalPath);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function safeId(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, "_");
}

function defaultNow(): string {
  return DEFAULT_EVAL_NOW;
}

function isRuntimeEvalCheck(check: RagEvalCheck): boolean {
  return RUNTIME_EVAL_CHECKS.some((runtimeCheck) => runtimeCheck === check);
}

function includesString<T extends string>(values: readonly T[], value: string): value is T {
  return values.some((entry) => entry === value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
