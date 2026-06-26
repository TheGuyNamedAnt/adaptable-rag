import type {
  CorpusAdapterContractExpectations,
  CorpusAdapterContractIssue,
  CorpusAdapterContractResult
} from "../corpus/adapter-contract.js";
import { validateCorpusAdapterContract } from "../corpus/adapter-contract.js";
import type {
  DocumentParserContractExpectations,
  DocumentParserContractIssue,
  DocumentParserContractResult
} from "../parsing/parser-contract.js";
import { validateDocumentParserContract } from "../parsing/parser-contract.js";
import type { RequestPrincipal, AccessScope } from "../security/access-scope.js";
import type { ConnectorAclMapper } from "../security/connector-acl-mapper.js";
import type { SourceSyncMode } from "../sync/source-connector.js";
import type {
  CompanyAdapterPackCorpusAdapterTest,
  CompanyAdapterPackIssue,
  CompanyAdapterPackParserTest
} from "./company-adapter-pack.js";
import type { CompanyDeploymentRegistry } from "./company-deployment-registry.js";
import {
  runCompanyConnectorContractTests,
  type CompanyConnectorContractExpectations,
  type CompanyConnectorContractReport
} from "./company-connector-contract.js";
import {
  assembleCompanyRuntime,
  type CompanyRuntimeAssembly,
  type CompanyRuntimeAssemblyRequest,
  type CompanySourceConnectorRegistration
} from "./company-runtime-assembly.js";

export type CompanyPackContractStatus = "passed" | "failed";
export type CompanyPackContractSeverity = "error" | "warning";

export type CompanyPackContractIssueCode =
  | "pack_coverage_warning"
  | "adapter_contract_failed"
  | "adapter_contract_missing"
  | "parser_contract_failed"
  | "parser_contract_fixture_missing"
  | "connector_contract_failed"
  | "permission_mapper_threw"
  | "permission_mapper_scope_invalid";

export type CompanyPackContractArea =
  | "pack_coverage"
  | "corpus_adapter"
  | "parser"
  | "source_connector"
  | "permission_mapper";

export interface CompanyPackContractIssue {
  readonly severity: CompanyPackContractSeverity;
  readonly code: CompanyPackContractIssueCode;
  readonly area: CompanyPackContractArea;
  readonly subjectId: string;
  readonly path: string;
  readonly message: string;
  readonly upstreamCode?: string;
}

export interface CompanyPackContractExpectations {
  readonly corpusAdapter?: CorpusAdapterContractExpectations;
  readonly parser?: DocumentParserContractExpectations;
  readonly connector?: CompanyConnectorContractExpectations;
  readonly permissionMapperNativeAcl?: unknown;
}

export interface CompanyPackContractRunnerOptions {
  readonly registry: CompanyDeploymentRegistry;
  readonly company: CompanyRuntimeAssemblyRequest;
  readonly requestedBy: RequestPrincipal;
  readonly modes?: readonly SourceSyncMode[];
  readonly requestedAt?: string;
  readonly now?: () => string;
  readonly expectations?: CompanyPackContractExpectations;
}

export interface CompanyCorpusAdapterPackContractResult {
  readonly status: CompanyPackContractStatus;
  readonly adapterId: string;
  readonly sourceId: string;
  readonly loadedRecordCount: number;
  readonly acceptedDocumentCount: number;
  readonly rejectedRecordCount: number;
  readonly issueCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly result?: CorpusAdapterContractResult;
}

export interface CompanyParserPackContractResult {
  readonly status: CompanyPackContractStatus;
  readonly parserId: string;
  readonly sourceId: string;
  readonly bodyLength: number;
  readonly warningCount: number;
  readonly layoutIssueCount: number;
  readonly issueCount: number;
  readonly errorCount: number;
  readonly result?: DocumentParserContractResult;
}

export interface CompanyPermissionMapperPackContractResult {
  readonly status: CompanyPackContractStatus;
  readonly mapperId: string;
  readonly sourceSystem: string;
  readonly connectorId: string;
  readonly sourceId: string;
  readonly scope?: AccessScope;
  readonly issues: readonly CompanyPackContractIssue[];
}

