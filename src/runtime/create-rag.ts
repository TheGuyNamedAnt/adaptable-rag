import type { StartupSelfTestOptions, StartupSelfTestResult } from "./startup-self-test.js";
import {
  createProductionRagApp,
  ProductionRagRequestError,
  type ProductionRagApp,
  type ProductionRagAppOptions,
  type ProductionRagAnswerInput,
  type ProductionRagAnswerResponse,
  type ProductionRagHealth
} from "./production-app.js";
import {
  createProductionIngestRuntime,
  type ProductionIngestRuntime,
  type ProductionIngestRuntimeOptions,
  type ProductionRagIngestInput,
  type ProductionRagIngestResponse
} from "./production-ingestion.js";
import {
  importGraphBatches,
  type GraphBatchImportRequest,
  type GraphBatchImportResult
} from "../graph/graph-batch-import.js";
import type { GraphIngestionResult } from "../graph/graph-ingestion.js";
import type {
  GraphEntityProposal,
  GraphRelationKind,
  GraphRelationProposal
} from "../graph/graph-types.js";
import type { GraphPageCursor } from "../graph/graph-pagination.js";
import type { AssembledGraphIngestionRequest } from "./rag-runtime-factory.js";
import type { RagAgentResult, RagQueryResult } from "./runtime-types.js";
import type { RagRunTrace } from "../observability/trace.js";
import type {
  IndexedChunk,
  IndexedDocument,
  IndexFilter,
  IndexStats
} from "../indexing/index-types.js";

export interface CreateRagOptions extends Omit<ProductionRagAppOptions, "graph"> {
  readonly knowledge?: ProductionRagAppOptions["graph"];
  /** @deprecated Use knowledge. */
  readonly graph?: ProductionRagAppOptions["graph"];
  readonly ingestion?: Omit<ProductionIngestRuntimeOptions, "app">;
}

export interface RagLocalAgentInput extends ProductionRagAnswerInput {
  readonly maxSteps?: unknown;
  readonly retryWhenEvidenceInsufficient?: unknown;
}

export interface RagLocalIngestInput extends ProductionRagIngestInput {
  readonly knowledge?: RagLocalKnowledgeIngestOption;
  /** @deprecated Use knowledge. */
  readonly graph?: RagLocalGraphIngestOption;
}

export interface RagLocalKnowledgeIngestOption {
  readonly enabled?: boolean;
  readonly approvalFilter?: unknown;
  readonly ingestionId?: string;
  readonly requestedAt?: string;
}

/** @deprecated Use RagLocalKnowledgeIngestOption. */
export type RagLocalGraphIngestOption = RagLocalKnowledgeIngestOption;

export interface RagLocalIngestResponse extends ProductionRagIngestResponse {
  readonly knowledge?: GraphIngestionResult;
  /** @deprecated Use knowledge. */
  readonly graph?: GraphIngestionResult;
}

export interface PlugAndPlayRagKnowledgeApi {
  ingest(input: AssembledGraphIngestionRequest): Promise<unknown>;
  importBatches(input: RagKnowledgeBatchImportInput): Promise<GraphBatchImportResult>;
  resolveEntities(
    input: Parameters<NonNullable<ProductionRagApp["runtime"]["resolveGraphEntities"]>>[0]
  ): unknown;
  query(input: RagKnowledgeQueryInput): RagKnowledgeQueryResult;
  pageEntities(input: RagKnowledgeEntityPageInput): RagKnowledgeEntityPageResult;
  pageRelations(input: RagKnowledgeRelationPageInput): RagKnowledgeRelationPageResult;
}

/** @deprecated Use PlugAndPlayRagKnowledgeApi. */
export type PlugAndPlayRagGraphApi = PlugAndPlayRagKnowledgeApi;

export type RagKnowledgeBatchImportInput = Omit<GraphBatchImportRequest, "store">;

/** @deprecated Use RagKnowledgeBatchImportInput. */
export type RagGraphBatchImportInput = RagKnowledgeBatchImportInput;

