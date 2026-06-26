import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { CitationPointer } from "../documents/provenance.js";
import {
  HostedVectorStore,
  type HostedVectorStoreTransport
} from "../indexing/hosted-vector-store.js";
import { HostedVisualVectorStore } from "../indexing/hosted-visual-vector-store.js";
import type { VisualEmbeddingAdapter } from "../embeddings/visual-embedding-types.js";
import {
  HostedVectorHttpClient,
  PgVectorRpcHostedVectorTransport,
  PineconeHostedVectorTransport,
  QdrantHostedVectorTransport,
  WeaviateHostedVectorTransport,
  type HostedVectorFetchLike,
  type HostedVectorTransportSecrets,
  type HostedVectorVendor
} from "../indexing/hosted-vector-vendor-transports.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { PostgresRagIndex } from "../indexing/postgres-index.js";
import { SqliteRagIndex } from "../indexing/sqlite-rag-index.js";
import { PostgresVectorStore } from "../indexing/postgres-vector-store.js";
import type { ChunkStore } from "../indexing/chunk-store.js";
import type { DocumentStore } from "../indexing/document-store.js";
import type { IndexCapabilities, IndexFilter, IndexStats } from "../indexing/index-types.js";
import { JsonFileRagIndex } from "../indexing/json-file-index.js";
import { JsonFileVisualVectorStore } from "../indexing/json-file-visual-vector-store.js";
import { JsonFileVectorStore } from "../indexing/json-file-vector-store.js";
import {
  InMemoryVectorStore,
  type VectorStore,
  type VectorStoreCapabilities
} from "../indexing/vector-store.js";
import {
  InMemoryVisualVectorStore,
  type VisualVectorStore,
  type VisualVectorStoreCapabilities
} from "../indexing/visual-vector-store.js";
import {
  InMemorySourceSyncLedgerStore,
  PostgresSourceSyncLedgerStore,
  type SourceSyncLedgerStore
} from "../sync/sync-ledger.js";
import { breakawaySupportProfile } from "../profiles/examples/breakaway-support.profile.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { ultimateDefaultProfile } from "../profiles/presets/ultimate-default.profile.js";
import type { RagProfile } from "../profiles/profile.js";
import { assertValidProfile, type ValidatedRagProfile } from "../profiles/profile-validation.js";
import type { ProviderTransport } from "../shared/provider-boundary.js";
import type { ProviderEnv } from "../shared/provider-runtime-config.js";
import {
  assembleLiveRagRuntimeFromEnv,
  type LiveAssembledRagRuntime,
  type LiveEmbeddingProviderMode,
  type LiveOptionalProviderMode,
  type LiveRagRuntimeFromEnvConfig
} from "./live-runtime-config.js";
import type { RagAnswerResult } from "./runtime-types.js";
import {
  runStartupSelfTest,
  type StartupSelfTestOptions,
  type StartupSelfTestResult
} from "./startup-self-test.js";

export type ProductionProfilePresetId = "generic-docs" | "breakaway-support" | "ultimate-default";

export type ProductionIndexStorageConfig =
  | {
      readonly kind: "memory";
    }
  | {
      readonly kind: "json_file";
      readonly path: string;
      readonly autosave?: boolean;
      readonly pretty?: boolean;
    }
  | {
      readonly kind: "sqlite";
      readonly path: string;
    }
  | {
      readonly kind: "postgres";
      readonly connectionString: string;
      readonly schema?: string;
    };

export type ProductionVectorStorageConfig =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "memory";
      readonly dimensions?: number;
    }
  | {
      readonly kind: "json_file";
      readonly path: string;
      readonly dimensions?: number;
      readonly autosave?: boolean;
      readonly pretty?: boolean;
    }
  | {
      readonly kind: "postgres";
      readonly connectionString: string;
      readonly schema?: string;
      readonly dimensions?: number;
    }
  | ProductionHostedVectorStorageConfig;

export type ProductionVisualVectorStorageConfig =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "memory";
      readonly dimensions?: number;
    }
  | {
      readonly kind: "json_file";
      readonly path: string;
      readonly dimensions?: number;
      readonly autosave?: boolean;
      readonly pretty?: boolean;
    }
  | ProductionHostedVectorStorageConfig;

export interface ProductionHostedVectorStorageConfig {
  readonly kind: "hosted";
  readonly vendor: HostedVectorVendor;
  readonly endpoint: string;
  readonly dimensions?: number;
  readonly apiKeyEnv?: string;
  readonly namespace?: string;
  readonly deleteNamespaces?: readonly string[];
  readonly apiVersion?: string;
  readonly collectionName?: string;
  readonly vectorName?: string;
  readonly waitForWrites?: boolean;
  readonly tenant?: string;
  readonly tableName?: string;
  readonly matchFunctionName?: string;
  readonly schema?: string;
}

export type ProductionSourceSyncLedgerStorageConfig =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "memory";
    }
  | {
      readonly kind: "postgres";
      readonly connectionString: string;
      readonly schema?: string;
    };

export interface ProductionStorageConfig {
  readonly index: ProductionIndexStorageConfig;
  readonly vector?: ProductionVectorStorageConfig;
  readonly visualVector?: ProductionVisualVectorStorageConfig;
  readonly sourceSyncLedger?: ProductionSourceSyncLedgerStorageConfig;
}

export interface ProductionProviderRuntimeConfig {
  readonly modelPrefix: string;
  readonly embeddingPrefix: string;
  readonly visualEmbeddingPrefix: string;
  readonly rerankPrefix: string;
  readonly groundingJudgePrefix: string;
  readonly embeddingMode: LiveEmbeddingProviderMode;
  readonly visualEmbeddingMode: LiveEmbeddingProviderMode;
  readonly rerankProviderMode: LiveOptionalProviderMode;
  readonly groundingJudgeProviderMode: LiveOptionalProviderMode;
}

export interface ProductionHttpConfig {
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly auth: ProductionHttpAuthConfig;
  readonly rateLimit: ProductionHttpRateLimitConfig;
  readonly operations: ProductionHttpOperationsConfig;
}

export type ProductionHttpAuthMode = "required" | "disabled";

export interface ProductionHttpAuthConfig {
  readonly mode: ProductionHttpAuthMode;
  readonly headerName: string;
  readonly tokenSha256s: readonly string[];
}

export type ProductionHttpRateLimitMode = "enabled" | "disabled";

export interface ProductionHttpRateLimitConfig {
  readonly mode: ProductionHttpRateLimitMode;
  readonly windowMs: number;
  readonly maxRequests: number;
  readonly maxKeys: number;
  readonly clientIpHeader?: string;
}

export type ProductionHttpLogMode = "json" | "disabled";

export interface ProductionHttpOperationsConfig {
  readonly logMode: ProductionHttpLogMode;
  readonly requestIdHeader: string;
  readonly readinessPath: string;
  readonly metricsPath: string;
}

export interface ProductionRagAppConfig {
  readonly profile: RagProfile | ValidatedRagProfile;
  readonly storage: ProductionStorageConfig;
  readonly providers: ProductionProviderRuntimeConfig;
  readonly http: ProductionHttpConfig;
}

export interface LoadProductionRagAppConfigFromEnvOptions {
  readonly env?: ProviderEnv;
  readonly cwd?: string;
  readonly defaults?: Partial<ProductionRagAppConfig>;
}

