#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { CompanyDeploymentRegistry } from "../company/company-deployment-registry.js";
import {
  loadCompanyDeploymentModule,
  type LoadedCompanyDeploymentModule
} from "../company/company-deployment-module.js";
import {
  runCompanyPackContractTests,
  type CompanyPackContractReport
} from "../company/company-pack-contract.js";
import {
  assembleCompanyProductionSourceSyncRuntimes,
  assembleCompanyRuntime,
  type CompanyProductionSourceSyncRuntimeRegistration,
  type CompanyRuntimeAssembly,
  type CompanyRuntimeAssemblyRequest
} from "../company/company-runtime-assembly.js";
import type { IndexFilter, IndexOverwriteMode } from "../indexing/index-types.js";
import type { HostedVectorFetchLike } from "../indexing/hosted-vector-vendor-transports.js";
import type { RequestPrincipal } from "../security/access-scope.js";
import type { ProviderTransport } from "../shared/provider-boundary.js";
import type { ProviderEnv } from "../shared/provider-runtime-config.js";
import type { SourceSyncMode } from "../sync/source-connector.js";
import type { SourceSyncWorkflowResult, SourceSyncWorkflowStatus } from "./source-sync-workflow.js";
import {
  createProductionRagApp,
  loadProductionRagAppConfigFromEnv,
  ProductionRagConfigError,
  ProductionRagRequestError,
  type ProductionRagAnswerInput,
  type ProductionRagApp,
  type ProductionRagAppConfig
} from "./production-app.js";
import {
  createProductionRagHttpServer,
  type ProductionRagHttpServer
} from "./production-http-server.js";
import {
  createProductionIngestRuntime,
  loadProductionIngestionConfigFromEnv,
  type ProductionCorpusAdapterExtension,
  type ProductionDocumentParserExtension,
  type ProductionIngestionConfig,
  type ProductionRagIngestInput
} from "./production-ingestion.js";

export interface ProductionRagSignalSource {
  once(signal: NodeJS.Signals, listener: () => void): this;
  off(signal: NodeJS.Signals, listener: () => void): this;
}

export interface ProductionRagCliOptions {
  readonly argv?: readonly string[];
  readonly env?: ProviderEnv;
  readonly cwd?: string;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly appFactory?: (
    config: ProductionRagAppConfig
  ) => ProductionRagApp | Promise<ProductionRagApp>;
  readonly transport?: ProviderTransport;
  readonly vectorFetch?: HostedVectorFetchLike;
  readonly now?: () => string;
  readonly nowMs?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly signalSource?: ProductionRagSignalSource;
  readonly ingestionConfig?: ProductionIngestionConfig;
  readonly adapterExtensions?: readonly ProductionCorpusAdapterExtension[];
  readonly parserExtensions?: readonly ProductionDocumentParserExtension[];
}

interface ParsedArgs {
  readonly command: string;
  readonly flags: ReadonlyMap<string, readonly string[]>;
}

interface ProductionCompanyDeploymentRuntime {
  readonly loaded: LoadedCompanyDeploymentModule;
  readonly registry: CompanyDeploymentRegistry;
  readonly assembly: CompanyRuntimeAssembly;
  readonly packContractReport?: CompanyPackContractReport;
}

interface ProductionCompanySyncCommandResult {
  readonly status: SourceSyncWorkflowStatus;
  readonly runId: string;
  readonly mode: SourceSyncMode;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly companyDeployment: unknown;
  readonly connectorCount: number;
  readonly sourceCount: number;
  readonly results: readonly ProductionCompanySyncSourceResult[];
  readonly metrics: ProductionCompanySyncMetrics;
}

interface ProductionCompanySyncSourceResult {
  readonly status: SourceSyncWorkflowStatus;
  readonly connectorId: string;
  readonly sourceSystem: string;
  readonly adapterId: string;
  readonly sourceId: string;
  readonly runId: string;
  readonly mode: SourceSyncMode;
  readonly complete: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly ledger: {
    readonly saved: boolean;
    readonly entryCount: number;
    readonly hasCursor: boolean;
  };
  readonly sync: {
    readonly status: string;
    readonly listedItemCount: number;
    readonly returnedRecordCount: number;
    readonly deletedItemCount: number;
    readonly failedItemCount: number;
    readonly skippedUnchangedCount: number;
    readonly tombstonedMissingCount: number;
    readonly warningCount: number;
    readonly warningCodes: readonly string[];
  };
  readonly ingest?: {
    readonly documentCount: number;
    readonly chunkCount: number;
    readonly rejectedRecordCount: number;
    readonly normalizationIssueCount: number;
  };
  readonly deletePropagation?: {
    readonly status: string;
    readonly propagatedDocumentCount: number;
    readonly deletedDocumentCount: number;
    readonly deletedChunkCount: number;
    readonly errorCount: number;
  };
  readonly postIngest?: {
    readonly status: string;
    readonly warningCodes: readonly string[];
    readonly indexedVectorCount: number;
    readonly indexedRelationVectorCount: number;
    readonly indexedVisualVectorCount: number;
    readonly knowledgeEntityCount: number;
    readonly knowledgeRelationCount: number;
  };
  readonly warningCodes: readonly string[];
  readonly metrics: SourceSyncWorkflowResult["metrics"];
}