export interface RagKnowledgeQueryInput extends RagInspectInput {
  readonly filters?: unknown;
  readonly entityId?: string;
  readonly entityName?: string;
  readonly relationKinds?: readonly GraphRelationKind[];
  readonly includeUnapproved?: boolean;
  readonly limit?: number;
}

/** @deprecated Use RagKnowledgeQueryInput. */
export type RagGraphQueryInput = RagKnowledgeQueryInput;

export interface RagKnowledgeQueryResult {
  readonly entities: readonly GraphEntityProposal[];
  readonly relations: readonly GraphRelationProposal[];
  readonly trace: {
    readonly entityCount: number;
    readonly relationCount: number;
    readonly includeUnapproved: boolean;
    readonly entityId?: string;
    readonly entityName?: string;
    readonly relationKinds?: readonly GraphRelationKind[];
  };
}

/** @deprecated Use RagKnowledgeQueryResult. */
export type RagGraphQueryResult = RagKnowledgeQueryResult;

export interface RagKnowledgeEntityPageInput extends RagInspectInput {
  readonly filters?: unknown;
  readonly entityIds?: readonly string[];
  readonly entityName?: string;
  readonly cursor?: GraphPageCursor;
  readonly limit?: number;
}

/** @deprecated Use RagKnowledgeEntityPageInput. */
export type RagGraphEntityPageInput = RagKnowledgeEntityPageInput;

export interface RagKnowledgeEntityPageResult {
  readonly entities: readonly GraphEntityProposal[];
  readonly nextCursor?: GraphPageCursor;
  readonly trace: {
    readonly entityCount: number;
    readonly hasNextPage: boolean;
    readonly entityName?: string;
  };
}

/** @deprecated Use RagKnowledgeEntityPageResult. */
export type RagGraphEntityPageResult = RagKnowledgeEntityPageResult;

export interface RagKnowledgeRelationPageInput extends RagInspectInput {
  readonly filters?: unknown;
  readonly entityId?: string;
  readonly relationKinds?: readonly GraphRelationKind[];
  readonly includeUnapproved?: boolean;
  readonly cursor?: GraphPageCursor;
  readonly limit?: number;
}

/** @deprecated Use RagKnowledgeRelationPageInput. */
export type RagGraphRelationPageInput = RagKnowledgeRelationPageInput;

export interface RagKnowledgeRelationPageResult {
  readonly relations: readonly GraphRelationProposal[];
  readonly nextCursor?: GraphPageCursor;
  readonly trace: {
    readonly relationCount: number;
    readonly hasNextPage: boolean;
    readonly includeUnapproved: boolean;
    readonly entityId?: string;
    readonly relationKinds?: readonly GraphRelationKind[];
  };
}

/** @deprecated Use RagKnowledgeRelationPageResult. */
export type RagGraphRelationPageResult = RagKnowledgeRelationPageResult;

export interface RagInspectInput {
  readonly tenantId: string;
  readonly namespaceId?: string;
  readonly principal: unknown;
}

export interface RagInspectDocumentInput extends RagInspectInput {
  readonly documentId: string;
}

export interface RagInspectChunkInput extends RagInspectInput {
  readonly chunkId: string;
}

export interface RagInspectListInput extends RagInspectInput {
  readonly filters?: unknown;
}

export interface RagInspectTraceSummary {
  readonly runId: string;
  readonly traceId: string;
  readonly status: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly retrievalId?: string;
  readonly contextId?: string;
  readonly generationId?: string;
  readonly answerId?: string;
  readonly retrievedChunkIds: readonly string[];
  readonly rejectedChunkIds: readonly string[];
  readonly finalCitationChunkIds: readonly string[];
  readonly eventKinds: readonly string[];
  readonly eventCount: number;
}

export interface PlugAndPlayRagInspectApi {
  stats(): IndexStats;
  document(input: RagInspectDocumentInput): IndexedDocument | undefined;
  chunk(input: RagInspectChunkInput): IndexedChunk | undefined;
  documents(input: RagInspectListInput): readonly IndexedDocument[];
  chunks(input: RagInspectListInput): readonly IndexedChunk[];
  trace(trace: RagRunTrace): RagInspectTraceSummary;
}

