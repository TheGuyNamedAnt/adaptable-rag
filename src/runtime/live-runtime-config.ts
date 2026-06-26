import type { EmbeddingAdapter } from "../embeddings/embedding-types.js";
import { createColPaliVisualEmbeddingAdapter } from "../embeddings/colpali-visual-embedding-preset.js";
import { createIndexedEmbeddingAdapter } from "../embeddings/indexed-embedding-preset.js";
import { createIndexedVisualEmbeddingAdapter } from "../embeddings/indexed-visual-embedding-preset.js";
import { createOpenAICompatibleEmbeddingAdapter } from "../embeddings/openai-embedding-preset.js";
import type { VisualEmbeddingAdapter } from "../embeddings/visual-embedding-types.js";
import { createModelBackedGroundingJudgeFromAdapter } from "../generation/grounding-judge-factory.js";
import { createAnthropicGroundingJudgeAdapter } from "../model/anthropic-grounding-judge-preset.js";
import { createAnthropicMessagesModelAdapter } from "../model/anthropic-messages-model-preset.js";
import { createJsonGroundingJudgeAdapter } from "../model/json-grounding-judge-preset.js";
import { createJsonChatModelAdapter } from "../model/json-chat-model-preset.js";
import type { ModelAdapter } from "../model/model-types.js";
import { createOpenAICompatibleChatModelAdapter } from "../model/openai-chat-model-preset.js";
import { createOpenAICompatibleGroundingJudgeAdapter } from "../model/openai-grounding-judge-preset.js";
import { createAnthropicRerankAdapter } from "../retrieval/anthropic-rerank-preset.js";
import { createJsonRerankAdapter } from "../retrieval/json-rerank-preset.js";
import { ModelBackedReranker } from "../retrieval/model-reranker.js";
import { createOpenAICompatibleRerankAdapter } from "../retrieval/openai-rerank-preset.js";
import type { Reranker } from "../retrieval/reranker.js";
import type { ProviderBoundaryConfig, ProviderTransport } from "../shared/provider-boundary.js";
import { FetchProviderTransport, type FetchLike } from "../shared/fetch-provider-transport.js";
import {
  hasProviderRuntimeEnv,
  loadEmbeddingProviderRuntimeConfigFromEnv,
  loadProviderRuntimeConfigFromEnv,
  type ProviderEnv
} from "../shared/provider-runtime-config.js";
import {
  assembleRagRuntime,
  type AssembledRagRuntime,
  type RagRuntimeAssemblyConfig
} from "./rag-runtime-factory.js";

export type LiveEmbeddingProviderMode = "auto" | "required" | "disabled";
export type LiveOptionalProviderMode = "auto" | "required" | "disabled";

export interface LiveProviderAdaptersFromEnvOptions {
  readonly env?: ProviderEnv;
  readonly modelPrefix?: string;
  readonly embeddingPrefix?: string;
  readonly visualEmbeddingPrefix?: string;
  readonly rerankPrefix?: string;
  readonly groundingJudgePrefix?: string;
  readonly embedding?: LiveEmbeddingProviderMode;
  readonly visualEmbedding?: LiveEmbeddingProviderMode;
  readonly rerankProvider?: LiveOptionalProviderMode;
  readonly groundingJudgeProvider?: LiveOptionalProviderMode;
  readonly transport?: ProviderTransport;
  readonly fetch?: FetchLike;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly modelTemperature?: number;
  readonly rerankTemperature?: number;
  readonly groundingJudgeTemperature?: number;
  readonly anthropicVersion?: string;
  readonly anthropicBeta?: string;
}