interface ProductionCompanySyncMetrics {
  readonly syncedRecordCount: number;
  readonly syncedDeleteCount: number;
  readonly syncFailedItemCount: number;
  readonly ingestedDocumentCount: number;
  readonly ingestedChunkCount: number;
  readonly rejectedRecordCount: number;
  readonly indexedVectorCount: number;
  readonly indexedRelationVectorCount: number;
  readonly indexedVisualVectorCount: number;
  readonly knowledgeEntityCount: number;
  readonly knowledgeRelationCount: number;
  readonly propagatedDeleteCount: number;
  readonly deletedDocumentCount: number;
  readonly deletedChunkCount: number;
  readonly ledgerSavedCount: number;
}

const HELP_TEXT = `adaptable-rag commands:
  validate-config [--self-test true|false] [--probe-providers true|false]
  sync --mode delta|full --tenant-id <tenant> --user-id <user> --principal-namespace-id <namespace>
  ingest --tenant-id <tenant> --user-id <user> --principal-namespace-id <namespace>
  answer --question <text> --tenant-id <tenant> --namespace-id <namespace> --user-id <user> --principal-namespace-id <namespace>
  serve

Common sync flags:
  --connector-id <id> --source-id <id> --delete-missing true|false
  --namespace-id <namespace> --team-id <id> --role <role> --tag <tag>
  --overwrite reject|replace --run-id <id> --requested-at <iso8601>

Common answer flags:
  --team-id <id> --role <role> --tag <tag>
  --source-id <id> --document-id <id> --chunk-id <id> --access-tag <tag>
  --top-k <n> --include-rejected true|false

Common ingest flags:
  --namespace-id <namespace> --team-id <id> --role <role> --tag <tag>
  --source-id <id> --overwrite reject|replace --run-id <id> --requested-at <iso8601>`;

export async function runProductionRagCli(options: ProductionRagCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const stderr = options.stderr ?? ((line) => process.stderr.write(`${line}\n`));

  try {
    const parsed = parseArgs(options.argv ?? process.argv.slice(2));
    if (parsed.command === "help" || parsed.flags.has("help")) {
      stdout(HELP_TEXT);
      return 0;
    }

    const env = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    const baseConfig = loadProductionRagAppConfigFromEnv({
      env,
      cwd
    });
    const companyRuntime = await loadCliCompanyRuntime({
      env,
      cwd,
      flags: parsed.flags,
      ...(options.now === undefined ? {} : { now: options.now })
    });
    const config =
      companyRuntime === undefined
        ? baseConfig
        : {
            ...baseConfig,
            profile: companyRuntime.assembly.resolution.profile
          };
    const app = await createCliApp(config, options);

    switch (parsed.command) {
      case "validate-config":
        if (shouldRunSelfTest(parsed.flags)) {
          const selfTest = await app.selfTest({
            probeProviders: optionalCliBooleanFlag(parsed.flags, "probe-providers") === true,
            ...(options.now === undefined ? {} : { requestedAt: options.now() })
          });
          stdout(
            JSON.stringify(
              companyRuntime === undefined
                ? selfTest
                : {
                    ...selfTest,
                    companyDeployment: companyDeploymentSummary(companyRuntime)
                  },
              null,
              2
            )
          );
          return 0;
        }

        stdout(
          JSON.stringify(
            companyRuntime === undefined
              ? app.health()
              : {
                  ...app.health(),
                  companyDeployment: companyDeploymentSummary(companyRuntime)
                },
            null,
            2
          )
        );
        return 0;
      case "sync": {
        if (companyRuntime === undefined) {
          throw new ProductionRagConfigError("sync requires RAG_COMPANY_MODULE_PATH.");
        }
        const result = await runCompanySyncCommand({
          app,
          companyRuntime,
          flags: parsed.flags,
          ...(options.now === undefined ? {} : { now: options.now })
        });
        stdout(JSON.stringify(result, null, 2));
        return result.status === "failed" || result.status === "partial" ? 1 : 0;
      }
      case "ingest": {
        const ingestion = createProductionIngestRuntime({
          app,
          adapterExtensions: [
            ...(companyRuntime?.assembly.corpusAdapterExtensions ?? []),
            ...(options.adapterExtensions ?? [])
          ],
          parserExtensions: [
            ...(companyRuntime?.assembly.parserExtensions ?? []),
            ...(options.parserExtensions ?? [])
          ],
          config: loadProductionIngestionConfigFromEnv({
            env: options.env ?? process.env,
            cwd: options.cwd ?? process.cwd(),
            ...(options.ingestionConfig === undefined ? {} : { defaults: options.ingestionConfig })
          }),
          ...(options.now === undefined ? {} : { now: options.now })
        });
        const result = await ingestion.ingest(
          ingestInputFromFlags(parsed.flags, app.profile.namespaceId)
        );
        stdout(JSON.stringify(result, null, 2));
        return 0;
      }
      case "answer": {
        const answer = await app.answer(
          answerInputFromFlags(parsed.flags, app.profile.namespaceId)
        );
        stdout(JSON.stringify(answer, null, 2));
        return 0;
      }
      case "serve": {
        const server = createProductionRagHttpServer({
          app,
          ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs })
        });
        const address = await server.listen();
        stdout(
          JSON.stringify({
            status: "listening",
            host: address.host,
            port: address.port,
            healthPath: "/health",
            readinessPath: app.config.http.operations.readinessPath,
            metricsPath: app.config.http.operations.metricsPath,
            answerPath: "/answer"
          })
        );
        return await waitForShutdown(server, options.signalSource ?? process, stdout, stderr);
      }
      default:
        stderr(`Unknown command: ${parsed.command}`);
        stderr(HELP_TEXT);
        return 2;
    }
  } catch (error) {
    stderr(
      JSON.stringify({
        error: {
          name: errorName(error),
          message: error instanceof Error ? error.message : "CLI command failed."
        }
      })
    );
    return error instanceof ProductionRagRequestError ? 2 : 1;
  }
}

