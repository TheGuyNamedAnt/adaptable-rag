import type { CorpusRecord } from "../corpus/corpus-record.js";
import type { CorpusSourceConfig } from "../profiles/profile.js";
import type { RequestPrincipal, AccessScope } from "../security/access-scope.js";
import type { SourceSyncMode } from "../sync/source-connector.js";
import {
  SourceSyncRunner,
  type SourceSyncDeletedItem,
  type SourceSyncRunResult
} from "../sync/sync-runner.js";
import { SOURCE_SYNC_LEDGER_SCHEMA_VERSION, type SourceSyncLedger } from "../sync/sync-ledger.js";
import type { CompanyDeploymentRegistry } from "./company-deployment-registry.js";
import {
  assembleCompanyRuntime,
  type CompanyRuntimeAssemblyRequest,
  type CompanySourceConnectorRegistration
} from "./company-runtime-assembly.js";

export type CompanyConnectorContractStatus = "passed" | "failed";
export type CompanyConnectorContractSeverity = "error" | "warning";

export type CompanyConnectorContractIssueCode =
  | "sync_succeeded"
  | "mode_covered"
  | "source_id_matched"
  | "connector_id_matched"
  | "full_sync_complete"
  | "delta_returned_records"
  | "connector_warning_shape"
  | "connector_warning_unexpected"
  | "connector_warning_leaks_sensitive_diagnostics"
  | "records_match_source"
  | "records_have_required_fields"
  | "records_have_safe_acl"
  | "delete_tombstones_have_record_id"
  | "ledger_schema_matched"
  | "ledger_scope_matched"
  | "ledger_evidence_boundary_safe"
  | "ledger_excludes_record_bodies"
  | "ledger_entries_safe"
  | "ledger_tombstones_preserved";

export interface CompanyConnectorContractIssue {
  readonly severity: CompanyConnectorContractSeverity;
  readonly code: CompanyConnectorContractIssueCode;
  readonly connectorId: string;
  readonly sourceId: string;
  readonly mode: SourceSyncMode;
  readonly path: string;
  readonly message: string;
}

export interface CompanyConnectorContractExpectations {
  readonly modes?: readonly SourceSyncMode[];
  readonly minDeltaReturnedRecords?: number;
  readonly requireFullComplete?: boolean;
  readonly requireSafeAccessBoundary?: boolean;
  readonly allowConnectorWarnings?: boolean;
  readonly forbiddenDiagnosticPatterns?: readonly RegExp[];
}

export interface CompanyConnectorContractRunnerOptions {
  readonly registry: CompanyDeploymentRegistry;
  readonly company: CompanyRuntimeAssemblyRequest;
  readonly requestedBy: RequestPrincipal;
  readonly modes?: readonly SourceSyncMode[];
  readonly requestedAt?: string;
  readonly now?: () => string;
  readonly expectations?: CompanyConnectorContractExpectations;
}

export interface CompanyConnectorContractCaseResult {
  readonly status: CompanyConnectorContractStatus;
  readonly connectorId: string;
  readonly sourceSystem: string;
  readonly adapterId: string;
  readonly sourceId: string;
  readonly mode: SourceSyncMode;
  readonly run: SourceSyncRunResult;
  readonly issues: readonly CompanyConnectorContractIssue[];
  readonly errors: readonly CompanyConnectorContractIssue[];
  readonly warnings: readonly CompanyConnectorContractIssue[];
}

export interface CompanyConnectorContractReport {
  readonly status: CompanyConnectorContractStatus;
  readonly companyId: string;
  readonly useCaseId: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly requestedAt: string;
  readonly checkedConnectorCount: number;
  readonly checkedSourceCount: number;
  readonly checkedCaseCount: number;
  readonly cases: readonly CompanyConnectorContractCaseResult[];
  readonly issues: readonly CompanyConnectorContractIssue[];
  readonly errors: readonly CompanyConnectorContractIssue[];
  readonly warnings: readonly CompanyConnectorContractIssue[];
}