export interface LiveProviderAdapters {
  readonly model: ModelAdapter;
  readonly modelConfig: ProviderBoundaryConfig;
  readonly transport: ProviderTransport;
  readonly embeddingAdapter?: EmbeddingAdapter;
  readonly embeddingConfig?: ProviderBoundaryConfig;
  readonly visualEmbeddingAdapter?: VisualEmbeddingAdapter;
  readonly visualEmbeddingConfig?: ProviderBoundaryConfig;
  readonly reranker?: Reranker;
  readonly rerankConfig?: ProviderBoundaryConfig;
  readonly groundingJudge?: NonNullable<RagRuntimeAssemblyConfig["groundingJudge"]>;
  readonly groundingJudgeConfig?: ProviderBoundaryConfig;
}

export type LiveRagRuntimeFromEnvConfig = Omit<
  RagRuntimeAssemblyConfig,
  "model" | "embeddingAdapter"
> &
  LiveProviderAdaptersFromEnvOptions;

export interface LiveAssembledRagRuntime extends AssembledRagRuntime {
  readonly providerAdapters: LiveProviderAdapters;
}

const DEFAULT_MODEL_PREFIX = "RAG_MODEL";
const DEFAULT_EMBEDDING_PREFIX = "RAG_EMBEDDING";
const DEFAULT_VISUAL_EMBEDDING_PREFIX = "RAG_VISUAL_EMBEDDING";
const DEFAULT_RERANK_PREFIX = "RAG_RERANK";
const DEFAULT_GROUNDING_JUDGE_PREFIX = "RAG_GROUNDING_JUDGE";

export function createLiveProviderAdaptersFromEnv(
  options: LiveProviderAdaptersFromEnvOptions = {}
): LiveProviderAdapters {
  const env = options.env ?? process.env;
  const modelPrefix = options.modelPrefix ?? DEFAULT_MODEL_PREFIX;
  const embeddingPrefix = options.embeddingPrefix ?? DEFAULT_EMBEDDING_PREFIX;
  const visualEmbeddingPrefix = options.visualEmbeddingPrefix ?? DEFAULT_VISUAL_EMBEDDING_PREFIX;
  const rerankPrefix = options.rerankPrefix ?? DEFAULT_RERANK_PREFIX;
  const groundingJudgePrefix = options.groundingJudgePrefix ?? DEFAULT_GROUNDING_JUDGE_PREFIX;
  const transport = resolveTransport(options);
  const modelProvider = loadProviderRuntimeConfigFromEnv({
    env,
    prefix: modelPrefix
  });
  const model = createModelAdapterFromProvider({
    loaded: modelProvider,
    transport,
    env,
    prefix: modelPrefix,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.modelTemperature === undefined ? {} : { temperature: options.modelTemperature }),
    ...(options.anthropicVersion === undefined
      ? {}
      : { anthropicVersion: options.anthropicVersion }),
    ...(options.anthropicBeta === undefined ? {} : { anthropicBeta: options.anthropicBeta })
  });
  const shouldCreateEmbedding = shouldLoadEmbeddingProvider(
    env,
    embeddingPrefix,
    options.embedding ?? "auto"
  );
  const shouldCreateVisualEmbedding = shouldLoadEmbeddingProvider(
    env,
    visualEmbeddingPrefix,
    options.visualEmbedding ?? "auto"
  );
  const adapters: LiveProviderAdapters = {
    model,
    modelConfig: modelProvider.config,
    transport
  };

  if (shouldCreateEmbedding) {
    const embeddingProvider = loadEmbeddingProviderRuntimeConfigFromEnv({
      env,
      prefix: embeddingPrefix
    });
    const embeddingAdapter = createEmbeddingAdapterFromProvider({
      loaded: embeddingProvider,
      transport,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep })
    });

    Object.assign(adapters, {
      embeddingAdapter,
      embeddingConfig: embeddingProvider.config
    });
  }

  if (shouldCreateVisualEmbedding) {
    const visualEmbeddingProvider = loadEmbeddingProviderRuntimeConfigFromEnv({
      env,
      prefix: visualEmbeddingPrefix
    });
    const visualEmbeddingAdapter = createVisualEmbeddingAdapterFromProvider({
      loaded: visualEmbeddingProvider,
      transport,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep })
    });

    Object.assign(adapters, {
      visualEmbeddingAdapter,
      visualEmbeddingConfig: visualEmbeddingProvider.config
    });
  }

  if (shouldLoadOptionalProvider(env, rerankPrefix, options.rerankProvider ?? "auto")) {
    const rerankProvider = loadProviderRuntimeConfigFromEnv({
      env,
      prefix: rerankPrefix
    });
    const reranker = createRerankerFromProvider({
      loaded: rerankProvider,
      transport,
      env,
      prefix: rerankPrefix,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.rerankTemperature === undefined
        ? {}
        : { temperature: options.rerankTemperature }),
      ...(options.anthropicVersion === undefined
        ? {}
        : { anthropicVersion: options.anthropicVersion }),
      ...(options.anthropicBeta === undefined ? {} : { anthropicBeta: options.anthropicBeta })
    });

    Object.assign(adapters, {
      reranker,
      rerankConfig: rerankProvider.config
    });
  }

  if (
    shouldLoadOptionalProvider(env, groundingJudgePrefix, options.groundingJudgeProvider ?? "auto")
  ) {
    const groundingJudgeProvider = loadProviderRuntimeConfigFromEnv({
      env,
      prefix: groundingJudgePrefix
    });
    const groundingJudge = createGroundingJudgeFromProvider({
      loaded: groundingJudgeProvider,
      transport,
      env,
      prefix: groundingJudgePrefix,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.groundingJudgeTemperature === undefined
        ? {}
        : { temperature: options.groundingJudgeTemperature }),
      ...(options.anthropicVersion === undefined
        ? {}
        : { anthropicVersion: options.anthropicVersion }),
      ...(options.anthropicBeta === undefined ? {} : { anthropicBeta: options.anthropicBeta })
    });

    Object.assign(adapters, {
      groundingJudge,
      groundingJudgeConfig: groundingJudgeProvider.config
    });
  }

  return adapters;
}

