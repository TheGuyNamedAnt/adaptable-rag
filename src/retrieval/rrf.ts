import { selectPreferredGraphEvidence } from "./graph-evidence.js";
import type { RetrievalCandidate } from "./retrieval-types.js";

export const DEFAULT_RRF_K = 60;

export interface RrfCandidateSource {
  readonly candidates: readonly RetrievalCandidate[];
  readonly weight: number;
  readonly componentReason: string;
}

export interface RrfMergeOptions {
  readonly k?: number;
  readonly scoreReason: string;
}

export interface RrfMergedCandidateRecord {
  chunk: RetrievalCandidate["chunk"];
  score: number;
  bestComponentRank: number;
  matchedTerms: string[];
  citation: RetrievalCandidate["citation"];
  reasons: string[];
  graphEvidence: RetrievalCandidate["graphEvidence"];
}

export function mergeCandidatesByRrf(
  sources: readonly RrfCandidateSource[],
  options: RrfMergeOptions
): readonly RrfMergedCandidateRecord[] {
  const k = options.k ?? DEFAULT_RRF_K;
  assertValidRrfInput(sources, k);

  const records = new Map<string, RrfMergedCandidateRecord>();

  for (const source of sources) {
    for (const candidate of source.candidates) {
      const rank = safeRank(candidate.rank);
      const score = roundRrfScore(reciprocalRankScore(rank, k, source.weight));
      const existing = records.get(candidate.chunk.id);

      if (!existing) {
        records.set(candidate.chunk.id, {
          chunk: candidate.chunk,
          score,
          bestComponentRank: rank,
          matchedTerms: [...candidate.matchedTerms],
          citation: candidate.citation,
          reasons: uniqueSorted([
            ...candidate.reasons,
            source.componentReason,
            options.scoreReason
          ]),
          graphEvidence: candidate.graphEvidence
        });
        continue;
      }

      existing.score = roundRrfScore(existing.score + score);
      existing.bestComponentRank = Math.min(existing.bestComponentRank, rank);
      existing.matchedTerms = uniqueSorted([...existing.matchedTerms, ...candidate.matchedTerms]);
      existing.graphEvidence = selectPreferredGraphEvidence(
        existing.graphEvidence,
        candidate.graphEvidence
      );
      existing.reasons = uniqueSorted([
        ...existing.reasons,
        ...candidate.reasons,
        source.componentReason,
        options.scoreReason
      ]);
    }
  }

  return [...records.values()].sort(compareRrfMergedCandidates);
}

export function reciprocalRankScore(rank: number, k = DEFAULT_RRF_K, weight = 1): number {
  if (!Number.isFinite(rank) || rank < 1) {
    throw new Error("RRF rank must be a positive finite number.");
  }

  if (!Number.isFinite(k) || k < 1) {
    throw new Error("RRF k must be a positive finite number.");
  }

  if (!Number.isFinite(weight) || weight < 0) {
    throw new Error("RRF weight must be a finite non-negative number.");
  }

  return weight / (k + rank);
}

function assertValidRrfInput(sources: readonly RrfCandidateSource[], k: number): void {
  if (!Number.isFinite(k) || k < 1) {
    throw new Error("RRF k must be a positive finite number.");
  }

  for (const source of sources) {
    if (!Number.isFinite(source.weight) || source.weight < 0) {
      throw new Error("RRF source weights must be finite non-negative numbers.");
    }
  }
}

function compareRrfMergedCandidates(
  first: RrfMergedCandidateRecord,
  second: RrfMergedCandidateRecord
): number {
  if (second.score !== first.score) {
    return second.score - first.score;
  }

  if (first.bestComponentRank !== second.bestComponentRank) {
    return first.bestComponentRank - second.bestComponentRank;
  }

  if (first.chunk.documentId !== second.chunk.documentId) {
    return first.chunk.documentId.localeCompare(second.chunk.documentId);
  }

  if (first.chunk.index !== second.chunk.index) {
    return first.chunk.index - second.chunk.index;
  }

  return first.chunk.id.localeCompare(second.chunk.id);
}

function safeRank(rank: number): number {
  return Number.isFinite(rank) && rank >= 1 ? rank : Number.MAX_SAFE_INTEGER;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((first, second) => first.localeCompare(second));
}

function roundRrfScore(score: number): number {
  return Math.round(score * 1_000_000) / 1_000_000;
}
