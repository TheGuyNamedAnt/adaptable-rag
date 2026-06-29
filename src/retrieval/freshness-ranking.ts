import type { RagChunk } from "../documents/chunk.js";
import type {
  RetrievalCandidate,
  RetrievalFreshnessTrace,
  RetrievalRequest
} from "./retrieval-types.js";

const MAX_FRESHNESS_RECENCY_BOOST = 0.2;
const FRESHNESS_RECENCY_REASON = "freshness_recency_boost";

export interface FreshnessScoreInput {
  readonly chunk: RagChunk;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface FreshnessScoredOutput {
  readonly score: number;
  readonly reasons: readonly string[];
}

export function applyFreshnessRecencyBoostToCandidates(
  candidates: readonly RetrievalCandidate[],
  request: RetrievalRequest
): readonly RetrievalCandidate[] {
  if (!isFreshnessRetrievalIntent(request) || candidates.length < 2) {
    return candidates;
  }

  const timestamps = candidateTimestamps(candidates.map((candidate) => candidate.chunk));
  if (!timestamps) {
    return candidates;
  }

  return candidates
    .map((candidate) => {
      const boosted = applyFreshnessRecencyBoostToScore(candidate, timestamps);
      return {
        ...candidate,
        score: boosted.score,
        reasons: boosted.reasons
      };
    })
    .sort(compareBoostedCandidates)
    .map((candidate, index) => ({
      ...candidate,
      rank: index + 1
    }));
}

export function applyFreshnessRecencyBoostToScore(
  input: FreshnessScoreInput,
  timestamps: FreshnessTimestampRange
): FreshnessScoredOutput {
  const timestamp = sourceTimestamp(input.chunk);
  if (timestamp <= 0) {
    return {
      score: input.score,
      reasons: input.reasons
    };
  }

  const recencyBoost =
    ((timestamp - timestamps.oldest) / timestamps.range) * MAX_FRESHNESS_RECENCY_BOOST;
  if (recencyBoost <= 0) {
    return {
      score: input.score,
      reasons: input.reasons
    };
  }

  return {
    score: roundScore(input.score + recencyBoost),
    reasons: [...new Set([...input.reasons, FRESHNESS_RECENCY_REASON])]
  };
}

export interface FreshnessTimestampRange {
  readonly oldest: number;
  readonly newest: number;
  readonly range: number;
}

export function freshnessTimestampRange(
  chunks: readonly RagChunk[]
): FreshnessTimestampRange | undefined {
  const timestamps = chunks.map(sourceTimestamp);
  const newest = Math.max(...timestamps);
  const oldest = Math.min(...timestamps);
  if (newest <= 0 || newest === oldest) {
    return undefined;
  }

  return {
    oldest,
    newest,
    range: newest - oldest
  };
}

export function isFreshnessRetrievalIntent(request: RetrievalRequest): boolean {
  return (
    request.intent?.primary === "freshness" ||
    (request.intent?.secondary ?? []).includes("freshness") ||
    (request.intent?.sourceHints ?? []).includes("recent")
  );
}

export function freshnessTraceForCandidates(
  candidates: readonly RetrievalCandidate[],
  request: RetrievalRequest
): RetrievalFreshnessTrace | undefined {
  if (!isFreshnessRetrievalIntent(request)) {
    return undefined;
  }

  const boostedCandidateCount = candidates.filter((candidate) =>
    candidate.reasons.includes(FRESHNESS_RECENCY_REASON)
  ).length;

  return {
    applied: boostedCandidateCount > 0,
    boostedCandidateCount,
    reason:
      boostedCandidateCount > 0
        ? "Freshness query intent applied bounded recency ranking boost."
        : "Freshness query intent was detected, but no candidates had boostable recency metadata."
  };
}

export function sourceTimestamp(chunk: RagChunk): number {
  const parsed = Date.parse(chunk.provenance.capturedAt ?? chunk.provenance.ingestedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function candidateTimestamps(chunks: readonly RagChunk[]): FreshnessTimestampRange | undefined {
  return freshnessTimestampRange(chunks);
}

function compareBoostedCandidates(first: RetrievalCandidate, second: RetrievalCandidate): number {
  if (second.score !== first.score) {
    return second.score - first.score;
  }

  if (first.rank !== second.rank) {
    return first.rank - second.rank;
  }

  return first.chunk.id.localeCompare(second.chunk.id);
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}