export interface CompanyPackContractReport {
  readonly status: CompanyPackContractStatus;
  readonly companyId: string;
  readonly useCaseId: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly requestedAt: string;
  readonly checkedAdapterCount: number;
  readonly checkedParserCount: number;
  readonly checkedConnectorCount: number;
  readonly checkedPermissionMapperCount: number;
  readonly checkedCaseCount: number;
  readonly adapterContracts: readonly CompanyCorpusAdapterPackContractResult[];
  readonly parserContracts: readonly CompanyParserPackContractResult[];
  readonly connectorContracts: CompanyConnectorContractReport;
  readonly permissionMapperContracts: readonly CompanyPermissionMapperPackContractResult[];
  readonly issues: readonly CompanyPackContractIssue[];
  readonly errors: readonly CompanyPackContractIssue[];
  readonly warnings: readonly CompanyPackContractIssue[];
}

export class CompanyPackContractError extends Error {
  readonly report: CompanyPackContractReport;

  constructor(report: CompanyPackContractReport) {
    super(
      `Company pack contract failed for "${report.companyId}.${report.useCaseId}": ${report.errors
        .map((issue) => issue.message)
        .join("; ")}`
    );
    this.name = "CompanyPackContractError";
    this.report = report;
  }
}

export async function assertCompanyPackContractTests(
  options: CompanyPackContractRunnerOptions
): Promise<CompanyPackContractReport> {
  const report = await runCompanyPackContractTests(options);
  if (report.errors.length > 0) {
    throw new CompanyPackContractError(report);
  }

  return report;
}

export async function runCompanyPackContractTests(
  options: CompanyPackContractRunnerOptions
): Promise<CompanyPackContractReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const requestedAt = options.requestedAt ?? now();
  const assembly = assembleCompanyRuntime(options.registry, options.company);
  const entry = options.registry.getCompanyRequired(assembly.resolution.company.companyId);
  const coverageIssues = coverageContractIssues(entry.adapterPackCoverageReport?.issues ?? []);
  const adapterContracts = await runAdapterContracts({
    assembly,
    adapterTests: entry.adapterPacks.flatMap((pack) => pack.corpusAdapterTests ?? []),
    requestedBy: options.requestedBy,
    requestedAt,
    ...(options.expectations?.corpusAdapter === undefined
      ? {}
      : { expectations: options.expectations.corpusAdapter })
  });
  const parserContracts = await runParserContracts({
    assembly,
    parserTests: entry.adapterPacks.flatMap((pack) => pack.parserTests ?? []),
    requestedAt,
    ...(options.expectations?.parser === undefined
      ? {}
      : { expectations: options.expectations.parser })
  });
  const connectorContracts = await runCompanyConnectorContractTests({
    registry: options.registry,
    company: options.company,
    requestedBy: options.requestedBy,
    ...(options.modes === undefined ? {} : { modes: options.modes }),
    requestedAt,
    now,
    ...(options.expectations?.connector === undefined
      ? {}
      : { expectations: options.expectations.connector })
  });
  const permissionMapperContracts = runPermissionMapperContracts({
    assembly,
    requestedBy: options.requestedBy,
    nativeAcl: options.expectations?.permissionMapperNativeAcl ?? {}
  });
  const issues = [
    ...coverageIssues,
    ...adapterContracts.flatMap((contract) =>
      contract.result === undefined
        ? [
            issue({
              severity: "error",
              code: "adapter_contract_missing",
              area: "corpus_adapter",
              subjectId: contract.adapterId,
              path: "adapterPacks[].corpusAdapters",
              message: `Source "${contract.sourceId}" declares adapter "${contract.adapterId}", but no selected adapter pack registered it.`
            })
          ]
        : adapterContractIssues(contract.result.issues, contract.adapterId, contract.sourceId)
    ),
    ...parserContracts.flatMap((contract) =>
      contract.result === undefined
        ? [
            issue({
              severity: "error",
              code: "parser_contract_fixture_missing",
              area: "parser",
              subjectId: contract.parserId,
              path: "adapterPacks[].parserTests",
              message: `Parser "${contract.parserId}" is registered for this use case but has no parser contract fixture.`
            })
          ]
        : parserContractIssues(contract.result.issues, contract.parserId, contract.sourceId)
    ),
    ...connectorContractIssues(connectorContracts),
    ...permissionMapperContracts.flatMap((contract) => contract.issues)
  ];
  const errors = issues.filter((contractIssue) => contractIssue.severity === "error");
  const warnings = issues.filter((contractIssue) => contractIssue.severity === "warning");

  return {
    status: errors.length === 0 ? "passed" : "failed",
    companyId: assembly.resolution.company.companyId,
    useCaseId: assembly.resolution.useCaseId,
    profileId: assembly.resolution.profile.id,
    namespaceId: assembly.resolution.profile.namespaceId,
    requestedAt,
    checkedAdapterCount: adapterContracts.length,
    checkedParserCount: parserContracts.length,
    checkedConnectorCount: connectorContracts.checkedConnectorCount,
    checkedPermissionMapperCount: permissionMapperContracts.length,
    checkedCaseCount:
      adapterContracts.length +
      parserContracts.length +
      connectorContracts.checkedCaseCount +
      permissionMapperContracts.length,
    adapterContracts,
    parserContracts,
    connectorContracts,
    permissionMapperContracts,
    issues,
    errors,
    warnings
  };
}

