import type { CorpusSourceConfig } from "../profiles/profile.js";
import type { ValidatedRagProfile } from "../profiles/profile-validation.js";
import type { RequestPrincipal } from "../security/access-scope.js";
import type { CorpusAdapter, CorpusAdapterWarning, CorpusLoadResult } from "./adapter.js";
import type { CorpusRecord } from "./corpus-record.js";
import { normalizeCorpusRecords, type CorpusNormalizationIssue } from "./normalize.js";

export type CorpusAdapterContractSeverity = "error" | "warning";

export type CorpusAdapterContractIssueCode =
  | "adapter_id_required"
  | "adapter_description_required"
  | "source_adapter_mismatch"
  | "source_disabled"
  | "adapter_threw"
  | "load_source_mismatch"
  | "adapter_warning_source_mismatch"
  | "adapter_warning_code_required"
  | "adapter_warning_message_required"
  | "adapter_warning_unexpected"
  | "adapter_warning_leaks_sensitive_diagnostics"
  | "loaded_record_count_below_minimum"
  | "accepted_document_count_below_minimum"
  | "rejected_record_count_above_maximum"
  | "normalization_error";

export interface CorpusAdapterContractIssue {
  readonly severity: CorpusAdapterContractSeverity;
  readonly code: CorpusAdapterContractIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface CorpusAdapterContractExpectations {
  readonly minLoadedRecords?: number;
  readonly minAcceptedDocuments?: number;
  readonly maxRejectedRecords?: number;
  readonly allowAdapterWarnings?: boolean;
  readonly forbiddenDiagnosticPatterns?: readonly RegExp[];
}

export interface CorpusAdapterContractOptions {
  readonly adapter: CorpusAdapter;
  readonly profile: ValidatedRagProfile;
  readonly source: CorpusSourceConfig;
  readonly requestedBy: RequestPrincipal;
  readonly runId?: string;
  readonly requestedAt?: string;
  readonly expectations?: CorpusAdapterContractExpectations;
}

export interface CorpusAdapterContractResult {
  readonly adapterId: string;
  readonly sourceId: string;
  readonly loadedSourceId?: string;
  readonly loadedRecordCount: number;
  readonly acceptedDocumentCount: number;
  readonly rejectedRecordCount: number;
  readonly adapterWarnings: readonly CorpusAdapterWarning[];
  readonly normalizationIssues: readonly CorpusNormalizationIssue[];
  readonly issues: readonly CorpusAdapterContractIssue[];
}

export class CorpusAdapterContractError extends Error {
  readonly result: CorpusAdapterContractResult;

