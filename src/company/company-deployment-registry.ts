import type { ValidatedRagProfile } from "../profiles/profile-validation.js";
import {
  assertCompanyAdapterPack,
  type CompanyAdapterPack,
  type CompanyAdapterPackIssue,
  type CompanyAdapterPackValidationResult
} from "./company-adapter-pack.js";
import {
  assertCompanyDeploymentReady,
  type CompanyProfile,
  type ValidatedCompanyDeployment
} from "./company-profile.js";

export interface CompanyDeploymentRegistryLookup {
  readonly companyId?: string;
  readonly useCaseId?: string;
  readonly namespaceId?: string;
  readonly profileId?: string;
}

export interface CompanyDeploymentRegistryEntry {
  readonly company: CompanyProfile;
  readonly deployment: ValidatedCompanyDeployment;
  readonly adapterPacks: readonly CompanyAdapterPack[];
  readonly adapterPackReports: readonly CompanyAdapterPackValidationResult[];
  readonly adapterPackCoverageReport?: CompanyAdapterPackValidationResult;
  readonly profilesByUseCaseId: ReadonlyMap<string, ValidatedRagProfile>;
}

export interface CompanyDeploymentRegistryRegistration {
  readonly company: CompanyProfile;
  readonly adapterPacks?: readonly CompanyAdapterPack[];
}

export interface CompanyDeploymentProfileResolution {
  readonly company: CompanyProfile;
  readonly deployment: ValidatedCompanyDeployment;
  readonly useCaseId: string;
  readonly profile: ValidatedRagProfile;
}

export class CompanyDeploymentRegistry {
  private readonly entries = new Map<string, CompanyDeploymentRegistryEntry>();
  private readonly profileIndex = new Map<string, CompanyDeploymentProfileResolution>();
  private readonly namespaceIndex = new Map<string, CompanyDeploymentProfileResolution>();

  constructor(companies: readonly (CompanyProfile | CompanyDeploymentRegistryRegistration)[] = []) {
    companies.forEach((input) => this.register(input));
  }

  register(input: CompanyProfile | CompanyDeploymentRegistryRegistration): void {
    const company = isRegistration(input) ? input.company : input;
    const adapterPacks = isRegistration(input) ? (input.adapterPacks ?? []) : [];
    if (this.entries.has(company.companyId)) {
      throw new Error(`Duplicate company deployment id "${company.companyId}".`);
    }

    const deployment = assertCompanyDeploymentReady(company);
    const adapterPackReports = adapterPacks.map((pack) => assertCompanyAdapterPack(company, pack));
    const adapterPackCoverageReport =
      adapterPacks.length > 0 ? assertAdapterPackCoverage(company, adapterPacks) : undefined;
    const profilesByUseCaseId = new Map<string, ValidatedRagProfile>();

    company.useCases.forEach((useCase) => {
      const profile = deployment.profiles.find(
        (candidate) => candidate.id === `${company.companyId}.${useCase.id}`
      );
      if (!profile) {
        throw new Error(
          `Company deployment "${company.companyId}" did not produce profile for use case "${useCase.id}".`
        );
      }
      profilesByUseCaseId.set(useCase.id, profile);
    });

    const entry: CompanyDeploymentRegistryEntry = {
      company,
      deployment,
      adapterPacks,
      adapterPackReports,
      ...(adapterPackCoverageReport === undefined ? {} : { adapterPackCoverageReport }),
      profilesByUseCaseId
    };

    for (const [useCaseId, profile] of profilesByUseCaseId.entries()) {
      const resolution: CompanyDeploymentProfileResolution = {
        company,
        deployment,
        useCaseId,
        profile
      };
      addUniqueProfileResolution(this.profileIndex, profile.id, resolution, "profile id");
      addUniqueProfileResolution(
        this.namespaceIndex,
        profile.namespaceId,
        resolution,
        "namespaceId"
      );
    }

    this.entries.set(company.companyId, entry);
  }

  getCompany(companyId: string): CompanyDeploymentRegistryEntry | undefined {
    return this.entries.get(companyId);
  }

  getCompanyRequired(companyId: string): CompanyDeploymentRegistryEntry {
    const entry = this.getCompany(companyId);
    if (!entry) {
      throw new Error(`Company deployment "${companyId}" is not registered.`);
    }
    return entry;
  }

  resolveProfile(
    lookup: CompanyDeploymentRegistryLookup
  ): CompanyDeploymentProfileResolution | undefined {
    if (lookup.profileId !== undefined) {
      return this.profileIndex.get(lookup.profileId);
    }

    if (lookup.companyId !== undefined && lookup.useCaseId !== undefined) {
      const entry = this.entries.get(lookup.companyId);
      const profile = entry?.profilesByUseCaseId.get(lookup.useCaseId);
      if (!entry || !profile) {
        return undefined;
      }
      return {
        company: entry.company,
        deployment: entry.deployment,
        useCaseId: lookup.useCaseId,
        profile
      };
    }

    if (lookup.namespaceId !== undefined) {
      return this.namespaceIndex.get(lookup.namespaceId);
    }

    return undefined;
  }

