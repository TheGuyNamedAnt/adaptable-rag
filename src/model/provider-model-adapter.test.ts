import assert from "node:assert/strict";
import test from "node:test";

import type { AnswerGenerationInput, SourcedAnswerDraft } from "../answer/answer-types.js";
import { chunkDocument } from "../chunking/chunker.js";
import { ContextBuilder } from "../context/context-builder.js";
import type { ContextBuildResult } from "../context/context-types.js";
import type { RagDocument } from "../documents/document.js";
import { GenerationOrchestrator } from "../generation/generation-orchestrator.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import type { RagProfile } from "../profiles/profile.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile, type ValidatedRagProfile } from "../profiles/profile-validation.js";
import { KeywordRetriever } from "../retrieval/keyword-retriever.js";
import { FIXED_NOW, makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import type { ModelGenerateRequest, ModelTokenUsage } from "./model-types.js";
import {
  ProviderModelAdapter,
  mapProviderStatus,
  redactText,
  validateProviderConfig
} from "./provider-model-adapter.js";
import type {
  ProviderBoundaryConfig,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "./provider-types.js";

class MockProviderTransport implements ProviderTransport {
  readonly requests: ProviderHttpRequest[] = [];
  private readonly results: Array<ProviderHttpResponse | Error>;

  constructor(results: Array<ProviderHttpResponse | Error>) {
    this.results = [...results];
  }

  async send(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(request);
    const next = this.results.shift();

    if (!next) {
      throw new Error("No mock provider response configured.");
    }

    if (next instanceof Error) {
      throw next;
    }

    return next;
  }
}

function providerConfig(overrides: Partial<ProviderBoundaryConfig> = {}): ProviderBoundaryConfig {
  return {
    id: "provider-test",
    provider: "test-provider",
    modelName: "test-model",
    endpoint: "https://provider.example.test/v1/responses",
    timeoutMs: 5000,
    retryPolicy: {
      maxRetries: 1,
      backoffMs: 0,
      retryStatusCodes: [408, 429, 500, 502, 503, 504]
    },
    pricing: {
      promptUsdPer1kTokens: 0.01,
      completionUsdPer1kTokens: 0.03
    },
    ...overrides
  };
}

function buildRequestBody(request: ModelGenerateRequest): unknown {
  return {
    question: request.input.question,
    context: request.input.contextText,
    rules: request.input.groundingRules,
    schemaName: request.input.contract.schemaName,
    maxOutputTokens: request.input.contract.maxOutputTokens,
    allowedCitationChunkIds: request.input.contract.allowedCitationChunkIds
  };
}

function parseResponse(response: ProviderHttpResponse): {
  readonly draft: SourcedAnswerDraft;
  readonly usage?: ModelTokenUsage;
  readonly warnings?: readonly string[];
} {
  if (!isRecord(response.body) || typeof response.body["answer"] !== "string") {
    throw new Error("Provider response did not contain an answer.");
  }

  const citationChunkIds = Array.isArray(response.body["citationChunkIds"])
    ? response.body["citationChunkIds"].filter(
        (chunkId): chunkId is string => typeof chunkId === "string"
      )
    : [];
  const draft: SourcedAnswerDraft = {
    answer: response.body["answer"],
    citationChunkIds,
    ...(typeof response.body["evidenceSummary"] === "string"
      ? { evidenceSummary: response.body["evidenceSummary"] }
      : {})
  };
  const usage = isRecord(response.body["usage"])
    ? {
        promptTokens: Number(response.body["usage"]["promptTokens"] ?? 0),
        completionTokens: Number(response.body["usage"]["completionTokens"] ?? 0),
        totalTokens: Number(response.body["usage"]["totalTokens"] ?? 0)
      }
    : undefined;
  const warnings = Array.isArray(response.body["warnings"])
    ? response.body["warnings"].filter((warning): warning is string => typeof warning === "string")
    : undefined;

  return {
    draft,
    ...(usage ? { usage } : {}),
    ...(warnings ? { warnings } : {})
  };
}

function generationInput(chunkId = "chunk_allowed"): AnswerGenerationInput {
  return {
    question: "What is the refund policy?",
    contextText: "[SOURCE 1]\nRefund policy says review is required.\n[/SOURCE 1]",
    groundingRules: ["Use only approved context."],
    contract: {
      schemaName: "GenericSourcedAnswer",
      outputMode: "sourced_answer",
      requireStructuredOutput: true,
      requireCitations: true,
      requireEvidenceSummary: true,
      allowedCitationChunkIds: [chunkId],
      minimumCitations: 1,
      minimumTrustedCitations: 1,
      maxOutputTokens: 1000,
      actionMode: "answer_only",
      allowedActions: [],
      requireApprovalFor: []
    }
  };
}

function modelRequest(input = generationInput()): ModelGenerateRequest {
  return {
    requestId: "model_provider_test",
    profileId: "generic-docs",
    namespaceId: "test-namespace",
    modelTier: "strong",
    input,
    requestedAt: FIXED_NOW
  };
}

function okResponse(body: unknown): ProviderHttpResponse {
  return {
    status: 200,
    headers: {},
    body,
    latencyMs: 25
  };
}

function errorResponse(status: number, message: string): ProviderHttpResponse {
  return {
    status,
    headers: {},
    body: {
      error: {
        message
      }
    },
    latencyMs: 10
  };
}

function providerAdapter(
  transport: ProviderTransport,
  apiKey = "sk_test_secret"
): ProviderModelAdapter {
  return new ProviderModelAdapter({
    config: providerConfig(),
    secrets: {
      apiKeyProvider: () => apiKey,
      secretId: "TEST_PROVIDER_KEY"
    },
    transport,
    buildRequestBody,
    parseResponse,
    now: () => FIXED_NOW,
    sleep: async () => {}
  });
}

function profileForTest(overrides: Partial<RagProfile> = {}): ValidatedRagProfile {
  return assertValidProfile({
    ...genericDocsProfile,
    namespaceId: "test-namespace",
    ...overrides
  });
}

async function buildContext(
  documents: readonly RagDocument[],
  profile = profileForTest()
): Promise<ContextBuildResult> {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  for (const document of documents) {
    const chunks = chunkDocument({ document }).chunks;
    index.addDocument(document);
    index.addChunks(document.id, chunks);
  }

  const retriever = new KeywordRetriever({ chunkStore: index, now: () => FIXED_NOW });
  const retrieval = await retriever.retrieve({
    query: "refund policy",
    filter: makeIndexFilter(),
    topK: 10,
    retrievalId: "retrieval_provider_test",
    requestedAt: FIXED_NOW
  });
  const builder = new ContextBuilder({ now: () => FIXED_NOW });

  return builder.build({
    profile,
    retrieval,
    contextId: "context_provider_test",
    requestedAt: FIXED_NOW
  });
}

test("validates provider config before runtime", () => {
  assert.throws(
    () => validateProviderConfig(providerConfig({ endpoint: "http://provider.example.test/v1" })),
    /https/
  );
  assert.throws(
    () =>
      validateProviderConfig(
        providerConfig({
          retryPolicy: {
            maxRetries: 6,
            backoffMs: 0,
            retryStatusCodes: [429]
          }
        })
      ),
    /maxRetries/
  );
  assert.doesNotThrow(() =>
    validateProviderConfig(providerConfig({ endpoint: "http://localhost:8787/v1" }))
  );
});

test("sends provider requests through the auth and timeout boundary", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      answer: "Refund policy requires review.",
      citationChunkIds: ["chunk_allowed"],
      evidenceSummary: "One approved context chunk supports the answer.",
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120
      }
    })
  ]);
  const adapter = providerAdapter(transport);

  const result = await adapter.generate(modelRequest());

  assert.equal(result.status, "succeeded");
  assert.equal(result.draft?.answer, "Refund policy requires review.");
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0]?.headers["authorization"], "Bearer sk_test_secret");
  assert.equal(transport.requests[0]?.timeoutMs, 5000);
  assert.equal(result.usage.totalTokens, 120);
  assert.equal(result.cost.amountUsd, 0.0016);
});

