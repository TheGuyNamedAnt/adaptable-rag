import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import type {
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import { FIXED_NOW, TEST_PRINCIPAL, makeIndexedFixture } from "../test-support/fixtures.js";
import { createProductionRagApp, type ProductionRagAppConfig } from "./production-app.js";
import {
  createProductionRagHttpServer,
  type ProductionHttpLogEvent
} from "./production-http-server.js";

const EDGE_TOKEN = "edge-token";

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

const CONFIG: ProductionRagAppConfig = {
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
      mode: "required",
      headerName: "authorization",
      tokenSha256s: [sha256Hex(EDGE_TOKEN)]
    },
    rateLimit: {
      mode: "enabled",
      windowMs: 60_000,
      maxRequests: 10,
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

const ENV = {
  RAG_MODEL_PROVIDER: "json-chat",
  RAG_MODEL_MODEL_NAME: "answer-model",
  RAG_MODEL_ENDPOINT: "https://provider.example.test/v1/chat",
  RAG_MODEL_API_KEY: "model-secret"
} as const;

function okResponse(body: unknown): ProviderHttpResponse {
  return {
    status: 200,
    headers: {},
    body,
    latencyMs: 10
  };
}

test("production HTTP server exposes health and answer routes without raw context text", async () => {
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
    config: CONFIG,
    env: ENV,
    transport,
    chunkStore: index,
    now: () => FIXED_NOW
  });
  const http = createProductionRagHttpServer({ app });
  const address = await http.listen();
  const baseUrl = `http://${address.host}:${address.port}`;

  try {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as { readonly index: { readonly chunkCount: number } };
    assert.equal(healthBody.index.chunkCount, chunks.length);

    const answer = await fetch(`${baseUrl}/answer`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${EDGE_TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        question: "What is the refund policy?",
        tenantId: TEST_PRINCIPAL.tenantId,
        namespaceId: "test-namespace",
        principal: TEST_PRINCIPAL,
        requestedAt: FIXED_NOW
      })
    });
    assert.equal(answer.status, 200);
    const answerBody = (await answer.json()) as {
      readonly status: string;
      readonly answer: string;
    };
    assert.equal(answerBody.status, "succeeded");
    assert.equal(answerBody.answer, "Refund requests require support review.");
    assert.equal(JSON.stringify(answerBody).includes("Billing issues should be escalated"), false);

    const invalidJson = await fetch(`${baseUrl}/answer`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${EDGE_TOKEN}`,
        "content-type": "application/json"
      },
      body: "{"
    });
    assert.equal(invalidJson.status, 400);
  } finally {
    await http.close();
  }
});

test("production HTTP server emits request ids, redacted logs, and metrics", async () => {
  const { index } = makeIndexedFixture();
  const logs: ProductionHttpLogEvent[] = [];
  const app = createProductionRagApp({
    config: {
      ...CONFIG,
      http: {
        ...CONFIG.http,
        operations: {
          ...CONFIG.http.operations,
          logMode: "json"
        }
      }
    },
    env: ENV,
    transport: new MockProviderTransport(),
    chunkStore: index,
    now: () => FIXED_NOW
  });
  const http = createProductionRagHttpServer({
    app,
    nowMs: () => 1_000,
    requestId: () => "generated-request-id",
    logger: (event) => logs.push(event)
  });
  const address = await http.listen();
  const baseUrl = `http://${address.host}:${address.port}`;

  try {
    const health = await fetch(`${baseUrl}/health`, {
      headers: { "x-request-id": "req-123" }
    });

    assert.equal(health.status, 200);
    assert.equal(health.headers.get("x-request-id"), "req-123");
    const metrics = http.metrics();
    assert.equal(metrics.totalRequests, 1);
    assert.equal(metrics.completedRequests, 1);
    assert.equal(metrics.byRoute["health"], 1);
    assert.equal(metrics.byStatusCode["200"], 1);

    const access = logs.find((event) => event.event === "http_access");
    assert.ok(access);
    assert.equal(access.requestId, "req-123");
    assert.equal(access.route, "health");
    assert.equal(access.statusCode, 200);
    assert.equal(JSON.stringify(logs).includes("edge-token"), false);
    assert.equal(JSON.stringify(logs).includes("model-secret"), false);
  } finally {
    await http.close();
  }
});

