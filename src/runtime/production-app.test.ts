import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import {
  InMemoryVectorStore,
  type ChunkVector,
  type VectorSnapshot,
  type VectorStore
} from "../indexing/vector-store.js";
import {
  POSTGRES_VECTOR_SCALE_CAPABILITIES,
  type VectorGenerationInventoryProvider
} from "../indexing/scale-capabilities.js";
import { PostgresSourceSyncLedgerStore } from "../sync/sync-ledger.js";
import type {
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import { FIXED_NOW, TEST_PRINCIPAL, makeIndexedFixture } from "../test-support/fixtures.js";
import {
  createProductionRagApp,
  loadProductionRagAppConfigFromEnv,
  ProductionRagConfigError,
  ProductionRagRequestError,
  type ProductionRagAppConfig
} from "./production-app.js";

class MockProviderTransport implements ProviderTransport {
  readonly requests: ProviderHttpRequest[] = [];
  private readonly responses: ProviderHttpResponse[];

  constructor(responses: readonly ProviderHttpResponse[] = []) {
    this.responses = [...responses];
  }

  async send(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No mock response configured.");
    }

    return response;
  }
}

function providerEnv(
  overrides: Readonly<Record<string, string | undefined>> = {}
): Readonly<Record<string, string | undefined>> {
  return {
    RAG_MODEL_PROVIDER: "json-chat",
    RAG_MODEL_MODEL_NAME: "answer-model",
    RAG_MODEL_ENDPOINT: "https://provider.example.test/v1/chat",
    RAG_MODEL_API_KEY: "model-secret",
    RAG_HTTP_AUTH_TOKEN: "edge-token",
    ...overrides
  };
}

function parseEnvFile(body: string): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    assert.notEqual(equalsIndex, -1, `Invalid env line: ${line}`);
    env[line.slice(0, equalsIndex)] = line.slice(equalsIndex + 1);
  }
  return env;
}

function okResponse(body: unknown): ProviderHttpResponse {
  return {
    status: 200,
    headers: {},
    body,
    latencyMs: 10
  };
}

function productionConfig(overrides: Partial<ProductionRagAppConfig> = {}): ProductionRagAppConfig {
  return {
    profile: {
      ...genericDocsProfile,
      namespaceId: "test-namespace"
    },
    storage: {
      index: { kind: "memory" },
      vector: { kind: "none" }
    },
    providers: {
      modelPrefix: "RAG_MODEL",
      embeddingPrefix: "RAG_EMBEDDING",
      visualEmbeddingPrefix: "RAG_VISUAL_EMBEDDING",
      rerankPrefix: "RAG_RERANK",
      groundingJudgePrefix: "RAG_GROUNDING_JUDGE",
      embeddingMode: "disabled",
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
    },
    ...overrides
  };
}

test("loads production config from env without storing raw vector secrets", () => {
  const config = loadProductionRagAppConfigFromEnv({
    cwd: "/tmp/adaptable-rag-test",
    env: providerEnv({
      RAG_APP_PROFILE_PRESET: "ultimate-default",
      RAG_INDEX_KIND: "memory",
      RAG_VECTOR_KIND: "hosted",
      RAG_VECTOR_VENDOR: "qdrant",
      RAG_VECTOR_ENDPOINT: "http://localhost:6333",
      RAG_VECTOR_COLLECTION: "rag_points",
      RAG_VECTOR_API_KEY_ENV: "VECTOR_VENDOR_KEY",
      VECTOR_VENDOR_KEY: "vector-secret",
      RAG_VECTOR_DIMENSIONS: "3",
      RAG_HTTP_PORT: "9191",
      RAG_HTTP_AUTH_TOKEN_ENV: "RAG_EDGE_TOKEN",
      RAG_EDGE_TOKEN: "edge-secret",
      RAG_HTTP_RATE_LIMIT_MAX_REQUESTS: "120",
      RAG_HTTP_LOG_MODE: "json",
      RAG_HTTP_REQUEST_ID_HEADER: "X-Trace-Id",
      RAG_HTTP_READINESS_PATH: "/internal/ready",
      RAG_HTTP_METRICS_PATH: "/internal/metrics",
      RAG_APP_EMBEDDING_MODE: "required",
      RAG_APP_VISUAL_EMBEDDING_PREFIX: "RAG_VISUAL_EMBEDDING",
      RAG_APP_VISUAL_EMBEDDING_MODE: "required"
    })
  });

  assert.equal(config.profile.id, "ultimate-default");
  assert.equal(config.storage.index.kind, "memory");
  assert.equal(config.storage.vector?.kind, "hosted");
  assert.equal(
    config.storage.vector?.kind === "hosted" && config.storage.vector.apiKeyEnv,
    "VECTOR_VENDOR_KEY"
  );
  assert.equal(config.http.port, 9191);
  assert.equal(config.http.auth.mode, "required");
  assert.equal(config.http.auth.tokenSha256s.length, 1);
  assert.equal(config.http.auth.tokenSha256s[0]?.length, 64);
  assert.equal(config.http.rateLimit.maxRequests, 120);
  assert.equal(config.http.operations.logMode, "json");
  assert.equal(config.http.operations.requestIdHeader, "x-trace-id");
  assert.equal(config.http.operations.readinessPath, "/internal/ready");
  assert.equal(config.http.operations.metricsPath, "/internal/metrics");
  assert.equal(config.providers.embeddingMode, "required");
  assert.equal(config.providers.visualEmbeddingPrefix, "RAG_VISUAL_EMBEDDING");
  assert.equal(config.providers.visualEmbeddingMode, "required");
  assert.equal(JSON.stringify(config).includes("vector-secret"), false);
  assert.equal(JSON.stringify(config).includes("edge-secret"), false);
});

