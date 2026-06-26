import type { RagProfile } from "../profiles/profile.js";
import type { GraphQueryRoute, PlannedQuery, QueryPlan } from "../query/query-types.js";
import type {
  RetrievalBudgetTrace,
  RetrievalGraphRequestControls
} from "../retrieval/retrieval-types.js";

const MAX_TOP_K = 100;
const MAX_CANDIDATE_POOL_LIMIT = 5000;
const DEFAULT_PARALLEL_CANDIDATE_MULTIPLIER = 4;
const DEFAULT_PARALLEL_CANDIDATE_FLOOR = 20;
const DEFAULT_GRAPH_OPTIONAL_ENTITY_LIMIT = 4;
const DEFAULT_GRAPH_OPTIONAL_NEIGHBOR_LIMIT = 8;
const DEFAULT_GRAPH_OPTIONAL_MAX_DEPTH = 1;
const DEFAULT_GRAPH_OPTIONAL_MAX_VISITED_ENTITIES = 64;
const DEFAULT_GRAPH_REQUIRED_ENTITY_LIMIT = 8;
const DEFAULT_GRAPH_REQUIRED_NEIGHBOR_LIMIT = 24;
const DEFAULT_GRAPH_REQUIRED_MAX_DEPTH = 2;
const DEFAULT_GRAPH_REQUIRED_MAX_VISITED_ENTITIES = 256;

export interface RetrievalBudgetPolicyRequest {
  readonly profile: RagProfile;
  readonly queryPlan: QueryPlan;
  readonly requestedTopK: number;
  readonly requestedCandidatePoolLimit?: number;
  readonly retrieverSupportsGraphSearch: boolean;
}

export interface RetrievalBudgetPolicy {
  plan(request: RetrievalBudgetPolicyRequest): RetrievalBudgetPlan;
}

export interface RetrievalBudgetPlan extends RetrievalBudgetTrace {
  readonly branches: readonly RetrievalBranchBudget[];
}

export interface RetrievalBranchBudget {
  readonly plannedQueryId: string;
  readonly kind: PlannedQuery["kind"];
  readonly enabled: boolean;
  readonly topK: number;
  readonly fusionWeight: number;
  readonly candidatePoolLimit?: number;
  readonly graph?: RetrievalGraphRequestControls;
  readonly reasons: readonly string[];
}

export interface DefaultRetrievalBudgetPolicyOptions {
  readonly maxTopK?: number;
  readonly maxCandidatePoolLimit?: number;
  readonly parallelCandidateMultiplier?: number;
  readonly parallelCandidateFloor?: number;
  readonly graphOptionalEntityLimit?: number;
  readonly graphOptionalNeighborLimit?: number;
  readonly graphOptionalMaxDepth?: number;
  readonly graphOptionalMaxVisitedEntities?: number;
  readonly graphRequiredEntityLimit?: number;
  readonly graphRequiredNeighborLimit?: number;
  readonly graphRequiredMaxDepth?: number;
  readonly graphRequiredMaxVisitedEntities?: number;
}

export class DefaultRetrievalBudgetPolicy implements RetrievalBudgetPolicy {
  private readonly maxTopK: number;
  private readonly maxCandidatePoolLimit: number;
  private readonly parallelCandidateMultiplier: number;
  private readonly parallelCandidateFloor: number;
  private readonly graphOptionalEntityLimit: number;
  private readonly graphOptionalNeighborLimit: number;
  private readonly graphOptionalMaxDepth: number;
  private readonly graphOptionalMaxVisitedEntities: number;
  private readonly graphRequiredEntityLimit: number;
  private readonly graphRequiredNeighborLimit: number;
  private readonly graphRequiredMaxDepth: number;
  private readonly graphRequiredMaxVisitedEntities: number;