async function runAdapterContracts(input: {
  readonly assembly: CompanyRuntimeAssembly;
  readonly adapterTests: readonly CompanyAdapterPackCorpusAdapterTest[];
  readonly requestedBy: RequestPrincipal;
  readonly requestedAt: string;
  readonly expectations?: CorpusAdapterContractExpectations;
}): Promise<readonly CompanyCorpusAdapterPackContractResult[]> {
  const adaptersById = new Map(
    input.assembly.corpusAdapterExtensions.map((extension) => [
      extension.adapter.id,
      extension.adapter
    ])
  );
  const results: CompanyCorpusAdapterPackContractResult[] = [];

  for (const source of input.assembly.resolution.profile.corpusSources) {
    const adapter = adaptersById.get(source.adapter);
    if (!adapter) {
      results.push({
        status: "failed",
        adapterId: source.adapter,
        sourceId: source.id,
        loadedRecordCount: 0,
        acceptedDocumentCount: 0,
        rejectedRecordCount: 0,
        issueCount: 1,
        errorCount: 1,
        warningCount: 0
      });
      continue;
    }

    const expectations = adapterExpectations(
      input.adapterTests,
      adapter.id,
      source.id,
      input.expectations
    );
    const result = await validateCorpusAdapterContract({
      adapter,
      profile: input.assembly.resolution.profile,
      source,
      requestedBy: input.requestedBy,
      runId: `company_pack_adapter_contract_${source.id}`,
      requestedAt: input.requestedAt,
      ...(expectations === undefined ? {} : { expectations })
    });
    const errorCount = result.issues.filter(
      (contractIssue) => contractIssue.severity === "error"
    ).length;
    const warningCount = result.issues.filter(
      (contractIssue) => contractIssue.severity === "warning"
    ).length;

    results.push({
      status: errorCount === 0 ? "passed" : "failed",
      adapterId: result.adapterId,
      sourceId: result.sourceId,
      loadedRecordCount: result.loadedRecordCount,
      acceptedDocumentCount: result.acceptedDocumentCount,
      rejectedRecordCount: result.rejectedRecordCount,
      issueCount: result.issues.length,
      errorCount,
      warningCount,
      result
    });
  }

  return results;
}

