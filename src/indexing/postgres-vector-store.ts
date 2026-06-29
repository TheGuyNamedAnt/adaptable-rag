import type { Pool, PoolClient, PoolConfig } from "pg";
import pg from "pg";

import type { ChunkStore } from "./chunk-store.js";
import type { IndexOperationResult } from "./index-types.js";
import { isValidIndexFilter } from "./index-filter.js";
import type { VectorGenerationInventoryEntry } from "./vector-generation-lifecycle.js";
import {
  POSTGRES_VECTOR_SCALE_CAPABILITIES,
  type VectorGenerationInventoryProvider
} from "./scale-capabilities.js";
import {
  type ChunkVector,
  type IndexedChunkVector,
  type VectorIndexOptions,
  type VectorSearchCandidate,
  type VectorSearchRejection,
  type VectorSearchRequest,
  type VectorSearchResult,
  type VectorSnapshot,
  type VectorStore,
  type VectorStoreCapabilities,
  validateChunkVector,
  validateVectorSearchRequest
} from "./vector-store.js";

export interface PostgresVectorStoreOptions {
  readonly chunkStore: ChunkStore;
  readonly connectionString?: string;
  readonly pool?: Pool;
  readonly poolConfig?: PoolConfig;
  readonly schema?: string;
  readonly dimensions?: number;
  readonly now?: () => string;
}

export interface PostgresVectorReadinessCheck {
  readonly status: "passed" | "failed";
  readonly checks: readonly {
    readonly id: string;
    readonly status: "passed" | "failed";
    readonly message: string;
  }[];
}

type Queryable = Pick<Pool | PoolClient, "query">;

const DEFAULT_SCHEMA = "rag_core";

export class PostgresVectorStore implements VectorStore, VectorGenerationInventoryProvider {
  readonly capabilities: VectorStoreCapabilities;

  private readonly chunkStore: ChunkStore;
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly schema: string;
  private readonly dimensions: number | undefined;
  private readonly now: () => string;

