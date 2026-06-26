import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { assertValidIndexFilter } from "../indexing/index-filter.js";
import type { IndexFilter } from "../indexing/index-types.js";
import type { AccessScope } from "../security/access-scope.js";
import { evaluateAccess } from "../security/access-control.js";
import type {
  GraphEntityProposal,
  GraphExtractionBatch,
  GraphFactStrength,
  GraphProposalStatus,
  GraphRelationKind,
  GraphRelationProposal,
  GraphVerificationStatus
} from "./graph-types.js";
import { assertValidGraphExtractionBatch } from "./graph-validation.js";
import type {
  GraphEntityPage,
  GraphEntityPageQuery,
  GraphEntityQuery,
  GraphEvidencePruneRequest,
  GraphEvidencePruneResult,
  GraphRelationPage,
  GraphRelationPageQuery,
  GraphRelationQuery,
  GraphStore,
  GraphStoreWriteResult
} from "./in-memory-graph-store.js";
import {
  decodeGraphPageCursor,
  encodeGraphPageCursor,
  type DecodedGraphPageCursor
} from "./graph-pagination.js";

export interface SqliteGraphStoreOptions {
  readonly filePath: string;
  readonly createDirectory?: boolean;
  readonly enableWal?: boolean;
}

export interface SqliteGraphStoreSnapshot {
  readonly entities: readonly GraphEntityProposal[];
  readonly relations: readonly GraphRelationProposal[];
}

interface EntityRow {
  readonly id: string;
  readonly namespace_id: string;
  readonly kind: string;
  readonly name: string;
  readonly normalized_name: string;
  readonly aliases_json: string;
  readonly confidence: number;
  readonly trust_tier: string;
  readonly access_scope_json: string;
  readonly evidence_json: string;
  readonly status: GraphProposalStatus;
  readonly created_at: string;
  readonly metadata_json: string | null;
}

interface RelationRow {
  readonly id: string;
  readonly namespace_id: string;
  readonly relation_kind: GraphRelationKind;
  readonly source_entity_id: string;
  readonly target_entity_id: string;
  readonly fact_strength: GraphFactStrength;
  readonly confidence: number;
  readonly trust_tier: string;
  readonly access_scope_json: string;
  readonly evidence_json: string;
  readonly temporal_json: string;
  readonly verification_status: GraphVerificationStatus;
  readonly status: GraphProposalStatus;
  readonly created_at: string;
  readonly metadata_json: string | null;
}

type SqlValue = string | number | null;
type AccessRequirementKind = "user" | "team" | "role" | "tag";

interface SqliteEntitySelectInput {
  readonly query: GraphEntityQuery;
  readonly limit: number;
  readonly order: "rowid" | "cursor";
  cursor?: DecodedGraphPageCursor;
}

interface SqliteRelationSelectInput {
  readonly query: GraphRelationQuery;
  readonly limit: number;
  readonly order: "rowid" | "cursor";
  cursor?: DecodedGraphPageCursor;
}

const require = createRequire(import.meta.url);

export class SqliteGraphStore implements GraphStore {
  private readonly db: DatabaseSync;

  constructor(options: SqliteGraphStoreOptions) {
    const { DatabaseSync } = loadNodeSqlite();

    if (options.createDirectory ?? true) {
      mkdirSync(path.dirname(options.filePath), { recursive: true });
    }

    this.db = new DatabaseSync(options.filePath);
    this.configure(options);
    this.migrate();
  }

  addExtractionBatch(batch: GraphExtractionBatch): GraphStoreWriteResult {
    assertValidGraphExtractionBatch(batch);

    this.transaction(() => {
      for (const entity of batch.entities) {
        this.upsertEntity(entity);
      }

      for (const relation of batch.relations) {
        this.upsertRelation(relation);
      }
    });

    return {
      accepted: true,
      entityCount: batch.entities.length,
      relationCount: batch.relations.length
    };
  }

  findEntities(filter: IndexFilter): readonly GraphEntityProposal[] {
    return this.queryEntities({ filter });
  }

  queryEntities(query: GraphEntityQuery): readonly GraphEntityProposal[] {
    assertValidIndexFilter(query.filter);
    const limit = Math.max(0, query.limit ?? query.filter.limit ?? 100);
    if (limit === 0) {
      return [];
    }

    const rows = this.selectEntityRows({ query, limit, order: "rowid" });
    return rows
      .map(rowToEntity)
      .filter((entity) => evaluateAccess(query.filter.principal, entity.accessScope).allowed)
      .slice(0, limit);
  }

