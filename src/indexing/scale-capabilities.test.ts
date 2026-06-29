import assert from "node:assert/strict";
import test from "node:test";

import {
  HOSTED_VECTOR_SCALE_CAPABILITIES,
  LOCAL_VECTOR_SCALE_CAPABILITIES,
  POSTGRES_INDEX_SCALE_CAPABILITIES,
  POSTGRES_VECTOR_SCALE_CAPABILITIES,
  isVectorGenerationInventoryProvider
} from "./scale-capabilities.js";

test("scale capabilities expose portable backend scale posture", () => {
  assert.equal(LOCAL_VECTOR_SCALE_CAPABILITIES.topology, "embedded");
  assert.equal(LOCAL_VECTOR_SCALE_CAPABILITIES.generationInventory.mode, "sync");
  assert.equal(LOCAL_VECTOR_SCALE_CAPABILITIES.annIndex.supported, false);

  assert.equal(POSTGRES_INDEX_SCALE_CAPABILITIES.stats.mode, "async");
  assert.equal(POSTGRES_INDEX_SCALE_CAPABILITIES.partitioning.supported, false);
  assert.deepEqual(POSTGRES_INDEX_SCALE_CAPABILITIES.partitionKeys, [
    "tenant_id",
    "namespace_id",
    "source_id",
    "document_id"
  ]);

  assert.equal(POSTGRES_VECTOR_SCALE_CAPABILITIES.generationInventory.mode, "async");
  assert.equal(POSTGRES_VECTOR_SCALE_CAPABILITIES.annIndex.supported, true);
  assert.equal(
    POSTGRES_VECTOR_SCALE_CAPABILITIES.partitionKeys.includes("embedding_config_hash"),
    true
  );

  assert.equal(HOSTED_VECTOR_SCALE_CAPABILITIES.topology, "hosted");
  assert.equal(HOSTED_VECTOR_SCALE_CAPABILITIES.metadataFiltering.mode, "external");
  assert.equal(HOSTED_VECTOR_SCALE_CAPABILITIES.generationInventory.supported, false);
});

test("vector generation inventory provider guard checks shape only", () => {
  assert.equal(
    isVectorGenerationInventoryProvider({
      vectorGenerationInventory: () => []
    }),
    true
  );
  assert.equal(isVectorGenerationInventoryProvider({ vectorGenerationInventory: [] }), false);
  assert.equal(isVectorGenerationInventoryProvider(undefined), false);
});
