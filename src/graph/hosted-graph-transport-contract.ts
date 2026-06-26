import { HostedGraphStore, type HostedGraphStoreTransport } from "./hosted-graph-store.js";
import type {
  GraphEntityProposal,
  GraphExtractionBatch,
  GraphRelationProposal
} from "./graph-types.js";
import { ownershipGraphOntology } from "./ownership-ontology.js";
import type { HostedGraphSafeIndexFilter } from "./hosted-graph-store.js";
import type { IndexFilter } from "../indexing/index-types.js";

export type HostedGraphTransportContractIssueCode =
  | "transport_threw"
  | "write_failed"
  | "entity_name_lookup_failed"
  | "entity_id_lookup_failed"
  | "entity_namespace_filter_failed"
  | "entity_tenant_filter_failed"
  | "relation_adjacency_lookup_failed"
  | "relation_kind_filter_failed"
  | "relation_status_filter_failed"
  | "relation_namespace_filter_failed"
  | "relation_tenant_filter_failed"
  | "entity_pagination_failed"
  | "relation_pagination_failed"
  | "entity_status_update_failed"
  | "relation_status_update_failed"
  | "relation_endpoint_update_failed"
  | "evidence_prune_failed"
  | "adapter_principal_forwarded"
  | "adapter_access_leak";

export interface HostedGraphTransportContractIssue {
  readonly code: HostedGraphTransportContractIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface HostedGraphTransportContractOptions {
  readonly transport: HostedGraphStoreTransport;
  readonly runId?: string;
  readonly namespaceId?: string;
  readonly tenantId?: string;
  readonly requestedAt?: string;
}

export interface HostedGraphTransportContractResult {
  readonly runId: string;
  readonly namespaceId: string;
  readonly tenantId: string;
  readonly entityIds: readonly string[];
  readonly relationIds: readonly string[];
  readonly issues: readonly HostedGraphTransportContractIssue[];
}

export class HostedGraphTransportContractError extends Error {
  readonly result: HostedGraphTransportContractResult;

