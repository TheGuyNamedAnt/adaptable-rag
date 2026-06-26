import { hashText } from "../shared/hash.js";
import { DefaultQueryPlanner, detectGraphQueryIntent } from "./default-query-planner.js";
import type {
  PlannedQuery,
  QueryPlan,
  QueryPlanRequest,
  QueryPlanner,
  QueryPlanningModelAdapter
} from "./query-types.js";

const MAX_KEYWORD_LENGTH = 120;
const MAX_QUERY_LENGTH = 500;

export interface ModelAssistedQueryPlannerOptions {
  readonly adapter: QueryPlanningModelAdapter;
  readonly fallback?: QueryPlanner;
  readonly now?: () => string;
}

export class ModelAssistedQueryPlanner implements QueryPlanner {
  private readonly adapter: QueryPlanningModelAdapter;
  private readonly fallback: QueryPlanner;
  private readonly now: () => string;

  constructor(options: ModelAssistedQueryPlannerOptions) {
    this.adapter = options.adapter;
    this.now = options.now ?? (() => new Date().toISOString());
    this.fallback = options.fallback ?? new DefaultQueryPlanner({ now: this.now });
  }

  async plan(request: QueryPlanRequest): Promise<QueryPlan> {
    const startedAt = request.requestedAt ?? this.now();
    const queryPlanId = request.queryPlanId ?? `query_plan_${startedAt.replace(/[^0-9a-z]/gi, "")}`;
    const question = request.question.trim().replace(/\s+/g, " ");
    if (!question) {
      throw new Error("Query planning question is required.");
    }

    try {
      const model = await this.adapter.plan({
        requestId: `model_${queryPlanId}`,
        profileId: request.profile.id,
        namespaceId: request.profile.namespaceId,
        question,
        maxQueries: Math.max(1, Math.floor(request.maxQueries ?? 3)),
        requestedAt: startedAt
      });
      const lowLevelKeywords = sanitizeKeywords(model.lowLevelKeywords ?? []);
      const highLevelKeywords = sanitizeKeywords(model.highLevelKeywords ?? []);
      const graphIntent = detectGraphQueryIntent(question, lowLevelKeywords);
      const queries = sanitizePlannedQueries({
        plannedQueries: model.plannedQueries ?? [],
        question,
        maxQueries: request.maxQueries ?? 3
      });

      if (queries.length === 0) {
        return this.fallback.plan(request);
      }

      return {
        originalQuestion: question,
        lowLevelKeywords,
        highLevelKeywords,
        graphIntent,
        queries,
        trace: {
          queryPlanId,
          startedAt,
          finishedAt: this.now(),
          strategy: "model_assisted",
          originalQuestionHash: hashText(question),
          plannedQueryHashes: queries.map((query) => hashText(query.query)),
          lowLevelKeywordHashes: lowLevelKeywords.map(hashText),
          highLevelKeywordHashes: highLevelKeywords.map(hashText),
          graphRoute: graphIntent.route,
          ...(graphIntent.direction === undefined ? {} : { graphDirection: graphIntent.direction }),
          ...(graphIntent.executionMode === undefined
            ? {}
            : { graphExecutionMode: graphIntent.executionMode }),
          graphRelationKindHashes: graphIntent.relationKinds.map(hashText),
          graphEntityHintHashes: graphIntent.entityHints.map(hashText),
          queryCount: queries.length,
          rewriteEnabled: request.profile.retrieval.allowQueryRewrite,
          parallelQueriesEnabled: request.profile.retrieval.allowParallelQueries
        }
      };
    } catch {
      return this.fallback.plan(request);
    }
  }
}

function sanitizeKeywords(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value.trim().replace(/\s+/g, " ");
    const key = normalized.toLowerCase();
    if (!normalized || normalized.length > MAX_KEYWORD_LENGTH || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }

  return result.slice(0, 8);
}

function sanitizePlannedQueries(input: {
  readonly plannedQueries: readonly {
    readonly id?: string;
    readonly query: string;
    readonly kind: PlannedQuery["kind"];
    readonly weight?: number;
  }[];
  readonly question: string;
  readonly maxQueries: number;
}): readonly PlannedQuery[] {
  const maxQueries = Math.max(1, Math.floor(input.maxQueries));
  const seen = new Set<string>();
  const queries: PlannedQuery[] = [];

  addQuery(queries, seen, {
    id: "q_original",
    query: input.question,
    kind: "original",
    weight: 1
  });

  for (const [index, query] of input.plannedQueries.entries()) {
    addQuery(queries, seen, {
      id: query.id?.trim() || `q_model_${index + 1}`,
      query: query.query,
      kind: query.kind,
      weight:
        query.weight === undefined || !Number.isFinite(query.weight)
          ? defaultWeight(query.kind)
          : Math.max(0.05, Math.min(query.weight, 1))
    });
  }

  return queries.slice(0, maxQueries);
}

function addQuery(queries: PlannedQuery[], seen: Set<string>, query: PlannedQuery): void {
  const normalized = query.query.trim().replace(/\s+/g, " ");
  const key = normalized.toLowerCase();
  if (!normalized || normalized.length > MAX_QUERY_LENGTH || seen.has(key)) {
    return;
  }

  seen.add(key);
  queries.push({
    ...query,
    query: normalized
  });
}

function defaultWeight(kind: PlannedQuery["kind"]): number {
  switch (kind) {
    case "original":
      return 1;
    case "low_level":
      return 0.9;
    case "high_level":
      return 0.75;
    case "graph":
      return 0.85;
    case "hyde":
      return 0.8;
  }
}
