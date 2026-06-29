import assert from "node:assert/strict";
import test from "node:test";

import { cosineSimilarity, vectorMagnitude } from "../shared/vector-math.js";
import { runEmbeddingAdapterContract } from "../test-support/embedding-adapter-contract.js";
import {
  FakeEmbeddingAdapter,
  embedText,
  tokenizeEmbeddingText
} from "./fake-embedding-adapter.js";

runEmbeddingAdapterContract({
  name: "FakeEmbeddingAdapter",
  createAdapter: () => new FakeEmbeddingAdapter({ dimensions: 16 })
});

test("fake embeddings are deterministic, normalized, and token based", async () => {
  const adapter = new FakeEmbeddingAdapter({ dimensions: 16 });
  const first = await adapter.embed({
    inputs: [{ id: "a", text: "Refund policy requires billing review." }]
  });
  const second = await adapter.embed({
    inputs: [{ id: "a", text: "Refund policy requires billing review." }]
  });

  assert.equal(first.status, "succeeded");
  assert.deepEqual(first.embeddings[0]?.vector, second.embeddings[0]?.vector);
  assert.equal(first.dimensions, 16);
  assert.equal(Math.round(vectorMagnitude(first.embeddings[0]?.vector ?? []) * 1000) / 1000, 1);
  assert.deepEqual(tokenizeEmbeddingText("Refund, refund-policy!"), ["refund", "refund-policy"]);
});

test("fake embeddings preserve token overlap enough for local vector tests", () => {
  const query = embedText("refund billing", 32);
  const matching = embedText("refund billing support review", 32);
  const unrelated = embedText("login password reset", 32);

  assert.ok(cosineSimilarity(query, matching) > cosineSimilarity(query, unrelated));
});

test("fake embedding adapter can simulate provider failure", async () => {
  const adapter = new FakeEmbeddingAdapter({ failWith: "embedding provider unavailable" });
  const result = await adapter.embed({
    inputs: [{ id: "a", text: "Refund policy." }]
  });

  assert.equal(result.status, "failed");
  assert.equal(result.embeddings.length, 0);
  assert.equal(result.errorMessage, "embedding provider unavailable");
});