export function assembleLiveRagRuntimeFromEnv(
  config: LiveRagRuntimeFromEnvConfig
): LiveAssembledRagRuntime {
  const providerAdapters = createLiveProviderAdaptersFromEnv(config);
  const reranker = config.reranker ?? providerAdapters.reranker;
  const groundingJudge = config.groundingJudge ?? providerAdapters.groundingJudge;
  const visualEmbeddingAdapter =
    config.visualEmbeddingAdapter ?? providerAdapters.visualEmbeddingAdapter;
  const assembled = assembleRagRuntime({
    profile: config.profile,
    chunkStore: config.chunkStore,
    model: providerAdapters.model,
    ...(providerAdapters.embeddingAdapter === undefined
      ? {}
      : { embeddingAdapter: providerAdapters.embeddingAdapter }),
    ...(reranker === undefined ? {} : { reranker }),
    ...(groundingJudge === undefined ? {} : { groundingJudge }),
    ...(config.vectorStore === undefined ? {} : { vectorStore: config.vectorStore }),
    ...(visualEmbeddingAdapter === undefined ? {} : { visualEmbeddingAdapter }),
    ...(config.visualVectorStore === undefined
      ? {}
      : { visualVectorStore: config.visualVectorStore }),
    ...(config.contextBuilder === undefined ? {} : { contextBuilder: config.contextBuilder }),
    ...(config.generationRunner === undefined ? {} : { generationRunner: config.generationRunner }),
    ...(config.queryPlanner === undefined ? {} : { queryPlanner: config.queryPlanner }),
    ...(config.graph === undefined ? {} : { graph: config.graph }),
    ...(config.now === undefined ? {} : { now: config.now })
  });

  return {
    ...assembled,
    providerAdapters
  };
}

function shouldLoadEmbeddingProvider(
  env: ProviderEnv,
  prefix: string,
  mode: LiveEmbeddingProviderMode
): boolean {
  return shouldLoadOptionalProvider(env, prefix, mode);
}