function adapterExpectations(
  adapterTests: readonly CompanyAdapterPackCorpusAdapterTest[],
  adapterId: string,
  sourceId: string,
  fallback: CorpusAdapterContractExpectations | undefined
): CorpusAdapterContractExpectations | undefined {
  const exactMatch = adapterTests.find(
    (test) => test.adapterId === adapterId && test.sourceId === sourceId
  );
  if (exactMatch?.expectations !== undefined) {
    return exactMatch.expectations;
  }

  const adapterMatch = adapterTests.find(
    (test) => test.adapterId === adapterId && test.sourceId === undefined
  );
  return adapterMatch?.expectations ?? fallback;
}

async function runParserContracts(input: {
  readonly assembly: CompanyRuntimeAssembly;
  readonly parserTests: readonly CompanyAdapterPackParserTest[];
  readonly requestedAt: string;
  readonly expectations?: DocumentParserContractExpectations;
}): Promise<readonly CompanyParserPackContractResult[]> {
  const results: CompanyParserPackContractResult[] = [];

  for (const extension of input.assembly.parserExtensions) {
    const tests = input.parserTests.filter((test) => test.parserId === extension.parser.id);
    if (tests.length === 0) {
      results.push({
        status: "failed",
        parserId: extension.parser.id,
        sourceId: "",
        bodyLength: 0,
        warningCount: 0,
        layoutIssueCount: 0,
        issueCount: 1,
        errorCount: 1
      });
      continue;
    }

    for (const test of tests) {
      const expectations = test.expectations ?? input.expectations;
      const result = await validateDocumentParserContract({
        parser: extension.parser,
        request: {
          ...test.request,
          requestedAt: test.request.requestedAt || input.requestedAt
        },
        ...(expectations === undefined ? {} : { expectations })
      });
      const errorCount = result.issues.filter(
        (contractIssue) => contractIssue.severity === "error"
      ).length;

      results.push({
        status: errorCount === 0 ? "passed" : "failed",
        parserId: result.parserId,
        sourceId: result.sourceId,
        bodyLength: result.bodyLength,
        warningCount: result.warningCount,
        layoutIssueCount: result.layoutIssueCount,
        issueCount: result.issues.length,
        errorCount,
        result
      });
    }
  }

  return results;
}

function runPermissionMapperContracts(input: {
  readonly assembly: CompanyRuntimeAssembly;
  readonly requestedBy: RequestPrincipal;
  readonly nativeAcl: unknown;
}): readonly CompanyPermissionMapperPackContractResult[] {
  return input.assembly.sourceConnectorRegistrations.flatMap((registration) => {
    if (!registration.permissionMapper) {
      return [];
    }

    return registration.sourceIds.map((sourceId) =>
      runPermissionMapperContract({
        assembly: input.assembly,
        registration,
        sourceId,
        mapper: registration.permissionMapper!,
        requestedBy: input.requestedBy,
        nativeAcl: input.nativeAcl
      })
    );
  });
}

