import { ContextBuilder } from "../context/context-builder.js";
import type { ContextBuildResult } from "../context/context-types.js";
import { hashText } from "../chunking/hash.js";
import { redactIndexFilterForTrace } from "../indexing/index-filter.js";
import { BudgetMeter, type BudgetIssue } from "../budget/budget-meter.js";
import { GenerationOrchestrator } from "../generation/generation-orchestrator.js";
import type { GenerationRunRequest, GenerationRunResult } from "../generation/generation-types.js";
import type {
  RagRunStatus,
  RagRunTrace,
  TraceEvent,
  TraceEventKind
} from "../observability/trace.js";
import { DefaultQueryPlanner } from "../query/default-query-planner.js";
import type { PlannedQuery, QueryPlan, QueryPlanner } from "../query/query-types.js";
import { mergeCandidatesByRrf } from "../retrieval/rrf.js";
import type {
  RetrievalCandidate,
  RetrievalBudgetTrace,
  RetrievalFreshnessTrace,
  RetrievalGraphBudgetTraceControls,
  RetrievalGraphRequestControls,
  RetrievalRejection,
  RetrievalRequest,
  RetrievalResult
} from "../retrieval/retrieval-types.js";
import type { Retriever } from "../retrieval/retriever.js";
import type {
  RagAnswerFailure,
  RagAnswerRequest,
  RagAnswerResult,
  RagQueryRequest,
  RagQueryResult
} from "./runtime-types.js";
import {
  DefaultRetrievalBudgetPolicy,
  type RetrievalBranchBudget,
  type RetrievalBudgetPlan,
  type RetrievalBudgetPolicy
} from "./retrieval-budget-policy.js";

export interface GenerationRunner {
  run(request: GenerationRunRequest): Promise<GenerationRunResult>;
}

export interface RagAnswerRuntimeOptions {
  readonly retriever: Retriever;
  readonly contextBuilder?: ContextBuilder;
  readonly generationRunner?: GenerationRunner;
  readonly queryPlanner?: QueryPlanner;
  readonly retrievalBudgetPolicy?: RetrievalBudgetPolicy;
  readonly now?: () => string;
}

interface TraceAccumulator {
  readonly runId: string;
  readonly traceId: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly startedAt: string;
  readonly questionHash: string;
  readonly plannedQueryHashes: string[];
  readonly events: TraceEvent[];
  queryPlanId?: string;
}

export class RagAnswerRuntime {
  private readonly retriever: Retriever;
  private readonly contextBuilder: ContextBuilder;
  private readonly generationRunner: GenerationRunner;
  private readonly queryPlanner: QueryPlanner;
  private readonly retrievalBudgetPolicy: RetrievalBudgetPolicy;
  private readonly now: () => string;

  constructor(options: RagAnswerRuntimeOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.retriever = options.retriever;
    this.contextBuilder = options.contextBuilder ?? new ContextBuilder({ now: this.now });
    this.queryPlanner = options.queryPlanner ?? new DefaultQueryPlanner({ now: this.now });
    this.retrievalBudgetPolicy =
      options.retrievalBudgetPolicy ?? new DefaultRetrievalBudgetPolicy();
    this.generationRunner =
      options.generationRunner ?? new GenerationOrchestrator({ now: this.now });
  }

  async answer(request: RagAnswerRequest): Promise<RagAnswerResult> {
    const planned = await this.planRetrieveAndBuildContext(request, "answer");

    if (planned.status !== "query_succeeded") {
      return planned;
    }

    const { retrieval, context, accumulator } = planned;
    const generationId = request.generationId ?? `${planned.runId}_generation`;
    const answerId = request.answerId ?? `${planned.runId}_answer`;

    addEvent(accumulator, "generation_started", this.now(), "Generation run started.", {
      generationId,
      answerId,
      contextId: context.trace.contextId,
      retrievalId: retrieval.trace.retrievalId
    });

    let generation: GenerationRunResult;
    try {
      generation = await this.generationRunner.run({
        profile: request.profile,
        context,
        question: request.question,
        model: request.model,
        generationId,
        answerId,
        requestedAt: this.now()
      });
    } catch (error) {
      const failure = failureSummary("generation", error);
      addFailureEvent(accumulator, "generation_failed", failure, this.now());
      return {
        status: "generation_failed",
        retrieval,
        context,
        failure,
        trace: buildRunTrace(accumulator, {
          status: "generation_failed",
          finishedAt: this.now(),
          retrieval,
          context,
          retrievalId: retrieval.trace.retrievalId,
          contextId: context.trace.contextId,
          generationId,
          answerId
        })
      };
    }

    addGenerationEvents(accumulator, generation);

    return {
      status: generation.status,
      retrieval,
      context,
      generation,
      answerCitations: generation.resolvedCitations,
      trace: buildRunTrace(accumulator, {
        status: generation.status,
        finishedAt: generation.trace.finishedAt,
        retrieval,
        context,
        generation,
        retrievalId: retrieval.trace.retrievalId,
        contextId: context.trace.contextId,
        generationId,
        answerId
      })
    };
  }

