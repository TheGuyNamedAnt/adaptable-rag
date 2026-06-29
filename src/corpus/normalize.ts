import type { RagDocument } from "../documents/document.js";
import { validateDocumentLayout } from "../documents/layout.js";
import { isSourceKind, type SourceProvenance } from "../documents/provenance.js";
import {
  isSourceSensitivity,
  isTrustTier,
  resolveTrustTierDecision
} from "../documents/trust-tier.js";
import { hashText } from "../shared/hash.js";
import type { CorpusSourceConfig } from "../profiles/profile.js";
import type { ValidatedRagProfile } from "../profiles/profile-validation.js";
import type { RequestPrincipal } from "../security/access-scope.js";
import type { CorpusRecord, RejectedCorpusRecord } from "./corpus-record.js";

export type CorpusNormalizationSeverity = "error" | "warning";

export type CorpusNormalizationCode =
  | "empty_record_field"
  | "disabled_source"
  | "source_not_declared"
  | "source_mismatch"
  | "namespace_boundary_violation"
  | "principal_boundary_violation"
  | "null_record"
  | "invalid_source_kind"
  | "invalid_sensitivity"
  | "invalid_trust_tier"
  | "unsafe_trust_upgrade"
  | "checksum_mismatch"
  | "invalid_layout"
  | "disallowed_trust_tier"
  | "missing_access_scope"
  | "missing_provenance_field";

export interface CorpusNormalizationIssue {
  readonly severity: CorpusNormalizationSeverity;
  readonly code: CorpusNormalizationCode;
  readonly recordId: string;
  readonly path: string;
  readonly message: string;
}

export interface CorpusNormalizationContext {
  readonly profile: ValidatedRagProfile;
  readonly source: CorpusSourceConfig;
  readonly requestedBy: RequestPrincipal;
  readonly ingestedAt: string;
}

export type CorpusNormalizationResult =
  | {
      readonly accepted: true;
      readonly document: RagDocument;
      readonly issues: readonly CorpusNormalizationIssue[];
    }
  | {
      readonly accepted: false;
      readonly issues: readonly CorpusNormalizationIssue[];
    };

export interface CorpusNormalizationBatchResult {
  readonly documents: readonly RagDocument[];
  readonly rejectedRecords: readonly RejectedCorpusRecord[];
  readonly issues: readonly CorpusNormalizationIssue[];
}

