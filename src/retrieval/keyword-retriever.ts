import type { ChunkStore } from "../indexing/chunk-store.js";
import { redactIndexFilterForTrace } from "../indexing/index-filter.js";
import type { IndexedChunk, IndexFilter } from "../indexing/index-types.js";
import { hashText } from "../shared/hash.js";
import {
  applyFreshnessRecencyBoostToScore,
  freshnessTraceForCandidates,
  freshnessTimestampRange,
  isFreshnessRetrievalIntent
} from "./freshness-ranking.js";
import type { Retriever, RetrieverCapabilities } from "./retriever.js";
import type {
  RetrievalCandidate,
  RetrievalRejection,
  RetrievalRequest,
  RetrievalResult,
  RetrievalTrace
} from "./retrieval-types.js";

const DEFAULT_CANDIDATE_POOL_LIMIT = 500;
const MAX_TOP_K = 100;
const MAX_CANDIDATE_POOL_LIMIT = 5000;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "describe",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "relationship",
  "relationships",
  "that",
  "the",
  "this",
  "to",
  "what",
  "when",
  "where",
  "which",
  "why",
  "with"
]);

export interface KeywordRetrieverOptions {
  readonly chunkStore: ChunkStore;
  readonly now?: () => string;
}

interface ScoredIndexedChunk {
  readonly indexed: IndexedChunk;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly reasons: readonly string[];
}

export class KeywordRetriever implements Retriever {
  readonly capabilities: RetrieverCapabilities = {
    modes: ["keyword"],
    supportsVectorSearch: false,
    supportsHybridSearch: false
  };

  private readonly chunkStore: ChunkStore;
  private readonly now: () => string;

  constructor(options: KeywordRetrieverOptions) {
    this.chunkStore = options.chunkStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const startedAt = request.requestedAt ?? this.now();
    const retrievalId = request.retrievalId ?? `retrieval_${startedAt.replace(/[^0-9a-z]/gi, "")}`;
    const normalizedQuery = normalizeKeywordQuery(request.query);
    const searchTerms = tokenizeQuery(normalizedQuery);
    const rejected: RetrievalRejection[] = [];

    validateKeywordRetrievalRequest(request, normalizedQuery);

    if (searchTerms.length === 0) {
      rejected.push({
        code: "empty_query",
        reason: "Query did not contain searchable terms."
      });
      return buildKeywordRetrievalResult({
        request,
        retrievalId,
        startedAt,
        finishedAt: this.now(),
        normalizedQuery,
        searchTerms,
        candidatePool: [],
        candidates: [],
        rejected
      });
    }

    const candidatePool = await this.chunkStore.findChunks(
      buildCandidateFilter(request.filter, request)
    );
    const termWeights = buildTermWeights(candidatePool, searchTerms);
    const scored: ScoredIndexedChunk[] = [];

    for (const indexed of candidatePool) {
      const score = scoreChunk(indexed, normalizedQuery, searchTerms, termWeights);
      if (score.score > 0) {
        scored.push({
          indexed,
          score: score.score,
          matchedTerms: score.matchedTerms,
          reasons: score.reasons
        });
      } else if (request.includeRejected) {
        rejected.push({
          chunkId: indexed.chunk.id,
          code: "no_keyword_match",
          reason: "Chunk passed index filters but did not match query terms."
        });
      }
    }

    const ranked = [...applyFreshnessRecencyBoosts(applyStructuredNeighborBoosts(scored), request)]
      .sort(compareScoredChunks)
      .slice(0, request.topK)
      .map<RetrievalCandidate>((entry, index) => ({
        chunk: entry.indexed.chunk,
        score: entry.score,
        rank: index + 1,
        matchedTerms: entry.matchedTerms,
        citation: entry.indexed.chunk.citation,
        reasons: entry.reasons
      }));

    return buildKeywordRetrievalResult({
      request,
      retrievalId,
      startedAt,
      finishedAt: this.now(),
      normalizedQuery,
      searchTerms,
      candidatePool,
      candidates: ranked,
      rejected
    });
  }
}

export function tokenizeQuery(query: string): readonly string[] {
  const terms = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const filtered = terms.filter((term) => term.length > 1 && !STOP_WORDS.has(term));

  return [...new Set(filtered.length > 0 ? filtered : terms)];
}