test("production config supports HTTP auth hashes, rotated env tokens, and client IP headers", () => {
  const hashConfig = loadProductionRagAppConfigFromEnv({
    env: providerEnv({
      RAG_HTTP_AUTH_TOKEN: undefined,
      RAG_HTTP_AUTH_TOKEN_SHA256S: sha256Hex("edge-token").toUpperCase(),
      RAG_HTTP_AUTH_HEADER: "X-RAG-Token",
      RAG_HTTP_RATE_LIMIT_MODE: "disabled"
    })
  });

  assert.equal(hashConfig.http.auth.headerName, "x-rag-token");
  assert.deepEqual(hashConfig.http.auth.tokenSha256s, [sha256Hex("edge-token")]);
  assert.equal(hashConfig.http.rateLimit.mode, "disabled");

  const rotatedConfig = loadProductionRagAppConfigFromEnv({
    env: providerEnv({
      RAG_HTTP_AUTH_TOKEN: undefined,
      RAG_HTTP_AUTH_TOKEN_ENVS: "RAG_EDGE_TOKEN_A,RAG_EDGE_TOKEN_B",
      RAG_EDGE_TOKEN_A: "edge-token-a",
      RAG_EDGE_TOKEN_B: "edge-token-b",
      RAG_HTTP_CLIENT_IP_HEADER: "X-Forwarded-For",
      RAG_HTTP_RATE_LIMIT_WINDOW_MS: "5000",
      RAG_HTTP_RATE_LIMIT_MAX_KEYS: "2"
    })
  });

  assert.equal(rotatedConfig.http.auth.tokenSha256s.length, 2);
  assert.equal(rotatedConfig.http.rateLimit.clientIpHeader, "x-forwarded-for");
  assert.equal(rotatedConfig.http.rateLimit.windowMs, 5000);
  assert.equal(rotatedConfig.http.rateLimit.maxKeys, 2);
  assert.equal(JSON.stringify(rotatedConfig).includes("edge-token-a"), false);
  assert.equal(JSON.stringify(rotatedConfig).includes("edge-token-b"), false);
});

test("production config supports signed principal freshness and issuer settings", () => {
  const config = loadProductionRagAppConfigFromEnv({
    env: providerEnv({
      RAG_PRINCIPAL_MODE: "signed_header",
      RAG_PRINCIPAL_SIGNING_SECRET_ENV: "RAG_PRINCIPAL_SECRET",
      RAG_PRINCIPAL_SECRET: "principal-secret",
      RAG_PRINCIPAL_MAX_AGE_MS: "300000",
      RAG_PRINCIPAL_CLOCK_SKEW_MS: "60000",
      RAG_PRINCIPAL_ISSUER: "identity-gateway"
    })
  });

  assert.equal(config.http.principal?.mode, "signed_header");
  assert.deepEqual(config.http.principal?.signingSecrets, ["principal-secret"]);
  assert.equal(config.http.principal?.maxAgeMs, 300000);
  assert.equal(config.http.principal?.clockSkewMs, 60000);
  assert.equal(config.http.principal?.issuer, "identity-gateway");
});

test("production config supports disabled and memory visual vector env shapes", () => {
  const disabled = loadProductionRagAppConfigFromEnv({
    env: providerEnv({
      RAG_HTTP_AUTH_MODE: "disabled"
    })
  });

  assert.equal(disabled.storage.visualVector?.kind, "none");

  const memory = loadProductionRagAppConfigFromEnv({
    env: providerEnv({
      RAG_HTTP_AUTH_MODE: "disabled",
      RAG_VISUAL_VECTOR_KIND: "memory",
      RAG_VISUAL_VECTOR_DIMENSIONS: "32"
    })
  });

  assert.equal(memory.storage.visualVector?.kind, "memory");
  assert.equal(
    memory.storage.visualVector?.kind === "memory" && memory.storage.visualVector.dimensions,
    32
  );
});

