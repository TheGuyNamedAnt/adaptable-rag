import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { IndexFilter } from "../indexing/index-types.js";
import type {
  GraphEntityProposal,
  GraphExtractionBatch,
  GraphProposalStatus,
  GraphRelationKind,
  GraphRelationProposal
} from "./graph-types.js";
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
import { InMemoryGraphStore } from "./in-memory-graph-store.js";
import { assertValidGraphExtractionBatch } from "./graph-validation.js";

export interface GraphStoreSnapshot {
  readonly version: 1;
  readonly entities: readonly GraphEntityProposal[];
  readonly relations: readonly GraphRelationProposal[];
}

export interface JsonFileGraphStoreOptions {
  readonly filePath: string;
  readonly autosave?: boolean;
  readonly pretty?: boolean;
}

export class JsonFileGraphStore implements GraphStore {
  private readonly filePath: string;
  private readonly autosave: boolean;
  private readonly pretty: boolean;
  private readonly indexed = new InMemoryGraphStore();

  constructor(options: JsonFileGraphStoreOptions) {
    this.filePath = options.filePath;
    this.autosave = options.autosave ?? true;
    this.pretty = options.pretty ?? false;

    const snapshot = loadSnapshot(options.filePath);
    if (snapshot) {
      this.indexed.addExtractionBatch({
        id: "json_file_graph_store_snapshot",
        namespaceId: snapshot.entities[0]?.namespaceId ?? snapshot.relations[0]?.namespaceId ?? "",
        ontology: {
          id: "snapshot",
          entityKinds: [...new Set(snapshot.entities.map((entity) => entity.kind))],
          relationKinds: [
            ...new Set(snapshot.relations.map((relation) => relation.relationKind))
          ] as readonly GraphRelationKind[],
          requiredEvidenceForRelations: false,
          allowInferredRelations: true
        },
        entities: snapshot.entities,
        relations: snapshot.relations,
        createdAt: new Date(0).toISOString()
      });
    }
  }

  addExtractionBatch(batch: GraphExtractionBatch): GraphStoreWriteResult {
    assertValidGraphExtractionBatch(batch);

    const result = this.indexed.addExtractionBatch(batch);

    this.flushIfNeeded(batch.entities.length > 0 || batch.relations.length > 0);

    return result;
  }

  findEntities(filter: IndexFilter): readonly GraphEntityProposal[] {
    return this.indexed.findEntities(filter);
  }

  queryEntities(query: GraphEntityQuery): readonly GraphEntityProposal[] {
    return this.indexed.queryEntities(query);
  }

  pageEntities(query: GraphEntityPageQuery): GraphEntityPage {
    return this.indexed.pageEntities(query);
  }

  findRelations(query: GraphRelationQuery): readonly GraphRelationProposal[] {
    return this.indexed.findRelations(query);
  }

  pageRelations(query: GraphRelationPageQuery): GraphRelationPage {
    return this.indexed.pageRelations(query);
  }

  updateEntityStatus(id: string, status: GraphProposalStatus): GraphEntityProposal | undefined {
    const updated = this.indexed.updateEntityStatus(id, status);
    this.flushIfNeeded(true);
    return updated;
  }

  updateRelationStatus(id: string, status: GraphProposalStatus): GraphRelationProposal | undefined {
    const updated = this.indexed.updateRelationStatus(id, status);
    this.flushIfNeeded(true);
    return updated;
  }

  updateRelationEndpoints(
    id: string,
    endpoints: {
      readonly sourceEntityId?: string;
      readonly targetEntityId?: string;
    }
  ): GraphRelationProposal | undefined {
    const updated = this.indexed.updateRelationEndpoints(id, endpoints);
    this.flushIfNeeded(true);
    return updated;
  }

  pruneEvidence(request: GraphEvidencePruneRequest): GraphEvidencePruneResult {
    const result = this.indexed.pruneEvidence(request);
    this.flushIfNeeded(result.accepted);
    return result;
  }

  snapshot(): GraphStoreSnapshot {
    return {
      version: 1,
      entities: this.indexed.snapshot().entities,
      relations: this.indexed.snapshot().relations
    };
  }

  flush(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const body = JSON.stringify(this.snapshot(), null, this.pretty ? 2 : 0);
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporaryPath, body, "utf8");
    renameSync(temporaryPath, this.filePath);
  }

  private flushIfNeeded(changed: boolean): void {
    if (changed && this.autosave) {
      this.flush();
    }
  }
}

function loadSnapshot(filePath: string): GraphStoreSnapshot | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  const raw = readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    return undefined;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isSnapshot(parsed)) {
    throw new Error(`Invalid graph store snapshot at "${filePath}".`);
  }

  return parsed;
}

function isSnapshot(value: unknown): value is GraphStoreSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as { version?: unknown; entities?: unknown; relations?: unknown };
  return record.version === 1 && Array.isArray(record.entities) && Array.isArray(record.relations);
}