test("retries retryable provider responses and returns the successful parsed draft", async () => {
  const transport = new MockProviderTransport([
    errorResponse(429, "rate limited"),
    okResponse({
      answer: "Refund policy requires review.",
      citationChunkIds: ["chunk_allowed"],
      evidenceSummary: "One approved context chunk supports the answer."
    })
  ]);
  const adapter = providerAdapter(transport);

  const result = await adapter.generate(modelRequest());

  assert.equal(result.status, "succeeded");
  assert.equal(transport.requests.length, 2);
  assert.equal(result.latencyMs, 35);
});

test("does not retry auth errors and redacts provider secrets", async () => {
  const transport = new MockProviderTransport([
    errorResponse(401, "bad api key sk_test_secret bearer sk_test_secret")
  ]);
  const adapter = providerAdapter(transport);

  const result = await adapter.generate(modelRequest());

  assert.equal(result.status, "failed");
  assert.equal(transport.requests.length, 1);
  assert.equal(result.errorMessage?.includes("sk_test_secret"), false);
  assert.equal(result.errorMessage?.includes("[REDACTED]"), true);
  assert.equal(result.warnings.includes("provider_error_code:auth_error"), true);
});

test("returns auth failure before transport when api key is missing", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      answer: "Should not be called.",
      citationChunkIds: ["chunk_allowed"]
    })
  ]);
  const adapter = providerAdapter(transport, " ");

  const result = await adapter.generate(modelRequest());

  assert.equal(result.status, "failed");
  assert.equal(result.errorMessage, "Provider API key is missing.");
  assert.equal(transport.requests.length, 0);
  assert.equal(result.warnings.includes("provider_error_code:auth_error"), true);
});

