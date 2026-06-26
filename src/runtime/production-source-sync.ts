import type { ChunkingPolicy } from "../chunking/chunk-policy.js";
import type { CorpusSourceConfig } from "../profiles/profile.js";
import type { IndexFilter, IndexOverwriteMode } from "../indexing/index-types.js";
import type { RequestPrincipal } from "../security/access-scope.js";
import type { SourceConnector, SourceSyncMode } from "../sync/source-connector.js";
import type { SourceSyncLedger } from "../sync/sync-ledger.js";
import { ProductionRagRequestError, type ProductionRagApp } from "./production-app.js";
import {
  SourceSyncWorkflowRunner,
  type SourceSyncWorkflowKnowledgeIngestionOptions,
  type SourceSyncWorkflowResult
} from "./source-sync-workflow.js";

export interface ProductionSourceSyncRuntimeOptions {
  readonly app: ProductionRagApp;
  readonly connector: SourceConnector;
  readonly knowledgeIngestion?: SourceSyncWorkflowKnowledgeIngestionOptions;
  readonly chunkingPolicy?: ChunkingPolicy;
  readonly now?: () => string;
}

export interface ProductionSourceSyncInput {
  readonly sourceId: string;
  readonly requestedBy: RequestPrincipal;
  readonly filter?: IndexFilter;
  readonly mode?: SourceSyncMode;
  readonly previousLedger?: SourceSyncLedger;
  readonly runId?: string;
  readonly requestedAt?: string;
  readonly deleteMissingItems?: boolean;
  readonly overwriteMode?: IndexOverwriteMode;
}

export interface ProductionSourceSyncRuntime {
  sync(input: ProductionSourceSyncInput): Promise<SourceSyncWorkflowResult>;
}

export function createProductionSourceSyncRuntime(
  options: ProductionSourceSyncRuntimeOptions
): ProductionSourceSyncRuntime {
  const workflow = new SourceSyncWorkflowRunner({
    connector: options.connector,
    documentStore: options.app.chunkStore,
    chunkStore: options.app.chunkStore,
    ...(options.app.sourceSyncLedgerStore === undefined
      ? {}
      : { ledgerStore: options.app.sourceSyncLedgerStore }),
    ...(options.app.vectorStore === undefined ? {} : { vectorStore: options.app.vectorStore }),
    ...(options.app.runtime.embeddingAdapter === undefined
      ? {}
      : { embeddingAdapter: options.app.runtime.embeddingAdapter }),
    ...(options.app.visualVectorStore === undefined
      ? {}
      : { visualVectorStore: options.app.visualVectorStore }),
    ...(options.app.visualEmbeddingAdapter === undefined
      ? {}
      : { visualEmbeddingAdapter: options.app.visualEmbeddingAdapter }),
    ...(options.app.runtime.graphStore === undefined
      ? {}
      : { graphStore: options.app.runtime.graphStore }),
    ...(options.knowledgeIngestion === undefined
      ? {}
      : { knowledgeIngestion: options.knowledgeIngestion }),
    ...(options.chunkingPolicy === undefined ? {} : { chunkingPolicy: options.chunkingPolicy }),
    ...(options.now === undefined ? {} : { now: options.now })
  });

  return {
    sync: async (input) => {
      const source = productionSourceById(options.app, input.sourceId);
      return workflow.run({
        profile: options.app.profile,
        source,
        requestedBy: input.requestedBy,
        ...(input.filter === undefined ? {} : { filter: input.filter }),
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(input.previousLedger === undefined ? {} : { previousLedger: input.previousLedger }),
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.requestedAt === undefined ? {} : { requestedAt: input.requestedAt }),
        ...(input.deleteMissingItems === undefined
          ? {}
          : { deleteMissingItems: input.deleteMissingItems }),
        ...(input.overwriteMode === undefined ? {} : { overwriteMode: input.overwriteMode })
      });
    }
  };
}

function productionSourceById(app: ProductionRagApp, sourceId: string): CorpusSourceConfig {
  if (!sourceId.trim()) {
    throw new ProductionRagRequestError("sourceId is required.");
  }

  const source = app.profile.corpusSources.find(
    (candidate) => candidate.enabled && candidate.id === sourceId
  );
  if (!source) {
    throw new ProductionRagRequestError(
      `Source "${sourceId}" is not enabled for profile "${app.profile.id}".`
    );
  }

  return source;
}