  constructor(options: DefaultRetrievalBudgetPolicyOptions = {}) {
    this.maxTopK = positiveIntegerOption(options.maxTopK, MAX_TOP_K, "maxTopK");
    this.maxCandidatePoolLimit = positiveIntegerOption(
      options.maxCandidatePoolLimit,
      MAX_CANDIDATE_POOL_LIMIT,
      "maxCandidatePoolLimit"
    );
    this.parallelCandidateMultiplier = positiveIntegerOption(
      options.parallelCandidateMultiplier,
      DEFAULT_PARALLEL_CANDIDATE_MULTIPLIER,
      "parallelCandidateMultiplier"
    );
    this.parallelCandidateFloor = positiveIntegerOption(
      options.parallelCandidateFloor,
      DEFAULT_PARALLEL_CANDIDATE_FLOOR,
      "parallelCandidateFloor"
    );
    this.graphOptionalEntityLimit = positiveIntegerOption(
      options.graphOptionalEntityLimit,
      DEFAULT_GRAPH_OPTIONAL_ENTITY_LIMIT,
      "graphOptionalEntityLimit"
    );
    this.graphOptionalNeighborLimit = positiveIntegerOption(
      options.graphOptionalNeighborLimit,
      DEFAULT_GRAPH_OPTIONAL_NEIGHBOR_LIMIT,
      "graphOptionalNeighborLimit"
    );
    this.graphOptionalMaxDepth = positiveIntegerOption(
      options.graphOptionalMaxDepth,
      DEFAULT_GRAPH_OPTIONAL_MAX_DEPTH,
      "graphOptionalMaxDepth"
    );
    this.graphOptionalMaxVisitedEntities = positiveIntegerOption(
      options.graphOptionalMaxVisitedEntities,
      DEFAULT_GRAPH_OPTIONAL_MAX_VISITED_ENTITIES,
      "graphOptionalMaxVisitedEntities"
    );
    this.graphRequiredEntityLimit = positiveIntegerOption(
      options.graphRequiredEntityLimit,
      DEFAULT_GRAPH_REQUIRED_ENTITY_LIMIT,
      "graphRequiredEntityLimit"
    );
    this.graphRequiredNeighborLimit = positiveIntegerOption(
      options.graphRequiredNeighborLimit,
      DEFAULT_GRAPH_REQUIRED_NEIGHBOR_LIMIT,
      "graphRequiredNeighborLimit"
    );
    this.graphRequiredMaxDepth = positiveIntegerOption(
      options.graphRequiredMaxDepth,
      DEFAULT_GRAPH_REQUIRED_MAX_DEPTH,
      "graphRequiredMaxDepth"
    );
    this.graphRequiredMaxVisitedEntities = positiveIntegerOption(
      options.graphRequiredMaxVisitedEntities,
      DEFAULT_GRAPH_REQUIRED_MAX_VISITED_ENTITIES,
      "graphRequiredMaxVisitedEntities"
    );
  }

  plan(request: RetrievalBudgetPolicyRequest): RetrievalBudgetPlan {
    const requestedTopK = boundedPositiveInteger(request.requestedTopK, this.maxTopK, "topK");
    const requestedCandidatePoolLimit =
      request.requestedCandidatePoolLimit === undefined
        ? undefined
        : boundedPositiveInteger(
            request.requestedCandidatePoolLimit,
            this.maxCandidatePoolLimit,
            "candidatePoolLimit"
          );
    const maxRetrievalCalls = boundedPositiveInteger(
      request.profile.costLatencyBudget.maxRetrievalCalls,
      Number.MAX_SAFE_INTEGER,
      "maxRetrievalCalls"
    );

    if (request.queryPlan.queries.length > maxRetrievalCalls) {
      throw new Error(
        `Query plan requested ${request.queryPlan.queries.length} retrieval calls, exceeding profile maxRetrievalCalls=${maxRetrievalCalls}.`
      );
    }

    const parallel = request.queryPlan.queries.length > 1;
    const branches = request.queryPlan.queries.map((plannedQuery) =>
      this.branchBudget({
        plannedQuery,
        queryPlan: request.queryPlan,
        requestedTopK,
        ...(requestedCandidatePoolLimit === undefined ? {} : { requestedCandidatePoolLimit }),
        retrieverSupportsGraphSearch: request.retrieverSupportsGraphSearch,
        parallel
      })
    );
    const enabledBranches = branches.filter((branch) => branch.enabled);
    const totalCandidatePoolLimit = sumDefined(
      enabledBranches.map((branch) => branch.candidatePoolLimit)
    );

    return {
      strategy: "default_retrieval_budget",
      requestedTopK,
      maxRetrievalCalls,
      enabledQueryCount: enabledBranches.length,
      ...(totalCandidatePoolLimit === undefined ? {} : { totalCandidatePoolLimit }),
      disabledQueryIds: branches
        .filter((branch) => !branch.enabled)
        .map((branch) => branch.plannedQueryId),
      branches
    };
  }

