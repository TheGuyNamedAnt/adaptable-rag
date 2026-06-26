import type { ChunkStore } from "../indexing/chunk-store.js";
import { redactIndexFilterForTrace } from "../indexing/index-filter.js";
import type {
  RagGraphMatch,
  RagGraphNeighbor,
  RagGraphNeighborQuery,
  RagGraphRelationship,
  RagGraphStore
} from "../graph/graph-store.js";
import { hashText } from "../shared/hash.js";
import {
  selectPreferredGraphEvidence,
  type RetrievalGraphEntityReference,
  type RetrievalGraphPathEdgeEvidence,
  type RetrievalGraphPathEvidence
} from "./graph-evidence.js";
import type { Retriever, RetrieverCapabilities } from "./retriever.js";
import type {
  RetrievalCandidate,
  RetrievalGraphRequestControls,
  RetrievalRequest,
  RetrievalResult
} from "./retrieval-types.js";

const DEFAULT_ENTITY_LIMIT = 4;
const DEFAULT_NEIGHBOR_LIMIT = 8;
const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_VISITED_ENTITIES = 256;
const MAX_GRAPH_TRAVERSAL_DEPTH = 3;
const ENTITY_HINT_STOP_TERMS = new Set([
  "co",
  "company",
  "corp",
  "corporation",
  "inc",
  "incorporated",
  "ltd",
  "llc",
  "lp",
  "plc"
]);

export interface GraphAugmentedRetrieverOptions {
  readonly baseRetriever: Retriever;
  readonly graphStore: RagGraphStore;
  readonly chunkStore: ChunkStore;
  readonly entityLimit?: number;
  readonly neighborLimit?: number;
  readonly maxDepth?: number;
  readonly maxVisitedEntities?: number;
  readonly now?: () => string;
}

export class GraphAugmentedRetriever implements Retriever {
  readonly capabilities: RetrieverCapabilities;

  private readonly baseRetriever: Retriever;
  private readonly graphStore: RagGraphStore;
  private readonly chunkStore: ChunkStore;
  private readonly entityLimit: number;
  private readonly neighborLimit: number;
  private readonly maxDepth: number;
  private readonly maxVisitedEntities: number;
  private readonly now: () => string;

