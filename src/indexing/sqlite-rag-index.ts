import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { ChunkingPolicy } from "../chunking/chunk-policy.js";
import { DEFAULT_CHUNKING_POLICY } from "../chunking/chunk-policy.js";
import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import { evaluateAccess } from "../security/access-control.js";
import type { StorageMigrationCheck } from "../storage/migration-check.js";
import type { FtsSearchRequest, FtsSearchResult } from "../storage/keyword-index.js";
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

export interface SqliteRagIndexOptions {
  readonly filePath: string;
  readonly createDirectory?: boolean;
  readonly enableWal?: boolean;
  readonly now?: () => string;
  readonly chunkingPolicy?: ChunkingPolicy;
}

export interface SqliteRagIndexReadinessCheck {
  readonly status: "passed" | "failed";
  readonly checks: readonly {
    readonly id: string;
    readonly status: "passed" | "failed";
    readonly message: string;
  }[];
}

interface DocumentRow {
  readonly document: string;
  readonly indexed_at: string;
  readonly updated_at: string | null;
}

interface ChunkRow {
  readonly chunk: string;
  readonly indexed_at: string;
  readonly updated_at: string | null;
}

interface FtsChunkRow extends ChunkRow {
  readonly rank: number;
}

const require = createRequire(import.meta.url);
const SQLITE_RAG_INDEX_SCHEMA_VERSION = 1;

export class SqliteRagIndex implements DocumentStore, ChunkStore {
  readonly capabilities: IndexCapabilities = {
    storageKind: "sqlite",
    durable: true,
    enforcesAccessFilters: true,
    supportsKeywordScan: false,
    supportsVectorSearch: false,
    supportsHybridSearch: false
  };

  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly chunkingPolicy: ChunkingPolicy;

