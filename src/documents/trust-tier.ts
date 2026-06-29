export type TrustTier =
  | "trusted_internal"
  | "verified_partner"
  | "user_provided"
  | "external_untrusted"
  | "generated_or_derived"
  | "unknown";

export const TRUST_TIERS = [
  "trusted_internal",
  "verified_partner",
  "user_provided",
  "external_untrusted",
  "generated_or_derived",
  "unknown"
] as const satisfies readonly TrustTier[];

export type SourceSensitivity = "public" | "internal" | "confidential" | "restricted";

export const SOURCE_SENSITIVITIES = [
  "public",
  "internal",
  "confidential",
  "restricted"
] as const satisfies readonly SourceSensitivity[];

export const HIGH_RISK_TRUST_TIERS = [
  "external_untrusted",
  "generated_or_derived",
  "unknown"
] as const satisfies readonly TrustTier[];

const TRUST_TIER_RISK_RANK = {
  trusted_internal: 0,
  verified_partner: 1,
  user_provided: 2,
  generated_or_derived: 3,
  external_untrusted: 4,
  unknown: 5
} as const satisfies Record<TrustTier, number>;

export interface TrustPolicy {
  readonly allowedTrustTiers: readonly TrustTier[];
  readonly requireHumanReviewFor: readonly TrustTier[];
  readonly minimumAnswerTrustTier: TrustTier;
}

export type TrustTierDecisionReason =
  | "record_declared_trust_tier"
  | "source_floor_downgraded_trust"
  | "source_override_downgraded_trust"
  | "source_override_rejected_trust_upgrade";

export interface TrustTierDecision {
  readonly declaredTrustTier: TrustTier;
  readonly effectiveTrustTier: TrustTier;
  readonly sourceTrustTierFloor?: TrustTier;
  readonly sourceTrustTierOverride?: TrustTier;
  readonly unsafeUpgrade: boolean;
  readonly reasons: readonly TrustTierDecisionReason[];
}

export function isTrustTier(value: string): value is TrustTier {
  return TRUST_TIERS.some((tier) => tier === value);
}

export function isSourceSensitivity(value: string): value is SourceSensitivity {
  return SOURCE_SENSITIVITIES.some((sensitivity) => sensitivity === value);
}

export function isTrustUpgrade(from: TrustTier, to: TrustTier): boolean {
  return TRUST_TIER_RISK_RANK[to] < TRUST_TIER_RISK_RANK[from];
}

export function leastTrustedTier(first: TrustTier, second: TrustTier): TrustTier {
  return TRUST_TIER_RISK_RANK[first] >= TRUST_TIER_RISK_RANK[second] ? first : second;
}

export function resolveTrustTierDecision(input: {
  readonly declaredTrustTier: TrustTier;
  readonly sourceTrustTierFloor?: TrustTier;
  readonly sourceTrustTierOverride?: TrustTier;
}): TrustTierDecision {
  const reasons: TrustTierDecisionReason[] = ["record_declared_trust_tier"];
  let effectiveTrustTier = input.declaredTrustTier;

  if (
    input.sourceTrustTierFloor &&
    isTrustUpgrade(input.sourceTrustTierFloor, effectiveTrustTier)
  ) {
    effectiveTrustTier = input.sourceTrustTierFloor;
    reasons.push("source_floor_downgraded_trust");
  }

  if (input.sourceTrustTierOverride) {
    if (isTrustUpgrade(effectiveTrustTier, input.sourceTrustTierOverride)) {
      return {
        declaredTrustTier: input.declaredTrustTier,
        effectiveTrustTier,
        ...(input.sourceTrustTierFloor === undefined
          ? {}
          : { sourceTrustTierFloor: input.sourceTrustTierFloor }),
        sourceTrustTierOverride: input.sourceTrustTierOverride,
        unsafeUpgrade: true,
        reasons: [...reasons, "source_override_rejected_trust_upgrade"]
      };
    }

    const downgraded = leastTrustedTier(effectiveTrustTier, input.sourceTrustTierOverride);
    if (downgraded !== effectiveTrustTier) {
      reasons.push("source_override_downgraded_trust");
    }
    effectiveTrustTier = downgraded;
  }

  return {
    declaredTrustTier: input.declaredTrustTier,
    effectiveTrustTier,
    ...(input.sourceTrustTierFloor === undefined
      ? {}
      : { sourceTrustTierFloor: input.sourceTrustTierFloor }),
    ...(input.sourceTrustTierOverride === undefined
      ? {}
      : { sourceTrustTierOverride: input.sourceTrustTierOverride }),
    unsafeUpgrade: false,
    reasons
  };
}
