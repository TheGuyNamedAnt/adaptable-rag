import assert from "node:assert/strict";
import test from "node:test";

import {
  hasProviderRuntimeEnv,
  loadEmbeddingProviderRuntimeConfigFromEnv,
  loadProviderRuntimeConfigFromEnv
} from "./provider-runtime-config.js";

test("loads provider runtime config from env without storing the raw secret in config", async () => {
  const loaded = loadProviderRuntimeConfigFromEnv({
    prefix: "RAG_MODEL",
    env: {
      RAG_MODEL_PROVIDER: "json-chat",
      RAG_MODEL_MODEL_NAME: "answer-model",
      RAG_MODEL_ENDPOINT: "https://provider.example.test/v1/chat",
      RAG_MODEL_API_KEY_ENV: "ANSWER_MODEL_KEY",
      ANSWER_MODEL_KEY: "secret-from-env",
      RAG_MODEL_TIMEOUT_MS: "7000",
      RAG_MODEL_MAX_RETRIES: "3",
      RAG_MODEL_BACKOFF_MS: "100",
      RAG_MODEL_RETRY_STATUS_CODES: "429,500,503",
      RAG_MODEL_PROMPT_USD_PER_1K_TOKENS: "0.01",
      RAG_MODEL_COMPLETION_USD_PER_1K_TOKENS: "0.03"
    }
  });

  assert.equal(loaded.config.id, "rag-model");
  assert.equal(loaded.config.provider, "json-chat");
  assert.equal(loaded.config.modelName, "answer-model");
  assert.equal(loaded.config.timeoutMs, 7000);
  assert.deepEqual(loaded.config.retryPolicy, {
    maxRetries: 3,
    backoffMs: 100,
    retryStatusCodes: [429, 500, 503]
  });
  assert.deepEqual(loaded.config.pricing, {
    promptUsdPer1kTokens: 0.01,
    completionUsdPer1kTokens: 0.03
  });
  assert.equal(await loaded.secrets.apiKeyProvider(), "secret-from-env");
  assert.equal(loaded.secrets.secretId, "ANSWER_MODEL_KEY");
  assert.equal(JSON.stringify(loaded.config).includes("secret-from-env"), false);
});

test("loads embedding provider dimensions from env", () => {
  const loaded = loadEmbeddingProviderRuntimeConfigFromEnv({
    prefix: "RAG_EMBEDDING",
    env: {
      RAG_EMBEDDING_PROVIDER: "indexed-embedding",
      RAG_EMBEDDING_MODEL_NAME: "embedding-model",
      RAG_EMBEDDING_ENDPOINT: "https://provider.example.test/v1/embeddings",
      RAG_EMBEDDING_API_KEY: "embedding-secret",
      RAG_EMBEDDING_DIMENSIONS: "1536"
    }
  });

  assert.equal(loaded.config.provider, "indexed-embedding");
  assert.equal(loaded.dimensions, 1536);
});

test("reports missing provider env names without leaking values", () => {
  assert.throws(
    () =>
      loadProviderRuntimeConfigFromEnv({
        prefix: "RAG_MODEL",
        env: {
          RAG_MODEL_PROVIDER: "json-chat",
          RAG_MODEL_API_KEY_ENV: "ANSWER_MODEL_KEY"
        }
      }),
    /RAG_MODEL_MODEL_NAME.*RAG_MODEL_ENDPOINT.*ANSWER_MODEL_KEY referenced by RAG_MODEL_API_KEY_ENV/
  );
});

test("detects whether a provider prefix is configured", () => {
  assert.equal(
    hasProviderRuntimeEnv(
      {
        RAG_EMBEDDING_PROVIDER: "indexed-embedding"
      },
      "RAG_EMBEDDING"
    ),
    true
  );
  assert.equal(hasProviderRuntimeEnv({}, "RAG_EMBEDDING"), false);
});
