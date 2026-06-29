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
  readonly baseScore: number;
}

interface SelectionState {
  readonly selectedDocumentIds: Set<string>;
  readonly selectedSourceIds: Set<string>;
  readonly selectedTextFingerprints: Set<string>;
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
    const weighted = request.candidates
      .map((candidate) => ({
        candidate,
        score: scoreCandidate(candidate, request),
        baseScore: scoreCandidate(candidate, request)
      }))
      .sort(compareWeightedCandidates);
    const ranked = selectDiverseCandidates(weighted, request.topK).map(
      ({ candidate, score }, index) => ({
        ...candidate,
        score,
        rank: index + 1,
        reasons: uniqueSorted([...candidate.reasons, ...lightweightReasons(candidate, request)])
      })
    );

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
  const lexicalOverlap = queryOverlap(request.query, searchableTextForCandidate(candidate));
  const normalizedRank = 1 / Math.max(1, candidate.rank);
  const citationScore = citationQualityScore(candidate);
  const sourceMatchScore = sourceMatch(candidate, request.query);
  const unitRoutingScore = searchableUnitRoutingScore(candidate, request.query);
  const parserGapPenalty = searchableUnitType(candidate) === "parser_gap_chunk" ? 0.2 : 0;

  return roundScore(
    candidate.score * 0.34 +
      trustScore * 0.17 +
      lexicalOverlap * 0.17 +
      normalizedRank * 0.11 +
      citationScore * 0.08 +
      sourceMatchScore * 0.05 +
      unitRoutingScore * 0.08 -
      parserGapPenalty
  );
}

function citationQualityScore(candidate: RetrievalCandidate): number {
  const citation = candidate.citation;
  let score = 0;

  if (citation.locator && !/^chunk\s+\d+$/iu.test(citation.locator)) {
    score += 0.25;
  }
  if (citation.pageNumber !== undefined) {
    score += 0.2;
  }
  if ((citation.layoutRegionIds?.length ?? 0) > 0) {
    score += 0.2;
  }
  if ((citation.boundingBoxes?.length ?? 0) > 0) {
    score += 0.2;
  }
  if (citation.visualAssetId || citation.visualAsset) {
    score += 0.15;
  }

  return Math.min(1, score);
}

function sourceMatch(candidate: RetrievalCandidate, query: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return 0;
  }

  const sourceTokens = new Set(
    tokenize(
      [
        candidate.chunk.provenance.title,
        candidate.chunk.provenance.sourceId,
        candidate.chunk.provenance.sourceKind,
        candidate.citation.title
      ].join(" ")
    )
  );
  const matched = queryTokens.filter((token) => sourceTokens.has(token)).length;
  return matched / queryTokens.length;
}

function selectDiverseCandidates(
  candidates: readonly WeightedCandidate[],
  topK: number
): readonly WeightedCandidate[] {
  const remaining = [...candidates];
  const selected: WeightedCandidate[] = [];
  const state: SelectionState = {
    selectedDocumentIds: new Set<string>(),
    selectedSourceIds: new Set<string>(),
    selectedTextFingerprints: new Set<string>()
  };

  while (selected.length < topK && remaining.length > 0) {
    const scored = remaining
      .map((candidate) => ({
        ...candidate,
        score: diversityAdjustedScore(candidate, state)
      }))
      .sort(compareWeightedCandidates);
    const next = scored[0];
    if (!next) {
      break;
    }

    selected.push(next);
    state.selectedDocumentIds.add(next.candidate.chunk.documentId);
    state.selectedSourceIds.add(next.candidate.chunk.provenance.sourceId);
    state.selectedTextFingerprints.add(textFingerprint(next.candidate.chunk.text));

    const nextChunkId = next.candidate.chunk.id;
    const index = remaining.findIndex((candidate) => candidate.candidate.chunk.id === nextChunkId);
    if (index >= 0) {
      remaining.splice(index, 1);
    }
  }

  return selected;
}