  async query(request: RagQueryRequest): Promise<RagQueryResult> {
    const planned = await this.planRetrieveAndBuildContext(request, "query");

    if (planned.status !== "query_succeeded") {
      return planned;
    }

    return {
      status: "query_succeeded",
      retrieval: planned.retrieval,
      context: planned.context,
      trace: buildRunTrace(planned.accumulator, {
        status: "query_succeeded",
        finishedAt: planned.context.trace.finishedAt,
        retrieval: planned.retrieval,
        context: planned.context,
        retrievalId: planned.retrieval.trace.retrievalId,
        contextId: planned.context.trace.contextId
      })
    };
  }

  private async planRetrieveAndBuildContext(
    request: RagQueryRequest,
    runKind: "answer" | "query"
  ): Promise<PreGenerationRunResult> {
    const startedAt = request.requestedAt ?? this.now();
    const runPrefix = runKind === "query" ? "query" : "run";
    const runId = request.runId ?? `${runPrefix}_${startedAt.replace(/[^0-9a-z]/gi, "")}`;
    const traceId = request.traceId ?? `trace_${runId}`;
    const retrievalId = request.retrievalId ?? `${runId}_retrieval`;
    const contextId = request.contextId ?? `${runId}_context`;
    const accumulator: TraceAccumulator = {
      runId,
      traceId,
      profileId: request.profile.id,
      namespaceId: request.profile.namespaceId,
      startedAt,
      questionHash: hashText(request.question),
      plannedQueryHashes: [],
      events: []
    };
    const budget = new BudgetMeter(request.profile.costLatencyBudget);

    addEvent(
      accumulator,
      "run_started",
      startedAt,
      runKind === "query" ? "RAG query run started." : "RAG answer run started.",
      {
        profileId: request.profile.id,
        namespaceId: request.profile.namespaceId
      }
    );

    let queryPlan: QueryPlan;
    try {
      queryPlan = await this.queryPlanner.plan({
        profile: request.profile,
        question: request.question,
        queryPlanId: `${runId}_query_plan`,
        requestedAt: startedAt,
        maxQueries: Math.max(1, Math.min(3, request.profile.costLatencyBudget.maxRetrievalCalls))
      });
      assertQueryPlanAllowed(queryPlan, request.profile);
    } catch (error) {
      const failure = failureSummary("retrieval", error);
      addFailureEvent(accumulator, "retrieval_failed", failure, this.now());
      return {
        status: "retrieval_failed",
        failure,
        trace: buildRunTrace(accumulator, {
          status: "retrieval_failed",
          finishedAt: this.now(),
          retrievalId
        })
      };
    }

    accumulator.queryPlanId = queryPlan.trace.queryPlanId;
    accumulator.plannedQueryHashes.push(...queryPlan.trace.plannedQueryHashes);
    addEvent(accumulator, "query_planned", queryPlan.trace.finishedAt, "Retrieval query planned.", {
      retrievalId,
      queryPlanId: queryPlan.trace.queryPlanId,
      queryCount: queryPlan.trace.queryCount,
      queryHashes: queryPlan.trace.plannedQueryHashes,
      lowLevelKeywordHashes: queryPlan.trace.lowLevelKeywordHashes,
      highLevelKeywordHashes: queryPlan.trace.highLevelKeywordHashes,
      primaryIntent: queryPlan.trace.primaryIntent,
      secondaryIntentHashes: queryPlan.trace.secondaryIntentHashes,
      sourceHintHashes: queryPlan.trace.sourceHintHashes,
      intentConfidence: queryPlan.trace.intentConfidence,
      graphRoute: queryPlan.trace.graphRoute,
      ...(queryPlan.trace.graphDirection === undefined
        ? {}
        : { graphDirection: queryPlan.trace.graphDirection }),
      ...(queryPlan.trace.graphExecutionMode === undefined
        ? {}
        : { graphExecutionMode: queryPlan.trace.graphExecutionMode }),
      graphRelationKindHashes: queryPlan.trace.graphRelationKindHashes,
      graphEntityHintHashes: queryPlan.trace.graphEntityHintHashes,
      rewriteEnabled: queryPlan.trace.rewriteEnabled,
      parallelQueriesEnabled: queryPlan.trace.parallelQueriesEnabled
    });
    if (
      !this.retriever.capabilities.modes.some((mode) => mode === request.profile.retrieval.mode)
    ) {
      const failure: RagAnswerFailure = {
        stage: "retrieval",
        errorName: "UnsupportedRetrievalMode",
        message: "Retrieval failed before a safe result was produced."
      };
      addFailureEvent(accumulator, "retrieval_failed", failure, this.now());
      return {
        status: "retrieval_failed",
        failure,
        trace: buildRunTrace(accumulator, {
          status: "retrieval_failed",
          finishedAt: this.now(),
          retrievalId
        })
      };
    }

    if (
      queryPlan.graphIntent.route === "graph_required" &&
      this.retriever.capabilities.supportsGraphSearch !== true
    ) {
      const failure: RagAnswerFailure = {
        stage: "retrieval",
        errorName: "GraphRetrievalRequired",
        message: "Retrieval failed before a graph-required query could be answered safely."
      };
      addFailureEvent(accumulator, "retrieval_failed", failure, this.now());
      return {
        status: "retrieval_failed",
        failure,
        trace: buildRunTrace(accumulator, {
          status: "retrieval_failed",
          finishedAt: this.now(),
          retrievalId
        })
      };
    }

    const retrievalBudgetIssues = recordRetrievalCalls(budget, queryPlan.queries.length);

    if (retrievalBudgetIssues.length > 0) {
      const failure: RagAnswerFailure = {
        stage: "retrieval",
        errorName: "BudgetExceeded",
        message: "Retrieval failed before a safe result was produced."
      };
      addFailureEvent(accumulator, "retrieval_failed", failure, this.now());
      return {
        status: "retrieval_failed",
        failure,
        trace: buildRunTrace(accumulator, {
          status: "retrieval_failed",
          finishedAt: this.now(),
          retrievalId
        })
      };
    }

    let retrievalBudget: RetrievalBudgetPlan;
    try {
      retrievalBudget = this.retrievalBudgetPolicy.plan({
        profile: request.profile,
        queryPlan,
        requestedTopK: request.topK ?? request.profile.retrieval.maxChunks,
        ...(request.candidatePoolLimit === undefined
          ? {}
          : { requestedCandidatePoolLimit: request.candidatePoolLimit }),
        retrieverSupportsGraphSearch: this.retriever.capabilities.supportsGraphSearch === true
      });
    } catch (error) {
      const failure = failureSummary("retrieval", error);
      addFailureEvent(accumulator, "retrieval_failed", failure, this.now());
      return {
        status: "retrieval_failed",
        failure,
        trace: buildRunTrace(accumulator, {
          status: "retrieval_failed",
          finishedAt: this.now(),
          retrievalId
        })
      };
    }

    const retrievalBudgetTrace = redactRetrievalBudgetTrace(retrievalBudget);
    addEvent(accumulator, "retrieval_started", startedAt, "Retrieval started.", {
      retrievalId,
      topK: request.topK ?? request.profile.retrieval.maxChunks,
      plannedQueryCount: queryPlan.queries.length,
      enabledQueryCount: retrievalBudget.enabledQueryCount,
      retrievalBudget: retrievalBudgetTrace
    });

    let retrieval: RetrievalResult;
    try {
      retrieval = await retrieveWithQueryPlan({
        retriever: this.retriever,
        request,
        queryPlan,
        retrievalBudget,
        retrievalId,
        startedAt,
        now: this.now
      });
    } catch (error) {
      const failure = failureSummary("retrieval", error);
      addFailureEvent(accumulator, "retrieval_failed", failure, this.now());
      return {
        status: "retrieval_failed",
        failure,
        trace: buildRunTrace(accumulator, {
          status: "retrieval_failed",
          finishedAt: this.now(),
          retrievalId
        })
      };
    }

    addRetrievalEvents(accumulator, retrieval);

    let context: ContextBuildResult;
    try {
      context = this.contextBuilder.build({
        profile: request.profile,
        retrieval,
        queryIntent: {
          primary: queryPlan.intent.primary,
          secondary: queryPlan.intent.secondary,
          sourceHints: queryPlan.intent.sourceHints
        },
        contextId,
        includeRejected:
          request.includeRejected ??
          request.profile.observabilityPolicy.includeRejectedChunksInTrace,
        requestedAt: this.now()
      });
    } catch (error) {
      const failure = failureSummary("context", error);
      addFailureEvent(accumulator, "context_failed", failure, this.now());
      return {
        status: "context_failed",
        retrieval,
        failure,
        trace: buildRunTrace(accumulator, {
          status: "context_failed",
          finishedAt: this.now(),
          retrieval,
          retrievalId,
          contextId
        })
      };
    }

    addContextEvents(accumulator, context);

    return {
      status: "query_succeeded",
      retrieval,
      context,
      accumulator,
      runId
    };
  }
}