  constructor(options: PostgresVectorStoreOptions) {
    if (!options.pool && !options.connectionString && !options.poolConfig) {
      throw new Error("PostgresVectorStore requires pool, connectionString, or poolConfig.");
    }

    this.chunkStore = options.chunkStore;
    this.pool =
      options.pool ??
      new pg.Pool({
        ...(options.poolConfig ?? {}),
        ...(options.connectionString === undefined
          ? {}
          : { connectionString: options.connectionString })
      });
    this.ownsPool = options.pool === undefined;
    this.schema = assertSafeIdentifier(options.schema ?? DEFAULT_SCHEMA, "schema");
    this.dimensions = options.dimensions;
    this.now = options.now ?? (() => new Date().toISOString());
    this.capabilities = {
      storageKind: "postgres",
      durable: true,
      enforcesAccessFilters: true,
      supportsCosineSimilarity: true,
      scale: POSTGRES_VECTOR_SCALE_CAPABILITIES,
      ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions })
    };

    if (
      this.dimensions !== undefined &&
      (!Number.isInteger(this.dimensions) || this.dimensions < 1)
    ) {
      throw new Error("Postgres vector store dimensions must be a positive integer.");
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async addChunkVectors(
    vectors: readonly ChunkVector[],
    options: VectorIndexOptions = {}
  ): Promise<readonly IndexOperationResult[]> {
    const seenIds = new Set<string>();
    for (const vector of vectors) {
      validateChunkVector(vector, this.dimensions, seenIds);
      seenIds.add(vector.id);
    }

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const results: IndexOperationResult[] = [];
      const indexedAt = options.indexedAt ?? this.now();
      const overwriteMode = options.overwriteMode ?? "reject";

      for (const vector of vectors) {
        const existing = await this.getStoredVector(vector.id, client);
        if (existing && overwriteMode === "reject") {
          throw new Error(`Chunk vector "${vector.id}" is already indexed.`);
        }

        await client.query(
          `insert into ${this.q("chunk_vectors")} (
            id, chunk_id, document_id, tenant_id, namespace_id, text_hash, embedding_model,
            dimensions, vector, metadata, embedded_at, indexed_at, updated_at
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10::jsonb, $11, $12, $13)
          on conflict (id) do update set
            chunk_id = excluded.chunk_id,
            document_id = excluded.document_id,
            tenant_id = excluded.tenant_id,
            namespace_id = excluded.namespace_id,
            text_hash = excluded.text_hash,
            embedding_model = excluded.embedding_model,
            dimensions = excluded.dimensions,
            vector = excluded.vector,
            metadata = excluded.metadata,
            embedded_at = excluded.embedded_at,
            updated_at = excluded.updated_at`,
          [
            vector.id,
            vector.chunkId,
            vector.documentId,
            vector.tenantId,
            vector.namespaceId,
            vector.textHash,
            vector.embeddingModel,
            vector.dimensions,
            vectorLiteral(vector.vector),
            JSON.stringify(metadataForStorage(vector)),
            vector.embeddedAt,
            existing?.indexedAt ?? indexedAt,
            existing ? indexedAt : null
          ]
        );
        results.push({
          accepted: true,
          id: vector.id,
          message: existing ? "Chunk vector replaced." : "Chunk vector indexed."
        });
      }

      await client.query("commit");
      return results;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteVectorsForDocument(documentId: string): Promise<number> {
    if (!documentId.trim()) {
      throw new Error("Postgres vector delete requires a documentId.");
    }

    const result = await this.pool.query(
      `delete from ${this.q("chunk_vectors")} where document_id = $1`,
      [documentId]
    );
    return result.rowCount ?? 0;
  }

  async findNearestVectors(request: VectorSearchRequest): Promise<VectorSearchResult> {
    validateVectorSearchRequest(request, this.dimensions);

    if (!isValidIndexFilter(request.filter)) {
      return {
        candidates: [],
        rejected: [
          {
            code: "invalid_filter",
            reason:
              "Postgres vector search requires a valid tenant, namespace, and principal filter."
          }
        ],
        candidatePoolSize: 0
      };
    }

    const queryLimit = request.candidatePoolLimit ?? request.topK;
    const maxLimit = Math.min(Math.max(queryLimit, request.topK), 5000);
    const result = await this.pool.query<PostgresVectorRow & { score: string | number }>(
      `select
        id, chunk_id, document_id, tenant_id, namespace_id, text_hash, embedding_model,
        dimensions, vector::text as vector, metadata, embedded_at, indexed_at, updated_at,
        (1 - (${this.vectorExpression()} <=> ${this.queryVectorExpression("$1")})) as score
      from ${this.q("chunk_vectors")}
      where tenant_id = $2
        and namespace_id = $3
        and dimensions = $4
        and ($5::text is null or embedding_model = $5)
        and ($6::text is null or metadata->>'embeddingProvider' = $6)
        and ($7::text is null or metadata->>'embeddingConfigHash' = $7)
      order by ${this.vectorExpression()} <=> ${this.queryVectorExpression("$1")} asc, id asc
      limit $8`,
      [
        vectorLiteral(request.vector),
        request.filter.tenantId,
        request.filter.namespaceId,
        request.vector.length,
        request.embeddingModel ?? null,
        request.embeddingProvider ?? null,
        request.embeddingConfigHash ?? null,
        maxLimit
      ]
    );

    const rejected: VectorSearchRejection[] = [];
    const scored: VectorSearchCandidate[] = [];
    const minScore = request.minScore ?? Number.NEGATIVE_INFINITY;

    for (const row of result.rows) {
      const indexed = indexedVectorFromRow(row);
      const chunk = (await this.chunkStore.getChunk(indexed.vector.chunkId, request.filter))?.chunk;
      if (!chunk) {
        if (request.includeRejected) {
          rejected.push({
            chunkId: indexed.vector.chunkId,
            code: "access_denied_or_missing_chunk",
            reason: "Postgres vector match did not pass the chunk access filter."
          });
        }
        continue;
      }

      if (
        chunk.documentId !== indexed.vector.documentId ||
        chunk.accessScope.tenantId !== indexed.vector.tenantId ||
        chunk.namespaceId !== indexed.vector.namespaceId ||
        chunk.textHash !== indexed.vector.textHash
      ) {
        if (request.includeRejected) {
          rejected.push({
            chunkId: indexed.vector.chunkId,
            code: "stale_vector",
            reason: "Postgres vector metadata no longer matches the indexed chunk."
          });
        }
        continue;
      }

      if (indexed.vector.vector.length !== request.vector.length) {
        if (request.includeRejected) {
          rejected.push({
            chunkId: indexed.vector.chunkId,
            code: "vector_dimension_mismatch",
            reason: "Postgres vector dimensions do not match the query vector."
          });
        }
        continue;
      }

      const score = roundScore(Number(row.score));
      if (score < minScore) {
        if (request.includeRejected) {
          rejected.push({
            chunkId: indexed.vector.chunkId,
            code: "no_vector_match",
            reason: "Postgres vector score was below the configured minimum."
          });
        }
        continue;
      }

      scored.push({
        chunk,
        vector: indexed.vector,
        score,
        rank: 0,
        reasons: ["pgvector_cosine_similarity"]
      });
    }

    return {
      candidates: scored.slice(0, request.topK).map((candidate, index) => ({
        ...candidate,
        rank: index + 1
      })),
      rejected,
      candidatePoolSize: scored.length
    };
  }

  async snapshot(): Promise<VectorSnapshot> {
    const result = await this.pool.query<PostgresVectorRow>(
      `select
        id, chunk_id, document_id, tenant_id, namespace_id, text_hash, embedding_model,
        dimensions, vector::text as vector, metadata, embedded_at, indexed_at, updated_at
      from ${this.q("chunk_vectors")}
      order by id`
    );
    return {
      version: 1,
      vectors: result.rows.map(indexedVectorFromRow)
    };
  }

  async vectorCount(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `select count(*)::text as count from ${this.q("chunk_vectors")}`
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async vectorGenerationInventory(): Promise<readonly VectorGenerationInventoryEntry[]> {
    const result = await this.pool.query<{
      tenant_id: string;
      namespace_id: string;
      embedding_provider: string | null;
      embedding_model: string;
      embedding_config_hash: string | null;
      embedding_index_config_hash: string | null;
      vector_count: string;
      document_count: string;
    }>(
      `select
        tenant_id,
        namespace_id,
        metadata->>'embeddingProvider' as embedding_provider,
        embedding_model,
        metadata->>'embeddingConfigHash' as embedding_config_hash,
        metadata->>'embeddingIndexConfigHash' as embedding_index_config_hash,
        count(*)::text as vector_count,
        count(distinct document_id)::text as document_count
      from ${this.q("chunk_vectors")}
      group by
        tenant_id,
        namespace_id,
        metadata->>'embeddingProvider',
        embedding_model,
        metadata->>'embeddingConfigHash',
        metadata->>'embeddingIndexConfigHash'
      order by tenant_id, namespace_id, embedding_provider, embedding_model, embedding_config_hash`
    );

    return result.rows.map((row) => ({
      tenantId: row.tenant_id,
      namespaceId: row.namespace_id,
      embeddingProvider: row.embedding_provider ?? "unknown",
      embeddingModel: row.embedding_model,
      embeddingConfigHash: row.embedding_config_hash ?? "unknown",
      ...(row.embedding_index_config_hash === null
        ? {}
        : { embeddingIndexConfigHash: row.embedding_index_config_hash }),
      vectorCount: Number(row.vector_count),
      documentCount: Number(row.document_count)
    }));
  }

  async readinessCheck(): Promise<PostgresVectorReadinessCheck> {
    const checks: PostgresVectorReadinessCheck["checks"][number][] = [];
    const extension = await this.pool.query<{ exists: boolean }>(
      "select exists (select 1 from pg_extension where extname = 'vector') as exists"
    );
    checks.push(
      extension.rows[0]?.exists
        ? {
            id: "pgvector_extension",
            status: "passed",
            message: "pgvector extension is installed."
          }
        : {
            id: "pgvector_extension",
            status: "failed",
            message: "pgvector extension is missing."
          }
    );

    const table = await this.pool.query<{ exists: boolean }>(
      `select exists (
        select 1 from information_schema.tables
        where table_schema = $1 and table_name = 'chunk_vectors'
      ) as exists`,
      [this.schema]
    );
    checks.push(
      table.rows[0]?.exists
        ? {
            id: "chunk_vectors_table",
            status: "passed",
            message: "chunk_vectors table exists."
          }
        : {
            id: "chunk_vectors_table",
            status: "failed",
            message: "chunk_vectors table is missing."
          }
    );

    if (this.dimensions !== undefined) {
      const mismatches = await this.pool.query<{ count: string }>(
        `select count(*)::text as count from ${this.q("chunk_vectors")} where dimensions <> $1`,
        [this.dimensions]
      );
      const mismatchCount = Number(mismatches.rows[0]?.count ?? 0);
      checks.push(
        mismatchCount === 0
          ? {
              id: "vector_dimensions",
              status: "passed",
              message: `All stored vectors match configured dimensions ${this.dimensions}.`
            }
          : {
              id: "vector_dimensions",
              status: "failed",
              message: `${mismatchCount} stored vector(s) do not match configured dimensions ${this.dimensions}.`
            }
      );

      const identityIndex = await this.pool.query<{ exists: boolean }>(
        `select exists (
          select 1 from pg_indexes
          where schemaname = $1
            and tablename = 'chunk_vectors'
            and indexname = 'rag_chunk_vectors_identity_idx'
        ) as exists`,
        [this.schema]
      );
      checks.push(
        identityIndex.rows[0]?.exists
          ? {
              id: "vector_identity_filter_index",
              status: "passed",
              message: "Vector identity filter index exists."
            }
          : {
              id: "vector_identity_filter_index",
              status: "failed",
              message:
                "Missing vector identity filter index. Apply the core Postgres storage migration before production traffic."
            }
      );

      const annIndex = await this.pool.query<{ exists: boolean }>(
        `select exists (
          select 1 from pg_indexes
          where schemaname = $1
            and tablename = 'chunk_vectors'
            and (lower(indexdef) like '% using hnsw %' or lower(indexdef) like '% using ivfflat %')
            and indexdef like $2
        ) as exists`,
        [this.schema, `%vector(${this.dimensions})%`]
      );
      checks.push(
        annIndex.rows[0]?.exists
          ? {
              id: "vector_ann_index",
              status: "passed",
              message: `Dimension-specific pgvector ANN index exists for ${this.dimensions}.`
            }
          : {
              id: "vector_ann_index",
              status: "failed",
              message: `Missing dimension-specific pgvector ANN index for ${this.dimensions}. Apply a vector index migration before production traffic.`
            }
      );
    }

    return {
      status: checks.some((check) => check.status === "failed") ? "failed" : "passed",
      checks
    };
  }

  private async getStoredVector(
    vectorId: string,
    queryable: Queryable
  ): Promise<IndexedChunkVector | undefined> {
    const result = await queryable.query<PostgresVectorRow>(
      `select
        id, chunk_id, document_id, tenant_id, namespace_id, text_hash, embedding_model,
        dimensions, vector::text as vector, metadata, embedded_at, indexed_at, updated_at
      from ${this.q("chunk_vectors")}
      where id = $1`,
      [vectorId]
    );
    return result.rows[0] === undefined ? undefined : indexedVectorFromRow(result.rows[0]);
  }

  private q(tableName: string): string {
    return `"${this.schema}"."${assertSafeIdentifier(tableName, "table")}"`;
  }

  private vectorExpression(): string {
    return this.dimensions === undefined ? "vector" : `vector::vector(${this.dimensions})`;
  }

  private queryVectorExpression(parameter: string): string {
    return this.dimensions === undefined
      ? `${parameter}::vector`
      : `${parameter}::vector(${this.dimensions})`;
  }
}

interface PostgresVectorRow {
  readonly id: string;
  readonly chunk_id: string;
  readonly document_id: string;
  readonly tenant_id: string;
  readonly namespace_id: string;
  readonly text_hash: string;
  readonly embedding_model: string;
  readonly dimensions: number;
  readonly vector: string;
  readonly metadata: Record<string, string | number | boolean>;
  readonly embedded_at: Date | string;
  readonly indexed_at: Date | string;
  readonly updated_at: Date | string | null;
}

function indexedVectorFromRow(row: PostgresVectorRow): IndexedChunkVector {
  const embeddingProvider = stringMetadata(row.metadata, "embeddingProvider");
  const embeddingConfigHash = stringMetadata(row.metadata, "embeddingConfigHash");

  return {
    vector: {
      id: row.id,
      chunkId: row.chunk_id,
      documentId: row.document_id,
      tenantId: row.tenant_id,
      namespaceId: row.namespace_id,
      textHash: row.text_hash,
      embeddingModel: row.embedding_model,
      ...(embeddingProvider === undefined ? {} : { embeddingProvider }),
      ...(embeddingConfigHash === undefined ? {} : { embeddingConfigHash }),
      dimensions: row.dimensions,
      vector: parseVectorLiteral(row.vector),
      embeddedAt: dateString(row.embedded_at),
      metadata: row.metadata
    },
    indexedAt: dateString(row.indexed_at),
    ...(row.updated_at === null ? {} : { updatedAt: dateString(row.updated_at) })
  };
}

function metadataForStorage(vector: ChunkVector): Record<string, string | number | boolean> {
  return {
    ...(vector.metadata ?? {}),
    ...(vector.embeddingProvider === undefined
      ? {}
      : { embeddingProvider: vector.embeddingProvider }),
    ...(vector.embeddingConfigHash === undefined
      ? {}
      : { embeddingConfigHash: vector.embeddingConfigHash })
  };
}

function stringMetadata(
  metadata: Readonly<Record<string, string | number | boolean>>,
  key: string
): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

function parseVectorLiteral(value: string): readonly number[] {
  const trimmed = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!trimmed) {
    return [];
  }
  return trimmed.split(",").map((part) => Number(part.trim()));
}

function dateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}

function assertSafeIdentifier(value: string, label: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Postgres vector ${label} must be a safe SQL identifier.`);
  }
  return value;
}