function diversityAdjustedScore(candidate: WeightedCandidate, state: SelectionState): number {
  let penalty = 0;

  if (state.selectedTextFingerprints.has(textFingerprint(candidate.candidate.chunk.text))) {
    penalty += 0.18;
  }
  if (state.selectedDocumentIds.has(candidate.candidate.chunk.documentId)) {
    penalty += 0.08;
  }
  if (state.selectedSourceIds.has(candidate.candidate.chunk.provenance.sourceId)) {
    penalty += 0.04;
  }

  return roundScore(candidate.baseScore - penalty);
}

function lightweightReasons(
  candidate: RetrievalCandidate,
  request: RerankRequest
): readonly string[] {
  return [
    "lightweight_rerank",
    ...(citationQualityScore(candidate) > 0 ? ["lightweight_citation_quality"] : []),
    ...(sourceMatch(candidate, request.query) > 0 ? ["lightweight_source_match"] : []),
    ...(searchableUnitRoutingScore(candidate, request.query) > 0
      ? ["lightweight_searchable_unit_match"]
      : []),
    ...(searchableUnitType(candidate) === "parser_gap_chunk"
      ? ["lightweight_parser_gap_downgrade"]
      : [])
  ];
}

function searchableUnitRoutingScore(candidate: RetrievalCandidate, query: string): number {
  const unitType = searchableUnitType(candidate);
  const tableIntent =
    /\b(?:table|row|rows|column|columns|cell|cells|spreadsheet|csv|xlsx|number|numeric|amount|total|revenue)\b/iu.test(
      query
    );
  const visualIntent =
    /\b(?:figure|image|visual|chart|diagram|screenshot|caption|page\s+image)\b/iu.test(query);
  const relationIntent =
    /\b(?:caption|related|relationship|relation|explains|references|continues|section)\b/iu.test(
      query
    );
  const pageIntent = /\b(?:page|pages|scan|ocr|scanned)\b/iu.test(query);
  const equationIntent =
    /\b(?:equation|formula|math|calculation|computed?|derive|metric|ratio|rate|sdp|constraint)\b/iu.test(
      query
    ) || /[=<>]|\\(?:frac|sum|succeq|leq|geq)|\b[a-z]+_[a-z]+\b/iu.test(query);

  switch (unitType) {
    case "equation_chunk":
      return equationIntent ? 1 : 0.25;
    case "table_chunk":
    case "table_row_chunk":
      return tableIntent ? 1 : 0.25;
    case "table_caption_chunk":
      return tableIntent || relationIntent ? 0.85 : 0.2;
    case "visual_asset_chunk":
    case "figure_caption_chunk":
      return visualIntent ? 1 : 0.2;
    case "heading_chunk":
      return relationIntent ? 0.55 : 0.15;
    case "layout_relation_chunk":
      return relationIntent || visualIntent || tableIntent ? 0.8 : 0.15;
    case "page_summary_chunk":
      return pageIntent ? 0.7 : 0.1;
    case "parser_gap_chunk":
      return pageIntent ? 0.25 : 0;
    default:
      return 0;
  }
}

function searchableUnitType(candidate: RetrievalCandidate): string {
  const value = candidate.chunk.metadata?.["searchableUnitType"];
  return typeof value === "string" && value.trim().length > 0 ? value : "body_chunk";
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

function searchableTextForCandidate(candidate: RetrievalCandidate): string {
  return [candidate.chunk.text, stringMetadata(candidate.chunk.metadata, "searchableEmbeddingText")]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join("\n");
}

function stringMetadata(
  metadata: Readonly<Record<string, string | number | boolean>> | undefined,
  key: string
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
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

  if (second.baseScore !== first.baseScore) {
    return second.baseScore - first.baseScore;
  }

  if (first.candidate.rank !== second.candidate.rank) {
    return first.candidate.rank - second.candidate.rank;
  }

  return first.candidate.chunk.id.localeCompare(second.candidate.chunk.id);
}

function textFingerprint(text: string): string {
  return tokenize(text).slice(0, 24).join(" ");
}

function roundScore(score: number): number {
  return Math.round(score * 1000000) / 1000000;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