  pageEntities(query: GraphEntityPageQuery): GraphEntityPage {
    assertValidIndexFilter(query.filter);
    const limit = Math.max(0, query.limit ?? query.filter.limit ?? 100);
    if (limit === 0) {
      return { entities: [] };
    }

    const cursor =
      query.cursor === undefined ? undefined : decodeGraphPageCursor(query.cursor, "entity");
    const selectInput: SqliteEntitySelectInput = {
      query,
      limit: limit + 1,
      order: "cursor"
    };
    if (cursor !== undefined) {
      selectInput.cursor = cursor;
    }

    const rows = this.selectEntityRows(selectInput);
    const matches = rows
      .map(rowToEntity)
      .filter((entity) => evaluateAccess(query.filter.principal, entity.accessScope).allowed);
    const entities = matches.slice(0, limit);
    const lastEntity = entities.at(-1);

    return {
      entities,
      ...(matches.length > limit && lastEntity !== undefined
        ? { nextCursor: encodeGraphPageCursor("entity", lastEntity) }
        : {})
    };
  }

  findRelations(query: GraphRelationQuery): readonly GraphRelationProposal[] {
    assertValidIndexFilter(query.filter);
    const limit = Math.max(0, query.limit ?? query.filter.limit ?? 100);
    if (limit === 0) {
      return [];
    }

    const rows = this.selectRelationRows({ query, limit, order: "rowid" });
    return rows
      .map(rowToRelation)
      .filter((relation) => evaluateAccess(query.filter.principal, relation.accessScope).allowed)
      .slice(0, limit);
  }

  pageRelations(query: GraphRelationPageQuery): GraphRelationPage {
    assertValidIndexFilter(query.filter);
    const limit = Math.max(0, query.limit ?? query.filter.limit ?? 100);
    if (limit === 0) {
      return { relations: [] };
    }

    const cursor =
      query.cursor === undefined ? undefined : decodeGraphPageCursor(query.cursor, "relation");
    const selectInput: SqliteRelationSelectInput = {
      query,
      limit: limit + 1,
      order: "cursor"
    };
    if (cursor !== undefined) {
      selectInput.cursor = cursor;
    }

    const rows = this.selectRelationRows(selectInput);
    const matches = rows
      .map(rowToRelation)
      .filter((relation) => evaluateAccess(query.filter.principal, relation.accessScope).allowed);
    const relations = matches.slice(0, limit);
    const lastRelation = relations.at(-1);

    return {
      relations,
      ...(matches.length > limit && lastRelation !== undefined
        ? { nextCursor: encodeGraphPageCursor("relation", lastRelation) }
        : {})
    };
  }

  updateEntityStatus(id: string, status: GraphProposalStatus): GraphEntityProposal | undefined {
    this.db.prepare("UPDATE graph_entities SET status = ? WHERE id = ?").run(status, id);

    const row = this.db.prepare("SELECT * FROM graph_entities WHERE id = ?").get(id) as
      | EntityRow
      | undefined;
    return row === undefined ? undefined : rowToEntity(row);
  }

  updateRelationStatus(id: string, status: GraphProposalStatus): GraphRelationProposal | undefined {
    this.db.prepare("UPDATE graph_relations SET status = ? WHERE id = ?").run(status, id);

    const row = this.db.prepare("SELECT * FROM graph_relations WHERE id = ?").get(id) as
      | RelationRow
      | undefined;
    return row === undefined ? undefined : rowToRelation(row);
  }