type PreGenerationRunResult =
  | {
      readonly status: "query_succeeded";
      readonly retrieval: RetrievalResult;
      readonly context: ContextBuildResult;
      readonly accumulator: TraceAccumulator;
      readonly runId: string;
    }
  | Extract<RagQueryResult, { readonly status: "retrieval_failed" | "context_failed" }>;

function recordRetrievalCalls(budget: BudgetMeter, count: number): readonly BudgetIssue[] {
  const issues: BudgetIssue[] = [];

  for (let index = 0; index < count; index += 1) {
    issues.push(...budget.recordRetrievalCall());
  }

  return issues;
}

async function retrieveWithQueryPlan(input: {
  readonly retriever: Retriever;
  readonly request: RagQueryRequest;
  readonly queryPlan: QueryPlan;
  readonly retrievalBudget: RetrievalBudgetPlan;
  readonly retrievalId: string;
  readonly startedAt: string;
  readonly now: () => string;
}): Promise<RetrievalResult> {
  const budgetedQueries = budgetedPlannedQueries(input.queryPlan, input.retrievalBudget);
  if (budgetedQueries.length === 0) {
    throw new Error("Retrieval budget disabled every planned query.");
  }

  if (budgetedQueries.length === 1) {
    const query = budgetedQueries[0];
    if (!query) {
      throw new Error("Retrieval budget produced an unreadable query branch.");
    }
    const result = await input.retriever.retrieve(
      retrievalRequestForPlannedQuery({
        request: input.request,
        queryPlan: input.queryPlan,
        plannedQuery: query.plannedQuery,
        branchBudget: query.budget,
        retrievalId: input.retrievalId,
        requestedAt: input.startedAt
      })
    );
    return withRetrievalBudgetTrace(result, input.retrievalBudget);
  }

  const childResults = await Promise.all(
    budgetedQueries.map((query) =>
      input.retriever.retrieve(
        retrievalRequestForPlannedQuery({
          request: input.request,
          queryPlan: input.queryPlan,
          plannedQuery: query.plannedQuery,
          branchBudget: query.budget,
          retrievalId: `${input.retrievalId}_${query.plannedQuery.id}`,
          requestedAt: input.startedAt
        })
      )
    )
  );

  return mergePlannedRetrievalResults({
    request: input.request,
    budgetedQueries,
    retrievalBudget: input.retrievalBudget,
    retrievalId: input.retrievalId,
    startedAt: input.startedAt,
    finishedAt: input.now(),
    results: childResults
  });
}