function shouldLoadOptionalProvider(
  env: ProviderEnv,
  prefix: string,
  mode: LiveOptionalProviderMode
): boolean {
  switch (mode) {
    case "disabled":
      return false;
    case "required":
      return true;
    case "auto":
      return hasProviderRuntimeEnv(env, prefix);
  }
}

function createModelAdapterFromProvider(input: {
  readonly loaded: ReturnType<typeof loadProviderRuntimeConfigFromEnv>;
  readonly transport: ProviderTransport;
  readonly env: ProviderEnv;
  readonly prefix: string;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly temperature?: number;
  readonly anthropicVersion?: string;
  readonly anthropicBeta?: string;
}): ModelAdapter {
  const provider = normalizeProviderName(input.loaded.config.provider);
  if (provider === "anthropic" || provider === "claude") {
    return createAnthropicMessagesModelAdapter({
      config: input.loaded.config,
      secrets: input.loaded.secrets,
      transport: input.transport,
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      ...readAnthropicOptions(input)
    });
  }

  if (provider === "openai" || provider === "openai-compatible") {
    return createOpenAICompatibleChatModelAdapter({
      config: input.loaded.config,
      secrets: input.loaded.secrets,
      transport: input.transport,
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature })
    });
  }

  return createJsonChatModelAdapter({
    config: input.loaded.config,
    secrets: input.loaded.secrets,
    transport: input.transport,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
    ...(input.temperature === undefined ? {} : { temperature: input.temperature })
  });
}

function createEmbeddingAdapterFromProvider(input: {
  readonly loaded: ReturnType<typeof loadEmbeddingProviderRuntimeConfigFromEnv>;
  readonly transport: ProviderTransport;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): EmbeddingAdapter {
  const provider = normalizeProviderName(input.loaded.config.provider);
  if (provider === "openai" || provider === "openai-compatible") {
    return createOpenAICompatibleEmbeddingAdapter({
      config: input.loaded.config,
      dimensions: input.loaded.dimensions,
      secrets: input.loaded.secrets,
      transport: input.transport,
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.sleep === undefined ? {} : { sleep: input.sleep })
    });
  }

  return createIndexedEmbeddingAdapter({
    config: input.loaded.config,
    dimensions: input.loaded.dimensions,
    secrets: input.loaded.secrets,
    transport: input.transport,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.sleep === undefined ? {} : { sleep: input.sleep })
  });
}

function createVisualEmbeddingAdapterFromProvider(input: {
  readonly loaded: ReturnType<typeof loadEmbeddingProviderRuntimeConfigFromEnv>;
  readonly transport: ProviderTransport;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): VisualEmbeddingAdapter {
  const provider = normalizeProviderName(input.loaded.config.provider);
  if (provider === "colpali" || provider === "colpali-compatible") {
    return createColPaliVisualEmbeddingAdapter({
      config: input.loaded.config,
      dimensions: input.loaded.dimensions,
      secrets: input.loaded.secrets,
      transport: input.transport,
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.sleep === undefined ? {} : { sleep: input.sleep })
    });
  }

  return createIndexedVisualEmbeddingAdapter({
    config: input.loaded.config,
    dimensions: input.loaded.dimensions,
    secrets: input.loaded.secrets,
    transport: input.transport,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.sleep === undefined ? {} : { sleep: input.sleep })
  });
}