  constructor(result: HostedGraphTransportContractResult) {
    super(
      `Hosted graph transport contract failed for "${result.runId}": ${result.issues
        .map((issue) => issue.message)
        .join("; ")}`
    );
    this.name = "HostedGraphTransportContractError";
    this.result = result;
  }
}

const DEFAULT_REQUESTED_AT = "2026-06-23T00:00:00.000Z";

export function assertHostedGraphTransportContract(
  options: HostedGraphTransportContractOptions
): HostedGraphTransportContractResult {
  const result = validateHostedGraphTransportContract(options);
  if (result.issues.length > 0) {
    throw new HostedGraphTransportContractError(result);
  }

  return result;
}

export function validateHostedGraphTransportContract(
  options: HostedGraphTransportContractOptions
): HostedGraphTransportContractResult {
  const fixture = makeContractFixture(options);
  const issues: HostedGraphTransportContractIssue[] = [];

  runContractStep(issues, "transport.addExtractionBatch", () => {
    const write = options.transport.addExtractionBatch({ batch: fixture.batch });
    if (
      !write.accepted ||
      write.entityCount !== fixture.batch.entities.length ||
      write.relationCount !== fixture.batch.relations.length
    ) {
      issues.push({
        code: "write_failed",
        path: "transport.addExtractionBatch",
        message: "Transport must accept the contract batch and return exact entity/relation counts."
      });
    }
  });

  runContractStep(issues, "transport.queryEntities", () => {
    const byName = options.transport.queryEntities({
      filter: fixture.hostedFilter,
      entityName: fixture.names.parentSearch,
      limit: 10
    });
    expectExactIds(
      issues,
      "entity_name_lookup_failed",
      "transport.queryEntities.entityName",
      [fixture.ids.parent],
      byName.entities
    );

    const byIds = options.transport.queryEntities({
      filter: fixture.hostedFilter,
      entityIds: [fixture.ids.child, fixture.ids.reviewer],
      limit: 10
    });
    expectExactIds(
      issues,
      "entity_id_lookup_failed",
      "transport.queryEntities.entityIds",
      [fixture.ids.child, fixture.ids.reviewer],
      byIds.entities
    );

    const wrongNamespace = options.transport.queryEntities({
      filter: { ...fixture.hostedFilter, namespaceId: `${fixture.namespaceId}-denied` },
      entityIds: [fixture.ids.parent],
      limit: 10
    });
    expectEmpty(
      issues,
      "entity_namespace_filter_failed",
      "transport.queryEntities.namespace",
      wrongNamespace.entities
    );

    const wrongTenant = options.transport.queryEntities({
      filter: { ...fixture.hostedFilter, tenantId: `${fixture.tenantId}-denied` },
      entityIds: [fixture.ids.parent],
      limit: 10
    });
    expectEmpty(
      issues,
      "entity_tenant_filter_failed",
      "transport.queryEntities.tenant",
      wrongTenant.entities
    );
  });

  runContractStep(issues, "transport.queryRelations", () => {
    const owns = options.transport.queryRelations({
      filter: fixture.hostedFilter,
      entityId: fixture.ids.child,
      relationKinds: ["owns"],
      limit: 10
    });
    expectExactIds(
      issues,
      "relation_adjacency_lookup_failed",
      "transport.queryRelations.owns",
      [fixture.ids.owns],
      owns.relations
    );

    const controlsWithoutReview = options.transport.queryRelations({
      filter: fixture.hostedFilter,
      entityId: fixture.ids.child,
      relationKinds: ["controls"],
      limit: 10
    });
    expectEmpty(
      issues,
      "relation_status_filter_failed",
      "transport.queryRelations.approvedOnly",
      controlsWithoutReview.relations
    );

    const controlsWithReview = options.transport.queryRelations({
      filter: fixture.hostedFilter,
      entityId: fixture.ids.child,
      relationKinds: ["controls"],
      includeUnapproved: true,
      limit: 10
    });
    expectExactIds(
      issues,
      "relation_kind_filter_failed",
      "transport.queryRelations.relationKinds",
      [fixture.ids.controls],
      controlsWithReview.relations
    );

    const wrongNamespace = options.transport.queryRelations({
      filter: { ...fixture.hostedFilter, namespaceId: `${fixture.namespaceId}-denied` },
      entityId: fixture.ids.child,
      includeUnapproved: true,
      limit: 10
    });
    expectEmpty(
      issues,
      "relation_namespace_filter_failed",
      "transport.queryRelations.namespace",
      wrongNamespace.relations
    );

    const wrongTenant = options.transport.queryRelations({
      filter: { ...fixture.hostedFilter, tenantId: `${fixture.tenantId}-denied` },
      entityId: fixture.ids.child,
      includeUnapproved: true,
      limit: 10
    });
    expectEmpty(
      issues,
      "relation_tenant_filter_failed",
      "transport.queryRelations.tenant",
      wrongTenant.relations
    );
  });

  runContractStep(issues, "transport.pageEntities", () => {
    const pagedEntityIds = collectEntityPageIds(options.transport, fixture, [
      fixture.ids.parent,
      fixture.ids.child,
      fixture.ids.reviewer
    ]);
    expectExactIdList(
      issues,
      "entity_pagination_failed",
      "transport.pageEntities",
      [fixture.ids.parent, fixture.ids.child, fixture.ids.reviewer],
      pagedEntityIds
    );
  });

  runContractStep(issues, "transport.pageRelations", () => {
    const pagedRelationIds = collectRelationPageIds(options.transport, fixture);
    expectExactIdList(
      issues,
      "relation_pagination_failed",
      "transport.pageRelations",
      [fixture.ids.owns, fixture.ids.controls],
      pagedRelationIds
    );
  });

  runContractStep(issues, "transport.updateEntityStatus", () => {
    const updated = options.transport.updateEntityStatus({
      id: fixture.ids.reviewer,
      status: "approved"
    }).entity;
    if (updated?.status !== "approved") {
      issues.push({
        code: "entity_status_update_failed",
        path: "transport.updateEntityStatus",
        message: "Transport must return the updated entity status."
      });
    }
  });

  runContractStep(issues, "transport.updateRelationStatus", () => {
    const updated = options.transport.updateRelationStatus({
      id: fixture.ids.controls,
      status: "approved"
    }).relation;
    if (updated?.status !== "approved") {
      issues.push({
        code: "relation_status_update_failed",
        path: "transport.updateRelationStatus",
        message: "Transport must return the updated relation status."
      });
      return;
    }

    const visibleControls = options.transport.queryRelations({
      filter: fixture.hostedFilter,
      entityId: fixture.ids.child,
      relationKinds: ["controls"],
      limit: 10
    });
    expectExactIds(
      issues,
      "relation_status_update_failed",
      "transport.updateRelationStatus.query",
      [fixture.ids.controls],
      visibleControls.relations
    );
  });

  runContractStep(issues, "transport.updateRelationEndpoints", () => {
    const updated = options.transport.updateRelationEndpoints({
      id: fixture.ids.owns,
      endpoints: { sourceEntityId: fixture.ids.reviewer }
    }).relation;
    if (updated?.sourceEntityId !== fixture.ids.reviewer) {
      issues.push({
        code: "relation_endpoint_update_failed",
        path: "transport.updateRelationEndpoints",
        message: "Transport must return the updated relation endpoint."
      });
      return;
    }

    const oldAdjacency = options.transport.queryRelations({
      filter: fixture.hostedFilter,
      entityId: fixture.ids.parent,
      relationKinds: ["owns"],
      includeUnapproved: true,
      limit: 10
    });
    if (oldAdjacency.relations.some((relation) => relation.id === fixture.ids.owns)) {
      issues.push({
        code: "relation_endpoint_update_failed",
        path: "transport.updateRelationEndpoints.oldAdjacency",
        message: "Transport must remove updated relations from old adjacency lookups."
      });
    }

    const newAdjacency = options.transport.queryRelations({
      filter: fixture.hostedFilter,
      entityId: fixture.ids.reviewer,
      relationKinds: ["owns"],
      includeUnapproved: true,
      limit: 10
    });
    if (!newAdjacency.relations.some((relation) => relation.id === fixture.ids.owns)) {
      issues.push({
        code: "relation_endpoint_update_failed",
        path: "transport.updateRelationEndpoints.newAdjacency",
        message: "Transport must expose updated relations through new adjacency lookups."
      });
    }
  });

  runContractStep(issues, "transport.pruneEvidence", () => {
    const prune = options.transport.pruneEvidence({
      filter: fixture.hostedFilter,
      documentIds: [fixture.evidenceDocumentId]
    });
    if (!prune.accepted || prune.removedEvidenceAnchorCount < 1) {
      issues.push({
        code: "evidence_prune_failed",
        path: "transport.pruneEvidence",
        message: "Transport must prune graph evidence by document id and report pruned anchors."
      });
      return;
    }

    const relations = options.transport.queryRelations({
      filter: fixture.hostedFilter,
      entityId: fixture.ids.child,
      includeUnapproved: true,
      limit: 10
    });
    if (
      relations.relations.some((relation) =>
        relation.evidence.some((anchor) => anchor.documentId === fixture.evidenceDocumentId)
      )
    ) {
      issues.push({
        code: "evidence_prune_failed",
        path: "transport.pruneEvidence.query",
        message: "Transport must not return facts with evidence anchors pruned by document id."
      });
    }
  });

  runContractStep(issues, "HostedGraphStore safety wrapper", () => {
    const recordingTransport = new RecordingHostedGraphTransport(options.transport);
    const store = new HostedGraphStore({
      transport: recordingTransport,
      candidateMultiplier: 10,
      maxCandidateLimit: 50
    });
    const entities = store.findEntities(fixture.indexFilter);
    const relations = store.findRelations({
      filter: fixture.indexFilter,
      includeUnapproved: true,
      limit: 20
    });

    if (entities.some((entity) => entity.id === fixture.ids.privateEntity)) {
      issues.push({
        code: "adapter_access_leak",
        path: "HostedGraphStore.findEntities",
        message:
          "HostedGraphStore must not return transport entities denied by local access checks."
      });
    }

    if (relations.some((relation) => relation.id === fixture.ids.privateRelation)) {
      issues.push({
        code: "adapter_access_leak",
        path: "HostedGraphStore.findRelations",
        message:
          "HostedGraphStore must not return transport relations denied by local access checks."
      });
    }

    const requestJson = JSON.stringify(recordingTransport.requests);
    const forbiddenValues = [
      "principal",
      "userId",
      "teamIds",
      "roles",
      "tags",
      fixture.principal.userId,
      fixture.principal.teamIds[0] ?? "",
      fixture.principal.roles[0] ?? ""
    ].filter(Boolean);
    if (forbiddenValues.some((value) => requestJson.includes(value))) {
      issues.push({
        code: "adapter_principal_forwarded",
        path: "HostedGraphStore.transportRequest",
        message: "HostedGraphStore must not forward raw principal claims to hosted transports."
      });
    }
  });

  return {
    runId: fixture.runId,
    namespaceId: fixture.namespaceId,
    tenantId: fixture.tenantId,
    entityIds: [
      fixture.ids.parent,
      fixture.ids.child,
      fixture.ids.reviewer,
      fixture.ids.privateEntity
    ],
    relationIds: [fixture.ids.owns, fixture.ids.controls, fixture.ids.privateRelation],
    issues
  };
}

interface ContractFixture {
  readonly runId: string;
  readonly namespaceId: string;
  readonly tenantId: string;
  readonly requestedAt: string;
  readonly hostedFilter: HostedGraphSafeIndexFilter;
  readonly indexFilter: IndexFilter;
  readonly principal: IndexFilter["principal"];
  readonly evidenceDocumentId: string;
  readonly ids: {
    readonly parent: string;
    readonly child: string;
    readonly reviewer: string;
    readonly privateEntity: string;
    readonly owns: string;
    readonly controls: string;
    readonly privateRelation: string;
  };
  readonly names: {
    readonly parentSearch: string;
  };
  readonly batch: GraphExtractionBatch;
}

class RecordingHostedGraphTransport implements HostedGraphStoreTransport {
  readonly requests: unknown[] = [];