export interface PlugAndPlayRag {
  readonly app: ProductionRagApp;
  readonly ingestRuntime: ProductionIngestRuntime;
  readonly knowledge: PlugAndPlayRagKnowledgeApi;
  /** @deprecated Use knowledge. */
  readonly graph: PlugAndPlayRagGraphApi;
  readonly inspect: PlugAndPlayRagInspectApi;
  query(input: ProductionRagAnswerInput): Promise<RagQueryResult>;
  answer(input: ProductionRagAnswerInput): Promise<ProductionRagAnswerResponse>;
  agent(input: RagLocalAgentInput): Promise<RagAgentResult>;
  ingest(input: RagLocalIngestInput): Promise<RagLocalIngestResponse>;
  health(): ProductionRagHealth;
  selfTest(options?: StartupSelfTestOptions): Promise<StartupSelfTestResult>;
}

export function createRag(options: CreateRagOptions): PlugAndPlayRag {
  const app = createProductionRagApp({
    ...options,
    ...(options.graph === undefined && options.knowledge !== undefined
      ? { graph: options.knowledge }
      : {})
  });
  const ingestRuntime = createProductionIngestRuntime({
    app,
    ...(options.ingestion ?? {})
  });
  const knowledge = {
    ingest: async (input) => {
      if (!app.runtime.ingestGraph) {
        throw new ProductionRagRequestError("Knowledge map ingestion is not configured.", 501);
      }

      return app.runtime.ingestGraph(input);
    },
    resolveEntities: (input) => {
      if (!app.runtime.resolveGraphEntities) {
        throw new ProductionRagRequestError(
          "Knowledge map entity resolution is not configured.",
          501
        );
      }

      return app.runtime.resolveGraphEntities(input);
    },
    importBatches: (input) => importGraphBatchesForApp(app, input),
    query: (input) => queryGraph(app, input),
    pageEntities: (input) => pageGraphEntities(app, input),
    pageRelations: (input) => pageGraphRelations(app, input)
  } satisfies PlugAndPlayRagKnowledgeApi;

  return {
    app,
    ingestRuntime,
    knowledge,
    graph: knowledge,
    inspect: {
      stats: () => requireSync(app.chunkStore.stats(), "inspect.stats"),
      document: (input) => {
        const filter = normalizeInspectFilter(app, input);
        return requireSync(
          app.chunkStore.getDocument(requiredString(input.documentId, "documentId"), filter),
          "inspect.document"
        );
      },
      chunk: (input) => {
        const filter = normalizeInspectFilter(app, input);
        return requireSync(
          app.chunkStore.getChunk(requiredString(input.chunkId, "chunkId"), filter),
          "inspect.chunk"
        );
      },
      documents: (input) =>
        requireSync(
          app.chunkStore.listDocuments(normalizeInspectFilter(app, input)),
          "inspect.documents"
        ),
      chunks: (input) =>
        requireSync(
          app.chunkStore.listChunks(normalizeInspectFilter(app, input)),
          "inspect.chunks"
        ),
      trace: summarizeTrace
    },
    query: (input) => app.runtime.query(normalizeLocalQueryInput(app, input)),
    answer: (input) => app.answer(input),
    agent: (input) => app.runtime.agent(normalizeLocalAgentInput(app, input)),
    ingest: async (input) => {
      const result = await ingestRuntime.ingest(input);
      const knowledgeIngest = input.knowledge ?? input.graph;
      if (knowledgeIngest?.enabled !== true) {
        return result;
      }

      if (!app.runtime.ingestGraph) {
        throw new ProductionRagRequestError("Knowledge map ingestion is not configured.", 501);
      }

      const approvalFilter =
        knowledgeIngest.approvalFilter === undefined
          ? normalizeIngestApprovalFilter(app, input)
          : normalizeKnowledgeApprovalFilter(app, input, knowledgeIngest.approvalFilter);
      const knowledgeResult = await app.runtime.ingestGraph({
        documents: result.artifacts.documents,
        chunks: result.artifacts.chunks,
        approvalFilter,
        ingestionId: knowledgeIngest.ingestionId ?? `${result.runId}_graph`,
        requestedAt: knowledgeIngest.requestedAt ?? result.startedAt
      });

      return {
        ...result,
        knowledge: knowledgeResult,
        graph: knowledgeResult
      };
    },
    health: () => app.health(),
    selfTest: (selfTestOptions) => app.selfTest(selfTestOptions)
  };
}

