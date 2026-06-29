import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import { FakeEmbeddingAdapter } from "../embeddings/fake-embedding-adapter.js";
import { EmbeddingIndexer } from "../embeddings/embedding-indexer.js";
import { cosineSimilarity } from "../shared/vector-math.js";
import { FIXED_NOW, makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import { InMemoryRagIndex } from "./in-memory-index.js";
import { PostgresVectorStore } from "./postgres-vector-store.js";

test("postgres vector store indexes, searches, counts, and deletes pgvector rows", async () => {
  const document = makeDocument({
    id: "doc_postgres_vector_refund",
    body: "Refund billing policy requires support review."
  });
  const chunks = chunkDocument({ document }).chunks;
  const chunkIndex = new InMemoryRagIndex({ now: () => FIXED_NOW });
  chunkIndex.addDocument(document);
  chunkIndex.addChunks(document.id, chunks);

  const pool = new MockPgVectorPool();
  const vectorStore = new PostgresVectorStore({
    chunkStore: chunkIndex,
    pool: pool as never,
    dimensions: 8,
    now: () => FIXED_NOW
  });
  const adapter = new FakeEmbeddingAdapter({ dimensions: 8 });
  const indexed = await new EmbeddingIndexer({
    adapter,
    vectorStore,
    now: () => FIXED_NOW
  }).indexChunks({
    chunks,
    requestedAt: FIXED_NOW
  });
  const [queryEmbedding] = (
    await adapter.embed({ inputs: [{ id: "query", text: "refund billing" }] })
  ).embeddings;
  assert.ok(queryEmbedding);

  const result = await vectorStore.findNearestVectors({
    vector: queryEmbedding.vector,
    filter: makeIndexFilter(),
    topK: 1
  });

  assert.equal(vectorStore.capabilities.storageKind, "postgres");
  assert.equal(indexed.indexedVectorCount, chunks.length);
  assert.equal(await vectorStore.vectorCount(), chunks.length);
  assert.deepEqual(
    (await vectorStore.vectorGenerationInventory()).map((entry) => ({
      provider: entry.embeddingProvider,
      model: entry.embeddingModel,
      hash: entry.embeddingConfigHash,
      vectors: entry.vectorCount
    })),
    [
      {
        provider: adapter.provider,
        model: adapter.modelName,
        hash: result.candidates[0]?.vector.embeddingConfigHash,
        vectors: chunks.length
      }
    ]
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.chunk.documentId, "doc_postgres_vector_refund");
  assert.equal(result.candidates[0]?.reasons[0], "pgvector_cosine_similarity");

  assert.equal(await vectorStore.deleteVectorsForDocument(document.id), chunks.length);
  assert.equal(await vectorStore.vectorCount(), 0);

  const readiness = await vectorStore.readinessCheck();
  assert.equal(readiness.status, "passed");
  assert.equal(
    readiness.checks.some((check) => check.id === "vector_ann_index" && check.status === "passed"),
    true
  );
});

test("postgres vector store rejects legacy rows missing required embedding config hash", async () => {
  const document = makeDocument({
    id: "doc_postgres_legacy_vector",
    body: "Refund billing policy requires support review."
  });
  const chunks = chunkDocument({ document }).chunks;
  const [chunk] = chunks;
  assert.ok(chunk);
  const chunkIndex = new InMemoryRagIndex({ now: () => FIXED_NOW });
  chunkIndex.addDocument(document);
  chunkIndex.addChunks(document.id, chunks);

  const pool = new MockPgVectorPool();
  pool.insertRow({
    id: "legacy_vector",
    chunk_id: chunk.id,
    document_id: chunk.documentId,
    tenant_id: chunk.accessScope.tenantId,
    namespace_id: chunk.namespaceId,
    text_hash: chunk.textHash,
    embedding_model: "same-model",
    dimensions: 3,
    vector: "[1,0,0]",
    metadata: {},
    embedded_at: FIXED_NOW,
    indexed_at: FIXED_NOW,
    updated_at: null
  });
  const vectorStore = new PostgresVectorStore({
    chunkStore: chunkIndex,
    pool: pool as never,
    dimensions: 3,
    now: () => FIXED_NOW
  });

  const result = await vectorStore.findNearestVectors({
    vector: [1, 0, 0],
    filter: makeIndexFilter(),
    topK: 1,
    embeddingModel: "same-model",
    embeddingProvider: "provider",
    embeddingConfigHash: "required-hash"
  });

  assert.equal(result.candidates.length, 0);
});

test("postgres vector readiness fails when embedding identity filter index is missing", async () => {
  const vectorStore = new PostgresVectorStore({
    chunkStore: new InMemoryRagIndex({ now: () => FIXED_NOW }),
    pool: new MockPgVectorPool({ identityIndexExists: false }) as never,
    dimensions: 3,
    now: () => FIXED_NOW
  });

  const readiness = await vectorStore.readinessCheck();

  assert.equal(readiness.status, "failed");
  assert.deepEqual(
    readiness.checks
      .filter((check) => check.id === "vector_identity_filter_index")
      .map((check) => check.status),
    ["failed"]
  );
});

interface MockPgVectorPoolOptions {
  readonly identityIndexExists?: boolean;
}

class MockPgVectorPool {
  private readonly rows: MockVectorRow[] = [];
  private readonly options: Required<MockPgVectorPoolOptions>;

  constructor(options: MockPgVectorPoolOptions = {}) {
    this.options = {
      identityIndexExists: options.identityIndexExists ?? true
    };
  }

  insertRow(row: MockVectorRow): void {
    this.rows.push(row);
  }

  async connect(): Promise<MockPgVectorClient> {
    return new MockPgVectorClient(this.rows, this.options);
  }

  async query<T>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<{ rows: T[]; rowCount: number }> {
    return queryMockRows<T>(this.rows, sql, params, this.options);
  }
}

class MockPgVectorClient {
  constructor(
    private readonly rows: MockVectorRow[],
    private readonly options: Required<MockPgVectorPoolOptions>
  ) {}

  async query<T>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<{ rows: T[]; rowCount: number }> {
    return queryMockRows<T>(this.rows, sql, params, this.options);
  }

  release(): void {
    return undefined;
  }
}

interface MockVectorRow {
  id: string;
  chunk_id: string;
  document_id: string;
  tenant_id: string;
  namespace_id: string;
  text_hash: string;
  embedding_model: string;
  dimensions: number;
  vector: string;
  metadata: Record<string, string | number | boolean>;
  embedded_at: string;
  indexed_at: string;
  updated_at: string | null;
}

function queryMockRows<T>(
  rows: MockVectorRow[],
  sql: string,
  params: readonly unknown[],
  options: Required<MockPgVectorPoolOptions>
): { rows: T[]; rowCount: number } {
  const normalized = sql.toLowerCase();
  if (
    normalized.startsWith("begin") ||
    normalized.startsWith("commit") ||
    normalized.startsWith("rollback")
  ) {
    return { rows: [], rowCount: 0 };
  }

  if (normalized.includes("insert into")) {
    const id = String(params[0]);
    const existingIndex = rows.findIndex((row) => row.id === id);
    const row: MockVectorRow = {
      id,
      chunk_id: String(params[1]),
      document_id: String(params[2]),
      tenant_id: String(params[3]),
      namespace_id: String(params[4]),
      text_hash: String(params[5]),
      embedding_model: String(params[6]),
      dimensions: Number(params[7]),
      vector: String(params[8]),
      metadata: JSON.parse(String(params[9])) as Record<string, string | number | boolean>,
      embedded_at: String(params[10]),
      indexed_at: String(params[11]),
      updated_at: params[12] === null ? null : String(params[12])
    };
    if (existingIndex >= 0) {
      rows[existingIndex] = row;
    } else {
      rows.push(row);
    }
    return { rows: [], rowCount: 1 };
  }

  if (normalized.includes("where id = $1")) {
    return {
      rows: rows.filter((row) => row.id === params[0]) as T[],
      rowCount: rows.filter((row) => row.id === params[0]).length
    };
  }

  if (normalized.includes("delete from")) {
    const before = rows.length;
    const documentId = String(params[0]);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index]?.document_id === documentId) {
        rows.splice(index, 1);
      }
    }
    return { rows: [], rowCount: before - rows.length };
  }

  if (normalized.includes("metadata->>'embeddingprovider' as embedding_provider")) {
    const grouped = new Map<string, MockVectorRow[]>();
    for (const row of rows) {
      const key = JSON.stringify({
        tenant_id: row.tenant_id,
        namespace_id: row.namespace_id,
        embedding_provider: row.metadata["embeddingProvider"] ?? null,
        embedding_model: row.embedding_model,
        embedding_config_hash: row.metadata["embeddingConfigHash"] ?? null,
        embedding_index_config_hash: row.metadata["embeddingIndexConfigHash"] ?? null
      });
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    return {
      rows: [...grouped.entries()].map(([key, group]) => {
        const parsed = JSON.parse(key) as Record<string, string | null>;
        return {
          tenant_id: parsed["tenant_id"],
          namespace_id: parsed["namespace_id"],
          embedding_provider: parsed["embedding_provider"],
          embedding_model: parsed["embedding_model"],
          embedding_config_hash: parsed["embedding_config_hash"],
          embedding_index_config_hash: parsed["embedding_index_config_hash"],
          vector_count: String(group.length),
          document_count: String(new Set(group.map((row) => row.document_id)).size)
        };
      }) as T[],
      rowCount: grouped.size
    };
  }

  if (normalized.includes("count(*)")) {
    if (normalized.includes("dimensions <>")) {
      return { rows: [{ count: "0" }] as T[], rowCount: 1 };
    }
    return { rows: [{ count: String(rows.length) }] as T[], rowCount: 1 };
  }

  if (normalized.includes("pg_extension")) {
    return { rows: [{ exists: true }] as T[], rowCount: 1 };
  }

  if (normalized.includes("information_schema.tables")) {
    return { rows: [{ exists: true }] as T[], rowCount: 1 };
  }

  if (normalized.includes("pg_indexes")) {
    const exists = normalized.includes("rag_chunk_vectors_identity_idx")
      ? options.identityIndexExists
      : true;
    return { rows: [{ exists }] as T[], rowCount: 1 };
  }

  if (normalized.includes("<=>") && normalized.includes("limit $8")) {
    const queryVector = parseVectorLiteral(String(params[0]));
    const tenantId = String(params[1]);
    const namespaceId = String(params[2]);
    const dimensions = Number(params[3]);
    const embeddingModel = params[4] === null ? undefined : String(params[4]);
    const embeddingProvider = params[5] === null ? undefined : String(params[5]);
    const embeddingConfigHash = params[6] === null ? undefined : String(params[6]);
    const limit = Number(params[7]);
    const scored = rows
      .filter(
        (row) =>
          row.tenant_id === tenantId &&
          row.namespace_id === namespaceId &&
          row.dimensions === dimensions &&
          (embeddingModel === undefined || row.embedding_model === embeddingModel) &&
          (embeddingProvider === undefined ||
            row.metadata["embeddingProvider"] === embeddingProvider) &&
          (embeddingConfigHash === undefined ||
            row.metadata["embeddingConfigHash"] === embeddingConfigHash)
      )
      .map((row) => ({
        ...row,
        score: cosineSimilarity(queryVector, parseVectorLiteral(row.vector))
      }))
      .sort((first, second) => second.score - first.score)
      .slice(0, limit);
    return { rows: scored as T[], rowCount: scored.length };
  }

  return { rows: rows as T[], rowCount: rows.length };
}

function parseVectorLiteral(value: string): readonly number[] {
  return value
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .filter(Boolean)
    .map((part) => Number(part.trim()));
}