export interface ProductionRagAppOptions {
  readonly config: ProductionRagAppConfig;
  readonly env?: ProviderEnv;
  readonly transport?: ProviderTransport;
  readonly graph?: LiveRagRuntimeFromEnvConfig["graph"];
  readonly vectorFetch?: HostedVectorFetchLike;
  readonly chunkStore?: ProductionIndexStore;
  readonly vectorStore?: VectorStore;
  readonly visualVectorStore?: VisualVectorStore;
  readonly sourceSyncLedgerStore?: SourceSyncLedgerStore;
  readonly visualEmbeddingAdapter?: VisualEmbeddingAdapter;
  readonly now?: () => string;
  readonly nowMs?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export type ProductionIndexStore = DocumentStore &
  ChunkStore & {
    readonly capabilities: IndexCapabilities;
    stats(): IndexStats | Promise<IndexStats>;
  };

export interface ProductionRagAnswerInput {
  readonly question: string;
  readonly tenantId: string;
  readonly namespaceId?: string;
  readonly principal: unknown;
  readonly filters?: unknown;
  readonly topK?: unknown;
  readonly candidatePoolLimit?: unknown;
  readonly includeRejected?: unknown;
  readonly requestedAt?: unknown;
  readonly runId?: unknown;
  readonly traceId?: unknown;
}

export interface ProductionRagAnswerResponse {
  readonly status: RagAnswerResult["status"];
  readonly answer?: string;
  readonly citationChunkIds?: readonly string[];
  readonly citations?: readonly CitationPointer[];
  readonly evidenceSummary?: string;
  readonly confidence?: string;
  readonly refusal?: unknown;
  readonly failure?: unknown;
  readonly trace: RagAnswerResult["trace"];
  readonly retrieval?: {
    readonly trace: unknown;
  };
  readonly context?: {
    readonly evidence: unknown;
    readonly trace: unknown;
  };
  readonly generation?: {
    readonly trace: unknown;
    readonly warnings: unknown;
  };
}

export interface ProductionRagHealth {
  readonly status: "ready";
  readonly profileId: string;
  readonly namespaceId: string;
  readonly retrievalMode: ValidatedRagProfile["retrieval"]["mode"];
  readonly index: {
    readonly storageKind: IndexCapabilities["storageKind"];
    readonly durable: boolean;
    readonly documentCount: number;
    readonly chunkCount: number;
  };
  readonly vector?: {
    readonly storageKind: VectorStoreCapabilities["storageKind"];
    readonly durable: boolean;
    readonly dimensions?: number;
  };
  readonly visualVector?: {
    readonly storageKind: VisualVectorStoreCapabilities["storageKind"];
    readonly durable: boolean;
    readonly dimensions?: number;
  };
  readonly sourceSyncLedger?: {
    readonly storageKind: Exclude<ProductionSourceSyncLedgerStorageConfig["kind"], "none">;
    readonly durable: boolean;
  };
  readonly providers: {
    readonly model: ProductionProviderSummary;
    readonly embedding?: ProductionProviderSummary;
    readonly visualEmbedding?: ProductionProviderSummary;
    readonly rerank?: ProductionProviderSummary;
    readonly groundingJudge?: ProductionProviderSummary;
  };
}

export interface ProductionProviderSummary {
  readonly id: string;
  readonly provider: string;
  readonly modelName: string;
}

export interface ProductionRagApp {
  readonly config: ProductionRagAppConfig;
  readonly profile: ValidatedRagProfile;
  readonly chunkStore: ProductionIndexStore;
  readonly vectorStore?: VectorStore;
  readonly visualVectorStore?: VisualVectorStore;
  readonly sourceSyncLedgerStore?: SourceSyncLedgerStore;
  readonly visualEmbeddingAdapter?: VisualEmbeddingAdapter;
  readonly runtime: LiveAssembledRagRuntime;
  answer(input: ProductionRagAnswerInput): Promise<ProductionRagAnswerResponse>;
  health(): ProductionRagHealth;
  selfTest(options?: StartupSelfTestOptions): Promise<StartupSelfTestResult>;
}

export class ProductionRagConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionRagConfigError";
  }
}

export class ProductionRagRequestError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "ProductionRagRequestError";
    this.statusCode = statusCode;
  }
}

const DEFAULT_HTTP_CONFIG: ProductionHttpConfig = {
  host: "127.0.0.1",
  port: 8787,
  maxBodyBytes: 128 * 1024,
  auth: {
    mode: "required",
    headerName: "authorization",
    tokenSha256s: []
  },
  rateLimit: {
    mode: "enabled",
    windowMs: 60_000,
    maxRequests: 60,
    maxKeys: 10_000
  },
  operations: {
    logMode: "json",
    requestIdHeader: "x-request-id",
    readinessPath: "/ready",
    metricsPath: "/metrics"
  }
};

const DEFAULT_PROVIDER_CONFIG: ProductionProviderRuntimeConfig = {
  modelPrefix: "RAG_MODEL",
  embeddingPrefix: "RAG_EMBEDDING",
  visualEmbeddingPrefix: "RAG_VISUAL_EMBEDDING",
  rerankPrefix: "RAG_RERANK",
  groundingJudgePrefix: "RAG_GROUNDING_JUDGE",
  embeddingMode: "auto",
  visualEmbeddingMode: "auto",
  rerankProviderMode: "auto",
  groundingJudgeProviderMode: "auto"
};

export function loadProductionRagAppConfigFromEnv(
  options: LoadProductionRagAppConfigFromEnvOptions = {}
): ProductionRagAppConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const profile = loadProfileFromEnv(env, cwd, options.defaults?.profile);
  const providers = loadProviderConfigFromEnv(env, options.defaults?.providers);
  const http = loadHttpConfigFromEnv(env, options.defaults?.http);
  const storage = loadStorageConfigFromEnv(env, cwd, options.defaults?.storage);

  return {
    profile,
    storage,
    providers,
    http
  };
}

