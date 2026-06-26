import assert from "node:assert/strict";
import test from "node:test";

import type { CorpusRecord } from "../corpus/corpus-record.js";
import { FakeEmbeddingAdapter } from "../embeddings/fake-embedding-adapter.js";
import { FakeVisualEmbeddingAdapter } from "../embeddings/fake-visual-embedding-adapter.js";
import { GraphApprovalRunner } from "../graph/graph-approval.js";
import {
  buildGraphExtractionTrace,
  type GraphExtractionRequest,
  type GraphExtractionResult,
  type GraphExtractor
} from "../graph/graph-extractor.js";
import { GraphIngestionRunner } from "../graph/graph-ingestion.js";
import type { GraphExtractionBatch } from "../graph/graph-types.js";
import { InMemoryGraphStore } from "../graph/in-memory-graph-store.js";
import { ownershipGraphOntology } from "../graph/ownership-ontology.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { InMemoryVectorStore } from "../indexing/vector-store.js";
import { InMemoryVisualVectorStore } from "../indexing/visual-vector-store.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import type { CorpusSourceConfig } from "../profiles/profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import type {
  SourceConnector,
  SourceConnectorSyncRequest,
  SourceConnectorSyncResult
} from "../sync/source-connector.js";
import { InMemorySourceSyncLedgerStore } from "../sync/sync-ledger.js";
import {
  FIXED_NOW,
  makeChunks,
  makeDocument,
  makeIndexFilter,
  TEST_PRINCIPAL
} from "../test-support/fixtures.js";
import { SourceSyncWorkflowRunner } from "./source-sync-workflow.js";

const source: CorpusSourceConfig = {
  id: "curated_docs",
  adapter: "workflow-sync-test",
  description: "Synced source fixture.",
  enabled: true,
  trustTierFloor: "trusted_internal",
  tags: ["curated"]
};
const profile = assertValidProfile({
  ...genericDocsProfile,
  namespaceId: "test-namespace",
  corpusSources: [source]
});

class FixtureSourceConnector implements SourceConnector {
  readonly id = "fixture-workflow-source";
  readonly description = "Fixture source workflow connector.";
  readonly requests: SourceConnectorSyncRequest[] = [];
  private readonly results: SourceConnectorSyncResult[];
  private readonly shouldThrow: boolean;

  constructor(
    results: readonly SourceConnectorSyncResult[],
    options: { readonly shouldThrow?: boolean } = {}
  ) {
    this.results = [...results];
    this.shouldThrow = options.shouldThrow ?? false;
  }

  async sync(request: SourceConnectorSyncRequest): Promise<SourceConnectorSyncResult> {
    this.requests.push(request);
    if (this.shouldThrow) {
      throw new Error("Connector unavailable.");
    }

    const result = this.results.shift();
    if (!result) {
      throw new Error("No fixture sync result configured.");
    }

    return result;
  }
}