  constructor(options: GraphAugmentedRetrieverOptions) {
    this.baseRetriever = options.baseRetriever;
    this.graphStore = options.graphStore;
    this.chunkStore = options.chunkStore;
    this.entityLimit = options.entityLimit ?? DEFAULT_ENTITY_LIMIT;
    this.neighborLimit = options.neighborLimit ?? DEFAULT_NEIGHBOR_LIMIT;
    this.maxDepth = boundedPositiveIntegerOrFallback(
      options.maxDepth,
      DEFAULT_MAX_DEPTH,
      MAX_GRAPH_TRAVERSAL_DEPTH,
      "maxDepth"
    );
    this.maxVisitedEntities = positiveIntegerOrFallback(
      options.maxVisitedEntities,
      DEFAULT_MAX_VISITED_ENTITIES,
      "maxVisitedEntities"
    );
    this.now = options.now ?? (() => new Date().toISOString());
    this.capabilities = {
      ...options.baseRetriever.capabilities,
      supportsGraphSearch: true
    };
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const startedAt = request.requestedAt ?? this.now();
    const base = await this.baseRetriever.retrieve(request);
    if (request.graph?.enabled === false) {
      return base;
    }

    const graphLimits = graphRequestLimits(request.graph, {
      entityLimit: this.entityLimit,
      neighborLimit: this.neighborLimit,
      maxDepth: this.maxDepth,
      maxVisitedEntities: this.maxVisitedEntities
    });
    const queryTerms = graphEntitySearchTerms(request);
    const entityMatches = this.graphStore.findEntities(
      queryTerms,
      graphLimits.entityLimit,
      request.filter
    );
    const graphResults = await Promise.all(
      entityMatches.map((match) =>
        graphCandidatesForEntity({
          match,
          graphStore: this.graphStore,
          chunkStore: this.chunkStore,
          request,
          neighborLimit: graphLimits.neighborLimit,
          maxDepth: graphLimits.maxDepth,
          maxVisitedEntities: graphLimits.maxVisitedEntities,
          graphFirst: request.graph?.executionMode === "graph_first"
        })
      )
    );
    const graphCandidates = graphResults.flatMap((result) => result.candidates);
    const graphStrategy = graphLimits.maxDepth > 1 ? "graph_multi_hop" : "graph_one_hop";
    const merged = mergeBaseAndGraphCandidates(
      base.candidates,
      graphCandidates,
      request.graph?.executionMode ?? "expand"
    ).slice(0, request.topK);

    return {
      query: base.query,
      candidates: merged.map((candidate, index) => ({
        ...candidate,
        rank: index + 1
      })),
      rejected: base.rejected,
      trace: {
        ...base.trace,
        retrievalId: base.trace.retrievalId,
        startedAt,
        finishedAt: this.now(),
        queryHash: hashText(request.query),
        normalizedQueryHash: hashText(request.query.trim().replace(/\s+/g, " ").toLowerCase()),
        searchTermHashes: [...base.trace.searchTermHashes, ...queryTerms.map(hashText)],
        access: redactIndexFilterForTrace(request.filter),
        candidatePoolSize: base.trace.candidatePoolSize + graphCandidates.length,
        returnedCount: Math.min(merged.length, request.topK),
        rejectedCount: base.rejected.length,
        graphTraversalDepth: maxNumber(graphResults.map((result) => result.traversedDepth)),
        graphVisitedEntityCount: unique(graphResults.flatMap((result) => result.visitedEntityIds))
          .length,
        graphTraversedEdgeCount: graphResults.reduce(
          (sum, result) => sum + result.traversedEdgeCount,
          0
        ),
        fusionStrategy: base.trace.fusionStrategy
          ? `${base.trace.fusionStrategy}+${graphStrategy}`
          : graphStrategy,
        childRetrievalIds: base.trace.childRetrievalIds ?? [base.trace.retrievalId]
      }
    };
  }
}

interface GraphCandidateResult {
  readonly candidates: readonly RetrievalCandidate[];
  readonly traversedDepth: number;
  readonly visitedEntityIds: readonly string[];
  readonly traversedEdgeCount: number;
}

async function graphCandidatesForEntity(input: {
  readonly match: RagGraphMatch;
  readonly graphStore: RagGraphStore;
  readonly chunkStore: ChunkStore;
  readonly request: RetrievalRequest;
  readonly neighborLimit: number;
  readonly maxDepth: number;
  readonly maxVisitedEntities: number;
  readonly graphFirst: boolean;
}): Promise<GraphCandidateResult> {
  const directCandidates = await candidateChunks({
    chunkIds: input.match.entity.chunkIds,
    chunkStore: input.chunkStore,
    request: input.request,
    score: input.graphFirst ? Math.max(0.05, input.match.score * 0.65) : input.match.score,
    matchedTerms: input.match.matchedTerms,
    reason: input.graphFirst ? "graph_first_entity_match" : "graph_entity_match"
  });
  const traversal = traverseGraph({
    seed: input.match,
    graphStore: input.graphStore,
    request: input.request,
    neighborLimit: input.neighborLimit,
    maxDepth: input.maxDepth,
    maxVisitedEntities: input.maxVisitedEntities
  });
  const traversalCandidates = (
    await Promise.all(
      traversal.steps.map((step) =>
        candidateChunks({
          chunkIds: [...step.entity.chunkIds, ...step.relationship.chunkIds],
          chunkStore: input.chunkStore,
          request: input.request,
          score: graphTraversalScore(input.match.score, step.depth, input.graphFirst),
          matchedTerms: step.matchedTerms,
          reason: graphTraversalReason(input.graphFirst, step.depth, step.relationship),
          graphEvidence: graphPathEvidence(input.match, step)
        })
      )
    )
  ).flat();

  return {
    candidates: [...directCandidates, ...traversalCandidates],
    traversedDepth: maxNumber(traversal.steps.map((step) => step.depth)),
    visitedEntityIds: traversal.visitedEntityIds,
    traversedEdgeCount: traversal.steps.length
  };
}

