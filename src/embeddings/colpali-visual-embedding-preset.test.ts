import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { RagDocument } from "../documents/document.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { InMemoryVisualVectorStore } from "../indexing/visual-vector-store.js";
import { VisualRetriever } from "../retrieval/visual-retriever.js";
import type {
  ProviderBoundaryConfig,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import { FIXED_NOW, makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import { VisualEmbeddingIndexer } from "./visual-embedding-indexer.js";
import {
  buildColPaliVisualEmbeddingRequestBody,
  buildColPaliVisualQueryEmbeddingRequestBody,
  createColPaliVisualEmbeddingAdapter
} from "./colpali-visual-embedding-preset.js";

class MockProviderTransport implements ProviderTransport {
  readonly requests: ProviderHttpRequest[] = [];
  private readonly responses: ProviderHttpResponse[];

  constructor(responses: readonly ProviderHttpResponse[]) {
    this.responses = [...responses];
  }

  async send(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No mock ColPali response configured.");
    }
    return response;
  }
}

test("builds ColPali visual asset and query request bodies", () => {
  const visualBody = buildColPaliVisualEmbeddingRequestBody(
    {
      inputs: [
        {
          id: "page_1_doc_chunk",
          chunkId: "chunk_1",
          documentId: "doc_1",
          mediaType: "image/png",
          visualAssetId: "page_1",
          uri: "s3://bucket/page-1.png",
          text: "ownership chart",
          metadata: {
            pageNumber: 1
          }
        }
      ]
    },
    "colpali-v1"
  );
  const queryBody = buildColPaliVisualQueryEmbeddingRequestBody(
    { query: "show ownership chart" },
    "colpali-v1"
  );

  assert.equal(visualBody["task"], "index");
  assert.equal(queryBody["task"], "query");
  assert.deepEqual(visualBody["late_interaction"], {
    scoring: "maxsim",
    vector_granularity: "patch"
  });
  assert.deepEqual(queryBody["late_interaction"], {
    scoring: "maxsim",
    vector_granularity: "token"
  });
});

test("indexes parser-emitted visual assets with ColPali patch vectors and retrieves them", async () => {
  const document = visualDocument();
  const chunkIndex = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const chunks = chunkDocument({ document }).chunks;
  chunkIndex.addDocument(document);
  chunkIndex.addChunks(document.id, chunks);

  const transport = new MockProviderTransport([
    okResponse({
      data: [
        {
          index: 0,
          patch_vectors: [
            [1, 0, 0],
            [0.8, 0.2, 0]
          ],
          visual_asset_id: "page_1"
        }
      ],
      usage: {
        input_count: 1,
        total_input_characters: 29,
        vector_count: 2
      }
    }),
    okResponse({
      query_vectors: [[1, 0, 0]],
      usage: {
        input_count: 1,
        total_input_characters: 21,
        vector_count: 1
      }
    })
  ]);
  const adapter = createColPaliVisualEmbeddingAdapter({
    config: providerConfig(),
    dimensions: 3,
    secrets: {
      apiKeyProvider: () => "colpali-secret"
    },
    transport,
    now: () => FIXED_NOW
  });
  const visualVectorStore = new InMemoryVisualVectorStore({
    chunkStore: chunkIndex,
    dimensions: adapter.dimensions,
    now: () => FIXED_NOW
  });
  const indexer = new VisualEmbeddingIndexer({
    adapter,
    visualVectorStore,
    now: () => FIXED_NOW
  });

  const indexResult = await indexer.indexChunks({
    documents: [document],
    chunks,
    requestedAt: FIXED_NOW
  });
  const retriever = new VisualRetriever({
    embeddingAdapter: adapter,
    vectorStore: visualVectorStore,
    now: () => FIXED_NOW
  });
  const retrieval = await retriever.retrieve({
    query: "show ownership chart",
    filter: makeIndexFilter(),
    topK: 1,
    requestedAt: FIXED_NOW
  });

  assert.equal(indexResult.candidateChunkCount, 1);
  assert.equal(indexResult.indexedVisualVectorCount, 1);
  assert.equal(await visualVectorStore.visualVectorCount(), 1);
  assert.equal(retrieval.candidates[0]?.chunk.documentId, "visual_doc");
  assert.equal(retrieval.candidates[0]?.citation.pageNumber, 1);
  assert.deepEqual(retrieval.candidates[0]?.citation.layoutRegionIds, [
    "region_title",
    "region_chart"
  ]);
  assert.equal(transport.requests.length, 2);
  assert.equal(transport.requests[0]?.headers.authorization, "Bearer colpali-secret");
});

function visualDocument(): RagDocument {
  const body = "Ownership Chart\n\nParent LLC owns Child LLC.";
  const titleEnd = body.indexOf("\n\n");
  const bodyStart = titleEnd + 2;
  return {
    ...makeDocument({
      id: "visual_doc",
      body
    }),
    layout: {
      parserId: "deepdoc-json",
      parserVersion: "1.0.0",
      strategy: "hybrid",
      pages: [{ pageNumber: 1, width: 1000, height: 1400, unit: "pixel" }],
      regions: [
        {
          id: "region_title",
          kind: "title",
          pageNumber: 1,
          text: body.slice(0, titleEnd),
          characterStart: 0,
          characterEnd: titleEnd,
          box: {
            pageNumber: 1,
            x: 100,
            y: 120,
            width: 700,
            height: 480,
            unit: "pixel"
          }
        },
        {
          id: "region_chart",
          kind: "paragraph",
          pageNumber: 1,
          text: body.slice(bodyStart),
          characterStart: bodyStart,
          characterEnd: body.length,
          box: {
            pageNumber: 1,
            x: 100,
            y: 620,
            width: 700,
            height: 180,
            unit: "pixel"
          }
        }
      ],
      visualAssets: [
        {
          id: "page_1",
          kind: "page_image",
          pageNumber: 1,
          mediaType: "image/png",
          uri: "s3://bucket/visual-doc-page-1.png"
        }
      ]
    }
  };
}

function providerConfig(): ProviderBoundaryConfig {
  return {
    id: "colpali-visual",
    provider: "colpali",
    modelName: "colpali-v1",
    endpoint: "https://provider.example.invalid/v1/colpali",
    timeoutMs: 5000,
    retryPolicy: {
      maxRetries: 0,
      backoffMs: 0,
      retryStatusCodes: [429, 500]
    }
  };
}

function okResponse(body: unknown): ProviderHttpResponse {
  return {
    status: 200,
    headers: {},
    body,
    latencyMs: 10
  };
}
