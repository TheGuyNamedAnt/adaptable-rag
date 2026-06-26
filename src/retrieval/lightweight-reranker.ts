import type { TrustTier } from "../documents/trust-tier.js";
import { hashText } from "../shared/hash.js";
import type { RerankRequest, RerankResult, Reranker } from "./reranker.js";
import type { RetrievalCandidate } from "./retrieval-types.js";

const TRUST_SCORE = {
  trusted_internal: 1,
  verified_partner: 0.9,
  user_provided: 0.7,
  generated_or_derived: 0.45,
  external_untrusted: 0.25,
  unknown: 0
} as const satisfies Record<TrustTier, number>;

export interface LightweightRerankerOptions {
  readonly now?: () => string;
}

interface WeightedCandidate {
  readonly candidate: RetrievalCandidate;
  readonly score: number;
}

export class LightweightReranker implements Reranker {
  readonly mode = "lightweight" as const;

  private readonly now: () => string;

  constructor(options: LightweightRerankerOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async rerank(request: RerankRequest): Promise<RerankResult> {
    const startedAt = request.requestedAt ?? this.now();
    const rerankId = request.rerankId ?? `rerank_${hashText(`${startedAt}:${request.query}`)}`;
    const ranked = request.candidates
      .map((candidate) => ({
        candidate,
        score: scoreCandidate(candidate, request)
      }))
      .sort(compareWeightedCandidates)
      .slice(0, request.topK)
      .map(({ candidate }, index) => ({
        ...candidate,
        rank: index + 1,
        reasons: uniqueSorted([...candidate.reasons, "lightweight_rerank"])
      }));

    return {
      candidates: ranked,
      rejected: [],
      trace: {
        rerankId,
        startedAt,
        finishedAt: this.now(),
        mode: this.mode,
        profileId: request.profile.id,
        namespaceId: request.profile.namespaceId,
        inputCandidateCount: request.candidates.length,
        returnedCount: ranked.length,
        rejectedCount: 0,
        inputChunkIds: request.candidates.map((candidate) => candidate.chunk.id),
        returnedChunkIds: ranked.map((candidate) => candidate.chunk.id),
        warningCodes: []
      }
    };
  }
}

function scoreCandidate(candidate: RetrievalCandidate, request: RerankRequest): number {
  const trustScore = TRUST_SCORE[candidate.chunk.provenance.trustTier];
  const lexicalOverlap = queryOverlap(request.query, candidate.chunk.text);
  const normalizedRank = 1 / Math.max(1, candidate.rank);

  return roundScore(
    candidate.score * 0.45 + trustScore * 0.2 + lexicalOverlap * 0.2 + normalizedRank * 0.15
  );
}

function queryOverlap(query: string, text: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return 0;
  }

  const textTokens = new Set(tokenize(text));
  const matched = queryTokens.filter((token) => textTokens.has(token)).length;
  return matched / queryTokens.length;
}

function tokenize(value: string): readonly string[] {
  return uniqueSorted(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  );
}

function compareWeightedCandidates(first: WeightedCandidate, second: WeightedCandidate): number {
  if (second.score !== first.score) {
    return second.score - first.score;
  }

  if (first.candidate.rank !== second.candidate.rank) {
    return first.candidate.rank - second.candidate.rank;
  }

  return first.candidate.chunk.id.localeCompare(second.candidate.chunk.id);
}

function roundScore(score: number): number {
  return Math.round(score * 1000000) / 1000000;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
