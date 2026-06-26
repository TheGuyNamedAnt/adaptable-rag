import { ContextBuilder } from "../context/context-builder.js";
import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import { FakeVisualEmbeddingAdapter } from "../embeddings/fake-visual-embedding-adapter.js";
import { VisualEmbeddingIndexer } from "../embeddings/visual-embedding-indexer.js";
import type { RagGraphStore } from "../graph/graph-store.js";
import type { ChunkStore } from "../indexing/chunk-store.js";
import { InMemoryVisualVectorStore } from "../indexing/visual-vector-store.js";
import type { ValidatedRagProfile } from "../profiles/profile-validation.js";
import { GraphAugmentedRetriever } from "../retrieval/graph-augmented-retriever.js";
import { KeywordRetriever } from "../retrieval/keyword-retriever.js";
import type { Retriever } from "../retrieval/retriever.js";
import { VisualRetriever } from "../retrieval/visual-retriever.js";
import { RagAnswerRuntime } from "./rag-answer-runtime.js";

export interface LocalEvalRuntimeRequest {
  readonly profile: ValidatedRagProfile;
  readonly chunkStore: ChunkStore;
  readonly documents: readonly RagDocument[];
  readonly chunks: readonly RagChunk[];
  readonly knowledgeMapStore?: RagGraphStore;
  readonly now: () => string;
}

export interface LocalEvalRuntimeSetup {
  readonly runtime: RagAnswerRuntime;
  readonly failures: readonly string[];
}

export async function createLocalEvalRuntime(
  request: LocalEvalRuntimeRequest
): Promise<LocalEvalRuntimeSetup> {
  switch (request.profile.retrieval.mode) {
    case "keyword": {
      const baseRetriever = new KeywordRetriever({
        chunkStore: request.chunkStore,
        now: request.now
      });
      const retriever: Retriever = request.knowledgeMapStore
        ? new GraphAugmentedRetriever({
            baseRetriever,
            graphStore: request.knowledgeMapStore,
            chunkStore: request.chunkStore,
            now: request.now
          })
        : baseRetriever;

      return {
        runtime: new RagAnswerRuntime({
          retriever,
          contextBuilder: new ContextBuilder({ now: request.now }),
          now: request.now
        }),
        failures: []
      };
    }
    case "visual": {
      const visualEmbeddingAdapter = new FakeVisualEmbeddingAdapter({ dimensions: 16 });
      const visualVectorStore = new InMemoryVisualVectorStore({
        chunkStore: request.chunkStore,
        dimensions: visualEmbeddingAdapter.dimensions,
        now: request.now
      });
      const visualIndexResult = await new VisualEmbeddingIndexer({
        adapter: visualEmbeddingAdapter,
        visualVectorStore,
        now: request.now
      }).indexChunks({
        documents: request.documents,
        chunks: request.chunks,
        requestedAt: request.now(),
        overwriteMode: "replace"
      });

      return {
        runtime: new RagAnswerRuntime({
          retriever: new VisualRetriever({
            embeddingAdapter: visualEmbeddingAdapter,
            vectorStore: visualVectorStore,
            now: request.now
          }),
          contextBuilder: new ContextBuilder({ now: request.now }),
          now: request.now
        }),
        failures: visualIndexResult.warnings.map(
          (warning) =>
            `Visual index warning${warning.chunkId ? ` for ${warning.chunkId}` : ""}: ${
              warning.code
            }.`
        )
      };
    }
    case "vector":
    case "hybrid":
      throw new Error(
        `Eval runner cannot serve retrieval mode "${request.profile.retrieval.mode}" without configured vector eval components.`
      );
  }
}
