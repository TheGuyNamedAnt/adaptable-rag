import type {
  ProductionCorpusAdapterExtension,
  ProductionDocumentParserExtension
} from "../runtime/production-ingestion.js";
import {
  createProductionSourceSyncRuntime,
  type ProductionSourceSyncRuntime
} from "../runtime/production-source-sync.js";
import type { ProductionRagApp } from "../runtime/production-app.js";
import type { SourceConnector } from "../sync/source-connector.js";
import type { ConnectorAclMapper } from "../security/connector-acl-mapper.js";
import {
  companyPermissionMappersFromPacks,
  companyParsersFromPacks,
  companySourceConnectorsFromPacks,
  createCompanyCorpusAdapterRegistry
} from "./company-adapter-pack.js";
import type {
  CompanyDeploymentRegistryEntry,
  CompanyDeploymentProfileResolution,
  CompanyDeploymentRegistry,
  CompanyDeploymentRegistryLookup
} from "./company-deployment-registry.js";

export type CompanyRuntimeAssemblyRequest = CompanyDeploymentRegistryLookup;

export interface CompanyRuntimeAssembly {
  readonly resolution: CompanyDeploymentProfileResolution;
  readonly corpusAdapterExtensions: readonly ProductionCorpusAdapterExtension[];
  readonly parserExtensions: readonly ProductionDocumentParserExtension[];
  readonly sourceConnectorRegistrations: readonly CompanySourceConnectorRegistration[];
  readonly declaredSourceIds: readonly string[];
  readonly declaredAdapterIds: readonly string[];
  readonly connectorTestCommands: readonly string[];
}

export interface CompanySourceConnectorRegistration {
  readonly connectorId: string;
  readonly sourceSystem: string;
  readonly adapterId: string;
  readonly sourceIds: readonly string[];
  readonly connector: SourceConnector;
  readonly permissionMapper?: ConnectorAclMapper;
}

export interface CompanyProductionSourceSyncRuntimeRegistration extends CompanySourceConnectorRegistration {
  readonly runtime: ProductionSourceSyncRuntime;
}

export interface CompanyProductionSourceSyncRuntimeAssemblyRequest extends CompanyRuntimeAssemblyRequest {
  readonly app: ProductionRagApp;
  readonly now?: () => string;
}

export function assembleCompanyRuntime(
  registry: CompanyDeploymentRegistry,
  request: CompanyRuntimeAssemblyRequest
): CompanyRuntimeAssembly {
  const resolution = registry.resolveProfileRequired(request);
  const entry = registry.getCompanyRequired(resolution.company.companyId);
  const adapterRegistry = createCompanyCorpusAdapterRegistry(entry.adapterPacks);
  const parsersById = new Map(
    companyParsersFromPacks(entry.adapterPacks).map((parser) => [parser.id, parser])
  );
  const sourceConnectorRegistrations = sourceConnectorRegistrationsForUseCase(entry, resolution);
  const declaredAdapterIds = unique(
    resolution.profile.corpusSources.map((source) => source.adapter)
  );
  const declaredParserIds = parserIdsForUseCase(entry, resolution);

  return {
    resolution,
    corpusAdapterExtensions: adapterRegistry
      .list()
      .filter((adapter) => declaredAdapterIds.includes(adapter.id))
      .map((adapter) => ({ adapter })),
    parserExtensions: declaredParserIds
      .map((parserId) => parsersById.get(parserId))
      .filter((parser): parser is NonNullable<typeof parser> => parser !== undefined)
      .map((parser) => ({ parser })),
    sourceConnectorRegistrations,
    declaredSourceIds: resolution.profile.corpusSources.map((source) => source.id),
    declaredAdapterIds,
    connectorTestCommands: connectorTestCommandsForUseCase(entry, resolution)
  };
}

function parserIdsForUseCase(
  entry: CompanyDeploymentRegistryEntry,
  resolution: CompanyDeploymentProfileResolution
): readonly string[] {
  const useCase = entry.company.useCases.find((candidate) => candidate.id === resolution.useCaseId);
  return unique(useCase?.parserIds ?? []);
}

export function assembleCompanyProductionSourceSyncRuntimes(
  registry: CompanyDeploymentRegistry,
  request: CompanyProductionSourceSyncRuntimeAssemblyRequest
): readonly CompanyProductionSourceSyncRuntimeRegistration[] {
  const assembly = assembleCompanyRuntime(registry, request);
  if (
    request.app.profile.id !== assembly.resolution.profile.id ||
    request.app.profile.namespaceId !== assembly.resolution.profile.namespaceId
  ) {
    throw new Error(
      `Production app profile "${request.app.profile.id}" does not match company profile "${assembly.resolution.profile.id}".`
    );
  }

  return assembly.sourceConnectorRegistrations.map((registration) => ({
    ...registration,
    runtime: createProductionSourceSyncRuntime({
      app: request.app,
      connector: registration.connector,
      ...(request.now === undefined ? {} : { now: request.now })
    })
  }));
}

function connectorTestCommandsForUseCase(
  entry: CompanyDeploymentRegistryEntry,
  resolution: CompanyDeploymentProfileResolution
): readonly string[] {
  const companyConnectorCommands =
    resolution.company.connectors
      ?.filter((connector) => connector.useCaseIds.includes(resolution.useCaseId))
      .flatMap((connector) =>
        connector.contractTestCommand?.trim() ? [connector.contractTestCommand] : []
      ) ?? [];
  const connectorIds = new Set(
    resolution.company.connectors
      ?.filter((connector) => connector.useCaseIds.includes(resolution.useCaseId))
      .map((connector) => connector.id) ?? []
  );
  const packConnectorCommands = entry.adapterPacks.flatMap((pack) =>
    (pack.connectorTests ?? []).flatMap((test) =>
      connectorIds.has(test.connectorId) && test.command.trim() ? [test.command] : []
    )
  );

  return unique([...companyConnectorCommands, ...packConnectorCommands]);
}

function sourceConnectorRegistrationsForUseCase(
  entry: CompanyDeploymentRegistryEntry,
  resolution: CompanyDeploymentProfileResolution
): readonly CompanySourceConnectorRegistration[] {
  const connectorsById = new Map(
    companySourceConnectorsFromPacks(entry.adapterPacks).map((connector) => [
      connector.id,
      connector
    ])
  );
  const permissionMappersBySourceSystem = new Map(
    companyPermissionMappersFromPacks(entry.adapterPacks).map((registration) => [
      registration.sourceSystem,
      registration.mapper
    ])
  );
  const registrations =
    resolution.company.connectors?.filter((connector) =>
      connector.useCaseIds.includes(resolution.useCaseId)
    ) ?? [];

  return registrations.map((registration) => {
    const connector = connectorsById.get(registration.id);
    if (!connector) {
      throw new Error(
        `Company connector "${registration.id}" does not have a registered SourceConnector in adapter packs.`
      );
    }

    const sourceIds = resolution.profile.corpusSources
      .filter((source) => source.adapter === registration.adapterId)
      .map((source) => source.id);
    if (sourceIds.length === 0) {
      throw new Error(
        `Company connector "${registration.id}" does not match any source in profile "${resolution.profile.id}".`
      );
    }

    const permissionMapper = permissionMappersBySourceSystem.get(registration.sourceSystem);
    return {
      connectorId: registration.id,
      sourceSystem: registration.sourceSystem,
      adapterId: registration.adapterId,
      sourceIds,
      connector,
      ...(permissionMapper === undefined ? {} : { permissionMapper })
    };
  });
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
