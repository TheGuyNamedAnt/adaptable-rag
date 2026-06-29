import assert from "node:assert/strict";
import test from "node:test";

import { runVisualEmbeddingAdapterContract } from "../test-support/visual-embedding-adapter-contract.js";
import {
  FakeVisualEmbeddingAdapter,
  visualVectorsForText
} from "./fake-visual-embedding-adapter.js";

runVisualEmbeddingAdapterContract({
  name: "FakeVisualEmbeddingAdapter",
  createAdapter: () => new FakeVisualEmbeddingAdapter({ dimensions: 8 })
});

test("fake visual embeddings are deterministic multivectors", async () => {
  const adapter = new FakeVisualEmbeddingAdapter({ dimensions: 8 });
  const first = await adapter.embedQuery({ query: "dashboard revenue" });
  const second = await adapter.embedQuery({ query: "dashboard revenue" });

  assert.equal(first.status, "succeeded");
  assert.deepEqual(first.vectors, second.vectors);
  assert.equal(
    first.vectors.every((vector) => vector.length === 8),
    true
  );
  assert.deepEqual(visualVectorsForText("dashboard revenue", 8), first.vectors);
});

test("fake visual embedding adapter can simulate provider failure", async () => {
  const adapter = new FakeVisualEmbeddingAdapter({ failWith: "visual provider unavailable" });
  const result = await adapter.embedQuery({ query: "dashboard" });

  assert.equal(result.status, "failed");
  assert.equal(result.vectors.length, 0);
  assert.equal(result.errorMessage, "visual provider unavailable");
});