function retrievalRequestForPlannedQuery(input: {
  readonly request: RagQueryRequest;
  readonly queryPlan: QueryPlan;
  readonly plannedQuery: PlannedQuery;
  readonly branchBudget?: RetrievalBranchBudget;
  readonly retrievalId: string;
  readonly requestedAt: string;
  readonly expandCandidatePool?: boolean;
}): RetrievalRequest {
  const requestedTopK = input.request.topK ?? input.request.profile.retrieval.maxChunks;
  const candidatePoolLimit =
    input.branchBudget?.candidatePoolLimit ??
    input.request.candidatePoolLimit ??
    (input.expandCandidatePool ? Math.min(Math.max(requestedTopK * 4, 20), 5000) : undefined);
  const topK =
    input.branchBudget?.topK ??
    (input.expandCandidatePool && candidatePoolLimit !== undefined
      ? Math.min(candidatePoolLimit, 100)
      : requestedTopK);
  const filter = applyBranchFilter(input.request.filter, input.branchBudget?.filter);

  return {
    query: input.plannedQuery.query,
    filter,
    topK,
    mode: input.request.profile.retrieval.mode,
    ...(candidatePoolLimit !== undefined ? { candidatePoolLimit } : {}),
    ...(input.branchBudget?.graph === undefined ? {} : { graph: input.branchBudget.graph }),
    intent: {
      primary: input.queryPlan.intent.primary,
      secondary: input.queryPlan.intent.secondary,
      sourceHints: input.queryPlan.intent.sourceHints
    },
    includeRejected:
      input.request.includeRejected ??
      input.request.profile.observabilityPolicy.includeRejectedChunksInTrace,
    retrievalId: input.retrievalId,
    requestedAt: input.requestedAt
  };
}

