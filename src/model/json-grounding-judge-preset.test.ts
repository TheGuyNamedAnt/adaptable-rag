import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderBoundaryConfig,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import { FIXED_NOW } from "../test-support/fixtures.js";
import {
  createAnthropicGroundingJudgeAdapter,
  parseAnthropicGroundingJudgeResponse
} from "./anthropic-grounding-judge-preset.js";
import {
  createJsonGroundingJudgeAdapter,
  parseJsonGroundingJudgeResponse
} from "./json-grounding-judge-preset.js";
import type { GroundingJudgeModelRequest } from "../answer/grounding-judge.js";
import { createOpenAICompatibleGroundingJudgeAdapter } from "./openai-grounding-judge-preset.js";

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
      throw new Error("No mock grounding judge provider response configured.");
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

const request: GroundingJudgeModelRequest = {
  requestId: "judge_provider_test",
  profileId: "profile_test",
  namespaceId: "test-namespace",
  modelTier: "strong",
  question: "What is the refund policy?",
  answer: "Refund requests require support review.",
  citationChunkIds: ["chunk_refund"],
  contextBlocks: [
    {
      chunkId: "chunk_refund",
      documentId: "doc_refund",
      sourceId: "docs",
      sourceKind: "local_file",
      trustTier: "trusted_internal",
      text: "Refund requests require support review."
    }
  ],
  requestedAt: FIXED_NOW
};

test("json grounding judge adapter sends provider request and parses chat JSON verdict", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              verdict: "unsupported",
              issues: [
                {
                  code: "unsupported_claim",
                  message: "The answer adds a claim not present in context.",
                  chunkId: "chunk_refund"
                },
                {
                  code: "not_a_supported_code",
                  message: "Ignored."
                }
              ],
              warnings: ["judge_low_margin"]
            })
          }
        }
      ],
      usage: {
        prompt_tokens: 80,
        completion_tokens: 8,
        total_tokens: 88
      }
    })
  ]);
  const adapter = createJsonGroundingJudgeAdapter({
    config: providerConfig(),
    secrets: {
      apiKeyProvider: () => "judge-secret"
    },
    transport,
    now: () => FIXED_NOW
  });

  const result = await adapter.judge(request);

  assert.equal(result.verdict, "unsupported");
  assert.deepEqual(result.issues, [
    {
      code: "unsupported_claim",
      message: "The answer adds a claim not present in context.",
      chunkId: "chunk_refund"
    }
  ]);
  assert.deepEqual(result.warnings, ["judge_low_margin", "provider_issue_code_ignored"]);
  assert.equal(result.cost.amountUsd, 0.000176);
  assert.equal(transport.requests[0]?.headers["authorization"], "Bearer judge-secret");
  assert.equal(transport.requests[0]?.body && typeof transport.requests[0].body, "object");
});

test("json grounding judge parser supports direct provider verdict objects", () => {
  const parsed = parseJsonGroundingJudgeResponse(
    okResponse({
      verdict: "grounded",
      issues: []
    })
  );

  assert.equal(parsed.verdict, "grounded");
  assert.deepEqual(parsed.issues, []);
});

test("json grounding judge parser supports output content text responses", () => {
  const parsed = parseJsonGroundingJudgeResponse(
    okResponse({
      output: [
        {
          content: [
            {
              text: JSON.stringify({
                verdict: "grounded",
                issues: []
              })
            }
          ]
        }
      ]
    })
  );

  assert.equal(parsed.verdict, "grounded");
  assert.deepEqual(parsed.issues, []);
});

test("json grounding judge adapter returns zero estimated cost when pricing is absent", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      verdict: "grounded",
      issues: []
    })
  ]);
  const { pricing: _pricing, ...configWithoutPricing } = providerConfig();
  const adapter = createJsonGroundingJudgeAdapter({
    config: configWithoutPricing,
    secrets: {
      apiKeyProvider: () => "judge-secret"
    },
    transport,
    now: () => FIXED_NOW
  });

  const result = await adapter.judge(request);

  assert.equal(result.verdict, "grounded");
  assert.equal(result.cost.amountUsd, 0);
});

test("openai-compatible grounding judge adapter uses the generic JSON response shape", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      output_text: JSON.stringify({
        verdict: "grounded",
        issues: []
      })
    })
  ]);
  const adapter = createOpenAICompatibleGroundingJudgeAdapter({
    config: providerConfig({ provider: "openai-compatible" }),
    secrets: {
      apiKeyProvider: () => "openai-secret"
    },
    transport,
    now: () => FIXED_NOW
  });

  const result = await adapter.judge(request);

  assert.equal(result.verdict, "grounded");
  assert.deepEqual(result.issues, []);
  assert.equal(transport.requests[0]?.headers["authorization"], "Bearer openai-secret");
});

test("provider grounding judge returns failed verdict without sending when API key is missing", async () => {
  const transport = new MockProviderTransport([]);
  const adapter = createJsonGroundingJudgeAdapter({
    config: providerConfig(),
    secrets: {
      apiKeyProvider: () => "   "
    },
    transport,
    now: () => FIXED_NOW
  });

  const result = await adapter.judge(request);

  assert.equal(result.verdict, "failed");
  assert.equal(result.issues[0]?.message, "Provider API key is missing.");
  assert.equal(transport.requests.length, 0);
});