  private branchBudget(input: {
    readonly plannedQuery: PlannedQuery;
    readonly queryPlan: QueryPlan;
    readonly requestedTopK: number;
    readonly requestedCandidatePoolLimit?: number;
    readonly retrieverSupportsGraphSearch: boolean;
    readonly parallel: boolean;
  }): RetrievalBranchBudget {
    const reasons: string[] = [];
    const uncappedTopK = branchTopK(
      input.plannedQuery,
      input.requestedTopK,
      input.queryPlan.graphIntent.route,
      this.maxTopK
    );
    const topK =
      input.requestedCandidatePoolLimit === undefined
        ? uncappedTopK
        : Math.min(uncappedTopK, input.requestedCandidatePoolLimit);
    const candidatePoolLimit = input.parallel
      ? (input.requestedCandidatePoolLimit ??
        Math.min(
          Math.max(topK * this.parallelCandidateMultiplier, this.parallelCandidateFloor),
          this.maxCandidatePoolLimit
        ))
      : input.requestedCandidatePoolLimit;
    const graph = graphControls({
      plannedQuery: input.plannedQuery,
      graphIntent: input.queryPlan.graphIntent,
      hasDedicatedGraphQuery: input.queryPlan.queries.some((query) => query.kind === "graph"),
      retrieverSupportsGraphSearch: input.retrieverSupportsGraphSearch,
      requiredEntityLimit: this.graphRequiredEntityLimit,
      requiredNeighborLimit: this.graphRequiredNeighborLimit,
      requiredMaxDepth: this.graphRequiredMaxDepth,
      requiredMaxVisitedEntities: this.graphRequiredMaxVisitedEntities,
      optionalEntityLimit: this.graphOptionalEntityLimit,
      optionalNeighborLimit: this.graphOptionalNeighborLimit,
      optionalMaxDepth: this.graphOptionalMaxDepth,
      optionalMaxVisitedEntities: this.graphOptionalMaxVisitedEntities
    });

    reasons.push(`kind:${input.plannedQuery.kind}`);
    if (input.parallel) {
      reasons.push("parallel_query_budget");
    } else {
      reasons.push("single_query_budget");
    }
    if (graph?.enabled === true) {
      reasons.push(`graph_${input.queryPlan.graphIntent.route}`);
    } else if (graph?.enabled === false) {
      reasons.push("graph_disabled_for_branch");
    }

    return {
      plannedQueryId: input.plannedQuery.id,
      kind: input.plannedQuery.kind,
      enabled: true,
      topK,
      fusionWeight: fusionWeight(input.plannedQuery, input.queryPlan.graphIntent.route),
      ...(candidatePoolLimit === undefined ? {} : { candidatePoolLimit }),
      ...(graph === undefined ? {} : { graph }),
      reasons
    };
  }
}

function branchTopK(
  query: PlannedQuery,
  requestedTopK: number,
  route: GraphQueryRoute,
  maxTopK: number
): number {
  const scaled =
    query.kind === "hyde" || query.kind === "high_level" || query.kind === "low_level"
      ? Math.ceil(requestedTopK * 0.75)
      : query.kind === "graph" && route === "graph_required"
        ? Math.ceil(requestedTopK * 1.25)
        : requestedTopK;

  return Math.max(1, Math.min(scaled, maxTopK));
}

function fusionWeight(query: PlannedQuery, route: GraphQueryRoute): number {
  if (query.kind === "graph" && route === "graph_required") {
    return Math.max(query.weight, 1.05);
  }

  if (query.kind === "hyde") {
    return Math.min(query.weight, 0.8);
  }

  return query.weight;
}

function graphControls(input: {
  readonly plannedQuery: PlannedQuery;
  readonly graphIntent: QueryPlan["graphIntent"];
  readonly hasDedicatedGraphQuery: boolean;
  readonly retrieverSupportsGraphSearch: boolean;
  readonly requiredEntityLimit: number;
  readonly requiredNeighborLimit: number;
  readonly requiredMaxDepth: number;
  readonly requiredMaxVisitedEntities: number;
  readonly optionalEntityLimit: number;
  readonly optionalNeighborLimit: number;
  readonly optionalMaxDepth: number;
  readonly optionalMaxVisitedEntities: number;
}): RetrievalGraphRequestControls | undefined {
  if (!input.retrieverSupportsGraphSearch) {
    return undefined;
  }

  if (input.graphIntent.route === "none") {
    return { enabled: false };
  }

  const graphBranch = input.plannedQuery.kind === "graph";
  const originalRequiredBranch =
    input.graphIntent.route === "graph_required" && input.plannedQuery.kind === "original";
  const originalOptionalWithoutDedicatedBranch =
    input.graphIntent.route === "graph_optional" &&
    input.plannedQuery.kind === "original" &&
    !input.hasDedicatedGraphQuery;

  if (!graphBranch && !originalRequiredBranch && !originalOptionalWithoutDedicatedBranch) {
    return { enabled: false };
  }

  const executionMode = graphBranch ? (input.graphIntent.executionMode ?? "graph_first") : "expand";
  const baseControls = {
    enabled: true,
    entityHints: input.graphIntent.entityHints,
    relationKinds: input.graphIntent.relationKinds,
    direction: input.graphIntent.direction ?? "any",
    executionMode
  } as const;

  if (input.graphIntent.route === "graph_required") {
    return {
      ...baseControls,
      entityLimit: input.requiredEntityLimit,
      neighborLimit: input.requiredNeighborLimit,
      maxDepth: input.requiredMaxDepth,
      maxVisitedEntities: input.requiredMaxVisitedEntities
    };
  }

  return {
    ...baseControls,
    entityLimit: input.optionalEntityLimit,
    neighborLimit: input.optionalNeighborLimit,
    maxDepth: input.optionalMaxDepth,
    maxVisitedEntities: input.optionalMaxVisitedEntities
  };
}

function boundedPositiveInteger(value: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}.`);
  }

  return value;
}

function positiveIntegerOption(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }

  return boundedPositiveInteger(value, Number.MAX_SAFE_INTEGER, label);
}

function sumDefined(values: readonly (number | undefined)[]): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  if (defined.length === 0) {
    return undefined;
  }

  return defined.reduce((sum, value) => sum + value, 0);
}
