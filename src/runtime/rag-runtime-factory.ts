import type { ContextBuilder } from "../context/context-builder.js";
import type { EmbeddingAdapter } from "../embeddings/embedding-types.js";
import type { VisualEmbeddingAdapter } from "../embeddings/visual-embedding-types.js";
import {
  GenerationOrchestrator,
  type GenerationOrchestratorOptions
} from "../generation/generation-orchestrator.js";
import { GraphApprovalRunner, type GraphApprovalPolicy } from "../graph/graph-approval.js";
import type { GraphApprovalDecisionLedger } from "../graph/graph-approval-ledger.js";
import {
  GraphEntityResolutionRunner,
  type GraphEntityResolutionRunRequest,
  type GraphEntityResolutionRunResult
} from "../graph/graph-entity-resolution.js";
import {
  GraphIngestionRunner,
  type GraphIngestionRequest,
  type GraphIngestionResult
} from "../graph/graph-ingestion.js";
import type { GraphExtractor } from "../graph/graph-extractor.js";
import type { GraphOntology } from "../graph/graph-types.js";
import { InMemoryGraphStore, type GraphStore } from "../graph/in-memory-graph-store.js";
import { JsonFileGraphStore } from "../graph/json-file-graph-store.js";
import { ProposalBackedRagGraphStore } from "../graph/proposal-graph-adapter.js";
import { SqliteGraphStore } from "../graph/sqlite-graph-store.js";
import type { ChunkStore } from "../indexing/chunk-store.js";
import type { ChunkRelationship } from "../ingestion/chunk-relationships.js";
import type { RetrievalReadinessReport } from "../ingestion/retrieval-readiness.js";
import { PostgresRagIndex } from "../indexing/postgres-index.js";
import { SqliteRagIndex } from "../indexing/sqlite-rag-index.js";
import type { VectorStore } from "../indexing/vector-store.js";
import type { VisualVectorStore } from "../indexing/visual-vector-store.js";
import type { ModelAdapter } from "../model/model-types.js";
import type { RagProfile } from "../profiles/profile.js";
import { assertValidProfile, type ValidatedRagProfile } from "../profiles/profile-validation.js";
import type { QueryPlanner } from "../query/query-types.js";
import { HybridRetriever } from "../retrieval/hybrid-retriever.js";
import { AdaptiveRetrievalController } from "../retrieval/adaptive-retrieval-controller.js";
import {
  ConnectedChunkRetriever,
  type ConnectedChunkRetrieverOptions
} from "../retrieval/connected-chunk-retriever.js";
import { KeywordRetriever } from "../retrieval/keyword-retriever.js";
import { PostgresFtsKeywordRetriever } from "../retrieval/postgres-fts-keyword-retriever.js";
import { FtsKeywordRetriever } from "../retrieval/fts-keyword-retriever.js";
import { GraphAugmentedRetriever } from "../retrieval/graph-augmented-retriever.js";
import { LightweightReranker } from "../retrieval/lightweight-reranker.js";
import { RerankingRetriever } from "../retrieval/reranking-retriever.js";
import type { Reranker, RerankProfileConfig } from "../retrieval/reranker.js";
import type { Retriever } from "../retrieval/retriever.js";
import { VisualRetriever } from "../retrieval/visual-retriever.js";
import { VectorRetriever } from "../retrieval/vector-retriever.js";
import { RagAgentRuntime } from "./rag-agent-runtime.js";
import { RagAnswerRuntime, type GenerationRunner } from "./rag-answer-runtime.js";
import type {
  RagAgentRequest,
  RagAgentResult,
  RagAnswerRequest,
  RagAnswerResult,
  RagQueryResult
} from "./runtime-types.js";

export type AssembledRagAnswerRequest = Omit<RagAnswerRequest, "profile" | "model">;
export type AssembledRagAgentRequest = Omit<RagAgentRequest, "profile" | "model">;
export type AssembledRagQueryRequest = Omit<RagAnswerRequest, "profile" | "model">;
export type AssembledGraphIngestionRequest = Omit<
  GraphIngestionRequest,
  "profile" | "ontology" | "approvalFilter"