function importGraphBatchesForApp(
  app: ProductionRagApp,
  input: RagKnowledgeBatchImportInput
): Promise<GraphBatchImportResult> {
  if (!app.runtime.graphStore) {
    throw new ProductionRagRequestError("Knowledge map store is not configured.", 501);
  }

  return importGraphBatches({
    ...input,
    store: app.runtime.graphStore
  });
}

function queryGraph(app: ProductionRagApp, input: RagKnowledgeQueryInput): RagKnowledgeQueryResult {
  if (!app.runtime.graphStore) {
    throw new ProductionRagRequestError("Knowledge map store is not configured.", 501);
  }

  const filter = normalizeInspectFilter(app, input);
  const includeUnapproved = input.includeUnapproved === true;
  const limit = input.limit ?? filter.limit ?? 100;
  const entityName = input.entityName?.trim();
  const relationKinds = input.relationKinds;
  const matchedEntities =
    app.runtime.graphStore.queryEntities?.({
      filter,
      ...(input.entityId === undefined ? {} : { entityIds: [input.entityId] }),
      ...(entityName === undefined || entityName.length === 0 ? {} : { entityName }),
      limit
    }) ??
    app.runtime.graphStore
      .findEntities(filter)
      .filter((entity) => input.entityId === undefined || entity.id === input.entityId)
      .filter(
        (entity) =>
          entityName === undefined ||
          entityName.length === 0 ||
          entity.name.toLowerCase().includes(entityName.toLowerCase()) ||
          entity.normalizedName.toLowerCase().includes(entityName.toLowerCase()) ||
          (entity.aliases ?? []).some((alias) =>
            alias.toLowerCase().includes(entityName.toLowerCase())
          )
      )
      .slice(0, Math.max(0, limit));
  const entityIds =
    input.entityId !== undefined
      ? [input.entityId]
      : entityName !== undefined && entityName.length > 0
        ? matchedEntities.map((entity) => entity.id)
        : [undefined];
  const relations = uniqueRelations(
    entityIds.flatMap((entityId) =>
      app.runtime.graphStore!.findRelations({
        filter,
        ...(entityId === undefined ? {} : { entityId }),
        ...(relationKinds === undefined ? {} : { relationKinds }),
        includeUnapproved,
        limit
      })
    )
  ).slice(0, Math.max(0, limit));

  return {
    entities: matchedEntities,
    relations,
    trace: {
      entityCount: matchedEntities.length,
      relationCount: relations.length,
      includeUnapproved,
      ...(input.entityId === undefined ? {} : { entityId: input.entityId }),
      ...(entityName === undefined || entityName.length === 0 ? {} : { entityName }),
      ...(relationKinds === undefined ? {} : { relationKinds })
    }
  };
}

function pageGraphEntities(
  app: ProductionRagApp,
  input: RagKnowledgeEntityPageInput
): RagKnowledgeEntityPageResult {
  if (!app.runtime.graphStore) {
    throw new ProductionRagRequestError("Knowledge map store is not configured.", 501);
  }

  if (!app.runtime.graphStore.pageEntities) {
    throw new ProductionRagRequestError(
      "Knowledge map store does not support cursor pagination.",
      501
    );
  }

  const filter = normalizeInspectFilter(app, input);
  const entityName = input.entityName?.trim();
  const page = app.runtime.graphStore.pageEntities({
    filter,
    ...(input.entityIds === undefined ? {} : { entityIds: input.entityIds }),
    ...(entityName === undefined || entityName.length === 0 ? {} : { entityName }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.limit === undefined ? {} : { limit: input.limit })
  });

  return {
    entities: page.entities,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    trace: {
      entityCount: page.entities.length,
      hasNextPage: page.nextCursor !== undefined,
      ...(entityName === undefined || entityName.length === 0 ? {} : { entityName })
    }
  };
}