test("provider grounding judge retries retryable transport failures before success", async () => {
  const sleeps: number[] = [];
  const transport = new MockProviderTransport([
    new Error("request timeout"),
    okResponse({
      verdict: "grounded",
      issues: []
    })
  ]);
  const adapter = createJsonGroundingJudgeAdapter({
    config: providerConfig({
      retryPolicy: {
        maxRetries: 1,
        backoffMs: 25,
        retryStatusCodes: [408, 429, 500]
      }
    }),
    secrets: {
      apiKeyProvider: () => "judge-secret"
    },
    transport,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    now: () => FIXED_NOW
  });

  const result = await adapter.judge(request);

  assert.equal(result.verdict, "grounded");
  assert.equal(transport.requests.length, 2);
  assert.deepEqual(sleeps, [25]);
});

test("json grounding judge parser rejects malformed verdict payloads", () => {
  assert.throws(
    () =>
      parseJsonGroundingJudgeResponse(
        okResponse({
          verdict: "grounded",
          issues: "bad"
        })
      ),
    /issues must be an array/
  );
  assert.throws(
    () =>
      parseJsonGroundingJudgeResponse(
        okResponse({
          choices: [
            {
              message: {
                content: "not json"
              }
            }
          ]
        })
      ),
    /JSON object/
  );
});

test("provider grounding judge failures return failed verdict and redact API secrets", async () => {
  const transport = new MockProviderTransport([
    {
      status: 401,
      headers: {},
      body: {
        error: {
          message: "Bearer judge-secret is invalid"
        }
      },
      latencyMs: 7
    }
  ]);
  const adapter = createJsonGroundingJudgeAdapter({
    config: providerConfig(),
    secrets: {
      apiKeyProvider: () => "judge-secret",
      secretId: "RAG_GROUNDING_JUDGE_API_KEY"
    },
    transport,
    now: () => FIXED_NOW
  });

  const result = await adapter.judge(request);

  assert.equal(result.verdict, "failed");
  assert.equal(result.issues[0]?.code, "judge_failed");
  assert.equal(result.issues[0]?.message.includes("judge-secret"), false);
  assert.equal(result.issues[0]?.message.includes("[REDACTED]"), true);
  assert.deepEqual(result.warnings, [
    "provider_error_code:auth_error",
    "provider_attempts:1",
    "provider_endpoint_host:provider.example.test"
  ]);
});

test("anthropic grounding judge adapter uses Anthropic headers and parses content blocks", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            verdict: "grounded",
            issues: []
          })
        }
      ],
      usage: {
        input_tokens: 40,
        output_tokens: 4
      }
    })
  ]);
  const adapter = createAnthropicGroundingJudgeAdapter({
    config: providerConfig({
      provider: "anthropic",
      endpoint: "https://api.anthropic.test/v1/messages"
    }),
    secrets: {
      apiKeyProvider: () => "anthropic-secret"
    },
    transport,
    anthropicBeta: "judge-beta",
    temperature: 0.2,
    now: () => FIXED_NOW
  });

  const result = await adapter.judge(request);
  const body = transport.requests[0]?.body as Record<string, unknown> | undefined;

  assert.equal(result.verdict, "grounded");
  assert.equal(transport.requests[0]?.headers["x-api-key"], "anthropic-secret");
  assert.equal(transport.requests[0]?.headers["anthropic-version"], "2023-06-01");
  assert.equal(transport.requests[0]?.headers["anthropic-beta"], "judge-beta");
  assert.equal(transport.requests[0]?.headers["authorization"], undefined);
  assert.equal(body?.["temperature"], 0.2);
});

test("anthropic grounding judge parser rejects malformed content blocks", () => {
  assert.throws(() => parseAnthropicGroundingJudgeResponse(okResponse("bad")), /must be an object/);
  assert.throws(() => parseAnthropicGroundingJudgeResponse(okResponse({})), /content blocks/);
  assert.throws(
    () =>
      parseAnthropicGroundingJudgeResponse(
        okResponse({
          content: [{ type: "text", text: "   " }]
        })
      ),
    /did not include text/
  );
});

function providerConfig(overrides: Partial<ProviderBoundaryConfig> = {}): ProviderBoundaryConfig {
  return {
    id: "judge-provider",
    provider: "json-grounding-judge",
    modelName: "judge-model",
    endpoint: "https://provider.example.test/v1/judge",
    timeoutMs: 30000,
    retryPolicy: {
      maxRetries: 0,
      backoffMs: 0,
      retryStatusCodes: [429, 500]
    },
    pricing: {
      promptUsdPer1kTokens: 0.002,
      completionUsdPer1kTokens: 0.002
    },
    ...overrides
  };
}

function okResponse(body: unknown): ProviderHttpResponse {
  return {
    status: 200,
    headers: {},
    body,
    latencyMs: 12
  };
}