  constructor(private readonly delegate: HostedGraphStoreTransport) {}

  addExtractionBatch(request: Parameters<HostedGraphStoreTransport["addExtractionBatch"]>[0]) {
    this.requests.push(request);
    return this.delegate.addExtractionBatch(request);
  }

  queryEntities(request: Parameters<HostedGraphStoreTransport["queryEntities"]>[0]) {
    this.requests.push(request);
    return this.delegate.queryEntities(request);
  }

  pageEntities(request: Parameters<HostedGraphStoreTransport["pageEntities"]>[0]) {
    this.requests.push(request);
    return this.delegate.pageEntities(request);
  }

  queryRelations(request: Parameters<HostedGraphStoreTransport["queryRelations"]>[0]) {
    this.requests.push(request);
    return this.delegate.queryRelations(request);
  }

  pageRelations(request: Parameters<HostedGraphStoreTransport["pageRelations"]>[0]) {
    this.requests.push(request);
    return this.delegate.pageRelations(request);
  }

  updateEntityStatus(request: Parameters<HostedGraphStoreTransport["updateEntityStatus"]>[0]) {
    this.requests.push(request);
    return this.delegate.updateEntityStatus(request);
  }

  updateRelationStatus(request: Parameters<HostedGraphStoreTransport["updateRelationStatus"]>[0]) {
    this.requests.push(request);
    return this.delegate.updateRelationStatus(request);
  }