> & {
  readonly approvalFilter?: GraphIngestionRequest["approvalFilter"];
};

export interface RagRuntimeGraphAssemblyConfig {
  readonly ontology: GraphOntology;
  readonly extractor?: GraphExtractor;
  readonly graphStore?: GraphStore;
  readonly graphStoreKind?: "memory" | "json_file" | "sqlite";
  readonly graphStorePath?: string;
  readonly approvalPolicy?: GraphApprovalPolicy;
  readonly approvalLedger?: GraphApprovalDecisionLedger;
  readonly autoApprove?: boolean;
  readonly autoResolveEntities?: boolean;
}

export interface RagRuntimeAssemblyConfig {
  readonly profile: RagProfile | ValidatedRagProfile;
  readonly chunkStore: ChunkStore;
  readonly model: ModelAdapter;
  readonly embeddingAdapter?: EmbeddingAdapter;
  readonly vectorStore?: VectorStore;
  readonly visualEmbeddingAdapter?: VisualEmbeddingAdapter;
  readonly visualVectorStore?: VisualVectorStore;
  readonly reranker?: Reranker;
  readonly groundingJudge?: GenerationOrchestratorOptions["groundingJudge"];
  readonly contextBuilder?: ContextBuilder;
  readonly generationRunner?: GenerationRunner;
  readonly queryPlanner?: QueryPlanner;
  readonly adaptiveRetrieval?: boolean;
  readonly connectedChunkExpansion?:
    | boolean
    | Omit<ConnectedChunkRetrieverOptions, "retriever" | "chunkStore">;
  readonly chunkRelationships?: readonly ChunkRelationship[];
  readonly retrievalReadiness?: RetrievalReadinessReport;
  readonly graph?: RagRuntimeGraphAssemblyConfig;
  readonly now?: () => string;
}

export interface AssembledRagRuntime {
  readonly profile: ValidatedRagProfile;
  readonly runtime: RagAnswerRuntime;
  readonly retriever: Retriever;
  readonly model: ModelAdapter;
  readonly embeddingAdapter?: EmbeddingAdapter;
  readonly vectorStore?: VectorStore;
  readonly visualEmbeddingAdapter?: VisualEmbeddingAdapter;
  readonly visualVectorStore?: VisualVectorStore;
  readonly reranker?: Reranker;
  readonly groundingJudge?: GenerationOrchestratorOptions["groundingJudge"];
  readonly queryPlanner?: QueryPlanner;
  readonly agentRuntime: RagAgentRuntime;
  readonly graphStore?: GraphStore;
  readonly graphApprovalRunner?: GraphApprovalRunner;
  readonly graphIngestionRunner?: GraphIngestionRunner;
  readonly graphEntityResolutionRunner?: GraphEntityResolutionRunner;
  readonly retrievalReadinessWarnings: readonly string[];
  query(request: AssembledRagQueryRequest): Promise<RagQueryResult>;
  answer(request: AssembledRagAnswerRequest): Promise<RagAnswerResult>;
  agent(request: AssembledRagAgentRequest): Promise<RagAgentResult>;
  ingestGraph?(request: AssembledGraphIngestionRequest): Promise<GraphIngestionResult>;
  resolveGraphEntities?(
    request: Omit<GraphEntityResolutionRunRequest, "filter"> & {
      readonly filter: GraphEntityResolutionRunRequest["filter"];
    }
  ): GraphEntityResolutionRunResult;
}