function pageGraphRelations(
  app: ProductionRagApp,
  input: RagKnowledgeRelationPageInput
): RagKnowledgeRelationPageResult {
  if (!app.runtime.graphStore) {
    throw new ProductionRagRequestError("Knowledge map store is not configured.", 501);
  }

  if (!app.runtime.graphStore.pageRelations) {
    throw new ProductionRagRequestError(
      "Knowledge map store does not support cursor pagination.",
      501
    );
  }

  const filter = normalizeInspectFilter(app, input);
  const includeUnapproved = input.includeUnapproved === true;
  const page = app.runtime.graphStore.pageRelations({
    filter,
    ...(input.entityId === undefined ? {} : { entityId: input.entityId }),
    ...(input.relationKinds === undefined ? {} : { relationKinds: input.relationKinds }),
    includeUnapproved,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.limit === undefined ? {} : { limit: input.limit })
  });

  return {
    relations: page.relations,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    trace: {
      relationCount: page.relations.length,
      hasNextPage: page.nextCursor !== undefined,
      includeUnapproved,
      ...(input.entityId === undefined ? {} : { entityId: input.entityId }),
      ...(input.relationKinds === undefined ? {} : { relationKinds: input.relationKinds })
    }
  };
}

function uniqueRelations(
  relations: readonly GraphRelationProposal[]
): readonly GraphRelationProposal[] {
  const seen = new Set<string>();
  const uniqueRelations: GraphRelationProposal[] = [];

  for (const relation of relations) {
    if (seen.has(relation.id)) {
      continue;
    }
    seen.add(relation.id);
    uniqueRelations.push(relation);
  }

  return uniqueRelations;
}

function normalizeInspectFilter(app: ProductionRagApp, input: RagInspectListInput): IndexFilter {
  const namespaceId = optionalString(input.namespaceId, "namespaceId") ?? app.profile.namespaceId;
  const tenantId = requiredString(input.tenantId, "tenantId");
  const principal = normalizePrincipal(input.principal, namespaceId, tenantId);

  return normalizeFilters(input.filters, namespaceId, tenantId, principal);
}

function summarizeTrace(trace: RagRunTrace): RagInspectTraceSummary {
  return {
    runId: trace.runId,
    traceId: trace.traceId,
    status: trace.status,
    profileId: trace.profileId,
    namespaceId: trace.namespaceId,
    ...(trace.retrievalId === undefined ? {} : { retrievalId: trace.retrievalId }),
    ...(trace.contextId === undefined ? {} : { contextId: trace.contextId }),
    ...(trace.generationId === undefined ? {} : { generationId: trace.generationId }),
    ...(trace.answerId === undefined ? {} : { answerId: trace.answerId }),
    retrievedChunkIds: trace.retrievedChunkIds,
    rejectedChunkIds: trace.rejectedChunkIds,
    finalCitationChunkIds: trace.finalCitations.map((citation) => citation.chunkId),
    eventKinds: trace.events.map((event) => event.kind),
    eventCount: trace.events.length
  };
}

function requireSync<T>(value: T | Promise<T>, operation: string): T {
  if (typeof (value as Promise<T>)?.then === "function") {
    throw new ProductionRagRequestError(
      `${operation} requires a synchronous index store. Use production HTTP/CLI inspection for async stores.`,
      501
    );
  }

  return value as T;
}

function normalizeIngestApprovalFilter(
  app: ProductionRagApp,
  input: ProductionRagIngestInput
): IndexFilter {
  const namespaceId = optionalString(input.namespaceId, "namespaceId") ?? app.profile.namespaceId;
  const tenantId = requiredString(input.tenantId, "tenantId");
  const principal = normalizePrincipal(input.principal, namespaceId, tenantId);

  return {
    namespaceId,
    tenantId,
    principal
  };
}