interface GraphTraversalStep {
  readonly entity: ReturnType<RagGraphStore["getOneHopNeighbors"]>[number]["entity"];
  readonly relationship: RagGraphRelationship;
  readonly depth: number;
  readonly matchedTerms: readonly string[];
  readonly pathEdges: readonly RetrievalGraphPathEdgeEvidence[];
}

interface GraphTraversalResult {
  readonly steps: readonly GraphTraversalStep[];
  readonly visitedEntityIds: readonly string[];
}

function traverseGraph(input: {
  readonly seed: RagGraphMatch;
  readonly graphStore: RagGraphStore;
  readonly request: RetrievalRequest;
  readonly neighborLimit: number;
  readonly maxDepth: number;
  readonly maxVisitedEntities: number;
}): GraphTraversalResult {
  const steps: GraphTraversalStep[] = [];
  const visitedEntityIds = new Set([input.seed.entity.id]);
  const visitedRelationshipIds = new Set<string>();
  let frontier: {
    readonly entity: RetrievalGraphEntityReference;
    readonly depth: number;
    readonly matchedTerms: readonly string[];
    readonly pathEdges: readonly RetrievalGraphPathEdgeEvidence[];
  }[] = [
    {
      entity: graphEntityReference(input.seed.entity),
      depth: 0,
      matchedTerms: input.seed.matchedTerms,
      pathEdges: []
    }
  ];

  while (frontier.length > 0) {
    const nextFrontier: typeof frontier = [];

    for (const node of frontier) {
      if (node.depth >= input.maxDepth || visitedEntityIds.size >= input.maxVisitedEntities) {
        continue;
      }

      const neighbors = input.graphStore.getOneHopNeighbors(
        node.entity.id,
        input.neighborLimit,
        input.request.filter,
        graphNeighborQuery(input.request)
      );

      for (const neighbor of neighbors) {
        if (visitedRelationshipIds.has(neighbor.relationship.id)) {
          continue;
        }
        visitedRelationshipIds.add(neighbor.relationship.id);

        if (visitedEntityIds.has(neighbor.entity.id)) {
          continue;
        }
        if (visitedEntityIds.size >= input.maxVisitedEntities) {
          break;
        }

        const depth = node.depth + 1;
        const edge = graphPathEdge(node.entity, neighbor, depth);
        const pathEdges = [...node.pathEdges, edge];
        const matchedTerms = unique([
          ...node.matchedTerms,
          ...(neighbor.relationship.highLevelKeywords ?? [])
        ]);
        visitedEntityIds.add(neighbor.entity.id);
        steps.push({
          entity: neighbor.entity,
          relationship: neighbor.relationship,
          depth,
          matchedTerms,
          pathEdges
        });

        if (depth < input.maxDepth) {
          nextFrontier.push({
            entity: graphEntityReference(neighbor.entity),
            depth,
            matchedTerms,
            pathEdges
          });
        }
      }
    }

    frontier = nextFrontier;
  }

  return { steps, visitedEntityIds: [...visitedEntityIds] };
}

function graphNeighborQuery(request: RetrievalRequest): RagGraphNeighborQuery {
  return {
    ...(request.graph?.relationKinds === undefined
      ? {}
      : { relationKinds: request.graph.relationKinds }),
    direction: request.graph?.direction ?? "any"
  };
}