  constructor(result: CorpusAdapterContractResult) {
    super(
      `Corpus adapter contract failed for "${result.adapterId}" on source "${result.sourceId}": ${result.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.message)
        .join("; ")}`
    );
    this.name = "CorpusAdapterContractError";
    this.result = result;
  }
}

const DEFAULT_FORBIDDEN_DIAGNOSTIC_PATTERNS = [
  /bearer\s+[a-z0-9._-]+/iu,
  /api[_-]?key\s*[:=]\s*[^,\s]+/iu,
  /password\s*[:=]\s*[^,\s]+/iu,
  /secret\s*[:=]\s*[^,\s]+/iu,
  /token\s*[:=]\s*[^,\s]+/iu
] as const;

export async function assertCorpusAdapterContract(
  options: CorpusAdapterContractOptions
): Promise<CorpusAdapterContractResult> {
  const result = await validateCorpusAdapterContract(options);
  if (result.issues.some((issue) => issue.severity === "error")) {
    throw new CorpusAdapterContractError(result);
  }

  return result;
}

export async function validateCorpusAdapterContract(
  options: CorpusAdapterContractOptions
): Promise<CorpusAdapterContractResult> {
  const issues: CorpusAdapterContractIssue[] = [];
  const expectations = normalizeExpectations(options.expectations);
  validateStaticAdapterContract(options, issues);

  let loaded: CorpusLoadResult | undefined;
  try {
    loaded = await options.adapter.load({
      profile: options.profile,
      source: options.source,
      requestedBy: options.requestedBy,
      runId: options.runId ?? "adapter_contract",
      requestedAt: options.requestedAt ?? new Date(0).toISOString()
    });
  } catch (error) {
    issues.push({
      severity: "error",
      code: "adapter_threw",
      path: "adapter.load",
      message: `Adapter load must return warnings instead of throwing: ${errorName(error)}.`
    });
  }

  if (!loaded) {
    return contractResult(options, undefined, [], [], issues);
  }

  validateLoadedResult(options, loaded, expectations, issues);

  const normalized = normalizeCorpusRecords(loaded.records, {
    profile: options.profile,
    source: options.source,
    requestedBy: options.requestedBy,
    ingestedAt: options.requestedAt ?? new Date(0).toISOString()
  });

  for (const normalizationIssue of normalized.issues) {
    if (normalizationIssue.severity === "error") {
      issues.push({
        severity: "error",
        code: "normalization_error",
        path: normalizationIssue.path,
        message: normalizationIssue.message
      });
    }
  }

  validateCounts(
    loaded.records,
    normalized.documents.length,
    normalized.rejectedRecords.length,
    expectations,
    issues
  );

  return contractResult(options, loaded, normalized.issues, loaded.warnings, issues, {
    acceptedDocumentCount: normalized.documents.length,
    rejectedRecordCount: normalized.rejectedRecords.length
  });
}

interface NormalizedExpectations {
  readonly minLoadedRecords: number;
  readonly minAcceptedDocuments: number;
  readonly maxRejectedRecords: number;
  readonly allowAdapterWarnings: boolean;
  readonly forbiddenDiagnosticPatterns: readonly RegExp[];
}

function normalizeExpectations(
  expectations: CorpusAdapterContractExpectations | undefined
): NormalizedExpectations {
  return {
    minLoadedRecords: nonNegativeInteger(expectations?.minLoadedRecords, 1, "minLoadedRecords"),
    minAcceptedDocuments: nonNegativeInteger(
      expectations?.minAcceptedDocuments,
      1,
      "minAcceptedDocuments"
    ),
    maxRejectedRecords: nonNegativeInteger(
      expectations?.maxRejectedRecords,
      0,
      "maxRejectedRecords"
    ),
    allowAdapterWarnings: expectations?.allowAdapterWarnings ?? true,
    forbiddenDiagnosticPatterns:
      expectations?.forbiddenDiagnosticPatterns ?? DEFAULT_FORBIDDEN_DIAGNOSTIC_PATTERNS
  };
}

function validateStaticAdapterContract(
  options: CorpusAdapterContractOptions,
  issues: CorpusAdapterContractIssue[]
): void {
  if (!options.adapter.id.trim()) {
    issues.push({
      severity: "error",
      code: "adapter_id_required",
      path: "adapter.id",
      message: "Adapter id is required."
    });
  }

  if (!options.adapter.description.trim()) {
    issues.push({
      severity: "error",
      code: "adapter_description_required",
      path: "adapter.description",
      message: "Adapter description is required."
    });
  }

  if (options.source.adapter !== options.adapter.id) {
    issues.push({
      severity: "error",
      code: "source_adapter_mismatch",
      path: "source.adapter",
      message: `Source adapter "${options.source.adapter}" must match adapter id "${options.adapter.id}".`
    });
  }

  if (!options.source.enabled) {
    issues.push({
      severity: "error",
      code: "source_disabled",
      path: "source.enabled",
      message: `Source "${options.source.id}" must be enabled for a positive adapter contract fixture.`
    });
  }
}

function validateLoadedResult(
  options: CorpusAdapterContractOptions,
  loaded: CorpusLoadResult,
  expectations: NormalizedExpectations,
  issues: CorpusAdapterContractIssue[]
): void {
  if (loaded.sourceId !== options.source.id) {
    issues.push({
      severity: "error",
      code: "load_source_mismatch",
      path: "load.sourceId",
      message: `Adapter returned sourceId "${loaded.sourceId}" for source "${options.source.id}".`
    });
  }

  loaded.warnings.forEach((warning, index) =>
    validateAdapterWarning(warning, index, options.source.id, expectations, issues)
  );
}

function validateAdapterWarning(
  warning: CorpusAdapterWarning,
  index: number,
  sourceId: string,
  expectations: NormalizedExpectations,
  issues: CorpusAdapterContractIssue[]
): void {
  if (warning.sourceId !== sourceId) {
    issues.push({
      severity: "error",
      code: "adapter_warning_source_mismatch",
      path: `warnings[${index}].sourceId`,
      message: `Adapter warning sourceId "${warning.sourceId}" must match source "${sourceId}".`
    });
  }

  if (!warning.code.trim()) {
    issues.push({
      severity: "error",
      code: "adapter_warning_code_required",
      path: `warnings[${index}].code`,
      message: "Adapter warning code is required."
    });
  }

  if (!warning.message.trim()) {
    issues.push({
      severity: "error",
      code: "adapter_warning_message_required",
      path: `warnings[${index}].message`,
      message: "Adapter warning message is required."
    });
  }

  if (!expectations.allowAdapterWarnings) {
    issues.push({
      severity: "error",
      code: "adapter_warning_unexpected",
      path: `warnings[${index}]`,
      message: "Adapter warnings are not allowed by this contract fixture."
    });
  }

  if (expectations.forbiddenDiagnosticPatterns.some((pattern) => pattern.test(warning.message))) {
    issues.push({
      severity: "error",
      code: "adapter_warning_leaks_sensitive_diagnostics",
      path: `warnings[${index}].message`,
      message: "Adapter warning message appears to contain sensitive diagnostics."
    });
  }
}

function validateCounts(
  records: readonly (CorpusRecord | null | undefined)[],
  acceptedDocumentCount: number,
  rejectedRecordCount: number,
  expectations: NormalizedExpectations,
  issues: CorpusAdapterContractIssue[]
): void {
  if (records.length < expectations.minLoadedRecords) {
    issues.push({
      severity: "error",
      code: "loaded_record_count_below_minimum",
      path: "records",
      message: `Adapter loaded ${records.length} records; expected at least ${expectations.minLoadedRecords}.`
    });
  }

  if (acceptedDocumentCount < expectations.minAcceptedDocuments) {
    issues.push({
      severity: "error",
      code: "accepted_document_count_below_minimum",
      path: "records",
      message: `Adapter produced ${acceptedDocumentCount} accepted documents; expected at least ${expectations.minAcceptedDocuments}.`
    });
  }

  if (rejectedRecordCount > expectations.maxRejectedRecords) {
    issues.push({
      severity: "error",
      code: "rejected_record_count_above_maximum",
      path: "records",
      message: `Adapter produced ${rejectedRecordCount} rejected records; expected at most ${expectations.maxRejectedRecords}.`
    });
  }
}

function contractResult(
  options: CorpusAdapterContractOptions,
  loaded: CorpusLoadResult | undefined,
  normalizationIssues: readonly CorpusNormalizationIssue[],
  adapterWarnings: readonly CorpusAdapterWarning[],
  issues: readonly CorpusAdapterContractIssue[],
  counts: {
    readonly acceptedDocumentCount?: number;
    readonly rejectedRecordCount?: number;
  } = {}
): CorpusAdapterContractResult {
  return {
    adapterId: options.adapter.id,
    sourceId: options.source.id,
    ...(loaded?.sourceId === undefined ? {} : { loadedSourceId: loaded.sourceId }),
    loadedRecordCount: loaded?.records.length ?? 0,
    acceptedDocumentCount: counts.acceptedDocumentCount ?? 0,
    rejectedRecordCount: counts.rejectedRecordCount ?? 0,
    adapterWarnings,
    normalizationIssues,
    issues
  };
}

function nonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return resolved;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}