export function createProductionRagApp(options: ProductionRagAppOptions): ProductionRagApp {
  const profile = assertValidProfile(options.config.profile);
  const chunkStore = options.chunkStore ?? createIndexStore(options.config.storage.index);
  const vectorStore =
    options.vectorStore ?? createVectorStore(options.config.storage.vector, chunkStore, options);
  const visualVectorStore =
    options.visualVectorStore ??
    createVisualVectorStore(options.config.storage.visualVector, chunkStore, options);
  const sourceSyncLedgerStore =
    options.sourceSyncLedgerStore ??
    createProductionSourceSyncLedgerStore(options.config.storage.sourceSyncLedger);
  const runtime = assembleLiveRagRuntimeFromEnv({
    profile,
    chunkStore,
    env: options.env ?? process.env,
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    modelPrefix: options.config.providers.modelPrefix,
    embeddingPrefix: options.config.providers.embeddingPrefix,
    visualEmbeddingPrefix: options.config.providers.visualEmbeddingPrefix,
    rerankPrefix: options.config.providers.rerankPrefix,
    groundingJudgePrefix: options.config.providers.groundingJudgePrefix,
    embedding: options.config.providers.embeddingMode,
    visualEmbedding: options.config.providers.visualEmbeddingMode,
    rerankProvider: options.config.providers.rerankProviderMode,
    groundingJudgeProvider: options.config.providers.groundingJudgeProviderMode,
    ...(vectorStore === undefined ? {} : { vectorStore }),
    ...(options.visualEmbeddingAdapter === undefined
      ? {}
      : { visualEmbeddingAdapter: options.visualEmbeddingAdapter }),
    ...(visualVectorStore === undefined ? {} : { visualVectorStore }),
    ...(options.graph === undefined ? {} : { graph: options.graph }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  });
  const visualEmbeddingAdapter = runtime.visualEmbeddingAdapter;

  return {
    config: options.config,
    profile,
    chunkStore,
    ...(vectorStore === undefined ? {} : { vectorStore }),
    ...(visualVectorStore === undefined ? {} : { visualVectorStore }),
    ...(sourceSyncLedgerStore === undefined ? {} : { sourceSyncLedgerStore }),
    ...(visualEmbeddingAdapter === undefined ? {} : { visualEmbeddingAdapter }),
    runtime,
    answer: async (input) => {
      const request = normalizeProductionAnswerInput(profile, input);
      const result = await runtime.answer(request);
      return serializeProductionAnswerResult(result);
    },
    health: () =>
      productionHealth(
        profile,
        chunkStore,
        vectorStore,
        visualVectorStore,
        sourceSyncLedgerStore,
        options.config.storage.sourceSyncLedger,
        runtime
      ),
    selfTest: (selfTestOptions = {}) =>
      runStartupSelfTest(
        {
          profile,
          runtime,
          chunkStore,
          ...(vectorStore === undefined ? {} : { vectorStore }),
          ...(visualVectorStore === undefined ? {} : { visualVectorStore })
        },
        selfTestOptions
      )
  };
}

export function serializeProductionAnswerResult(
  result: RagAnswerResult
): ProductionRagAnswerResponse {
  if ("generation" in result) {
    const draft = result.generation.draft;
    const refusal = result.generation.refusal ?? draft?.refusal;
    return {
      status: result.status,
      ...(draft?.answer === undefined ? {} : { answer: draft.answer }),
      ...(draft?.citationChunkIds === undefined
        ? {}
        : { citationChunkIds: draft.citationChunkIds }),
      ...(result.answerCitations.length === 0 ? {} : { citations: result.answerCitations }),
      ...(draft?.evidenceSummary === undefined ? {} : { evidenceSummary: draft.evidenceSummary }),
      ...(draft?.confidence === undefined ? {} : { confidence: draft.confidence }),
      ...(refusal === undefined ? {} : { refusal }),
      trace: result.trace,
      retrieval: { trace: result.retrieval.trace },
      context: { evidence: result.context.evidence, trace: result.context.trace },
      generation: {
        trace: result.generation.trace,
        warnings: result.generation.warnings
      }
    };
  }

  return {
    status: result.status,
    failure: result.failure,
    trace: result.trace,
    ...("retrieval" in result ? { retrieval: { trace: result.retrieval.trace } } : {}),
    ...("context" in result
      ? { context: { trace: result.context.trace, evidence: result.context.evidence } }
      : {})
  };
}

function normalizeProductionAnswerInput(
  profile: ValidatedRagProfile,
  input: ProductionRagAnswerInput
): Parameters<LiveAssembledRagRuntime["answer"]>[0] {
  if (!isRecord(input)) {
    throw new ProductionRagRequestError("Answer request must be a JSON object.");
  }

  const question = requiredString(input.question, "question");
  const tenantId = requiredString(input.tenantId, "tenantId");
  const namespaceId = optionalString(input.namespaceId, "namespaceId") ?? profile.namespaceId;
  const principal = normalizePrincipal(input.principal, namespaceId, tenantId);
  const filter = normalizeFilters(input.filters, namespaceId, tenantId, principal);
  const topK = optionalPositiveInteger(input.topK, "topK");
  const candidatePoolLimit = optionalPositiveInteger(
    input.candidatePoolLimit,
    "candidatePoolLimit"
  );
  const includeRejected = optionalBoolean(input.includeRejected, "includeRejected");
  const requestedAt = optionalString(input.requestedAt, "requestedAt");
  const runId = optionalString(input.runId, "runId");
  const traceId = optionalString(input.traceId, "traceId");

  return {
    question,
    filter,
    ...(topK === undefined ? {} : { topK }),
    ...(candidatePoolLimit === undefined ? {} : { candidatePoolLimit }),
    ...(includeRejected === undefined ? {} : { includeRejected }),
    ...(requestedAt === undefined ? {} : { requestedAt }),
    ...(runId === undefined ? {} : { runId }),
    ...(traceId === undefined ? {} : { traceId })
  };
}

function normalizePrincipal(
  value: unknown,
  namespaceId: string,
  tenantId: string
): IndexFilter["principal"] {
  if (!isRecord(value)) {
    throw new ProductionRagRequestError("principal must be a JSON object.");
  }

  const principal = {
    userId: requiredString(value["userId"], "principal.userId"),
    tenantId: requiredString(value["tenantId"], "principal.tenantId"),
    namespaceIds: requiredStringArray(value["namespaceIds"], "principal.namespaceIds"),
    teamIds: optionalStringArray(value["teamIds"], "principal.teamIds") ?? [],
    roles: optionalStringArray(value["roles"], "principal.roles") ?? [],
    tags: optionalStringArray(value["tags"], "principal.tags") ?? []
  };

  if (principal.tenantId !== tenantId) {
    throw new ProductionRagRequestError("principal.tenantId must match tenantId.");
  }

  if (!principal.namespaceIds.includes(namespaceId)) {
    throw new ProductionRagRequestError("principal.namespaceIds must include namespaceId.");
  }

  return principal;
}

function normalizeFilters(
  value: unknown,
  namespaceId: string,
  tenantId: string,
  principal: IndexFilter["principal"]
): IndexFilter {
  if (value !== undefined && !isRecord(value)) {
    throw new ProductionRagRequestError("filters must be a JSON object when provided.");
  }

  const filters = value && isRecord(value) ? value : {};
  const documentIds = optionalStringArray(filters["documentIds"], "filters.documentIds");
  const chunkIds = optionalStringArray(filters["chunkIds"], "filters.chunkIds");
  const sourceIds = optionalStringArray(filters["sourceIds"], "filters.sourceIds");
  const sourceKinds = optionalStringArray(filters["sourceKinds"], "filters.sourceKinds");
  const trustTiers = optionalStringArray(filters["trustTiers"], "filters.trustTiers");
  const includeSafetyFlags = optionalStringArray(
    filters["includeSafetyFlags"],
    "filters.includeSafetyFlags"
  );
  const excludeSafetyFlags = optionalStringArray(
    filters["excludeSafetyFlags"],
    "filters.excludeSafetyFlags"
  );
  const accessTags = optionalStringArray(filters["accessTags"], "filters.accessTags");
  const limit = optionalPositiveInteger(filters["limit"], "filters.limit");

  return {
    namespaceId,
    tenantId,
    principal,
    ...(documentIds === undefined ? {} : { documentIds }),
    ...(chunkIds === undefined ? {} : { chunkIds }),
    ...(sourceIds === undefined ? {} : { sourceIds }),
    ...(sourceKinds === undefined
      ? {}
      : { sourceKinds: sourceKinds as NonNullable<IndexFilter["sourceKinds"]> }),
    ...(trustTiers === undefined
      ? {}
      : { trustTiers: trustTiers as NonNullable<IndexFilter["trustTiers"]> }),
    ...(includeSafetyFlags === undefined
      ? {}
      : {
          includeSafetyFlags: includeSafetyFlags as NonNullable<IndexFilter["includeSafetyFlags"]>
        }),
    ...(excludeSafetyFlags === undefined
      ? {}
      : {
          excludeSafetyFlags: excludeSafetyFlags as NonNullable<IndexFilter["excludeSafetyFlags"]>
        }),
    ...(accessTags === undefined ? {} : { accessTags }),
    ...(limit === undefined ? {} : { limit })
  };
}

function createIndexStore(config: ProductionIndexStorageConfig): ProductionIndexStore {
  if (config.kind === "memory") {
    return new InMemoryRagIndex();
  }

  if (config.kind === "postgres") {
    return new PostgresRagIndex({
      connectionString: config.connectionString,
      ...(config.schema === undefined ? {} : { schema: config.schema })
    });
  }

  if (config.kind === "sqlite") {
    return new SqliteRagIndex({
      filePath: config.path
    });
  }

  return new JsonFileRagIndex({
    filePath: config.path,
    ...(config.autosave === undefined ? {} : { autosave: config.autosave }),
    ...(config.pretty === undefined ? {} : { pretty: config.pretty })
  });
}

function createVectorStore(
  config: ProductionVectorStorageConfig | undefined,
  chunkStore: ProductionIndexStore,
  options: ProductionRagAppOptions
): VectorStore | undefined {
  if (config === undefined || config.kind === "none") {
    return undefined;
  }

  if (config.kind === "memory") {
    return new InMemoryVectorStore({
      chunkStore,
      ...(config.dimensions === undefined ? {} : { dimensions: config.dimensions }),
      ...(options.now === undefined ? {} : { now: options.now })
    });
  }

  if (config.kind === "json_file") {
    return new JsonFileVectorStore({
      filePath: config.path,
      chunkStore,
      ...(config.dimensions === undefined ? {} : { dimensions: config.dimensions }),
      ...(config.autosave === undefined ? {} : { autosave: config.autosave }),
      ...(config.pretty === undefined ? {} : { pretty: config.pretty }),
      ...(options.now === undefined ? {} : { now: options.now })
    });
  }

  if (config.kind === "postgres") {
    return new PostgresVectorStore({
      chunkStore,
      connectionString: config.connectionString,
      ...(config.schema === undefined ? {} : { schema: config.schema }),
      ...(config.dimensions === undefined ? {} : { dimensions: config.dimensions }),
      ...(options.now === undefined ? {} : { now: options.now })
    });
  }

  return new HostedVectorStore({
    chunkStore,
    transport: createHostedVectorTransport(config, options),
    ...(config.dimensions === undefined ? {} : { dimensions: config.dimensions }),
    ...(options.now === undefined ? {} : { now: options.now })
  });
}

function createVisualVectorStore(
  config: ProductionVisualVectorStorageConfig | undefined,
  chunkStore: ProductionIndexStore,
  options: ProductionRagAppOptions
): VisualVectorStore | undefined {
  if (config === undefined || config.kind === "none") {
    return undefined;
  }

  if (config.kind === "memory") {
    return new InMemoryVisualVectorStore({
      chunkStore,
      ...(config.dimensions === undefined ? {} : { dimensions: config.dimensions }),
      ...(options.now === undefined ? {} : { now: options.now })
    });
  }

  if (config.kind === "json_file") {
    return new JsonFileVisualVectorStore({
      filePath: config.path,
      chunkStore,
      ...(config.dimensions === undefined ? {} : { dimensions: config.dimensions }),
      ...(config.autosave === undefined ? {} : { autosave: config.autosave }),
      ...(config.pretty === undefined ? {} : { pretty: config.pretty }),
      ...(options.now === undefined ? {} : { now: options.now })
    });
  }

  return new HostedVisualVectorStore({
    chunkStore,
    transport: createHostedVectorTransport(config, options, "RAG_VISUAL_VECTOR"),
    ...(config.dimensions === undefined ? {} : { dimensions: config.dimensions }),
    ...(options.now === undefined ? {} : { now: options.now })
  });
}

export function createProductionSourceSyncLedgerStore(
  config: ProductionSourceSyncLedgerStorageConfig | undefined
): SourceSyncLedgerStore | undefined {
  if (config === undefined || config.kind === "none") {
    return undefined;
  }

  if (config.kind === "memory") {
    return new InMemorySourceSyncLedgerStore();
  }

  return new PostgresSourceSyncLedgerStore({
    connectionString: config.connectionString,
    ...(config.schema === undefined ? {} : { schema: config.schema })
  });
}

function createHostedVectorTransport(
  config: ProductionHostedVectorStorageConfig,
  options: ProductionRagAppOptions,
  envPrefix = "RAG_VECTOR"
): HostedVectorStoreTransport {
  const secrets = hostedVectorSecrets(config.apiKeyEnv, options.env ?? process.env);
  const http = {
    ...(options.vectorFetch === undefined ? {} : { fetch: options.vectorFetch }),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  };

  switch (config.vendor) {
    case "pinecone":
      return new PineconeHostedVectorTransport({
        indexHost: config.endpoint,
        secrets,
        http,
        ...(config.namespace === undefined ? {} : { namespace: config.namespace }),
        ...(config.deleteNamespaces === undefined
          ? {}
          : { deleteNamespaces: config.deleteNamespaces }),
        ...(config.apiVersion === undefined ? {} : { apiVersion: config.apiVersion })
      });
    case "qdrant":
      return new QdrantHostedVectorTransport({
        endpoint: config.endpoint,
        collectionName: requiredConfigString(config.collectionName, `${envPrefix}_COLLECTION`),
        secrets,
        http,
        ...(config.vectorName === undefined ? {} : { vectorName: config.vectorName }),
        ...(config.waitForWrites === undefined ? {} : { waitForWrites: config.waitForWrites })
      });
    case "weaviate":
      return new WeaviateHostedVectorTransport({
        endpoint: config.endpoint,
        collectionName: requiredConfigString(config.collectionName, `${envPrefix}_COLLECTION`),
        secrets,
        http,
        ...(config.tenant === undefined ? {} : { tenant: config.tenant })
      });
    case "pgvector-rpc":
      return new PgVectorRpcHostedVectorTransport({
        endpoint: config.endpoint,
        tableName: requiredConfigString(config.tableName, `${envPrefix}_TABLE`),
        matchFunctionName: requiredConfigString(
          config.matchFunctionName,
          `${envPrefix}_MATCH_FUNCTION`
        ),
        secrets,
        http,
        ...(config.schema === undefined ? {} : { schema: config.schema })
      });
  }
}

function hostedVectorSecrets(
  apiKeyEnv: string | undefined,
  env: ProviderEnv
): HostedVectorTransportSecrets | undefined {
  if (apiKeyEnv === undefined) {
    return undefined;
  }

  return {
    apiKeyProvider: () => env[apiKeyEnv]?.trim() ?? "",
    secretId: apiKeyEnv
  };
}

function productionHealth(
  profile: ValidatedRagProfile,
  chunkStore: ProductionIndexStore,
  vectorStore: VectorStore | undefined,
  visualVectorStore: VisualVectorStore | undefined,
  sourceSyncLedgerStore: SourceSyncLedgerStore | undefined,
  sourceSyncLedgerConfig: ProductionSourceSyncLedgerStorageConfig | undefined,
  runtime: LiveAssembledRagRuntime
): ProductionRagHealth {
  const maybeStats = chunkStore.stats();
  const stats = isPromiseLike(maybeStats)
    ? {
        documentCount: -1,
        chunkCount: -1,
        namespaceIds: [],
        sourceIds: [],
        trustTierCounts: {},
        flaggedChunkCount: -1
      }
    : maybeStats;
  const vector = vectorStore
    ? {
        storageKind: vectorStore.capabilities.storageKind,
        durable: vectorStore.capabilities.durable,
        ...(vectorStore.capabilities.dimensions === undefined
          ? {}
          : { dimensions: vectorStore.capabilities.dimensions })
      }
    : undefined;
  const visualVector = visualVectorStore
    ? {
        storageKind: visualVectorStore.capabilities.storageKind,
        durable: visualVectorStore.capabilities.durable,
        ...(visualVectorStore.capabilities.dimensions === undefined
          ? {}
          : { dimensions: visualVectorStore.capabilities.dimensions })
      }
    : undefined;
  const sourceSyncLedger =
    sourceSyncLedgerStore && sourceSyncLedgerConfig && sourceSyncLedgerConfig.kind !== "none"
      ? {
          storageKind: sourceSyncLedgerConfig.kind,
          durable: sourceSyncLedgerConfig.kind === "postgres"
        }
      : undefined;

  return {
    status: "ready",
    profileId: profile.id,
    namespaceId: profile.namespaceId,
    retrievalMode: profile.retrieval.mode,
    index: {
      storageKind: chunkStore.capabilities.storageKind,
      durable: chunkStore.capabilities.durable,
      documentCount: stats.documentCount,
      chunkCount: stats.chunkCount
    },
    ...(vector === undefined ? {} : { vector }),
    ...(visualVector === undefined ? {} : { visualVector }),
    ...(sourceSyncLedger === undefined ? {} : { sourceSyncLedger }),
    providers: providerHealth(runtime)
  };
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === "function";
}

function providerHealth(runtime: LiveAssembledRagRuntime): ProductionRagHealth["providers"] {
  return {
    model: {
      id: runtime.providerAdapters.modelConfig.id,
      provider: runtime.providerAdapters.model.provider,
      modelName: runtime.providerAdapters.model.modelName
    },
    ...(runtime.providerAdapters.embeddingConfig === undefined
      ? {}
      : {
          embedding: {
            id: runtime.providerAdapters.embeddingConfig.id,
            provider: runtime.providerAdapters.embeddingConfig.provider,
            modelName: runtime.providerAdapters.embeddingConfig.modelName
          }
        }),
    ...(runtime.providerAdapters.visualEmbeddingConfig === undefined
      ? {}
      : {
          visualEmbedding: {
            id: runtime.providerAdapters.visualEmbeddingConfig.id,
            provider: runtime.providerAdapters.visualEmbeddingConfig.provider,
            modelName: runtime.providerAdapters.visualEmbeddingConfig.modelName
          }
        }),
    ...(runtime.providerAdapters.rerankConfig === undefined
      ? {}
      : {
          rerank: {
            id: runtime.providerAdapters.rerankConfig.id,
            provider: runtime.providerAdapters.rerankConfig.provider,
            modelName: runtime.providerAdapters.rerankConfig.modelName
          }
        }),
    ...(runtime.providerAdapters.groundingJudgeConfig === undefined
      ? {}
      : {
          groundingJudge: {
            id: runtime.providerAdapters.groundingJudgeConfig.id,
            provider: runtime.providerAdapters.groundingJudgeConfig.provider,
            modelName: runtime.providerAdapters.groundingJudgeConfig.modelName
          }
        })
  };
}

function loadProfileFromEnv(
  env: ProviderEnv,
  cwd: string,
  fallback: RagProfile | ValidatedRagProfile | undefined
): RagProfile | ValidatedRagProfile {
  const profilePath = readEnv(env, "RAG_APP_PROFILE_PATH");
  const preset = readEnv(env, "RAG_APP_PROFILE_PRESET") as ProductionProfilePresetId | undefined;

  if (profilePath && preset) {
    throw new ProductionRagConfigError(
      "Set either RAG_APP_PROFILE_PATH or RAG_APP_PROFILE_PRESET, not both."
    );
  }

  if (profilePath) {
    return readProfileFile(resolveConfigPath(profilePath, cwd));
  }

  if (preset) {
    return profilePreset(preset);
  }

  return fallback ?? profilePreset("generic-docs");
}

function loadProviderConfigFromEnv(
  env: ProviderEnv,
  fallback: ProductionProviderRuntimeConfig | undefined
): ProductionProviderRuntimeConfig {
  return {
    modelPrefix:
      readEnv(env, "RAG_APP_MODEL_PREFIX") ??
      fallback?.modelPrefix ??
      DEFAULT_PROVIDER_CONFIG.modelPrefix,
    embeddingPrefix:
      readEnv(env, "RAG_APP_EMBEDDING_PREFIX") ??
      fallback?.embeddingPrefix ??
      DEFAULT_PROVIDER_CONFIG.embeddingPrefix,
    visualEmbeddingPrefix:
      readEnv(env, "RAG_APP_VISUAL_EMBEDDING_PREFIX") ??
      fallback?.visualEmbeddingPrefix ??
      DEFAULT_PROVIDER_CONFIG.visualEmbeddingPrefix,
    rerankPrefix:
      readEnv(env, "RAG_APP_RERANK_PREFIX") ??
      fallback?.rerankPrefix ??
      DEFAULT_PROVIDER_CONFIG.rerankPrefix,
    groundingJudgePrefix:
      readEnv(env, "RAG_APP_GROUNDING_JUDGE_PREFIX") ??
      fallback?.groundingJudgePrefix ??
      DEFAULT_PROVIDER_CONFIG.groundingJudgePrefix,
    embeddingMode: readMode(
      env,
      "RAG_APP_EMBEDDING_MODE",
      fallback?.embeddingMode ?? DEFAULT_PROVIDER_CONFIG.embeddingMode
    ),
    visualEmbeddingMode: readMode(
      env,
      "RAG_APP_VISUAL_EMBEDDING_MODE",
      fallback?.visualEmbeddingMode ?? DEFAULT_PROVIDER_CONFIG.visualEmbeddingMode
    ),
    rerankProviderMode: readMode(
      env,
      "RAG_APP_RERANK_MODE",
      fallback?.rerankProviderMode ?? DEFAULT_PROVIDER_CONFIG.rerankProviderMode
    ),
    groundingJudgeProviderMode: readMode(
      env,
      "RAG_APP_GROUNDING_JUDGE_MODE",
      fallback?.groundingJudgeProviderMode ?? DEFAULT_PROVIDER_CONFIG.groundingJudgeProviderMode
    )
  };
}

function loadHttpConfigFromEnv(
  env: ProviderEnv,
  fallback: ProductionHttpConfig | undefined
): ProductionHttpConfig {
  const fallbackPort = fallback?.port ?? DEFAULT_HTTP_CONFIG.port;
  const fallbackMaxBodyBytes = fallback?.maxBodyBytes ?? DEFAULT_HTTP_CONFIG.maxBodyBytes;
  const port = readInteger(readEnv(env, "RAG_HTTP_PORT"), "RAG_HTTP_PORT", fallbackPort, 1, 65535);
  const maxBodyBytes = readInteger(
    readEnv(env, "RAG_HTTP_MAX_BODY_BYTES"),
    "RAG_HTTP_MAX_BODY_BYTES",
    fallbackMaxBodyBytes,
    1024,
    10 * 1024 * 1024
  );

  return {
    host: readEnv(env, "RAG_HTTP_HOST") ?? fallback?.host ?? DEFAULT_HTTP_CONFIG.host,
    port: port ?? fallbackPort,
    maxBodyBytes: maxBodyBytes ?? fallbackMaxBodyBytes,
    auth: loadHttpAuthConfigFromEnv(env, fallback?.auth),
    rateLimit: loadHttpRateLimitConfigFromEnv(env, fallback?.rateLimit),
    operations: loadHttpOperationsConfigFromEnv(env, fallback?.operations)
  };
}

function loadHttpAuthConfigFromEnv(
  env: ProviderEnv,
  fallback: ProductionHttpAuthConfig | undefined
): ProductionHttpAuthConfig {
  const mode = readHttpAuthMode(
    readEnv(env, "RAG_HTTP_AUTH_MODE"),
    fallback?.mode ?? DEFAULT_HTTP_CONFIG.auth.mode
  );
  const headerName = normalizeHttpHeaderName(
    readEnv(env, "RAG_HTTP_AUTH_HEADER") ??
      fallback?.headerName ??
      DEFAULT_HTTP_CONFIG.auth.headerName,
    "RAG_HTTP_AUTH_HEADER"
  );

  if (mode === "disabled") {
    return {
      mode,
      headerName,
      tokenSha256s: []
    };
  }

  const tokenSha256s = httpAuthTokenSha256s(env, fallback);
  if (tokenSha256s.length === 0) {
    throw new ProductionRagConfigError(
      "RAG_HTTP_AUTH_TOKEN, RAG_HTTP_AUTH_TOKEN_ENV, or RAG_HTTP_AUTH_TOKEN_ENVS is required when RAG_HTTP_AUTH_MODE=required."
    );
  }

  return {
    mode,
    headerName,
    tokenSha256s
  };
}

function loadHttpRateLimitConfigFromEnv(
  env: ProviderEnv,
  fallback: ProductionHttpRateLimitConfig | undefined
): ProductionHttpRateLimitConfig {
  const mode = readHttpRateLimitMode(
    readEnv(env, "RAG_HTTP_RATE_LIMIT_MODE"),
    fallback?.mode ?? DEFAULT_HTTP_CONFIG.rateLimit.mode
  );
  const windowMs = readInteger(
    readEnv(env, "RAG_HTTP_RATE_LIMIT_WINDOW_MS"),
    "RAG_HTTP_RATE_LIMIT_WINDOW_MS",
    fallback?.windowMs ?? DEFAULT_HTTP_CONFIG.rateLimit.windowMs,
    1000,
    24 * 60 * 60 * 1000
  );
  const maxRequests = readInteger(
    readEnv(env, "RAG_HTTP_RATE_LIMIT_MAX_REQUESTS"),
    "RAG_HTTP_RATE_LIMIT_MAX_REQUESTS",
    fallback?.maxRequests ?? DEFAULT_HTTP_CONFIG.rateLimit.maxRequests,
    1,
    1_000_000
  );
  const maxKeys = readInteger(
    readEnv(env, "RAG_HTTP_RATE_LIMIT_MAX_KEYS"),
    "RAG_HTTP_RATE_LIMIT_MAX_KEYS",
    fallback?.maxKeys ?? DEFAULT_HTTP_CONFIG.rateLimit.maxKeys,
    1,
    1_000_000
  );
  const clientIpHeader = optionalHttpHeaderName(
    readEnv(env, "RAG_HTTP_CLIENT_IP_HEADER") ?? fallback?.clientIpHeader,
    "RAG_HTTP_CLIENT_IP_HEADER"
  );

  return {
    mode,
    windowMs: windowMs ?? DEFAULT_HTTP_CONFIG.rateLimit.windowMs,
    maxRequests: maxRequests ?? DEFAULT_HTTP_CONFIG.rateLimit.maxRequests,
    maxKeys: maxKeys ?? DEFAULT_HTTP_CONFIG.rateLimit.maxKeys,
    ...(clientIpHeader === undefined ? {} : { clientIpHeader })
  };
}

function loadHttpOperationsConfigFromEnv(
  env: ProviderEnv,
  fallback: ProductionHttpOperationsConfig | undefined
): ProductionHttpOperationsConfig {
  return {
    logMode: readHttpLogMode(
      readEnv(env, "RAG_HTTP_LOG_MODE"),
      fallback?.logMode ?? DEFAULT_HTTP_CONFIG.operations.logMode
    ),
    requestIdHeader: normalizeHttpHeaderName(
      readEnv(env, "RAG_HTTP_REQUEST_ID_HEADER") ??
        fallback?.requestIdHeader ??
        DEFAULT_HTTP_CONFIG.operations.requestIdHeader,
      "RAG_HTTP_REQUEST_ID_HEADER"
    ),
    readinessPath: normalizeHttpPath(
      readEnv(env, "RAG_HTTP_READINESS_PATH") ??
        fallback?.readinessPath ??
        DEFAULT_HTTP_CONFIG.operations.readinessPath,
      "RAG_HTTP_READINESS_PATH"
    ),
    metricsPath: normalizeHttpPath(
      readEnv(env, "RAG_HTTP_METRICS_PATH") ??
        fallback?.metricsPath ??
        DEFAULT_HTTP_CONFIG.operations.metricsPath,
      "RAG_HTTP_METRICS_PATH"
    )
  };
}

function loadStorageConfigFromEnv(
  env: ProviderEnv,
  cwd: string,
  fallback: ProductionStorageConfig | undefined
): ProductionStorageConfig {
  return {
    index: loadIndexStorageConfig(env, cwd, fallback?.index),
    vector: loadVectorStorageConfig(env, cwd, fallback?.vector),
    visualVector: loadVisualVectorStorageConfig(env, cwd, fallback?.visualVector),
    sourceSyncLedger: loadSourceSyncLedgerStorageConfig(env, fallback?.sourceSyncLedger)
  };
}

function loadSourceSyncLedgerStorageConfig(
  env: ProviderEnv,
  fallback: ProductionSourceSyncLedgerStorageConfig | undefined
): ProductionSourceSyncLedgerStorageConfig {
  const kind = readEnv(env, "RAG_SOURCE_SYNC_LEDGER_KIND") ?? fallback?.kind ?? "none";
  if (kind === "none") {
    return { kind: "none" };
  }

  if (kind === "memory") {
    return { kind: "memory" };
  }

  if (kind === "postgres") {
    const schema = readEnv(env, "RAG_POSTGRES_SCHEMA");
    return {
      kind: "postgres",
      connectionString: readPostgresConnectionString(env),
      ...(schema === undefined ? {} : { schema })
    };
  }

  throw new ProductionRagConfigError(
    "RAG_SOURCE_SYNC_LEDGER_KIND must be none, memory, or postgres."
  );
}

function loadIndexStorageConfig(
  env: ProviderEnv,
  cwd: string,
  fallback: ProductionIndexStorageConfig | undefined
): ProductionIndexStorageConfig {
  const kind = readEnv(env, "RAG_INDEX_KIND") ?? fallback?.kind ?? "json_file";
  if (kind === "memory") {
    return { kind: "memory" };
  }

  if (kind === "postgres") {
    const schema = readEnv(env, "RAG_POSTGRES_SCHEMA");
    return {
      kind: "postgres",
      connectionString: readPostgresConnectionString(env),
      ...(schema === undefined ? {} : { schema })
    };
  }

  if (kind === "sqlite") {
    return {
      kind: "sqlite",
      path: resolveConfigPath(
        readEnv(env, "RAG_INDEX_PATH") ??
          (fallback?.kind === "sqlite" ? fallback.path : ".rag/index.sqlite"),
        cwd
      )
    };
  }

  if (kind !== "json_file") {
    throw new ProductionRagConfigError(
      "RAG_INDEX_KIND must be memory, json_file, sqlite, or postgres."
    );
  }

  const autosave = readBoolean(
    readEnv(env, "RAG_INDEX_AUTOSAVE"),
    "RAG_INDEX_AUTOSAVE",
    fallback?.kind === "json_file" ? fallback.autosave : undefined
  );
  const pretty = readBoolean(
    readEnv(env, "RAG_INDEX_PRETTY"),
    "RAG_INDEX_PRETTY",
    fallback?.kind === "json_file" ? fallback.pretty : undefined
  );

  return {
    kind: "json_file",
    path: resolveConfigPath(
      readEnv(env, "RAG_INDEX_PATH") ??
        (fallback?.kind === "json_file" ? fallback.path : ".rag/index.json"),
      cwd
    ),
    ...(autosave === undefined ? {} : { autosave }),
    ...(pretty === undefined ? {} : { pretty })
  };
}

function loadVectorStorageConfig(
  env: ProviderEnv,
  cwd: string,
  fallback: ProductionVectorStorageConfig | undefined
): ProductionVectorStorageConfig {
  const kind = readEnv(env, "RAG_VECTOR_KIND") ?? fallback?.kind ?? "none";
  if (kind === "none") {
    return { kind: "none" };
  }

  if (kind === "memory") {
    return {
      kind: "memory",
      ...optionalDimension(
        env,
        "RAG_VECTOR_DIMENSIONS",
        fallback?.kind === "memory" ? fallback.dimensions : undefined
      )
    };
  }

  if (kind === "json_file") {
    const autosave = readBoolean(
      readEnv(env, "RAG_VECTOR_AUTOSAVE"),
      "RAG_VECTOR_AUTOSAVE",
      fallback?.kind === "json_file" ? fallback.autosave : undefined
    );
    const pretty = readBoolean(
      readEnv(env, "RAG_VECTOR_PRETTY"),
      "RAG_VECTOR_PRETTY",
      fallback?.kind === "json_file" ? fallback.pretty : undefined
    );

    return {
      kind: "json_file",
      path: resolveConfigPath(
        readEnv(env, "RAG_VECTOR_PATH") ??
          (fallback?.kind === "json_file" ? fallback.path : ".rag/vectors.json"),
        cwd
      ),
      ...optionalDimension(
        env,
        "RAG_VECTOR_DIMENSIONS",
        fallback?.kind === "json_file" ? fallback.dimensions : undefined
      ),
      ...(autosave === undefined ? {} : { autosave }),
      ...(pretty === undefined ? {} : { pretty })
    };
  }

  if (kind === "postgres") {
    const schema = readEnv(env, "RAG_POSTGRES_SCHEMA");
    return {
      kind: "postgres",
      connectionString: readPostgresConnectionString(env),
      ...(schema === undefined ? {} : { schema }),
      ...optionalDimension(
        env,
        "RAG_VECTOR_DIMENSIONS",
        fallback?.kind === "postgres" ? fallback.dimensions : undefined
      )
    };
  }

  if (kind !== "hosted") {
    throw new ProductionRagConfigError(
      "RAG_VECTOR_KIND must be none, memory, json_file, postgres, or hosted."
    );
  }

  return loadHostedVectorStorageConfig(
    env,
    "RAG_VECTOR",
    fallback?.kind === "hosted" ? fallback : undefined
  );
}

function loadVisualVectorStorageConfig(
  env: ProviderEnv,
  cwd: string,
  fallback: ProductionVisualVectorStorageConfig | undefined
): ProductionVisualVectorStorageConfig {
  const kind = readEnv(env, "RAG_VISUAL_VECTOR_KIND") ?? fallback?.kind ?? "none";
  if (kind === "none") {
    return { kind: "none" };
  }

  if (kind === "memory") {
    return {
      kind: "memory",
      ...optionalDimension(
        env,
        "RAG_VISUAL_VECTOR_DIMENSIONS",
        fallback?.kind === "memory" ? fallback.dimensions : undefined
      )
    };
  }

  if (kind === "hosted") {
    return loadHostedVectorStorageConfig(
      env,
      "RAG_VISUAL_VECTOR",
      fallback?.kind === "hosted" ? fallback : undefined
    );
  }

  if (kind !== "json_file") {
    throw new ProductionRagConfigError(
      "RAG_VISUAL_VECTOR_KIND must be none, memory, json_file, or hosted."
    );
  }

  const autosave = readBoolean(
    readEnv(env, "RAG_VISUAL_VECTOR_AUTOSAVE"),
    "RAG_VISUAL_VECTOR_AUTOSAVE",
    fallback?.kind === "json_file" ? fallback.autosave : undefined
  );
  const pretty = readBoolean(
    readEnv(env, "RAG_VISUAL_VECTOR_PRETTY"),
    "RAG_VISUAL_VECTOR_PRETTY",
    fallback?.kind === "json_file" ? fallback.pretty : undefined
  );

  return {
    kind: "json_file",
    path: resolveConfigPath(
      readEnv(env, "RAG_VISUAL_VECTOR_PATH") ??
        (fallback?.kind === "json_file" ? fallback.path : ".rag/visual-vectors.json"),
      cwd
    ),
    ...optionalDimension(
      env,
      "RAG_VISUAL_VECTOR_DIMENSIONS",
      fallback?.kind === "json_file" ? fallback.dimensions : undefined
    ),
    ...(autosave === undefined ? {} : { autosave }),
    ...(pretty === undefined ? {} : { pretty })
  };
}

function loadHostedVectorStorageConfig(
  env: ProviderEnv,
  prefix: "RAG_VECTOR" | "RAG_VISUAL_VECTOR",
  fallback: ProductionHostedVectorStorageConfig | undefined
): ProductionHostedVectorStorageConfig {
  const vendor = readRequiredEnv(env, `${prefix}_VENDOR`) as HostedVectorVendor;
  if (!["pinecone", "qdrant", "weaviate", "pgvector-rpc"].includes(vendor)) {
    throw new ProductionRagConfigError(
      `${prefix}_VENDOR must be pinecone, qdrant, weaviate, or pgvector-rpc.`
    );
  }
  const apiKeyEnv = resolveSecretEnvName(env, `${prefix}_API_KEY`, `${prefix}_API_KEY_ENV`);
  const namespace = readEnv(env, `${prefix}_NAMESPACE`);
  const deleteNamespaces = readEnv(env, `${prefix}_DELETE_NAMESPACES`)
    ? readCsvEnv(env, `${prefix}_DELETE_NAMESPACES`)
    : undefined;
  const apiVersion = readEnv(env, `${prefix}_API_VERSION`);
  const collectionName = readEnv(env, `${prefix}_COLLECTION`);
  const vectorName = readEnv(env, `${prefix}_NAME`);
  const waitForWrites = readBoolean(readEnv(env, `${prefix}_WAIT`), `${prefix}_WAIT`, undefined);
  const tenant = readEnv(env, `${prefix}_TENANT`);
  const tableName = readEnv(env, `${prefix}_TABLE`);
  const matchFunctionName = readEnv(env, `${prefix}_MATCH_FUNCTION`);
  const schema = readEnv(env, `${prefix}_SCHEMA`);

  return {
    kind: "hosted",
    vendor,
    endpoint: readRequiredEnv(env, `${prefix}_ENDPOINT`),
    ...optionalDimension(env, `${prefix}_DIMENSIONS`, fallback?.dimensions),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(namespace === undefined ? {} : { namespace }),
    ...(deleteNamespaces === undefined ? {} : { deleteNamespaces }),
    ...(apiVersion === undefined ? {} : { apiVersion }),
    ...(collectionName === undefined ? {} : { collectionName }),
    ...(vectorName === undefined ? {} : { vectorName }),
    ...(waitForWrites === undefined ? {} : { waitForWrites }),
    ...(tenant === undefined ? {} : { tenant }),
    ...(tableName === undefined ? {} : { tableName }),
    ...(matchFunctionName === undefined ? {} : { matchFunctionName }),
    ...(schema === undefined ? {} : { schema })
  };
}

function readProfileFile(filePath: string): RagProfile {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new ProductionRagConfigError(`Profile file must contain a JSON object: ${filePath}`);
  }

  return parsed as unknown as RagProfile;
}

