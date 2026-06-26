import { hashText } from "../shared/hash.js";
import type {
  GraphQueryDirection,
  GraphQueryExecutionMode,
  GraphQueryIntent,
  GraphQueryRelationKind,
  PlannedQuery,
  QueryPlan,
  QueryPlanRequest,
  QueryPlanner
} from "./query-types.js";

const DEFAULT_MAX_PARALLEL_QUERIES = 3;
const MAX_KEYWORDS_PER_TRACK = 8;
const STOP_WORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "our",
  "should",
  "that",
  "the",
  "their",
  "this",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with"
]);

const ENTITY_STOP_WORDS = new Set([
  "A",
  "An",
  "And",
  "Are",
  "Can",
  "Does",
  "For",
  "From",
  "How",
  "In",
  "Is",
  "It",
  "Of",
  "On",
  "Or",
  "Our",
  "Should",
  "That",
  "The",
  "This",
  "To",
  "What",
  "When",
  "Where",
  "Which",
  "Who",
  "Why",
  "With"
]);

const GRAPH_RELATION_PATTERNS: readonly {
  readonly relationKind: GraphQueryRelationKind;
  readonly patterns: readonly RegExp[];
}[] = [
  { relationKind: "owns", patterns: [/\bown(?:s|ed|ership)?\b/i, /\bparent\b/i, /\bsubsidiar/i] },
  { relationKind: "controls", patterns: [/\bcontrol(?:s|led)?\b/i] },
  { relationKind: "manages", patterns: [/\bmanage(?:s|d|ment)?\b/i] },
  { relationKind: "beneficiary_of", patterns: [/\bbeneficiar(?:y|ies)\b/i] },
  { relationKind: "trustee_of", patterns: [/\btrustee\b/i] },
  { relationKind: "director_of", patterns: [/\bdirector\b/i, /\bboard\b/i] },
  { relationKind: "signatory_of", patterns: [/\bsignator(?:y|ies)\b/i, /\bsigned by\b/i] },
  { relationKind: "guarantees", patterns: [/\bguarantee(?:s|d)?\b/i] },
  { relationKind: "owes", patterns: [/\bowes?\b/i, /\bdebt\b/i, /\bliabilit/i] },
  { relationKind: "member_of", patterns: [/\bmember(?:s|ship)?\b/i] },
  { relationKind: "registered_in", patterns: [/\bregistered\b/i, /\bjurisdiction\b/i] },
  { relationKind: "formed_on", patterns: [/\bformed\b/i, /\bincorporated\b/i, /\bformation\b/i] }
];

const GRAPH_REQUIRED_PATTERNS = [
  /\bwho\s+owns\b/i,
  /\bwhat\s+owns\b/i,
  /\bowned\s+by\b/i,
  /\bparent(?:\s+company|\s+entity)?\b/i,
  /\bsubsidiar(?:y|ies)\b/i,
  /\bcontrol(?:s|led)?\s+by\b/i,
  /\bbeneficiar(?:y|ies)\b/i,
  /\btrustee\b/i,
  /\bownership\s+(?:structure|tree|chain|graph)\b/i
];

export class DefaultQueryPlanner implements QueryPlanner {
  private readonly now: () => string;