function createRerankerFromProvider(input: {
  readonly loaded: ReturnType<typeof loadProviderRuntimeConfigFromEnv>;
  readonly transport: ProviderTransport;
  readonly env: ProviderEnv;
  readonly prefix: string;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly temperature?: number;
  readonly anthropicVersion?: string;
  readonly anthropicBeta?: string;
}): Reranker {
  const provider = normalizeProviderName(input.loaded.config.provider);
  const adapter =
    provider === "anthropic" || provider === "claude"
      ? createAnthropicRerankAdapter({
          config: input.loaded.config,
          secrets: input.loaded.secrets,
          transport: input.transport,
          ...(input.now === undefined ? {} : { now: input.now }),
          ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
          ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
          ...readAnthropicOptions(input)
        })
      : provider === "openai" || provider === "openai-compatible"
        ? createOpenAICompatibleRerankAdapter({
            config: input.loaded.config,
            secrets: input.loaded.secrets,
            transport: input.transport,
            ...(input.now === undefined ? {} : { now: input.now }),
            ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
            ...(input.temperature === undefined ? {} : { temperature: input.temperature })
          })
        : createJsonRerankAdapter({
            config: input.loaded.config,
            secrets: input.loaded.secrets,
            transport: input.transport,
            ...(input.now === undefined ? {} : { now: input.now }),
            ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
            ...(input.temperature === undefined ? {} : { temperature: input.temperature })
          });

  return new ModelBackedReranker({
    adapter,
    ...(input.now === undefined ? {} : { now: input.now })
  });
}

function createGroundingJudgeFromProvider(input: {
  readonly loaded: ReturnType<typeof loadProviderRuntimeConfigFromEnv>;
  readonly transport: ProviderTransport;
  readonly env: ProviderEnv;
  readonly prefix: string;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly temperature?: number;
  readonly anthropicVersion?: string;
  readonly anthropicBeta?: string;
}): NonNullable<RagRuntimeAssemblyConfig["groundingJudge"]> {
  const provider = normalizeProviderName(input.loaded.config.provider);
  const adapter =
    provider === "anthropic" || provider === "claude"
      ? createAnthropicGroundingJudgeAdapter({
          config: input.loaded.config,
          secrets: input.loaded.secrets,
          transport: input.transport,
          ...(input.now === undefined ? {} : { now: input.now }),
          ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
          ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
          ...readAnthropicOptions(input)
        })
      : provider === "openai" || provider === "openai-compatible"
        ? createOpenAICompatibleGroundingJudgeAdapter({
            config: input.loaded.config,
            secrets: input.loaded.secrets,
            transport: input.transport,
            ...(input.now === undefined ? {} : { now: input.now }),
            ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
            ...(input.temperature === undefined ? {} : { temperature: input.temperature })
          })
        : createJsonGroundingJudgeAdapter({
            config: input.loaded.config,
            secrets: input.loaded.secrets,
            transport: input.transport,
            ...(input.now === undefined ? {} : { now: input.now }),
            ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
            ...(input.temperature === undefined ? {} : { temperature: input.temperature })
          });

  return createModelBackedGroundingJudgeFromAdapter({
    adapter,
    ...(input.now === undefined ? {} : { now: input.now })
  });
}

function readAnthropicOptions(input: {
  readonly env: ProviderEnv;
  readonly prefix: string;
  readonly anthropicVersion?: string;
  readonly anthropicBeta?: string;
}): { readonly anthropicVersion?: string; readonly anthropicBeta?: string } {
  const anthropicVersion =
    input.anthropicVersion ?? readOptionalEnv(input.env, `${input.prefix}_ANTHROPIC_VERSION`);
  const anthropicBeta =
    input.anthropicBeta ?? readOptionalEnv(input.env, `${input.prefix}_ANTHROPIC_BETA`);

  return {
    ...(anthropicVersion === undefined ? {} : { anthropicVersion }),
    ...(anthropicBeta === undefined ? {} : { anthropicBeta })
  };
}

function readOptionalEnv(env: ProviderEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function normalizeProviderName(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, "-");
}

function resolveTransport(options: LiveProviderAdaptersFromEnvOptions): ProviderTransport {
  if (options.transport !== undefined && options.fetch !== undefined) {
    throw new Error("Pass either transport or fetch, not both.");
  }

  if (options.transport !== undefined) {
    return options.transport;
  }

  return new FetchProviderTransport(options.fetch === undefined ? {} : { fetch: options.fetch });
}
