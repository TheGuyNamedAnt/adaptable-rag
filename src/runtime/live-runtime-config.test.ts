import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import { FIXED_NOW, makeIndexFilter, makeIndexedFixture } from "../test-support/fixtures.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import {
  assembleLiveRagRuntimeFromEnv,
  createLiveProviderAdaptersFromEnv
} from "./live-runtime-config.js";

class MockProviderTransport implements ProviderTransport {
  readonly requests: ProviderHttpRequest[] = [];
  private readonly results: ProviderHttpResponse[];

  constructor(results: ProviderHttpResponse[] = []) {
    this.results = [...results];
  }

  async send(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(request);
    const next = this.results.shift();
    if (!next) {
      throw new Error("No mock live provider response configured.");
    }
    return next;
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
    ...overrides
  };
}

function okResponse(body: unknown): ProviderHttpResponse {
  return {
    status: 200,
    headers: {},
    body,
    latencyMs: 20
  };
}

test("creates live provider adapters from env with optional embedding auto-detection", () => {
  const transport = new MockProviderTransport();
  const providers = createLiveProviderAdaptersFromEnv({
    env: providerEnv(),
    transport,
    now: () => FIXED_NOW
  });

  assert.equal(providers.model.provider, "json-chat");
  assert.equal(providers.model.modelName, "answer-model");
  assert.equal(providers.embeddingAdapter, undefined);
  assert.equal(providers.transport, transport);
  assert.equal(JSON.stringify(providers.modelConfig).includes("model-secret"), false);
});

test("creates embedding adapters when embedding env is required", () => {
  const providers = createLiveProviderAdaptersFromEnv({
    env: providerEnv({
      RAG_EMBEDDING_PROVIDER: "indexed-embedding",
      RAG_EMBEDDING_MODEL_NAME: "embedding-model",
      RAG_EMBEDDING_ENDPOINT: "https://provider.example.test/v1/embeddings",
      RAG_EMBEDDING_API_KEY: "embedding-secret",
      RAG_EMBEDDING_DIMENSIONS: "8"
    }),
    transport: new MockProviderTransport(),
    embedding: "required",
    now: () => FIXED_NOW
  });

  assert.equal(providers.embeddingAdapter?.provider, "indexed-embedding");
  assert.equal(providers.embeddingAdapter?.dimensions, 8);
  assert.equal(providers.embeddingConfig?.modelName, "embedding-model");
});

test("creates visual embedding adapters when visual embedding env is required", () => {
  const providers = createLiveProviderAdaptersFromEnv({
    env: providerEnv({
      RAG_VISUAL_EMBEDDING_PROVIDER: "indexed-visual-embedding",
      RAG_VISUAL_EMBEDDING_MODEL_NAME: "visual-embedding-model",
      RAG_VISUAL_EMBEDDING_ENDPOINT: "https://provider.example.test/v1/visual-embeddings",
      RAG_VISUAL_EMBEDDING_API_KEY: "visual-embedding-secret",
      RAG_VISUAL_EMBEDDING_DIMENSIONS: "16"
    }),
    transport: new MockProviderTransport(),
    visualEmbedding: "required",
    now: () => FIXED_NOW
  });

  assert.equal(providers.visualEmbeddingAdapter?.provider, "indexed-visual-embedding");
  assert.equal(providers.visualEmbeddingAdapter?.dimensions, 16);
  assert.equal(providers.visualEmbeddingConfig?.modelName, "visual-embedding-model");
  assert.equal(
    JSON.stringify(providers.visualEmbeddingConfig).includes("visual-embedding-secret"),
    false
  );
});

