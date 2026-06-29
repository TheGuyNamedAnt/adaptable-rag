import type { ChunkStore } from "../indexing/chunk-store.js";
import type { RagChunk } from "../documents/chunk.js";
import type { RetrievalGraphPathEvidence } from "./graph-evidence.js";
import type { Retriever, RetrieverCapabilities } from "./retriever.js";
import type { RetrievalCandidate, RetrievalRequest, RetrievalResult } from "./retrieval-types.js";

export type ConnectedChunkRelationshipKind =
  | "previous_chunk"
  | "next_chunk"
  | "same_section"
  | "caption_for"
  | "explains"
  | "continues_as"
  | "references";

export interface ConnectedChunkRelationship {
  readonly id: string;
  readonly documentId: string;
  readonly fromChunkId: string;
  readonly toChunkId: string;
  readonly kind: ConnectedChunkRelationshipKind;
  readonly evidence: "chunk_order" | "layout_relation";
  readonly weight: number;
}

export interface ConnectedChunkRetrieverOptions {
  readonly retriever: Retriever;
  readonly chunkStore: ChunkStore;
  readonly adjacentWindow?: number;
  readonly maxConnectedChunks?: number;
  readonly connectedScoreMultiplier?: number;
  readonly chunkRelationships?: readonly ConnectedChunkRelationship[];
}

interface ConnectedCandidateInput {
  readonly chunk: RagChunk;
  readonly seed: RetrievalCandidate;
  readonly reason: string;
  readonly graphEvidence?: RetrievalGraphPathEvidence;
}

const DEFAULT_ADJACENT_WINDOW = 1;
const DEFAULT_MAX_CONNECTED_CHUNKS = 12;
const DEFAULT_CONNECTED_SCORE_MULTIPLIER = 0.82;

export class ConnectedChunkRetriever implements Retriever {
  readonly capabilities: RetrieverCapabilities;

  private readonly retriever: Retriever;
  private readonly chunkStore: ChunkStore;
  private readonly adjacentWindow: number;
  private readonly maxConnectedChunks: number;
  private readonly connectedScoreMultiplier: number;
  private readonly relationshipsBySeedChunkId: ReadonlyMap<
    string,
    readonly ConnectedChunkRelationship[]
  >;

  constructor(options: ConnectedChunkRetrieverOptions) {
    this.retriever = options.retriever;
    this.chunkStore = options.chunkStore;
    this.capabilities = options.retriever.capabilities;
    this.adjacentWindow = positiveIntegerOrFallback(
      options.adjacentWindow,
      DEFAULT_ADJACENT_WINDOW,
      "adjacentWindow"
    );
    this.maxConnectedChunks = positiveIntegerOrFallback(
      options.maxConnectedChunks,
      DEFAULT_MAX_CONNECTED_CHUNKS,
      "maxConnectedChunks"
    );
    this.connectedScoreMultiplier = positiveNumberOrFallback(
      options.connectedScoreMultiplier,
      DEFAULT_CONNECTED_SCORE_MULTIPLIER,
      "connectedScoreMultiplier"
    );
    this.relationshipsBySeedChunkId = groupRelationshipsBySeedChunkId(
      options.chunkRelationships ?? []
    );
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const base = await this.retriever.retrieve(request);
    if (base.candidates.length === 0 || this.maxConnectedChunks === 0) {
      return base;
    }

    const connected = await this.connectedCandidates(base.candidates, request);
    if (connected.length === 0) {
      return base;
    }

    const merged = mergeCandidates(base.candidates, connected).slice(0, request.topK);

    return {
      ...base,
      candidates: merged.map((candidate, index) => ({ ...candidate, rank: index + 1 })),
      trace: {
        ...base.trace,
        candidatePoolSize: base.trace.candidatePoolSize + connected.length,
        returnedCount: Math.min(merged.length, request.topK),
        fusionStrategy:
          base.trace.fusionStrategy === undefined
            ? "connected_chunk_expansion"
            : `${base.trace.fusionStrategy}+connected_chunk_expansion`
      }
    };
  }

  private async connectedCandidates(
    seeds: readonly RetrievalCandidate[],
    request: RetrievalRequest
  ): Promise<readonly RetrievalCandidate[]> {
    const byChunkId = new Map<string, ConnectedCandidateInput>();
    const seedChunkIds = new Set(seeds.map((candidate) => candidate.chunk.id));

    for (const seed of seeds) {
      for (const connected of await this.adjacentChunks(seed, request)) {
        if (!seedChunkIds.has(connected.chunk.id)) {
          upsertConnectedCandidate(byChunkId, connected);
        }
      }

      for (const connected of await this.graphEvidenceChunks(seed, request)) {
        if (!seedChunkIds.has(connected.chunk.id)) {
          upsertConnectedCandidate(byChunkId, connected);
        }
      }

      for (const connected of await this.explicitRelationshipChunks(seed, request)) {
        if (!seedChunkIds.has(connected.chunk.id)) {
          upsertConnectedCandidate(byChunkId, connected);
        }
      }
    }

    return [...byChunkId.values()]
      .sort((first, second) => {
        const scoreDelta =
          connectedScore(second, this.connectedScoreMultiplier) -
          connectedScore(first, this.connectedScoreMultiplier);
        if (scoreDelta !== 0) {
          return scoreDelta;
        }
        return first.chunk.id.localeCompare(second.chunk.id);
      })
      .slice(0, this.maxConnectedChunks)
      .map((input, index) => toCandidate(input, this.connectedScoreMultiplier, index + 1));
  }

