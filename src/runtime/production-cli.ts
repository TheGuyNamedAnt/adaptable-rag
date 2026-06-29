#!/usr/bin/env node
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

import { CompanyDeploymentRegistry } from "../company/company-deployment-registry.js";
import {
  loadCompanyDeploymentModule,
  type LoadedCompanyDeploymentModule
} from "../company/company-deployment-module.js";
import { inspect } from "../inspect/inspect.js";
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
import { redactText, type ProviderTransport } from "../shared/provider-boundary.js";
import type { ProviderEnv } from "../shared/provider-runtime-config.js";
import type { SourceSyncMode } from "../sync/source-connector.js";
import type { SourceSyncWorkflowResult, SourceSyncWorkflowStatus } from "./source-sync-workflow.js";
import {
  PostgresIngestionCheckpointStore,
  PostgresIngestionJobStore,
  PostgresIngestionProgressStore,
  type IngestionDocumentStatus,
  type IngestionJobRecord,
  type IngestionJobListFilter,
  type IngestionJobStatus,
  type IngestionJobStore
} from "./ingestion-job.js";
import {
  IndexGenerationPromotionService,
  PostgresIndexGenerationStore,
  PostgresIngestionJobQueue,
  PostgresIngestionLeaseStore,
  planGenerationPromotion,
  planIngestionBackfillJobs,
  planReindex,
  type EnqueueIngestionJobInput,
  type GenerationEvalStatus,
  type GenerationPromotionPlan,
  type GenerationPromotionRecord,
  type IndexGenerationListFilter,
  type IndexGenerationManifest,
  type IndexGenerationStatus,
  type IndexGenerationStore,
  type IngestionBackfillPlan,
  type IngestionJobQueue,
  type IngestionLeaseStore,
  type IngestionQueueJob,
  type IngestionQueueListFilter,
  type IngestionQueueStatus
} from "./ingestion-scale.js";
import {
  ProductionIngestionWorker,
  type ProductionIngestionWorkerRunLoopInput,
  type ProductionIngestionWorkerRunLoopResult,
  type ProductionIngestionWorkerRunOnceResult
} from "./ingestion-worker.js";
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
  type ProductionIngestRuntime,
  type ProductionRagIngestResponse,
  type ProductionRagIngestInput
} from "./production-ingestion.js";
import type { StartupSelfTestResult } from "./startup-self-test.js";

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
  readonly ingestRuntimeFactory?: (
    app: ProductionRagApp
  ) => ProductionIngestRuntime | Promise<ProductionIngestRuntime>;
  readonly adapterExtensions?: readonly ProductionCorpusAdapterExtension[];
  readonly parserExtensions?: readonly ProductionDocumentParserExtension[];
  readonly workerQueue?: IngestionJobQueue;
  readonly workerLeaseStore?: IngestionLeaseStore;
  readonly indexGenerationStore?: IndexGenerationStore;
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

interface PostgresIngestionInspectStores {
  readonly jobStore: PostgresIngestionJobStore;
  readonly checkpointStore: PostgresIngestionCheckpointStore;
  readonly progressStore: PostgresIngestionProgressStore;
}

interface ProductionIngestionWorkerStores {
  readonly queue: IngestionJobQueue;
  readonly leaseStore?: IngestionLeaseStore;
}

interface ProductionIndexGenerationStores {
  readonly store: IndexGenerationStore;
}

interface ProductionIngestionWorkerCommandResult {
  readonly workerId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly attemptedCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly leaseConflictCount: number;
  readonly idleCount: number;
  readonly results: readonly ProductionIngestionWorkerCommandJobResult[];
}

interface ProductionIngestionWorkerCommandJobResult {
  readonly status: ProductionIngestionWorkerRunOnceResult["status"];
  readonly workerId: string;
  readonly checkedAt: string;
  readonly queueJob?: ProductionIngestionWorkerCommandQueueJob;
  readonly ingestion?: ProductionIngestionWorkerCommandIngestion;
  readonly errorName?: string;
  readonly errorMessage?: string;
}