test("source sync workflow propagates deletes, ingests changed records, and saves the ledger", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const deletedDocument = makeDocument({
    id: "doc_deleted",
    title: "Deleted source document",
    body: "This document used to exist in the source system."
  });
  index.addDocument(deletedDocument);
  index.addChunks(deletedDocument.id, makeChunks(deletedDocument));
  const ledgerStore = new InMemorySourceSyncLedgerStore();
  const connector = new FixtureSourceConnector([
    {
      sourceId: source.id,
      nextCursor: "cursor_1",
      complete: true,
      items: [
        {
          operation: "delete",
          sourceItemId: "source_item_deleted",
          recordId: deletedDocument.id,
          deletedAt: FIXED_NOW
        },
        {
          operation: "upsert",
          sourceItemId: "source_item_fresh",
          version: "1",
          record: record("fresh", "Fresh source content that should be indexed.")
        }
      ]
    }
  ]);
  const runner = new SourceSyncWorkflowRunner({
    connector,
    ledgerStore,
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await runner.run({
    profile,
    source,
    requestedBy: TEST_PRINCIPAL,
    filter: makeIndexFilter({ sourceIds: [source.id] }),
    mode: "delta",
    runId: "workflow_success",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.ledgerSaved, true);
  assert.equal(result.metrics.syncedRecordCount, 1);
  assert.equal(result.metrics.syncedDeleteCount, 1);
  assert.equal(result.metrics.deletedDocumentCount, 1);
  assert.equal(result.metrics.ingestedDocumentCount, 1);
  assert.equal(index.hasDocument(deletedDocument.id, makeIndexFilter()), false);
  assert.equal(index.hasDocument("doc_fresh", makeIndexFilter()), true);
  const saved = await ledgerStore.load({
    connectorId: connector.id,
    sourceId: source.id,
    namespaceId: profile.namespaceId
  });
  assert.equal(saved?.cursor, "cursor_1");
  assert.deepEqual(
    saved?.entries.map((entry) => [entry.sourceItemId, entry.status, entry.lastAction]),
    [
      ["source_item_deleted", "deleted", "deleted"],
      ["source_item_fresh", "active", "created"]
    ]
  );
});

test("source sync workflow does not save a success ledger when ingestion rejects changed records", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const ledgerStore = new InMemorySourceSyncLedgerStore();
  const connector = new FixtureSourceConnector([
    {
      sourceId: source.id,
      complete: true,
      items: [
        {
          operation: "upsert",
          sourceItemId: "source_item_bad",
          version: "1",
          record: {
            ...record("bad"),
            sourceId: "wrong_source"
          }
        }
      ]
    }
  ]);
  const runner = new SourceSyncWorkflowRunner({
    connector,
    ledgerStore,
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await runner.run({
    profile,
    source,
    requestedBy: TEST_PRINCIPAL,
    runId: "workflow_rejected",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "failed");
  assert.equal(result.ledgerSaved, false);
  assert.equal(result.metrics.rejectedRecordCount, 1);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ["ingest_rejected_records", "ledger_save_skipped"]
  );
  assert.equal(index.hasDocument("doc_bad", makeIndexFilter()), false);
  assert.equal(
    await ledgerStore.load({
      connectorId: connector.id,
      sourceId: source.id,
      namespaceId: profile.namespaceId
    }),
    undefined
  );
});

test("source sync workflow saves failed connector ledgers so retry state is visible", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const ledgerStore = new InMemorySourceSyncLedgerStore();
  const connector = new FixtureSourceConnector([], { shouldThrow: true });
  const runner = new SourceSyncWorkflowRunner({
    connector,
    ledgerStore,
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await runner.run({
    profile,
    source,
    requestedBy: TEST_PRINCIPAL,
    runId: "workflow_connector_failed",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "failed");
  assert.equal(result.ledgerSaved, true);
  assert.equal(result.sync.status, "failed");
  const saved = await ledgerStore.load({
    connectorId: connector.id,
    sourceId: source.id,
    namespaceId: profile.namespaceId
  });
  assert.equal(saved?.status, "failed");
  assert.equal(saved?.entries.length, 0);
});

test("source sync workflow refreshes configured text, visual, and knowledge indexes after ingest", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const vectorStore = new InMemoryVectorStore({ chunkStore: index, dimensions: 16 });
  const visualVectorStore = new InMemoryVisualVectorStore({ chunkStore: index, dimensions: 12 });
  const graphStore = new InMemoryGraphStore();
  const ledgerStore = new InMemorySourceSyncLedgerStore();
  const connector = new FixtureSourceConnector([
    {
      sourceId: source.id,
      complete: true,
      items: [
        {
          operation: "upsert",
          sourceItemId: "source_item_visual_ownership",
          version: "1",
          record: visualOwnershipRecord()
        }
      ]
    }
  ]);
  const runner = new SourceSyncWorkflowRunner({
    connector,
    ledgerStore,
    documentStore: index,
    chunkStore: index,
    vectorStore,
    embeddingAdapter: new FakeEmbeddingAdapter({ dimensions: 16 }),
    visualVectorStore,
    visualEmbeddingAdapter: new FakeVisualEmbeddingAdapter({ dimensions: 12 }),
    graphStore,
    knowledgeIngestion: {
      runner: new GraphIngestionRunner({
        extractor: fakeGraphExtractor(),
        graphStore,
        approvalRunner: new GraphApprovalRunner({ graphStore, now: () => FIXED_NOW }),
        now: () => FIXED_NOW
      }),
      ontology: ownershipGraphOntology,
      approvalFilter: makeIndexFilter()
    },
    now: () => FIXED_NOW
  });

  const result = await runner.run({
    profile,
    source,
    requestedBy: TEST_PRINCIPAL,
    filter: makeIndexFilter({ sourceIds: [source.id] }),
    runId: "workflow_post_ingest",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.ledgerSaved, true);
  assert.equal(result.postIngest?.status, "succeeded");
  assert.equal(result.metrics.indexedVectorCount > 0, true);
  assert.equal(result.metrics.indexedRelationVectorCount, 1);
  assert.equal(result.metrics.indexedVisualVectorCount > 0, true);
  assert.equal(result.metrics.knowledgeEntityCount, 2);
  assert.equal(result.metrics.knowledgeRelationCount, 1);
  assert.equal(vectorStore.vectorCount() >= result.metrics.indexedVectorCount, true);
  assert.equal(visualVectorStore.visualVectorCount(), result.metrics.indexedVisualVectorCount);
  assert.deepEqual(
    graphStore.findRelations({ filter: makeIndexFilter() }).map((relation) => relation.id),
    ["relation_parent_owns_child"]
  );
});

test("source sync workflow does not save the ledger when configured post-ingest indexing fails", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const vectorStore = new InMemoryVectorStore({ chunkStore: index, dimensions: 16 });
  const ledgerStore = new InMemorySourceSyncLedgerStore();
  const connector = new FixtureSourceConnector([
    {
      sourceId: source.id,
      complete: true,
      items: [
        {
          operation: "upsert",
          sourceItemId: "source_item_embedding_failure",
          version: "1",
          record: record("embedding_failure", "Valid changed content that ingestion accepts.")
        }
      ]
    }
  ]);
  const runner = new SourceSyncWorkflowRunner({
    connector,
    ledgerStore,
    documentStore: index,
    chunkStore: index,
    vectorStore,
    embeddingAdapter: new FakeEmbeddingAdapter({
      dimensions: 16,
      failWith: "embedding provider down"
    }),
    now: () => FIXED_NOW
  });

  const result = await runner.run({
    profile,
    source,
    requestedBy: TEST_PRINCIPAL,
    runId: "workflow_post_ingest_failed",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "partial");
  assert.equal(result.ledgerSaved, false);
  assert.equal(result.postIngest?.status, "failed");
  assert.equal(result.metrics.ingestedDocumentCount, 1);
  assert.equal(result.metrics.indexedVectorCount, 0);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ["post_ingest_failed", "ledger_save_skipped"]
  );
  assert.equal(
    await ledgerStore.load({
      connectorId: connector.id,
      sourceId: source.id,
      namespaceId: profile.namespaceId
    }),
    undefined
  );
});

function record(
  suffix: string,
  body = `Body for ${suffix}.`,
  options: { readonly layout?: CorpusRecord["layout"] } = {}
): CorpusRecord {
  return {
    id: `doc_${suffix}`,
    sourceId: source.id,
    sourceKind: "local_file",
    title: `Document ${suffix}`,
    body,
    trustTier: "trusted_internal",
    sensitivity: "internal",
    accessScope: {
      tenantId: TEST_PRINCIPAL.tenantId,
      namespaceId: profile.namespaceId,
      tags: ["support"]
    },
    capturedAt: FIXED_NOW,
    ...(options.layout === undefined ? {} : { layout: options.layout })
  };
}

function visualOwnershipRecord(): CorpusRecord {
  const title = "Visual Ownership";
  const paragraph = "The page image shows Parent LLC owns Child LLC in the ownership chart.";
  const body = `${title}\n\n${paragraph}`;
  return record("visual_ownership", body, {
    layout: visualOwnershipLayout(body, title, paragraph)
  });
}

function visualOwnershipLayout(
  body: string,
  title: string,
  paragraph: string
): NonNullable<CorpusRecord["layout"]> {
  const titleStart = body.indexOf(title);
  const paragraphStart = body.indexOf(paragraph);
  return {
    parserId: "workflow-layout-fixture",
    parserVersion: "1",
    strategy: "hybrid",
    pages: [
      {
        pageNumber: 1,
        width: 1000,
        height: 1000,
        unit: "pixel",
        visualAssetId: "page_1"
      }
    ],
    regions: [
      {
        id: "region_title",
        kind: "title",
        pageNumber: 1,
        text: title,
        characterStart: titleStart,
        characterEnd: titleStart + title.length,
        box: box(1, 50, 50, 800, 80)
      },
      {
        id: "region_body",
        kind: "paragraph",
        pageNumber: 1,
        text: paragraph,
        characterStart: paragraphStart,
        characterEnd: paragraphStart + paragraph.length,
        box: box(1, 50, 160, 850, 300)
      }
    ],
    relations: [
      {
        id: "layout_relation_title_explains_body",
        kind: "explains",
        fromRegionId: "region_title",
        toRegionId: "region_body",
        confidence: 0.9
      }
    ],
    visualAssets: [
      {
        id: "page_1",
        kind: "page_image",
        pageNumber: 1,
        mediaType: "image/png",
        uri: "file:///tmp/workflow-page-1.png",
        metadata: {
          title: "Ownership chart page"
        }
      }
    ]
  };
}

function box(pageNumber: number, x: number, y: number, width: number, height: number) {
  return {
    pageNumber,
    x,
    y,
    width,
    height,
    unit: "pixel" as const
  };
}

function fakeGraphExtractor(): GraphExtractor {
  return {
    id: "workflow-fake-graph-extractor",
    supportedOntologyIds: [ownershipGraphOntology.id],
    extract: async (request) => graphSuccessResult(request, graphBatch(request))
  };
}

function graphSuccessResult(
  request: GraphExtractionRequest,
  batch: GraphExtractionBatch
): GraphExtractionResult {
  return {
    status: "succeeded",
    batch,
    validationIssues: [],
    trace: buildGraphExtractionTrace({
      request,
      extractionId: request.extractionId ?? "workflow_graph_extract",
      startedAt: request.requestedAt ?? FIXED_NOW,
      finishedAt: FIXED_NOW,
      status: "succeeded",
      entityCount: batch.entities.length,
      relationCount: batch.relations.length
    })
  };
}

function graphBatch(request: GraphExtractionRequest): GraphExtractionBatch {
  const chunk = request.chunks[0];
  assert.ok(chunk);
  const anchor = {
    chunkId: chunk.id,
    documentId: chunk.documentId,
    sourceId: chunk.provenance.sourceId,
    citation: chunk.citation,
    quoteHash: chunk.textHash,
    characterStart: chunk.characterStart,
    characterEnd: chunk.characterEnd
  };

  return {
    id: "workflow_graph_batch",
    namespaceId: request.profile.namespaceId,
    ontology: request.ontology,
    entities: [
      {
        id: "entity_parent",
        namespaceId: request.profile.namespaceId,
        kind: "legal_entity",
        name: "Parent LLC",
        normalizedName: "parent llc",
        confidence: 0.95,
        trustTier: "trusted_internal",
        accessScope: chunk.accessScope,
        evidence: [anchor],
        status: "proposed",
        createdAt: FIXED_NOW
      },
      {
        id: "entity_child",
        namespaceId: request.profile.namespaceId,
        kind: "legal_entity",
        name: "Child LLC",
        normalizedName: "child llc",
        confidence: 0.94,
        trustTier: "trusted_internal",
        accessScope: chunk.accessScope,
        evidence: [anchor],
        status: "proposed",
        createdAt: FIXED_NOW
      }
    ],
    relations: [
      {
        id: "relation_parent_owns_child",
        namespaceId: request.profile.namespaceId,
        relationKind: "owns",
        sourceEntityId: "entity_parent",
        targetEntityId: "entity_child",
        factStrength: "explicit_fact",
        confidence: 0.93,
        trustTier: "trusted_internal",
        accessScope: chunk.accessScope,
        evidence: [anchor],
        temporal: { observedAt: FIXED_NOW },
        verificationStatus: "supported",
        status: "proposed",
        createdAt: FIXED_NOW
      }
    ],
    createdAt: FIXED_NOW
  };
}