function mergePlannedRetrievalResults(input: {
  readonly request: RagQueryRequest;
  readonly budgetedQueries: readonly BudgetedPlannedQuery[];
  readonly retrievalBudget: RetrievalBudgetPlan;
  readonly retrievalId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly results: readonly RetrievalResult[];
}): RetrievalResult {
  const requestedTopK = input.request.topK ?? input.request.profile.retrieval.maxChunks;
  const mergedPool = mergeCandidatesByRrf(
    input.results.map((result, index) => {
      const plannedQuery =
        input.budgetedQueries[index]?.plannedQuery ?? originalPlannedQuery(input.request.question);
      const branchBudget = input.budgetedQueries[index]?.budget;
      return {
        candidates: result.candidates,
        weight: branchBudget?.fusionWeight ?? plannedQuery.weight,
        componentReason: `planned_query_${plannedQuery.kind}`
      };
    }),
    {
      scoreReason: "query_plan_rrf_score"
    }
  );
  const ranked = mergedPool.slice(0, requestedTopK).map<RetrievalCandidate>((candidate, index) => ({
    chunk: candidate.chunk,
    score: candidate.score,
    rank: index + 1,
    matchedTerms: candidate.matchedTerms,
    citation: candidate.citation,
    reasons: candidate.reasons,
    ...(candidate.graphEvidence === undefined ? {} : { graphEvidence: candidate.graphEvidence })
  }));
  const rejected = dedupeRetrievalRejections(input.results.flatMap((result) => result.rejected));
  const freshnessTrace = mergeFreshnessTraces(
    input.results.map((result) => result.trace.freshness).filter((trace) => trace !== undefined)
  );

  return {
    query: input.request.question,
    candidates: ranked,
    rejected,
    trace: {
      retrievalId: input.retrievalId,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      mode: input.request.profile.retrieval.mode,
      queryHash: hashText(input.request.question),
      normalizedQueryHash: hashText(normalizeQuery(input.request.question)),
      searchTermHashes: unique(input.results.flatMap((result) => result.trace.searchTermHashes)),
      access: redactIndexFilterForTrace(input.request.filter),
      candidatePoolSize: mergedPool.length,
      returnedCount: ranked.length,
      rejectedCount: rejected.length,
      fusionStrategy: "planned_query_rrf",
      childRetrievalIds: input.results.map((result) => result.trace.retrievalId),
      plannedQueryHashes: input.budgetedQueries.map((query) => hashText(query.plannedQuery.query)),
      retrievalBudget: redactRetrievalBudgetTrace(input.retrievalBudget),
      ...(freshnessTrace === undefined ? {} : { freshness: freshnessTrace })
    }
  };
}

function mergeFreshnessTraces(
  traces: readonly RetrievalFreshnessTrace[]
): RetrievalFreshnessTrace | undefined {
  if (traces.length === 0) {
    return undefined;
  }

  const boostedCandidateCount = traces.reduce((sum, trace) => sum + trace.boostedCandidateCount, 0);
  return {
    applied: traces.some((trace) => trace.applied),
    boostedCandidateCount,
    reason:
      boostedCandidateCount > 0
        ? "Freshness query intent applied bounded recency ranking boost in planned retrieval branches."
        : "Freshness query intent was detected in planned retrieval branches, but no candidates had boostable recency metadata."
  };
}

function originalPlannedQuery(question: string): PlannedQuery {
  return {
    id: "q_original",
    query: question,
    kind: "original",
    weight: 1
  };
}

interface BudgetedPlannedQuery {
  readonly plannedQuery: PlannedQuery;
  readonly budget: RetrievalBranchBudget;
}

function budgetedPlannedQueries(
  queryPlan: QueryPlan,
  retrievalBudget: RetrievalBudgetPlan
): readonly BudgetedPlannedQuery[] {
  return queryPlan.queries.flatMap((plannedQuery, index) => {
    const branch = retrievalBudget.branches[index];
    if (!branch) {
      throw new Error(`Retrieval budget is missing a branch for planned query ${plannedQuery.id}.`);
    }

    if (branch.plannedQueryId !== plannedQuery.id) {
      throw new Error(
        `Retrieval budget branch ${branch.plannedQueryId} does not match planned query ${plannedQuery.id}.`
      );
    }

    if (!branch.enabled) {
      return [];
    }

    return [{ plannedQuery, budget: branch }];
  });
}