function normalizeKnowledgeApprovalFilter(
  app: ProductionRagApp,
  input: ProductionRagIngestInput,
  value: unknown
): IndexFilter {
  const namespaceId = optionalString(input.namespaceId, "namespaceId") ?? app.profile.namespaceId;
  const tenantId = requiredString(input.tenantId, "tenantId");
  const principal = normalizePrincipal(input.principal, namespaceId, tenantId);

  return normalizeFilters(value, namespaceId, tenantId, principal);
}

function normalizeLocalQueryInput(
  app: ProductionRagApp,
  input: ProductionRagAnswerInput
): Parameters<ProductionRagApp["runtime"]["query"]>[0] {
  if (!isRecord(input)) {
    throw new ProductionRagRequestError("Query request must be a JSON object.");
  }

  const namespaceId = optionalString(input.namespaceId, "namespaceId") ?? app.profile.namespaceId;
  const tenantId = requiredString(input.tenantId, "tenantId");
  const principal = normalizePrincipal(input.principal, namespaceId, tenantId);
  const filter = normalizeFilters(input.filters, namespaceId, tenantId, principal);
  const question = requiredString(input.question, "question");
  const topK = optionalPositiveInteger(input.topK, "topK");
  const candidatePoolLimit = optionalPositiveInteger(
    input.candidatePoolLimit,
    "candidatePoolLimit"
  );
  const includeRejected = optionalBoolean(input.includeRejected, "includeRejected");
  const requestedAt = optionalString(input.requestedAt, "requestedAt");
  const runId = optionalString(input.runId, "runId");
  const traceId = optionalString(input.traceId, "traceId");

  return {
    question,
    filter,
    ...(topK === undefined ? {} : { topK }),
    ...(candidatePoolLimit === undefined ? {} : { candidatePoolLimit }),
    ...(includeRejected === undefined ? {} : { includeRejected }),
    ...(requestedAt === undefined ? {} : { requestedAt }),
    ...(runId === undefined ? {} : { runId }),
    ...(traceId === undefined ? {} : { traceId })
  };
}

function normalizeLocalAgentInput(
  app: ProductionRagApp,
  input: RagLocalAgentInput
): Parameters<ProductionRagApp["runtime"]["agent"]>[0] {
  if (!isRecord(input)) {
    throw new ProductionRagRequestError("Agent request must be a JSON object.");
  }

  const namespaceId = optionalString(input.namespaceId, "namespaceId") ?? app.profile.namespaceId;
  const tenantId = requiredString(input.tenantId, "tenantId");
  const principal = normalizePrincipal(input.principal, namespaceId, tenantId);
  const filter = normalizeFilters(input.filters, namespaceId, tenantId, principal);
  const question = requiredString(input.question, "question");
  const topK = optionalPositiveInteger(input.topK, "topK");
  const candidatePoolLimit = optionalPositiveInteger(
    input.candidatePoolLimit,
    "candidatePoolLimit"
  );
  const includeRejected = optionalBoolean(input.includeRejected, "includeRejected");
  const requestedAt = optionalString(input.requestedAt, "requestedAt");
  const runId = optionalString(input.runId, "runId");
  const traceId = optionalString(input.traceId, "traceId");
  const maxSteps = optionalPositiveInteger(input.maxSteps, "maxSteps");
  const retryWhenEvidenceInsufficient = optionalBoolean(
    input.retryWhenEvidenceInsufficient,
    "retryWhenEvidenceInsufficient"
  );

  return {
    question,
    filter,
    ...(topK === undefined ? {} : { topK }),
    ...(candidatePoolLimit === undefined ? {} : { candidatePoolLimit }),
    ...(includeRejected === undefined ? {} : { includeRejected }),
    ...(requestedAt === undefined ? {} : { requestedAt }),
    ...(runId === undefined ? {} : { runId }),
    ...(traceId === undefined ? {} : { traceId }),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(retryWhenEvidenceInsufficient === undefined ? {} : { retryWhenEvidenceInsufficient })
  };
}

