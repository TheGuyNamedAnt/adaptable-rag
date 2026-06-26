import type { CorpusAdapter } from "../corpus/adapter.js";
import type { CorpusAdapterContractExpectations } from "../corpus/adapter-contract.js";
import { CorpusAdapterRegistry } from "../corpus/adapter-registry.js";
import type { DocumentParseRequest } from "../parsing/parser.js";
import type { DocumentParserContractExpectations } from "../parsing/parser-contract.js";
import type { DocumentParser } from "../parsing/parser.js";
import type { ConnectorAclMapper } from "../security/connector-acl-mapper.js";
import type { SourceConnector } from "../sync/source-connector.js";
import type { CompanyProfile } from "./company-profile.js";

export interface CompanyAdapterPack {
  readonly id: string;
  readonly companyId: string;
  readonly description: string;
  readonly corpusAdapters?: readonly CorpusAdapter[];
  readonly parsers?: readonly DocumentParser[];
  readonly sourceConnectors?: readonly SourceConnector[];
  readonly permissionMappers?: readonly CompanyPermissionMapperRegistration[];
  readonly connectorTests?: readonly CompanyAdapterPackConnectorTest[];
  readonly corpusAdapterTests?: readonly CompanyAdapterPackCorpusAdapterTest[];
  readonly parserTests?: readonly CompanyAdapterPackParserTest[];
}

export interface CompanyPermissionMapperRegistration {
  readonly sourceSystem: string;
  readonly mapper: ConnectorAclMapper;
}

export interface CompanyAdapterPackConnectorTest {
  readonly connectorId: string;
  readonly command: string;
}

export interface CompanyAdapterPackCorpusAdapterTest {
  readonly adapterId: string;
  readonly sourceId?: string;
  readonly expectations?: CorpusAdapterContractExpectations;
}

export interface CompanyAdapterPackParserTest {
  readonly parserId: string;
  readonly request: DocumentParseRequest;
  readonly expectations?: DocumentParserContractExpectations;
}

export type CompanyAdapterPackIssueSeverity = "error" | "warning";

export type CompanyAdapterPackIssueCode =
  | "missing_pack_identity"
  | "company_mismatch"
  | "duplicate_adapter_id"
  | "duplicate_parser_id"
  | "duplicate_source_connector_id"
  | "duplicate_permission_mapper"
  | "declared_adapter_missing"
  | "declared_parser_missing"
  | "declared_source_connector_missing"
  | "registered_adapter_unused"
  | "registered_source_connector_unused"
  | "permission_mapper_missing"
  | "connector_test_missing";