function withRetrievalBudgetTrace(
  result: RetrievalResult,
  retrievalBudget: RetrievalBudgetPlan
): RetrievalResult {
  return {
    ...result,
    trace: {
      ...result.trace,
      retrievalBudget: redactRetrievalBudgetTrace(retrievalBudget)
    }
  };
}

function redactRetrievalBudgetTrace(retrievalBudget: RetrievalBudgetPlan): RetrievalBudgetTrace {
  return {
    ...retrievalBudget,
    branches: retrievalBudget.branches.map((branch) => {
      const { graph, filter, prefer, ...rest } = branch;
      return {
        ...rest,
        ...(filter === undefined ? {} : { routeFilter: redactBranchFilterTrace(filter) }),
        ...(prefer === undefined ? {} : { routePreference: redactBranchPreferenceTrace(prefer) }),
        ...(graph === undefined ? {} : { graph: redactGraphBudgetTrace(graph) })
      };
    })
  };
}

function applyBranchFilter(
  baseFilter: RagQueryRequest["filter"],
  branchFilter: RetrievalBranchBudget["filter"] | undefined
): RagQueryRequest["filter"] {
  if (branchFilter === undefined) {
    return baseFilter;
  }
  const sourceIds = intersectOptionalList(baseFilter.sourceIds, branchFilter.sourceIds);
  const sourceKinds = intersectOptionalList(baseFilter.sourceKinds, branchFilter.sourceKinds);
  const trustTiers = intersectOptionalList(baseFilter.trustTiers, branchFilter.trustTiers);

  return {
    ...baseFilter,
    ...(sourceIds === undefined ? {} : { sourceIds }),
    ...(sourceKinds === undefined ? {} : { sourceKinds }),
    ...(trustTiers === undefined ? {} : { trustTiers })
  };
}

function intersectOptionalList<Value extends string>(
  existing: readonly Value[] | undefined,
  routed: readonly Value[] | undefined
): readonly Value[] | undefined {
  if (routed === undefined || routed.length === 0) {
    return existing;
  }

  if (existing === undefined || existing.length === 0) {
    return routed;
  }

  const routedValues = new Set<unknown>(routed);
  return existing.filter((value) => routedValues.has(value));
}

function redactBranchFilterTrace(filter: NonNullable<RetrievalBranchBudget["filter"]>) {
  return {
    sourceIdCount: filter.sourceIds?.length ?? 0,
    sourceIdHashes: (filter.sourceIds ?? []).map(hashText),
    sourceKindCount: filter.sourceKinds?.length ?? 0,
    sourceKindHashes: (filter.sourceKinds ?? []).map(hashText),
    trustTierCount: filter.trustTiers?.length ?? 0,
    trustTierHashes: (filter.trustTiers ?? []).map(hashText)
  };
}

function redactBranchPreferenceTrace(preference: NonNullable<RetrievalBranchBudget["prefer"]>) {
  return {
    ...redactBranchFilterTrace(preference),
    fusionWeightMultiplier: preference.fusionWeightMultiplier
  };
}

function redactGraphBudgetTrace(
  graph: RetrievalGraphRequestControls
): RetrievalGraphBudgetTraceControls {
  const { entityHints, ...safeGraph } = graph;
  return {
    ...safeGraph,
    ...(entityHints === undefined
      ? {}
      : {
          entityHintCount: entityHints.length,
          entityHintHashes: entityHints.map(hashText)
        })
  };
}

function assertQueryPlanAllowed(queryPlan: QueryPlan, profile: RagAnswerRequest["profile"]): void {
  if (queryPlan.queries.length < 1) {
    throw new Error("Query planner returned no retrieval queries.");
  }

  if (
    !profile.retrieval.allowQueryRewrite &&
    queryPlan.queries.some((query) => query.kind !== "original")
  ) {
    throw new Error("Query planner returned rewritten queries when profile disallows rewriting.");
  }

  if (!profile.retrieval.allowParallelQueries && queryPlan.queries.length > 1) {
    throw new Error("Query planner returned parallel queries when profile disallows them.");
  }

  for (const query of queryPlan.queries) {
    if (!query.query.trim()) {
      throw new Error("Query planner returned an empty retrieval query.");
    }
  }
}