export class CompanyConnectorContractError extends Error {
  readonly report: CompanyConnectorContractReport;

  constructor(report: CompanyConnectorContractReport) {
    super(
      `Company connector contract failed for "${report.companyId}.${report.useCaseId}": ${report.errors
        .map((issue) => issue.message)
        .join("; ")}`
    );
    this.name = "CompanyConnectorContractError";
    this.report = report;
  }
}

const DEFAULT_MODES = ["delta", "full"] as const satisfies readonly SourceSyncMode[];

const DEFAULT_FORBIDDEN_DIAGNOSTIC_PATTERNS = [
  /bearer\s+[a-z0-9._-]+/iu,
  /api[_-]?key\s*[:=]\s*[^,\s]+/iu,
  /password\s*[:=]\s*[^,\s]+/iu,
  /secret\s*[:=]\s*[^,\s]+/iu,
  /token\s*[:=]\s*[^,\s]+/iu
] as const;

export async function assertCompanyConnectorContractTests(
  options: CompanyConnectorContractRunnerOptions
): Promise<CompanyConnectorContractReport> {
  const report = await runCompanyConnectorContractTests(options);
  if (report.errors.length > 0) {
    throw new CompanyConnectorContractError(report);
  }

  return report;
}

export async function runCompanyConnectorContractTests(
  options: CompanyConnectorContractRunnerOptions
): Promise<CompanyConnectorContractReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const requestedAt = options.requestedAt ?? now();
  const expectations = normalizeExpectations(options);
  const modes = uniqueModes(options.modes ?? expectations.modes ?? DEFAULT_MODES);
  const assembly = assembleCompanyRuntime(options.registry, options.company);
  const sourcesById = new Map(
    assembly.resolution.profile.corpusSources.map((source) => [source.id, source])
  );
  const previousLedgers = new Map<string, SourceSyncLedger>();
  const cases: CompanyConnectorContractCaseResult[] = [];

  for (const registration of assembly.sourceConnectorRegistrations) {
    for (const sourceId of registration.sourceIds) {
      const source = sourcesById.get(sourceId);
      if (!source) {
        continue;
      }

      for (const mode of modes) {
        const previousKey = `${registration.connectorId}:${source.id}`;
        const previousLedger = previousLedgers.get(previousKey);
        const run = await new SourceSyncRunner({
          connector: registration.connector,
          now
        }).sync({
          profile: assembly.resolution.profile,
          source,
          requestedBy: options.requestedBy,
          mode,
          runId: contractRunId({
            requestedAt,
            connectorId: registration.connectorId,
            sourceId: source.id,
            mode
          }),
          requestedAt,
          ...(previousLedger === undefined ? {} : { previousLedger })
        });

        if (run.status !== "failed") {
          previousLedgers.set(previousKey, run.ledger);
        }

        const issues = validateContractCase({
          registration,
          source,
          run,
          mode,
          profileNamespaceId: assembly.resolution.profile.namespaceId,
          tenantId: assembly.resolution.company.defaultTenantId,
          expectations
        });
        const errors = issues.filter((issue) => issue.severity === "error");
        const warnings = issues.filter((issue) => issue.severity === "warning");

        cases.push({
          status: errors.length === 0 ? "passed" : "failed",
          connectorId: registration.connectorId,
          sourceSystem: registration.sourceSystem,
          adapterId: registration.adapterId,
          sourceId: source.id,
          mode,
          run,
          issues,
          errors,
          warnings
        });
      }
    }
  }

  const issues = cases.flatMap((contractCase) => contractCase.issues);
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");

  return {
    status: errors.length === 0 ? "passed" : "failed",
    companyId: assembly.resolution.company.companyId,
    useCaseId: assembly.resolution.useCaseId,
    profileId: assembly.resolution.profile.id,
    namespaceId: assembly.resolution.profile.namespaceId,
    requestedAt,
    checkedConnectorCount: assembly.sourceConnectorRegistrations.length,
    checkedSourceCount: uniqueStrings(
      assembly.sourceConnectorRegistrations.flatMap((registration) => registration.sourceIds)
    ).length,
    checkedCaseCount: cases.length,
    cases,
    issues,
    errors,
    warnings
  };
}

