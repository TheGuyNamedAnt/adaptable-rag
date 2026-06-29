import assert from "node:assert/strict";
import test from "node:test";

import type { VisualEmbeddingAdapter } from "../embeddings/visual-embedding-types.js";

export interface VisualEmbeddingAdapterContractOptions {
  readonly name: string;
  readonly createAdapter: () => VisualEmbeddingAdapter;
}

export function runVisualEmbeddingAdapterContract(
  options: VisualEmbeddingAdapterContractOptions
): void {
  test(`${options.name}: visual embedding adapter exposes stable plug-and-play identity`, async () => {
    const adapter = options.createAdapter();

    assert.equal(typeof adapter.id, "string");
    assert.equal(adapter.id.trim().length > 0, true);
    assert.equal(typeof adapter.provider, "string");
    assert.equal(adapter.provider.trim().length > 0, true);
    assert.equal(typeof adapter.modelName, "string");
    assert.equal(adapter.modelName.trim().length > 0, true);
    assert.equal(Number.isInteger(adapter.dimensions), true);
    assert.equal(adapter.dimensions > 0, true);

    const assetResult = await adapter.embedVisualAssets({
      inputs: [
        {
          id: "contract_visual_input",
          chunkId: "chunk_contract",
          documentId: "doc_contract",
          mediaType: "image/png",
          visualAssetId: "asset_contract",
          text: "contract visual input"
        }
      ]
    });
    const queryResult = await adapter.embedQuery({ query: "contract visual query" });

    assert.equal(assetResult.provider, adapter.provider);
    assert.equal(assetResult.modelName, adapter.modelName);
    assert.equal(assetResult.dimensions, adapter.dimensions);
    assert.equal(queryResult.provider, adapter.provider);
    assert.equal(queryResult.modelName, adapter.modelName);
    assert.equal(queryResult.dimensions, adapter.dimensions);

    if (assetResult.status === "succeeded") {
      assert.equal(assetResult.embeddings[0]?.id, "contract_visual_input");
      assert.equal(assetResult.embeddings[0]?.vectors[0]?.length, adapter.dimensions);
    }

    if (queryResult.status === "succeeded") {
      assert.equal(queryResult.vectors[0]?.length, adapter.dimensions);
    }
  });
}