function waitForShutdown(
  server: ProductionRagHttpServer,
  signalSource: ProductionRagSignalSource,
  stdout: (line: string) => void,
  stderr: (line: string) => void
): Promise<number> {
  return new Promise((resolve) => {
    let closing = false;
    const onSigint = (): void => {
      void shutdown("SIGINT");
    };
    const onSigterm = (): void => {
      void shutdown("SIGTERM");
    };
    const cleanup = (): void => {
      signalSource.off("SIGINT", onSigint);
      signalSource.off("SIGTERM", onSigterm);
    };
    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
      if (closing) {
        return;
      }

      closing = true;
      cleanup();
      stdout(
        JSON.stringify({
          status: "shutting_down",
          signal
        })
      );
      try {
        await server.close();
        stdout(
          JSON.stringify({
            status: "stopped",
            signal
          })
        );
        resolve(0);
      } catch (error) {
        stderr(
          JSON.stringify({
            error: {
              name: errorName(error),
              message: error instanceof Error ? error.message : "Server shutdown failed."
            }
          })
        );
        resolve(1);
      }
    };

    signalSource.once("SIGINT", onSigint);
    signalSource.once("SIGTERM", onSigterm);
  });
}

function createCliApp(
  config: ProductionRagAppConfig,
  options: ProductionRagCliOptions
): ProductionRagApp | Promise<ProductionRagApp> {
  if (options.appFactory) {
    return options.appFactory(config);
  }

  return createProductionRagApp({
    config,
    env: options.env ?? process.env,
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    ...(options.vectorFetch === undefined ? {} : { vectorFetch: options.vectorFetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  });
}

async function loadCliCompanyRuntime(input: {
  readonly env: ProviderEnv;
  readonly cwd: string;
  readonly flags: ReadonlyMap<string, readonly string[]>;
  readonly now?: () => string;
}): Promise<ProductionCompanyDeploymentRuntime | undefined> {
  const modulePath = readEnv(input.env, "RAG_COMPANY_MODULE_PATH");
  if (!modulePath) {
    if (optionalCliBooleanFlag(input.flags, "run-pack-contracts") === true) {
      throw new ProductionRagConfigError("--run-pack-contracts requires RAG_COMPANY_MODULE_PATH.");
    }
    return undefined;
  }

  const adapterPackExportNames = csvEnv(input.env, "RAG_COMPANY_ADAPTER_PACK_EXPORTS");
  const loaded = await loadCompanyDeploymentModule({
    modulePath,
    cwd: input.cwd,
    companyExportName: readEnv(input.env, "RAG_COMPANY_PROFILE_EXPORT") ?? "companyProfile",
    ...(adapterPackExportNames === undefined ? {} : { adapterPackExportNames })
  });
  const registry = new CompanyDeploymentRegistry([
    {
      company: loaded.company,
      adapterPacks: loaded.adapterPacks
    }
  ]);
  const assembly = assembleCompanyRuntime(registry, companyRuntimeLookup(loaded, input.env));
  const shouldRunPackContracts = shouldRunCompanyPackContracts(input.flags, input.env);
  const packContractReport = shouldRunPackContracts
    ? await runCompanyPackContractTests({
        registry,
        company: {
          companyId: assembly.resolution.company.companyId,
          useCaseId: assembly.resolution.useCaseId
        },
        requestedBy: companyPackContractPrincipal(input.env, assembly),
        requestedAt: input.now?.() ?? new Date().toISOString()
      })
    : undefined;

  if (packContractReport && packContractReport.status !== "passed") {
    throw new ProductionRagConfigError(
      `Company pack contracts failed for "${packContractReport.companyId}.${packContractReport.useCaseId}" with ${packContractReport.errors.length} errors.`
    );
  }

  return {
    loaded,
    registry,
    assembly,
    ...(packContractReport === undefined ? {} : { packContractReport })
  };
}

function companyRuntimeLookup(
  loaded: LoadedCompanyDeploymentModule,
  env: ProviderEnv
): CompanyRuntimeAssemblyRequest {
  const namespaceId = readEnv(env, "RAG_COMPANY_NAMESPACE_ID");
  if (namespaceId) {
    return { namespaceId };
  }

  const profileId = readEnv(env, "RAG_COMPANY_PROFILE_ID");
  if (profileId) {
    return { profileId };
  }

  const companyId = readEnv(env, "RAG_COMPANY_ID") ?? loaded.company.companyId;
  const useCaseId = readEnv(env, "RAG_COMPANY_USE_CASE_ID") ?? singleUseCaseId(loaded.company);
  if (!useCaseId) {
    throw new ProductionRagConfigError(
      "RAG_COMPANY_USE_CASE_ID is required when the company deployment has multiple use cases."
    );
  }

  return {
    companyId,
    useCaseId
  };
}

function singleUseCaseId(company: LoadedCompanyDeploymentModule["company"]): string | undefined {
  return company.useCases.length === 1 ? company.useCases[0]?.id : undefined;
}

function shouldRunCompanyPackContracts(
  flags: ReadonlyMap<string, readonly string[]>,
  env: ProviderEnv
): boolean {
  const flag = optionalCliBooleanFlag(flags, "run-pack-contracts");
  if (flag !== undefined) {
    return flag;
  }

  const explicitBoolean = envBoolean(readEnv(env, "RAG_COMPANY_RUN_PACK_CONTRACTS"));
  if (explicitBoolean !== undefined) {
    return explicitBoolean;
  }

  const mode = readEnv(env, "RAG_COMPANY_PACK_CONTRACT_MODE");
  if (mode === undefined || mode === "disabled") {
    return false;
  }
  if (mode === "required") {
    return true;
  }

  throw new ProductionRagConfigError(
    'RAG_COMPANY_PACK_CONTRACT_MODE must be "disabled" or "required".'
  );
}

function companyPackContractPrincipal(
  env: ProviderEnv,
  assembly: CompanyRuntimeAssembly
): RequestPrincipal {
  return {
    userId: readEnv(env, "RAG_COMPANY_CONTRACT_USER_ID") ?? "company_pack_contract",
    tenantId:
      readEnv(env, "RAG_COMPANY_CONTRACT_TENANT_ID") ?? assembly.resolution.company.defaultTenantId,
    namespaceIds: csvEnv(env, "RAG_COMPANY_CONTRACT_NAMESPACE_IDS") ?? [
      assembly.resolution.profile.namespaceId
    ],
    teamIds: csvEnv(env, "RAG_COMPANY_CONTRACT_TEAM_IDS") ?? [],
    roles: csvEnv(env, "RAG_COMPANY_CONTRACT_ROLES") ?? ["company_pack_contract"],
    tags: csvEnv(env, "RAG_COMPANY_CONTRACT_TAGS") ?? ["contract-test"]
  };
}

function companyDeploymentSummary(runtime: ProductionCompanyDeploymentRuntime): unknown {
  return {
    companyId: runtime.assembly.resolution.company.companyId,
    useCaseId: runtime.assembly.resolution.useCaseId,
    profileId: runtime.assembly.resolution.profile.id,
    namespaceId: runtime.assembly.resolution.profile.namespaceId,
    moduleUrl: runtime.loaded.moduleUrl,
    companyExportName: runtime.loaded.companyExportName,
    adapterPackExports: runtime.loaded.adapterPackExportNames,
    adapterPackCount: runtime.loaded.adapterPacks.length,
    packContracts:
      runtime.packContractReport === undefined
        ? { status: "not_run" }
        : {
            status: runtime.packContractReport.status,
            checkedAdapterCount: runtime.packContractReport.checkedAdapterCount,
            checkedParserCount: runtime.packContractReport.checkedParserCount,
            checkedConnectorCount: runtime.packContractReport.checkedConnectorCount,
            checkedPermissionMapperCount: runtime.packContractReport.checkedPermissionMapperCount,
            checkedCaseCount: runtime.packContractReport.checkedCaseCount,
            errorCount: runtime.packContractReport.errors.length,
            warningCount: runtime.packContractReport.warnings.length
          }
  };
}

async function runCompanySyncCommand(input: {
  readonly app: ProductionRagApp;
  readonly companyRuntime: ProductionCompanyDeploymentRuntime;
  readonly flags: ReadonlyMap<string, readonly string[]>;
  readonly now?: () => string;
}): Promise<ProductionCompanySyncCommandResult> {
  const syncInput = companySyncInputFromFlags(input.flags, input.app.profile.namespaceId);
  const registrations = assembleCompanyProductionSourceSyncRuntimes(input.companyRuntime.registry, {
    companyId: input.companyRuntime.assembly.resolution.company.companyId,
    useCaseId: input.companyRuntime.assembly.resolution.useCaseId,
    app: input.app,
    ...(input.now === undefined ? {} : { now: input.now })
  });
  const targets = selectedCompanySyncTargets(registrations, syncInput);
  const startedAt = syncInput.requestedAt ?? input.now?.() ?? new Date().toISOString();
  const baseRunId = syncInput.runId ?? `company_sync_${safeId(startedAt)}`;
  const results: ProductionCompanySyncSourceResult[] = [];

  for (const target of targets) {
    const result = await target.registration.runtime.sync({
      sourceId: target.sourceId,
      requestedBy: syncInput.principal,
      filter: syncFilter(syncInput, target.sourceId, input.app.profile.namespaceId),
      mode: syncInput.mode,
      runId: sourceSyncRunId(baseRunId, target, targets.length),
      requestedAt: startedAt,
      ...(syncInput.deleteMissingItems === undefined
        ? {}
        : { deleteMissingItems: syncInput.deleteMissingItems }),
      ...(syncInput.overwriteMode === undefined ? {} : { overwriteMode: syncInput.overwriteMode })
    });
    results.push(redactCompanySyncSourceResult(target.registration, target.sourceId, result));
  }

  return {
    status: aggregateSyncStatus(results.map((result) => result.status)),
    runId: baseRunId,
    mode: syncInput.mode,
    startedAt,
    finishedAt: latestFinishedAt(results),
    companyDeployment: companyDeploymentSummary(input.companyRuntime),
    connectorCount: new Set(results.map((result) => result.connectorId)).size,
    sourceCount: results.length,
    results,
    metrics: aggregateSyncMetrics(results)
  };
}

interface CompanySyncInput {
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly principal: RequestPrincipal;
  readonly mode: SourceSyncMode;
  readonly connectorIds?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly deleteMissingItems?: boolean;
  readonly overwriteMode?: IndexOverwriteMode;
  readonly runId?: string;
  readonly requestedAt?: string;
}

interface CompanySyncTarget {
  readonly registration: CompanyProductionSourceSyncRuntimeRegistration;
  readonly sourceId: string;
}

function companySyncInputFromFlags(
  flags: ReadonlyMap<string, readonly string[]>,
  defaultNamespaceId: string
): CompanySyncInput {
  const tenantId = requiredFlag(flags, "tenant-id");
  const namespaceId = firstFlag(flags, "namespace-id") ?? defaultNamespaceId;
  const principalNamespaceIds = allFlags(flags, "principal-namespace-id");
  const connectorIds = optionalFlags(flags, "connector-id");
  const sourceIds = optionalFlags(flags, "source-id");
  const overwriteMode = optionalOverwriteModeFlag(flags);
  const runId = firstFlag(flags, "run-id");
  const requestedAt = firstFlag(flags, "requested-at");
  const deleteMissingItems = optionalCliBooleanFlag(flags, "delete-missing");

  if (principalNamespaceIds.length === 0) {
    throw new ProductionRagRequestError("--principal-namespace-id is required.");
  }
  if (!principalNamespaceIds.includes(namespaceId)) {
    throw new ProductionRagRequestError("--principal-namespace-id must include namespace-id.");
  }

  return {
    tenantId,
    namespaceId,
    principal: {
      userId: requiredFlag(flags, "user-id"),
      tenantId: firstFlag(flags, "principal-tenant-id") ?? tenantId,
      namespaceIds: principalNamespaceIds,
      teamIds: allFlags(flags, "team-id"),
      roles: allFlags(flags, "role"),
      tags: allFlags(flags, "tag")
    },
    mode: optionalSyncModeFlag(flags) ?? "delta",
    ...(connectorIds === undefined ? {} : { connectorIds }),
    ...(sourceIds === undefined ? {} : { sourceIds }),
    ...(deleteMissingItems === undefined ? {} : { deleteMissingItems }),
    ...(overwriteMode === undefined ? {} : { overwriteMode }),
    ...(runId === undefined ? {} : { runId }),
    ...(requestedAt === undefined ? {} : { requestedAt })
  };
}

function selectedCompanySyncTargets(
  registrations: readonly CompanyProductionSourceSyncRuntimeRegistration[],
  input: CompanySyncInput
): readonly CompanySyncTarget[] {
  if (registrations.length === 0) {
    throw new ProductionRagConfigError(
      "The selected company use case does not register any production source connectors."
    );
  }

  const availableConnectorIds = new Set(
    registrations.map((registration) => registration.connectorId)
  );
  const availableSourceIds = new Set(
    registrations.flatMap((registration) => registration.sourceIds)
  );
  const missingConnectorIds = (input.connectorIds ?? []).filter(
    (connectorId) => !availableConnectorIds.has(connectorId)
  );
  const missingSourceIds = (input.sourceIds ?? []).filter(
    (sourceId) => !availableSourceIds.has(sourceId)
  );
  if (missingConnectorIds.length > 0) {
    throw new ProductionRagRequestError(
      `Unknown company connector ids: ${missingConnectorIds.join(", ")}.`
    );
  }
  if (missingSourceIds.length > 0) {
    throw new ProductionRagRequestError(
      `Unknown company source ids: ${missingSourceIds.join(", ")}.`
    );
  }

  const connectorFilter = new Set(input.connectorIds ?? []);
  const sourceFilter = new Set(input.sourceIds ?? []);
  const targets = registrations.flatMap((registration) => {
    if (connectorFilter.size > 0 && !connectorFilter.has(registration.connectorId)) {
      return [];
    }

    return registration.sourceIds
      .filter((sourceId) => sourceFilter.size === 0 || sourceFilter.has(sourceId))
      .map((sourceId) => ({
        registration,
        sourceId
      }));
  });

  if (targets.length === 0) {
    throw new ProductionRagRequestError("No company sync targets matched the supplied filters.");
  }

  return targets;
}

function syncFilter(
  input: CompanySyncInput,
  sourceId: string,
  profileNamespaceId: string
): IndexFilter {
  return {
    tenantId: input.tenantId,
    namespaceId: input.namespaceId || profileNamespaceId,
    principal: input.principal,
    sourceIds: [sourceId]
  };
}

function redactCompanySyncSourceResult(
  registration: CompanyProductionSourceSyncRuntimeRegistration,
  sourceId: string,
  result: SourceSyncWorkflowResult
): ProductionCompanySyncSourceResult {
  return {
    status: result.status,
    connectorId: registration.connectorId,
    sourceSystem: registration.sourceSystem,
    adapterId: registration.adapterId,
    sourceId,
    runId: result.runId,
    mode: result.sync.mode,
    complete: result.sync.complete,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    ledger: {
      saved: result.ledgerSaved,
      entryCount: result.ledger.entries.length,
      hasCursor: result.ledger.cursor !== undefined
    },
    sync: {
      status: result.sync.status,
      listedItemCount: result.sync.metrics.listedItemCount,
      returnedRecordCount: result.sync.metrics.returnedRecordCount,
      deletedItemCount: result.sync.metrics.deletedItemCount,
      failedItemCount: result.sync.metrics.failedItemCount,
      skippedUnchangedCount: result.sync.metrics.skippedUnchangedCount,
      tombstonedMissingCount: result.sync.metrics.tombstonedMissingCount,
      warningCount: result.sync.metrics.warningCount,
      warningCodes: uniqueSorted(result.sync.warnings.map((warning) => warning.code))
    },
    ...(result.ingest === undefined
      ? {}
      : {
          ingest: {
            documentCount: result.ingest.documents.length,
            chunkCount: result.ingest.chunks.length,
            rejectedRecordCount: result.ingest.rejectedRecords.length,
            normalizationIssueCount: result.ingest.normalizationIssues.length
          }
        }),
    ...(result.deletePropagation === undefined
      ? {}
      : {
          deletePropagation: {
            status: result.deletePropagation.status,
            propagatedDocumentCount: result.deletePropagation.metrics.propagatedDocumentCount,
            deletedDocumentCount: result.deletePropagation.metrics.deletedDocumentCount,
            deletedChunkCount: result.deletePropagation.metrics.deletedChunkCount,
            errorCount: result.deletePropagation.errors.length
          }
        }),
    ...(result.postIngest === undefined
      ? {}
      : {
          postIngest: {
            status: result.postIngest.status,
            warningCodes: uniqueSorted(result.postIngest.warnings.map((warning) => warning.code)),
            indexedVectorCount: result.postIngest.metrics.indexedVectorCount,
            indexedRelationVectorCount: result.postIngest.metrics.indexedRelationVectorCount,
            indexedVisualVectorCount: result.postIngest.metrics.indexedVisualVectorCount,
            knowledgeEntityCount: result.postIngest.metrics.knowledgeEntityCount,
            knowledgeRelationCount: result.postIngest.metrics.knowledgeRelationCount
          }
        }),
    warningCodes: uniqueSorted(result.warnings.map((warning) => warning.code)),
    metrics: result.metrics
  };
}

function aggregateSyncStatus(
  statuses: readonly SourceSyncWorkflowStatus[]
): SourceSyncWorkflowStatus {
  if (statuses.some((status) => status === "failed")) {
    return "failed";
  }
  if (statuses.some((status) => status === "partial")) {
    return "partial";
  }
  if (statuses.some((status) => status === "succeeded")) {
    return "succeeded";
  }
  return "skipped";
}

function aggregateSyncMetrics(
  results: readonly ProductionCompanySyncSourceResult[]
): ProductionCompanySyncMetrics {
  return {
    syncedRecordCount: sum(results, (result) => result.metrics.syncedRecordCount),
    syncedDeleteCount: sum(results, (result) => result.metrics.syncedDeleteCount),
    syncFailedItemCount: sum(results, (result) => result.metrics.syncFailedItemCount),
    ingestedDocumentCount: sum(results, (result) => result.metrics.ingestedDocumentCount),
    ingestedChunkCount: sum(results, (result) => result.metrics.ingestedChunkCount),
    rejectedRecordCount: sum(results, (result) => result.metrics.rejectedRecordCount),
    indexedVectorCount: sum(results, (result) => result.metrics.indexedVectorCount),
    indexedRelationVectorCount: sum(results, (result) => result.metrics.indexedRelationVectorCount),
    indexedVisualVectorCount: sum(results, (result) => result.metrics.indexedVisualVectorCount),
    knowledgeEntityCount: sum(results, (result) => result.metrics.knowledgeEntityCount),
    knowledgeRelationCount: sum(results, (result) => result.metrics.knowledgeRelationCount),
    propagatedDeleteCount: sum(results, (result) => result.metrics.propagatedDeleteCount),
    deletedDocumentCount: sum(results, (result) => result.metrics.deletedDocumentCount),
    deletedChunkCount: sum(results, (result) => result.metrics.deletedChunkCount),
    ledgerSavedCount: results.filter((result) => result.ledger.saved).length
  };
}

function latestFinishedAt(results: readonly ProductionCompanySyncSourceResult[]): string {
  return (
    results
      .map((result) => result.finishedAt)
      .sort()
      .at(-1) ?? new Date().toISOString()
  );
}

function sum<T>(values: readonly T[], selector: (value: T) => number): number {
  return values.reduce((total, value) => total + selector(value), 0);
}

function sourceSyncRunId(
  baseRunId: string,
  target: CompanySyncTarget,
  targetCount: number
): string {
  if (targetCount === 1) {
    return baseRunId;
  }

  return `${baseRunId}_${safeId(target.registration.connectorId)}_${safeId(target.sourceId)}`;
}

function safeId(value: string): string {
  return value.replace(/[^0-9a-z_-]/gi, "");
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function answerInputFromFlags(
  flags: ReadonlyMap<string, readonly string[]>,
  defaultNamespaceId: string
): ProductionRagAnswerInput {
  const tenantId = requiredFlag(flags, "tenant-id");
  const namespaceId = firstFlag(flags, "namespace-id") ?? defaultNamespaceId;
  const principalNamespaceIds = allFlags(flags, "principal-namespace-id");

  if (principalNamespaceIds.length === 0) {
    throw new ProductionRagRequestError("--principal-namespace-id is required.");
  }

  return {
    question: requiredFlag(flags, "question"),
    tenantId,
    namespaceId,
    principal: {
      userId: requiredFlag(flags, "user-id"),
      tenantId: firstFlag(flags, "principal-tenant-id") ?? tenantId,
      namespaceIds: principalNamespaceIds,
      teamIds: allFlags(flags, "team-id"),
      roles: allFlags(flags, "role"),
      tags: allFlags(flags, "tag")
    },
    filters: {
      documentIds: optionalFlags(flags, "document-id"),
      chunkIds: optionalFlags(flags, "chunk-id"),
      sourceIds: optionalFlags(flags, "source-id"),
      accessTags: optionalFlags(flags, "access-tag")
    },
    ...optionalIntegerFlag(flags, "top-k", "topK"),
    ...optionalBooleanFlag(flags, "include-rejected", "includeRejected")
  };
}

function ingestInputFromFlags(
  flags: ReadonlyMap<string, readonly string[]>,
  defaultNamespaceId: string
): ProductionRagIngestInput {
  const tenantId = requiredFlag(flags, "tenant-id");
  const namespaceId = firstFlag(flags, "namespace-id") ?? defaultNamespaceId;
  const principalNamespaceIds = allFlags(flags, "principal-namespace-id");
  const sourceIds = optionalFlags(flags, "source-id");
  const overwriteMode = optionalOverwriteModeFlag(flags);
  const runId = firstFlag(flags, "run-id");
  const requestedAt = firstFlag(flags, "requested-at");

  if (principalNamespaceIds.length === 0) {
    throw new ProductionRagRequestError("--principal-namespace-id is required.");
  }

  return {
    tenantId,
    namespaceId,
    principal: {
      userId: requiredFlag(flags, "user-id"),
      tenantId: firstFlag(flags, "principal-tenant-id") ?? tenantId,
      namespaceIds: principalNamespaceIds,
      teamIds: allFlags(flags, "team-id"),
      roles: allFlags(flags, "role"),
      tags: allFlags(flags, "tag")
    },
    ...(sourceIds === undefined ? {} : { sourceIds }),
    ...(overwriteMode === undefined ? {} : { overwriteMode }),
    ...(runId === undefined ? {} : { runId }),
    ...(requestedAt === undefined ? {} : { requestedAt })
  };
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string[]>();

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg?.startsWith("--")) {
      throw new ProductionRagRequestError(`Unexpected argument: ${arg ?? ""}`);
    }

    const withoutPrefix = arg.slice(2);
    const [rawKey, inlineValue] = withoutPrefix.split("=", 2);
    if (!rawKey) {
      throw new ProductionRagRequestError("Flag name cannot be empty.");
    }

    const value = inlineValue ?? rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ProductionRagRequestError(`Missing value for --${rawKey}.`);
    }

    if (inlineValue === undefined) {
      index += 1;
    }

    const existing = flags.get(rawKey) ?? [];
    flags.set(rawKey, [...existing, value]);
  }

  return {
    command,
    flags
  };
}