  constructor(options: SqliteRagIndexOptions) {
    const { DatabaseSync } = loadNodeSqlite();
    if (options.createDirectory ?? true) {
      mkdirSync(path.dirname(options.filePath), { recursive: true });
    }
    this.db = new DatabaseSync(options.filePath);
    this.now = options.now ?? (() => new Date().toISOString());
    this.chunkingPolicy = options.chunkingPolicy ?? DEFAULT_CHUNKING_POLICY;
    this.configure(options);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  addDocument(document: RagDocument, options: IndexDocumentOptions = {}): IndexOperationResult {
    const validation = validateDocumentForIndex(document);
    if (!validation.valid) {
      throw new Error(
        formatValidationError("Document rejected by index validation", validation.errors)
      );
    }

    const existing = this.getStoredDocument(document.id);
    const overwriteMode = options.overwriteMode ?? "reject";
    if (existing && overwriteMode === "reject") {
      throw new Error(`Document "${document.id}" is already indexed.`);
    }

    const indexedAt = options.indexedAt ?? this.now();
    this.transaction(() => {
      if (existing) {
        this.deleteStoredChunksForDocument(document.id);
      }
      this.db
        .prepare(
          `INSERT INTO documents (
            id, tenant_id, namespace_id, source_id, source_kind, trust_tier,
            access_tags_json, document_json, indexed_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            tenant_id = excluded.tenant_id,
            namespace_id = excluded.namespace_id,
            source_id = excluded.source_id,
            source_kind = excluded.source_kind,
            trust_tier = excluded.trust_tier,
            access_tags_json = excluded.access_tags_json,
            document_json = excluded.document_json,
            updated_at = excluded.updated_at`
        )
        .run(
          document.id,
          document.accessScope.tenantId,
          document.namespaceId,
          document.provenance.sourceId,
          document.provenance.sourceKind,
          document.provenance.trustTier,
          JSON.stringify(document.accessScope.tags ?? []),
          JSON.stringify(document),
          existing?.indexedAt ?? indexedAt,
          existing ? indexedAt : null
        );
    });

    return {
      accepted: true,
      id: document.id,
      message: existing ? "Document replaced." : "Document indexed."
    };
  }

  deleteDocument(documentId: string, filter: IndexFilter): IndexDocumentDeleteResult {
    if (!isValidIndexFilter(filter)) {
      return {
        accepted: false,
        documentId,
        deletedDocumentCount: 0,
        message: "Document delete requires a valid tenant, namespace, and principal filter."
      };
    }
    const indexed = this.getDocument(documentId, filter);
    if (!indexed) {
      return {
        accepted: false,
        documentId,
        deletedDocumentCount: 0,
        message: "Document was not found or did not pass the delete filter."
      };
    }

    const result = this.db
      .prepare("DELETE FROM documents WHERE id = ? AND tenant_id = ? AND namespace_id = ?")
      .run(documentId, filter.tenantId, filter.namespaceId);
    const deletedDocumentCount = Number(result.changes ?? 0);
    return {
      accepted: deletedDocumentCount > 0,
      documentId,
      deletedDocumentCount,
      message: deletedDocumentCount > 0 ? "Document deleted." : "Document was not deleted."
    };
  }

  getDocument(documentId: string, filter: IndexFilter): IndexedDocument | undefined {
    if (!isValidIndexFilter(filter)) {
      return undefined;
    }
    return this.selectDocuments({ ...filter, documentIds: [documentId], limit: 1 })[0];
  }

  hasDocument(documentId: string, filter: IndexFilter): boolean {
    return this.getDocument(documentId, filter) !== undefined;
  }

  findDocuments(filter: IndexFilter): readonly IndexedDocument[] {
    if (!isValidIndexFilter(filter)) {
      return [];
    }
    return this.selectDocuments(filter);
  }

  listDocuments(filter: IndexFilter): readonly IndexedDocument[] {
    return this.findDocuments(filter);
  }

  addChunks(
    documentId: string,
    chunks: readonly RagChunk[],
    options: IndexChunkOptions = {}
  ): readonly IndexOperationResult[] {
    const document = this.getStoredDocument(documentId)?.document;
    const overwriteMode = options.overwriteMode ?? "reject";
    const validation = validateChunksForIndex(
      document,
      chunks,
      this.existingChunkIds(documentId, overwriteMode),
      this.chunkingPolicy
    );
    if (!validation.valid) {
      throw new Error(
        formatValidationError("Chunks rejected by index validation", validation.errors)
      );
    }

    const indexedAt = options.indexedAt ?? this.now();
    const results: IndexOperationResult[] = [];
    this.transaction(() => {
      if (overwriteMode === "replace") {
        this.deleteStoredChunksForDocument(documentId);
      }

      for (const chunk of chunks) {
        const existing = this.getStoredChunk(chunk.id);
        this.db
          .prepare(
            `INSERT INTO chunks (
              id, document_id, tenant_id, namespace_id, source_id, source_kind, trust_tier,
              safety_flags_json, access_tags_json, chunk_json, indexed_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              document_id = excluded.document_id,
              tenant_id = excluded.tenant_id,
              namespace_id = excluded.namespace_id,
              source_id = excluded.source_id,
              source_kind = excluded.source_kind,
              trust_tier = excluded.trust_tier,
              safety_flags_json = excluded.safety_flags_json,
              access_tags_json = excluded.access_tags_json,
              chunk_json = excluded.chunk_json,
              updated_at = excluded.updated_at`
          )
          .run(
            chunk.id,
            chunk.documentId,
            chunk.accessScope.tenantId,
            chunk.namespaceId,
            chunk.provenance.sourceId,
            chunk.provenance.sourceKind,
            chunk.provenance.trustTier,
            JSON.stringify(chunk.safetyFlags),
            JSON.stringify(chunk.accessScope.tags ?? []),
            JSON.stringify(chunk),
            existing?.indexedAt ?? indexedAt,
            existing ? indexedAt : null
          );
        this.upsertFtsChunk(chunk);
        results.push({
          accepted: true,
          id: chunk.id,
          message: existing ? "Chunk replaced." : "Chunk indexed."
        });
      }
    });
    return results;
  }

  deleteChunksForDocument(documentId: string, filter: IndexFilter): IndexChunkDeleteResult {
    if (!isValidIndexFilter(filter)) {
      return {
        accepted: false,
        documentId,
        deletedChunkCount: 0,
        message: "Chunk delete requires a valid tenant, namespace, and principal filter."
      };
    }
    const allowed = this.findChunks({ ...filter, documentIds: [documentId] });
    if (allowed.length === 0) {
      return {
        accepted: false,
        documentId,
        deletedChunkCount: 0,
        message: "No chunks were found or allowed for document."
      };
    }

    this.transaction(() => {
      for (const indexed of allowed) {
        this.db.prepare("DELETE FROM chunk_fts WHERE chunk_id = ?").run(indexed.chunk.id);
        this.db.prepare("DELETE FROM chunks WHERE id = ?").run(indexed.chunk.id);
      }
    });
    return {
      accepted: true,
      documentId,
      deletedChunkCount: allowed.length,
      message: "Chunks deleted for document."
    };
  }

  getChunk(chunkId: string, filter: IndexFilter): IndexedChunk | undefined {
    if (!isValidIndexFilter(filter)) {
      return undefined;
    }
    return this.selectChunks({ ...filter, chunkIds: [chunkId], limit: 1 })[0];
  }

  hasChunk(chunkId: string, filter: IndexFilter): boolean {
    return this.getChunk(chunkId, filter) !== undefined;
  }

  findChunks(filter: IndexFilter): readonly IndexedChunk[] {
    if (!isValidIndexFilter(filter)) {
      return [];
    }
    return this.selectChunks(filter);
  }

  listChunks(filter: IndexFilter): readonly IndexedChunk[] {
    return this.findChunks(filter);
  }

  searchKeywordChunks(request: FtsSearchRequest): readonly FtsSearchResult[] {
    if (!isValidIndexFilter(request.filter) || request.terms.length === 0) {
      return [];
    }
    const ftsQuery = sqliteFtsQuery(request.terms);
    if (ftsQuery === "") {
      return [];
    }

    const rows = this.db
      .prepare(
        `SELECT c.chunk_json AS chunk, c.indexed_at, c.updated_at, bm25(chunk_fts, 4.0, 2.0, 1.0) AS rank
         FROM chunk_fts
         JOIN chunks c ON c.id = chunk_fts.chunk_id
         WHERE chunk_fts MATCH ?
           AND c.tenant_id = ?
           AND c.namespace_id = ?
         ORDER BY rank ASC, c.document_id ASC, c.id ASC
         LIMIT ?`
      )
      .all(
        ftsQuery,
        request.filter.tenantId,
        request.filter.namespaceId,
        Math.min(Math.max(1, request.limit) * 4, 5000)
      ) as unknown as FtsChunkRow[];
    const matches = rows
      .map((row) => ({ indexed: indexedChunkFromRow(row), rank: Number(row.rank) }))
      .filter((row) => chunkMatchesFilter(row.indexed.chunk, request.filter));

    return matches.slice(0, request.limit).map((row) => {
      const haystack =
        `${row.indexed.chunk.text}\n${row.indexed.chunk.provenance.title}\n${row.indexed.chunk.citation.title}`.toLowerCase();
      const matchedTerms = request.terms.filter((term) => haystack.includes(term));
      const phrase = request.query.toLowerCase();
      const exactPhraseMatch = phrase.length > 0 && haystack.includes(phrase);
      return {
        chunk: row.indexed,
        score: roundScore(-row.rank + (exactPhraseMatch ? 0.25 : 0)),
        matchedTerms,
        reasons: ["sqlite_fts_match", ...(exactPhraseMatch ? ["exact_phrase_match"] : [])]
      };
    });
  }

  stats(): IndexStats {
    const documents = this.db
      .prepare("SELECT document_json AS document, indexed_at, updated_at FROM documents")
      .all() as unknown as DocumentRow[];
    const chunks = this.db
      .prepare("SELECT chunk_json AS chunk, indexed_at, updated_at FROM chunks")
      .all() as unknown as ChunkRow[];
    const parsedDocuments = documents
      .map(indexedDocumentFromRow)
      .map((indexed) => indexed.document);
    const parsedChunks = chunks.map(indexedChunkFromRow).map((indexed) => indexed.chunk);
    const trustTierCounts = parsedChunks.reduce<Record<string, number>>((counts, chunk) => {
      counts[chunk.provenance.trustTier] = (counts[chunk.provenance.trustTier] ?? 0) + 1;
      return counts;
    }, {});
    return {
      documentCount: parsedDocuments.length,
      chunkCount: parsedChunks.length,
      namespaceIds: unique(parsedDocuments.map((document) => document.namespaceId)),
      sourceIds: unique(parsedDocuments.map((document) => document.provenance.sourceId)),
      trustTierCounts,
      flaggedChunkCount: parsedChunks.filter((chunk) => chunk.safetyFlags.length > 0).length
    };
  }

  snapshot(): IndexSnapshot {
    const documents = this.db
      .prepare(
        "SELECT document_json AS document, indexed_at, updated_at FROM documents ORDER BY id"
      )
      .all() as unknown as DocumentRow[];
    const chunks = this.db
      .prepare("SELECT chunk_json AS chunk, indexed_at, updated_at FROM chunks ORDER BY id")
      .all() as unknown as ChunkRow[];
    return {
      version: 1,
      documents: documents.map(indexedDocumentFromRow),
      chunks: chunks.map(indexedChunkFromRow)
    };
  }

  readinessCheck(): SqliteRagIndexReadinessCheck {
    const checks = this.migrationCheck().checks.map((check) => ({
      id: check.id,
      status: check.status,
      message: check.message
    }));
    return {
      status: checks.some((check) => check.status === "failed") ? "failed" : "passed",
      checks
    };
  }

  migrationCheck(): StorageMigrationCheck {
    const userVersion = Number(
      (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
    );
    const checks: StorageMigrationCheck["checks"] = [
      userVersion === SQLITE_RAG_INDEX_SCHEMA_VERSION
        ? {
            id: "schema_version",
            status: "passed",
            message: "SQLite RAG index schema version is current.",
            expectedVersion: SQLITE_RAG_INDEX_SCHEMA_VERSION,
            actualVersion: userVersion
          }
        : {
            id: "schema_version",
            status: "failed",
            message: "SQLite RAG index schema version is not current.",
            expectedVersion: SQLITE_RAG_INDEX_SCHEMA_VERSION,
            actualVersion: userVersion
          },
      ...["documents", "chunks", "chunk_fts"].map((tableName) =>
        this.tableExists(tableName)
          ? {
              id: `${tableName}_table`,
              status: "passed" as const,
              message: `${tableName} table exists.`
            }
          : {
              id: `${tableName}_table`,
              status: "failed" as const,
              message: `${tableName} table is missing.`
            }
      )
    ];
    return {
      status: checks.some((check) => check.status === "failed") ? "failed" : "passed",
      storageKind: "sqlite",
      schemaVersion: userVersion,
      checks
    };
  }

  private configure(options: SqliteRagIndexOptions): void {
    this.db.exec("PRAGMA foreign_keys = ON");
    if (options.enableWal ?? true) {
      this.db.exec("PRAGMA journal_mode = WAL");
    }
  }

  private migrate(): void {
    const version = Number(
      (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
    );
    if (version > SQLITE_RAG_INDEX_SCHEMA_VERSION) {
      throw new Error(
        `SQLite RAG index schema version ${version} is newer than supported version ${SQLITE_RAG_INDEX_SCHEMA_VERSION}.`
      );
    }
    if (version === 0) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          namespace_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          trust_tier TEXT NOT NULL,
          access_tags_json TEXT NOT NULL,
          document_json TEXT NOT NULL,
          indexed_at TEXT NOT NULL,
          updated_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS chunks (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          tenant_id TEXT NOT NULL,
          namespace_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          trust_tier TEXT NOT NULL,
          safety_flags_json TEXT NOT NULL,
          access_tags_json TEXT NOT NULL,
          chunk_json TEXT NOT NULL,
          indexed_at TEXT NOT NULL,
          updated_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
          chunk_id UNINDEXED,
          title,
          citation_title,
          body,
          tokenize = 'porter unicode61'
        );
        CREATE INDEX IF NOT EXISTS rag_sqlite_documents_scope_idx ON documents (tenant_id, namespace_id);
        CREATE INDEX IF NOT EXISTS rag_sqlite_documents_source_idx ON documents (tenant_id, namespace_id, source_id);
        CREATE INDEX IF NOT EXISTS rag_sqlite_chunks_scope_idx ON chunks (tenant_id, namespace_id);
        CREATE INDEX IF NOT EXISTS rag_sqlite_chunks_document_idx ON chunks (document_id);
        CREATE INDEX IF NOT EXISTS rag_sqlite_chunks_source_idx ON chunks (tenant_id, namespace_id, source_id);
        CREATE INDEX IF NOT EXISTS rag_sqlite_chunks_trust_idx ON chunks (tenant_id, namespace_id, trust_tier);
        PRAGMA user_version = ${SQLITE_RAG_INDEX_SCHEMA_VERSION};
      `);
    }
  }

  private selectDocuments(filter: IndexFilter): readonly IndexedDocument[] {
    const rows = this.db
      .prepare(
        `SELECT document_json AS document, indexed_at, updated_at
         FROM documents
         WHERE tenant_id = ? AND namespace_id = ?
         ORDER BY id`
      )
      .all(filter.tenantId, filter.namespaceId) as unknown as DocumentRow[];
    return applyLimit(
      rows
        .map(indexedDocumentFromRow)
        .filter((indexed) => documentMatchesFilter(indexed.document, filter)),
      filter.limit
    );
  }

  private selectChunks(filter: IndexFilter): readonly IndexedChunk[] {
    const rows = this.db
      .prepare(
        `SELECT chunk_json AS chunk, indexed_at, updated_at
         FROM chunks
         WHERE tenant_id = ? AND namespace_id = ?
         ORDER BY document_id ASC, id ASC`
      )
      .all(filter.tenantId, filter.namespaceId) as unknown as ChunkRow[];
    return applyLimit(
      rows.map(indexedChunkFromRow).filter((indexed) => chunkMatchesFilter(indexed.chunk, filter)),
      filter.limit
    );
  }

  private getStoredDocument(documentId: string): IndexedDocument | undefined {
    const row = this.db
      .prepare(
        "SELECT document_json AS document, indexed_at, updated_at FROM documents WHERE id = ?"
      )
      .get(documentId) as DocumentRow | undefined;
    return row === undefined ? undefined : indexedDocumentFromRow(row);
  }

  private getStoredChunk(chunkId: string): IndexedChunk | undefined {
    const row = this.db
      .prepare("SELECT chunk_json AS chunk, indexed_at, updated_at FROM chunks WHERE id = ?")
      .get(chunkId) as ChunkRow | undefined;
    return row === undefined ? undefined : indexedChunkFromRow(row);
  }

  private existingChunkIds(
    documentId: string,
    overwriteMode: "reject" | "replace"
  ): ReadonlySet<string> {
    const rows = this.db
      .prepare(
        overwriteMode === "replace"
          ? "SELECT id FROM chunks WHERE document_id <> ?"
          : "SELECT id FROM chunks"
      )
      .all(...(overwriteMode === "replace" ? [documentId] : [])) as { readonly id: string }[];
    return new Set(rows.map((row) => row.id));
  }

  private deleteStoredChunksForDocument(documentId: string): void {
    this.db
      .prepare(
        "DELETE FROM chunk_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)"
      )
      .run(documentId);
    this.db.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId);
  }

  private upsertFtsChunk(chunk: RagChunk): void {
    this.db.prepare("DELETE FROM chunk_fts WHERE chunk_id = ?").run(chunk.id);
    this.db
      .prepare("INSERT INTO chunk_fts (chunk_id, title, citation_title, body) VALUES (?, ?, ?, ?)")
      .run(chunk.id, chunk.provenance.title, chunk.citation.title, chunk.text);
  }

  private tableExists(tableName: string): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE name = ? AND type IN ('table', 'virtual')")
      .get(tableName) as { readonly name: string } | undefined;
    return row !== undefined;
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function indexedDocumentFromRow(row: DocumentRow): IndexedDocument {
  return {
    document: JSON.parse(row.document) as RagDocument,
    indexedAt: row.indexed_at,
    ...(row.updated_at === null ? {} : { updatedAt: row.updated_at })
  };
}

function indexedChunkFromRow(row: ChunkRow): IndexedChunk {
  return {
    chunk: JSON.parse(row.chunk) as RagChunk,
    indexedAt: row.indexed_at,
    ...(row.updated_at === null ? {} : { updatedAt: row.updated_at })
  };
}

function documentMatchesFilter(document: RagDocument, filter: IndexFilter): boolean {
  if (document.namespaceId !== filter.namespaceId) return false;
  if (filter.tenantId !== filter.principal.tenantId) return false;
  if (document.accessScope.tenantId !== filter.tenantId) return false;
  if (!evaluateAccess(filter.principal, document.accessScope).allowed) return false;
  if (filter.documentIds && !filter.documentIds.includes(document.id)) return false;
  if (filter.sourceIds && !filter.sourceIds.includes(document.provenance.sourceId)) return false;
  if (filter.sourceKinds && !filter.sourceKinds.includes(document.provenance.sourceKind))
    return false;
  if (filter.trustTiers && !filter.trustTiers.includes(document.provenance.trustTier)) return false;
  if (filter.accessTags && !containsAll(document.accessScope.tags ?? [], filter.accessTags))
    return false;
  return true;
}

function chunkMatchesFilter(chunk: RagChunk, filter: IndexFilter): boolean {
  if (chunk.namespaceId !== filter.namespaceId) return false;
  if (filter.tenantId !== filter.principal.tenantId) return false;
  if (chunk.accessScope.tenantId !== filter.tenantId) return false;
  if (!evaluateAccess(filter.principal, chunk.accessScope).allowed) return false;
  if (filter.documentIds && !filter.documentIds.includes(chunk.documentId)) return false;
  if (filter.chunkIds && !filter.chunkIds.includes(chunk.id)) return false;
  if (filter.sourceIds && !filter.sourceIds.includes(chunk.provenance.sourceId)) return false;
  if (filter.sourceKinds && !filter.sourceKinds.includes(chunk.provenance.sourceKind)) return false;
  if (filter.trustTiers && !filter.trustTiers.includes(chunk.provenance.trustTier)) return false;
  if (filter.includeSafetyFlags && !matchesAny(chunk.safetyFlags, filter.includeSafetyFlags))
    return false;
  if (filter.excludeSafetyFlags && matchesAny(chunk.safetyFlags, filter.excludeSafetyFlags))
    return false;
  if (filter.accessTags && !containsAll(chunk.accessScope.tags ?? [], filter.accessTags))
    return false;
  return true;
}

function sqliteFtsQuery(terms: readonly string[]): string {
  return terms
    .map((term) => term.replace(/"/g, "").trim())
    .filter((term) => /^[\p{L}\p{N}_-]+$/u.test(term))
    .map((term) => `"${term}"*`)
    .join(" OR ");
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

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}

function formatValidationError(
  prefix: string,
  errors: readonly { readonly path: string; readonly message: string }[]
): string {
  const details = errors.map((error) => `${error.path}: ${error.message}`).join("\n");
  return `${prefix}:\n${details}`;
}

function loadNodeSqlite(): { readonly DatabaseSync: typeof DatabaseSync } {
  try {
    return require("node:sqlite") as { readonly DatabaseSync: typeof DatabaseSync };
  } catch {
    throw new Error(
      `SqliteRagIndex requires a Node.js runtime with node:sqlite support. Current runtime: ${process.version}.`
    );
  }
}
