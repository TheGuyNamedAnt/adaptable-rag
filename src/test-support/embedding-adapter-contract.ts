import assert from "node:assert/strict";
import test from "node:test";

import type { EmbeddingAdapter } from "../embeddings/embedding-types.js";

export interface EmbeddingAdapterContractOptions {
  readonly name: string;
  readonly createAdapter: () => EmbeddingAdapter;
}

export function runEmbeddingAdapterContract(options: EmbeddingAdapterContractOptions): void {
  test(`${options.name}: embedding adapter exposes stable plug-and-play identity`, async () => {
    const adapter = options.createAdapter();

    assert.equal(typeof adapter.id, "string");
    assert.equal(adapter.id.trim().length > 0, true);
    assert.equal(typeof adapter.provider, "string");
    assert.equal(adapter.provider.trim().length > 0, true);
    assert.equal(typeof adapter.modelName, "string");
    assert.equal(adapter.modelName.trim().length > 0, true);
    assert.equal(Number.isInteger(adapter.dimensions), true);
    assert.equal(adapter.dimensions > 0, true);

    const result = await adapter.embed({
      inputs: [{ id: "contract_input", text: "contract embedding input" }]
    });

    assert.equal(result.provider, adapter.provider);
    assert.equal(result.modelName, adapter.modelName);
    assert.equal(result.dimensions, adapter.dimensions);
    assert.equal(result.status === "succeeded" || result.status === "failed", true);

    if (result.status === "succeeded") {
      assert.equal(result.embeddings[0]?.id, "contract_input");
      assert.equal(result.embeddings[0]?.vector.length, adapter.dimensions);
    }
  });
}