  resolveProfileRequired(
    lookup: CompanyDeploymentRegistryLookup
  ): CompanyDeploymentProfileResolution {
    const resolution = this.resolveProfile(lookup);
    if (!resolution) {
      throw new Error(`Company RAG profile lookup failed: ${lookupDescription(lookup)}.`);
    }
    return resolution;
  }

  listCompanies(): readonly CompanyDeploymentRegistryEntry[] {
    return [...this.entries.values()];
  }

  listProfiles(): readonly CompanyDeploymentProfileResolution[] {
    return [...this.profileIndex.values()];
  }
}

function assertAdapterPackCoverage(
  company: CompanyProfile,
  adapterPacks: readonly CompanyAdapterPack[]
): CompanyAdapterPackValidationResult {
  const issues: CompanyAdapterPackIssue[] = [];
  const adapterOccurrences = adapterPacks.flatMap((pack, packIndex) =>
    (pack.corpusAdapters ?? []).map((adapter, adapterIndex) => ({
      id: adapter.id,
      packId: pack.id,
      path: `adapterPacks[${packIndex}].corpusAdapters[${adapterIndex}].id`
    }))
  );
  const connectorOccurrences = adapterPacks.flatMap((pack, packIndex) =>
    (pack.sourceConnectors ?? []).map((connector, connectorIndex) => ({
      id: connector.id,
      packId: pack.id,
      path: `adapterPacks[${packIndex}].sourceConnectors[${connectorIndex}].id`
    }))
  );
  const parserOccurrences = adapterPacks.flatMap((pack, packIndex) =>
    (pack.parsers ?? []).map((parser, parserIndex) => ({
      id: parser.id,
      packId: pack.id,
      path: `adapterPacks[${packIndex}].parsers[${parserIndex}].id`
    }))
  );
  const permissionSourceSystemOccurrences = adapterPacks.flatMap((pack, packIndex) =>
    (pack.permissionMappers ?? []).map((registration, mapperIndex) => ({
      id: registration.sourceSystem,
      packId: pack.id,
      path: `adapterPacks[${packIndex}].permissionMappers[${mapperIndex}].sourceSystem`
    }))
  );
  const permissionMapperIdOccurrences = adapterPacks.flatMap((pack, packIndex) =>
    (pack.permissionMappers ?? []).map((registration, mapperIndex) => ({
      id: registration.mapper.id,
      packId: pack.id,
      path: `adapterPacks[${packIndex}].permissionMappers[${mapperIndex}].mapper.id`
    }))
  );
  const providedAdapterIds = new Set(adapterOccurrences.map((occurrence) => occurrence.id));
  const providedConnectorIds = new Set(connectorOccurrences.map((occurrence) => occurrence.id));
  const providedParserIds = new Set(parserOccurrences.map((occurrence) => occurrence.id));
  const providedPermissionSourceSystems = new Set(
    permissionSourceSystemOccurrences.map((occurrence) => occurrence.id)
  );

  addDuplicateCoverageIssues(adapterOccurrences, issues, {
    code: "duplicate_adapter_id",
    path: "adapterPacks[].corpusAdapters",
    label: "Corpus adapter id"
  });
  addDuplicateCoverageIssues(parserOccurrences, issues, {
    code: "duplicate_parser_id",
    path: "adapterPacks[].parsers",
    label: "Parser id"
  });
  addDuplicateCoverageIssues(connectorOccurrences, issues, {
    code: "duplicate_source_connector_id",
    path: "adapterPacks[].sourceConnectors",
    label: "Source connector id"
  });
  addDuplicateCoverageIssues(permissionSourceSystemOccurrences, issues, {
    code: "duplicate_permission_mapper",
    path: "adapterPacks[].permissionMappers.sourceSystem",
    label: "Permission mapper sourceSystem"
  });
  addDuplicateCoverageIssues(permissionMapperIdOccurrences, issues, {
    code: "duplicate_permission_mapper",
    path: "adapterPacks[].permissionMappers.mapper.id",
    label: "Permission mapper id"
  });

  for (const adapterId of declaredAdapterIds(company)) {
    if (!providedAdapterIds.has(adapterId)) {
      issues.push({
        severity: "error",
        code: "declared_adapter_missing",
        path: "adapterPacks[].corpusAdapters",
        message: `Profile source declares adapter "${adapterId}", but no company adapter pack provides it.`
      });
    }
  }

  for (const parserId of declaredParserIds(company)) {
    if (!providedParserIds.has(parserId)) {
      issues.push({
        severity: "error",
        code: "declared_parser_missing",
        path: "adapterPacks[].parsers",
        message: `Company use case declares parser "${parserId}", but no company adapter pack provides it.`
      });
    }
  }

  for (const connectorId of declaredConnectorIds(company)) {
    if (!providedConnectorIds.has(connectorId)) {
      issues.push({
        severity: "warning",
        code: "declared_source_connector_missing",
        path: "adapterPacks[].sourceConnectors",
        message: `Company connector "${connectorId}" is declared, but no adapter pack provides a live SourceConnector for production sync.`
      });
    }
  }

  const permissionSourceSystem = company.permissionMapping?.sourceSystem;
  if (permissionSourceSystem && !providedPermissionSourceSystems.has(permissionSourceSystem)) {
    issues.push({
      severity: "warning",
      code: "permission_mapper_missing",
      path: "adapterPacks[].permissionMappers",
      message: `Company permissionMapping declares sourceSystem "${permissionSourceSystem}", but no adapter pack provides a ConnectorAclMapper registration for it.`
    });
  }

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const result: CompanyAdapterPackValidationResult = {
    valid: errors.length === 0,
    companyId: company.companyId,
    packId: "__adapter_pack_coverage__",
    adapterCount: adapterOccurrences.length,
    parserCount: parserOccurrences.length,
    sourceConnectorCount: connectorOccurrences.length,
    permissionMapperCount: permissionSourceSystemOccurrences.length,
    connectorTestCount: adapterPacks.reduce(
      (count, pack) => count + (pack.connectorTests?.length ?? 0),
      0
    ),
    corpusAdapterTestCount: adapterPacks.reduce(
      (count, pack) => count + (pack.corpusAdapterTests?.length ?? 0),
      0
    ),
    parserTestCount: adapterPacks.reduce(
      (count, pack) => count + (pack.parserTests?.length ?? 0),
      0
    ),
    issues,
    errors,
    warnings
  };

  if (errors.length > 0) {
    const details = errors.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
    throw new Error(`Company adapter packs for "${company.companyId}" are incomplete:\n${details}`);
  }

  return result;
}