test("creates ColPali visual embedding adapters from provider env", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      data: [
        {
          id: "visual_input_1",
          patch_vectors: [[1, 0, 0, 0]]
        }
      ]
    })
  ]);
  const providers = createLiveProviderAdaptersFromEnv({
    env: providerEnv({
      RAG_VISUAL_EMBEDDING_PROVIDER: "colpali",
      RAG_VISUAL_EMBEDDING_MODEL_NAME: "colpali-v1",
      RAG_VISUAL_EMBEDDING_ENDPOINT: "https://provider.example.test/v1/colpali",
      RAG_VISUAL_EMBEDDING_API_KEY: "visual-embedding-secret",
      RAG_VISUAL_EMBEDDING_DIMENSIONS: "4"
    }),
    transport,
    visualEmbedding: "required",
    now: () => FIXED_NOW
  });

  const result = await providers.visualEmbeddingAdapter?.embedVisualAssets({
    inputs: [
      {
        id: "visual_input_1",
        chunkId: "chunk_1",
        documentId: "doc_1",
        mediaType: "image/png",
        visualAssetId: "page_1",
        uri: "s3://bucket/page-1.png"
      }
    ],
    requestedAt: FIXED_NOW
  });

  assert.equal(providers.visualEmbeddingAdapter?.provider, "colpali");
  assert.equal(providers.visualEmbeddingAdapter?.dimensions, 4);
  assert.equal(result?.status, "succeeded");
  assert.equal(
    isRecord(transport.requests[0]?.body) ? transport.requests[0].body["task"] : "",
    "index"
  );
});

test("creates openai-compatible embedding, rerank, and grounding judge providers from env", () => {
  const providers = createLiveProviderAdaptersFromEnv({
    env: providerEnv({
      RAG_EMBEDDING_PROVIDER: "openai-compatible",
      RAG_EMBEDDING_MODEL_NAME: "embedding-model",
      RAG_EMBEDDING_ENDPOINT: "https://provider.example.test/v1/embeddings",
      RAG_EMBEDDING_API_KEY: "embedding-secret",
      RAG_EMBEDDING_DIMENSIONS: "8",
      RAG_RERANK_PROVIDER: "openai-compatible",
      RAG_RERANK_MODEL_NAME: "rerank-model",
      RAG_RERANK_ENDPOINT: "https://provider.example.test/v1/rerank",
      RAG_RERANK_API_KEY: "rerank-secret",
      RAG_GROUNDING_JUDGE_PROVIDER: "openai-compatible",
      RAG_GROUNDING_JUDGE_MODEL_NAME: "judge-model",
      RAG_GROUNDING_JUDGE_ENDPOINT: "https://provider.example.test/v1/judge",
      RAG_GROUNDING_JUDGE_API_KEY: "judge-secret"
    }),
    transport: new MockProviderTransport(),
    embedding: "required",
    rerankTemperature: 0.1,
    groundingJudgeTemperature: 0.2,
    now: () => FIXED_NOW
  });

  assert.equal(providers.embeddingAdapter?.provider, "openai-compatible");
  assert.equal(providers.reranker?.mode, "model");
  assert.equal(providers.rerankConfig?.provider, "openai-compatible");
  assert.equal(providers.groundingJudgeConfig?.provider, "openai-compatible");
});

test("creates anthropic rerank and grounding judge providers from prefixed Anthropic env", () => {
  const providers = createLiveProviderAdaptersFromEnv({
    env: providerEnv({
      RAG_RERANK_PROVIDER: "claude",
      RAG_RERANK_MODEL_NAME: "claude-rerank-model",
      RAG_RERANK_ENDPOINT: "https://api.anthropic.test/v1/messages",
      RAG_RERANK_API_KEY: "rerank-secret",
      RAG_RERANK_ANTHROPIC_VERSION: "2023-06-01",
      RAG_RERANK_ANTHROPIC_BETA: "rerank-beta",
      RAG_GROUNDING_JUDGE_PROVIDER: "anthropic",
      RAG_GROUNDING_JUDGE_MODEL_NAME: "claude-judge-model",
      RAG_GROUNDING_JUDGE_ENDPOINT: "https://api.anthropic.test/v1/messages",
      RAG_GROUNDING_JUDGE_API_KEY: "judge-secret",
      RAG_GROUNDING_JUDGE_ANTHROPIC_VERSION: "2023-06-01"
    }),
    transport: new MockProviderTransport(),
    now: () => FIXED_NOW
  });

  assert.equal(providers.reranker?.mode, "model");
  assert.equal(providers.rerankConfig?.provider, "claude");
  assert.equal(providers.groundingJudgeConfig?.provider, "anthropic");
});