function graphPathEvidence(
  seed: RagGraphMatch,
  step: GraphTraversalStep
): RetrievalGraphPathEvidence {
  return {
    seed: graphEntityReference(seed.entity),
    target: graphEntityReference(step.entity),
    depth: step.depth,
    edges: step.pathEdges
  };
}

function graphPathEdge(
  current: RetrievalGraphEntityReference,
  neighbor: RagGraphNeighbor,
  depth: number
): RetrievalGraphPathEdgeEvidence {
  const neighborEntity = graphEntityReference(neighbor.entity);
  const from =
    neighbor.relationship.fromEntityId === current.id
      ? current
      : neighbor.relationship.fromEntityId === neighborEntity.id
        ? neighborEntity
        : { id: neighbor.relationship.fromEntityId, name: neighbor.relationship.fromEntityId };
  const to =
    neighbor.relationship.toEntityId === current.id
      ? current
      : neighbor.relationship.toEntityId === neighborEntity.id
        ? neighborEntity
        : { id: neighbor.relationship.toEntityId, name: neighbor.relationship.toEntityId };

  return {
    relationId: neighbor.relationship.id,
    relationType: neighbor.relationship.type,
    from,
    to,
    depth,
    evidenceChunkIds: unique(neighbor.relationship.chunkIds)
  };
}

function graphEntityReference(entity: {
  readonly id: string;
  readonly name: string;
}): RetrievalGraphEntityReference {
  return {
    id: entity.id,
    name: entity.name
  };
}

function graphTraversalScore(score: number, depth: number, graphFirst: boolean): number {
  if (graphFirst) {
    return Math.max(1, score + 0.1 / (depth + 1));
  }

  return Math.max(0.05, score * 0.75 ** depth);
}

function graphTraversalReason(
  graphFirst: boolean,
  depth: number,
  relationship: RagGraphRelationship
): string {
  if (depth === 1) {
    return graphFirst
      ? `graph_first_one_hop:${relationship.type}`
      : `graph_one_hop:${relationship.type}`;
  }

  return graphFirst
    ? `graph_first_path_depth_${depth}:${relationship.type}`
    : `graph_path_depth_${depth}:${relationship.type}`;
}

function maxNumber(values: readonly number[]): number {
  return values.reduce((max, value) => Math.max(max, value), 0);
}

async function candidateChunks(input: {
  readonly chunkIds: readonly string[];
  readonly chunkStore: ChunkStore;
  readonly request: RetrievalRequest;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly reason: string;
  readonly graphEvidence?: RetrievalGraphPathEvidence;
}): Promise<readonly RetrievalCandidate[]> {
  const candidates: RetrievalCandidate[] = [];
  for (const chunkId of [...new Set(input.chunkIds)]) {
    const indexed = await input.chunkStore.getChunk(chunkId, input.request.filter);
    if (!indexed) {
      continue;
    }
    candidates.push({
      chunk: indexed.chunk,
      score: input.score,
      rank: 0,
      matchedTerms: input.matchedTerms,
      citation: indexed.chunk.citation,
      reasons: [input.reason],
      ...(input.graphEvidence === undefined ? {} : { graphEvidence: input.graphEvidence })
    });
  }
  return candidates;
}