function profilePreset(preset: ProductionProfilePresetId): RagProfile {
  switch (preset) {
    case "generic-docs":
      return cloneProfile(genericDocsProfile);
    case "breakaway-support":
      return cloneProfile(breakawaySupportProfile);
    case "ultimate-default":
      return cloneProfile(ultimateDefaultProfile);
  }
}

function cloneProfile(profile: RagProfile): RagProfile {
  return JSON.parse(JSON.stringify(profile)) as RagProfile;
}

function resolveConfigPath(value: string, cwd: string): string {
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

function requiredConfigString(value: string | undefined, label: string): string {
  if (!value?.trim()) {
    throw new ProductionRagConfigError(`${label} is required for this vector vendor.`);
  }

  return value;
}

function readPostgresConnectionString(env: ProviderEnv): string {
  const direct = readEnv(env, "RAG_POSTGRES_URL");
  const referencedEnvName = readEnv(env, "RAG_POSTGRES_URL_ENV");
  const referenced = referencedEnvName === undefined ? undefined : readEnv(env, referencedEnvName);
  const connectionString = referenced ?? direct;

  if (connectionString === undefined) {
    throw new ProductionRagConfigError(
      referencedEnvName === undefined
        ? "RAG_POSTGRES_URL or RAG_POSTGRES_URL_ENV is required for Postgres-backed production storage."
        : `${referencedEnvName} referenced by RAG_POSTGRES_URL_ENV is required for Postgres-backed production storage.`
    );
  }

  return connectionString;
}

function readRequiredEnv(env: ProviderEnv, name: string): string {
  const value = readEnv(env, name);
  if (value === undefined) {
    throw new ProductionRagConfigError(`${name} is required.`);
  }

  return value;
}

function readEnv(env: ProviderEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function httpAuthTokenSha256s(
  env: ProviderEnv,
  fallback: ProductionHttpAuthConfig | undefined
): readonly string[] {
  const hashCsv = readEnv(env, "RAG_HTTP_AUTH_TOKEN_SHA256S");
  if (hashCsv !== undefined) {
    return hashCsv
      .split(",")
      .map((value) => normalizeSha256(value.trim(), "RAG_HTTP_AUTH_TOKEN_SHA256S"));
  }

  const tokenEnvNames = httpAuthTokenEnvNames(env);
  if (tokenEnvNames.length > 0) {
    return tokenEnvNames.map((name) => sha256Hex(readRequiredEnv(env, name)));
  }

  const directToken = readEnv(env, "RAG_HTTP_AUTH_TOKEN");
  if (directToken !== undefined) {
    return [sha256Hex(directToken)];
  }

  return fallback?.mode === "required" ? fallback.tokenSha256s : [];
}

function httpAuthTokenEnvNames(env: ProviderEnv): readonly string[] {
  const names = readEnv(env, "RAG_HTTP_AUTH_TOKEN_ENVS")
    ? readCsvEnv(env, "RAG_HTTP_AUTH_TOKEN_ENVS")
    : [];
  const single = readEnv(env, "RAG_HTTP_AUTH_TOKEN_ENV");

  if (names.length > 0 && single !== undefined) {
    throw new ProductionRagConfigError(
      "Set either RAG_HTTP_AUTH_TOKEN_ENV or RAG_HTTP_AUTH_TOKEN_ENVS, not both."
    );
  }

  return names.length > 0 ? names : single === undefined ? [] : [single];
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeSha256(value: string, name: string): string {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new ProductionRagConfigError(`${name} must contain SHA-256 hex values.`);
  }

  return normalized;
}

function readHttpAuthMode(
  value: string | undefined,
  fallback: ProductionHttpAuthMode
): ProductionHttpAuthMode {
  if (value === undefined) {
    return fallback;
  }

  if (value === "required" || value === "disabled") {
    return value;
  }

  throw new ProductionRagConfigError("RAG_HTTP_AUTH_MODE must be required or disabled.");
}

function readHttpRateLimitMode(
  value: string | undefined,
  fallback: ProductionHttpRateLimitMode
): ProductionHttpRateLimitMode {
  if (value === undefined) {
    return fallback;
  }

  if (value === "enabled" || value === "disabled") {
    return value;
  }

  throw new ProductionRagConfigError("RAG_HTTP_RATE_LIMIT_MODE must be enabled or disabled.");
}

function readHttpLogMode(
  value: string | undefined,
  fallback: ProductionHttpLogMode
): ProductionHttpLogMode {
  if (value === undefined) {
    return fallback;
  }

  if (value === "json" || value === "disabled") {
    return value;
  }

  throw new ProductionRagConfigError("RAG_HTTP_LOG_MODE must be json or disabled.");
}

function optionalHttpHeaderName(value: string | undefined, name: string): string | undefined {
  return value === undefined ? undefined : normalizeHttpHeaderName(value, name);
}

function normalizeHttpHeaderName(value: string, name: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/u.test(normalized)) {
    throw new ProductionRagConfigError(`${name} must be an HTTP header name.`);
  }

  return normalized;
}

function normalizeHttpPath(value: string, name: string): string {
  const normalized = value.trim();
  if (!/^\/[A-Za-z0-9/_-]*$/u.test(normalized)) {
    throw new ProductionRagConfigError(`${name} must be an absolute HTTP path.`);
  }

  return normalized;
}

function resolveSecretEnvName(
  env: ProviderEnv,
  directName: string,
  referenceName: string
): string | undefined {
  const referenced = readEnv(env, referenceName);
  if (referenced) {
    if (readEnv(env, referenced) === undefined) {
      throw new ProductionRagConfigError(
        `${referenced} referenced by ${referenceName} is missing.`
      );
    }

    return referenced;
  }

  return readEnv(env, directName) === undefined ? undefined : directName;
}

function readMode<T extends LiveEmbeddingProviderMode | LiveOptionalProviderMode>(
  env: ProviderEnv,
  name: string,
  fallback: T
): T {
  const value = readEnv(env, name);
  if (value === undefined) {
    return fallback;
  }

  if (value === "auto" || value === "required" || value === "disabled") {
    return value as T;
  }

  throw new ProductionRagConfigError(`${name} must be auto, required, or disabled.`);
}

function optionalDimension(
  env: ProviderEnv,
  name: string,
  fallback: number | undefined
): { readonly dimensions?: number } {
  const dimensions = readInteger(readEnv(env, name), name, fallback, 1, 100000);
  return dimensions === undefined ? {} : { dimensions };
}

function readInteger(
  value: string | undefined,
  name: string,
  fallback: number | undefined,
  minimum: number,
  maximum: number
): number | undefined {
  if (value === undefined) {
    return fallback;
  }

  if (!/^[0-9]+$/u.test(value)) {
    throw new ProductionRagConfigError(`${name} must be an integer.`);
  }

  const parsed = Number.parseInt(value, 10);
  if (parsed < minimum || parsed > maximum) {
    throw new ProductionRagConfigError(`${name} must be between ${minimum} and ${maximum}.`);
  }

  return parsed;
}

function readBoolean(
  value: string | undefined,
  name: string,
  fallback: boolean | undefined
): boolean | undefined {
  if (value === undefined) {
    return fallback;
  }

  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new ProductionRagConfigError(`${name} must be true or false.`);
}

function readCsvEnv(env: ProviderEnv, name: string): readonly string[] {
  return (readEnv(env, name) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function requiredString(value: unknown, pathName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProductionRagRequestError(`${pathName} must be a non-empty string.`);
  }

  return value.trim();
}

function optionalString(value: unknown, pathName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requiredString(value, pathName);
}

function requiredStringArray(value: unknown, pathName: string): readonly string[] {
  const parsed = optionalStringArray(value, pathName);
  if (parsed === undefined || parsed.length === 0) {
    throw new ProductionRagRequestError(`${pathName} must be a non-empty string array.`);
  }

  return parsed;
}

function optionalStringArray(value: unknown, pathName: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new ProductionRagRequestError(`${pathName} must be a string array.`);
  }

  return value.map((entry, index) => requiredString(entry, `${pathName}[${index}]`));
}

function optionalPositiveInteger(value: unknown, pathName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ProductionRagRequestError(`${pathName} must be a positive integer.`);
  }

  return value;
}

function optionalBoolean(value: unknown, pathName: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new ProductionRagRequestError(`${pathName} must be a boolean.`);
  }

  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { HostedVectorHttpClient };