test("production config supports hosted visual vector env shapes without raw secrets", () => {
  const config = loadProductionRagAppConfigFromEnv({
    env: providerEnv({
      RAG_HTTP_AUTH_MODE: "disabled",
      RAG_VISUAL_VECTOR_KIND: "hosted",
      RAG_VISUAL_VECTOR_VENDOR: "qdrant",
      RAG_VISUAL_VECTOR_ENDPOINT: "http://localhost:6333",
      RAG_VISUAL_VECTOR_COLLECTION: "rag_visual_points",
      RAG_VISUAL_VECTOR_NAME: "visual",
      RAG_VISUAL_VECTOR_API_KEY_ENV: "VISUAL_VECTOR_VENDOR_KEY",
      VISUAL_VECTOR_VENDOR_KEY: "visual-vector-secret",
      RAG_VISUAL_VECTOR_DIMENSIONS: "16"
    })
  });

  assert.equal(config.storage.visualVector?.kind, "hosted");
  assert.equal(
    config.storage.visualVector?.kind === "hosted" && config.storage.visualVector.vendor,
    "qdrant"
  );
  assert.equal(
    config.storage.visualVector?.kind === "hosted" && config.storage.visualVector.collectionName,
    "rag_visual_points"
  );
  assert.equal(
    config.storage.visualVector?.kind === "hosted" && config.storage.visualVector.vectorName,
    "visual"
  );
  assert.equal(
    config.storage.visualVector?.kind === "hosted" && config.storage.visualVector.apiKeyEnv,
    "VISUAL_VECTOR_VENDOR_KEY"
  );
  assert.equal(
    config.storage.visualVector?.kind === "hosted" && config.storage.visualVector.dimensions,
    16
  );
  assert.equal(JSON.stringify(config).includes("visual-vector-secret"), false);
});

test("loads production config from a JSON profile file and durable store env", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-profile-"));
  const profilePath = path.join(directory, "profile.json");
  writeFileSync(profilePath, JSON.stringify(genericDocsProfile), "utf8");

  try {
    const config = loadProductionRagAppConfigFromEnv({
      cwd: directory,
      env: providerEnv({
        RAG_APP_PROFILE_PATH: "profile.json",
        RAG_INDEX_KIND: "json_file",
        RAG_INDEX_PATH: "index.json",
        RAG_INDEX_PRETTY: "true",
        RAG_VECTOR_KIND: "json_file",
        RAG_VECTOR_PATH: "vectors.json",
        RAG_VECTOR_DIMENSIONS: "3",
        RAG_VECTOR_AUTOSAVE: "false",
        RAG_VISUAL_VECTOR_KIND: "json_file",
        RAG_VISUAL_VECTOR_PATH: "visual-vectors.json",
        RAG_VISUAL_VECTOR_DIMENSIONS: "8",
        RAG_VISUAL_VECTOR_AUTOSAVE: "false",
        RAG_VISUAL_VECTOR_PRETTY: "true",
        RAG_HTTP_HOST: "0.0.0.0",
        RAG_HTTP_MAX_BODY_BYTES: "2048",
        RAG_HTTP_AUTH_MODE: "disabled",
        RAG_HTTP_RATE_LIMIT_MODE: "disabled",
        RAG_HTTP_LOG_MODE: "disabled"
      })
    });

    assert.equal(config.profile.id, "generic-docs");
    assert.equal(config.storage.index.kind, "json_file");
    assert.equal(
      config.storage.index.kind === "json_file" && config.storage.index.path,
      path.join(directory, "index.json")
    );
    assert.equal(config.storage.index.kind === "json_file" && config.storage.index.pretty, true);
    assert.equal(config.storage.vector?.kind, "json_file");
    assert.equal(
      config.storage.vector?.kind === "json_file" && config.storage.vector.autosave,
      false
    );
    assert.equal(
      config.storage.vector?.kind === "json_file" && config.storage.vector.dimensions,
      3
    );
    assert.equal(config.storage.visualVector?.kind, "json_file");
    assert.equal(
      config.storage.visualVector?.kind === "json_file" && config.storage.visualVector.path,
      path.join(directory, "visual-vectors.json")
    );
    assert.equal(
      config.storage.visualVector?.kind === "json_file" && config.storage.visualVector.dimensions,
      8
    );
    assert.equal(
      config.storage.visualVector?.kind === "json_file" && config.storage.visualVector.pretty,
      true
    );
    assert.equal(config.http.host, "0.0.0.0");
    assert.equal(config.http.maxBodyBytes, 2048);
    assert.equal(config.http.auth.mode, "disabled");
    assert.equal(config.http.rateLimit.mode, "disabled");
    assert.equal(config.http.operations.logMode, "disabled");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production config rejects ambiguous profiles and unsafe env values", () => {
  assert.throws(
    () =>
      loadProductionRagAppConfigFromEnv({
        env: providerEnv({
          RAG_APP_PROFILE_PRESET: "generic-docs",
          RAG_APP_PROFILE_PATH: "profile.json"
        })
      }),
    ProductionRagConfigError
  );
  assert.throws(
    () =>
      loadProductionRagAppConfigFromEnv({
        env: providerEnv({
          RAG_INDEX_KIND: "sql"
        })
      }),
    /RAG_INDEX_KIND/u
  );
  assert.throws(
    () =>
      loadProductionRagAppConfigFromEnv({
        env: providerEnv({
          RAG_SOURCE_SYNC_LEDGER_KIND: "sqlite"
        })
      }),
    /RAG_SOURCE_SYNC_LEDGER_KIND/u
  );
  assert.throws(
    () =>
      loadProductionRagAppConfigFromEnv({
        env: providerEnv({
          RAG_APP_EMBEDDING_MODE: "maybe"
        })
      }),
    /RAG_APP_EMBEDDING_MODE/u
  );
  assert.throws(
    () =>
      loadProductionRagAppConfigFromEnv({
        env: providerEnv({
          RAG_APP_VISUAL_EMBEDDING_MODE: "maybe"
        })
      }),
    /RAG_APP_VISUAL_EMBEDDING_MODE/u
  );
  assert.throws(
    () =>
      loadProductionRagAppConfigFromEnv({
        env: providerEnv({
          RAG_VECTOR_KIND: "hosted",
          RAG_VECTOR_VENDOR: "qdrant",
          RAG_VECTOR_ENDPOINT: "http://localhost:6333",
          RAG_VECTOR_COLLECTION: "rag_points",
          RAG_VECTOR_API_KEY_ENV: "MISSING_VECTOR_KEY"
        })
      }),
    /MISSING_VECTOR_KEY/u
  );
  assert.throws(
    () =>
      loadProductionRagAppConfigFromEnv({
        env: providerEnv({
          RAG_HTTP_PORT: "999999"
        })
      }),
    /RAG_HTTP_PORT/u
  );
  assert.throws(
    () =>
      loadProductionRagAppConfigFromEnv({
        env: providerEnv({
          RAG_HTTP_AUTH_TOKEN: undefined
        })
      }),
    /RAG_HTTP_AUTH_TOKEN/u
  );
  assert.throws(
    () =>
      loadProductionRagAppConfigFromEnv({
        env: providerEnv({
          RAG_HTTP_AUTH_MODE: "maybe"
        })
      }),
    /RAG_HTTP_AUTH_MODE/u
  );
  assert.throws(
    () =>
      loadProductionRagAppConfigFromEnv({
        env: providerEnv({
          RAG_HTTP_CLIENT_IP_HEADER: "x bad"
        })
      }),
    /RAG_HTTP_CLIENT_IP_HEADER/u
  );
  assert.throws(
    () =>
      loadProductionRagAppConfigFromEnv({
        env: providerEnv({
          RAG_HTTP_AUTH_TOKEN_SHA256S: "not-a-sha"
        })
      }),
    /RAG_HTTP_AUTH_TOKEN_SHA256S/u
  );
  assert.throws(
    () =>
      loadProductionRagAppConfigFromEnv({
        env: providerEnv({
          RAG_HTTP_AUTH_TOKEN_ENV: "RAG_EDGE_TOKEN",
          RAG_HTTP_AUTH_TOKEN_ENVS: "RAG_EDGE_TOKEN_A,RAG_EDGE_TOKEN_B"
        })
      }),
    /RAG_HTTP_AUTH_TOKEN_ENV/u
  );
  assert.throws(
    () =>
      loadProductionRagAppConfigFromEnv({
        env: providerEnv({
          RAG_HTTP_RATE_LIMIT_MODE: "maybe"
        })
      }),
    /RAG_HTTP_RATE_LIMIT_MODE/u
  );
  assert.throws(
    () =>
      loadProductionRagAppConfigFromEnv({
        env: providerEnv({
          RAG_HTTP_RATE_LIMIT_WINDOW_MS: "999"
        })
      }),
    /RAG_HTTP_RATE_LIMIT_WINDOW_MS/u
  );
  assert.throws(
    () =>
      loadProductionRagAppConfigFromEnv({
        env: providerEnv({
          RAG_HTTP_LOG_MODE: "verbose"
        })
      }),
    /RAG_HTTP_LOG_MODE/u
  );
  assert.throws(
    () =>
      loadProductionRagAppConfigFromEnv({
        env: providerEnv({
          RAG_HTTP_READINESS_PATH: "ready"
        })
      }),
    /RAG_HTTP_READINESS_PATH/u
  );
  assert.throws(
    () =>
      loadProductionRagAppConfigFromEnv({
        env: providerEnv({
          RAG_VISUAL_VECTOR_KIND: "sql"
        })
      }),
    /RAG_VISUAL_VECTOR_KIND/u
  );
});

