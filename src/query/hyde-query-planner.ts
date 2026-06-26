import { hashText } from "../shared/hash.js";
import { DefaultQueryPlanner } from "./default-query-planner.js";
import type { PlannedQuery, QueryPlan, QueryPlanRequest, QueryPlanner } from "./query-types.js";

export interface HydeGenerationRequest {
  readonly requestId: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly question: string;
  readonly lowLevelKeywords: readonly string[];
  readonly highLevelKeywords: readonly string[];
  readonly maxDocumentCharacters: number;
  readonly requestedAt?: string;
}

export interface HydeGenerationResult {
  readonly document: string;
  readonly warnings?: readonly string[];
}

export interface HydeGenerator {
  readonly id: string;
  readonly provider: string;
  readonly modelName: string;
  generate(request: HydeGenerationRequest): Promise<HydeGenerationResult>;
}

export interface HydeQueryPlannerOptions {
  readonly generator: HydeGenerator;
  readonly basePlanner?: QueryPlanner;
  readonly now?: () => string;
  readonly maxDocumentCharacters?: number;
  readonly hydeWeight?: number;
  readonly failOpen?: boolean;
}

const DEFAULT_MAX_HYDE_DOCUMENT_CHARACTERS = 1200;
const DEFAULT_HYDE_WEIGHT = 0.8;

export class HydeQueryPlanner implements QueryPlanner {
  private readonly generator: HydeGenerator;
  private readonly basePlanner: QueryPlanner;
  private readonly now: () => string;
  private readonly maxDocumentCharacters: number;
  private readonly hydeWeight: number;
  private readonly failOpen: boolean;

  constructor(options: HydeQueryPlannerOptions) {
    this.generator = options.generator;
    this.now = options.now ?? (() => new Date().toISOString());
    this.basePlanner = options.basePlanner ?? new DefaultQueryPlanner({ now: this.now });
    this.maxDocumentCharacters =
      options.maxDocumentCharacters ?? DEFAULT_MAX_HYDE_DOCUMENT_CHARACTERS;
    this.hydeWeight = options.hydeWeight ?? DEFAULT_HYDE_WEIGHT;
    this.failOpen = options.failOpen ?? true;

    if (!Number.isInteger(this.maxDocumentCharacters) || this.maxDocumentCharacters < 100) {
      throw new Error("HyDE maxDocumentCharacters must be an integer of at least 100.");
    }

    if (!Number.isFinite(this.hydeWeight) || this.hydeWeight <= 0 || this.hydeWeight > 1) {
      throw new Error("HyDE query weight must be greater than 0 and at most 1.");
    }
  }

  async plan(request: QueryPlanRequest): Promise<QueryPlan> {
    const maxQueries = Math.max(1, Math.floor(request.maxQueries ?? 3));
    const basePlan = await this.basePlanner.plan({
      ...request,
      maxQueries
    });

    if (
      !request.profile.retrieval.allowQueryRewrite ||
      !request.profile.retrieval.allowParallelQueries ||
      maxQueries <= 1
    ) {
      return basePlan;
    }

    try {
      const generated = await this.generator.generate({
        requestId: `hyde_${basePlan.trace.queryPlanId}`,
        profileId: request.profile.id,
        namespaceId: request.profile.namespaceId,
        question: basePlan.originalQuestion,
        lowLevelKeywords: basePlan.lowLevelKeywords,
        highLevelKeywords: basePlan.highLevelKeywords,
        maxDocumentCharacters: this.maxDocumentCharacters,
        requestedAt: request.requestedAt ?? basePlan.trace.startedAt
      });
      const hypotheticalDocument = sanitizeHypotheticalDocument(
        generated.document,
        this.maxDocumentCharacters
      );
      if (!hypotheticalDocument) {
        return basePlan;
      }

      const queries = addHydeQuery(
        basePlan.queries,
        {
          id: "q_hyde",
          query: hypotheticalDocument,
          kind: "hyde",
          weight: this.hydeWeight
        },
        maxQueries
      );
      if (queries === basePlan.queries) {
        return basePlan;
      }

      return {
        ...basePlan,
        queries,
        trace: {
          ...basePlan.trace,
          finishedAt: this.now(),
          strategy: "hyde_augmented",
          plannedQueryHashes: queries.map((query) => hashText(query.query)),
          queryCount: queries.length,
          rewriteEnabled: request.profile.retrieval.allowQueryRewrite,
          parallelQueriesEnabled: request.profile.retrieval.allowParallelQueries
        }
      };
    } catch (error) {
      if (this.failOpen) {
        return basePlan;
      }

      throw error;
    }
  }
}

function addHydeQuery(
  queries: readonly PlannedQuery[],
  hydeQuery: PlannedQuery,
  maxQueries: number
): readonly PlannedQuery[] {
  if (queries.some((query) => sameQuery(query.query, hydeQuery.query))) {
    return queries;
  }

  const normalizedHyde = {
    ...hydeQuery,
    query: normalizeQueryText(hydeQuery.query)
  };
  if (!normalizedHyde.query) {
    return queries;
  }

  if (queries.length < maxQueries) {
    return [...queries, normalizedHyde];
  }

  const replaceIndex = replaceableQueryIndex(queries, normalizedHyde.weight);
  if (replaceIndex === undefined) {
    return queries;
  }

  return queries.map((query, index) => (index === replaceIndex ? normalizedHyde : query));
}

function replaceableQueryIndex(
  queries: readonly PlannedQuery[],
  hydeWeight: number
): number | undefined {
  let selectedIndex: number | undefined;
  let selectedWeight = Number.POSITIVE_INFINITY;

  for (const [index, query] of queries.entries()) {
    if (query.kind === "original" || query.kind === "graph") {
      continue;
    }

    if (query.weight <= hydeWeight && query.weight < selectedWeight) {
      selectedIndex = index;
      selectedWeight = query.weight;
    }
  }

  return selectedIndex;
}

function sanitizeHypotheticalDocument(value: string, maxCharacters: number): string {
  return normalizeQueryText(value).slice(0, maxCharacters).trim();
}

function sameQuery(first: string, second: string): boolean {
  return normalizeQueryText(first).toLowerCase() === normalizeQueryText(second).toLowerCase();
}

function normalizeQueryText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