  private async adjacentChunks(
    seed: RetrievalCandidate,
    request: RetrievalRequest
  ): Promise<readonly ConnectedCandidateInput[]> {
    const indexed = await this.chunkStore.findChunks({
      ...request.filter,
      documentIds: [seed.chunk.documentId]
    });
    const lowerBound = seed.chunk.index - this.adjacentWindow;
    const upperBound = seed.chunk.index + this.adjacentWindow;

    return indexed
      .map((entry) => entry.chunk)
      .filter(
        (chunk) =>
          chunk.id !== seed.chunk.id && chunk.index >= lowerBound && chunk.index <= upperBound
      )
      .map((chunk) => ({
        chunk,
        seed,
        reason: chunk.index < seed.chunk.index ? "connected_previous_chunk" : "connected_next_chunk"
      }));
  }

  private async graphEvidenceChunks(
    seed: RetrievalCandidate,
    request: RetrievalRequest
  ): Promise<readonly ConnectedCandidateInput[]> {
    const chunkIds = unique(
      seed.graphEvidence?.edges.flatMap((edge) => edge.evidenceChunkIds) ?? []
    ).filter((chunkId) => chunkId !== seed.chunk.id);

    const chunks = await Promise.all(
      chunkIds.map(
        async (chunkId) => (await this.chunkStore.getChunk(chunkId, request.filter))?.chunk
      )
    );

    return chunks.flatMap((chunk) =>
      chunk === undefined
        ? []
        : [
            {
              chunk,
              seed,
              reason: "connected_graph_evidence_chunk",
              ...(seed.graphEvidence === undefined ? {} : { graphEvidence: seed.graphEvidence })
            }
          ]
    );
  }

  private async explicitRelationshipChunks(
    seed: RetrievalCandidate,
    request: RetrievalRequest
  ): Promise<readonly ConnectedCandidateInput[]> {
    const relationships = this.relationshipsBySeedChunkId.get(seed.chunk.id) ?? [];
    const chunks = await Promise.all(
      relationships.map(async (relationship) => ({
        relationship,
        chunk: (await this.chunkStore.getChunk(relationship.toChunkId, request.filter))?.chunk
      }))
    );

    return chunks.flatMap((entry) =>
      entry.chunk === undefined
        ? []
        : [
            {
              chunk: entry.chunk,
              seed,
              reason: `connected_${entry.relationship.kind}`
            }
          ]
    );
  }
}

function upsertConnectedCandidate(
  byChunkId: Map<string, ConnectedCandidateInput>,
  candidate: ConnectedCandidateInput
): void {
  const existing = byChunkId.get(candidate.chunk.id);
  if (!existing || candidate.seed.score > existing.seed.score) {
    byChunkId.set(candidate.chunk.id, candidate);
  }
}

function toCandidate(
  input: ConnectedCandidateInput,
  multiplier: number,
  rank: number
): RetrievalCandidate {
  return {
    chunk: input.chunk,
    score: connectedScore(input, multiplier),
    rank,
    matchedTerms: input.seed.matchedTerms,
    citation: input.chunk.citation,
    reasons: [input.reason, `connected_seed:${input.seed.chunk.id}`],
    ...(input.graphEvidence === undefined ? {} : { graphEvidence: input.graphEvidence })
  };
}

function connectedScore(input: ConnectedCandidateInput, multiplier: number): number {
  const distancePenalty = Math.abs(input.chunk.index - input.seed.chunk.index) * 0.03;
  return Math.max(0.01, input.seed.score * multiplier - distancePenalty);
}

function groupRelationshipsBySeedChunkId(
  relationships: readonly ConnectedChunkRelationship[]
): ReadonlyMap<string, readonly ConnectedChunkRelationship[]> {
  const groups = new Map<string, ConnectedChunkRelationship[]>();
  for (const relationship of relationships) {
    const group = groups.get(relationship.fromChunkId) ?? [];
    group.push(relationship);
    groups.set(relationship.fromChunkId, group);
  }

  for (const [chunkId, group] of groups) {
    groups.set(
      chunkId,
      [...group].sort((first, second) => {
        if (second.weight !== first.weight) {
          return second.weight - first.weight;
        }
        return first.id.localeCompare(second.id);
      })
    );
  }
  return groups;
}

function mergeCandidates(
  base: readonly RetrievalCandidate[],
  connected: readonly RetrievalCandidate[]
): readonly RetrievalCandidate[] {
  const byChunkId = new Map<string, RetrievalCandidate>();
  for (const candidate of [...base, ...connected]) {
    const existing = byChunkId.get(candidate.chunk.id);
    if (!existing || candidate.score > existing.score) {
      byChunkId.set(candidate.chunk.id, existing ? mergeCandidate(existing, candidate) : candidate);
      continue;
    }
    byChunkId.set(candidate.chunk.id, mergeCandidate(existing, candidate));
  }

  return [...byChunkId.values()].sort((first, second) => {
    if (second.score !== first.score) {
      return second.score - first.score;
    }
    return first.chunk.id.localeCompare(second.chunk.id);
  });
}

function mergeCandidate(first: RetrievalCandidate, second: RetrievalCandidate): RetrievalCandidate {
  const preferred = second.score > first.score ? second : first;
  const graphEvidence = preferred.graphEvidence ?? first.graphEvidence ?? second.graphEvidence;
  return {
    ...preferred,
    matchedTerms: unique([...first.matchedTerms, ...second.matchedTerms]),
    reasons: unique([...first.reasons, ...second.reasons]),
    ...(graphEvidence === undefined ? {} : { graphEvidence })
  };
}

function positiveIntegerOrFallback(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Connected chunk retrieval ${label} must be a non-negative integer.`);
  }
  return value;
}

function positiveNumberOrFallback(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(
      `Connected chunk retrieval ${label} must be greater than 0 and no more than 1.`
    );
  }
  return value;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim()))].sort();
}