test("production config supports hosted pinecone and pgvector env shapes", () => {
  const pinecone = loadProductionRagAppConfigFromEnv({
    env: providerEnv({
      RAG_VECTOR_KIND: "hosted",
      RAG_VECTOR_VENDOR: "pinecone",
      RAG_VECTOR_ENDPOINT: "https://pinecone.example.test",
      RAG_VECTOR_NAMESPACE: "support",
      RAG_VECTOR_DELETE_NAMESPACES: "support,archive",
      RAG_VECTOR_API_VERSION: "2026-01",
      RAG_VECTOR_API_KEY: "pinecone-secret"
    })
  });

  assert.equal(pinecone.storage.vector?.kind, "hosted");
  assert.equal(
    pinecone.storage.vector?.kind === "hosted" && pinecone.storage.vector.apiKeyEnv,
    "RAG_VECTOR_API_KEY"
  );
  assert.deepEqual(
    pinecone.storage.vector?.kind === "hosted" && pinecone.storage.vector.deleteNamespaces,
    ["support", "archive"]
  );
  assert.equal(JSON.stringify(pinecone).includes("pinecone-secret"), false);

  const pgvector = loadProductionRagAppConfigFromEnv({
    env: providerEnv({
      RAG_VECTOR_KIND: "hosted",
      RAG_VECTOR_VENDOR: "pgvector-rpc",
      RAG_VECTOR_ENDPOINT: "https://supabase.example.test",
      RAG_VECTOR_TABLE: "rag_vectors",
      RAG_VECTOR_MATCH_FUNCTION: "match_rag_vectors",
      RAG_VECTOR_SCHEMA: "private"
    })
  });

  assert.equal(pgvector.storage.vector?.kind, "hosted");
  assert.equal(
    pgvector.storage.vector?.kind === "hosted" && pgvector.storage.vector.tableName,
    "rag_vectors"
  );
  assert.equal(
    pgvector.storage.vector?.kind === "hosted" && pgvector.storage.vector.schema,
    "private"
  );
});