export function assembleRagRuntime(config: RagRuntimeAssemblyConfig): AssembledRagRuntime {
  const profile = assertValidProfile(config.profile);
  const graphConfig = config.graph;
  const graphStore = createGraphStore(graphConfig);
  const graphApprovalRunner =
    graphStore && config.graph?.autoApprove
      ? new GraphApprovalRunner({
          graphStore,
          ...(config.graph.approvalPolicy === undefined
            ? {}
            : { policy: config.graph.approvalPolicy }),
          ...(config.graph.approvalLedger === undefined
            ? {}
            : { ledger: config.graph.approvalLedger }),
          ...(config.now === undefined ? {} : { now: config.now })
        })
      : undefined;
  const graphIngestionRunner =
    graphStore && config.graph?.extractor
      ? new GraphIngestionRunner({
          extractor: config.graph.extractor,
          graphStore,
          ...(graphApprovalRunner === undefined ? {} : { approvalRunner: graphApprovalRunner }),
          ...(config.now === undefined ? {} : { now: config.now })
        })
      : undefined;
  const graphEntityResolutionRunner = graphStore
    ? new GraphEntityResolutionRunner({
        graphStore,
        ...(config.now === undefined ? {} : { now: config.now })
      })
    : undefined;
  const retriever = createRetrieverForProfile(profile, config, graphStore);
  const generationRunner =
    config.generationRunner ??
    (config.groundingJudge
      ? new GenerationOrchestrator({
          groundingJudge: config.groundingJudge,
          ...(config.now === undefined ? {} : { now: config.now })
        })
      : undefined);
  const runtime = new RagAnswerRuntime({
    retriever,
    ...(config.contextBuilder === undefined ? {} : { contextBuilder: config.contextBuilder }),
    ...(generationRunner === undefined ? {} : { generationRunner }),
    ...(config.queryPlanner === undefined ? {} : { queryPlanner: config.queryPlanner }),
    ...(config.now === undefined ? {} : { now: config.now })
  });
  const agentRuntime = new RagAgentRuntime({
    answerRuntime: runtime,
    ...(config.now === undefined ? {} : { now: config.now })
  });

  return {
    profile,
    runtime,
    retriever,
    model: config.model,
    ...(config.embeddingAdapter === undefined ? {} : { embeddingAdapter: config.embeddingAdapter }),
    ...(config.vectorStore === undefined ? {} : { vectorStore: config.vectorStore }),
    ...(config.visualEmbeddingAdapter === undefined
      ? {}
      : { visualEmbeddingAdapter: config.visualEmbeddingAdapter }),
    ...(config.visualVectorStore === undefined
      ? {}
      : { visualVectorStore: config.visualVectorStore }),
    ...(config.reranker === undefined ? {} : { reranker: config.reranker }),
    ...(config.groundingJudge === undefined ? {} : { groundingJudge: config.groundingJudge }),
    ...(config.queryPlanner === undefined ? {} : { queryPlanner: config.queryPlanner }),
    agentRuntime,
    ...(graphStore === undefined ? {} : { graphStore }),
    ...(graphApprovalRunner === undefined ? {} : { graphApprovalRunner }),
    ...(graphIngestionRunner === undefined ? {} : { graphIngestionRunner }),
    ...(graphEntityResolutionRunner === undefined ? {} : { graphEntityResolutionRunner }),
    retrievalReadinessWarnings: runtimeReadinessWarnings(profile, config),
    query: (request) =>
      runtime.query({
        ...request,
        profile
      }),
    answer: (request) =>
      runtime.answer({
        ...request,
        profile,
        model: config.model
      }),
    agent: (request) =>
      agentRuntime.run({
        ...request,
        profile,
        model: config.model
      }),
    ...(graphIngestionRunner === undefined || graphConfig === undefined
      ? {}
      : {
          ingestGraph: async (request: AssembledGraphIngestionRequest) => {
            const result = await graphIngestionRunner.ingest({
              documents: request.documents,
              chunks: request.chunks,
              profile,
              ontology: graphConfig.ontology,
              ...(request.approvalFilter === undefined
                ? {}
                : { approvalFilter: request.approvalFilter }),
              ...(request.ingestionId === undefined ? {} : { ingestionId: request.ingestionId }),
              ...(request.requestedAt === undefined ? {} : { requestedAt: request.requestedAt })
            });
            if (
              result.status === "succeeded" &&
              graphConfig.autoResolveEntities &&
              graphEntityResolutionRunner &&
              request.approvalFilter
            ) {
              graphEntityResolutionRunner.resolve({
                filter: request.approvalFilter,
                runId: `${result.trace.ingestionId}_entity_resolution`,
                requestedAt: result.trace.finishedAt
              });
            }
            return result;
          }
        }),
    ...(graphEntityResolutionRunner === undefined
      ? {}
      : {
          resolveGraphEntities: (
            request: Omit<GraphEntityResolutionRunRequest, "filter"> & {
              readonly filter: GraphEntityResolutionRunRequest["filter"];
            }
          ) => graphEntityResolutionRunner.resolve(request)
        })
  };
}