export function normalizeCorpusRecord(
  record: CorpusRecord | null | undefined,
  context: CorpusNormalizationContext
): CorpusNormalizationResult {
  const issues: CorpusNormalizationIssue[] = [];
  if (!record) {
    issues.push({
      severity: "error",
      code: "null_record",
      recordId: "unknown",
      path: "record",
      message: "Corpus adapter returned a null or undefined record."
    });

    return {
      accepted: false,
      issues
    };
  }

  validateRequiredText(record, "id", stringField(record.id), issues);
  validateRequiredText(record, "sourceId", stringField(record.sourceId), issues);
  validateRequiredText(record, "title", stringField(record.title), issues);
  validateRequiredText(record, "body", stringField(record.body), issues);
  validateRequiredText(record, "sourceKind", stringField(record.sourceKind), issues);
  validateSourceKind(record, issues);
  validateSensitivity(record, issues);
  validateChecksum(record, issues);
  validateLayout(record, normalizedBodyForRecord(record), issues);

  const declaredSource = context.profile.corpusSources.find(
    (source) => source.id === context.source.id
  );
  if (!declaredSource) {
    issues.push({
      severity: "error",
      code: "source_not_declared",
      recordId: recordId(record),
      path: "source.id",
      message: `Corpus source "${context.source.id}" is not declared by profile "${context.profile.id}".`
    });
  } else {
    if (!declaredSource.enabled) {
      issues.push({
        severity: "error",
        code: "disabled_source",
        recordId: recordId(record),
        path: "source.enabled",
        message: `Corpus source "${context.source.id}" is disabled by profile "${context.profile.id}".`
      });
    }

    if (
      declaredSource.adapter !== context.source.adapter ||
      declaredSource.enabled !== context.source.enabled ||
      declaredSource.trustTierOverride !== context.source.trustTierOverride ||
      declaredSource.trustTierFloor !== context.source.trustTierFloor
    ) {
      issues.push({
        severity: "error",
        code: "source_mismatch",
        recordId: recordId(record),
        path: "source",
        message: `Corpus source "${context.source.id}" does not match the profile-declared source config.`
      });
    }
  }

  if (record.sourceId !== context.source.id) {
    issues.push({
      severity: "error",
      code: "source_mismatch",
      recordId: recordId(record),
      path: "sourceId",
      message: `Record source "${record.sourceId}" does not match configured source "${context.source.id}".`
    });
  }

  validateAccessScope(record, context, issues);
  validateFreshness(record, context, issues);

  const trustDecision = resolveEffectiveTrustTier(record, context, issues);
  if (!context.profile.trustPolicy.allowedTrustTiers.includes(trustDecision.effectiveTrustTier)) {
    issues.push({
      severity: "error",
      code: "disallowed_trust_tier",
      recordId: recordId(record),
      path: "trustTier",
      message: `Trust tier "${trustDecision.effectiveTrustTier}" is not allowed by profile "${context.profile.id}".`
    });
  }

  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    return {
      accepted: false,
      issues
    };
  }

  const provenance: SourceProvenance = {
    sourceId: stringField(record.sourceId),
    sourceKind: record.sourceKind,
    title: stringField(record.title).trim(),
    ingestedAt: context.ingestedAt,
    trustTier: trustDecision.effectiveTrustTier,
    sensitivity: record.sensitivity,
    ...(stringField(record.originUri) ? { originUri: stringField(record.originUri) } : {}),
    ...(stringField(record.path) ? { path: stringField(record.path) } : {}),
    ...(stringField(record.owner) ? { owner: stringField(record.owner) } : {}),
    ...(stringField(record.capturedAt) ? { capturedAt: stringField(record.capturedAt) } : {}),
    ...(stringField(record.checksum) ? { checksum: stringField(record.checksum) } : {})
  };

  return {
    accepted: true,
    document: {
      id: stringField(record.id).trim(),
      namespaceId: context.profile.namespaceId,
      title: stringField(record.title).trim(),
      body: normalizedBodyForRecord(record),
      provenance,
      accessScope: record.accessScope,
      ...(record.layout ? { layout: record.layout } : {}),
      metadata: {
        ...(record.metadata ?? {}),
        trustDeclaredTier: trustDecision.declaredTrustTier,
        trustEffectiveTier: trustDecision.effectiveTrustTier,
        trustUnsafeUpgrade: trustDecision.unsafeUpgrade,
        trustDecisionReasons: trustDecision.reasons.join(","),
        ...(trustDecision.sourceTrustTierFloor === undefined
          ? {}
          : { trustSourceFloor: trustDecision.sourceTrustTierFloor }),
        ...(trustDecision.sourceTrustTierOverride === undefined
          ? {}
          : { trustSourceOverride: trustDecision.sourceTrustTierOverride })
      }
    },
    issues
  };
}

function validateFreshness(
  record: CorpusRecord,
  context: CorpusNormalizationContext,
  issues: CorpusNormalizationIssue[]
): void {
  if (context.profile.freshnessPolicy.requireCapturedAt && !stringField(record.capturedAt).trim()) {
    issues.push({
      severity: "error",
      code: "missing_provenance_field",
      recordId: recordId(record),
      path: "capturedAt",
      message: `Profile "${context.profile.id}" requires capturedAt for freshness-aware provenance.`
    });
  }
}

export function normalizeCorpusRecords(
  records: readonly (CorpusRecord | null | undefined)[],
  context: CorpusNormalizationContext
): CorpusNormalizationBatchResult {
  const documents: RagDocument[] = [];
  const rejectedRecords: RejectedCorpusRecord[] = [];
  const issues: CorpusNormalizationIssue[] = [];

  for (const record of records) {
    const result = normalizeCorpusRecord(record, context);
    issues.push(...result.issues);

    if (result.accepted) {
      documents.push(result.document);
    } else {
      rejectedRecords.push({
        recordId: record ? recordId(record) : "unknown",
        sourceId: record ? stringField(record.sourceId) || context.source.id : context.source.id,
        rejectedStage: "normalizing",
        reason: summarizeRejection(result.issues)
      });
    }
  }

  return {
    documents,
    rejectedRecords,
    issues
  };
}

function validateRequiredText(
  record: CorpusRecord,
  path: string,
  value: string,
  issues: CorpusNormalizationIssue[]
): void {
  if (!value.trim()) {
    issues.push({
      severity: "error",
      code: "empty_record_field",
      recordId: recordId(record),
      path,
      message: `${path} is required.`
    });
  }
}

function validateSourceKind(record: CorpusRecord, issues: CorpusNormalizationIssue[]): void {
  if (!isSourceKind(record.sourceKind)) {
    issues.push({
      severity: "error",
      code: "invalid_source_kind",
      recordId: recordId(record),
      path: "sourceKind",
      message: `Unknown source kind "${record.sourceKind}".`
    });
  }
}