test("production config supports postgres source sync ledger env shape", () => {
  const config = loadProductionRagAppConfigFromEnv({
    env: providerEnv({
      RAG_SOURCE_SYNC_LEDGER_KIND: "postgres",
      RAG_POSTGRES_URL_ENV: "RAG_DATABASE_URL",
      RAG_DATABASE_URL: "postgres://rag:secret@postgres:5432/rag",
      RAG_POSTGRES_SCHEMA: "rag_core"
    })
  });

  assert.equal(config.storage.sourceSyncLedger?.kind, "postgres");
  assert.equal(
    config.storage.sourceSyncLedger?.kind === "postgres" &&
      config.storage.sourceSyncLedger.connectionString,
    "postgres://rag:secret@postgres:5432/rag"
  );
  assert.equal(
    config.storage.sourceSyncLedger?.kind === "postgres" && config.storage.sourceSyncLedger.schema,
    "rag_core"
  );
});

test("company production env example loads the Postgres pgvector deployment shape", () => {
  const env = parseEnvFile(
    readFileSync(path.join(process.cwd(), "deploy", "company-production.example.env"), "utf8")
  );
  const config = loadProductionRagAppConfigFromEnv({ env });

  assert.equal(config.storage.index.kind, "postgres");
  assert.equal(config.storage.vector?.kind, "postgres");
  assert.equal(
    config.storage.vector?.kind === "postgres" && config.storage.vector.dimensions,
    1536
  );
  assert.equal(config.storage.sourceSyncLedger?.kind, "postgres");
  assert.equal(config.providers.embeddingMode, "required");
  assert.equal(config.providers.groundingJudgeProviderMode, "required");
  assert.equal(config.http.auth.mode, "required");
  assert.equal(config.http.rateLimit.mode, "enabled");
});