interface NormalizedExpectations {
  readonly modes?: readonly SourceSyncMode[];
  readonly minDeltaReturnedRecords: number;
  readonly requireFullComplete: boolean;
  readonly requireSafeAccessBoundary: boolean;
  readonly allowConnectorWarnings: boolean;
  readonly forbiddenDiagnosticPatterns: readonly RegExp[];
}

function normalizeExpectations(
  options: CompanyConnectorContractRunnerOptions
): NormalizedExpectations {
  const expectations = options.expectations;
  return {
    ...(expectations?.modes === undefined ? {} : { modes: expectations.modes }),
    minDeltaReturnedRecords: nonNegativeInteger(
      expectations?.minDeltaReturnedRecords,
      1,
      "minDeltaReturnedRecords"
    ),
    requireFullComplete: expectations?.requireFullComplete ?? true,
    requireSafeAccessBoundary: expectations?.requireSafeAccessBoundary ?? true,
    allowConnectorWarnings: expectations?.allowConnectorWarnings ?? true,
    forbiddenDiagnosticPatterns:
      expectations?.forbiddenDiagnosticPatterns ?? DEFAULT_FORBIDDEN_DIAGNOSTIC_PATTERNS
  };
}

function validateContractCase(input: {
  readonly registration: CompanySourceConnectorRegistration;
  readonly source: CorpusSourceConfig;
  readonly run: SourceSyncRunResult;
  readonly mode: SourceSyncMode;
  readonly profileNamespaceId: string;
  readonly tenantId: string;
  readonly expectations: NormalizedExpectations;
}): readonly CompanyConnectorContractIssue[] {
  const issues: CompanyConnectorContractIssue[] = [];
  validateRunShape(input, issues);
  validateConnectorWarnings(input, issues);
  validateRecords(input, issues);
  validateDeletedItems(input, issues);
  validateLedger(input, issues);
  return issues;
}

function validateRunShape(
  input: {
    readonly registration: CompanySourceConnectorRegistration;
    readonly source: CorpusSourceConfig;
    readonly run: SourceSyncRunResult;
    readonly mode: SourceSyncMode;
    readonly expectations: NormalizedExpectations;
  },
  issues: CompanyConnectorContractIssue[]
): void {
  if (input.run.status !== "succeeded") {
    issues.push(
      issue(input, {
        severity: "error",
        code: "sync_succeeded",
        path: "run.status",
        message: `Connector sync must succeed for contract fixtures; received "${input.run.status}".`
      })
    );
  }

  if (input.run.mode !== input.mode) {
    issues.push(
      issue(input, {
        severity: "error",
        code: "mode_covered",
        path: "run.mode",
        message: `Sync run mode "${input.run.mode}" must match requested mode "${input.mode}".`
      })
    );
  }

  if (input.run.connectorId !== input.registration.connectorId) {
    issues.push(
      issue(input, {
        severity: "error",
        code: "connector_id_matched",
        path: "run.connectorId",
        message: `Sync run connectorId "${input.run.connectorId}" must match registration "${input.registration.connectorId}".`
      })
    );
  }

  if (input.run.sourceId !== input.source.id) {
    issues.push(
      issue(input, {
        severity: "error",
        code: "source_id_matched",
        path: "run.sourceId",
        message: `Sync run sourceId "${input.run.sourceId}" must match profile source "${input.source.id}".`
      })
    );
  }

  if (input.mode === "full" && input.expectations.requireFullComplete && !input.run.complete) {
    issues.push(
      issue(input, {
        severity: "error",
        code: "full_sync_complete",
        path: "run.complete",
        message:
          "Full sync contract fixtures must return complete=true so missing-item tombstones are safe."
      })
    );
  }

  if (
    input.mode === "delta" &&
    input.run.records.length < input.expectations.minDeltaReturnedRecords
  ) {
    issues.push(
      issue(input, {
        severity: "error",
        code: "delta_returned_records",
        path: "run.records",
        message: `Delta sync returned ${input.run.records.length} changed records; expected at least ${input.expectations.minDeltaReturnedRecords}.`
      })
    );
  }
}