  updateRelationEndpoints(
    request: Parameters<HostedGraphStoreTransport["updateRelationEndpoints"]>[0]
  ) {
    this.requests.push(request);
    return this.delegate.updateRelationEndpoints(request);
  }

  pruneEvidence(request: Parameters<HostedGraphStoreTransport["pruneEvidence"]>[0]) {
    this.requests.push(request);
    return this.delegate.pruneEvidence(request);
  }
}

function makeContractFixture(options: HostedGraphTransportContractOptions): ContractFixture {
  const runId = normalizeContractId(options.runId ?? "hosted_graph_transport_contract");
  const namespaceId = options.namespaceId ?? `${runId}-namespace`;
  const tenantId = options.tenantId ?? `${runId}-tenant`;
  const requestedAt = options.requestedAt ?? DEFAULT_REQUESTED_AT;
  const visibleTag = `${runId}_visible`;
  const privateTag = `${runId}_private`;
  const ids = {
    parent: `${runId}_entity_parent`,
    child: `${runId}_entity_child`,
    reviewer: `${runId}_entity_reviewer`,
    privateEntity: `${runId}_entity_private`,
    owns: `${runId}_rel_owns`,
    controls: `${runId}_rel_controls`,
    privateRelation: `${runId}_rel_private`
  };
  const principal = {
    userId: `${runId}_user`,
    tenantId,
    namespaceIds: [namespaceId],
    teamIds: [`${runId}_team`],
    roles: [`${runId}_role`],
    tags: [visibleTag, `${runId}_principal_tag`]
  };
  const hostedFilter = {
    namespaceId,
    tenantId
  };
  const indexFilter = {
    ...hostedFilter,
    principal,
    limit: 20
  };
  const evidence = evidenceAnchor(runId);
  const visibleScope = {
    tenantId,
    namespaceId,
    tags: [visibleTag]
  };
  const privateScope = {
    tenantId,
    namespaceId,
    tags: [privateTag]
  };
  const baseEntity = {
    namespaceId,
    kind: "legal_entity" as const,
    confidence: 0.95,
    trustTier: "trusted_internal" as const,
    evidence: [evidence],
    status: "proposed" as const
  };
  const baseRelation = {
    namespaceId,
    sourceEntityId: ids.parent,
    targetEntityId: ids.child,
    factStrength: "explicit_fact" as const,
    confidence: 0.91,
    trustTier: "trusted_internal" as const,
    evidence: [evidence],
    temporal: { observedAt: requestedAt },
    verificationStatus: "supported" as const,
    createdAt: timestampForIndex(requestedAt, 10)
  };

  return {
    runId,
    namespaceId,
    tenantId,
    requestedAt,
    hostedFilter,
    indexFilter,
    principal,
    evidenceDocumentId: evidence.documentId,
    ids,
    names: {
      parentSearch: `${runId} Parent`
    },
    batch: {
      id: `${runId}_batch`,
      namespaceId,
      ontology: ownershipGraphOntology,
      entities: [
        {
          ...baseEntity,
          id: ids.parent,
          name: `${runId} Parent Holdings LLC`,
          normalizedName: `${runId} parent holdings`,
          aliases: [`${runId} Parent`],
          accessScope: visibleScope,
          status: "approved",
          createdAt: timestampForIndex(requestedAt, 1)
        },
        {
          ...baseEntity,
          id: ids.child,
          name: `${runId} Child Operating LLC`,
          normalizedName: `${runId} child operating`,
          accessScope: visibleScope,
          status: "approved",
          createdAt: timestampForIndex(requestedAt, 2)
        },
        {
          ...baseEntity,
          id: ids.reviewer,
          name: `${runId} Reviewer LLC`,
          normalizedName: `${runId} reviewer`,
          accessScope: visibleScope,
          createdAt: timestampForIndex(requestedAt, 3)
        },
        {
          ...baseEntity,
          id: ids.privateEntity,
          name: `${runId} Private Board LLC`,
          normalizedName: `${runId} private board`,
          accessScope: privateScope,
          status: "approved",
          createdAt: timestampForIndex(requestedAt, 4)
        }
      ],
      relations: [
        {
          ...baseRelation,
          id: ids.owns,
          relationKind: "owns",
          accessScope: visibleScope,
          status: "approved",
          createdAt: timestampForIndex(requestedAt, 5)
        },
        {
          ...baseRelation,
          id: ids.controls,
          relationKind: "controls",
          sourceEntityId: ids.reviewer,
          accessScope: visibleScope,
          status: "proposed",
          createdAt: timestampForIndex(requestedAt, 6)
        },
        {
          ...baseRelation,
          id: ids.privateRelation,
          relationKind: "owns",
          targetEntityId: ids.privateEntity,
          accessScope: privateScope,
          status: "approved",
          createdAt: timestampForIndex(requestedAt, 7)
        }
      ],
      createdAt: requestedAt
    }
  };
}

function runContractStep(
  issues: HostedGraphTransportContractIssue[],
  path: string,
  step: () => void
): void {
  try {
    step();
  } catch (error) {
    issues.push({
      code: "transport_threw",
      path,
      message: `Transport operation must not throw during the contract: ${errorName(error)}.`
    });
  }
}

function collectEntityPageIds(
  transport: HostedGraphStoreTransport,
  fixture: ContractFixture,
  entityIds: readonly string[]
): readonly string[] {
  const ids: string[] = [];
  let cursor: string | undefined;

  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const page = transport.pageEntities({
      filter: fixture.hostedFilter,
      entityIds,
      limit: 2,
      ...(cursor === undefined ? {} : { cursor })
    });
    if (page.entities.length > 2) {
      return [...ids, "__page_limit_exceeded__"];
    }

    ids.push(...page.entities.map((entity) => entity.id));
    cursor = page.nextCursor;
    if (cursor === undefined) {
      return ids;
    }
  }