function requiredFlag(flags: ReadonlyMap<string, readonly string[]>, name: string): string {
  const value = firstFlag(flags, name);
  if (!value) {
    throw new ProductionRagRequestError(`--${name} is required.`);
  }

  return value;
}

function firstFlag(
  flags: ReadonlyMap<string, readonly string[]>,
  name: string
): string | undefined {
  return flags.get(name)?.[0];
}

function optionalFlags(
  flags: ReadonlyMap<string, readonly string[]>,
  name: string
): readonly string[] | undefined {
  const values = allFlags(flags, name);
  return values.length === 0 ? undefined : values;
}

function allFlags(flags: ReadonlyMap<string, readonly string[]>, name: string): readonly string[] {
  return (flags.get(name) ?? []).flatMap((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
  );
}

function readEnv(env: ProviderEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function csvEnv(env: ProviderEnv, name: string): readonly string[] | undefined {
  const value = readEnv(env, name);
  if (value === undefined) {
    return undefined;
  }

  const values = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return values.length === 0 ? undefined : values;
}

function envBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new ProductionRagConfigError("Boolean env values must be true or false.");
}

function optionalIntegerFlag(
  flags: ReadonlyMap<string, readonly string[]>,
  flagName: string,
  outputName: "topK"
): { readonly topK?: number } {
  const value = firstFlag(flags, flagName);
  if (value === undefined) {
    return {};
  }

  if (!/^[0-9]+$/u.test(value)) {
    throw new ProductionRagRequestError(`--${flagName} must be a positive integer.`);
  }

  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) {
    throw new ProductionRagRequestError(`--${flagName} must be a positive integer.`);
  }

  return { [outputName]: parsed };
}

