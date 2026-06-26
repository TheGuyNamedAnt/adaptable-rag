import assert from "node:assert/strict";
import test from "node:test";

import type { CorpusRecord } from "../corpus/corpus-record.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { InMemoryVectorStore } from "../indexing/vector-store.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import type { CorpusSourceConfig } from "../profiles/profile.js";
import type {
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import type {
  SourceConnector,
  SourceConnectorSyncRequest,
  SourceConnectorSyncResult
} from "../sync/source-connector.js";
import { InMemorySourceSyncLedgerStore } from "../sync/sync-ledger.js";
import { FIXED_NOW, TEST_PRINCIPAL, makeIndexFilter } from "../test-support/fixtures.js";
import { createProductionRagApp, type ProductionRagAppConfig } from "./production-app.js";
import { createProductionSourceSyncRuntime } from "./production-source-sync.js";

const source: CorpusSourceConfig = {
  id: "curated_docs",
  adapter: "production-source-sync-test",
  description: "Production source sync fixture.",
  enabled: true,
  trustTierFloor: "trusted_internal",
  tags: ["curated"]
};

class FixtureConnector implements SourceConnector {
  readonly id = "fixture-production-connector";
  readonly description = "Fixture production source connector.";
  readonly requests: SourceConnectorSyncRequest[] = [];

  constructor(private readonly result: SourceConnectorSyncResult) {}

  async sync(request: SourceConnectorSyncRequest): Promise<SourceConnectorSyncResult> {
    this.requests.push(request);
    return this.result;
  }
}

class DynamicEmbeddingTransport implements ProviderTransport {
  readonly requests: ProviderHttpRequest[] = [];

  async send(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(request);
    const input =
      isRecord(request.body) && Array.isArray(request.body["input"]) ? request.body["input"] : [];
    return {
      status: 200,
      headers: {},
      latencyMs: 5,
      body: {
        data: input.map((_value, index) => ({
          index,
          embedding: [1, 0, 0, 0]
        }))
      }
    };
  }
}

test("production source sync runtime assembles app stores, ledger, and vector indexing", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const vectorStore = new InMemoryVectorStore({ chunkStore: index, dimensions: 4 });
  const ledgerStore = new InMemorySourceSyncLedgerStore();
  const transport = new DynamicEmbeddingTransport();
  const connector = new FixtureConnector({
    sourceId: source.id,
    complete: true,
    nextCursor: "cursor_1",
    items: [
      {
        operation: "upsert",
        sourceItemId: "source_item_policy",
        version: "1",
        record: record("policy", "Policy text that should be indexed and embedded.")
      }
    ]
  });
  const app = createProductionRagApp({
    config: productionConfig(),
    env: providerEnv(),
    transport,
    chunkStore: index,
    vectorStore,
    sourceSyncLedgerStore: ledgerStore,
    now: () => FIXED_NOW
  });
  const runtime = createProductionSourceSyncRuntime({
    app,
    connector,
    now: () => FIXED_NOW
  });

  const result = await runtime.sync({
    sourceId: source.id,
    requestedBy: TEST_PRINCIPAL,
    filter: makeIndexFilter({ sourceIds: [source.id] }),
    mode: "delta",
    runId: "production_source_sync",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.ledgerSaved, true);
  assert.equal(result.metrics.ingestedDocumentCount, 1);
  assert.equal(result.metrics.indexedVectorCount, 1);
  assert.equal(index.hasDocument("doc_policy", makeIndexFilter()), true);
  assert.equal(vectorStore.vectorCount(), 1);
  assert.equal(transport.requests.length, 1);
  const saved = await ledgerStore.load({
    connectorId: connector.id,
    sourceId: source.id,
    namespaceId: app.profile.namespaceId
  });
  assert.equal(saved?.cursor, "cursor_1");
  assert.equal(connector.requests[0]?.previousCursor, undefined);
});

function productionConfig(): ProductionRagAppConfig {
  return {
    profile: {
      ...genericDocsProfile,
      namespaceId: "test-namespace",
      corpusSources: [source]
    },
    storage: {
      index: { kind: "memory" },
      vector: { kind: "memory", dimensions: 4 },
      sourceSyncLedger: { kind: "memory" }
    },
    providers: {
      modelPrefix: "RAG_MODEL",
      embeddingPrefix: "RAG_EMBEDDING",
      visualEmbeddingPrefix: "RAG_VISUAL_EMBEDDING",
      rerankPrefix: "RAG_RERANK",
      groundingJudgePrefix: "RAG_GROUNDING_JUDGE",
      embeddingMode: "required",
      visualEmbeddingMode: "disabled",
      rerankProviderMode: "disabled",
      groundingJudgeProviderMode: "disabled"
    },
    http: {
      host: "127.0.0.1",
      port: 0,
      maxBodyBytes: 65536,
      auth: {
        mode: "disabled",
        headerName: "authorization",
        tokenSha256s: []
      },
      rateLimit: {
        mode: "disabled",
        windowMs: 60_000,
        maxRequests: 60,
        maxKeys: 100
      },
      operations: {
        logMode: "disabled",
        requestIdHeader: "x-request-id",
        readinessPath: "/ready",
        metricsPath: "/metrics"
      }
    }
  };
}

function providerEnv(): Readonly<Record<string, string | undefined>> {
  return {
    RAG_MODEL_PROVIDER: "json-chat",
    RAG_MODEL_MODEL_NAME: "answer-model",
    RAG_MODEL_ENDPOINT: "https://provider.example.test/v1/chat",
    RAG_MODEL_API_KEY: "model-secret",
    RAG_EMBEDDING_PROVIDER: "indexed-embedding",
    RAG_EMBEDDING_MODEL_NAME: "embedding-model",
    RAG_EMBEDDING_ENDPOINT: "https://provider.example.test/v1/embeddings",
    RAG_EMBEDDING_API_KEY: "embedding-secret",
    RAG_EMBEDDING_DIMENSIONS: "4"
  };
}

function record(id: string, body: string): CorpusRecord {
  return {
    id: `doc_${id}`,
    sourceId: source.id,
    sourceKind: "local_file",
    title: `Document ${id}`,
    body,
    trustTier: "trusted_internal",
    sensitivity: "internal",
    accessScope: {
      tenantId: TEST_PRINCIPAL.tenantId,
      namespaceId: "test-namespace",
      roles: ["support"]
    },
    capturedAt: FIXED_NOW
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