export function validateKeywordRetrievalRequest(
  request: RetrievalRequest,
  normalizedQuery: string
): void {
  if (!normalizedQuery) {
    throw new Error("Retrieval query is required.");
  }

  if (request.mode !== undefined && request.mode !== "keyword") {
    throw new Error(`KeywordRetriever cannot serve retrieval mode "${request.mode}".`);
  }

  if (!request.filter.namespaceId.trim()) {
    throw new Error("Retrieval filter namespaceId is required.");
  }

  if (!request.filter.tenantId.trim()) {
    throw new Error("Retrieval filter tenantId is required.");
  }

  if (request.filter.tenantId !== request.filter.principal.tenantId) {
    throw new Error("Retrieval filter tenantId must match the requesting principal.");
  }

  if (!request.filter.principal.namespaceIds.includes(request.filter.namespaceId)) {
    throw new Error("Retrieval principal is not allowed for the requested namespaceId.");
  }

  if (!Number.isInteger(request.topK) || request.topK < 1 || request.topK > MAX_TOP_K) {
    throw new Error(`Retrieval topK must be an integer between 1 and ${MAX_TOP_K}.`);
  }

  if (
    request.candidatePoolLimit !== undefined &&
    (!Number.isInteger(request.candidatePoolLimit) ||
      request.candidatePoolLimit < request.topK ||
      request.candidatePoolLimit > MAX_CANDIDATE_POOL_LIMIT)
  ) {
    throw new Error(
      `candidatePoolLimit must be an integer between topK and ${MAX_CANDIDATE_POOL_LIMIT}.`
    );
  }
}

function buildCandidateFilter(filter: IndexFilter, request: RetrievalRequest): IndexFilter {
  return {
    ...filter,
    limit: request.candidatePoolLimit ?? filter.limit ?? DEFAULT_CANDIDATE_POOL_LIMIT
  };
}

export function normalizeKeywordQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

function scoreChunk(
  indexed: IndexedChunk,
  normalizedQuery: string,
  searchTerms: readonly string[],
  termWeights: ReadonlyMap<string, number>
): {
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly reasons: readonly string[];
} {
  const chunk = indexed.chunk;
  const haystack = keywordHaystackForChunk(chunk);
  const matchedTerms = searchTerms.filter((term) => haystack.includes(term));

  if (matchedTerms.length === 0) {
    return {
      score: 0,
      matchedTerms: [],
      reasons: []
    };
  }

  const totalQueryWeight = searchTerms.reduce((sum, term) => sum + (termWeights.get(term) ?? 1), 0);
  const matchedWeight = matchedTerms.reduce((sum, term) => sum + (termWeights.get(term) ?? 1), 0);
  const termFrequency = matchedTerms.reduce(
    (count, term) =>
      count + Math.min(countOccurrences(haystack, term), 3) * (termWeights.get(term) ?? 1),
    0
  );
  const coverageScore = matchedWeight / totalQueryWeight;
  const frequencyScore = Math.min(termFrequency, 10) * 0.05;
  const exactPhraseScore = haystack.includes(normalizedQuery) ? 1 : 0;
  const titleScore = matchedTerms.some((term) =>
    chunk.provenance.title.toLowerCase().includes(term)
  )
    ? 0.25
    : 0;

  return {
    score: roundScore(coverageScore + frequencyScore + exactPhraseScore + titleScore),
    matchedTerms,
    reasons: [
      "keyword_term_match",
      ...(exactPhraseScore > 0 ? ["exact_phrase_match"] : []),
      ...(titleScore > 0 ? ["source_title_match"] : [])
    ]
  };
}

function buildTermWeights(
  candidatePool: readonly IndexedChunk[],
  searchTerms: readonly string[]
): ReadonlyMap<string, number> {
  const weights = new Map<string, number>();
  const haystacks = candidatePool.map((indexed) => keywordHaystackForChunk(indexed.chunk));
  const candidateCount = Math.max(haystacks.length, 1);

  for (const term of searchTerms) {
    const documentFrequency = haystacks.filter((haystack) => haystack.includes(term)).length;
    weights.set(term, Math.min(2.5, 1 + Math.log((candidateCount + 1) / (documentFrequency + 1))));
  }

  return weights;
}

function keywordHaystackForChunk(chunk: IndexedChunk["chunk"]): string {
  return [
    chunk.text,
    stringMetadata(chunk.metadata, "searchableEmbeddingText"),
    chunk.provenance.title,
    chunk.citation.title
  ]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join("\n")
    .toLowerCase();
}