function addRetrievalEvents(accumulator: TraceAccumulator, retrieval: RetrievalResult): void {
  addEvent(accumulator, "retrieval_finished", retrieval.trace.finishedAt, "Retrieval finished.", {
    retrievalId: retrieval.trace.retrievalId,
    candidatePoolSize: retrieval.trace.candidatePoolSize,
    returnedCount: retrieval.trace.returnedCount,
    rejectedCount: retrieval.trace.rejectedCount,
    ...(retrieval.trace.fusionStrategy ? { fusionStrategy: retrieval.trace.fusionStrategy } : {}),
    ...(retrieval.trace.childRetrievalIds
      ? { childRetrievalIds: retrieval.trace.childRetrievalIds }
      : {})
  });

  if (retrieval.rerank) {
    addEvent(
      accumulator,
      "retrieval_reranked",
      retrieval.rerank.finishedAt,
      "Retrieval reranked.",
      {
        retrievalId: retrieval.trace.retrievalId,
        rerankId: retrieval.rerank.rerankId,
        mode: retrieval.rerank.mode,
        inputCandidateCount: retrieval.rerank.inputCandidateCount,
        returnedCount: retrieval.rerank.returnedCount,
        rejectedCount: retrieval.rerank.rejectedCount,
        ...(retrieval.rerank.provider ? { provider: retrieval.rerank.provider } : {}),
        ...(retrieval.rerank.modelName ? { modelName: retrieval.rerank.modelName } : {})
      }
    );
  }

  for (const candidate of retrieval.candidates) {
    addEvent(accumulator, "chunk_retrieved", retrieval.trace.finishedAt, "Chunk retrieved.", {
      retrievalId: retrieval.trace.retrievalId,
      chunkId: candidate.chunk.id,
      documentId: candidate.chunk.documentId,
      sourceId: candidate.chunk.provenance.sourceId,
      trustTier: candidate.chunk.provenance.trustTier,
      rank: candidate.rank,
      score: candidate.score
    });
  }

  for (const rejection of retrieval.rejected) {
    addEvent(
      accumulator,
      "chunk_rejected",
      retrieval.trace.finishedAt,
      "Retrieval candidate rejected.",
      {
        retrievalId: retrieval.trace.retrievalId,
        code: rejection.code,
        ...(rejection.chunkId ? { chunkId: rejection.chunkId } : {})
      }
    );
  }
}

function addContextEvents(accumulator: TraceAccumulator, context: ContextBuildResult): void {
  addEvent(accumulator, "context_built", context.trace.finishedAt, "Context built.", {
    contextId: context.trace.contextId,
    retrievalId: context.trace.retrievalId,
    blockCount: context.trace.blockCount,
    rejectedCount: context.trace.rejectedCount,
    totalTokenEstimate: context.trace.totalTokenEstimate,
    evidenceStatus: context.evidence.status
  });

  for (const rejection of context.rejected) {
    addEvent(
      accumulator,
      "chunk_rejected",
      context.trace.finishedAt,
      "Context candidate rejected.",
      {
        contextId: context.trace.contextId,
        code: rejection.code,
        ...(rejection.chunkId ? { chunkId: rejection.chunkId } : {}),
        ...(rejection.documentId ? { documentId: rejection.documentId } : {})
      }
    );
  }
}

function addGenerationEvents(accumulator: TraceAccumulator, generation: GenerationRunResult): void {
  addEvent(
    accumulator,
    "grounding_checked",
    generation.gate.trace.finishedAt,
    "Grounding gate checked.",
    {
      answerId: generation.trace.answerId,
      contextId: generation.trace.contextId,
      retrievalId: generation.trace.retrievalId,
      status: generation.gate.status,
      ...(generation.gate.refusal ? { refusalCode: generation.gate.refusal.code } : {})
    }
  );

  addEvent(
    accumulator,
    "answer_generated",
    generation.trace.finishedAt,
    "Generation run finished.",
    {
      generationId: generation.trace.generationId,
      answerId: generation.trace.answerId,
      status: generation.status,
      gateStatus: generation.trace.gateStatus,
      validationErrorCount: generation.trace.validationErrorCount,
      warningCount: generation.trace.warningCount,
      modelAttempted: generation.trace.model.attempted,
      ...(generation.trace.model.requestId
        ? { modelRequestId: generation.trace.model.requestId }
        : {}),
      ...(generation.trace.model.provider ? { provider: generation.trace.model.provider } : {}),
      ...(generation.trace.model.modelName ? { modelName: generation.trace.model.modelName } : {})
    }
  );

  if (generation.trace.groundingJudge) {
    addEvent(
      accumulator,
      "grounding_judged",
      generation.trace.finishedAt,
      "Grounding judge checked generated answer.",
      {
        generationId: generation.trace.generationId,
        answerId: generation.trace.answerId,
        judgeId: generation.trace.groundingJudge.judgeId,
        verdict: generation.trace.groundingJudge.verdict,
        issueCount: generation.trace.groundingJudge.issueCount,
        provider: generation.trace.groundingJudge.provider,
        modelName: generation.trace.groundingJudge.modelName
      }
    );
  }
}