export interface CompanyAdapterPackIssue {
  readonly severity: CompanyAdapterPackIssueSeverity;
  readonly code: CompanyAdapterPackIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface CompanyAdapterPackValidationResult {
  readonly valid: boolean;
  readonly companyId: string;
  readonly packId: string;
  readonly adapterCount: number;
  readonly parserCount: number;
  readonly sourceConnectorCount: number;
  readonly permissionMapperCount: number;
  readonly connectorTestCount: number;
  readonly corpusAdapterTestCount: number;
  readonly parserTestCount: number;
  readonly issues: readonly CompanyAdapterPackIssue[];
  readonly errors: readonly CompanyAdapterPackIssue[];
  readonly warnings: readonly CompanyAdapterPackIssue[];
}

export function validateCompanyAdapterPack(
  company: CompanyProfile,
  pack: CompanyAdapterPack
): CompanyAdapterPackValidationResult {
  const issues: CompanyAdapterPackIssue[] = [];
  validatePackIdentity(company, pack, issues);
  validateAdapterIds(company, pack, issues);
  validateParserIds(pack, issues);
  validateSourceConnectorIds(company, pack, issues);
  validatePermissionMappers(company, pack, issues);
  validateConnectorTests(company, pack, issues);

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");

  return {
    valid: errors.length === 0,
    companyId: company.companyId,
    packId: pack.id,
    adapterCount: pack.corpusAdapters?.length ?? 0,
    parserCount: pack.parsers?.length ?? 0,
    sourceConnectorCount: pack.sourceConnectors?.length ?? 0,
    permissionMapperCount: pack.permissionMappers?.length ?? 0,
    connectorTestCount: pack.connectorTests?.length ?? 0,
    corpusAdapterTestCount: pack.corpusAdapterTests?.length ?? 0,
    parserTestCount: pack.parserTests?.length ?? 0,
    issues,
    errors,
    warnings
  };
}

export function assertCompanyAdapterPack(
  company: CompanyProfile,
  pack: CompanyAdapterPack
): CompanyAdapterPackValidationResult {
  const result = validateCompanyAdapterPack(company, pack);
  if (!result.valid) {
    const details = result.errors.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
    throw new Error(`Company adapter pack "${pack.id}" is invalid:\n${details}`);
  }
  return result;
}

export function createCompanyCorpusAdapterRegistry(
  packs: readonly CompanyAdapterPack[]
): CorpusAdapterRegistry {
  return new CorpusAdapterRegistry(packs.flatMap((pack) => pack.corpusAdapters ?? []));
}

export function companyParsersFromPacks(
  packs: readonly CompanyAdapterPack[]
): readonly DocumentParser[] {
  return packs.flatMap((pack) => pack.parsers ?? []);
}

export function companySourceConnectorsFromPacks(
  packs: readonly CompanyAdapterPack[]
): readonly SourceConnector[] {
  return packs.flatMap((pack) => pack.sourceConnectors ?? []);
}

export function companyPermissionMappersFromPacks(
  packs: readonly CompanyAdapterPack[]
): readonly CompanyPermissionMapperRegistration[] {
  return packs.flatMap((pack) => pack.permissionMappers ?? []);
}

function validatePackIdentity(
  company: CompanyProfile,
  pack: CompanyAdapterPack,
  issues: CompanyAdapterPackIssue[]
): void {
  if (!pack.id.trim() || !pack.companyId.trim() || !pack.description.trim()) {
    issues.push({
      severity: "error",
      code: "missing_pack_identity",
      path: "pack",
      message: "Adapter pack id, companyId, and description are required."
    });
  }

  if (pack.companyId !== company.companyId) {
    issues.push({
      severity: "error",
      code: "company_mismatch",
      path: "companyId",
      message: `Adapter pack companyId "${pack.companyId}" does not match company "${company.companyId}".`
    });
  }
}

function validateAdapterIds(
  company: CompanyProfile,
  pack: CompanyAdapterPack,
  issues: CompanyAdapterPackIssue[]
): void {
  const adapters = pack.corpusAdapters ?? [];
  const adapterIds = adapters.map((adapter) => adapter.id);
  const providedAdapterIds = new Set<string>();

  adapterIds.forEach((adapterId, index) => {
    if (providedAdapterIds.has(adapterId)) {
      issues.push({
        severity: "error",
        code: "duplicate_adapter_id",
        path: `corpusAdapters[${index}].id`,
        message: `Duplicate adapter id "${adapterId}" in adapter pack "${pack.id}".`
      });
    }
    providedAdapterIds.add(adapterId);
  });

  providedAdapterIds.forEach((adapterId) => {
    if (!declaredAdapterIds(company).has(adapterId)) {
      issues.push({
        severity: "warning",
        code: "registered_adapter_unused",
        path: "corpusAdapters",
        message: `Adapter "${adapterId}" is provided by pack "${pack.id}" but no company use case declares it.`
      });
    }
  });
}

function validateParserIds(pack: CompanyAdapterPack, issues: CompanyAdapterPackIssue[]): void {
  const seen = new Set<string>();
  (pack.parsers ?? []).forEach((parser, index) => {
    if (seen.has(parser.id)) {
      issues.push({
        severity: "error",
        code: "duplicate_parser_id",
        path: `parsers[${index}].id`,
        message: `Duplicate parser id "${parser.id}" in adapter pack "${pack.id}".`
      });
    }
    seen.add(parser.id);
  });
}

function validateSourceConnectorIds(
  company: CompanyProfile,
  pack: CompanyAdapterPack,
  issues: CompanyAdapterPackIssue[]
): void {
  const declaredConnectorIds = new Set((company.connectors ?? []).map((connector) => connector.id));
  const seen = new Set<string>();
  (pack.sourceConnectors ?? []).forEach((connector, index) => {
    if (seen.has(connector.id)) {
      issues.push({
        severity: "error",
        code: "duplicate_source_connector_id",
        path: `sourceConnectors[${index}].id`,
        message: `Duplicate source connector id "${connector.id}" in adapter pack "${pack.id}".`
      });
    }
    seen.add(connector.id);

    if (!declaredConnectorIds.has(connector.id)) {
      issues.push({
        severity: "warning",
        code: "registered_source_connector_unused",
        path: `sourceConnectors[${index}].id`,
        message: `Source connector "${connector.id}" is provided by pack "${pack.id}" but no company connector declares it.`
      });
    }
  });
}

function validatePermissionMappers(
  company: CompanyProfile,
  pack: CompanyAdapterPack,
  issues: CompanyAdapterPackIssue[]
): void {
  const seenSourceSystems = new Set<string>();
  const seenMapperIds = new Set<string>();
  (pack.permissionMappers ?? []).forEach((registration, index) => {
    const sourceSystem = registration.sourceSystem;
    const mapperId = registration.mapper.id;

    if (seenSourceSystems.has(sourceSystem) || seenMapperIds.has(mapperId)) {
      issues.push({
        severity: "error",
        code: "duplicate_permission_mapper",
        path: `permissionMappers[${index}]`,
        message: `Duplicate permission mapper sourceSystem "${sourceSystem}" or mapper id "${mapperId}" in adapter pack "${pack.id}".`
      });
    }
    seenSourceSystems.add(sourceSystem);
    seenMapperIds.add(mapperId);
  });

  void company;
}

function validateConnectorTests(
  company: CompanyProfile,
  pack: CompanyAdapterPack,
  issues: CompanyAdapterPackIssue[]
): void {
  const testsByConnectorId = new Map(
    (pack.connectorTests ?? []).map((test) => [test.connectorId, test.command])
  );

  (company.connectors ?? []).forEach((connector, index) => {
    if (connector.contractTestCommand?.trim()) {
      return;
    }

    const packCommand = testsByConnectorId.get(connector.id);
    if (!packCommand?.trim()) {
      issues.push({
        severity: "warning",
        code: "connector_test_missing",
        path: `connectors[${index}].contractTestCommand`,
        message: `Connector "${connector.id}" should have a contract test command in the company profile or adapter pack.`
      });
    }
  });
}

function declaredAdapterIds(company: CompanyProfile): ReadonlySet<string> {
  return new Set(
    company.useCases.flatMap((useCase) => useCase.corpusSources.map((source) => source.adapter))
  );
}