test("production HTTP server separates readiness from liveness and exposes metrics", async () => {
  const { index } = makeIndexedFixture();
  const app = createProductionRagApp({
    config: CONFIG,
    env: ENV,
    transport: new MockProviderTransport(),
    chunkStore: index,
    now: () => FIXED_NOW
  });
  const http = createProductionRagHttpServer({ app });
  const address = await http.listen();
  const baseUrl = `http://${address.host}:${address.port}`;

  try {
    const ready = await fetch(`${baseUrl}/ready`);
    assert.equal(ready.status, 200);
    assert.equal(((await ready.json()) as { readonly ready: boolean }).ready, true);

    http.setReady(false);

    const notReady = await fetch(`${baseUrl}/ready`);
    assert.equal(notReady.status, 503);
    assert.equal(((await notReady.json()) as { readonly ready: boolean }).ready, false);

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);

    const metricsResponse = await fetch(`${baseUrl}/metrics`);
    assert.equal(metricsResponse.status, 200);
    const metrics = (await metricsResponse.json()) as {
      readonly ready: boolean;
      readonly draining: boolean;
      readonly byRoute: Record<string, number>;
    };
    assert.equal(metrics.ready, false);
    assert.equal(metrics.draining, true);
    assert.equal(metrics.byRoute["ready"], 2);
    assert.equal(http.ready(), false);
  } finally {
    await http.close();
  }
});

test("production HTTP server requires answer auth and rate limits before model work", async () => {
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
    config: {
      ...CONFIG,
      http: {
        ...CONFIG.http,
        rateLimit: {
          ...CONFIG.http.rateLimit,
          maxRequests: 1
        }
      }
    },
    env: ENV,
    transport,
    chunkStore: index,
    now: () => FIXED_NOW
  });
  const http = createProductionRagHttpServer({ app, nowMs: () => 1_000 });
  const address = await http.listen();
  const baseUrl = `http://${address.host}:${address.port}`;
  const requestBody = JSON.stringify({
    question: "What is the refund policy?",
    tenantId: TEST_PRINCIPAL.tenantId,
    namespaceId: "test-namespace",
    principal: TEST_PRINCIPAL,
    requestedAt: FIXED_NOW
  });

  try {
    const missingAuth = await fetch(`${baseUrl}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody
    });
    assert.equal(missingAuth.status, 401);
    assert.equal(transport.requests.length, 0);

    const first = await fetch(`${baseUrl}/answer`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${EDGE_TOKEN}`,
        "content-type": "application/json"
      },
      body: requestBody
    });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-ratelimit-limit"), "1");
    assert.equal(first.headers.get("x-ratelimit-remaining"), "0");
    assert.equal(transport.requests.length, 1);

    const second = await fetch(`${baseUrl}/answer`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${EDGE_TOKEN}`,
        "content-type": "application/json"
      },
      body: requestBody
    });
    assert.equal(second.status, 429);
    assert.equal(transport.requests.length, 1);

    const metrics = http.metrics();
    assert.equal(metrics.authDenied, 1);
    assert.equal(metrics.rateLimited, 1);
    assert.equal(metrics.answerSucceeded, 1);
  } finally {
    await http.close();
  }
});

test("production HTTP server records model failures without raw provider errors", async () => {
  const { index } = makeIndexedFixture();
  const logs: ProductionHttpLogEvent[] = [];
  const transport = new MockProviderTransport([okResponse({ nope: true })]);
  const app = createProductionRagApp({
    config: {
      ...CONFIG,
      http: {
        ...CONFIG.http,
        operations: {
          ...CONFIG.http.operations,
          logMode: "json"
        }
      }
    },
    env: ENV,
    transport,
    chunkStore: index,
    now: () => FIXED_NOW
  });
  const http = createProductionRagHttpServer({
    app,
    requestId: () => "model-failure-request",
    logger: (event) => logs.push(event)
  });
  const address = await http.listen();
  const baseUrl = `http://${address.host}:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/answer`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${EDGE_TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        question: "What is the refund policy?",
        tenantId: TEST_PRINCIPAL.tenantId,
        namespaceId: "test-namespace",
        principal: TEST_PRINCIPAL,
        requestedAt: FIXED_NOW
      })
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { readonly status: string };
    assert.equal(body.status, "model_failed");
    assert.equal(http.metrics().answerFailed, 1);

    const access = logs.find(
      (event): event is Extract<ProductionHttpLogEvent, { readonly event: "http_access" }> =>
        event.event === "http_access" && event.route === "answer"
    );
    assert.ok(access);
    assert.equal(access.answerStatus, "model_failed");
    assert.equal(access.requestId, "model-failure-request");
    assert.equal(JSON.stringify(access).includes("nope"), false);
    assert.equal(JSON.stringify(access).includes("What is the refund policy?"), false);
  } finally {
    await http.close();
  }
});