  return [...ids, "__page_loop__"];
}

function collectRelationPageIds(
  transport: HostedGraphStoreTransport,
  fixture: ContractFixture
): readonly string[] {
  const ids: string[] = [];
  let cursor: string | undefined;

  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const page = transport.pageRelations({
      filter: fixture.hostedFilter,
      entityId: fixture.ids.child,
      includeUnapproved: true,
      limit: 1,
      ...(cursor === undefined ? {} : { cursor })
    });
    if (page.relations.length > 1) {
      return [...ids, "__page_limit_exceeded__"];
    }

    ids.push(...page.relations.map((relation) => relation.id));
    cursor = page.nextCursor;
    if (cursor === undefined) {
      return ids;
    }
  }

  return [...ids, "__page_loop__"];
}

function expectExactIds(
  issues: HostedGraphTransportContractIssue[],
  code: HostedGraphTransportContractIssueCode,
  path: string,
  expectedIds: readonly string[],
  facts: readonly (GraphEntityProposal | GraphRelationProposal)[]
): void {
  expectExactIdList(
    issues,
    code,
    path,
    expectedIds,
    facts.map((fact) => fact.id)
  );
}

function expectExactIdList(
  issues: HostedGraphTransportContractIssue[],
  code: HostedGraphTransportContractIssueCode,
  path: string,
  expectedIds: readonly string[],
  actualIds: readonly string[]
): void {
  if (sameSet(expectedIds, actualIds)) {
    return;
  }

  issues.push({
    code,
    path,
    message: `${path} expected ids [${expectedIds.join(", ")}], received [${actualIds.join(", ")}].`
  });
}