test("maps invalid provider response parsing into failed results", async () => {
  const transport = new MockProviderTransport([okResponse({ nope: true })]);
  const adapter = providerAdapter(transport);

  const result = await adapter.generate(modelRequest());

  assert.equal(result.status, "failed");
  assert.match(result.errorMessage ?? "", /answer/);
  assert.equal(result.warnings.includes("provider_error_code:invalid_response"), true);
  assert.equal(result.warnings.includes("provider_attempts:1"), true);
});

test("retries transport timeout errors", async () => {
  const transport = new MockProviderTransport([
    new Error("timeout while calling provider"),
    okResponse({
      answer: "Refund policy requires review.",
      citationChunkIds: ["chunk_allowed"],
      evidenceSummary: "One approved context chunk supports the answer."
    })
  ]);
  const adapter = providerAdapter(transport);

  const result = await adapter.generate(modelRequest());

  assert.equal(result.status, "succeeded");
  assert.equal(transport.requests.length, 2);
});

test("maps provider statuses consistently", () => {
  assert.equal(mapProviderStatus(errorResponse(401, "auth"))?.code, "auth_error");
  assert.equal(mapProviderStatus(errorResponse(429, "rate"))?.code, "rate_limited");
  assert.equal(mapProviderStatus(errorResponse(504, "timeout"))?.code, "timeout");
  assert.equal(mapProviderStatus(errorResponse(500, "boom"))?.retryable, true);
  assert.equal(mapProviderStatus(errorResponse(400, "bad"))?.retryable, false);
  assert.equal(mapProviderStatus(okResponse({ ok: true })), undefined);
});

test("redacts common secret patterns", () => {
  const redacted = redactText("Bearer abc123 api_key=secret password=hunter2", ["secret"]);

  assert.equal(redacted.includes("abc123"), false);
  assert.equal(redacted.includes("hunter2"), false);
  assert.equal(redacted.includes("secret"), false);
});

test("plugs into the generation orchestrator without bypassing validation", async () => {
  const profile = profileForTest();
  const context = await buildContext([
    makeDocument({
      id: "doc_refunds",
      body: "Refund policy says billing refunds require human review."
    })
  ]);
  const chunkId = context.blocks[0]?.chunkId;
  assert.ok(chunkId);
  const transport = new MockProviderTransport([
    okResponse({
      answer: "Billing refunds require human review.",
      citationChunkIds: [chunkId],
      evidenceSummary: "One approved context chunk supports the answer."
    })
  ]);
  const adapter = providerAdapter(transport);
  const orchestrator = new GenerationOrchestrator({ now: () => FIXED_NOW });

  const result = await orchestrator.run({
    profile,
    context,
    question: "What is the refund policy?",
    model: adapter,
    generationId: "generation_provider_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.validation?.valid, true);
  assert.equal(result.trace.model.provider, "test-provider");
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
