import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { RagDocument } from "../documents/document.js";
import { InMemoryRagGraphStore } from "../graph/graph-store.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import {
  FIXED_NOW,
  makeDocument,
  makeIndexFilter,
  makePrincipal
} from "../test-support/fixtures.js";
import { GraphAugmentedRetriever } from "./graph-augmented-retriever.js";
import { KeywordRetriever } from "./keyword-retriever.js";

test("graph augmentation adds one-hop neighbor chunks through the normal chunk store", async () => {
  const { index, chunksByDocument } = makeIndex([
    makeDocument({
      id: "doc_acme",
      body: "Acme Corp appears in the acquisition memo."
    }),
    makeDocument({
      id: "doc_customer_concentration",
      body: "Top three customers account for most revenue, creating concentration risk."
    })
  ]);
  const graph = new InMemoryRagGraphStore();
  graph.upsertEntity({
    id: "entity_acme",
    name: "Acme Corp",
    chunkIds: [chunksByDocument.get("doc_acme")?.[0]?.id ?? ""]
  });
  graph.upsertEntity({
    id: "entity_customer_concentration",
    name: "Customer concentration",
    aliases: ["revenue exposure"],
    chunkIds: [chunksByDocument.get("doc_customer_concentration")?.[0]?.id ?? ""]
  });
  graph.upsertRelationship({
    id: "rel_acme_concentration",
    fromEntityId: "entity_acme",
    toEntityId: "entity_customer_concentration",
    type: "risk_factor",
    highLevelKeywords: ["risk", "revenue exposure"],
    chunkIds: []
  });
  const retriever = new GraphAugmentedRetriever({
    baseRetriever: new KeywordRetriever({ chunkStore: index, now: () => FIXED_NOW }),
    graphStore: graph,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await retriever.retrieve({
    query: "What risks does Acme have?",
    filter: makeIndexFilter(),
    topK: 5,
    mode: "keyword",
    requestedAt: FIXED_NOW
  });

  assert.equal(
    result.candidates.some((candidate) => candidate.chunk.documentId === "doc_acme"),
    true
  );
  assert.equal(
    result.candidates.some(
      (candidate) => candidate.chunk.documentId === "doc_customer_concentration"
    ),
    true
  );
  assert.equal(result.trace.fusionStrategy, "graph_one_hop");
});

test("graph augmentation cannot return chunks denied by the index filter", async () => {
  const deniedPrincipal = makePrincipal({ tags: ["support"] });
  const { index, chunksByDocument } = makeIndex([
    makeDocument({
      id: "doc_acme",
      body: "Acme Corp appears in the acquisition memo."
    }),
    makeDocument({
      id: "doc_private",
      body: "Private board-only concentration risk memo.",
      accessScope: {
        tenantId: "tenant_1",
        namespaceId: "test-namespace",
        tags: ["board_only"]
      }
    })
  ]);
  const graph = new InMemoryRagGraphStore();
  graph.upsertEntity({
    id: "entity_acme",
    name: "Acme Corp",
    chunkIds: [
      chunksByDocument.get("doc_acme")?.[0]?.id ?? "",
      chunksByDocument.get("doc_private")?.[0]?.id ?? ""
    ]
  });
  const retriever = new GraphAugmentedRetriever({
    baseRetriever: new KeywordRetriever({ chunkStore: index, now: () => FIXED_NOW }),
    graphStore: graph,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await retriever.retrieve({
    query: "Acme",
    filter: makeIndexFilter({ principal: deniedPrincipal }),
    topK: 5,
    mode: "keyword",
    requestedAt: FIXED_NOW
  });

  assert.equal(
    result.candidates.some((candidate) => candidate.chunk.documentId === "doc_acme"),
    true
  );
  assert.equal(
    result.candidates.some((candidate) => candidate.chunk.documentId === "doc_private"),
    false
  );
});

test("graph augmentation obeys request-scoped graph controls", async () => {
  const { index, chunksByDocument } = makeIndex([
    makeDocument({
      id: "doc_appendix",
      body: "Appendix evidence describes the relevant structure."
    })
  ]);
  const graph = new InMemoryRagGraphStore();
  graph.upsertEntity({
    id: "entity_parent",
    name: "Parent LLC",
    chunkIds: [chunksByDocument.get("doc_appendix")?.[0]?.id ?? ""]
  });
  const retriever = new GraphAugmentedRetriever({
    baseRetriever: new KeywordRetriever({ chunkStore: index, now: () => FIXED_NOW }),
    graphStore: graph,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const disabled = await retriever.retrieve({
    query: "Parent LLC",
    filter: makeIndexFilter(),
    topK: 5,
    mode: "keyword",
    graph: { enabled: false },
    requestedAt: FIXED_NOW
  });
  const enabled = await retriever.retrieve({
    query: "Parent LLC",
    filter: makeIndexFilter(),
    topK: 5,
    mode: "keyword",
    graph: {
      enabled: true,
      entityLimit: 1,
      neighborLimit: 1
    },
    requestedAt: FIXED_NOW
  });

  assert.equal(disabled.candidates.length, 0);
  assert.equal(
    enabled.candidates.some((candidate) => candidate.chunk.documentId === "doc_appendix"),
    true
  );
});

test("graph augmentation uses structured entity hints, relation kinds, and direction", async () => {
  const { index, chunksByDocument } = makeIndex([
    makeDocument({
      id: "doc_parent",
      body: "Parent LLC governance memo."
    }),
    makeDocument({
      id: "doc_child",
      body: "Child LLC formation memo."
    }),
    makeDocument({
      id: "doc_manager",
      body: "Manager LLC service memo."
    })
  ]);
  const graph = new InMemoryRagGraphStore();
  graph.upsertEntity({
    id: "entity_parent",
    name: "Parent LLC",
    chunkIds: [chunksByDocument.get("doc_parent")?.[0]?.id ?? ""]
  });
  graph.upsertEntity({
    id: "entity_child",
    name: "Child LLC",
    chunkIds: [chunksByDocument.get("doc_child")?.[0]?.id ?? ""]
  });
  graph.upsertEntity({
    id: "entity_manager",
    name: "Manager LLC",
    chunkIds: [chunksByDocument.get("doc_manager")?.[0]?.id ?? ""]
  });
  graph.upsertRelationship({
    id: "rel_parent_child",
    fromEntityId: "entity_parent",
    toEntityId: "entity_child",
    type: "owns",
    highLevelKeywords: ["ownership"],
    chunkIds: []
  });
  graph.upsertRelationship({
    id: "rel_manager_child",
    fromEntityId: "entity_manager",
    toEntityId: "entity_child",
    type: "manages",
    highLevelKeywords: ["management"],
    chunkIds: []
  });
  const retriever = new GraphAugmentedRetriever({
    baseRetriever: new KeywordRetriever({ chunkStore: index, now: () => FIXED_NOW }),
    graphStore: graph,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await retriever.retrieve({
    query: "Who owns it?",
    filter: makeIndexFilter(),
    topK: 3,
    mode: "keyword",
    graph: {
      enabled: true,
      entityHints: ["Child LLC"],
      relationKinds: ["owns"],
      direction: "incoming",
      executionMode: "graph_first",
      entityLimit: 2,
      neighborLimit: 4
    },
    requestedAt: FIXED_NOW
  });

  assert.equal(result.candidates[0]?.chunk.documentId, "doc_parent");
  assert.equal(
    result.candidates.some((candidate) => candidate.chunk.documentId === "doc_manager"),
    false
  );
  assert.equal(
    result.candidates[0]?.reasons.some((reason) => reason === "graph_first_one_hop:owns"),
    true
  );
});

test("graph augmentation follows bounded multi-hop paths when requested", async () => {
  const { index, chunksByDocument } = makeIndex([
    makeDocument({
      id: "doc_parent",
      body: "Parent LLC owns the intermediate holding company."
    }),
    makeDocument({
      id: "doc_child",
      body: "Child LLC owns the operating subsidiary."
    }),
    makeDocument({
      id: "doc_operating_subsidiary",
      body: "Operating Subsidiary LLC is the entity named in the question."
    }),
    makeDocument({
      id: "doc_rel_parent_child",
      body: "The ownership chart states Parent LLC owns Child LLC."
    }),
    makeDocument({
      id: "doc_rel_child_subsidiary",
      body: "The ownership chart states Child LLC owns Operating Subsidiary LLC."
    })
  ]);
  const graph = new InMemoryRagGraphStore();
  graph.upsertEntity({
    id: "entity_parent",
    name: "Parent LLC",
    chunkIds: [chunksByDocument.get("doc_parent")?.[0]?.id ?? ""]
  });
  graph.upsertEntity({
    id: "entity_child",
    name: "Child LLC",
    chunkIds: [chunksByDocument.get("doc_child")?.[0]?.id ?? ""]
  });
  graph.upsertEntity({
    id: "entity_operating_subsidiary",
    name: "Operating Subsidiary LLC",
    chunkIds: [chunksByDocument.get("doc_operating_subsidiary")?.[0]?.id ?? ""]
  });
  graph.upsertRelationship({
    id: "rel_parent_child",
    fromEntityId: "entity_parent",
    toEntityId: "entity_child",
    type: "owns",
    highLevelKeywords: ["ownership chain"],
    chunkIds: [chunksByDocument.get("doc_rel_parent_child")?.[0]?.id ?? ""]
  });
  graph.upsertRelationship({
    id: "rel_child_subsidiary",
    fromEntityId: "entity_child",
    toEntityId: "entity_operating_subsidiary",
    type: "owns",
    highLevelKeywords: ["subsidiary owner"],
    chunkIds: [chunksByDocument.get("doc_rel_child_subsidiary")?.[0]?.id ?? ""]
  });
  const retriever = new GraphAugmentedRetriever({
    baseRetriever: new KeywordRetriever({ chunkStore: index, now: () => FIXED_NOW }),
    graphStore: graph,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await retriever.retrieve({
    query: "Who ultimately owns it?",
    filter: makeIndexFilter(),
    topK: 6,
    mode: "keyword",
    graph: {
      enabled: true,
      entityHints: ["Operating Subsidiary LLC"],
      relationKinds: ["owns"],
      direction: "incoming",
      executionMode: "graph_first",
      entityLimit: 1,
      neighborLimit: 2,
      maxDepth: 2,
      maxVisitedEntities: 3
    },
    requestedAt: FIXED_NOW
  });
  const parentCandidate = result.candidates.find(
    (candidate) => candidate.chunk.documentId === "doc_parent"
  );

  assert.equal(
    result.candidates.some(
      (candidate) =>
        candidate.chunk.documentId === "doc_parent" &&
        candidate.reasons.includes("graph_first_path_depth_2:owns")
    ),
    true
  );
  assert.equal(parentCandidate?.graphEvidence?.depth, 2);
  assert.deepEqual(
    parentCandidate?.graphEvidence?.edges.map((edge) => `${edge.from.name}->${edge.to.name}`),
    ["Child LLC->Operating Subsidiary LLC", "Parent LLC->Child LLC"]
  );
  assert.deepEqual(
    parentCandidate?.graphEvidence?.edges.flatMap((edge) => edge.evidenceChunkIds).sort(),
    [
      chunksByDocument.get("doc_rel_child_subsidiary")?.[0]?.id ?? "",
      chunksByDocument.get("doc_rel_parent_child")?.[0]?.id ?? ""
    ].sort()
  );
  assert.equal(result.trace.graphTraversalDepth, 2);
  assert.equal(result.trace.graphVisitedEntityCount, 3);
  assert.equal(result.trace.graphTraversedEdgeCount, 2);
  assert.equal(result.trace.fusionStrategy, "graph_multi_hop");
});

test("graph augmentation caps dense traversal with maxVisitedEntities", async () => {
  const { index, chunksByDocument } = makeIndex([
    makeDocument({
      id: "doc_a",
      body: "Alpha Anchor appears in the graph."
    }),
    makeDocument({
      id: "doc_b",
      body: "First neighbor note."
    }),
    makeDocument({
      id: "doc_c",
      body: "Second neighbor note that should remain outside the cap."
    }),
    makeDocument({
      id: "doc_d",
      body: "Beyond the capped frontier."
    })
  ]);
  const graph = new InMemoryRagGraphStore();
  graph.upsertEntity({
    id: "entity_a",
    name: "Alpha Anchor",
    chunkIds: [chunksByDocument.get("doc_a")?.[0]?.id ?? ""]
  });
  graph.upsertEntity({
    id: "entity_b",
    name: "Beta Node",
    chunkIds: [chunksByDocument.get("doc_b")?.[0]?.id ?? ""]
  });
  graph.upsertEntity({
    id: "entity_c",
    name: "Gamma Node",
    chunkIds: [chunksByDocument.get("doc_c")?.[0]?.id ?? ""]
  });
  graph.upsertEntity({
    id: "entity_d",
    name: "Delta Node",
    chunkIds: [chunksByDocument.get("doc_d")?.[0]?.id ?? ""]
  });
  graph.upsertRelationship({
    id: "rel_a_b",
    fromEntityId: "entity_a",
    toEntityId: "entity_b",
    type: "references",
    chunkIds: []
  });
  graph.upsertRelationship({
    id: "rel_a_c",
    fromEntityId: "entity_a",
    toEntityId: "entity_c",
    type: "references",
    chunkIds: []
  });
  graph.upsertRelationship({
    id: "rel_b_d",
    fromEntityId: "entity_b",
    toEntityId: "entity_d",
    type: "references",
    chunkIds: []
  });
  const retriever = new GraphAugmentedRetriever({
    baseRetriever: new KeywordRetriever({ chunkStore: index, now: () => FIXED_NOW }),
    graphStore: graph,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await retriever.retrieve({
    query: "Alpha Anchor",
    filter: makeIndexFilter(),
    topK: 5,
    mode: "keyword",
    graph: {
      enabled: true,
      entityHints: ["Alpha Anchor"],
      relationKinds: ["references"],
      direction: "outgoing",
      executionMode: "graph_first",
      entityLimit: 1,
      neighborLimit: 3,
      maxDepth: 2,
      maxVisitedEntities: 2
    },
    requestedAt: FIXED_NOW
  });

  assert.equal(
    result.candidates.some((candidate) => candidate.chunk.documentId === "doc_b"),
    true
  );
  assert.equal(
    result.candidates.some((candidate) => candidate.chunk.documentId === "doc_c"),
    false
  );
  assert.equal(
    result.candidates.some((candidate) => candidate.chunk.documentId === "doc_d"),
    false
  );
  assert.equal(result.trace.graphVisitedEntityCount, 2);
  assert.equal(result.trace.graphTraversedEdgeCount, 1);
});

function makeIndex(documents: readonly RagDocument[]): {
  readonly index: InMemoryRagIndex;
  readonly chunksByDocument: ReadonlyMap<string, readonly { readonly id: string }[]>;
} {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const chunksByDocument = new Map<string, readonly { readonly id: string }[]>();

  for (const document of documents) {
    const chunks = chunkDocument({ document }).chunks;
    index.addDocument(document);
    index.addChunks(document.id, chunks);
    chunksByDocument.set(document.id, chunks);
  }

  return { index, chunksByDocument };
}