test("production app answers through the shared runtime and returns a safe response", async () => {
  const { index, chunks } = makeIndexedFixture();
  const chunkId = chunks[0]?.id;
  assert.ok(chunkId);
  const transport = new MockProviderTransport([
    okResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              answer: "Refund requests require support review.",
              citationChunkIds: [chunkId],
              evidenceSummary: "The indexed policy says refund requests require review.",
              confidence: "medium"
            })
          }
        }
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15
      }
    })
  ]);
  const app = createProductionRagApp({
    config: productionConfig(),
    env: providerEnv(),
    transport,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await app.answer({
    question: "What is the refund policy?",
    tenantId: TEST_PRINCIPAL.tenantId,
    namespaceId: "test-namespace",
    principal: TEST_PRINCIPAL,
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.answer, "Refund requests require support review.");
  assert.equal(result.citationChunkIds?.[0], chunkId);
  assert.equal(result.citations?.[0]?.chunkId, chunkId);
  assert.equal(result.citations?.[0]?.title, "Test Policy");
  assert.equal(result.context?.evidence !== undefined, true);
  assert.equal(JSON.stringify(result).includes("Billing issues should be escalated"), false);
  assert.equal(app.health().index.chunkCount, chunks.length);
  assert.equal(JSON.stringify(app.health()).includes("model-secret"), false);
  assert.equal(transport.requests.length, 1);
});

test("production app rejects mismatched principal scopes before retrieval", async () => {
  const { index } = makeIndexedFixture();
  const app = createProductionRagApp({
    config: productionConfig(),
    env: providerEnv(),
    transport: new MockProviderTransport(),
    chunkStore: index,
    now: () => FIXED_NOW
  });

  await assert.rejects(
    () =>
      app.answer({
        question: "What is the refund policy?",
        tenantId: TEST_PRINCIPAL.tenantId,
        namespaceId: "test-namespace",
        principal: {
          ...TEST_PRINCIPAL,
          namespaceIds: ["other-namespace"]
        }
      }),
    ProductionRagRequestError
  );

  await assert.rejects(
    () =>
      app.answer({
        question: "What is the refund policy?",
        tenantId: TEST_PRINCIPAL.tenantId,
        namespaceId: "test-namespace",
        principal: TEST_PRINCIPAL,
        topK: 0
      }),
    /topK/u
  );

  await assert.rejects(
    () =>
      app.answer({
        question: "What is the refund policy?",
        tenantId: TEST_PRINCIPAL.tenantId,
        namespaceId: "test-namespace",
        principal: {
          ...TEST_PRINCIPAL,
          tenantId: "other_tenant"
        }
      }),
    /principal\.tenantId/u
  );

  await assert.rejects(
    () =>
      app.answer({
        question: "What is the refund policy?",
        tenantId: TEST_PRINCIPAL.tenantId,
        namespaceId: "test-namespace",
        principal: TEST_PRINCIPAL,
        filters: "not-an-object"
      }),
    /filters/u
  );
});

test("production app can assemble a hosted vector store from config", () => {
  const { index } = makeIndexedFixture();
  const app = createProductionRagApp({
    config: productionConfig({
      storage: {
        index: { kind: "memory" },
        vector: {
          kind: "hosted",
          vendor: "qdrant",
          endpoint: "http://localhost:6333",
          collectionName: "rag_points",
          dimensions: 3
        }
      }
    }),
    env: providerEnv(),
    transport: new MockProviderTransport(),
    vectorFetch: async () => ({
      status: 200,
      headers: {
        forEach: () => undefined
      },
      text: async () => "{}"
    }),
    chunkStore: index,
    now: () => FIXED_NOW
  });

  assert.equal(app.health().vector?.storageKind, "hosted");
  assert.equal(app.health().vector?.dimensions, 3);
});

test("production app can assemble a postgres source sync ledger store from config", () => {
  const app = createProductionRagApp({
    config: productionConfig({
      storage: {
        index: { kind: "memory" },
        vector: { kind: "none" },
        sourceSyncLedger: {
          kind: "postgres",
          connectionString: "postgres://rag:secret@postgres:5432/rag",
          schema: "rag_core"
        }
      }
    }),
    env: providerEnv(),
    transport: new MockProviderTransport(),
    now: () => FIXED_NOW
  });

  assert.equal(app.sourceSyncLedgerStore instanceof PostgresSourceSyncLedgerStore, true);
  assert.deepEqual(app.health().sourceSyncLedger, {
    storageKind: "postgres",
    durable: true
  });
});

test("production app can assemble a durable visual vector store from config", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-visual-production-"));
  try {
    const { index } = makeIndexedFixture();
    const app = createProductionRagApp({
      config: productionConfig({
        storage: {
          index: { kind: "memory" },
          vector: { kind: "none" },
          visualVector: {
            kind: "json_file",
            path: path.join(directory, "visual-vectors.json"),
            dimensions: 8
          }
        }
      }),
      env: providerEnv(),
      transport: new MockProviderTransport(),
      chunkStore: index,
      now: () => FIXED_NOW
    });

    assert.equal(app.health().visualVector?.storageKind, "json_file");
    assert.equal(app.health().visualVector?.durable, true);
    assert.equal(app.health().visualVector?.dimensions, 8);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production app can assemble a hosted visual vector store from config", () => {
  const { index } = makeIndexedFixture();
  const app = createProductionRagApp({
    config: productionConfig({
      storage: {
        index: { kind: "memory" },
        vector: { kind: "none" },
        visualVector: {
          kind: "hosted",
          vendor: "qdrant",
          endpoint: "http://localhost:6333",
          collectionName: "rag_visual_points",
          vectorName: "visual",
          dimensions: 16
        }
      }
    }),
    env: providerEnv(),
    transport: new MockProviderTransport(),
    vectorFetch: async () => ({
      status: 200,
      headers: {
        forEach: () => undefined
      },
      text: async () => "{}"
    }),
    chunkStore: index,
    now: () => FIXED_NOW
  });

  assert.equal(app.health().visualVector?.storageKind, "hosted");
  assert.equal(app.health().visualVector?.durable, true);
  assert.equal(app.health().visualVector?.dimensions, 16);
});

test("production app creates visual embedding providers from env and reports safe health", () => {
  const { index } = makeIndexedFixture();
  const base = productionConfig();
  const app = createProductionRagApp({
    config: productionConfig({
      storage: {
        index: { kind: "memory" },
        vector: { kind: "none" },
        visualVector: {
          kind: "memory",
          dimensions: 16
        }
      },
      providers: {
        ...base.providers,
        visualEmbeddingMode: "required"
      }
    }),
    env: providerEnv({
      RAG_VISUAL_EMBEDDING_PROVIDER: "indexed-visual-embedding",
      RAG_VISUAL_EMBEDDING_MODEL_NAME: "visual-embedding-model",
      RAG_VISUAL_EMBEDDING_ENDPOINT: "https://provider.example.test/v1/visual-embeddings",
      RAG_VISUAL_EMBEDDING_API_KEY: "visual-secret",
      RAG_VISUAL_EMBEDDING_DIMENSIONS: "16"
    }),
    transport: new MockProviderTransport(),
    chunkStore: index,
    now: () => FIXED_NOW
  });
  const health = app.health();

  assert.equal(app.visualEmbeddingAdapter?.provider, "indexed-visual-embedding");
  assert.equal(app.visualEmbeddingAdapter?.dimensions, 16);
  assert.equal(health.visualVector?.dimensions, 16);
  assert.equal(health.providers.visualEmbedding?.provider, "indexed-visual-embedding");
  assert.equal(health.providers.visualEmbedding?.modelName, "visual-embedding-model");
  assert.equal(JSON.stringify(health).includes("visual-secret"), false);
});

test("production app health reports old vector generations against active embedding config", () => {
  const { index, chunks } = makeIndexedFixture();
  const embeddingEnv = providerEnv({
    RAG_EMBEDDING_PROVIDER: "indexed-embedding",
    RAG_EMBEDDING_MODEL_NAME: "embedding-model",
    RAG_EMBEDDING_ENDPOINT: "https://provider.example.test/v1/embeddings",
    RAG_EMBEDDING_API_KEY: "embedding-secret",
    RAG_EMBEDDING_DIMENSIONS: "3"
  });
  const app = createProductionRagApp({
    config: productionConfig({
      storage: {
        index: { kind: "memory" },
        vector: { kind: "memory", dimensions: 3 }
      },
      providers: {
        ...productionConfig().providers,
        embeddingMode: "required"
      }
    }),
    env: embeddingEnv,
    transport: new MockProviderTransport(),
    chunkStore: index,
    now: () => FIXED_NOW
  });
  const [firstChunk] = chunks;
  assert.ok(firstChunk);
  const vectorStore = app.vectorStore;
  assert.ok(vectorStore instanceof InMemoryVectorStore);
  const activeHash = app.health().vector?.embeddingCompatibility?.configHash;
  assert.ok(activeHash);
  vectorStore.addChunkVectors([
    chunkVector(firstChunk.id, firstChunk.documentId, activeHash),
    chunkVector(firstChunk.id, firstChunk.documentId, "old_hash"),
    chunkVector(firstChunk.id, firstChunk.documentId, "older_hash")
  ]);

  const health = app.health();

  assert.equal(health.vector?.embeddingCompatibility?.configHash, activeHash);
  assert.equal(health.vector?.generationCount, 3);
  assert.equal(health.vector?.oldGenerationCount, 2);
});

test("production app async health uses scalable vector generation inventory", async () => {
  const { index } = makeIndexedFixture();
  let activeHash = "";
  let snapshotCalls = 0;
  let inventoryCalls = 0;
  const vectorStore: VectorStore & VectorGenerationInventoryProvider = {
    capabilities: {
      storageKind: "postgres",
      durable: true,
      enforcesAccessFilters: true,
      supportsCosineSimilarity: true,
      dimensions: 3,
      scale: POSTGRES_VECTOR_SCALE_CAPABILITIES
    },
    addChunkVectors: async () => [],
    deleteVectorsForDocument: async () => 0,
    findNearestVectors: async () => ({ candidates: [], rejected: [], candidatePoolSize: 0 }),
    snapshot: async (): Promise<VectorSnapshot> => {
      snapshotCalls += 1;
      return { version: 1, vectors: [] };
    },
    vectorCount: async () => 2,
    vectorGenerationInventory: async () => {
      inventoryCalls += 1;
      return [
        {
          tenantId: TEST_PRINCIPAL.tenantId,
          namespaceId: "test-namespace",
          embeddingProvider: "indexed-embedding",
          embeddingModel: "embedding-model",
          embeddingConfigHash: activeHash,
          vectorCount: 1,
          documentCount: 1
        },
        {
          tenantId: TEST_PRINCIPAL.tenantId,
          namespaceId: "test-namespace",
          embeddingProvider: "indexed-embedding",
          embeddingModel: "embedding-model",
          embeddingConfigHash: "old_hash",
          vectorCount: 1,
          documentCount: 1
        }
      ];
    }
  };
  const app = createProductionRagApp({
    config: productionConfig({
      storage: {
        index: { kind: "memory" },
        vector: { kind: "none" }
      },
      providers: {
        ...productionConfig().providers,
        embeddingMode: "required"
      }
    }),
    env: providerEnv({
      RAG_EMBEDDING_PROVIDER: "indexed-embedding",
      RAG_EMBEDDING_MODEL_NAME: "embedding-model",
      RAG_EMBEDDING_ENDPOINT: "https://provider.example.test/v1/embeddings",
      RAG_EMBEDDING_API_KEY: "embedding-secret",
      RAG_EMBEDDING_DIMENSIONS: "3"
    }),
    transport: new MockProviderTransport(),
    chunkStore: index,
    vectorStore,
    now: () => FIXED_NOW
  });

  const syncHealth = app.health();
  activeHash = syncHealth.vector?.embeddingCompatibility?.configHash ?? "";
  assert.ok(activeHash);
  assert.equal(syncHealth.vector?.generationCount, undefined);
  assert.equal(snapshotCalls, 1);

  assert.ok(app.healthAsync);
  const asyncHealth = await app.healthAsync();

  assert.equal(inventoryCalls, 1);
  assert.equal(snapshotCalls, 1);
  assert.equal(asyncHealth.vector?.generationCount, 2);
  assert.equal(asyncHealth.vector?.oldGenerationCount, 1);
});

test("production app self-test reports static capability and dimension failures", async () => {
  const { index } = makeIndexedFixture();
  const base = productionConfig();
  const app = createProductionRagApp({
    config: productionConfig({
      storage: {
        index: { kind: "memory" },
        vector: {
          kind: "memory",
          dimensions: 3
        }
      },
      providers: {
        ...base.providers,
        embeddingMode: "required"
      }
    }),
    env: providerEnv({
      RAG_EMBEDDING_PROVIDER: "indexed-embedding",
      RAG_EMBEDDING_MODEL_NAME: "embedding-model",
      RAG_EMBEDDING_ENDPOINT: "https://provider.example.test/v1/embeddings",
      RAG_EMBEDDING_API_KEY: "embedding-secret",
      RAG_EMBEDDING_DIMENSIONS: "8"
    }),
    transport: new MockProviderTransport(),
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await app.selfTest({ requestedAt: FIXED_NOW });

  assert.equal(result.status, "failed");
  assert.equal(result.probeProviders, false);
  assert.equal(
    result.checks.find((check) => check.id === "vector_dimensions_match_adapter")?.status,
    "failed"
  );
  assert.equal(JSON.stringify(result).includes("embedding-secret"), false);
});

test("production app self-test can probe configured providers without leaking secrets", async () => {
  const { index } = makeIndexedFixture();
  const base = productionConfig();
  const transport = new MockProviderTransport([
    okResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              answer: "Startup self-test evidence is present.",
              citationChunkIds: ["startup_probe_chunk"],
              evidenceSummary: "Startup self-test evidence is present.",
              confidence: "high"
            })
          }
        }
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15
      }
    }),
    okResponse({
      data: [{ index: 0, embedding: [1, 0, 0] }]
    }),
    okResponse({
      data: [{ index: 0, vectors: [[1, 0, 0]] }]
    }),
    okResponse({
      data: [{ embedding: [1, 0, 0] }]
    })
  ]);
  const app = createProductionRagApp({
    config: productionConfig({
      storage: {
        index: { kind: "memory" },
        vector: {
          kind: "memory",
          dimensions: 3
        },
        visualVector: {
          kind: "memory",
          dimensions: 3
        }
      },
      providers: {
        ...base.providers,
        embeddingMode: "required",
        visualEmbeddingMode: "required"
      }
    }),
    env: providerEnv({
      RAG_EMBEDDING_PROVIDER: "indexed-embedding",
      RAG_EMBEDDING_MODEL_NAME: "embedding-model",
      RAG_EMBEDDING_ENDPOINT: "https://provider.example.test/v1/embeddings",
      RAG_EMBEDDING_API_KEY: "embedding-secret",
      RAG_EMBEDDING_DIMENSIONS: "3",
      RAG_VISUAL_EMBEDDING_PROVIDER: "indexed-visual-embedding",
      RAG_VISUAL_EMBEDDING_MODEL_NAME: "visual-embedding-model",
      RAG_VISUAL_EMBEDDING_ENDPOINT: "https://provider.example.test/v1/visual-embeddings",
      RAG_VISUAL_EMBEDDING_API_KEY: "visual-secret",
      RAG_VISUAL_EMBEDDING_DIMENSIONS: "3"
    }),
    transport,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await app.selfTest({
    probeProviders: true,
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "passed");
  assert.equal(result.probeProviders, true);
  assert.equal(result.failedCount, 0);
  assert.equal(transport.requests.length, 4);
  assert.equal(
    result.checks.find((check) => check.id === "model_provider_probe")?.status,
    "passed"
  );
  assert.equal(
    result.checks.find((check) => check.id === "embedding_provider_probe")?.status,
    "passed"
  );
  assert.equal(
    result.checks.find((check) => check.id === "visual_embedding_provider_asset_probe")?.status,
    "passed"
  );
  assert.equal(
    result.checks.find((check) => check.id === "visual_embedding_provider_query_probe")?.status,
    "passed"
  );
  assert.equal(JSON.stringify(result).includes("embedding-secret"), false);
  assert.equal(JSON.stringify(result).includes("visual-secret"), false);
});

test("production app self-test redacts failed provider probe messages", async () => {
  const { index } = makeIndexedFixture();
  const app = createProductionRagApp({
    config: productionConfig(),
    env: providerEnv(),
    transport: new MockProviderTransport([
      {
        status: 401,
        headers: {},
        body: {
          error: {
            message: "bad api key model-secret bearer model-secret"
          }
        },
        latencyMs: 10
      }
    ]),
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await app.selfTest({
    probeProviders: true,
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "failed");
  assert.equal(
    result.checks.find((check) => check.id === "model_provider_probe")?.status,
    "failed"
  );
  assert.equal(JSON.stringify(result).includes("model-secret"), false);
  assert.equal(JSON.stringify(result).includes("[REDACTED]"), true);
});

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function chunkVector(
  chunkId: string,
  documentId: string,
  embeddingConfigHash: string
): ChunkVector {
  return {
    id: `${embeddingConfigHash}_${chunkId}`,
    chunkId,
    documentId,
    tenantId: TEST_PRINCIPAL.tenantId,
    namespaceId: "test-namespace",
    textHash: "text_hash",
    embeddingModel: "embedding-model",
    embeddingProvider: "indexed-embedding",
    embeddingConfigHash,
    dimensions: 3,
    vector: [1, 0, 0],
    embeddedAt: FIXED_NOW,
    metadata: {
      embeddingIndexConfigHash: `${embeddingConfigHash}_index`
    }
  };
}
