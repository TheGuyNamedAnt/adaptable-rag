import type { Pool, PoolClient, PoolConfig } from "pg";
import pg from "pg";

import type { ChunkingPolicy } from "../chunking/chunk-policy.js";
import { DEFAULT_CHUNKING_POLICY } from "../chunking/chunk-policy.js";
import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import { evaluateAccess } from "../security/access-control.js";
import type {
  FtsDeleteChunksForDocumentRequest,
  FtsIndexStore,
  FtsIndexWriter,
  FtsSearchRequest,
  FtsSearchResult,
  FtsWriteChunksRequest,
  FtsWriteChunksResult
} from "../storage/keyword-index.js";
import type { ChunkStore } from "./chunk-store.js";
import type { DocumentStore } from "./document-store.js";
import { isValidIndexFilter } from "./index-filter.js";
import type {
  IndexCapabilities,
  IndexChunkDeleteResult,
  IndexChunkOptions,
  IndexDocumentDeleteResult,
  IndexDocumentOptions,
  IndexedChunk,
  IndexedDocument,
  IndexFilter,
  IndexOperationResult,
  IndexSnapshot,
  IndexStats
} from "./index-types.js";
import { validateChunksForIndex, validateDocumentForIndex } from "./index-validation.js";

export interface PostgresRagIndexOptions {
  readonly connectionString?: string;
  readonly pool?: Pool;
  readonly poolConfig?: PoolConfig;
  readonly schema?: string;
  readonly now?: () => string;
  readonly chunkingPolicy?: ChunkingPolicy;
}

export interface PostgresRagIndexReadinessCheck {
  readonly status: "passed" | "failed";
  readonly checks: readonly {
    readonly id: string;
    readonly status: "passed" | "failed";
    readonly message: string;
  }[];
}

export type PostgresFtsSearchRequest = FtsSearchRequest;
export type PostgresFtsSearchResult = FtsSearchResult;

type Queryable = Pick<Pool | PoolClient, "query">;

const DEFAULT_SCHEMA = "rag_core";

export class PostgresRagIndex implements DocumentStore, ChunkStore, FtsIndexStore, FtsIndexWriter {
  readonly capabilities: IndexCapabilities = {
    storageKind: "postgres",
    durable: true,
    enforcesAccessFilters: true,
    supportsKeywordScan: false,
    supportsVectorSearch: true,
    supportsHybridSearch: true
  };

  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly schema: string;
  private readonly now: () => string;
  private readonly chunkingPolicy: ChunkingPolicy;