function validateConnectorWarnings(
  input: {
    readonly registration: CompanySourceConnectorRegistration;
    readonly source: CorpusSourceConfig;
    readonly run: SourceSyncRunResult;
    readonly mode: SourceSyncMode;
    readonly expectations: NormalizedExpectations;
  },
  issues: CompanyConnectorContractIssue[]
): void {
  input.run.warnings.forEach((warning, index) => {
    if (warning.code === "source_id_mismatch") {
      issues.push(
        issue(input, {
          severity: "error",
          code: "source_id_matched",
          path: `warnings[${index}]`,
          message: warning.message
        })
      );
    }

    if (warning.sourceId !== input.source.id || !warning.code.trim() || !warning.message.trim()) {
      issues.push(
        issue(input, {
          severity: "error",
          code: "connector_warning_shape",
          path: `warnings[${index}]`,
          message:
            "Connector warnings must include the requested source id, a stable code, and a non-empty message."
        })
      );
    }

    if (!input.expectations.allowConnectorWarnings) {
      issues.push(
        issue(input, {
          severity: "error",
          code: "connector_warning_unexpected",
          path: `warnings[${index}]`,
          message: "Connector warnings are not allowed by this contract fixture."
        })
      );
    }

    if (
      input.expectations.forbiddenDiagnosticPatterns.some((pattern) =>
        pattern.test(warning.message)
      )
    ) {
      issues.push(
        issue(input, {
          severity: "error",
          code: "connector_warning_leaks_sensitive_diagnostics",
          path: `warnings[${index}].message`,
          message: "Connector warning message appears to contain sensitive diagnostics."
        })
      );
    }
  });
}

function validateRecords(
  input: {
    readonly registration: CompanySourceConnectorRegistration;
    readonly source: CorpusSourceConfig;
    readonly run: SourceSyncRunResult;
    readonly mode: SourceSyncMode;
    readonly profileNamespaceId: string;
    readonly tenantId: string;
    readonly expectations: NormalizedExpectations;
  },
  issues: CompanyConnectorContractIssue[]
): void {
  input.run.records.forEach((record, index) => {
    if (record.sourceId !== input.source.id) {
      issues.push(
        issue(input, {
          severity: "error",
          code: "records_match_source",
          path: `records[${index}].sourceId`,
          message: `Record "${record.id}" sourceId "${record.sourceId}" must match profile source "${input.source.id}".`
        })
      );
    }

    if (!record.id.trim() || !record.title.trim() || !record.body.trim()) {
      issues.push(
        issue(input, {
          severity: "error",
          code: "records_have_required_fields",
          path: `records[${index}]`,
          message: "Connector records must include stable id, title, and non-empty body."
        })
      );
    }

    validateAccessScope(input, record.accessScope, index, issues);
  });
}

function validateAccessScope(
  input: {
    readonly registration: CompanySourceConnectorRegistration;
    readonly source: CorpusSourceConfig;
    readonly run: SourceSyncRunResult;
    readonly mode: SourceSyncMode;
    readonly profileNamespaceId: string;
    readonly tenantId: string;
    readonly expectations: NormalizedExpectations;
  },
  scope: AccessScope,
  recordIndex: number,
  issues: CompanyConnectorContractIssue[]
): void {
  const hasBoundary =
    nonEmpty(scope.roles) ||
    nonEmpty(scope.tags) ||
    nonEmpty(scope.teamIds) ||
    nonEmpty(scope.userIds);
  const tenantAndNamespaceMatch =
    scope.tenantId === input.tenantId && scope.namespaceId === input.profileNamespaceId;

  if (!tenantAndNamespaceMatch || (input.expectations.requireSafeAccessBoundary && !hasBoundary)) {
    issues.push(
      issue(input, {
        severity: "error",
        code: "records_have_safe_acl",
        path: `records[${recordIndex}].accessScope`,
        message:
          "Connector records must map ACLs into the company tenant, selected namespace, and at least one role/tag/team/user boundary."
      })
    );
  }
}