function stringMetadata(
  metadata: Readonly<Record<string, string | number | boolean>> | undefined,
  key: string
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function applyStructuredNeighborBoosts(
  scored: readonly ScoredIndexedChunk[]
): readonly ScoredIndexedChunk[] {
  const byDocument = new Map<string, ScoredIndexedChunk[]>();
  for (const entry of scored) {
    const entries = byDocument.get(entry.indexed.chunk.documentId) ?? [];
    entries.push(entry);
    byDocument.set(entry.indexed.chunk.documentId, entries);
  }

  return scored.map((entry) => {
    if (!isStructuredEvidenceChunk(entry.indexed.chunk)) {
      return entry;
    }

    const neighbor = (byDocument.get(entry.indexed.chunk.documentId) ?? [])
      .filter(
        (candidate) =>
          candidate !== entry &&
          Math.abs(candidate.indexed.chunk.index - entry.indexed.chunk.index) <= 1
      )
      .sort((first, second) => second.score - first.score)[0];
    if (!neighbor || neighbor.score <= entry.score) {
      return entry;
    }

    const boost = Math.min(0.75, neighbor.score * 0.4);
    return {
      ...entry,
      score: roundScore(entry.score + boost),
      reasons: [...new Set([...entry.reasons, "structured_neighbor_match"])]
    };
  });
}

function applyFreshnessRecencyBoosts(
  scored: readonly ScoredIndexedChunk[],
  request: RetrievalRequest
): readonly ScoredIndexedChunk[] {
  if (!isFreshnessRetrievalIntent(request) || scored.length < 2) {
    return scored;
  }

  const timestamps = freshnessTimestampRange(scored.map((entry) => entry.indexed.chunk));
  if (!timestamps) {
    return scored;
  }

  return scored.map((entry) => {
    const boosted = applyFreshnessRecencyBoostToScore(
      {
        chunk: entry.indexed.chunk,
        score: entry.score,
        reasons: entry.reasons
      },
      timestamps
    );
    return {
      ...entry,
      score: boosted.score,
      reasons: boosted.reasons
    };
  });
}

function isStructuredEvidenceChunk(chunk: IndexedChunk["chunk"]): boolean {
  if ((chunk.layoutRegionIds ?? []).length > 0 && /\|/.test(chunk.text)) {
    return true;
  }

  const tableLikeLineCount = chunk.text
    .split(/\r?\n/u)
    .filter((line) => line.split("|").length >= 2).length;
  return tableLikeLineCount >= 2;
}

function compareScoredChunks(first: ScoredIndexedChunk, second: ScoredIndexedChunk): number {
  if (second.score !== first.score) {
    return second.score - first.score;
  }

  if (first.indexed.chunk.documentId !== second.indexed.chunk.documentId) {
    return first.indexed.chunk.documentId.localeCompare(second.indexed.chunk.documentId);
  }

  if (first.indexed.chunk.index !== second.indexed.chunk.index) {
    return first.indexed.chunk.index - second.indexed.chunk.index;
  }

  return first.indexed.chunk.id.localeCompare(second.indexed.chunk.id);
}

function countOccurrences(value: string, term: string): number {
  let count = 0;
  let cursor = 0;

  while (cursor < value.length) {
    const next = value.indexOf(term, cursor);
    if (next === -1) {
      break;
    }

    count += 1;
    cursor = next + term.length;
  }

  return count;
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}

export function buildKeywordRetrievalResult(input: {
  readonly request: RetrievalRequest;
  readonly retrievalId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly normalizedQuery: string;
  readonly searchTerms: readonly string[];
  readonly candidatePool: readonly IndexedChunk[];
  readonly candidates: readonly RetrievalCandidate[];
  readonly rejected: readonly RetrievalRejection[];
}): RetrievalResult {
  const freshnessTrace = freshnessTraceForCandidates(input.candidates, input.request);
  const trace: RetrievalTrace = {
    retrievalId: input.retrievalId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    mode: "keyword",
    queryHash: hashText(input.request.query),
    normalizedQueryHash: hashText(input.normalizedQuery),
    searchTermHashes: input.searchTerms.map((term) => hashText(term)),
    access: redactIndexFilterForTrace(input.request.filter),
    candidatePoolSize: input.candidatePool.length,
    returnedCount: input.candidates.length,
    rejectedCount: input.rejected.length,
    ...(freshnessTrace === undefined ? {} : { freshness: freshnessTrace })
  };

  return {
    query: input.request.query,
    candidates: input.candidates,
    rejected: input.rejected,
    trace
  };
}