  constructor(options: PostgresRagIndexOptions = {}) {
    if (!options.pool && !options.connectionString && !options.poolConfig) {
      throw new Error("PostgresRagIndex requires pool, connectionString, or poolConfig.");
    }

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
    this.now = options.now ?? (() => new Date().toISOString());
    this.chunkingPolicy = options.chunkingPolicy ?? DEFAULT_CHUNKING_POLICY;
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async addDocument(
    document: RagDocument,
    options: IndexDocumentOptions = {}
  ): Promise<IndexOperationResult> {
    const validation = validateDocumentForIndex(document);
    if (!validation.valid) {
      throw new Error(
        formatValidationError("Document rejected by index validation", validation.errors)
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await this.addDocumentWithClient(client, document, options);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteDocument(
    documentId: string,
    filter: IndexFilter
  ): Promise<IndexDocumentDeleteResult> {
    if (!isValidIndexFilter(filter)) {
      return {
        accepted: false,
        documentId,
        deletedDocumentCount: 0,
        message: "Document delete requires a valid tenant, namespace, and principal filter."
      };
    }

    const indexed = await this.getDocument(documentId, filter);
    if (!indexed) {
      return {
        accepted: false,
        documentId,
        deletedDocumentCount: 0,
        message: "Document was not found or did not pass the delete filter."
      };
    }

    const result = await this.pool.query(
      `delete from ${this.q("documents")} where id = $1 and tenant_id = $2 and namespace_id = $3`,
      [documentId, filter.tenantId, filter.namespaceId]
    );

    return {
      accepted: (result.rowCount ?? 0) > 0,
      documentId,
      deletedDocumentCount: result.rowCount ?? 0,
      message: (result.rowCount ?? 0) > 0 ? "Document deleted." : "Document was not deleted."
    };
  }

  async getDocument(documentId: string, filter: IndexFilter): Promise<IndexedDocument | undefined> {
    if (!isValidIndexFilter(filter)) {
      return undefined;
    }

    const rows = await this.selectDocuments(
      { ...filter, documentIds: [documentId], limit: 1 },
      this.pool
    );
    return rows[0];
  }

  async hasDocument(documentId: string, filter: IndexFilter): Promise<boolean> {
    return (await this.getDocument(documentId, filter)) !== undefined;
  }

  async findDocuments(filter: IndexFilter): Promise<readonly IndexedDocument[]> {
    if (!isValidIndexFilter(filter)) {
      return [];
    }

    return this.selectDocuments(filter, this.pool);
  }

  listDocuments(filter: IndexFilter): Promise<readonly IndexedDocument[]> {
    return this.findDocuments(filter);
  }

  async addChunks(
    documentId: string,
    chunks: readonly RagChunk[],
    options: IndexChunkOptions = {}
  ): Promise<readonly IndexOperationResult[]> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const document = await this.getStoredDocument(documentId, client);
      const overwriteMode = options.overwriteMode ?? "reject";
      const existingChunkIds = await this.existingChunkIds(documentId, overwriteMode, client);
      const validation = validateChunksForIndex(
        document?.document,
        chunks,
        existingChunkIds,
        this.chunkingPolicy
      );

      if (!validation.valid) {
        throw new Error(
          formatValidationError("Chunks rejected by index validation", validation.errors)
        );
      }

      if (overwriteMode === "replace") {
        await client.query(`delete from ${this.q("chunks")} where document_id = $1`, [documentId]);
      }

      const indexedAt = options.indexedAt ?? this.now();
      const results: IndexOperationResult[] = [];
      for (const chunk of chunks) {
        const existing = await this.getStoredChunk(chunk.id, client);
        await client.query(
          `insert into ${this.q("chunks")} (
            id, document_id, tenant_id, namespace_id, source_id, source_kind, trust_tier,
            safety_flags, access_tags, chunk, indexed_at, updated_at, fts
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8::text[], $9::text[], $10::jsonb, $11, $12,
            setweight(to_tsvector('english', coalesce($13, '')), 'A') ||
            setweight(to_tsvector('english', coalesce($14, '')), 'B') ||
            setweight(to_tsvector('english', coalesce($15, '')), 'C')
          )
          on conflict (id) do update set
            document_id = excluded.document_id,
            tenant_id = excluded.tenant_id,
            namespace_id = excluded.namespace_id,
            source_id = excluded.source_id,
            source_kind = excluded.source_kind,
            trust_tier = excluded.trust_tier,
            safety_flags = excluded.safety_flags,
            access_tags = excluded.access_tags,
            chunk = excluded.chunk,
            updated_at = excluded.updated_at,
            fts = excluded.fts`,
          [
            chunk.id,
            chunk.documentId,
            chunk.accessScope.tenantId,
            chunk.namespaceId,
            chunk.provenance.sourceId,
            chunk.provenance.sourceKind,
            chunk.provenance.trustTier,
            chunk.safetyFlags,
            chunk.accessScope.tags ?? [],
            JSON.stringify(chunk),
            existing?.indexedAt ?? indexedAt,
            existing ? indexedAt : null,
            chunk.provenance.title,
            chunk.citation.title,
            chunk.text
          ]
        );
        results.push({
          accepted: true,
          id: chunk.id,
          message: existing ? "Chunk replaced." : "Chunk indexed."
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

  async deleteChunksForDocument(
    documentId: string,
    filter: IndexFilter
  ): Promise<IndexChunkDeleteResult> {
    if (!isValidIndexFilter(filter)) {
      return {
        accepted: false,
        documentId,
        deletedChunkCount: 0,
        message: "Chunk delete requires a valid tenant, namespace, and principal filter."
      };
    }

    const allowed = await this.findChunks({ ...filter, documentIds: [documentId] });
    if (allowed.length === 0) {
      return {
        accepted: false,
        documentId,
        deletedChunkCount: 0,
        message: "No chunks were found or allowed for document."
      };
    }

    const result = await this.pool.query(
      `delete from ${this.q("chunks")} where id = any($1::text[])`,
      [allowed.map((indexed) => indexed.chunk.id)]
    );

    return {
      accepted: (result.rowCount ?? 0) > 0,
      documentId,
      deletedChunkCount: result.rowCount ?? 0,
      message:
        (result.rowCount ?? 0) > 0 ? "Chunks deleted for document." : "No chunks were deleted."
    };
  }

  async getChunk(chunkId: string, filter: IndexFilter): Promise<IndexedChunk | undefined> {
    if (!isValidIndexFilter(filter)) {
      return undefined;
    }

    const rows = await this.selectChunks({ ...filter, chunkIds: [chunkId], limit: 1 }, this.pool);
    return rows[0];
  }

  async hasChunk(chunkId: string, filter: IndexFilter): Promise<boolean> {
    return (await this.getChunk(chunkId, filter)) !== undefined;
  }

  async findChunks(filter: IndexFilter): Promise<readonly IndexedChunk[]> {
    if (!isValidIndexFilter(filter)) {
      return [];
    }

    return this.selectChunks(filter, this.pool);
  }

  listChunks(filter: IndexFilter): Promise<readonly IndexedChunk[]> {
    return this.findChunks(filter);
  }

  async writeKeywordChunks(request: FtsWriteChunksRequest): Promise<FtsWriteChunksResult> {
    const client = await this.pool.connect();
    const results: IndexOperationResult[] = [];
    try {
      await client.query("begin");
      for (const chunk of request.chunks) {
        const stored = await this.getStoredChunk(chunk.id, client);
        if (!stored) {
          results.push({
            accepted: false,
            id: chunk.id,
            message: "Chunk is not stored; keyword index row was not written."
          });
          continue;
        }
        if (stored.chunk.textHash !== chunk.textHash) {
          results.push({
            accepted: false,
            id: chunk.id,
            message:
              "Chunk text hash does not match stored chunk; keyword index row was not written."
          });
          continue;
        }

        const result = await client.query(
          `update ${this.q("chunks")}
           set fts =
             setweight(to_tsvector('english', coalesce($2, '')), 'A') ||
             setweight(to_tsvector('english', coalesce($3, '')), 'B') ||
             setweight(to_tsvector('english', coalesce($4, '')), 'C'),
             updated_at = coalesce($5, updated_at)
           where id = $1`,
          [
            chunk.id,
            stored.chunk.provenance.title,
            stored.chunk.citation.title,
            stored.chunk.text,
            request.indexedAt ?? null
          ]
        );
        results.push({
          accepted: (result.rowCount ?? 0) > 0,
          id: chunk.id,
          message:
            (result.rowCount ?? 0) > 0
              ? "Keyword index row written."
              : "Keyword index row was not written."
        });
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    const indexedChunkCount = results.filter((result) => result.accepted).length;
    return {
      indexedChunkCount,
      rejectedChunkCount: results.length - indexedChunkCount,
      results
    };
  }

  async deleteKeywordChunksForDocument(
    request: FtsDeleteChunksForDocumentRequest
  ): Promise<IndexChunkDeleteResult> {
    if (!isValidIndexFilter(request.filter)) {
      return {
        accepted: false,
        documentId: request.documentId,
        deletedChunkCount: 0,
        message: "Keyword chunk delete requires a valid tenant, namespace, and principal filter."
      };
    }

    const allowed = await this.findChunks({ ...request.filter, documentIds: [request.documentId] });
    if (allowed.length === 0) {
      return {
        accepted: false,
        documentId: request.documentId,
        deletedChunkCount: 0,
        message: "No chunks were found or allowed for keyword index delete."
      };
    }

    const result = await this.pool.query(
      `update ${this.q("chunks")}
       set fts = to_tsvector('english', '')
       where id = any($1::text[])`,
      [allowed.map((indexed) => indexed.chunk.id)]
    );

    return {
      accepted: (result.rowCount ?? 0) > 0,
      documentId: request.documentId,
      deletedChunkCount: result.rowCount ?? 0,
      message:
        (result.rowCount ?? 0) > 0
          ? "Keyword index rows deleted for document."
          : "No keyword index rows were deleted."
    };
  }

  async searchKeywordChunks(
    request: PostgresFtsSearchRequest
  ): Promise<readonly PostgresFtsSearchResult[]> {
    if (!isValidIndexFilter(request.filter) || request.terms.length === 0) {
      return [];
    }

    const limit = Math.max(1, request.limit);
    const result = await this.pool.query<
      IndexedChunkRow & {
        readonly rank: string | number;
        readonly exact_phrase_match: boolean;
        readonly title_match: boolean;
      }
    >(
      `with query as (
        select websearch_to_tsquery('english', $1) as tsq
      )
      select
        c.chunk,
        c.indexed_at,
        c.updated_at,
        ts_rank_cd(c.fts, query.tsq, 32) as rank,
        lower(c.chunk->>'text') like lower($2) as exact_phrase_match,
        lower(coalesce(c.chunk #>> '{provenance,title}', '') || ' ' || coalesce(c.chunk #>> '{citation,title}', '')) like any($3::text[]) as title_match
      from ${this.q("chunks")} c, query
      where c.tenant_id = $4
        and c.namespace_id = $5
        and query.tsq @@ c.fts
        ${arrayPredicate("c.document_id", request.filter.documentIds, 6)}
        ${arrayPredicate("c.id", request.filter.chunkIds, 7)}
        ${arrayPredicate("c.source_id", request.filter.sourceIds, 8)}
        ${arrayPredicate("c.source_kind", request.filter.sourceKinds, 9)}
        ${arrayPredicate("c.trust_tier", request.filter.trustTiers, 10)}
      order by rank desc, c.document_id asc, (c.chunk->>'index')::integer asc, c.id asc
      limit $11`,
      [
        request.query,
        `%${escapeLike(request.query.toLowerCase())}%`,
        request.terms.map((term) => `%${escapeLike(term)}%`),
        request.filter.tenantId,
        request.filter.namespaceId,
        request.filter.documentIds ?? null,
        request.filter.chunkIds ?? null,
        request.filter.sourceIds ?? null,
        request.filter.sourceKinds ?? null,
        request.filter.trustTiers ?? null,
        Math.min(limit * 4, 5000)
      ]
    );

    const rows = result.rows
      .map((row) => ({
        indexed: indexedChunkFromRow(row),
        rank: Number(row.rank),
        exactPhraseMatch: row.exact_phrase_match,
        titleMatch: row.title_match
      }))
      .filter((row) => chunkMatchesFilter(row.indexed.chunk, request.filter));

    return rows.slice(0, limit).map((row) => {
      const haystack =
        `${row.indexed.chunk.text}\n${row.indexed.chunk.provenance.title}\n${row.indexed.chunk.citation.title}`.toLowerCase();
      const matchedTerms = request.terms.filter((term) => haystack.includes(term));
      return {
        chunk: row.indexed,
        score: roundScore(
          row.rank + (row.exactPhraseMatch ? 0.25 : 0) + (row.titleMatch ? 0.1 : 0)
        ),
        matchedTerms,
        reasons: [
          "postgres_fts_match",
          ...(row.exactPhraseMatch ? ["exact_phrase_match"] : []),
          ...(row.titleMatch ? ["source_title_match"] : [])
        ]
      };
    });
  }

  async stats(): Promise<IndexStats> {
    const [documentCount, chunkCount, namespaceIds, sourceIds, trustTierCounts, flagged] =
      await Promise.all([
        this.pool.query<{ count: string }>(
          `select count(*)::text as count from ${this.q("documents")}`
        ),
        this.pool.query<{ count: string }>(
          `select count(*)::text as count from ${this.q("chunks")}`
        ),
        this.pool.query<{ namespace_id: string }>(
          `select distinct namespace_id from ${this.q("documents")} order by namespace_id`
        ),
        this.pool.query<{ source_id: string }>(
          `select distinct source_id from ${this.q("documents")} order by source_id`
        ),
        this.pool.query<{ trust_tier: string; count: string }>(
          `select trust_tier, count(*)::text as count from ${this.q("chunks")} group by trust_tier`
        ),
        this.pool.query<{ count: string }>(
          `select count(*)::text as count from ${this.q("chunks")} where cardinality(safety_flags) > 0`
        )
      ]);

    return {
      documentCount: Number(documentCount.rows[0]?.count ?? 0),
      chunkCount: Number(chunkCount.rows[0]?.count ?? 0),
      namespaceIds: namespaceIds.rows.map((row) => row.namespace_id),
      sourceIds: sourceIds.rows.map((row) => row.source_id),
      trustTierCounts: Object.fromEntries(
        trustTierCounts.rows.map((row) => [row.trust_tier, Number(row.count)])
      ),
      flaggedChunkCount: Number(flagged.rows[0]?.count ?? 0)
    };
  }

  async readinessCheck(): Promise<PostgresRagIndexReadinessCheck> {
    const checks: PostgresRagIndexReadinessCheck["checks"][number][] = [];
    for (const tableName of ["documents", "chunks", "chunk_vectors"]) {
      const table = await this.pool.query<{ exists: boolean }>(
        `select exists (
          select 1 from information_schema.tables
          where table_schema = $1 and table_name = $2
        ) as exists`,
        [this.schema, tableName]
      );
      checks.push(
        table.rows[0]?.exists
          ? {
              id: `${tableName}_table`,
              status: "passed",
              message: `${tableName} table exists.`
            }
          : {
              id: `${tableName}_table`,
              status: "failed",
              message: `${tableName} table is missing.`
            }
      );
    }

    const ftsIndex = await this.pool.query<{ exists: boolean }>(
      `select exists (
        select 1 from pg_indexes
        where schemaname = $1
          and tablename = 'chunks'
          and lower(indexdef) like '% using gin %'
          and lower(indexdef) like '%fts%'
      ) as exists`,
      [this.schema]
    );
    checks.push(
      ftsIndex.rows[0]?.exists
        ? {
            id: "chunks_fts_index",
            status: "passed",
            message: "Weighted chunk FTS GIN index exists."
          }
        : {
            id: "chunks_fts_index",
            status: "failed",
            message: "Weighted chunk FTS GIN index is missing."
          }
    );

    return {
      status: checks.some((check) => check.status === "failed") ? "failed" : "passed",
      checks
    };
  }

  async snapshot(): Promise<IndexSnapshot> {
    const [documents, chunks] = await Promise.all([
      this.pool.query<IndexedDocumentRow>(
        `select document, indexed_at, updated_at from ${this.q("documents")} order by id`
      ),
      this.pool.query<IndexedChunkRow>(
        `select chunk, indexed_at, updated_at from ${this.q("chunks")} order by id`
      )
    ]);

    return {
      version: 1,
      documents: documents.rows.map(indexedDocumentFromRow),
      chunks: chunks.rows.map(indexedChunkFromRow)
    };
  }

  private async addDocumentWithClient(
    client: PoolClient,
    document: RagDocument,
    options: IndexDocumentOptions
  ): Promise<IndexOperationResult> {
    const existing = await this.getStoredDocument(document.id, client);
    const overwriteMode = options.overwriteMode ?? "reject";
    if (existing && overwriteMode === "reject") {
      throw new Error(`Document "${document.id}" is already indexed.`);
    }

    if (existing) {
      await client.query(`delete from ${this.q("chunks")} where document_id = $1`, [document.id]);
    }

    const indexedAt = options.indexedAt ?? this.now();
    await client.query(
      `insert into ${this.q("documents")} (
        id, tenant_id, namespace_id, source_id, source_kind, trust_tier,
        access_tags, document, indexed_at, updated_at
      ) values ($1, $2, $3, $4, $5, $6, $7::text[], $8::jsonb, $9, $10)
      on conflict (id) do update set
        tenant_id = excluded.tenant_id,
        namespace_id = excluded.namespace_id,
        source_id = excluded.source_id,
        source_kind = excluded.source_kind,
        trust_tier = excluded.trust_tier,
        access_tags = excluded.access_tags,
        document = excluded.document,
        updated_at = excluded.updated_at`,
      [
        document.id,
        document.accessScope.tenantId,
        document.namespaceId,
        document.provenance.sourceId,
        document.provenance.sourceKind,
        document.provenance.trustTier,
        document.accessScope.tags ?? [],
        JSON.stringify(document),
        existing?.indexedAt ?? indexedAt,
        existing ? indexedAt : null
      ]
    );

    return {
      accepted: true,
      id: document.id,
      message: existing ? "Document replaced." : "Document indexed."
    };
  }

  private async selectDocuments(
    filter: IndexFilter,
    queryable: Queryable
  ): Promise<readonly IndexedDocument[]> {
    const rows = await queryable.query<IndexedDocumentRow>(
      `select document, indexed_at, updated_at from ${this.q("documents")}
       where tenant_id = $1 and namespace_id = $2
       ${arrayPredicate("id", filter.documentIds, 3)}
       ${arrayPredicate("source_id", filter.sourceIds, 4)}
       ${arrayPredicate("source_kind", filter.sourceKinds, 5)}
       ${arrayPredicate("trust_tier", filter.trustTiers, 6)}
       order by id`,
      [
        filter.tenantId,
        filter.namespaceId,
        filter.documentIds ?? null,
        filter.sourceIds ?? null,
        filter.sourceKinds ?? null,
        filter.trustTiers ?? null
      ]
    );
    return applyLimit(
      rows.rows
        .map(indexedDocumentFromRow)
        .filter((indexed) => documentMatchesFilter(indexed.document, filter)),
      filter.limit
    );
  }

  private async selectChunks(
    filter: IndexFilter,
    queryable: Queryable
  ): Promise<readonly IndexedChunk[]> {
    const rows = await queryable.query<IndexedChunkRow>(
      `select chunk, indexed_at, updated_at from ${this.q("chunks")}
       where tenant_id = $1 and namespace_id = $2
       ${arrayPredicate("document_id", filter.documentIds, 3)}
       ${arrayPredicate("id", filter.chunkIds, 4)}
       ${arrayPredicate("source_id", filter.sourceIds, 5)}
       ${arrayPredicate("source_kind", filter.sourceKinds, 6)}
       ${arrayPredicate("trust_tier", filter.trustTiers, 7)}
       order by id`,
      [
        filter.tenantId,
        filter.namespaceId,
        filter.documentIds ?? null,
        filter.chunkIds ?? null,
        filter.sourceIds ?? null,
        filter.sourceKinds ?? null,
        filter.trustTiers ?? null
      ]
    );
    return applyLimit(
      rows.rows
        .map(indexedChunkFromRow)
        .filter((indexed) => chunkMatchesFilter(indexed.chunk, filter)),
      filter.limit
    );
  }

  private async getStoredDocument(
    documentId: string,
    queryable: Queryable
  ): Promise<IndexedDocument | undefined> {
    const result = await queryable.query<IndexedDocumentRow>(
      `select document, indexed_at, updated_at from ${this.q("documents")} where id = $1`,
      [documentId]
    );
    return result.rows[0] === undefined ? undefined : indexedDocumentFromRow(result.rows[0]);
  }

  private async getStoredChunk(
    chunkId: string,
    queryable: Queryable
  ): Promise<IndexedChunk | undefined> {
    const result = await queryable.query<IndexedChunkRow>(
      `select chunk, indexed_at, updated_at from ${this.q("chunks")} where id = $1`,
      [chunkId]
    );
    return result.rows[0] === undefined ? undefined : indexedChunkFromRow(result.rows[0]);
  }

  private async existingChunkIds(
    documentId: string,
    overwriteMode: "reject" | "replace",
    queryable: Queryable
  ): Promise<ReadonlySet<string>> {
    const result = await queryable.query<{ id: string }>(
      overwriteMode === "replace"
        ? `select id from ${this.q("chunks")} where document_id <> $1`
        : `select id from ${this.q("chunks")}`,
      overwriteMode === "replace" ? [documentId] : []
    );
    return new Set(result.rows.map((row) => row.id));
  }

  private q(tableName: string): string {
    return `"${this.schema}"."${assertSafeIdentifier(tableName, "table")}"`;
  }
}

interface IndexedDocumentRow {
  readonly document: RagDocument;
  readonly indexed_at: Date | string;
  readonly updated_at: Date | string | null;
}

interface IndexedChunkRow {
  readonly chunk: RagChunk;
  readonly indexed_at: Date | string;
  readonly updated_at: Date | string | null;
}

function indexedDocumentFromRow(row: IndexedDocumentRow): IndexedDocument {
  return {
    document: row.document,
    indexedAt: dateString(row.indexed_at),
    ...(row.updated_at === null ? {} : { updatedAt: dateString(row.updated_at) })
  };
}

function indexedChunkFromRow(row: IndexedChunkRow): IndexedChunk {
  return {
    chunk: row.chunk,
    indexedAt: dateString(row.indexed_at),
    ...(row.updated_at === null ? {} : { updatedAt: dateString(row.updated_at) })
  };
}

function documentMatchesFilter(document: RagDocument, filter: IndexFilter): boolean {
  if (document.namespaceId !== filter.namespaceId) {
    return false;
  }
  if (filter.tenantId !== filter.principal.tenantId) {
    return false;
  }
  if (document.accessScope.tenantId !== filter.tenantId) {
    return false;
  }
  if (!evaluateAccess(filter.principal, document.accessScope).allowed) {
    return false;
  }
  if (filter.accessTags && !containsAll(document.accessScope.tags ?? [], filter.accessTags)) {
    return false;
  }
  return true;
}

function chunkMatchesFilter(chunk: RagChunk, filter: IndexFilter): boolean {
  if (chunk.namespaceId !== filter.namespaceId) {
    return false;
  }
  if (filter.tenantId !== filter.principal.tenantId) {
    return false;
  }
  if (chunk.accessScope.tenantId !== filter.tenantId) {
    return false;
  }
  if (!evaluateAccess(filter.principal, chunk.accessScope).allowed) {
    return false;
  }
  if (filter.includeSafetyFlags && !matchesAny(chunk.safetyFlags, filter.includeSafetyFlags)) {
    return false;
  }
  if (filter.excludeSafetyFlags && matchesAny(chunk.safetyFlags, filter.excludeSafetyFlags)) {
    return false;
  }
  if (filter.accessTags && !containsAll(chunk.accessScope.tags ?? [], filter.accessTags)) {
    return false;
  }
  return true;
}

function arrayPredicate(
  column: string,
  values: readonly string[] | undefined,
  index: number
): string {
  return values === undefined ? "" : `and ${column} = any($${index}::text[])`;
}

function applyLimit<T>(values: readonly T[], limit: number | undefined): readonly T[] {
  return limit === undefined ? values : values.slice(0, Math.max(0, limit));
}

function matchesAny<T>(values: readonly T[], candidates: readonly T[]): boolean {
  return candidates.some((candidate) => values.includes(candidate));
}

function containsAll<T>(values: readonly T[], candidates: readonly T[]): boolean {
  return candidates.every((candidate) => values.includes(candidate));
}

function dateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}

function assertSafeIdentifier(value: string, label: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Postgres ${label} must be a safe SQL identifier.`);
  }
  return value;
}

function formatValidationError(
  prefix: string,
  errors: readonly { readonly path: string; readonly message: string }[]
): string {
  const details = errors.map((error) => `${error.path}: ${error.message}`).join("\n");
  return `${prefix}:\n${details}`;
}