function validateDeletedItems(
  input: {
    readonly registration: CompanySourceConnectorRegistration;
    readonly source: CorpusSourceConfig;
    readonly run: SourceSyncRunResult;
    readonly mode: SourceSyncMode;
  },
  issues: CompanyConnectorContractIssue[]
): void {
  input.run.deleted.forEach((deleted, index) => {
    if (!deleted.recordId?.trim()) {
      issues.push(
        issue(input, {
          severity: "error",
          code: "delete_tombstones_have_record_id",
          path: `deleted[${index}].recordId`,
          message:
            "Delete tombstones must include a corpus record id so downstream indexes can delete safely."
        })
      );
    }
  });
}

function validateLedger(
  input: {
    readonly registration: CompanySourceConnectorRegistration;
    readonly source: CorpusSourceConfig;
    readonly run: SourceSyncRunResult;
    readonly mode: SourceSyncMode;
    readonly profileNamespaceId: string;
  },
  issues: CompanyConnectorContractIssue[]
): void {
  const ledger = input.run.ledger;
  if (ledger.schemaVersion !== SOURCE_SYNC_LEDGER_SCHEMA_VERSION) {
    issues.push(
      issue(input, {
        severity: "error",
        code: "ledger_schema_matched",
        path: "ledger.schemaVersion",
        message: `Ledger schema version must be ${SOURCE_SYNC_LEDGER_SCHEMA_VERSION}.`
      })
    );
  }

  if (
    ledger.connectorId !== input.registration.connectorId ||
    ledger.sourceId !== input.source.id ||
    ledger.namespaceId !== input.profileNamespaceId
  ) {
    issues.push(
      issue(input, {
        severity: "error",
        code: "ledger_scope_matched",
        path: "ledger",
        message: "Ledger connector, source, and namespace must match the selected company profile."
      })
    );
  }

  validateEvidenceBoundary(input, ledger, issues);
  validateLedgerDoesNotLeakRecordBodies(input, ledger, input.run.records, issues);
  validateLedgerEntries(input, ledger, issues);
  validateDeletedItemsPreserved(input, ledger, input.run.deleted, issues);
}

function validateEvidenceBoundary(
  input: {
    readonly registration: CompanySourceConnectorRegistration;
    readonly source: CorpusSourceConfig;
    readonly run: SourceSyncRunResult;
    readonly mode: SourceSyncMode;
  },
  ledger: SourceSyncLedger,
  issues: CompanyConnectorContractIssue[]
): void {
  const evidenceBoundary = ledger.evidenceBoundary.join("\n").toLowerCase();
  const requiredPhrases = [
    "excludes source bodies",
    "raw credentials",
    "api keys",
    "full principal claims"
  ];

  if (
    ledger.evidenceBoundary.length === 0 ||
    requiredPhrases.some((phrase) => !evidenceBoundary.includes(phrase))
  ) {
    issues.push(
      issue(input, {
        severity: "error",
        code: "ledger_evidence_boundary_safe",
        path: "ledger.evidenceBoundary",
        message:
          "Ledger evidence boundary must explicitly exclude source bodies, raw credentials, API keys, and full principal claims."
      })
    );
  }
}

function validateLedgerDoesNotLeakRecordBodies(
  input: {
    readonly registration: CompanySourceConnectorRegistration;
    readonly source: CorpusSourceConfig;
    readonly run: SourceSyncRunResult;
    readonly mode: SourceSyncMode;
  },
  ledger: SourceSyncLedger,
  records: readonly CorpusRecord[],
  issues: CompanyConnectorContractIssue[]
): void {
  const serializedLedger = JSON.stringify(ledger);
  records.forEach((record, index) => {
    if (record.body.trim().length >= 8 && serializedLedger.includes(record.body)) {
      issues.push(
        issue(input, {
          severity: "error",
          code: "ledger_excludes_record_bodies",
          path: `records[${index}].body`,
          message: `Ledger must not contain raw body text for record "${record.id}".`
        })
      );
    }
  });
}