function validateSensitivity(record: CorpusRecord, issues: CorpusNormalizationIssue[]): void {
  if (!isSourceSensitivity(record.sensitivity)) {
    issues.push({
      severity: "error",
      code: "invalid_sensitivity",
      recordId: recordId(record),
      path: "sensitivity",
      message: `Unknown source sensitivity "${record.sensitivity}".`
    });
  }
}

function validateChecksum(record: CorpusRecord, issues: CorpusNormalizationIssue[]): void {
  const checksum = stringField(record.checksum);
  if (!checksum.trim()) {
    return;
  }

  if (checksum !== hashText(stringField(record.body))) {
    issues.push({
      severity: "error",
      code: "checksum_mismatch",
      recordId: recordId(record),
      path: "checksum",
      message: "Record checksum does not match the record body."
    });
  }
}

function validateLayout(
  record: CorpusRecord,
  normalizedBody: string,
  issues: CorpusNormalizationIssue[]
): void {
  if (!record.layout) {
    return;
  }

  const result = validateDocumentLayout(record.layout, normalizedBody);
  for (const layoutIssue of result.errors) {
    issues.push({
      severity: "error",
      code: "invalid_layout",
      recordId: recordId(record),
      path: `layout.${layoutIssue.path}`,
      message: layoutIssue.message
    });
  }
}

function normalizedBodyForRecord(record: CorpusRecord): string {
  const body = stringField(record.body);
  return record.layout ? body : body.trim();
}

function validateAccessScope(
  record: CorpusRecord,
  context: CorpusNormalizationContext,
  issues: CorpusNormalizationIssue[]
): void {
  const { accessScope } = record;

  if (!isRecord(accessScope)) {
    issues.push({
      severity: "error",
      code: "missing_access_scope",
      recordId: recordId(record),
      path: "accessScope",
      message: "accessScope is required on every corpus record."
    });
    return;
  }

  const tenantId = stringField(accessScope["tenantId"]);
  const namespaceId = stringField(accessScope["namespaceId"]);

  if (!tenantId.trim() || !namespaceId.trim()) {
    issues.push({
      severity: "error",
      code: "missing_access_scope",
      recordId: recordId(record),
      path: "accessScope",
      message: "tenantId and namespaceId are required on every corpus record."
    });
  }

  if (namespaceId !== context.profile.namespaceId) {
    issues.push({
      severity: "error",
      code: "namespace_boundary_violation",
      recordId: recordId(record),
      path: "accessScope.namespaceId",
      message: `Record namespace "${namespaceId}" cannot enter profile namespace "${context.profile.namespaceId}".`
    });
  }

  if (tenantId !== context.requestedBy.tenantId) {
    issues.push({
      severity: "error",
      code: "principal_boundary_violation",
      recordId: recordId(record),
      path: "accessScope.tenantId",
      message: "Record tenant does not match requesting principal tenant."
    });
  }

  if (!context.requestedBy.namespaceIds.includes(context.profile.namespaceId)) {
    issues.push({
      severity: "error",
      code: "principal_boundary_violation",
      recordId: recordId(record),
      path: "requestedBy.namespaceIds",
      message: `Requesting principal is not allowed to ingest namespace "${context.profile.namespaceId}".`
    });
  }
}

function resolveEffectiveTrustTier(
  record: CorpusRecord,
  context: CorpusNormalizationContext,
  issues: CorpusNormalizationIssue[]
): ReturnType<typeof resolveTrustTierDecision> {
  if (!isTrustTier(record.trustTier)) {
    issues.push({
      severity: "error",
      code: "invalid_trust_tier",
      recordId: recordId(record),
      path: "trustTier",
      message: `Unknown trust tier "${record.trustTier}".`
    });
    return resolveTrustTierDecision({ declaredTrustTier: "unknown" });
  }

  const decision = resolveTrustTierDecision({
    declaredTrustTier: record.trustTier,
    ...(context.source.trustTierFloor === undefined
      ? {}
      : { sourceTrustTierFloor: context.source.trustTierFloor }),
    ...(context.source.trustTierOverride === undefined
      ? {}
      : { sourceTrustTierOverride: context.source.trustTierOverride })
  });

  if (decision.unsafeUpgrade && decision.sourceTrustTierOverride) {
    issues.push({
      severity: "error",
      code: "unsafe_trust_upgrade",
      recordId: recordId(record),
      path: "source.trustTierOverride",
      message: `Source override cannot upgrade "${decision.effectiveTrustTier}" to "${decision.sourceTrustTierOverride}".`
    });
  }

  return decision;
}

function summarizeRejection(issues: readonly CorpusNormalizationIssue[]): string {
  const firstError = issues.find((issue) => issue.severity === "error");
  return firstError?.message ?? "Record rejected by corpus normalization.";
}

function recordId(record: CorpusRecord): string {
  return stringField(record.id) || "unknown";
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