  updateRelationEndpoints(
    id: string,
    endpoints: {
      readonly sourceEntityId?: string;
      readonly targetEntityId?: string;
    }
  ): GraphRelationProposal | undefined {
    const existing = this.db.prepare("SELECT * FROM graph_relations WHERE id = ?").get(id) as
      | RelationRow
      | undefined;
    if (existing === undefined) {
      return undefined;
    }

    const sourceEntityId = endpoints.sourceEntityId ?? existing.source_entity_id;
    const targetEntityId = endpoints.targetEntityId ?? existing.target_entity_id;

    this.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE graph_relations
          SET source_entity_id = ?, target_entity_id = ?
          WHERE id = ?
        `
        )
        .run(sourceEntityId, targetEntityId, id);
      this.reindexRelationEndpoints(id, sourceEntityId, targetEntityId);
    });

    const updated = this.db.prepare("SELECT * FROM graph_relations WHERE id = ?").get(id) as
      | RelationRow
      | undefined;
    return updated === undefined ? undefined : rowToRelation(updated);
  }

  pruneEvidence(request: GraphEvidencePruneRequest): GraphEvidencePruneResult {
    assertValidIndexFilter(request.filter);
    assertEvidencePruneSelector(request);

    let prunedEntityCount = 0;
    let prunedRelationCount = 0;
    let supersededEntityCount = 0;
    let supersededRelationCount = 0;
    let removedEvidenceAnchorCount = 0;

    this.transaction(() => {
      for (const row of this.selectPruneEntityRows(request)) {
        const entity = rowToEntity(row);
        const pruned = pruneEvidenceAnchors(entity.evidence, request);
        if (pruned.removedCount === 0) {
          continue;
        }
        const superseded = pruned.evidence.length === 0;
        this.upsertEntity({
          ...entity,
          evidence: pruned.evidence,
          ...(superseded ? { status: "superseded" } : {})
        });
        prunedEntityCount += 1;
        removedEvidenceAnchorCount += pruned.removedCount;
        if (superseded) {
          supersededEntityCount += 1;
        }
      }

      for (const row of this.selectPruneRelationRows(request)) {
        const relation = rowToRelation(row);
        const pruned = pruneEvidenceAnchors(relation.evidence, request);
        if (pruned.removedCount === 0) {
          continue;
        }
        const superseded = pruned.evidence.length === 0;
        this.upsertRelation({
          ...relation,
          evidence: pruned.evidence,
          ...(superseded ? { status: "superseded" } : {})
        });
        prunedRelationCount += 1;
        removedEvidenceAnchorCount += pruned.removedCount;
        if (superseded) {
          supersededRelationCount += 1;
        }
      }
    });

    return {
      accepted: removedEvidenceAnchorCount > 0,
      prunedEntityCount,
      prunedRelationCount,
      supersededEntityCount,
      supersededRelationCount,
      removedEvidenceAnchorCount
    };
  }

  snapshot(): SqliteGraphStoreSnapshot {
    return {
      entities: (
        this.db.prepare("SELECT * FROM graph_entities ORDER BY id").all() as unknown as EntityRow[]
      ).map(rowToEntity),
      relations: (
        this.db
          .prepare("SELECT * FROM graph_relations ORDER BY id")
          .all() as unknown as RelationRow[]
      ).map(rowToRelation)
    };
  }

  close(): void {
    this.db.close();
  }

  private configure(options: SqliteGraphStoreOptions): void {
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    if ((options.enableWal ?? true) && options.filePath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_entities (
        id TEXT PRIMARY KEY,
        namespace_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        trust_tier TEXT NOT NULL,
        access_scope_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS graph_relations (
        id TEXT PRIMARY KEY,
        namespace_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        relation_kind TEXT NOT NULL,
        source_entity_id TEXT NOT NULL,
        target_entity_id TEXT NOT NULL,
        fact_strength TEXT NOT NULL,
        confidence REAL NOT NULL,
        trust_tier TEXT NOT NULL,
        access_scope_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        temporal_json TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS graph_entity_name_keys (
        namespace_id TEXT NOT NULL,
        name_key TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        PRIMARY KEY (namespace_id, name_key, entity_id)
      );

      CREATE TABLE IF NOT EXISTS graph_relation_entity_index (
        entity_id TEXT NOT NULL,
        relation_id TEXT NOT NULL,
        PRIMARY KEY (entity_id, relation_id)
      );

      CREATE TABLE IF NOT EXISTS graph_evidence_anchors (
        fact_type TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        citation_json TEXT NOT NULL,
        quote_hash TEXT,
        character_start INTEGER,
        character_end INTEGER
      );

      CREATE TABLE IF NOT EXISTS graph_access_requirements (
        fact_type TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        requirement_kind TEXT NOT NULL,
        requirement_value TEXT NOT NULL,
        PRIMARY KEY (fact_type, fact_id, requirement_kind, requirement_value)
      );

      CREATE INDEX IF NOT EXISTS idx_graph_entities_namespace
        ON graph_entities(namespace_id, tenant_id);
      CREATE INDEX IF NOT EXISTS idx_graph_entities_status
        ON graph_entities(namespace_id, status);
      CREATE INDEX IF NOT EXISTS idx_graph_entities_page
        ON graph_entities(namespace_id, tenant_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_graph_entity_name_lookup
        ON graph_entity_name_keys(namespace_id, name_key);
      CREATE INDEX IF NOT EXISTS idx_graph_relations_namespace
        ON graph_relations(namespace_id, tenant_id);
      CREATE INDEX IF NOT EXISTS idx_graph_relations_status
        ON graph_relations(namespace_id, status);
      CREATE INDEX IF NOT EXISTS idx_graph_relations_kind
        ON graph_relations(namespace_id, relation_kind, status);
      CREATE INDEX IF NOT EXISTS idx_graph_relations_page
        ON graph_relations(namespace_id, tenant_id, status, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_graph_relations_entity
        ON graph_relation_entity_index(entity_id, relation_id);
      CREATE INDEX IF NOT EXISTS idx_graph_evidence_fact
        ON graph_evidence_anchors(fact_type, fact_id);
      CREATE INDEX IF NOT EXISTS idx_graph_evidence_chunk
        ON graph_evidence_anchors(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_graph_access_fact
        ON graph_access_requirements(fact_type, fact_id, requirement_kind);
      CREATE INDEX IF NOT EXISTS idx_graph_access_lookup
        ON graph_access_requirements(requirement_kind, requirement_value, fact_type, fact_id);
    `);
  }

  private upsertEntity(entity: GraphEntityProposal): void {
    this.db
      .prepare(
        `
        INSERT OR REPLACE INTO graph_entities (
          id,
          namespace_id,
          tenant_id,
          kind,
          name,
          normalized_name,
          aliases_json,
          confidence,
          trust_tier,
          access_scope_json,
          evidence_json,
          status,
          created_at,
          metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        entity.id,
        entity.namespaceId,
        entity.accessScope.tenantId,
        entity.kind,
        entity.name,
        entity.normalizedName,
        JSON.stringify(entity.aliases ?? []),
        entity.confidence,
        entity.trustTier,
        JSON.stringify(entity.accessScope),
        JSON.stringify(entity.evidence),
        entity.status,
        entity.createdAt,
        entity.metadata === undefined ? null : JSON.stringify(entity.metadata)
      );

    this.db.prepare("DELETE FROM graph_entity_name_keys WHERE entity_id = ?").run(entity.id);
    const insertNameKey = this.db.prepare(
      `
      INSERT OR IGNORE INTO graph_entity_name_keys(namespace_id, name_key, entity_id)
      VALUES (?, ?, ?)
    `
    );
    for (const nameKey of entityNameKeys(entity)) {
      insertNameKey.run(entity.namespaceId, nameKey, entity.id);
    }

    this.replaceEvidence("entity", entity.id, entity.evidence);
    this.replaceAccessRequirements("entity", entity.id, entity.accessScope);
  }

  private upsertRelation(relation: GraphRelationProposal): void {
    this.db
      .prepare(
        `
        INSERT OR REPLACE INTO graph_relations (
          id,
          namespace_id,
          tenant_id,
          relation_kind,
          source_entity_id,
          target_entity_id,
          fact_strength,
          confidence,
          trust_tier,
          access_scope_json,
          evidence_json,
          temporal_json,
          verification_status,
          status,
          created_at,
          metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        relation.id,
        relation.namespaceId,
        relation.accessScope.tenantId,
        relation.relationKind,
        relation.sourceEntityId,
        relation.targetEntityId,
        relation.factStrength,
        relation.confidence,
        relation.trustTier,
        JSON.stringify(relation.accessScope),
        JSON.stringify(relation.evidence),
        JSON.stringify(relation.temporal),
        relation.verificationStatus,
        relation.status,
        relation.createdAt,
        relation.metadata === undefined ? null : JSON.stringify(relation.metadata)
      );

    this.reindexRelationEndpoints(relation.id, relation.sourceEntityId, relation.targetEntityId);
    this.replaceEvidence("relation", relation.id, relation.evidence);
    this.replaceAccessRequirements("relation", relation.id, relation.accessScope);
  }

  private reindexRelationEndpoints(
    relationId: string,
    sourceEntityId: string,
    targetEntityId: string
  ): void {
    this.db
      .prepare("DELETE FROM graph_relation_entity_index WHERE relation_id = ?")
      .run(relationId);
    const insertEndpoint = this.db.prepare(
      `
      INSERT OR IGNORE INTO graph_relation_entity_index(entity_id, relation_id)
      VALUES (?, ?)
    `
    );
    insertEndpoint.run(sourceEntityId, relationId);
    insertEndpoint.run(targetEntityId, relationId);
  }

  private replaceEvidence(
    factType: "entity" | "relation",
    factId: string,
    evidence: GraphEntityProposal["evidence"] | GraphRelationProposal["evidence"]
  ): void {
    this.db
      .prepare("DELETE FROM graph_evidence_anchors WHERE fact_type = ? AND fact_id = ?")
      .run(factType, factId);
    const insertEvidence = this.db.prepare(
      `
      INSERT INTO graph_evidence_anchors (
        fact_type,
        fact_id,
        chunk_id,
        document_id,
        source_id,
        citation_json,
        quote_hash,
        character_start,
        character_end
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    );

    for (const anchor of evidence) {
      insertEvidence.run(
        factType,
        factId,
        anchor.chunkId,
        anchor.documentId,
        anchor.sourceId,
        JSON.stringify(anchor.citation),
        anchor.quoteHash ?? null,
        anchor.characterStart ?? null,
        anchor.characterEnd ?? null
      );
    }
  }

  private replaceAccessRequirements(
    factType: "entity" | "relation",
    factId: string,
    scope: AccessScope
  ): void {
    this.db
      .prepare("DELETE FROM graph_access_requirements WHERE fact_type = ? AND fact_id = ?")
      .run(factType, factId);
    const requirements = accessRequirements(scope);
    if (requirements.length === 0) {
      return;
    }

    const insertRequirement = this.db.prepare(
      `
      INSERT OR IGNORE INTO graph_access_requirements (
        fact_type,
        fact_id,
        requirement_kind,
        requirement_value
      ) VALUES (?, ?, ?, ?)
    `
    );

    for (const requirement of requirements) {
      insertRequirement.run(factType, factId, requirement.kind, requirement.value);
    }
  }

  private selectEntityRows(input: SqliteEntitySelectInput): readonly EntityRow[] {
    const query = input.query;
    const where = ["entity.namespace_id = ?", "entity.tenant_id = ?"];
    const values: SqlValue[] = [query.filter.namespaceId, query.filter.tenantId];
    const accessPredicate = sqlAccessPredicate({
      factType: "entity",
      factIdColumn: "entity.id",
      filter: query.filter
    });
    where.push(accessPredicate.sql);
    values.push(...accessPredicate.values);

    if (query.entityIds !== undefined) {
      if (query.entityIds.length === 0) {
        return [];
      }
      where.push(`entity.id IN (${placeholders(query.entityIds.length)})`);
      values.push(...query.entityIds);
    }

    const entityName = normalizeIndexKey(query.entityName ?? "");
    const joinNameIndex = entityName.length > 0;
    if (joinNameIndex) {
      where.push("name_key.name_key = ?");
      values.push(entityName);
    }

    if (input.cursor !== undefined) {
      where.push("(entity.created_at > ? OR (entity.created_at = ? AND entity.id > ?))");
      values.push(input.cursor.createdAt, input.cursor.createdAt, input.cursor.id);
    }

    values.push(input.limit);
    const rows = this.db
      .prepare(
        `
        SELECT entity.*
        FROM graph_entities entity
        ${
          joinNameIndex
            ? "JOIN graph_entity_name_keys name_key ON name_key.entity_id = entity.id AND name_key.namespace_id = entity.namespace_id"
            : ""
        }
        WHERE ${where.join(" AND ")}
        ORDER BY ${input.order === "cursor" ? "entity.created_at, entity.id" : "entity.rowid"}
        LIMIT ?
      `
      )
      .all(...values) as unknown as EntityRow[];

    return rows;
  }

  private selectRelationRows(input: SqliteRelationSelectInput): readonly RelationRow[] {
    const query = input.query;
    const where = ["relation.namespace_id = ?", "relation.tenant_id = ?"];
    const values: SqlValue[] = [query.filter.namespaceId, query.filter.tenantId];
    const accessPredicate = sqlAccessPredicate({
      factType: "relation",
      factIdColumn: "relation.id",
      filter: query.filter
    });
    where.push(accessPredicate.sql);
    values.push(...accessPredicate.values);

    if (query.includeUnapproved !== true) {
      where.push("relation.status = ?");
      values.push("approved");
    }

    const joinEntityIndex = query.entityId !== undefined;
    if (joinEntityIndex) {
      where.push("edge.entity_id = ?");
      values.push(query.entityId ?? "");
    }

    if (query.relationKinds !== undefined) {
      if (query.relationKinds.length === 0) {
        return [];
      }
      where.push(`relation.relation_kind IN (${placeholders(query.relationKinds.length)})`);
      values.push(...query.relationKinds);
    }

    if (input.cursor !== undefined) {
      where.push("(relation.created_at > ? OR (relation.created_at = ? AND relation.id > ?))");
      values.push(input.cursor.createdAt, input.cursor.createdAt, input.cursor.id);
    }

    values.push(input.limit);
    const rows = this.db
      .prepare(
        `
        SELECT relation.*
        FROM graph_relations relation
        ${
          joinEntityIndex
            ? "JOIN graph_relation_entity_index edge ON edge.relation_id = relation.id"
            : ""
        }
        WHERE ${where.join(" AND ")}
        ORDER BY ${input.order === "cursor" ? "relation.created_at, relation.id" : "relation.rowid"}
        LIMIT ?
      `
      )
      .all(...values) as unknown as RelationRow[];

    return rows;
  }

  private selectPruneEntityRows(request: GraphEvidencePruneRequest): readonly EntityRow[] {
    const where = ["entity.namespace_id = ?", "entity.tenant_id = ?", "evidence.fact_type = ?"];
    const values: SqlValue[] = [request.filter.namespaceId, request.filter.tenantId, "entity"];
    const accessPredicate = sqlAccessPredicate({
      factType: "entity",
      factIdColumn: "entity.id",
      filter: request.filter
    });
    const selector = evidenceSelectorPredicate(request);
    where.push(accessPredicate.sql, selector.sql);
    values.push(...accessPredicate.values, ...selector.values);

    return this.db
      .prepare(
        `
        SELECT DISTINCT entity.*
        FROM graph_entities entity
        JOIN graph_evidence_anchors evidence
          ON evidence.fact_type = 'entity' AND evidence.fact_id = entity.id
        WHERE ${where.join(" AND ")}
        ORDER BY entity.id
      `
      )
      .all(...values) as unknown as EntityRow[];
  }

  private selectPruneRelationRows(request: GraphEvidencePruneRequest): readonly RelationRow[] {
    const where = ["relation.namespace_id = ?", "relation.tenant_id = ?", "evidence.fact_type = ?"];
    const values: SqlValue[] = [request.filter.namespaceId, request.filter.tenantId, "relation"];
    const accessPredicate = sqlAccessPredicate({
      factType: "relation",
      factIdColumn: "relation.id",
      filter: request.filter
    });
    const selector = evidenceSelectorPredicate(request);
    where.push(accessPredicate.sql, selector.sql);
    values.push(...accessPredicate.values, ...selector.values);

    return this.db
      .prepare(
        `
        SELECT DISTINCT relation.*
        FROM graph_relations relation
        JOIN graph_evidence_anchors evidence
          ON evidence.fact_type = 'relation' AND evidence.fact_id = relation.id
        WHERE ${where.join(" AND ")}
        ORDER BY relation.id
      `
      )
      .all(...values) as unknown as RelationRow[];
  }

  private transaction(action: () => void): void {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      action();
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }
}

function rowToEntity(row: EntityRow): GraphEntityProposal {
  const aliases = parseJson<readonly string[]>(row.aliases_json);
  const metadata = optionalJson<Readonly<Record<string, string | number | boolean>>>(
    row.metadata_json
  );

  return {
    id: row.id,
    namespaceId: row.namespace_id,
    kind: row.kind,
    name: row.name,
    normalizedName: row.normalized_name,
    ...(aliases.length === 0 ? {} : { aliases }),
    confidence: row.confidence,
    trustTier: row.trust_tier as GraphEntityProposal["trustTier"],
    accessScope: parseJson<AccessScope>(row.access_scope_json),
    evidence: parseJson<GraphEntityProposal["evidence"]>(row.evidence_json),
    status: row.status,
    createdAt: row.created_at,
    ...(metadata === undefined ? {} : { metadata })
  };
}

function rowToRelation(row: RelationRow): GraphRelationProposal {
  const metadata = optionalJson<Readonly<Record<string, string | number | boolean>>>(
    row.metadata_json
  );

  return {
    id: row.id,
    namespaceId: row.namespace_id,
    relationKind: row.relation_kind,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    factStrength: row.fact_strength,
    confidence: row.confidence,
    trustTier: row.trust_tier as GraphRelationProposal["trustTier"],
    accessScope: parseJson<AccessScope>(row.access_scope_json),
    evidence: parseJson<GraphRelationProposal["evidence"]>(row.evidence_json),
    temporal: parseJson<GraphRelationProposal["temporal"]>(row.temporal_json),
    verificationStatus: row.verification_status,
    status: row.status,
    createdAt: row.created_at,
    ...(metadata === undefined ? {} : { metadata })
  };
}

function entityNameKeys(entity: GraphEntityProposal): readonly string[] {
  const normalized = [entity.name, entity.normalizedName, ...(entity.aliases ?? [])].map(
    normalizeIndexKey
  );
  const tokens = normalized.flatMap((value) => value.split(" ").filter(Boolean));
  return unique([...normalized, ...tokens]);
}

function accessRequirements(
  scope: AccessScope
): readonly { readonly kind: AccessRequirementKind; readonly value: string }[] {
  return [
    ...(scope.userIds ?? []).map((value) => ({ kind: "user" as const, value })),
    ...(scope.teamIds ?? []).map((value) => ({ kind: "team" as const, value })),
    ...(scope.roles ?? []).map((value) => ({ kind: "role" as const, value })),
    ...(scope.tags ?? []).map((value) => ({ kind: "tag" as const, value }))
  ];
}

function sqlAccessPredicate(input: {
  readonly factType: "entity" | "relation";
  readonly factIdColumn: string;
  readonly filter: IndexFilter;
}): { readonly sql: string; readonly values: readonly SqlValue[] } {
  const userPredicate = optionalAnyRequirementPredicate({
    factType: input.factType,
    factIdColumn: input.factIdColumn,
    kind: "user",
    values: [input.filter.principal.userId]
  });
  const teamPredicate = optionalAnyRequirementPredicate({
    factType: input.factType,
    factIdColumn: input.factIdColumn,
    kind: "team",
    values: input.filter.principal.teamIds
  });
  const rolePredicate = optionalAnyRequirementPredicate({
    factType: input.factType,
    factIdColumn: input.factIdColumn,
    kind: "role",
    values: input.filter.principal.roles
  });
  const tagPredicate = requiredAllTagsPredicate({
    factType: input.factType,
    factIdColumn: input.factIdColumn,
    values: input.filter.principal.tags
  });
  const predicates = [userPredicate, teamPredicate, rolePredicate, tagPredicate];

  return {
    sql: predicates.map((predicate) => predicate.sql).join(" AND "),
    values: predicates.flatMap((predicate) => predicate.values)
  };
}

function optionalAnyRequirementPredicate(input: {
  readonly factType: "entity" | "relation";
  readonly factIdColumn: string;
  readonly kind: Exclude<AccessRequirementKind, "tag">;
  readonly values: readonly string[];
}): { readonly sql: string; readonly values: readonly SqlValue[] } {
  const noRequirement = noRequirementPredicate(input);
  if (input.values.length === 0) {
    return noRequirement;
  }

  return {
    sql: `(${noRequirement.sql} OR EXISTS (
      SELECT 1
      FROM graph_access_requirements req
      WHERE req.fact_type = ?
        AND req.fact_id = ${input.factIdColumn}
        AND req.requirement_kind = ?
        AND req.requirement_value IN (${placeholders(input.values.length)})
    ))`,
    values: [...noRequirement.values, input.factType, input.kind, ...input.values]
  };
}

function requiredAllTagsPredicate(input: {
  readonly factType: "entity" | "relation";
  readonly factIdColumn: string;
  readonly values: readonly string[];
}): { readonly sql: string; readonly values: readonly SqlValue[] } {
  if (input.values.length === 0) {
    return noRequirementPredicate({
      factType: input.factType,
      factIdColumn: input.factIdColumn,
      kind: "tag"
    });
  }

  return {
    sql: `NOT EXISTS (
      SELECT 1
      FROM graph_access_requirements req
      WHERE req.fact_type = ?
        AND req.fact_id = ${input.factIdColumn}
        AND req.requirement_kind = ?
        AND req.requirement_value NOT IN (${placeholders(input.values.length)})
    )`,
    values: [input.factType, "tag", ...input.values]
  };
}

function noRequirementPredicate(input: {
  readonly factType: "entity" | "relation";
  readonly factIdColumn: string;
  readonly kind: AccessRequirementKind;
}): { readonly sql: string; readonly values: readonly SqlValue[] } {
  return {
    sql: `NOT EXISTS (
      SELECT 1
      FROM graph_access_requirements req
      WHERE req.fact_type = ?
        AND req.fact_id = ${input.factIdColumn}
        AND req.requirement_kind = ?
    )`,
    values: [input.factType, input.kind]
  };
}

function assertEvidencePruneSelector(request: GraphEvidencePruneRequest): void {
  if (
    hasNonBlankValues(request.documentIds) ||
    hasNonBlankValues(request.chunkIds) ||
    hasNonBlankValues(request.sourceIds)
  ) {
    return;
  }

  throw new Error("Graph evidence prune requires at least one documentId, chunkId, or sourceId.");
}

function hasNonBlankValues(values: readonly string[] | undefined): boolean {
  return values !== undefined && values.some((value) => value.trim().length > 0);
}

function evidenceSelectorPredicate(request: GraphEvidencePruneRequest): {
  readonly sql: string;
  readonly values: readonly SqlValue[];
} {
  const clauses: string[] = [];
  const values: SqlValue[] = [];
  addEvidenceSelectorClause(clauses, values, "evidence.document_id", request.documentIds);
  addEvidenceSelectorClause(clauses, values, "evidence.chunk_id", request.chunkIds);
  addEvidenceSelectorClause(clauses, values, "evidence.source_id", request.sourceIds);
  return {
    sql: `(${clauses.join(" OR ")})`,
    values
  };
}

function addEvidenceSelectorClause(
  clauses: string[],
  values: SqlValue[],
  column: string,
  candidates: readonly string[] | undefined
): void {
  const uniqueCandidates = unique((candidates ?? []).map((value) => value.trim()).filter(Boolean));
  if (uniqueCandidates.length === 0) {
    return;
  }
  clauses.push(`${column} IN (${placeholders(uniqueCandidates.length)})`);
  values.push(...uniqueCandidates);
}

function pruneEvidenceAnchors<
  T extends GraphEntityProposal["evidence"][number] | GraphRelationProposal["evidence"][number]
>(
  evidence: readonly T[],
  request: GraphEvidencePruneRequest
): { readonly evidence: readonly T[]; readonly removedCount: number } {
  const remaining = evidence.filter((anchor) => !evidenceAnchorMatches(anchor, request));
  return {
    evidence: remaining,
    removedCount: evidence.length - remaining.length
  };
}

function evidenceAnchorMatches(
  anchor: GraphEntityProposal["evidence"][number] | GraphRelationProposal["evidence"][number],
  request: GraphEvidencePruneRequest
): boolean {
  return (
    valueMatches(anchor.documentId, request.documentIds) ||
    valueMatches(anchor.chunkId, request.chunkIds) ||
    valueMatches(anchor.sourceId, request.sourceIds)
  );
}

function valueMatches(value: string, candidates: readonly string[] | undefined): boolean {
  return candidates !== undefined && candidates.includes(value);
}

function normalizeIndexKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))];
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function optionalJson<T>(value: string | null): T | undefined {
  if (value === null || value.trim().length === 0) {
    return undefined;
  }
  return parseJson<T>(value);
}

function loadNodeSqlite(): { readonly DatabaseSync: typeof DatabaseSync } {
  try {
    return require("node:sqlite") as { readonly DatabaseSync: typeof DatabaseSync };
  } catch {
    throw new Error(
      `SqliteGraphStore requires a Node.js runtime with node:sqlite support. Current runtime: ${process.version}.`
    );
  }
}