function optionalBooleanFlag(
  flags: ReadonlyMap<string, readonly string[]>,
  flagName: string,
  outputName: "includeRejected"
): { readonly includeRejected?: boolean } {
  const value = firstFlag(flags, flagName);
  if (value === undefined) {
    return {};
  }

  if (value === "true") {
    return { [outputName]: true };
  }
  if (value === "false") {
    return { [outputName]: false };
  }

  throw new ProductionRagRequestError(`--${flagName} must be true or false.`);
}

function optionalCliBooleanFlag(
  flags: ReadonlyMap<string, readonly string[]>,
  flagName: string
): boolean | undefined {
  const value = firstFlag(flags, flagName);
  if (value === undefined) {
    return undefined;
  }

  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new ProductionRagRequestError(`--${flagName} must be true or false.`);
}

function shouldRunSelfTest(flags: ReadonlyMap<string, readonly string[]>): boolean {
  return (
    optionalCliBooleanFlag(flags, "self-test") === true ||
    optionalCliBooleanFlag(flags, "probe-providers") === true
  );
}

function optionalOverwriteModeFlag(
  flags: ReadonlyMap<string, readonly string[]>
): ProductionRagIngestInput["overwriteMode"] | undefined {
  const value = firstFlag(flags, "overwrite");
  if (value === undefined) {
    return undefined;
  }

  if (value === "reject" || value === "replace") {
    return value;
  }

  throw new ProductionRagRequestError("--overwrite must be reject or replace.");
}

function optionalSyncModeFlag(
  flags: ReadonlyMap<string, readonly string[]>
): SourceSyncMode | undefined {
  const value = firstFlag(flags, "mode");
  if (value === undefined) {
    return undefined;
  }

  if (value === "delta" || value === "full") {
    return value;
  }

  throw new ProductionRagRequestError("--mode must be delta or full.");
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(entry).href === moduleUrl;
}

if (isMain(import.meta.url)) {
  void runProductionRagCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