function validateLedgerEntries(
  input: {
    readonly registration: CompanySourceConnectorRegistration;
    readonly source: CorpusSourceConfig;
    readonly run: SourceSyncRunResult;
    readonly mode: SourceSyncMode;
  },
  ledger: SourceSyncLedger,
  issues: CompanyConnectorContractIssue[]
): void {
  ledger.entries.forEach((entry, index) => {
    if (!entry.sourceItemId.trim()) {
      issues.push(
        issue(input, {
          severity: "error",
          code: "ledger_entries_safe",
          path: `ledger.entries[${index}].sourceItemId`,
          message: "Ledger entries must retain stable source item ids."
        })
      );
    }

    if (entry.status === "active" && (!entry.recordId?.trim() || !entry.contentHash?.trim())) {
      issues.push(
        issue(input, {
          severity: "error",
          code: "ledger_entries_safe",
          path: `ledger.entries[${index}]`,
          message: "Active ledger entries must include record ids and safe content hashes."
        })
      );
    }

    if (entry.status === "deleted" && !entry.recordId?.trim()) {
      issues.push(
        issue(input, {
          severity: "error",
          code: "ledger_entries_safe",
          path: `ledger.entries[${index}].recordId`,
          message: "Deleted ledger entries must keep the corpus record id for delete propagation."
        })
      );
    }
  });
}

function validateDeletedItemsPreserved(
  input: {
    readonly registration: CompanySourceConnectorRegistration;
    readonly source: CorpusSourceConfig;
    readonly run: SourceSyncRunResult;
    readonly mode: SourceSyncMode;
  },
  ledger: SourceSyncLedger,
  deletedItems: readonly SourceSyncDeletedItem[],
  issues: CompanyConnectorContractIssue[]
): void {
  deletedItems.forEach((deleted, index) => {
    if (!deleted.recordId) {
      return;
    }

    const ledgerEntry = ledger.entries.find(
      (entry) =>
        entry.sourceItemId === deleted.sourceItemId &&
        entry.recordId === deleted.recordId &&
        entry.status === "deleted"
    );
    if (!ledgerEntry) {
      issues.push(
        issue(input, {
          severity: "error",
          code: "ledger_tombstones_preserved",
          path: `deleted[${index}]`,
          message: `Deleted item "${deleted.sourceItemId}" must be preserved as a deleted ledger entry.`
        })
      );
    }
  });
}

function issue(
  input: {
    readonly registration: CompanySourceConnectorRegistration;
    readonly source: CorpusSourceConfig;
    readonly mode: SourceSyncMode;
  },
  issueInput: {
    readonly severity: CompanyConnectorContractSeverity;
    readonly code: CompanyConnectorContractIssueCode;
    readonly path: string;
    readonly message: string;
  }
): CompanyConnectorContractIssue {
  return {
    severity: issueInput.severity,
    code: issueInput.code,
    connectorId: input.registration.connectorId,
    sourceId: input.source.id,
    mode: input.mode,
    path: issueInput.path,
    message: issueInput.message
  };
}

function contractRunId(input: {
  readonly requestedAt: string;
  readonly connectorId: string;
  readonly sourceId: string;
  readonly mode: SourceSyncMode;
}): string {
  return [
    "company_connector_contract",
    safeId(input.requestedAt),
    safeId(input.connectorId),
    safeId(input.sourceId),
    input.mode
  ].join("_");
}

function safeId(value: string): string {
  const normalized = value.replace(/[^0-9a-z]+/gi, "_").replace(/^_+|_+$/g, "");
  return normalized.length === 0 ? "unknown" : normalized;
}

function uniqueModes(values: readonly SourceSyncMode[]): readonly SourceSyncMode[] {
  return [...new Set(values)];
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function nonEmpty(values: readonly string[] | undefined): boolean {
  return values !== undefined && values.length > 0;
}

function nonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return resolved;
}