interface AdapterPackIdOccurrence {
  readonly id: string;
  readonly packId: string;
  readonly path: string;
}

function addDuplicateCoverageIssues(
  occurrences: readonly AdapterPackIdOccurrence[],
  issues: CompanyAdapterPackIssue[],
  input: {
    readonly code: CompanyAdapterPackIssue["code"];
    readonly path: string;
    readonly label: string;
  }
): void {
  const byId = new Map<string, AdapterPackIdOccurrence[]>();
  for (const occurrence of occurrences) {
    byId.set(occurrence.id, [...(byId.get(occurrence.id) ?? []), occurrence]);
  }

  for (const [id, matches] of byId.entries()) {
    if (matches.length <= 1) {
      continue;
    }

    issues.push({
      severity: "error",
      code: input.code,
      path: input.path,
      message: `${input.label} "${id}" is provided by multiple adapter packs: ${matches
        .map((match) => `${match.packId} at ${match.path}`)
        .join(", ")}.`
    });
  }
}

function declaredAdapterIds(company: CompanyProfile): readonly string[] {
  return [
    ...new Set(
      company.useCases.flatMap((useCase) => useCase.corpusSources.map((source) => source.adapter))
    )
  ];
}

function declaredConnectorIds(company: CompanyProfile): readonly string[] {
  return [...new Set((company.connectors ?? []).map((connector) => connector.id))];
}

function declaredParserIds(company: CompanyProfile): readonly string[] {
  return [...new Set(company.useCases.flatMap((useCase) => useCase.parserIds ?? []))];
}

function isRegistration(
  input: CompanyProfile | CompanyDeploymentRegistryRegistration
): input is CompanyDeploymentRegistryRegistration {
  return "company" in input;
}

function addUniqueProfileResolution(
  index: Map<string, CompanyDeploymentProfileResolution>,
  key: string,
  resolution: CompanyDeploymentProfileResolution,
  label: string
): void {
  const existing = index.get(key);
  if (existing) {
    throw new Error(
      `Duplicate company RAG ${label} "${key}" for "${existing.company.companyId}.${existing.useCaseId}" and "${resolution.company.companyId}.${resolution.useCaseId}".`
    );
  }
  index.set(key, resolution);
}

function lookupDescription(lookup: CompanyDeploymentRegistryLookup): string {
  return JSON.stringify({
    ...(lookup.companyId === undefined ? {} : { companyId: lookup.companyId }),
    ...(lookup.useCaseId === undefined ? {} : { useCaseId: lookup.useCaseId }),
    ...(lookup.namespaceId === undefined ? {} : { namespaceId: lookup.namespaceId }),
    ...(lookup.profileId === undefined ? {} : { profileId: lookup.profileId })
  });
}