function runPermissionMapperContract(input: {
  readonly assembly: CompanyRuntimeAssembly;
  readonly registration: CompanySourceConnectorRegistration;
  readonly sourceId: string;
  readonly mapper: ConnectorAclMapper;
  readonly requestedBy: RequestPrincipal;
  readonly nativeAcl: unknown;
}): CompanyPermissionMapperPackContractResult {
  const source = input.assembly.resolution.profile.corpusSources.find(
    (candidate) => candidate.id === input.sourceId
  );
  const mapperIssues: CompanyPackContractIssue[] = [];
  let scope: AccessScope | undefined;

  try {
    scope = input.mapper.map({
      nativeAcl: input.nativeAcl,
      context: {
        source: source ?? {
          id: input.sourceId,
          adapter: input.registration.adapterId,
          description: input.sourceId,
          enabled: true
        },
        requestedBy: input.requestedBy,
        defaultTenantId: input.assembly.resolution.company.defaultTenantId,
        defaultNamespaceId: input.assembly.resolution.profile.namespaceId,
        defaultTags: source?.tags ?? []
      }
    });
  } catch (error) {
    mapperIssues.push(
      issue({
        severity: "error",
        code: "permission_mapper_threw",
        area: "permission_mapper",
        subjectId: input.mapper.id,
        path: "permissionMapper.map",
        message: `Permission mapper "${input.mapper.id}" must return an access scope instead of throwing: ${errorName(error)}.`
      })
    );
  }

  if (scope) {
    if (
      !scope.tenantId.trim() ||
      scope.tenantId !== input.assembly.resolution.company.defaultTenantId
    ) {
      mapperIssues.push(
        issue({
          severity: "error",
          code: "permission_mapper_scope_invalid",
          area: "permission_mapper",
          subjectId: input.mapper.id,
          path: "permissionMapper.map.tenantId",
          message: `Permission mapper "${input.mapper.id}" must map to tenant "${input.assembly.resolution.company.defaultTenantId}".`
        })
      );
    }

    if (
      !scope.namespaceId.trim() ||
      scope.namespaceId !== input.assembly.resolution.profile.namespaceId
    ) {
      mapperIssues.push(
        issue({
          severity: "error",
          code: "permission_mapper_scope_invalid",
          area: "permission_mapper",
          subjectId: input.mapper.id,
          path: "permissionMapper.map.namespaceId",
          message: `Permission mapper "${input.mapper.id}" must map to namespace "${input.assembly.resolution.profile.namespaceId}".`
        })
      );
    }
  }

  return {
    status: mapperIssues.some((contractIssue) => contractIssue.severity === "error")
      ? "failed"
      : "passed",
    mapperId: input.mapper.id,
    sourceSystem: input.registration.sourceSystem,
    connectorId: input.registration.connectorId,
    sourceId: input.sourceId,
    ...(scope === undefined ? {} : { scope }),
    issues: mapperIssues
  };
}

function coverageContractIssues(
  coverageIssues: readonly CompanyAdapterPackIssue[]
): readonly CompanyPackContractIssue[] {
  return coverageIssues.map((coverageIssue) =>
    issue({
      severity: coverageIssue.severity,
      code: "pack_coverage_warning",
      area: "pack_coverage",
      subjectId: "adapterPacks",
      path: coverageIssue.path,
      message: coverageIssue.message,
      upstreamCode: coverageIssue.code
    })
  );
}

function adapterContractIssues(
  contractIssues: readonly CorpusAdapterContractIssue[],
  adapterId: string,
  sourceId: string
): readonly CompanyPackContractIssue[] {
  if (contractIssues.length === 0) {
    return [];
  }

  return contractIssues.map((contractIssue) =>
    issue({
      severity: contractIssue.severity,
      code: "adapter_contract_failed",
      area: "corpus_adapter",
      subjectId: adapterId,
      path: contractIssue.path,
      message: `Adapter "${adapterId}" failed contract for source "${sourceId}": ${contractIssue.message}`,
      upstreamCode: contractIssue.code
    })
  );
}

function parserContractIssues(
  contractIssues: readonly DocumentParserContractIssue[],
  parserId: string,
  sourceId: string
): readonly CompanyPackContractIssue[] {
  return contractIssues.map((contractIssue) =>
    issue({
      severity: contractIssue.severity,
      code: "parser_contract_failed",
      area: "parser",
      subjectId: parserId,
      path: contractIssue.path,
      message: `Parser "${parserId}" failed contract for source "${sourceId}": ${contractIssue.message}`,
      upstreamCode: contractIssue.code
    })
  );
}

function connectorContractIssues(
  report: CompanyConnectorContractReport
): readonly CompanyPackContractIssue[] {
  return report.issues.map((contractIssue) =>
    issue({
      severity: contractIssue.severity,
      code: "connector_contract_failed",
      area: "source_connector",
      subjectId: contractIssue.connectorId,
      path: contractIssue.path,
      message: `Connector "${contractIssue.connectorId}" failed contract for source "${contractIssue.sourceId}": ${contractIssue.message}`,
      upstreamCode: contractIssue.code
    })
  );
}

function issue(input: CompanyPackContractIssue): CompanyPackContractIssue {
  return input;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}