interface ProductionIngestionWorkerCommandQueueJob {
  readonly queueId: string;
  readonly jobId: string;
  readonly runId?: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly sourceIds: readonly string[];
  readonly status: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly updatedAt: string;
  readonly leasedBy?: string;
  readonly leaseExpiresAt?: string;
  readonly finishedAt?: string;
  readonly errorName?: string;
  readonly errorMessage?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

interface ProductionIngestionWorkerCommandIngestion {
  readonly status: ProductionRagIngestResponse["status"];
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly loadedSourceIds: readonly string[];
  readonly counts: ProductionRagIngestResponse["counts"];
  readonly index: ProductionRagIngestResponse["index"];
  readonly vector?: ProductionRagIngestResponse["vector"];
  readonly visualVector?: ProductionRagIngestResponse["visualVector"];
  readonly parserQuality: ProductionRagIngestResponse["parserQuality"];
  readonly integrity: ProductionRagIngestResponse["integrity"];
  readonly warnings: ProductionRagIngestResponse["warnings"];
}

type ProductionIngestionEnqueueMode = "backfill" | "reindex";

interface ProductionIngestionEnqueuePlan {
  readonly mode: ProductionIngestionEnqueueMode;
  readonly dryRun: boolean;
  readonly plan: IngestionBackfillPlan;
  readonly candidateGeneration?: IndexGenerationManifest;
  readonly promotion?: GenerationPromotionPlan;
}

interface ProductionIngestionEnqueueCommandResult {
  readonly mode: ProductionIngestionEnqueueMode;
  readonly dryRun: boolean;
  readonly planId: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly requestedAt: string;
  readonly batchSize: number;
  readonly plannedJobCount: number;
  readonly enqueuedJobCount: number;
  readonly plannedJobs: readonly ProductionIngestionEnqueuePlannedJob[];
  readonly enqueuedJobs?: readonly ProductionIngestionWorkerCommandQueueJob[];
  readonly candidateGeneration?: IndexGenerationManifest;
  readonly promotion?: GenerationPromotionPlan;
}

interface ProductionIngestionEnqueuePlannedJob {
  readonly queueId?: string;
  readonly jobId: string;
  readonly runId?: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly sourceIds: readonly string[];
  readonly priority?: number;
  readonly maxAttempts?: number;
  readonly availableAt?: string;
  readonly enqueuedAt: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

interface ProductionIngestionQueueInspectResult {
  readonly jobs: readonly ProductionIngestionWorkerCommandQueueJob[];
  readonly count: number;
  readonly filter: IngestionQueueListFilter;
}

interface ProductionIngestionQueueMutationResult {
  readonly status: "cancelled" | "requeued";
  readonly queueJob: ProductionIngestionWorkerCommandQueueJob;
}

interface ProductionIndexGenerationInspectResult {
  readonly manifests: readonly IndexGenerationManifest[];
  readonly count: number;
  readonly filter: IndexGenerationListFilter;
}

interface ProductionGenerationPromotionPlanResult {
  readonly status: "planned" | "saved";
  readonly dryRun: boolean;
  readonly promotionId: string;
  readonly candidateGeneration: IndexGenerationManifest;
  readonly activeGeneration?: IndexGenerationManifest;
  readonly promotion: GenerationPromotionPlan | GenerationPromotionRecord;
}

type InspectTraceInput = Parameters<typeof inspect.trace>[0];
type InspectRetrievalInput = Parameters<typeof inspect.retrieval>[0];
type InspectCitationContextInput = NonNullable<Parameters<typeof inspect.citation>[0]["context"]>;
type InspectEvalSummaryInput = Parameters<typeof inspect.evalFailure>[0]["summary"];

const INGESTION_JOB_STATUSES: readonly IngestionJobStatus[] = [
  "queued",
  "loading_source",
  "normalizing",
  "parsing",
  "chunking",
  "embedding",
  "indexing",
  "graph_extracting",
  "completed",
  "completed_with_warnings",
  "failed",
  "cancelled"
];

const INGESTION_DOCUMENT_STATUSES: readonly IngestionDocumentStatus[] = [
  "queued",
  "normalizing",
  "parsing",
  "chunking",
  "embedding",
  "indexing",
  "graph_extracting",
  "accepted",
  "failed",
  "skipped"
];

const INGESTION_QUEUE_STATUSES: readonly IngestionQueueStatus[] = [
  "queued",
  "leased",
  "completed",
  "dead_letter",
  "cancelled"
];

const INDEX_GENERATION_STATUSES: readonly IndexGenerationStatus[] = [
  "candidate",
  "active",
  "deprecated",
  "failed"
];

const STORAGE_ONLY_COMMANDS = new Set([
  "backup",
  "restore",
  "inspect-ingestion-queue",
  "cancel-ingestion-queue-job",
  "requeue-ingestion-queue-job",
  "inspect-index-generations",
  "inspect-generation-promotion",
  "plan-generation-promotion",
  "record-generation-eval",
  "promote-generation",
  "inspect-ingestion-job",
  "inspect-ingestion-jobs",
  "inspect-ingestion",
  "inspect-source-health",
  "inspect-trace",
  "inspect-retrieval",
  "inspect-citation",
  "inspect-eval-failure"
]);

const HELP_TEXT = `adaptable-rag commands:
  validate-config [--self-test true|false] [--probe-providers true|false]
  health
  ready [--probe-providers true|false]
  metrics
  doctor [--probe-providers true|false]
  backup [--output <path>]
  restore --input <path>
  inspect-ingestion-queue [--tenant-id <tenant>] [--namespace-id <namespace>] [--status <status>] [--limit <n>]
  cancel-ingestion-queue-job --queue-id <queue> [--reason <text>]
  requeue-ingestion-queue-job --queue-id <queue> [--available-at <iso8601>] [--max-attempts <n>]
  inspect-index-generations [--tenant-id <tenant>] [--namespace-id <namespace>] [--generation-status <status>] [--limit <n>]
  inspect-generation-promotion --promotion-id <id>
  plan-generation-promotion --promotion-id <id> --generation-id <id> --embedding-provider <id> --embedding-model <name>
  record-generation-eval --promotion-id <id> --eval-id <id> --eval-status passed|failed
  promote-generation --promotion-id <id>
  inspect-ingestion-jobs [--tenant-id <tenant>] [--namespace-id <namespace>] [--status <status>] [--limit <n>]
  inspect-ingestion-job --job-id <job> [--source-id <source>] [--document-status <status>] [--document-limit <n>] [--document-offset <n>] [--checkpoint-limit <n>] [--checkpoint-offset <n>]
  inspect-ingestion --job-id <job>
  inspect-source-health --job-id <job> [--source-id <source>]
  inspect-trace --trace <path>
  inspect-retrieval --retrieval <path>
  inspect-citation [--trace <path>] [--retrieval <path>] [--context <path>] [--chunk-id <chunk>]
  inspect-eval-failure --summary <path> [--case-id <case>]
  sync --mode delta|full --tenant-id <tenant> --user-id <user> --principal-namespace-id <namespace>
  ingest --tenant-id <tenant> --user-id <user> --principal-namespace-id <namespace>
  enqueue-ingestion --plan-id <id> --tenant-id <tenant> --namespace-id <namespace> --source-id <id> --batch-size <n>
  worker [--max-jobs <n>] [--worker-id <id>] [--tenant-id <tenant>] [--namespace-id <namespace>]
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
  --source-id <id> --overwrite reject|replace --run-id <id> --requested-at <iso8601>

Common enqueue-ingestion flags:
  --mode backfill|reindex --priority <n> --max-attempts <n> --available-at <iso8601>
  --metadata key=value --dry-run true|false
  reindex: --generation-id <id> --embedding-provider <id> --embedding-model <name>
  reindex: --embedding-dimensions <n> --embedding-config-hash <hash> --embedding-index-config-hash <hash>
  reindex: --chunking-policy-id <id> --chunking-policy-version <n> [--required-eval-id <id>]

Common queue control flags:
  --status queued|leased|completed|dead_letter|cancelled --metadata key=value --requested-at <iso8601>

Common generation promotion flags:
  --tenant-id <tenant> --namespace-id <namespace> --profile-id <profile>
  --generation-status candidate|active|deprecated|failed --required-eval-id <id>
  --active-generation-id <id> --archive-previous true|false --dry-run true|false --replace true|false
  --recorded-at <iso8601> --promoted-at <iso8601> --report-uri <uri> --summary <text>

Common worker flags:
  --source-id <id> --principal-namespace-id <namespace> --user-id <user>
  --lease-ttl-ms <ms> --heartbeat-interval-ms <ms> --lease-conflict-retry-ms <ms>
  --retry-failed-jobs true|false --overwrite reject|replace --requested-at <iso8601>`;

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
    const configEnv =
      isStorageOnlyCommand(parsed.command) && readEnv(env, "RAG_HTTP_AUTH_MODE") === undefined
        ? {
            ...env,
            RAG_HTTP_AUTH_MODE: "disabled"
          }
        : env;
    const cwd = options.cwd ?? process.cwd();
    const baseConfig = loadProductionRagAppConfigFromEnv({
      env: configEnv,
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
    const storageOnlyExitCode = await runStorageOnlyCliCommand({
      command: parsed.command,
      flags: parsed.flags,
      config,
      options,
      cwd,
      ...(companyRuntime === undefined ? {} : { companyRuntime }),
      requestedAt: options.now?.() ?? new Date().toISOString(),
      stdout
    });
    if (storageOnlyExitCode !== undefined) {
      return storageOnlyExitCode;
    }

    const app = await createCliApp(config, options);

    switch (parsed.command) {
      case "health":
        stdout(
          JSON.stringify(
            withCompanyDeployment(await productionAppHealth(app), companyRuntime),
            null,
            2
          )
        );
        return 0;
      case "ready": {
        const selfTest = await app.selfTest({
          probeProviders: optionalCliBooleanFlag(parsed.flags, "probe-providers") === true,
          ...(options.now === undefined ? {} : { requestedAt: options.now() })
        });
        const health = await productionAppHealth(app);
        const payload = withCompanyDeployment(
          {
            status: selfTest.status === "passed" ? "ready" : "not_ready",
            ready: selfTest.status === "passed",
            health,
            selfTest
          },
          companyRuntime
        );
        stdout(JSON.stringify(payload, null, 2));
        return selfTest.status === "passed" ? 0 : 1;
      }
      case "metrics":
        stdout(
          JSON.stringify(
            withCompanyDeployment(
              await localOperationalMetrics(app, options.nowMs?.() ?? Date.now()),
              companyRuntime
            ),
            null,
            2
          )
        );
        return 0;
      case "doctor": {
        const selfTest = await app.selfTest({
          probeProviders: optionalCliBooleanFlag(parsed.flags, "probe-providers") === true,
          ...(options.now === undefined ? {} : { requestedAt: options.now() })
        });
        const health = await productionAppHealth(app);
        const payload = withCompanyDeployment(
          {
            status: selfTest.status,
            checkedAt: selfTest.checkedAt,
            health,
            selfTest,
            recommendations: doctorRecommendations(selfTest)
          },
          companyRuntime
        );
        stdout(JSON.stringify(payload, null, 2));
        return selfTest.status === "passed" ? 0 : 1;
      }
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
              ? await productionAppHealth(app)
              : {
                  ...(await productionAppHealth(app)),
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
        const ingestion = await createCliIngestRuntime(app, options, companyRuntime);
        const result = await ingestion.ingest(
          ingestInputFromFlags(parsed.flags, app.profile.namespaceId)
        );
        stdout(JSON.stringify(result, null, 2));
        return 0;
      }
      case "enqueue-ingestion": {
        const result = await runEnqueueIngestionCommand({
          flags: parsed.flags,
          config,
          options,
          profileId: app.profile.id,
          defaultNamespaceId: app.profile.namespaceId,
          requestedAt: options.now?.() ?? new Date().toISOString()
        });
        stdout(JSON.stringify(withCompanyDeployment(result, companyRuntime), null, 2));
        return 0;
      }
      case "worker": {
        const ingestion = await createCliIngestRuntime(app, options, companyRuntime);
        const result = await withProductionIngestionWorkerStores({
          config,
          options,
          callback: ({ queue, leaseStore }) =>
            new ProductionIngestionWorker({
              queue,
              ingestRuntime: ingestion,
              workerId: workerIdFromFlags(parsed.flags, env),
              principalForJob: workerPrincipalForJobFromFlags(parsed.flags),
              ...(leaseStore === undefined ? {} : { leaseStore }),
              ...workerOptionsFromFlags(parsed.flags),
              ...(options.now === undefined ? {} : { now: options.now })
            }).runLoop(workerRunLoopInputFromFlags(parsed.flags))
        });
        stdout(
          JSON.stringify(
            withCompanyDeployment(summarizeWorkerCommandResult(result), companyRuntime),
            null,
            2
          )
        );
        return result.failedCount > 0 ? 1 : 0;
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

async function createCliIngestRuntime(
  app: ProductionRagApp,
  options: ProductionRagCliOptions,
  companyRuntime: ProductionCompanyDeploymentRuntime | undefined
): Promise<ProductionIngestRuntime> {
  if (options.ingestRuntimeFactory !== undefined) {
    return options.ingestRuntimeFactory(app);
  }

  return createProductionIngestRuntime({
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
}

function withCompanyDeployment<T>(
  payload: T,
  runtime: ProductionCompanyDeploymentRuntime | undefined
): T | (T & { readonly companyDeployment: unknown }) {
  return runtime === undefined
    ? payload
    : {
        ...payload,
        companyDeployment: companyDeploymentSummary(runtime)
      };
}

async function runStorageOnlyCliCommand(input: {
  readonly command: string;
  readonly flags: ReadonlyMap<string, readonly string[]>;
  readonly config: ProductionRagAppConfig;
  readonly options: ProductionRagCliOptions;
  readonly cwd: string;
  readonly companyRuntime?: ProductionCompanyDeploymentRuntime;
  readonly requestedAt: string;
  readonly stdout: (line: string) => void;
}): Promise<number | undefined> {
  switch (input.command) {
    case "backup": {
      const outputPath = firstFlag(input.flags, "output");
      const result = await backupLocalStorage({
        config: input.config,
        cwd: input.cwd,
        requestedAt: input.requestedAt,
        ...(outputPath === undefined ? {} : { outputPath })
      });
      input.stdout(JSON.stringify(withCompanyDeployment(result, input.companyRuntime), null, 2));
      return result.status === "completed" ? 0 : 1;
    }
    case "restore": {
      const result = await restoreLocalStorage({
        config: input.config,
        inputPath: requiredFlag(input.flags, "input"),
        cwd: input.cwd,
        requestedAt: input.requestedAt
      });
      input.stdout(JSON.stringify(withCompanyDeployment(result, input.companyRuntime), null, 2));
      return result.status === "completed" ? 0 : 1;
    }
    case "inspect-ingestion-queue": {
      const result = await withProductionIngestionWorkerStores({
        config: input.config,
        options: input.options,
        callback: ({ queue }) => inspectIngestionQueue(queue, input.flags)
      });
      input.stdout(JSON.stringify(withCompanyDeployment(result, input.companyRuntime), null, 2));
      return 0;
    }
    case "cancel-ingestion-queue-job": {
      const result = await withProductionIngestionWorkerStores({
        config: input.config,
        options: input.options,
        callback: ({ queue }) => cancelIngestionQueueJob(queue, input.flags, input.requestedAt)
      });
      input.stdout(JSON.stringify(withCompanyDeployment(result, input.companyRuntime), null, 2));
      return 0;
    }
    case "requeue-ingestion-queue-job": {
      const result = await withProductionIngestionWorkerStores({
        config: input.config,
        options: input.options,
        callback: ({ queue }) => requeueIngestionQueueJob(queue, input.flags, input.requestedAt)
      });
      input.stdout(JSON.stringify(withCompanyDeployment(result, input.companyRuntime), null, 2));
      return 0;
    }
    case "inspect-index-generations": {
      const result = await withProductionIndexGenerationStore({
        config: input.config,
        options: input.options,
        callback: ({ store }) => inspectIndexGenerations(store, input.flags)
      });
      input.stdout(JSON.stringify(withCompanyDeployment(result, input.companyRuntime), null, 2));
      return 0;
    }
    case "inspect-generation-promotion": {
      const result = await withProductionIndexGenerationStore({
        config: input.config,
        options: input.options,
        callback: ({ store }) => inspectGenerationPromotion(store, input.flags)
      });
      input.stdout(JSON.stringify(withCompanyDeployment(result, input.companyRuntime), null, 2));
      return 0;
    }
    case "plan-generation-promotion": {
      const result = await withProductionIndexGenerationStore({
        config: input.config,
        options: input.options,
        callback: ({ store }) =>
          planGenerationPromotionCommand({
            store,
            flags: input.flags,
            config: input.config,
            requestedAt: input.requestedAt
          })
      });
      input.stdout(JSON.stringify(withCompanyDeployment(result, input.companyRuntime), null, 2));
      return 0;
    }
    case "record-generation-eval": {
      const result = await withProductionIndexGenerationStore({
        config: input.config,
        options: input.options,
        callback: ({ store }) => recordGenerationEval(store, input.flags, input.requestedAt)
      });
      input.stdout(JSON.stringify(withCompanyDeployment(result, input.companyRuntime), null, 2));
      return 0;
    }
    case "promote-generation": {
      const result = await withProductionIndexGenerationStore({
        config: input.config,
        options: input.options,
        callback: ({ store }) => promoteGeneration(store, input.flags, input.requestedAt)
      });
      input.stdout(JSON.stringify(withCompanyDeployment(result, input.companyRuntime), null, 2));
      return 0;
    }
    case "inspect-ingestion-jobs": {
      const result = await withPostgresIngestionInspectStores(input.config, ({ jobStore }) =>
        listIngestionJobsForInspect(jobStore, input.flags)
      );
      input.stdout(JSON.stringify(withCompanyDeployment(result, input.companyRuntime), null, 2));
      return 0;
    }
    case "inspect-ingestion-job":
    case "inspect-ingestion": {
      const result = await withPostgresIngestionInspectStores(
        input.config,
        ({ jobStore, checkpointStore, progressStore }) =>
          inspect.ingestionRun({
            ...inspectIngestionRunFlags(input.flags),
            jobStore,
            checkpointStore,
            progressStore
          })
      );
      input.stdout(JSON.stringify(withCompanyDeployment(result, input.companyRuntime), null, 2));
      return 0;
    }
    case "inspect-source-health": {
      const jobId = requiredFlag(input.flags, "job-id");
      const sourceId = firstFlag(input.flags, "source-id");
      const result = await withPostgresIngestionInspectStores(input.config, ({ progressStore }) =>
        inspect.sourceHealth({
          jobId,
          progressStore,
          ...(sourceId === undefined ? {} : { sourceId })
        })
      );
      input.stdout(JSON.stringify(withCompanyDeployment(result, input.companyRuntime), null, 2));
      return 0;
    }
    case "inspect-trace": {
      const trace = await readJsonFile<InspectTraceInput>(
        requiredFlag(input.flags, "trace"),
        input.cwd
      );
      input.stdout(
        JSON.stringify(withCompanyDeployment(inspect.trace(trace), input.companyRuntime), null, 2)
      );
      return 0;
    }
    case "inspect-retrieval": {
      const retrieval = await readJsonFile<InspectRetrievalInput>(
        requiredFlag(input.flags, "retrieval"),
        input.cwd
      );
      input.stdout(
        JSON.stringify(
          withCompanyDeployment(inspect.retrieval(retrieval), input.companyRuntime),
          null,
          2
        )
      );
      return 0;
    }
    case "inspect-citation": {
      const result = await inspectCitationFromFlags(input.flags, input.cwd);
      input.stdout(JSON.stringify(withCompanyDeployment(result, input.companyRuntime), null, 2));
      return 0;
    }
    case "inspect-eval-failure": {
      const summary = await readJsonFile<InspectEvalSummaryInput>(
        requiredFlag(input.flags, "summary"),
        input.cwd
      );
      const result = inspect.evalFailure({
        summary,
        ...optionalCaseId(input.flags)
      });
      input.stdout(JSON.stringify(withCompanyDeployment(result, input.companyRuntime), null, 2));
      return 0;
    }
    default:
      return undefined;
  }
}

async function localOperationalMetrics(
  app: ProductionRagApp,
  observedAtMs: number
): Promise<{
  readonly status: "ok";
  readonly observedAt: string;
  readonly uptimeMs: number;
  readonly health: ReturnType<ProductionRagApp["health"]>;
}> {
  return {
    status: "ok",
    observedAt: new Date(observedAtMs).toISOString(),
    uptimeMs: Math.max(0, Math.round(process.uptime() * 1000)),
    health: await productionAppHealth(app)
  };
}

async function productionAppHealth(
  app: ProductionRagApp
): Promise<ReturnType<ProductionRagApp["health"]>> {
  return app.healthAsync === undefined ? app.health() : app.healthAsync();
}

function doctorRecommendations(selfTest: StartupSelfTestResult): readonly string[] {
  if (selfTest.status === "passed") {
    return [];
  }

  return selfTest.checks
    .filter((check) => check.status === "failed")
    .map((check) => {
      if (check.kind === "provider_probe") {
        return `Fix provider check "${check.id}": verify credentials, endpoint, and model name.`;
      }
      if (check.kind === "storage") {
        return `Fix storage check "${check.id}": verify migrations, schema version, and backend connectivity.`;
      }
      return `Fix capability check "${check.id}": ${check.message}`;
    });
}

interface LocalStorageBackupRequest {
  readonly config: ProductionRagAppConfig;
  readonly outputPath?: string;
  readonly cwd: string;
  readonly requestedAt: string;
}

interface LocalStorageRestoreRequest {
  readonly config: ProductionRagAppConfig;
  readonly inputPath: string;
  readonly cwd: string;
  readonly requestedAt: string;
}

interface LocalStorageBackupResult {
  readonly status: "completed" | "unsupported";
  readonly requestedAt: string;
  readonly storageKind: ProductionRagAppConfig["storage"]["index"]["kind"];
  readonly outputPath?: string;
  readonly manifestPath?: string;
  readonly sourcePath?: string;
  readonly bytesCopied?: number;
  readonly message?: string;
}

interface LocalStorageRestoreResult {
  readonly status: "completed" | "unsupported";
  readonly requestedAt: string;
  readonly storageKind: ProductionRagAppConfig["storage"]["index"]["kind"];
  readonly inputPath: string;
  readonly targetPath?: string;
  readonly bytesCopied?: number;
  readonly message?: string;
}

async function backupLocalStorage(
  request: LocalStorageBackupRequest
): Promise<LocalStorageBackupResult> {
  const index = request.config.storage.index;
  if (index.kind !== "json_file" && index.kind !== "sqlite") {
    return {
      status: "unsupported",
      requestedAt: request.requestedAt,
      storageKind: index.kind,
      message:
        index.kind === "postgres"
          ? "Use native Postgres backup tooling for postgres storage."
          : "Memory storage has no durable local file to back up."
    };
  }

  const sourcePath = index.path;
  const outputPath = resolveBackupOutputPath(request.outputPath, request.cwd, request.requestedAt);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await copyFile(sourcePath, outputPath);
  const copied = await stat(outputPath);
  const manifestPath = `${outputPath}.manifest.json`;
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        status: "completed",
        requestedAt: request.requestedAt,
        storageKind: index.kind,
        sourcePath,
        outputPath,
        bytesCopied: copied.size
      },
      null,
      2
    )}\n`
  );

  return {
    status: "completed",
    requestedAt: request.requestedAt,
    storageKind: index.kind,
    outputPath,
    manifestPath,
    sourcePath,
    bytesCopied: copied.size
  };
}

async function restoreLocalStorage(
  request: LocalStorageRestoreRequest
): Promise<LocalStorageRestoreResult> {
  const index = request.config.storage.index;
  const inputPath = path.resolve(request.cwd, request.inputPath);
  if (index.kind !== "json_file" && index.kind !== "sqlite") {
    return {
      status: "unsupported",
      requestedAt: request.requestedAt,
      storageKind: index.kind,
      inputPath,
      message:
        index.kind === "postgres"
          ? "Use native Postgres restore tooling for postgres storage."
          : "Memory storage has no durable local file to restore."
    };
  }

  await readFile(inputPath);
  await mkdir(path.dirname(index.path), { recursive: true });
  await copyFile(inputPath, index.path);
  const copied = await stat(index.path);
  return {
    status: "completed",
    requestedAt: request.requestedAt,
    storageKind: index.kind,
    inputPath,
    targetPath: index.path,
    bytesCopied: copied.size
  };
}

function resolveBackupOutputPath(
  outputPath: string | undefined,
  cwd: string,
  requestedAt: string
): string {
  if (outputPath) {
    return path.resolve(cwd, outputPath);
  }

  return path.resolve(cwd, ".rag", "backups", `index-${safeId(requestedAt)}.backup`);
}

async function withPostgresIngestionInspectStores<T>(
  config: ProductionRagAppConfig,
  callback: (stores: PostgresIngestionInspectStores) => Promise<T>
): Promise<T> {
  const index = config.storage.index;
  if (index.kind !== "postgres") {
    throw new ProductionRagConfigError(
      "Ingestion inspection requires postgres index storage because ingestion job state is durable production metadata."
    );
  }

  const pool = new pg.Pool({ connectionString: index.connectionString });
  const storeOptions = {
    pool,
    ...(index.schema === undefined ? {} : { schema: index.schema })
  };

  try {
    return await callback({
      jobStore: new PostgresIngestionJobStore(storeOptions),
      checkpointStore: new PostgresIngestionCheckpointStore(storeOptions),
      progressStore: new PostgresIngestionProgressStore(storeOptions)
    });
  } finally {
    await pool.end();
  }
}

async function withProductionIngestionWorkerStores<T>(input: {
  readonly config: ProductionRagAppConfig;
  readonly options: ProductionRagCliOptions;
  readonly callback: (stores: ProductionIngestionWorkerStores) => Promise<T>;
}): Promise<T> {
  if (input.options.workerQueue !== undefined) {
    return input.callback({
      queue: input.options.workerQueue,
      ...(input.options.workerLeaseStore === undefined
        ? {}
        : { leaseStore: input.options.workerLeaseStore })
    });
  }
  if (input.options.workerLeaseStore !== undefined) {
    throw new ProductionRagConfigError(
      "workerLeaseStore requires workerQueue because the CLI cannot attach a lease store to an implicit queue."
    );
  }

  const index = input.config.storage.index;
  if (index.kind !== "postgres") {
    throw new ProductionRagConfigError(
      "Distributed ingestion queue commands require postgres index storage for durable queue and lease state, or an injected workerQueue for embedded execution."
    );
  }

  const pool = new pg.Pool({ connectionString: index.connectionString });
  const storeOptions = {
    pool,
    ...(index.schema === undefined ? {} : { schema: index.schema })
  };

  try {
    return await input.callback({
      queue: new PostgresIngestionJobQueue(storeOptions),
      leaseStore: new PostgresIngestionLeaseStore(storeOptions)
    });
  } finally {
    await pool.end();
  }
}

async function withProductionIndexGenerationStore<T>(input: {
  readonly config: ProductionRagAppConfig;
  readonly options: ProductionRagCliOptions;
  readonly callback: (stores: ProductionIndexGenerationStores) => Promise<T>;
}): Promise<T> {
  if (input.options.indexGenerationStore !== undefined) {
    return input.callback({ store: input.options.indexGenerationStore });
  }

  const index = input.config.storage.index;
  if (index.kind !== "postgres") {
    throw new ProductionRagConfigError(
      "Index generation promotion commands require postgres index storage for durable generation state, or an injected indexGenerationStore for embedded execution."
    );
  }

  const pool = new pg.Pool({ connectionString: index.connectionString });
  const storeOptions = {
    pool,
    ...(index.schema === undefined ? {} : { schema: index.schema })
  };

  try {
    return await input.callback({
      store: new PostgresIndexGenerationStore(storeOptions)
    });
  } finally {
    await pool.end();
  }
}

async function runEnqueueIngestionCommand(input: {
  readonly flags: ReadonlyMap<string, readonly string[]>;
  readonly config: ProductionRagAppConfig;
  readonly options: ProductionRagCliOptions;
  readonly profileId: string;
  readonly defaultNamespaceId: string;
  readonly requestedAt: string;
}): Promise<ProductionIngestionEnqueueCommandResult> {
  const enqueuePlan = enqueueIngestionPlanFromFlags({
    flags: input.flags,
    profileId: input.profileId,
    defaultNamespaceId: input.defaultNamespaceId,
    requestedAt: input.requestedAt
  });
  if (enqueuePlan.dryRun) {
    return summarizeEnqueueCommandResult({
      enqueuePlan,
      enqueuedJobs: []
    });
  }

  const enqueuedJobs = await withProductionIngestionWorkerStores({
    config: input.config,
    options: input.options,
    callback: async ({ queue }) => {
      const existing = await Promise.all(
        enqueuePlan.plan.jobs.map((job) => queue.get(job.queueId ?? job.jobId))
      );
      const duplicateQueueIds = existing
        .filter((job): job is IngestionQueueJob => job !== undefined)
        .map((job) => job.queueId);
      if (duplicateQueueIds.length > 0) {
        throw new ProductionRagRequestError(
          `Ingestion queue already contains job ids: ${duplicateQueueIds.join(", ")}.`
        );
      }

      const enqueued: IngestionQueueJob[] = [];
      for (const job of enqueuePlan.plan.jobs) {
        enqueued.push(await queue.enqueue(job));
      }
      return enqueued;
    }
  });

  return summarizeEnqueueCommandResult({
    enqueuePlan,
    enqueuedJobs
  });
}

async function inspectIngestionQueue(
  queue: IngestionJobQueue,
  flags: ReadonlyMap<string, readonly string[]>
): Promise<ProductionIngestionQueueInspectResult> {
  const filter = ingestionQueueListFilterFromFlags(flags);
  const jobs = await queue.list(filter);
  return {
    jobs: jobs.map(summarizeQueueJob),
    count: jobs.length,
    filter
  };
}

async function cancelIngestionQueueJob(
  queue: IngestionJobQueue,
  flags: ReadonlyMap<string, readonly string[]>,
  requestedAt: string
): Promise<ProductionIngestionQueueMutationResult> {
  const queueId = requiredFlag(flags, "queue-id");
  const existing = await requiredQueueJob(queue, queueId);
  if (existing.status !== "queued" && existing.status !== "leased") {
    throw new ProductionRagRequestError(
      `Only queued or leased ingestion queue jobs can be cancelled; "${queueId}" is ${existing.status}.`
    );
  }

  const reason = firstFlag(flags, "reason");
  const cancelled = await queue.cancel({
    queueId,
    now: firstFlag(flags, "requested-at") ?? requestedAt,
    ...(reason === undefined ? {} : { reason })
  });
  return {
    status: "cancelled",
    queueJob: summarizeQueueJob(cancelled)
  };
}

async function requeueIngestionQueueJob(
  queue: IngestionJobQueue,
  flags: ReadonlyMap<string, readonly string[]>,
  requestedAt: string
): Promise<ProductionIngestionQueueMutationResult> {
  const queueId = requiredFlag(flags, "queue-id");
  const existing = await requiredQueueJob(queue, queueId);
  if (existing.status !== "dead_letter") {
    throw new ProductionRagRequestError(
      `Only dead-letter ingestion queue jobs can be requeued; "${queueId}" is ${existing.status}.`
    );
  }

  const availableAt = firstFlag(flags, "available-at");
  const maxAttempts = optionalPositiveIntegerFlag(flags, "max-attempts");
  const reason = firstFlag(flags, "reason");
  const metadata = optionalMetadataField(flags).metadata;
  const requeued = await queue.requeue({
    queueId,
    now: firstFlag(flags, "requested-at") ?? requestedAt,
    ...(availableAt === undefined ? {} : { availableAt }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(reason === undefined ? {} : { reason }),
    ...(metadata === undefined ? {} : { metadata })
  });
  return {
    status: "requeued",
    queueJob: summarizeQueueJob(requeued)
  };
}

async function requiredQueueJob(
  queue: IngestionJobQueue,
  queueId: string
): Promise<IngestionQueueJob> {
  const existing = await queue.get(queueId);
  if (existing === undefined) {
    throw new ProductionRagRequestError(`Ingestion queue job "${queueId}" does not exist.`);
  }
  return existing;
}

async function inspectIndexGenerations(
  store: IndexGenerationStore,
  flags: ReadonlyMap<string, readonly string[]>
): Promise<ProductionIndexGenerationInspectResult> {
  const filter = indexGenerationListFilterFromFlags(flags);
  const manifests = await store.listManifests(filter);
  return {
    manifests,
    count: manifests.length,
    filter
  };
}

async function inspectGenerationPromotion(
  store: IndexGenerationStore,
  flags: ReadonlyMap<string, readonly string[]>
): Promise<GenerationPromotionRecord> {
  const promotionId = requiredFlag(flags, "promotion-id");
  const promotion = await store.getPromotion(promotionId);
  if (promotion === undefined) {
    throw new ProductionRagRequestError(`Generation promotion "${promotionId}" does not exist.`);
  }
  return promotion;
}

async function planGenerationPromotionCommand(input: {
  readonly store: IndexGenerationStore;
  readonly flags: ReadonlyMap<string, readonly string[]>;
  readonly config: ProductionRagAppConfig;
  readonly requestedAt: string;
}): Promise<ProductionGenerationPromotionPlanResult> {
  const plannedAt = firstFlag(input.flags, "requested-at") ?? input.requestedAt;
  const tenantId = requiredFlag(input.flags, "tenant-id");
  const namespaceId = firstFlag(input.flags, "namespace-id") ?? input.config.profile.namespaceId;
  const profileId = firstFlag(input.flags, "profile-id") ?? input.config.profile.id;
  const promotionId = requiredFlag(input.flags, "promotion-id");
  const candidate = candidateGenerationFromFlags({
    flags: input.flags,
    tenantId,
    namespaceId,
    profileId,
    createdAt: plannedAt
  });
  const active = await activeGenerationForPromotion(
    input.store,
    input.flags,
    tenantId,
    namespaceId
  );
  const requiredEvalIds = optionalRequiredEvalIdsField(input.flags).requiredEvalIds;
  const archivePrevious = optionalCliBooleanFlag(input.flags, "archive-previous");
  const promotion = planGenerationPromotion({
    candidate,
    ...(active === undefined ? {} : { active }),
    ...(requiredEvalIds === undefined ? {} : { requiredEvalIds }),
    ...(archivePrevious === undefined ? {} : { archivePrevious }),
    plannedAt
  });
  const dryRun = optionalCliBooleanFlag(input.flags, "dry-run") ?? false;
  if (dryRun) {
    return {
      status: "planned",
      dryRun,
      promotionId,
      candidateGeneration: candidate,
      ...(active === undefined ? {} : { activeGeneration: active }),
      promotion
    };
  }

  const replace = optionalCliBooleanFlag(input.flags, "replace") ?? false;
  const existing = await input.store.getPromotion(promotionId);
  if (existing !== undefined && !replace) {
    throw new ProductionRagRequestError(
      `Generation promotion "${promotionId}" already exists. Pass --replace true to overwrite the plan.`
    );
  }

  const service = new IndexGenerationPromotionService({
    store: input.store,
    now: () => plannedAt
  });
  const saved = await service.planPromotion({
    promotionId,
    candidate,
    ...(active === undefined ? {} : { active }),
    ...(requiredEvalIds === undefined ? {} : { requiredEvalIds }),
    ...(archivePrevious === undefined ? {} : { archivePrevious }),
    plannedAt
  });

  return {
    status: "saved",
    dryRun,
    promotionId,
    candidateGeneration: candidate,
    ...(active === undefined ? {} : { activeGeneration: active }),
    promotion: saved
  };
}

async function activeGenerationForPromotion(
  store: IndexGenerationStore,
  flags: ReadonlyMap<string, readonly string[]>,
  tenantId: string,
  namespaceId: string
): Promise<IndexGenerationManifest | undefined> {
  const activeGenerationId = firstFlag(flags, "active-generation-id");
  const active =
    activeGenerationId === undefined
      ? await store.getActiveManifest({ tenantId, namespaceId })
      : await store.getManifest(activeGenerationId);
  if (activeGenerationId !== undefined && active === undefined) {
    throw new ProductionRagRequestError(
      `Active index generation "${activeGenerationId}" does not exist.`
    );
  }
  if (active === undefined) {
    return undefined;
  }
  if (active.tenantId !== tenantId || active.namespaceId !== namespaceId) {
    throw new ProductionRagRequestError(
      `Active index generation "${active.generationId}" is outside tenant/namespace scope.`
    );
  }
  if (active.status !== "active") {
    throw new ProductionRagRequestError(
      `Active index generation "${active.generationId}" has status ${active.status}.`
    );
  }
  return active;
}

async function recordGenerationEval(
  store: IndexGenerationStore,
  flags: ReadonlyMap<string, readonly string[]>,
  requestedAt: string
): Promise<GenerationPromotionRecord> {
  const recordedAt =
    firstFlag(flags, "recorded-at") ?? firstFlag(flags, "requested-at") ?? requestedAt;
  const reportUri = firstFlag(flags, "report-uri");
  const summary = firstFlag(flags, "summary");
  const service = new IndexGenerationPromotionService({
    store,
    now: () => recordedAt
  });
  return service.recordEvalResult({
    promotionId: requiredFlag(flags, "promotion-id"),
    evalId: requiredFlag(flags, "eval-id"),
    status: requiredGenerationEvalStatusFlag(flags),
    recordedAt,
    ...(reportUri === undefined ? {} : { reportUri }),
    ...(summary === undefined ? {} : { summary })
  });
}

async function promoteGeneration(
  store: IndexGenerationStore,
  flags: ReadonlyMap<string, readonly string[]>,
  requestedAt: string
): Promise<GenerationPromotionRecord> {
  const promotedAt =
    firstFlag(flags, "promoted-at") ?? firstFlag(flags, "requested-at") ?? requestedAt;
  const service = new IndexGenerationPromotionService({
    store,
    now: () => promotedAt
  });
  return service.promote({
    promotionId: requiredFlag(flags, "promotion-id"),
    promotedAt
  });
}

function indexGenerationListFilterFromFlags(
  flags: ReadonlyMap<string, readonly string[]>
): IndexGenerationListFilter {
  const tenantId = firstFlag(flags, "tenant-id");
  const namespaceId = firstFlag(flags, "namespace-id");
  const statuses = optionalIndexGenerationStatuses(flags);
  const limit = optionalPositiveIntegerFlag(flags, "limit");
  return {
    ...(tenantId === undefined ? {} : { tenantId }),
    ...(namespaceId === undefined ? {} : { namespaceId }),
    ...(statuses === undefined ? {} : { statuses }),
    ...(limit === undefined ? {} : { limit })
  };
}

function optionalIndexGenerationStatuses(
  flags: ReadonlyMap<string, readonly string[]>
): readonly IndexGenerationStatus[] | undefined {
  const values = allFlags(flags, "generation-status");
  if (values.length === 0) {
    return undefined;
  }

  const allowed = new Set<string>(INDEX_GENERATION_STATUSES);
  const invalid = values.filter((value) => !allowed.has(value));
  if (invalid.length > 0) {
    throw new ProductionRagRequestError(
      `--generation-status must be one of: ${INDEX_GENERATION_STATUSES.join(", ")}.`
    );
  }

  return values as readonly IndexGenerationStatus[];
}

function requiredGenerationEvalStatusFlag(
  flags: ReadonlyMap<string, readonly string[]>
): GenerationEvalStatus {
  const value = requiredFlag(flags, "eval-status");
  if (value === "passed" || value === "failed") {
    return value;
  }

  throw new ProductionRagRequestError("--eval-status must be passed or failed.");
}

function ingestionQueueListFilterFromFlags(
  flags: ReadonlyMap<string, readonly string[]>
): IngestionQueueListFilter {
  const tenantId = firstFlag(flags, "tenant-id");
  const namespaceId = firstFlag(flags, "namespace-id");
  const statuses = optionalIngestionQueueStatuses(flags);
  const limit = optionalPositiveIntegerFlag(flags, "limit");
  return {
    ...(tenantId === undefined ? {} : { tenantId }),
    ...(namespaceId === undefined ? {} : { namespaceId }),
    ...(statuses === undefined ? {} : { statuses }),
    ...(limit === undefined ? {} : { limit })
  };
}

function optionalIngestionQueueStatuses(
  flags: ReadonlyMap<string, readonly string[]>
): readonly IngestionQueueStatus[] | undefined {
  const values = allFlags(flags, "status");
  if (values.length === 0) {
    return undefined;
  }

  const allowed = new Set<string>(INGESTION_QUEUE_STATUSES);
  const invalid = values.filter((value) => !allowed.has(value));
  if (invalid.length > 0) {
    throw new ProductionRagRequestError(
      `--status must be one of: ${INGESTION_QUEUE_STATUSES.join(", ")}.`
    );
  }

  return values as readonly IngestionQueueStatus[];
}

async function listIngestionJobsForInspect(
  jobStore: IngestionJobStore,
  flags: ReadonlyMap<string, readonly string[]>
): Promise<{
  readonly jobs: readonly IngestionJobRecord[];
  readonly count: number;
  readonly filter: IngestionJobListFilter;
}> {
  if (!jobStore.list) {
    throw new ProductionRagConfigError("The configured ingestion job store cannot list jobs.");
  }

  const filter = ingestionJobListFilterFromFlags(flags);
  const jobs = await jobStore.list(filter);
  return {
    jobs,
    count: jobs.length,
    filter
  };
}

function ingestionJobListFilterFromFlags(
  flags: ReadonlyMap<string, readonly string[]>
): IngestionJobListFilter {
  const tenantId = firstFlag(flags, "tenant-id");
  const namespaceId = firstFlag(flags, "namespace-id");
  const statuses = optionalIngestionJobStatuses(flags);
  const limit = optionalPositiveIntegerFlag(flags, "limit");
  return {
    ...(tenantId === undefined ? {} : { tenantId }),
    ...(namespaceId === undefined ? {} : { namespaceId }),
    ...(statuses === undefined ? {} : { statuses }),
    ...(limit === undefined ? {} : { limit })
  };
}

function optionalIngestionJobStatuses(
  flags: ReadonlyMap<string, readonly string[]>
): readonly IngestionJobStatus[] | undefined {
  const values = allFlags(flags, "status");
  if (values.length === 0) {
    return undefined;
  }

  const allowed = new Set<string>(INGESTION_JOB_STATUSES);
  const invalid = values.filter((value) => !allowed.has(value));
  if (invalid.length > 0) {
    throw new ProductionRagRequestError(
      `--status must be one of: ${INGESTION_JOB_STATUSES.join(", ")}.`
    );
  }

  return values as readonly IngestionJobStatus[];
}

function inspectIngestionRunFlags(flags: ReadonlyMap<string, readonly string[]>): {
  readonly jobId: string;
  readonly sourceId?: string;
  readonly documentStatuses?: readonly IngestionDocumentStatus[];
  readonly checkpointLimit?: number;
  readonly checkpointOffset?: number;
  readonly documentLimit?: number;
  readonly documentOffset?: number;
} {
  const sourceId = firstFlag(flags, "source-id");
  const documentStatuses = optionalIngestionDocumentStatuses(flags);
  const checkpointLimit = optionalPositiveIntegerFlag(flags, "checkpoint-limit");
  const checkpointOffset = optionalNonNegativeIntegerFlag(flags, "checkpoint-offset");
  const documentLimit = optionalPositiveIntegerFlag(flags, "document-limit");
  const documentOffset = optionalNonNegativeIntegerFlag(flags, "document-offset");
  return {
    jobId: requiredFlag(flags, "job-id"),
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(documentStatuses === undefined ? {} : { documentStatuses }),
    ...(checkpointLimit === undefined ? {} : { checkpointLimit }),
    ...(checkpointOffset === undefined ? {} : { checkpointOffset }),
    ...(documentLimit === undefined ? {} : { documentLimit }),
    ...(documentOffset === undefined ? {} : { documentOffset })
  };
}

function optionalIngestionDocumentStatuses(
  flags: ReadonlyMap<string, readonly string[]>
): readonly IngestionDocumentStatus[] | undefined {
  const values = allFlags(flags, "document-status");
  if (values.length === 0) {
    return undefined;
  }

  const allowed = new Set<string>(INGESTION_DOCUMENT_STATUSES);
  const invalid = values.filter((value) => !allowed.has(value));
  if (invalid.length > 0) {
    throw new ProductionRagRequestError(
      `--document-status must be one of: ${INGESTION_DOCUMENT_STATUSES.join(", ")}.`
    );
  }

  return values as readonly IngestionDocumentStatus[];
}

async function inspectCitationFromFlags(
  flags: ReadonlyMap<string, readonly string[]>,
  cwd: string
): Promise<ReturnType<typeof inspect.citation>> {
  const tracePath = firstFlag(flags, "trace");
  const retrievalPath = firstFlag(flags, "retrieval");
  const contextPath = firstFlag(flags, "context");
  const chunkId = firstFlag(flags, "chunk-id");
  if (
    tracePath === undefined &&
    retrievalPath === undefined &&
    contextPath === undefined &&
    chunkId === undefined
  ) {
    throw new ProductionRagRequestError(
      "inspect-citation requires --trace, --retrieval, --context, or --chunk-id."
    );
  }

  const trace =
    tracePath === undefined ? undefined : await readJsonFile<InspectTraceInput>(tracePath, cwd);
  const retrieval =
    retrievalPath === undefined
      ? undefined
      : await readJsonFile<InspectRetrievalInput>(retrievalPath, cwd);
  const context =
    contextPath === undefined
      ? undefined
      : await readJsonFile<InspectCitationContextInput>(contextPath, cwd);

  return inspect.citation({
    ...(trace === undefined ? {} : { trace }),
    ...(retrieval === undefined ? {} : { retrieval }),
    ...(context === undefined ? {} : { context }),
    ...(chunkId === undefined ? {} : { chunkId })
  });
}

function optionalCaseId(flags: ReadonlyMap<string, readonly string[]>): {
  readonly caseId?: string;
} {
  const caseId = firstFlag(flags, "case-id");
  return caseId === undefined ? {} : { caseId };
}

async function readJsonFile<T>(filePath: string, cwd: string): Promise<T> {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  try {
    return JSON.parse(await readFile(absolutePath, "utf8")) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ProductionRagRequestError(`File must contain valid JSON: ${absolutePath}`);
    }
    throw error;
  }
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
  const companyExportName =
    readEnv(input.env, "RAG_COMPANY_DEPLOYMENT_EXPORT") ??
    readEnv(input.env, "RAG_COMPANY_PROFILE_EXPORT");
  const loaded = await loadCompanyDeploymentModule({
    modulePath,
    cwd: input.cwd,
    ...(companyExportName === undefined ? {} : { companyExportName }),
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
    moduleExportName: runtime.loaded.moduleExportName,
    companyExportName: runtime.loaded.companyExportName,
    companyExportPath: runtime.loaded.companyExportPath,
    ...(runtime.loaded.deploymentExportName === undefined
      ? {}
      : { deploymentExportName: runtime.loaded.deploymentExportName }),
    adapterPackExports: runtime.loaded.adapterPackExportNames,
    adapterPackCount: runtime.loaded.adapterPacks.length,
    ...(runtime.loaded.environment === undefined
      ? {}
      : { environment: safeCompanyEnvironmentManifest(runtime.loaded.environment) }),
    ...(runtime.loaded.evals === undefined
      ? {}
      : { evals: safeCompanyEvalManifest(runtime.loaded.evals) }),
    ...(runtime.loaded.smoke === undefined
      ? {}
      : { smoke: safeCompanySmokeManifest(runtime.loaded.smoke) }),
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

function safeCompanyEnvironmentManifest(
  environment: NonNullable<LoadedCompanyDeploymentModule["environment"]>
): unknown {
  return {
    requiredEnv: safeStringArray(environment.requiredEnv),
    optionalEnv: safeStringArray(environment.optionalEnv)
  };
}

function safeCompanyEvalManifest(
  evals: NonNullable<LoadedCompanyDeploymentModule["evals"]>
): unknown {
  return {
    requiredPaths: safeStringArray(evals.requiredPaths),
    goldenSetPaths: safeStringArray(evals.goldenSetPaths),
    adversarialSetPaths: safeStringArray(evals.adversarialSetPaths)
  };
}

function safeCompanySmokeManifest(
  smoke: NonNullable<LoadedCompanyDeploymentModule["smoke"]>
): unknown {
  return {
    ...(smoke.validateCommand === undefined
      ? {}
      : { validateCommand: redactText(smoke.validateCommand) }),
    ...(smoke.packContractsCommand === undefined
      ? {}
      : { packContractsCommand: redactText(smoke.packContractsCommand) }),
    ...(smoke.smokeCommand === undefined ? {} : { smokeCommand: redactText(smoke.smokeCommand) }),
    ...(smoke.postgresSmokeCommand === undefined
      ? {}
      : { postgresSmokeCommand: redactText(smoke.postgresSmokeCommand) })
  };
}

function safeStringArray(values: readonly string[] | undefined): readonly string[] {
  return (values ?? []).map((value) => redactText(value));
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

function enqueueIngestionPlanFromFlags(input: {
  readonly flags: ReadonlyMap<string, readonly string[]>;
  readonly profileId: string;
  readonly defaultNamespaceId: string;
  readonly requestedAt: string;
}): ProductionIngestionEnqueuePlan {
  const mode = optionalEnqueueModeFlag(input.flags) ?? "backfill";
  const tenantId = requiredFlag(input.flags, "tenant-id");
  const namespaceId = firstFlag(input.flags, "namespace-id") ?? input.defaultNamespaceId;
  const sourceIds = optionalFlags(input.flags, "source-id");
  if (sourceIds === undefined || sourceIds.length === 0) {
    throw new ProductionRagRequestError("--source-id is required.");
  }

  const common = {
    planId: requiredFlag(input.flags, "plan-id"),
    tenantId,
    namespaceId,
    sourceIds,
    requestedAt: firstFlag(input.flags, "requested-at") ?? input.requestedAt,
    batchSize: requiredPositiveIntegerFlag(input.flags, "batch-size"),
    ...optionalNonNegativeIntegerField(input.flags, "priority", "priority"),
    ...optionalPositiveIntegerField(input.flags, "max-attempts", "maxAttempts"),
    ...optionalStringField(input.flags, "available-at", "availableAt"),
    ...optionalMetadataField(input.flags)
  };
  const dryRun = optionalCliBooleanFlag(input.flags, "dry-run") ?? false;
  const profileId = firstFlag(input.flags, "profile-id") ?? input.profileId;

  if (mode === "backfill") {
    return {
      mode,
      dryRun,
      plan: planIngestionBackfillJobs(common)
    };
  }

  const reindexPlan = planReindex({
    ...common,
    candidateGeneration: candidateGenerationFromFlags({
      flags: input.flags,
      tenantId,
      namespaceId,
      profileId,
      createdAt: common.requestedAt
    }),
    ...activeGenerationFieldFromFlags(
      input.flags,
      tenantId,
      namespaceId,
      profileId,
      common.requestedAt
    ),
    ...optionalRequiredEvalIdsField(input.flags)
  });
  return {
    mode,
    dryRun,
    plan: reindexPlan.backfill,
    candidateGeneration: reindexPlan.candidateGeneration,
    promotion: reindexPlan.promotion
  };
}

function optionalEnqueueModeFlag(
  flags: ReadonlyMap<string, readonly string[]>
): ProductionIngestionEnqueueMode | undefined {
  const value = firstFlag(flags, "mode");
  if (value === undefined) {
    return undefined;
  }
  if (value === "backfill" || value === "reindex") {
    return value;
  }

  throw new ProductionRagRequestError("--mode must be backfill or reindex.");
}

function candidateGenerationFromFlags(input: {
  readonly flags: ReadonlyMap<string, readonly string[]>;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly profileId: string;
  readonly createdAt: string;
}): IndexGenerationManifest {
  const chunkerVersion = firstFlag(input.flags, "chunker-version");
  const evalReportUri = firstFlag(input.flags, "eval-report-uri");
  return {
    generationId: requiredFlag(input.flags, "generation-id"),
    tenantId: input.tenantId,
    namespaceId: input.namespaceId,
    profileId: input.profileId,
    status: "candidate",
    embeddingProvider: requiredFlag(input.flags, "embedding-provider"),
    embeddingModel: requiredFlag(input.flags, "embedding-model"),
    embeddingDimensions: requiredPositiveIntegerFlag(input.flags, "embedding-dimensions"),
    embeddingConfigHash: requiredFlag(input.flags, "embedding-config-hash"),
    embeddingIndexConfigHash: requiredFlag(input.flags, "embedding-index-config-hash"),
    chunkingPolicyId: requiredFlag(input.flags, "chunking-policy-id"),
    chunkingPolicyVersion: requiredPositiveIntegerFlag(input.flags, "chunking-policy-version"),
    ...(chunkerVersion === undefined ? {} : { chunkerVersion }),
    createdAt: input.createdAt,
    ...(evalReportUri === undefined ? {} : { evalReportUri })
  };
}

function activeGenerationFieldFromFlags(
  flags: ReadonlyMap<string, readonly string[]>,
  tenantId: string,
  namespaceId: string,
  profileId: string,
  createdAt: string
): { readonly activeGeneration?: IndexGenerationManifest } {
  const activeGenerationId = firstFlag(flags, "active-generation-id");
  if (activeGenerationId === undefined) {
    return {};
  }

  const activeGeneration: IndexGenerationManifest = {
    generationId: activeGenerationId,
    tenantId,
    namespaceId,
    profileId,
    status: "active",
    embeddingProvider: requiredFlag(flags, "embedding-provider"),
    embeddingModel: requiredFlag(flags, "embedding-model"),
    embeddingDimensions: requiredPositiveIntegerFlag(flags, "embedding-dimensions"),
    embeddingConfigHash: requiredFlag(flags, "embedding-config-hash"),
    embeddingIndexConfigHash: requiredFlag(flags, "embedding-index-config-hash"),
    chunkingPolicyId: requiredFlag(flags, "chunking-policy-id"),
    chunkingPolicyVersion: requiredPositiveIntegerFlag(flags, "chunking-policy-version"),
    createdAt,
    promotedAt: createdAt
  };
  return { activeGeneration };
}

function optionalRequiredEvalIdsField(flags: ReadonlyMap<string, readonly string[]>): {
  readonly requiredEvalIds?: readonly string[];
} {
  const requiredEvalIds = optionalFlags(flags, "required-eval-id");
  return requiredEvalIds === undefined ? {} : { requiredEvalIds };
}

function optionalMetadataField(flags: ReadonlyMap<string, readonly string[]>): {
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
} {
  const entries = allFlags(flags, "metadata");
  if (entries.length === 0) {
    return {};
  }

  const metadata: Record<string, string | number | boolean> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 1) {
      throw new ProductionRagRequestError("--metadata values must use key=value.");
    }
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/u.test(key)) {
      throw new ProductionRagRequestError(
        "--metadata keys must start with a letter or underscore and contain only letters, numbers, underscore, dot, or dash."
      );
    }
    metadata[key] = scalarMetadataValue(value);
  }

  return { metadata };
}

function scalarMetadataValue(value: string): string | number | boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) || !Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return value;
}

function optionalStringField<TName extends string>(
  flags: ReadonlyMap<string, readonly string[]>,
  flagName: string,
  outputName: TName
): { readonly [key in TName]?: string } {
  const value = firstFlag(flags, flagName);
  return value === undefined
    ? {}
    : ({ [outputName]: value } as { readonly [key in TName]?: string });
}

function optionalPositiveIntegerField<TName extends string>(
  flags: ReadonlyMap<string, readonly string[]>,
  flagName: string,
  outputName: TName
): { readonly [key in TName]?: number } {
  const value = optionalPositiveIntegerFlag(flags, flagName);
  return value === undefined
    ? {}
    : ({ [outputName]: value } as { readonly [key in TName]?: number });
}

function optionalNonNegativeIntegerField<TName extends string>(
  flags: ReadonlyMap<string, readonly string[]>,
  flagName: string,
  outputName: TName
): { readonly [key in TName]?: number } {
  const value = optionalNonNegativeIntegerFlag(flags, flagName);
  return value === undefined
    ? {}
    : ({ [outputName]: value } as { readonly [key in TName]?: number });
}

function summarizeEnqueueCommandResult(input: {
  readonly enqueuePlan: ProductionIngestionEnqueuePlan;
  readonly enqueuedJobs: readonly IngestionQueueJob[];
}): ProductionIngestionEnqueueCommandResult {
  return {
    mode: input.enqueuePlan.mode,
    dryRun: input.enqueuePlan.dryRun,
    planId: input.enqueuePlan.plan.planId,
    tenantId: input.enqueuePlan.plan.tenantId,
    namespaceId: input.enqueuePlan.plan.namespaceId,
    requestedAt: input.enqueuePlan.plan.requestedAt,
    batchSize: input.enqueuePlan.plan.batchSize,
    plannedJobCount: input.enqueuePlan.plan.jobCount,
    enqueuedJobCount: input.enqueuedJobs.length,
    plannedJobs: input.enqueuePlan.plan.jobs.map(summarizePlannedJob),
    ...(input.enqueuedJobs.length === 0
      ? {}
      : { enqueuedJobs: input.enqueuedJobs.map(summarizeQueueJob) }),
    ...(input.enqueuePlan.candidateGeneration === undefined
      ? {}
      : { candidateGeneration: input.enqueuePlan.candidateGeneration }),
    ...(input.enqueuePlan.promotion === undefined ? {} : { promotion: input.enqueuePlan.promotion })
  };
}

function summarizePlannedJob(job: EnqueueIngestionJobInput): ProductionIngestionEnqueuePlannedJob {
  return {
    ...(job.queueId === undefined ? {} : { queueId: job.queueId }),
    jobId: job.jobId,
    ...(job.runId === undefined ? {} : { runId: job.runId }),
    tenantId: job.tenantId,
    namespaceId: job.namespaceId,
    sourceIds: job.sourceIds,
    ...(job.priority === undefined ? {} : { priority: job.priority }),
    ...(job.maxAttempts === undefined ? {} : { maxAttempts: job.maxAttempts }),
    ...(job.availableAt === undefined ? {} : { availableAt: job.availableAt }),
    enqueuedAt: job.enqueuedAt,
    ...(job.metadata === undefined ? {} : { metadata: job.metadata })
  };
}

function workerIdFromFlags(
  flags: ReadonlyMap<string, readonly string[]>,
  env: ProviderEnv
): string {
  return (
    firstFlag(flags, "worker-id") ??
    readEnv(env, "RAG_WORKER_ID") ??
    `ingestion_worker_${process.pid}`
  );
}

function workerOptionsFromFlags(flags: ReadonlyMap<string, readonly string[]>): {
  readonly leaseTtlMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly leaseConflictRetryMs?: number;
  readonly retryFailedJobs?: boolean;
  readonly overwriteMode?: IndexOverwriteMode;
} {
  const leaseTtlMs = optionalPositiveIntegerFlag(flags, "lease-ttl-ms");
  const heartbeatIntervalMs = optionalNonNegativeIntegerFlag(flags, "heartbeat-interval-ms");
  const leaseConflictRetryMs = optionalPositiveIntegerFlag(flags, "lease-conflict-retry-ms");
  const retryFailedJobs = optionalCliBooleanFlag(flags, "retry-failed-jobs");
  const overwriteMode = optionalOverwriteModeFlag(flags);
  return {
    ...(leaseTtlMs === undefined ? {} : { leaseTtlMs }),
    ...(heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs }),
    ...(leaseConflictRetryMs === undefined ? {} : { leaseConflictRetryMs }),
    ...(retryFailedJobs === undefined ? {} : { retryFailedJobs }),
    ...(overwriteMode === undefined ? {} : { overwriteMode })
  };
}

function workerRunLoopInputFromFlags(
  flags: ReadonlyMap<string, readonly string[]>
): ProductionIngestionWorkerRunLoopInput {
  const maxJobs = optionalPositiveIntegerFlag(flags, "max-jobs");
  const tenantId = firstFlag(flags, "tenant-id");
  const namespaceId = firstFlag(flags, "namespace-id");
  const sourceIds = optionalFlags(flags, "source-id");
  const requestedAt = firstFlag(flags, "requested-at");
  const overwriteMode = optionalOverwriteModeFlag(flags);
  return {
    ...(maxJobs === undefined ? {} : { maxJobs }),
    ...(tenantId === undefined ? {} : { tenantId }),
    ...(namespaceId === undefined ? {} : { namespaceId }),
    ...(sourceIds === undefined ? {} : { sourceIds }),
    ...(requestedAt === undefined ? {} : { requestedAt }),
    ...(overwriteMode === undefined ? {} : { overwriteMode })
  };
}

function workerPrincipalForJobFromFlags(
  flags: ReadonlyMap<string, readonly string[]>
): (job: IngestionQueueJob) => RequestPrincipal {
  return (job) => {
    const principalNamespaceIds = allFlags(flags, "principal-namespace-id");
    const namespaceIds =
      principalNamespaceIds.length === 0 ? [job.namespaceId] : principalNamespaceIds;
    if (!namespaceIds.includes(job.namespaceId)) {
      throw new ProductionRagRequestError(
        "--principal-namespace-id must include the queued job namespace-id."
      );
    }

    const roles = allFlags(flags, "role");
    return {
      userId: firstFlag(flags, "user-id") ?? "ingestion_worker",
      tenantId: firstFlag(flags, "principal-tenant-id") ?? job.tenantId,
      namespaceIds,
      teamIds: allFlags(flags, "team-id"),
      roles: roles.length === 0 ? ["ingestion_worker"] : roles,
      tags: allFlags(flags, "tag")
    };
  };
}

function summarizeWorkerCommandResult(
  result: ProductionIngestionWorkerRunLoopResult
): ProductionIngestionWorkerCommandResult {
  return {
    workerId: result.workerId,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    attemptedCount: result.attemptedCount,
    completedCount: result.completedCount,
    failedCount: result.failedCount,
    leaseConflictCount: result.leaseConflictCount,
    idleCount: result.idleCount,
    results: result.results.map(summarizeWorkerJobResult)
  };
}

function summarizeWorkerJobResult(
  result: ProductionIngestionWorkerRunOnceResult
): ProductionIngestionWorkerCommandJobResult {
  return {
    status: result.status,
    workerId: result.workerId,
    checkedAt: result.checkedAt,
    ...(result.queueJob === undefined ? {} : { queueJob: summarizeQueueJob(result.queueJob) }),
    ...(result.ingestion === undefined ? {} : { ingestion: summarizeIngestion(result.ingestion) }),
    ...(result.errorName === undefined ? {} : { errorName: result.errorName }),
    ...(result.errorMessage === undefined ? {} : { errorMessage: result.errorMessage })
  };
}

function summarizeQueueJob(job: IngestionQueueJob): ProductionIngestionWorkerCommandQueueJob {
  return {
    queueId: job.queueId,
    jobId: job.jobId,
    ...(job.runId === undefined ? {} : { runId: job.runId }),
    tenantId: job.tenantId,
    namespaceId: job.namespaceId,
    sourceIds: job.sourceIds,
    status: job.status,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    availableAt: job.availableAt,
    updatedAt: job.updatedAt,
    ...(job.leasedBy === undefined ? {} : { leasedBy: job.leasedBy }),
    ...(job.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: job.leaseExpiresAt }),
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(job.errorName === undefined ? {} : { errorName: job.errorName }),
    ...(job.errorMessage === undefined ? {} : { errorMessage: job.errorMessage }),
    ...(job.metadata === undefined ? {} : { metadata: job.metadata })
  };
}

function summarizeIngestion(
  ingestion: ProductionRagIngestResponse
): ProductionIngestionWorkerCommandIngestion {
  return {
    status: ingestion.status,
    runId: ingestion.runId,
    startedAt: ingestion.startedAt,
    finishedAt: ingestion.finishedAt,
    loadedSourceIds: ingestion.loadedSourceIds,
    counts: ingestion.counts,
    index: ingestion.index,
    ...(ingestion.vector === undefined ? {} : { vector: ingestion.vector }),
    ...(ingestion.visualVector === undefined ? {} : { visualVector: ingestion.visualVector }),
    parserQuality: ingestion.parserQuality,
    integrity: ingestion.integrity,
    warnings: ingestion.warnings
  };
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

function isStorageOnlyCommand(command: string): boolean {
  return STORAGE_ONLY_COMMANDS.has(command);
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

function optionalPositiveIntegerFlag(
  flags: ReadonlyMap<string, readonly string[]>,
  flagName: string
): number | undefined {
  const value = firstFlag(flags, flagName);
  if (value === undefined) {
    return undefined;
  }

  if (!/^[0-9]+$/u.test(value)) {
    throw new ProductionRagRequestError(`--${flagName} must be a positive integer.`);
  }

  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) {
    throw new ProductionRagRequestError(`--${flagName} must be a positive integer.`);
  }

  return parsed;
}

function requiredPositiveIntegerFlag(
  flags: ReadonlyMap<string, readonly string[]>,
  flagName: string
): number {
  const value = optionalPositiveIntegerFlag(flags, flagName);
  if (value === undefined) {
    throw new ProductionRagRequestError(`--${flagName} is required.`);
  }
  return value;
}

function optionalNonNegativeIntegerFlag(
  flags: ReadonlyMap<string, readonly string[]>,
  flagName: string
): number | undefined {
  const value = firstFlag(flags, flagName);
  if (value === undefined) {
    return undefined;
  }

  if (!/^[0-9]+$/u.test(value)) {
    throw new ProductionRagRequestError(`--${flagName} must be a non-negative integer.`);
  }

  return Number.parseInt(value, 10);
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