test("optional rerank and grounding judge providers can be disabled even when env exists", () => {
  const providers = createLiveProviderAdaptersFromEnv({
    env: providerEnv({
      RAG_RERANK_PROVIDER: "json-rerank",
      RAG_RERANK_MODEL_NAME: "rerank-model",
      RAG_RERANK_ENDPOINT: "https://provider.example.test/v1/rerank",
      RAG_RERANK_API_KEY: "rerank-secret",
      RAG_GROUNDING_JUDGE_PROVIDER: "json-grounding-judge",
      RAG_GROUNDING_JUDGE_MODEL_NAME: "judge-model",
      RAG_GROUNDING_JUDGE_ENDPOINT: "https://provider.example.test/v1/judge",
      RAG_GROUNDING_JUDGE_API_KEY: "judge-secret"
    }),
    transport: new MockProviderTransport(),
    rerankProvider: "disabled",
    groundingJudgeProvider: "disabled",
    now: () => FIXED_NOW
  });

  assert.equal(providers.reranker, undefined);
  assert.equal(providers.groundingJudge, undefined);
});

test("required optional providers fail fast when their env namespace is missing", () => {
  assert.throws(
    () =>
      createLiveProviderAdaptersFromEnv({
        env: providerEnv(),
        transport: new MockProviderTransport(),
        visualEmbedding: "required"
      }),
    /RAG_VISUAL_EMBEDDING_PROVIDER/
  );
  assert.throws(
    () =>
      createLiveProviderAdaptersFromEnv({
        env: providerEnv(),
        transport: new MockProviderTransport(),
        rerankProvider: "required"
      }),
    /RAG_RERANK_PROVIDER/
  );
  assert.throws(
    () =>
      createLiveProviderAdaptersFromEnv({
        env: providerEnv(),
        transport: new MockProviderTransport(),
        groundingJudgeProvider: "required"
      }),
    /RAG_GROUNDING_JUDGE_PROVIDER/
  );
});

test("rejects ambiguous transport configuration", () => {
  assert.throws(
    () =>
      createLiveProviderAdaptersFromEnv({
        env: providerEnv(),
        transport: new MockProviderTransport(),
        fetch: async () => ({
          status: 200,
          headers: {
            forEach: () => {}
          },
          text: async () => "{}"
        })
      }),
    /either transport or fetch/
  );
});

test("assembles an answer runtime from env-backed model adapter", async () => {
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
              evidenceSummary: "The indexed policy states refund requests need review.",
              confidence: "medium"
            })
          }
        }
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14
      }
    })
  ]);
  const runtime = assembleLiveRagRuntimeFromEnv({
    profile: {
      ...genericDocsProfile,
      namespaceId: "test-namespace"
    },
    chunkStore: index,
    env: providerEnv(),
    transport,
    now: () => FIXED_NOW
  });

  const result = await runtime.answer({
    question: "What is the refund policy?",
    filter: makeIndexFilter(),
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.generation.status, "succeeded");
  assert.equal(runtime.providerAdapters.modelConfig.provider, "json-chat");
  assert.equal(transport.requests.length, 1);
});