function addFailureEvent(
  accumulator: TraceAccumulator,
  status: Extract<RagRunStatus, "retrieval_failed" | "context_failed" | "generation_failed">,
  failure: RagAnswerFailure,
  at: string
): void {
  addEvent(accumulator, "run_failed", at, "RAG answer run failed.", {
    status,
    stage: failure.stage,
    errorName: failure.errorName
  });
}

function buildRunTrace(
  accumulator: TraceAccumulator,
  input: {
    readonly status: RagRunStatus;
    readonly finishedAt: string;
    readonly retrieval?: RetrievalResult;
    readonly context?: ContextBuildResult;
    readonly generation?: GenerationRunResult;
    readonly retrievalId?: string;
    readonly contextId?: string;
    readonly generationId?: string;
    readonly answerId?: string;
  }
): RagRunTrace {
  const retrievedChunkIds =
    input.retrieval?.candidates.map((candidate) => candidate.chunk.id) ?? [];
  const rejectedChunkIds = [
    ...(input.retrieval?.rejected.flatMap((rejection) =>
      rejection.chunkId ? [rejection.chunkId] : []
    ) ?? []),
    ...(input.context?.rejected.flatMap((rejection) =>
      rejection.chunkId ? [rejection.chunkId] : []
    ) ?? [])
  ];
  const finalCitations =
    input.generation?.draft?.citationChunkIds.flatMap(
      (chunkId) => input.context?.citations.filter((citation) => citation.chunkId === chunkId) ?? []
    ) ?? [];
  const safetyFlags = input.context?.blocks.flatMap((block) => block.safetyFlags) ?? [];
  const runFinishedEvent: TraceEvent = {
    runId: accumulator.runId,
    traceId: accumulator.traceId,
    kind: "run_finished",
    at: input.finishedAt,
    message: "RAG answer run finished.",
    data: {
      status: input.status
    }
  };

  return {
    runId: accumulator.runId,
    traceId: accumulator.traceId,
    profileId: accumulator.profileId,
    namespaceId: accumulator.namespaceId,
    startedAt: accumulator.startedAt,
    finishedAt: input.finishedAt,
    status: input.status,
    questionHash: accumulator.questionHash,
    ...(accumulator.queryPlanId ? { queryPlanId: accumulator.queryPlanId } : {}),
    plannedQueryHashes: accumulator.plannedQueryHashes,
    ...(input.retrieval || input.retrievalId
      ? { retrievalId: input.retrieval?.trace.retrievalId ?? input.retrievalId }
      : {}),
    ...(input.context || input.contextId
      ? { contextId: input.context?.trace.contextId ?? input.contextId }
      : {}),
    ...(input.generation || input.generationId
      ? { generationId: input.generation?.trace.generationId ?? input.generationId }
      : {}),
    ...(input.generation || input.answerId
      ? { answerId: input.generation?.trace.answerId ?? input.answerId }
      : {}),
    ...(input.generation?.trace.model.requestId
      ? { modelRequestId: input.generation.trace.model.requestId }
      : {}),
    retrievedChunkIds: unique(retrievedChunkIds),
    rejectedChunkIds: unique(rejectedChunkIds),
    finalCitations,
    safetyFlags: unique(safetyFlags),
    events: [...accumulator.events, runFinishedEvent]
  };
}

function addEvent(
  accumulator: TraceAccumulator,
  kind: TraceEventKind,
  at: string,
  message: string,
  data?: Readonly<Record<string, unknown>>
): void {
  accumulator.events.push({
    runId: accumulator.runId,
    traceId: accumulator.traceId,
    kind,
    at,
    message,
    ...(data ? { data } : {})
  });
}

function failureSummary(stage: RagAnswerFailure["stage"], error: unknown): RagAnswerFailure {
  return {
    stage,
    errorName: error instanceof Error ? error.name : "UnknownError",
    message: `${stage} failed before a safe result was produced.`
  };
}

function dedupeRetrievalRejections(
  rejections: readonly RetrievalRejection[]
): readonly RetrievalRejection[] {
  const seen = new Set<string>();
  const deduped: RetrievalRejection[] = [];

  for (const rejection of rejections) {
    const key = `${rejection.chunkId ?? ""}:${rejection.code}:${rejection.reason}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(rejection);
  }

  return deduped;
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
