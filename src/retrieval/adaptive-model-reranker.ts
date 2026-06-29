import type { TrustTier } from "../documents/trust-tier.js";
import { LightweightReranker } from "./lightweight-reranker.js";
import type { RerankRequest, RerankResult, Reranker } from "./reranker.js";
import type { RetrievalCandidate } from "./retrieval-types.js";

export type AdaptiveModelRerankReason =
  | "low_top_score"
  | "small_score_gap"
  | "duplicate_evidence"
  | "high_risk_query"
  | "multi_part_query"
  | "relationship_query"
  | "freshness_sensitive_query"
  | "top_evidence_low_trust"
  | "context_budget_pressure";

export interface AdaptiveModelRerankerOptions {
  readonly modelReranker: Reranker;
  readonly lightweightReranker?: Reranker;
  readonly minReasonsToTrigger?: number;
  readonly lowTopScoreThreshold?: number;
  readonly smallScoreGapThreshold?: number;
  readonly contextPressureMultiplier?: number;
  readonly now?: () => string;
}

const LOW_TRUST_TIERS = new Set<TrustTier>([
  "generated_or_derived",
  "external_untrusted",
  "unknown"
]);

const HIGH_RISK_QUERY_PATTERN =
  /\b(refund|billing|payment|charge|delete|privacy|security|legal|contract|compliance|medical|policy|permission|access)\b/iu;
const RELATIONSHIP_QUERY_PATTERN =
  /\b(own|owns|owned|owner|subsidiary|parent|connected|relationship|caused|depends|belongs|linked|between)\b/iu;
const FRESHNESS_QUERY_PATTERN =
  /\b(latest|current|today|recent|updated|new|now|this\s+(week|month|year))\b/iu;

export class AdaptiveModelReranker implements Reranker {
  readonly mode = "model" as const;

  private readonly modelReranker: Reranker;
  private readonly lightweightReranker: Reranker;
  private readonly minReasonsToTrigger: number;
  private readonly lowTopScoreThreshold: number;
  private readonly smallScoreGapThreshold: number;
  private readonly contextPressureMultiplier: number;

  constructor(options: AdaptiveModelRerankerOptions) {
    this.modelReranker = options.modelReranker;
    this.lightweightReranker =
      options.lightweightReranker ??
      new LightweightReranker(options.now === undefined ? {} : { now: options.now });
    this.minReasonsToTrigger = options.minReasonsToTrigger ?? 2;
    this.lowTopScoreThreshold = options.lowTopScoreThreshold ?? 0.65;
    this.smallScoreGapThreshold = options.smallScoreGapThreshold ?? 0.08;
    this.contextPressureMultiplier = options.contextPressureMultiplier ?? 4;
  }

  async rerank(request: RerankRequest): Promise<RerankResult> {
    const lightweight = await this.lightweightReranker.rerank(request);
    const reasons = adaptiveModelRerankReasons({
      request,
      lightweight,
      lowTopScoreThreshold: this.lowTopScoreThreshold,
      smallScoreGapThreshold: this.smallScoreGapThreshold,
      contextPressureMultiplier: this.contextPressureMultiplier
    });

    if (!shouldTriggerModelRerank(reasons, this.minReasonsToTrigger)) {
      return {
        ...lightweight,
        trace: {
          ...lightweight.trace,
          warningCodes: [
            ...lightweight.trace.warningCodes,
            "adaptive_model_rerank_skipped",
            ...reasons.map((reason) => `adaptive_reason:${reason}`)
          ]
        }
      };
    }

    const model = await this.modelReranker.rerank(request);

    return {
      ...model,
      rejected: [...lightweight.rejected, ...model.rejected],
      trace: {
        ...model.trace,
        warningCodes: [
          ...model.trace.warningCodes,
          "adaptive_model_rerank_triggered",
          ...reasons.map((reason) => `adaptive_reason:${reason}`)
        ]
      }
    };
  }
}

export function adaptiveModelRerankReasons(input: {
  readonly request: RerankRequest;
  readonly lightweight: RerankResult;
  readonly lowTopScoreThreshold?: number;
  readonly smallScoreGapThreshold?: number;
  readonly contextPressureMultiplier?: number;
}): readonly AdaptiveModelRerankReason[] {
  const reasons = new Set<AdaptiveModelRerankReason>();
  const candidates = input.lightweight.candidates;
  const top = candidates[0];
  const second = candidates[1];
  const lowTopScoreThreshold = input.lowTopScoreThreshold ?? 0.65;
  const smallScoreGapThreshold = input.smallScoreGapThreshold ?? 0.08;
  const contextPressureMultiplier = input.contextPressureMultiplier ?? 4;

  if (top && top.score < lowTopScoreThreshold) {
    reasons.add("low_top_score");
  }
  if (top && second && top.score - second.score < smallScoreGapThreshold) {
    reasons.add("small_score_gap");
  }
  if (hasDuplicateEvidence(input.request.candidates)) {
    reasons.add("duplicate_evidence");
  }
  if (HIGH_RISK_QUERY_PATTERN.test(input.request.query)) {
    reasons.add("high_risk_query");
  }
  if (isMultiPartQuery(input.request.query)) {
    reasons.add("multi_part_query");
  }
  if (RELATIONSHIP_QUERY_PATTERN.test(input.request.query)) {
    reasons.add("relationship_query");
  }
  if (FRESHNESS_QUERY_PATTERN.test(input.request.query)) {
    reasons.add("freshness_sensitive_query");
  }
  if (top && LOW_TRUST_TIERS.has(top.chunk.provenance.trustTier)) {
    reasons.add("top_evidence_low_trust");
  }
  if (input.request.candidates.length >= input.request.topK * contextPressureMultiplier) {
    reasons.add("context_budget_pressure");
  }

  return [...reasons].sort();
}

function shouldTriggerModelRerank(
  reasons: readonly AdaptiveModelRerankReason[],
  minReasonsToTrigger: number
): boolean {
  if (
    reasons.includes("high_risk_query") ||
    reasons.includes("relationship_query") ||
    reasons.includes("top_evidence_low_trust") ||
    reasons.includes("context_budget_pressure")
  ) {
    return true;
  }

  return reasons.length >= minReasonsToTrigger;
}

function hasDuplicateEvidence(candidates: readonly RetrievalCandidate[]): boolean {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = textFingerprint(candidate.chunk.text);
    if (seen.has(key)) {
      return true;
    }
    seen.add(key);
  }
  return false;
}

function isMultiPartQuery(query: string): boolean {
  const normalized = query.trim();
  return (
    (normalized.includes("?") && normalized.indexOf("?") !== normalized.lastIndexOf("?")) ||
    /\b(and|also|plus|as well as)\b/iu.test(normalized)
  );
}

function textFingerprint(text: string): string {
  return [...new Set(text.toLowerCase().match(/[a-z0-9]+/gu) ?? [])].slice(0, 24).join(" ");
}