function normalizePrincipal(
  value: unknown,
  namespaceId: string,
  tenantId: string
): IndexFilter["principal"] {
  if (!isRecord(value)) {
    throw new ProductionRagRequestError("principal must be a JSON object.");
  }

  const principal = {
    userId: requiredString(value["userId"], "principal.userId"),
    tenantId: requiredString(value["tenantId"], "principal.tenantId"),
    namespaceIds: requiredStringArray(value["namespaceIds"], "principal.namespaceIds"),
    teamIds: optionalStringArray(value["teamIds"], "principal.teamIds") ?? [],
    roles: optionalStringArray(value["roles"], "principal.roles") ?? [],
    tags: optionalStringArray(value["tags"], "principal.tags") ?? []
  };

  if (principal.tenantId !== tenantId) {
    throw new ProductionRagRequestError("principal.tenantId must match tenantId.");
  }

  if (!principal.namespaceIds.includes(namespaceId)) {
    throw new ProductionRagRequestError("principal.namespaceIds must include namespaceId.");
  }

  return principal;
}

function normalizeFilters(
  value: unknown,
  namespaceId: string,
  tenantId: string,
  principal: IndexFilter["principal"]
): IndexFilter {
  if (value !== undefined && !isRecord(value)) {
    throw new ProductionRagRequestError("filters must be a JSON object when provided.");
  }

  const filters = value && isRecord(value) ? value : {};
  const documentIds = optionalStringArray(filters["documentIds"], "filters.documentIds");
  const chunkIds = optionalStringArray(filters["chunkIds"], "filters.chunkIds");
  const sourceIds = optionalStringArray(filters["sourceIds"], "filters.sourceIds");
  const sourceKinds = optionalStringArray(filters["sourceKinds"], "filters.sourceKinds");
  const trustTiers = optionalStringArray(filters["trustTiers"], "filters.trustTiers");
  const includeSafetyFlags = optionalStringArray(
    filters["includeSafetyFlags"],
    "filters.includeSafetyFlags"
  );
  const excludeSafetyFlags = optionalStringArray(
    filters["excludeSafetyFlags"],
    "filters.excludeSafetyFlags"
  );
  const accessTags = optionalStringArray(filters["accessTags"], "filters.accessTags");
  const limit = optionalPositiveInteger(filters["limit"], "filters.limit");

  return {
    namespaceId,
    tenantId,
    principal,
    ...(documentIds === undefined ? {} : { documentIds }),
    ...(chunkIds === undefined ? {} : { chunkIds }),
    ...(sourceIds === undefined ? {} : { sourceIds }),
    ...(sourceKinds === undefined
      ? {}
      : { sourceKinds: sourceKinds as NonNullable<IndexFilter["sourceKinds"]> }),
    ...(trustTiers === undefined
      ? {}
      : { trustTiers: trustTiers as NonNullable<IndexFilter["trustTiers"]> }),
    ...(includeSafetyFlags === undefined
      ? {}
      : {
          includeSafetyFlags: includeSafetyFlags as NonNullable<IndexFilter["includeSafetyFlags"]>
        }),
    ...(excludeSafetyFlags === undefined
      ? {}
      : {
          excludeSafetyFlags: excludeSafetyFlags as NonNullable<IndexFilter["excludeSafetyFlags"]>
        }),
    ...(accessTags === undefined ? {} : { accessTags }),
    ...(limit === undefined ? {} : { limit })
  };
}

function requiredString(value: unknown, pathName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProductionRagRequestError(`${pathName} must be a non-empty string.`);
  }

  return value;
}

function optionalString(value: unknown, pathName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requiredString(value, pathName);
}

function requiredStringArray(value: unknown, pathName: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProductionRagRequestError(`${pathName} must be a non-empty string array.`);
  }

  return value.map((item, index) => requiredString(item, `${pathName}[${index}]`));
}

function optionalStringArray(value: unknown, pathName: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requiredStringArray(value, pathName);
}

function optionalPositiveInteger(value: unknown, pathName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ProductionRagRequestError(`${pathName} must be a positive integer.`);
  }

  return value;
}

function optionalBoolean(value: unknown, pathName: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new ProductionRagRequestError(`${pathName} must be a boolean.`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