test("production HTTP server supports custom auth headers with rate limiting disabled", async () => {
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
    config: {
      ...CONFIG,
      http: {
        ...CONFIG.http,
        auth: {
          mode: "required",
          headerName: "x-rag-token",
          tokenSha256s: [sha256Hex(EDGE_TOKEN)]
        },
        rateLimit: {
          ...CONFIG.http.rateLimit,
          mode: "disabled"
        }
      }
    },
    env: ENV,
    transport,
    chunkStore: index,
    now: () => FIXED_NOW
  });
  const http = createProductionRagHttpServer({ app });
  const address = await http.listen();
  const baseUrl = `http://${address.host}:${address.port}`;
  const requestBody = JSON.stringify({
    question: "What is the refund policy?",
    tenantId: TEST_PRINCIPAL.tenantId,
    namespaceId: "test-namespace",
    principal: TEST_PRINCIPAL,
    requestedAt: FIXED_NOW
  });

  try {
    const invalidAuth = await fetch(`${baseUrl}/answer`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rag-token": "wrong-token"
      },
      body: requestBody
    });
    assert.equal(invalidAuth.status, 401);
    assert.equal(transport.requests.length, 0);

    const answer = await fetch(`${baseUrl}/answer`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rag-token": EDGE_TOKEN
      },
      body: requestBody
    });

    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get("x-ratelimit-limit"), "10");
    assert.equal(answer.headers.get("x-ratelimit-remaining"), "10");
    assert.equal(transport.requests.length, 1);
  } finally {
    await http.close();
  }
});

test("production HTTP server rejects oversized answer bodies after auth", async () => {
  const { index } = makeIndexedFixture();
  const transport = new MockProviderTransport();
  const app = createProductionRagApp({
    config: {
      ...CONFIG,
      http: {
        ...CONFIG.http,
        maxBodyBytes: 32
      }
    },
    env: ENV,
    transport,
    chunkStore: index,
    now: () => FIXED_NOW
  });
  const http = createProductionRagHttpServer({ app });
  const address = await http.listen();
  const baseUrl = `http://${address.host}:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/answer`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${EDGE_TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        question: "What is the refund policy?",
        tenantId: TEST_PRINCIPAL.tenantId,
        namespaceId: "test-namespace",
        principal: TEST_PRINCIPAL
      })
    });

    assert.equal(response.status, 413);
    assert.equal(transport.requests.length, 0);
  } finally {
    await http.close();
  }
});

test("production HTTP server rejects unsupported routes and methods", async () => {
  const { index } = makeIndexedFixture();
  const app = createProductionRagApp({
    config: CONFIG,
    env: ENV,
    transport: new MockProviderTransport(),
    chunkStore: index,
    now: () => FIXED_NOW
  });
  const http = createProductionRagHttpServer({ app });
  const address = await http.listen();
  const baseUrl = `http://${address.host}:${address.port}`;

  try {
    const missing = await fetch(`${baseUrl}/missing`);
    assert.equal(missing.status, 404);

    const wrongMethod = await fetch(`${baseUrl}/answer`);
    assert.equal(wrongMethod.status, 405);
  } finally {
    await http.close();
  }
});

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