function createRetrieverForProfile(
  profile: ValidatedRagProfile,
  config: RagRuntimeAssemblyConfig,
  graphStore?: GraphStore
): Retriever {
  const baseRetriever = createBaseRetrieverForProfile(profile, config);
  const graphAwareRetriever =
    graphStore === undefined
      ? baseRetriever
      : new GraphAugmentedRetriever({
          baseRetriever,
          graphStore: new ProposalBackedRagGraphStore(graphStore),
          chunkStore: config.chunkStore,
          ...(config.now === undefined ? {} : { now: config.now })
        });
  const connectedRetriever = wrapRetrieverWithConnectedChunks(graphAwareRetriever, config);
  const rerankedRetriever = wrapRetrieverWithReranker(profile, connectedRetriever, config);
  if (config.adaptiveRetrieval === false) {
    return rerankedRetriever;
  }
  return new AdaptiveRetrievalController({
    retriever: rerankedRetriever,
    ...(config.now === undefined ? {} : { now: config.now })
  });
}

function runtimeReadinessWarnings(
  profile: ValidatedRagProfile,
  config: RagRuntimeAssemblyConfig
): readonly string[] {
  const readiness = config.retrievalReadiness;
  if (readiness === undefined) {
    return [];
  }

  const warnings: string[] = [];
  if (!readiness.textIndexReady) {
    warnings.push("runtime_text_index_not_ready");
  }
  if (
    (profile.retrieval.mode === "vector" || profile.retrieval.mode === "hybrid") &&
    !readiness.vectorIndexReady
  ) {
    warnings.push("runtime_vector_index_not_ready");
  }
  if (profile.retrieval.mode === "visual" && !readiness.visualIndexReady) {
    warnings.push("runtime_visual_index_not_ready");
  }
  if (config.graph !== undefined && !readiness.graphReady) {
    warnings.push("runtime_graph_not_ready");
  }
  if (config.connectedChunkExpansion !== false && !readiness.connectedChunkExpansionReady) {
    warnings.push("runtime_connected_chunk_expansion_not_ready");
  }

  return [...new Set([...warnings, ...readiness.warningCodes])].sort();
}

function wrapRetrieverWithConnectedChunks(
  retriever: Retriever,
  config: RagRuntimeAssemblyConfig
): Retriever {
  if (config.connectedChunkExpansion === false) {
    return retriever;
  }

  const options =
    config.connectedChunkExpansion === undefined || config.connectedChunkExpansion === true
      ? {}
      : config.connectedChunkExpansion;

  return new ConnectedChunkRetriever({
    retriever,
    chunkStore: config.chunkStore,
    ...(config.chunkRelationships === undefined
      ? {}
      : { chunkRelationships: config.chunkRelationships }),
    ...options
  });
}

function createGraphStore(
  config: RagRuntimeGraphAssemblyConfig | undefined
): GraphStore | undefined {
  if (config === undefined) {
    return undefined;
  }
  if (config.graphStore !== undefined) {
    return config.graphStore;
  }
  if (config.graphStoreKind === "sqlite") {
    if (config.graphStorePath === undefined) {
      throw new Error("graph.graphStorePath is required when graphStoreKind is sqlite.");
    }
    return new SqliteGraphStore({ filePath: config.graphStorePath });
  }
  if (config.graphStoreKind === "memory") {
    return new InMemoryGraphStore();
  }
  if (config.graphStoreKind === "json_file" && config.graphStorePath === undefined) {
    throw new Error("graph.graphStorePath is required when graphStoreKind is json_file.");
  }
  if (config.graphStorePath !== undefined) {
    return new JsonFileGraphStore({ filePath: config.graphStorePath });
  }
  return new InMemoryGraphStore();
}