function expectEmpty(
  issues: HostedGraphTransportContractIssue[],
  code: HostedGraphTransportContractIssueCode,
  path: string,
  facts: readonly (GraphEntityProposal | GraphRelationProposal)[]
): void {
  if (facts.length === 0) {
    return;
  }

  issues.push({
    code,
    path,
    message: `${path} must return no facts for denied tenant/namespace/status filters.`
  });
}

function sameSet(expected: readonly string[], actual: readonly string[]): boolean {
  if (expected.length !== actual.length) {
    return false;
  }

  const actualSet = new Set(actual);
  return expected.every((id) => actualSet.has(id));
}

function evidenceAnchor(runId: string): GraphEntityProposal["evidence"][number] {
  return {
    chunkId: `${runId}_chunk_1`,
    documentId: `${runId}_doc_1`,
    sourceId: `${runId}_source_1`,
    citation: {
      sourceId: `${runId}_source_1`,
      chunkId: `${runId}_chunk_1`,
      title: "Hosted graph transport contract",
      locator: "page 1"
    },
    quoteHash: `${runId}_hash_1`,
    characterStart: 0,
    characterEnd: 20
  };
}

function normalizeContractId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized.length > 0 ? normalized : "hosted_graph_transport_contract";
}

function timestampForIndex(base: string, index: number): string {
  return new Date(Date.parse(base) + index).toISOString();
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