test("live env assembly selects Anthropic Messages headers for anthropic providers", async () => {
  const { index, chunks } = makeIndexedFixture();
  const chunkId = chunks[0]?.id;
  assert.ok(chunkId);

  const transport = new MockProviderTransport([
    okResponse({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            answer: "Refund requests require support review.",
            citationChunkIds: [chunkId],
            evidenceSummary: "The indexed policy states refund requests need review.",
            confidence: "medium"
          })
        }
      ],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 4
      }
    })
  ]);
  const runtime = assembleLiveRagRuntimeFromEnv({
    profile: {
      ...genericDocsProfile,
      namespaceId: "test-namespace"
    },
    chunkStore: index,
    env: providerEnv({
      RAG_MODEL_PROVIDER: "anthropic",
      RAG_MODEL_MODEL_NAME: "claude-test-model",
      RAG_MODEL_ENDPOINT: "https://api.anthropic.test/v1/messages",
      RAG_MODEL_API_KEY_ENV: "ANTHROPIC_API_KEY",
      ANTHROPIC_API_KEY: "anthropic-secret",
      RAG_MODEL_ANTHROPIC_VERSION: "2023-06-01"
    }),
    transport,
    now: () => FIXED_NOW
  });

  const result = await runtime.answer({
    question: "What is the refund policy?",
    filter: makeIndexFilter(),
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "succeeded");
  assert.equal(runtime.providerAdapters.model.provider, "anthropic");
  assert.equal(transport.requests[0]?.headers["x-api-key"], "anthropic-secret");
  assert.equal(transport.requests[0]?.headers["anthropic-version"], "2023-06-01");
  assert.equal(transport.requests[0]?.headers["authorization"], undefined);
});

test("live env assembly wires provider reranker and grounding judge into one answer trace", async () => {
  const { index, chunks } = makeIndexedFixture();
  const chunkId = chunks[0]?.id;
  assert.ok(chunkId);

  const transport = new MockProviderTransport([
    okResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              scores: [{ chunkId, score: 0.95, reason: "best policy match" }]
            })
          }
        }
      ]
    }),
    okResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              answer: "Refund requests require review.",
              citationChunkIds: [chunkId],
              evidenceSummary: "The indexed policy states refund requests need review.",
              confidence: "high"
            })
          }
        }
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14
      }
    }),
    okResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              verdict: "grounded",
              issues: []
            })
          }
        }
      ]
    })
  ]);
  const runtime = assembleLiveRagRuntimeFromEnv({
    profile: {
      ...genericDocsProfile,
      namespaceId: "test-namespace",
      retrieval: {
        ...genericDocsProfile.retrieval,
        rerankMode: "model"
      }
    },
    chunkStore: index,
    env: providerEnv({
      RAG_RERANK_PROVIDER: "json-rerank",
      RAG_RERANK_MODEL_NAME: "rerank-model",
      RAG_RERANK_ENDPOINT: "https://provider.example.test/v1/rerank",
      RAG_RERANK_API_KEY: "rerank-secret",
      RAG_GROUNDING_JUDGE_PROVIDER: "json-grounding-judge",
      RAG_GROUNDING_JUDGE_MODEL_NAME: "judge-model",
      RAG_GROUNDING_JUDGE_ENDPOINT: "https://provider.example.test/v1/judge",
      RAG_GROUNDING_JUDGE_API_KEY: "judge-secret"
    }),
    transport,
    now: () => FIXED_NOW
  });

  const result = await runtime.answer({
    question: "What is the refund policy?",
    filter: makeIndexFilter(),
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.retrieval.rerank?.mode, "model");
  assert.equal(result.generation.groundingJudge?.verdict, "grounded");
  assert.equal(runtime.providerAdapters.rerankConfig?.provider, "json-rerank");
  assert.equal(runtime.providerAdapters.groundingJudgeConfig?.provider, "json-grounding-judge");
  assert.equal(transport.requests.length, 3);
  assert.equal(transport.requests[0]?.headers["authorization"], "Bearer rerank-secret");
  assert.equal(transport.requests[2]?.headers["authorization"], "Bearer judge-secret");
  assert.equal(
    result.trace.events.filter((event) => event.kind === "retrieval_reranked").length,
    1
  );
  assert.equal(result.trace.events.filter((event) => event.kind === "grounding_judged").length, 1);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