function mergeBaseAndGraphCandidates(
  baseCandidates: readonly RetrievalCandidate[],
  graphCandidates: readonly RetrievalCandidate[],
  executionMode: NonNullable<RetrievalGraphRequestControls["executionMode"]>
): readonly RetrievalCandidate[] {
  const byChunkId = new Map<string, RetrievalCandidate>();

  for (const candidate of [...baseCandidates, ...graphCandidates]) {
    const existing = byChunkId.get(candidate.chunk.id);
    if (!existing || candidate.score > existing.score) {
      const graphEvidence = existing
        ? selectPreferredGraphEvidence(existing.graphEvidence, candidate.graphEvidence)
        : candidate.graphEvidence;
      byChunkId.set(
        candidate.chunk.id,
        existing
          ? {
              ...candidate,
              matchedTerms: unique([...existing.matchedTerms, ...candidate.matchedTerms]),
              reasons: unique([...existing.reasons, ...candidate.reasons]),
              ...(graphEvidence === undefined ? {} : { graphEvidence })
            }
          : candidate
      );
      continue;
    }

    const graphEvidence = selectPreferredGraphEvidence(
      existing.graphEvidence,
      candidate.graphEvidence
    );
    byChunkId.set(candidate.chunk.id, {
      ...existing,
      matchedTerms: unique([...existing.matchedTerms, ...candidate.matchedTerms]),
      reasons: unique([...existing.reasons, ...candidate.reasons]),
      ...(graphEvidence === undefined ? {} : { graphEvidence })
    });
  }

  return [...byChunkId.values()].sort((first, second) => {
    if (executionMode === "graph_first") {
      const graphPriority = graphCandidatePriority(second) - graphCandidatePriority(first);
      if (graphPriority !== 0) {
        return graphPriority;
      }
    }

    if (second.score !== first.score) {
      return second.score - first.score;
    }
    return first.chunk.id.localeCompare(second.chunk.id);
  });
}

function graphCandidatePriority(candidate: RetrievalCandidate): number {
  return candidate.reasons.some(
    (reason) =>
      reason.startsWith("graph_first_one_hop:") || reason.startsWith("graph_first_path_depth_")
  )
    ? 2
    : candidate.reasons.some((reason) => reason.startsWith("graph_"))
      ? 1
      : 0;
}

function tokenizeGraphQuery(query: string): readonly string[] {
  return unique(query.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []).filter(
    (term) => term.length > 2
  );
}

function graphEntitySearchTerms(request: RetrievalRequest): readonly string[] {
  const hints = request.graph?.entityHints?.flatMap((hint) => [
    normalizeGraphTerm(hint),
    ...tokenizeGraphQuery(hint).filter((term) => !ENTITY_HINT_STOP_TERMS.has(term))
  ]);
  const terms = hints && hints.length > 0 ? hints : tokenizeGraphQuery(request.query);

  return unique(terms.map(normalizeGraphTerm).filter((term) => term.length > 2));
}

function normalizeGraphTerm(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function graphRequestLimits(
  controls: RetrievalGraphRequestControls | undefined,
  fallback: {
    readonly entityLimit: number;
    readonly neighborLimit: number;
    readonly maxDepth: number;
    readonly maxVisitedEntities: number;
  }
): {
  readonly entityLimit: number;
  readonly neighborLimit: number;
  readonly maxDepth: number;
  readonly maxVisitedEntities: number;
} {
  return {
    entityLimit: positiveIntegerOrFallback(
      controls?.entityLimit,
      fallback.entityLimit,
      "entityLimit"
    ),
    neighborLimit: positiveIntegerOrFallback(
      controls?.neighborLimit,
      fallback.neighborLimit,
      "neighborLimit"
    ),
    maxDepth: boundedPositiveIntegerOrFallback(
      controls?.maxDepth,
      fallback.maxDepth,
      MAX_GRAPH_TRAVERSAL_DEPTH,
      "maxDepth"
    ),
    maxVisitedEntities: positiveIntegerOrFallback(
      controls?.maxVisitedEntities,
      fallback.maxVisitedEntities,
      "maxVisitedEntities"
    )
  };
}

function boundedPositiveIntegerOrFallback(
  value: number | undefined,
  fallback: number,
  max: number,
  label: string
): number {
  const resolved = positiveIntegerOrFallback(value, fallback, label);
  if (resolved > max) {
    throw new Error(`Graph retrieval ${label} must be no greater than ${max}.`);
  }

  return resolved;
}

function positiveIntegerOrFallback(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Graph retrieval ${label} must be a positive integer.`);
  }

  return value;
}