function createBaseRetrieverForProfile(
  profile: ValidatedRagProfile,
  config: RagRuntimeAssemblyConfig
): Retriever {
  switch (profile.retrieval.mode) {
    case "keyword":
      return createKeywordRetriever(config);
    case "vector": {
      const vector = requireVectorComponents(profile.retrieval.mode, config);
      return new VectorRetriever({
        embeddingAdapter: vector.embeddingAdapter,
        vectorStore: vector.vectorStore,
        ...(config.now === undefined ? {} : { now: config.now })
      });
    }
    case "hybrid": {
      const vector = requireVectorComponents(profile.retrieval.mode, config);
      return new HybridRetriever({
        keywordRetriever: createKeywordRetriever(config),
        vectorRetriever: new VectorRetriever({
          embeddingAdapter: vector.embeddingAdapter,
          vectorStore: vector.vectorStore,
          ...(config.now === undefined ? {} : { now: config.now })
        }),
        ...(config.now === undefined ? {} : { now: config.now })
      });
    }
    case "visual": {
      const visual = requireVisualComponents(profile.retrieval.mode, config);
      return new VisualRetriever({
        embeddingAdapter: visual.visualEmbeddingAdapter,
        vectorStore: visual.visualVectorStore,
        ...(config.now === undefined ? {} : { now: config.now })
      });
    }
  }
}

function createKeywordRetriever(config: RagRuntimeAssemblyConfig): Retriever {
  if (config.chunkStore instanceof PostgresRagIndex) {
    return new PostgresFtsKeywordRetriever({
      index: config.chunkStore,
      ...(config.now === undefined ? {} : { now: config.now })
    });
  }
  if (config.chunkStore instanceof SqliteRagIndex) {
    return new FtsKeywordRetriever({
      index: config.chunkStore,
      fusionStrategy: "sqlite_fts",
      ...(config.now === undefined ? {} : { now: config.now })
    });
  }

  return new KeywordRetriever({
    chunkStore: config.chunkStore,
    ...(config.now === undefined ? {} : { now: config.now })
  });
}

function wrapRetrieverWithReranker(
  profile: ValidatedRagProfile,
  retriever: Retriever,
  config: RagRuntimeAssemblyConfig
): Retriever {
  switch (profile.retrieval.rerankMode) {
    case "none":
      return retriever;
    case "lightweight":
      return new RerankingRetriever({
        profile: rerankProfileConfig(profile),
        retriever,
        reranker: config.reranker ?? new LightweightReranker(config),
        ...(config.now === undefined ? {} : { now: config.now })
      });
    case "model":
      if (config.reranker === undefined) {
        throw new Error("Profile rerankMode 'model' requires a configured model-backed reranker.");
      }

      return new RerankingRetriever({
        profile: rerankProfileConfig(profile),
        retriever,
        reranker: config.reranker,
        ...(config.now === undefined ? {} : { now: config.now })
      });
  }
}

function rerankProfileConfig(profile: ValidatedRagProfile): RerankProfileConfig {
  return {
    id: profile.id,
    namespaceId: profile.namespaceId,
    modelTier: profile.modelPolicy.defaultTierByRole.context_evaluation,
    allowModelFallback: profile.modelPolicy.allowModelFallback
  };
}

function requireVectorComponents(
  mode: "vector" | "hybrid",
  config: RagRuntimeAssemblyConfig
): {
  readonly embeddingAdapter: EmbeddingAdapter;
  readonly vectorStore: VectorStore;
} {
  if (config.embeddingAdapter === undefined || config.vectorStore === undefined) {
    throw new Error(`Profile retrieval mode '${mode}' requires embeddingAdapter and vectorStore.`);
  }

  return {
    embeddingAdapter: config.embeddingAdapter,
    vectorStore: config.vectorStore
  };
}

function requireVisualComponents(
  mode: "visual",
  config: RagRuntimeAssemblyConfig
): {
  readonly visualEmbeddingAdapter: VisualEmbeddingAdapter;
  readonly visualVectorStore: VisualVectorStore;
} {
  if (config.visualEmbeddingAdapter === undefined || config.visualVectorStore === undefined) {
    throw new Error(
      `Profile retrieval mode '${mode}' requires visualEmbeddingAdapter and visualVectorStore.`
    );
  }

  return {
    visualEmbeddingAdapter: config.visualEmbeddingAdapter,
    visualVectorStore: config.visualVectorStore
  };
}