  constructor(options: { readonly now?: () => string } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  plan(request: QueryPlanRequest): QueryPlan {
    const startedAt = request.requestedAt ?? this.now();
    const queryPlanId = request.queryPlanId ?? `query_plan_${startedAt.replace(/[^0-9a-z]/gi, "")}`;
    const question = normalizeQuestion(request.question);

    if (!question) {
      throw new Error("Query planning question is required.");
    }

    const lowLevelKeywords = extractLowLevelKeywords(question);
    const highLevelKeywords = extractHighLevelKeywords(question, lowLevelKeywords);
    const graphIntent = detectGraphQueryIntent(question, lowLevelKeywords);
    const queries = buildPlannedQueries({
      question,
      lowLevelKeywords,
      highLevelKeywords,
      graphIntent,
      rewriteEnabled: request.profile.retrieval.allowQueryRewrite,
      parallelEnabled: request.profile.retrieval.allowParallelQueries,
      maxQueries: request.maxQueries ?? DEFAULT_MAX_PARALLEL_QUERIES
    });

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
        strategy: "default_heuristic",
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
  }
}

function buildPlannedQueries(input: {
  readonly question: string;
  readonly lowLevelKeywords: readonly string[];
  readonly highLevelKeywords: readonly string[];
  readonly graphIntent: GraphQueryIntent;
  readonly rewriteEnabled: boolean;
  readonly parallelEnabled: boolean;
  readonly maxQueries: number;
}): readonly PlannedQuery[] {
  const queries: PlannedQuery[] = [
    {
      id: "q_original",
      query: input.question,
      kind: "original",
      weight: 1
    }
  ];

  if (!input.rewriteEnabled || !input.parallelEnabled || input.maxQueries <= 1) {
    return queries;
  }

  addQueryIfDistinct(queries, {
    id: "q_low_level",
    query: input.lowLevelKeywords.join(" "),
    kind: "low_level",
    weight: 0.9
  });
  addQueryIfDistinct(queries, {
    id: "q_high_level",
    query: input.highLevelKeywords.join(" "),
    kind: "high_level",
    weight: 0.75
  });
  if (input.graphIntent.route !== "none") {
    addQueryIfDistinct(queries, {
      id: "q_graph",
      query: [...input.graphIntent.entityHints, ...input.graphIntent.relationKinds].join(" "),
      kind: "graph",
      weight: input.graphIntent.route === "graph_required" ? 0.95 : 0.8
    });
  }

  return queries.slice(0, Math.max(1, Math.floor(input.maxQueries)));
}

function addQueryIfDistinct(queries: PlannedQuery[], query: PlannedQuery): void {
  const normalized = normalizeQuestion(query.query);

  if (!normalized) {
    return;
  }

  if (queries.some((existing) => normalizeQuestion(existing.query) === normalized)) {
    return;
  }

  queries.push({
    ...query,
    query: normalized
  });
}

function extractLowLevelKeywords(question: string): readonly string[] {
  const quoted = [...question.matchAll(/"([^"]{2,80})"/g)].map((match) => match[1] ?? "");
  const capitalized = [
    ...question.matchAll(/\b[A-Z][A-Za-z0-9_-]*(?:\s+[A-Z][A-Za-z0-9_-]*){0,4}\b/g)
  ].map((match) => match[0]);
  const identifiers =
    question.match(/\b[A-Za-z]+[-_][A-Za-z0-9_-]+|\b[A-Z]{2,}\b|\b[A-Za-z]*\d[A-Za-z0-9._-]*\b/g) ??
    [];

  return uniqueNormalized(
    [...quoted, ...capitalized, ...identifiers].filter((term) => {
      const normalized = term.trim();
      return normalized.length > 1 && !ENTITY_STOP_WORDS.has(normalized);
    })
  ).slice(0, MAX_KEYWORDS_PER_TRACK);
}

function extractHighLevelKeywords(
  question: string,
  lowLevelKeywords: readonly string[]
): readonly string[] {
  const lowLevel = new Set(lowLevelKeywords.map((keyword) => keyword.toLowerCase()));
  const tokens = question.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? [];

  return uniqueNormalized(
    tokens.filter(
      (token) => token.length > 2 && !STOP_WORDS.has(token) && !lowLevel.has(token.toLowerCase())
    )
  ).slice(0, MAX_KEYWORDS_PER_TRACK);
}

export function detectGraphQueryIntent(
  question: string,
  entityHints: readonly string[] = extractLowLevelKeywords(question)
): GraphQueryIntent {
  const relationKinds = uniqueGraphRelationKinds(
    GRAPH_RELATION_PATTERNS.filter((entry) =>
      entry.patterns.some((pattern) => pattern.test(question))
    ).map((entry) => entry.relationKind)
  );
  const graphRequired = GRAPH_REQUIRED_PATTERNS.some((pattern) => pattern.test(question));

  if (relationKinds.length === 0 && !graphRequired) {
    return {
      route: "none",
      relationKinds: [],
      entityHints: [],
      direction: "any",
      executionMode: "expand",
      reason: "No entity relationship pattern detected."
    };
  }

  const route = graphRequired ? "graph_required" : "graph_optional";
  return {
    route,
    relationKinds,
    entityHints,
    direction: detectGraphDirection(question),
    executionMode: graphExecutionMode(route),
    reason: graphRequired
      ? "Question asks for an entity relationship answer that should use graph retrieval."
      : "Question includes entity relationship terms that can benefit from graph expansion."
  };
}

function detectGraphDirection(question: string): GraphQueryDirection {
  if (
    /\bwho\s+owns\b/i.test(question) ||
    /\bwhat\s+owns\b/i.test(question) ||
    /\bowned\s+by\b/i.test(question) ||
    /\bcontrol(?:s|led)?\s+by\b/i.test(question) ||
    /\bmanaged\s+by\b/i.test(question)
  ) {
    return "incoming";
  }

  if (
    /\b(?:what|which)\s+(?:companies|entities|subsidiar(?:y|ies)|assets)\s+(?:does|do)\b.+\bown\b/i.test(
      question
    ) ||
    /\bsubsidiar(?:y|ies)\s+of\b/i.test(question) ||
    /\bcontrols?\s+(?:companies|entities|subsidiar(?:y|ies)|assets)\b/i.test(question)
  ) {
    return "outgoing";
  }

  return "any";
}

function graphExecutionMode(route: GraphQueryIntent["route"]): GraphQueryExecutionMode {
  return route === "graph_required" ? "graph_first" : "expand";
}

function uniqueGraphRelationKinds(
  values: readonly GraphQueryRelationKind[]
): readonly GraphQueryRelationKind[] {
  return [...new Set(values)].sort();
}

function normalizeQuestion(question: string): string {
  return question.trim().replace(/\s+/g, " ");
}

function uniqueNormalized(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    const normalized = normalizeQuestion(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(normalized);
  }

  return unique;
}
