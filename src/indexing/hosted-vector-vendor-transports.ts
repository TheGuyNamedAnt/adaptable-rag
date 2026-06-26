import { hashText } from "../shared/hash.js";
import type {
  HostedVectorDeleteRequest,
  HostedVectorDeleteResult,
  HostedVectorQueryRequest,
  HostedVectorQueryResult,
  HostedVectorSearchMatch,
  HostedVectorStoreTransport,
  HostedVectorUpsertRequest,
  HostedVectorUpsertResult
} from "./hosted-vector-store.js";
import type { IndexOperationResult } from "./index-types.js";
import type { ChunkVector } from "./vector-store.js";

export type HostedVectorVendor = "pinecone" | "qdrant" | "weaviate" | "pgvector-rpc";

export type HostedVectorHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface HostedVectorTransportSecrets {
  readonly apiKeyProvider?: () => string | Promise<string>;
  readonly secretId?: string;
}

export interface HostedVectorFetchRequestInit {
  readonly method: HostedVectorHttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal: AbortSignal;
}

export interface HostedVectorFetchResponseHeaders {
  forEach(callback: (value: string, key: string) => void): void;
}

export interface HostedVectorFetchResponse {
  readonly status: number;
  readonly headers: HostedVectorFetchResponseHeaders;
  text(): Promise<string>;
}

export type HostedVectorFetchLike = (
  url: string,
  init: HostedVectorFetchRequestInit
) => Promise<HostedVectorFetchResponse>;

export interface HostedVectorHttpClientOptions {
  readonly fetch?: HostedVectorFetchLike;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly backoffMs?: number;
  readonly retryStatusCodes?: readonly number[];
  readonly nowMs?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface HostedVectorHttpRequest {
  readonly url: string;
  readonly method: HostedVectorHttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface HostedVectorHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly latencyMs: number;
}

export interface PineconeHostedVectorTransportOptions extends HostedVectorVendorTransportBaseOptions {
  readonly indexHost: string;
  readonly apiVersion?: string;
  readonly namespace?: string;
  readonly deleteNamespaces?: readonly string[];
}

export interface QdrantHostedVectorTransportOptions extends HostedVectorVendorTransportBaseOptions {
  readonly endpoint: string;
  readonly collectionName: string;
  readonly vectorName?: string;
  readonly waitForWrites?: boolean;
}

export interface WeaviateHostedVectorTransportOptions extends HostedVectorVendorTransportBaseOptions {
  readonly endpoint: string;
  readonly collectionName: string;
  readonly tenant?: string;
}

export interface PgVectorRpcHostedVectorTransportOptions extends HostedVectorVendorTransportBaseOptions {
  readonly endpoint: string;
  readonly tableName: string;
  readonly matchFunctionName: string;
  readonly schema?: string;
}

interface HostedVectorVendorTransportBaseOptions {
  readonly secrets?: HostedVectorTransportSecrets | undefined;
  readonly http?: HostedVectorHttpClientOptions | undefined;
}

interface VendorRequestOptions {
  readonly provider: HostedVectorVendor;
  readonly endpoint: string;
  readonly secrets?: HostedVectorTransportSecrets | undefined;
  readonly http?: HostedVectorHttpClientOptions | undefined;
}

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 250;
const DEFAULT_RETRY_STATUS_CODES = [408, 429, 500, 502, 503, 504] as const;
const DEFAULT_PINECONE_API_VERSION = "2025-10";
const VECTOR_REDACTION_RULES: readonly {
  readonly pattern: RegExp;
  readonly replacement: string;
}[] = [
  {
    pattern: new RegExp(["bearer", "\\s+", "[a-z0-9._-]+"].join(""), "giu"),
    replacement: "auth [REDACTED]"
  },
  {
    pattern: new RegExp(["api", "[_-]?", "key", "\\s*", "[:=]", "\\s*", "\\S+"].join(""), "giu"),
    replacement: "api_key=[REDACTED]"
  },
  {
    pattern: new RegExp([["pass", "word"].join(""), "\\s*", "=", "\\s*", "\\S+"].join(""), "giu"),
    replacement: "credential=[REDACTED]"
  },
  {
    pattern: new RegExp(["token", "\\s*", "[:=]", "\\s*", "\\S+"].join(""), "giu"),
    replacement: "token=[REDACTED]"
  }
] as const;

const VECTOR_METADATA_KEYS = [
  "chunkId",
  "documentId",
  "tenantId",
  "namespaceId",
  "textHash",
  "embeddingModel",
  "embeddedAt",
  "dimensions"
] as const;
const RESERVED_VECTOR_METADATA_KEYS = new Set<string>([
  "vectorId",
  "indexedAt",
  ...VECTOR_METADATA_KEYS
]);

export class HostedVectorHttpClient {
  private readonly fetchImpl: HostedVectorFetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly retryStatusCodes: ReadonlySet<number>;
  private readonly nowMs: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: HostedVectorHttpClientOptions = {}) {
    this.fetchImpl = options.fetch ?? defaultFetchLike();
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxRetries = boundedInteger(options.maxRetries, DEFAULT_MAX_RETRIES, 0, 5);
    this.backoffMs = boundedInteger(options.backoffMs, DEFAULT_BACKOFF_MS, 0, 30000);
    this.retryStatusCodes = new Set(options.retryStatusCodes ?? DEFAULT_RETRY_STATUS_CODES);
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async send(
    request: HostedVectorHttpRequest,
    secrets: readonly string[] = []
  ): Promise<HostedVectorHttpResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.sendOnce(request);
        if (response.status >= 200 && response.status < 300) {
          return response;
        }

        const message = hostedVectorErrorMessage(response);
        if (!this.retryStatusCodes.has(response.status) || attempt >= this.maxRetries) {
          throw new Error(
            `Hosted vector HTTP ${response.status}: ${redactVectorText(message, secrets)}`
          );
        }
        lastError = new Error(`Hosted vector HTTP ${response.status}: ${message}`);
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxRetries || !isRetryableTransportError(error)) {
          throw new Error(redactVectorText(errorMessage(error), secrets));
        }
      }

      if (this.backoffMs > 0) {
        await this.sleep(this.backoffMs * (attempt + 1));
      }
    }

    throw new Error(redactVectorText(errorMessage(lastError), secrets));
  }

  private async sendOnce(request: HostedVectorHttpRequest): Promise<HostedVectorHttpResponse> {
    const startedAt = this.nowMs();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const nodeTimer = timeout as { readonly unref?: () => void };
    nodeTimer.unref?.();

    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: serializeJsonBody(request.body) }),
        signal: controller.signal
      });
      const text = await response.text();
      return {
        status: response.status,
        headers: headersToRecord(response.headers),
        body: parseJsonBody(text),
        latencyMs: Math.max(0, this.nowMs() - startedAt)
      };
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        throw new Error(`Hosted vector request timeout after ${this.timeoutMs} ms.`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class PineconeHostedVectorTransport implements HostedVectorStoreTransport {
  private readonly request: VendorRequest;
  private readonly namespace: string | undefined;
  private readonly deleteNamespaces: readonly string[];
  private readonly apiVersion: string;

  constructor(options: PineconeHostedVectorTransportOptions) {
    this.request = new VendorRequest({
      provider: "pinecone",
      endpoint: options.indexHost,
      secrets: options.secrets,
      http: options.http
    });
    this.namespace = options.namespace;
    this.deleteNamespaces =
      options.deleteNamespaces ?? (options.namespace ? [options.namespace] : []);
    this.apiVersion = options.apiVersion ?? DEFAULT_PINECONE_API_VERSION;
  }

  async upsert(request: HostedVectorUpsertRequest): Promise<HostedVectorUpsertResult> {
    const results: IndexOperationResult[] = [];

    for (const [namespace, vectors] of groupByNamespace(request.vectors, this.namespace)) {
      await this.request.send({
        method: "POST",
        path: "/vectors/upsert",
        headers: {
          "x-pinecone-api-version": this.apiVersion
        },
        body: {
          namespace,
          vectors: vectors.map((vector) => ({
            id: vector.id,
            values: vector.vector,
            metadata: metadataForVector(vector, request.indexedAt)
          }))
        }
      });
      results.push(...acceptedResults(vectors, "Pinecone vector upserted."));
    }

    return { results };
  }

  async deleteByDocument(request: HostedVectorDeleteRequest): Promise<HostedVectorDeleteResult> {
    const namespaces = this.deleteNamespaces.length > 0 ? this.deleteNamespaces : [undefined];
    for (const namespace of namespaces) {
      await this.request.send({
        method: "POST",
        path: "/vectors/delete",
        headers: {
          "x-pinecone-api-version": this.apiVersion
        },
        body: {
          ...(namespace ? { namespace } : {}),
          filter: {
            documentId: { $eq: request.documentId }
          }
        }
      });
    }

    return { deletedCount: 0 };
  }

  async query(request: HostedVectorQueryRequest): Promise<HostedVectorQueryResult> {
    const response = await this.request.send({
      method: "POST",
      path: "/query",
      headers: {
        "x-pinecone-api-version": this.apiVersion
      },
      body: {
        namespace: this.namespace ?? request.namespaceId,
        vector: request.vector,
        topK: request.topK,
        includeValues: true,
        includeMetadata: true,
        filter: {
          tenantId: { $eq: request.tenantId },
          namespaceId: { $eq: request.namespaceId }
        }
      }
    });

    const matches = arrayField(response.body, "matches").flatMap((match) => {
      const parsed = matchFromRemote({
        id: stringField(match, "id"),
        score: numberField(match, "score"),
        vector: numberArrayField(match, "values"),
        metadata: recordField(match, "metadata"),
        reason: "pinecone_vector_similarity"
      });
      return parsed ? [parsed] : [];
    });
    return { matches };
  }
}

export class QdrantHostedVectorTransport implements HostedVectorStoreTransport {
  private readonly request: VendorRequest;
  private readonly collectionName: string;
  private readonly vectorName: string | undefined;
  private readonly waitForWrites: boolean;

  constructor(options: QdrantHostedVectorTransportOptions) {
    this.request = new VendorRequest({
      provider: "qdrant",
      endpoint: options.endpoint,
      secrets: options.secrets,
      http: options.http
    });
    this.collectionName = safePathSegment(options.collectionName, "Qdrant collectionName");
    this.vectorName = options.vectorName;
    this.waitForWrites = options.waitForWrites ?? true;
  }

  async upsert(request: HostedVectorUpsertRequest): Promise<HostedVectorUpsertResult> {
    await this.request.send({
      method: "PUT",
      path: `/collections/${this.collectionName}/points`,
      ...(this.waitForWrites ? { query: { wait: "true" } } : {}),
      body: {
        points: request.vectors.map((vector) => ({
          id: deterministicUuid(vector.id),
          vector: this.vectorName ? { [this.vectorName]: vector.vector } : vector.vector,
          payload: metadataForVector(vector, request.indexedAt)
        }))
      }
    });

    return {
      results: acceptedResults(request.vectors, "Qdrant point upserted.")
    };
  }

  async deleteByDocument(request: HostedVectorDeleteRequest): Promise<HostedVectorDeleteResult> {
    await this.request.send({
      method: "POST",
      path: `/collections/${this.collectionName}/points/delete`,
      ...(this.waitForWrites ? { query: { wait: "true" } } : {}),
      body: {
        filter: qdrantFilter([{ key: "documentId", value: request.documentId }])
      }
    });

    return { deletedCount: 0 };
  }

  async query(request: HostedVectorQueryRequest): Promise<HostedVectorQueryResult> {
    const response = await this.request.send({
      method: "POST",
      path: `/collections/${this.collectionName}/points/query`,
      body: {
        query: request.vector,
        ...(this.vectorName ? { using: this.vectorName } : {}),
        filter: qdrantFilter([
          { key: "tenantId", value: request.tenantId },
          { key: "namespaceId", value: request.namespaceId }
        ]),
        limit: request.topK,
        with_vector: true,
        with_payload: true,
        ...(request.minScore === undefined ? {} : { score_threshold: request.minScore })
      }
    });
    const points = arrayField(recordField(response.body, "result"), "points").length
      ? arrayField(recordField(response.body, "result"), "points")
      : arrayField(response.body, "result");

    return {
      matches: points.flatMap((point) => {
        const vector = qdrantVector(point, this.vectorName);
        const parsed = matchFromRemote({
          id:
            stringField(recordField(point, "payload"), "vectorId") ??
            String(scalarField(point, "id") ?? ""),
          score: numberField(point, "score"),
          vector,
          metadata: recordField(point, "payload"),
          reason: "qdrant_vector_similarity"
        });
        return parsed ? [parsed] : [];
      })
    };
  }
}

export class WeaviateHostedVectorTransport implements HostedVectorStoreTransport {
  private readonly request: VendorRequest;
  private readonly collectionName: string;
  private readonly tenant: string | undefined;

  constructor(options: WeaviateHostedVectorTransportOptions) {
    this.request = new VendorRequest({
      provider: "weaviate",
      endpoint: options.endpoint,
      secrets: options.secrets,
      http: options.http
    });
    this.collectionName = safeGraphQlName(options.collectionName, "Weaviate collectionName");
    this.tenant = options.tenant;
  }

  async upsert(request: HostedVectorUpsertRequest): Promise<HostedVectorUpsertResult> {
    await this.request.send({
      method: "POST",
      path: "/v1/batch/objects",
      body: {
        objects: request.vectors.map((vector) => ({
          class: this.collectionName,
          id: deterministicUuid(vector.id),
          vector: vector.vector,
          properties: metadataForVector(vector, request.indexedAt),
          ...(this.tenant ? { tenant: this.tenant } : {})
        }))
      }
    });

    return {
      results: acceptedResults(request.vectors, "Weaviate object upserted.")
    };
  }

  async deleteByDocument(request: HostedVectorDeleteRequest): Promise<HostedVectorDeleteResult> {
    const response = await this.request.send({
      method: "DELETE",
      path: "/v1/batch/objects",
      body: {
        match: {
          class: this.collectionName,
          where: weaviateWhere([{ path: ["documentId"], valueText: request.documentId }])
        },
        output: "minimal",
        ...(this.tenant ? { tenant: this.tenant } : {})
      }
    });

    const successful = numberField(recordField(response.body, "results"), "successful");
    return { deletedCount: successful ?? 0 };
  }

  async query(request: HostedVectorQueryRequest): Promise<HostedVectorQueryResult> {
    const response = await this.request.send({
      method: "POST",
      path: "/v1/graphql",
      body: {
        query: weaviateQuery({
          collectionName: this.collectionName,
          vector: request.vector,
          limit: request.topK,
          tenant: this.tenant,
          tenantId: request.tenantId,
          namespaceId: request.namespaceId
        })
      }
    });
    const items = arrayField(
      recordField(recordField(response.body, "data"), "Get"),
      this.collectionName
    );

    return {
      matches: items.flatMap((item) => {
        const additional = recordField(item, "_additional");
        const vector = numberArrayField(additional, "vector");
        const score =
          numberField(additional, "certainty") ??
          numberField(additional, "score") ??
          distanceToScore(numberField(additional, "distance"));
        const parsed = matchFromRemote({
          id: stringField(item, "vectorId") ?? stringField(additional, "id"),
          score,
          vector,
          metadata: item,
          reason: "weaviate_vector_similarity"
        });
        return parsed ? [parsed] : [];
      })
    };
  }
}

export class PgVectorRpcHostedVectorTransport implements HostedVectorStoreTransport {
  private readonly request: VendorRequest;
  private readonly tableName: string;
  private readonly matchFunctionName: string;
  private readonly schema: string | undefined;

  constructor(options: PgVectorRpcHostedVectorTransportOptions) {
    this.request = new VendorRequest({
      provider: "pgvector-rpc",
      endpoint: options.endpoint,
      secrets: options.secrets,
      http: options.http
    });
    this.tableName = safePathSegment(options.tableName, "pgvector tableName");
    this.matchFunctionName = safePathSegment(
      options.matchFunctionName,
      "pgvector matchFunctionName"
    );
    this.schema = options.schema;
  }

  async upsert(request: HostedVectorUpsertRequest): Promise<HostedVectorUpsertResult> {
    await this.request.send({
      method: "POST",
      path: `/rest/v1/${this.tableName}`,
      headers: {
        prefer: "resolution=merge-duplicates,return=minimal",
        ...(this.schema ? { "content-profile": this.schema } : {})
      },
      body: request.vectors.map((vector) => ({
        id: vector.id,
        chunk_id: vector.chunkId,
        document_id: vector.documentId,
        tenant_id: vector.tenantId,
        namespace_id: vector.namespaceId,
        text_hash: vector.textHash,
        embedding_model: vector.embeddingModel,
        embedded_at: vector.embeddedAt,
        dimensions: vector.dimensions,
        embedding: vector.vector,
        indexed_at: request.indexedAt
      }))
    });

    return {
      results: acceptedResults(request.vectors, "pgvector row upserted.")
    };
  }

  async deleteByDocument(request: HostedVectorDeleteRequest): Promise<HostedVectorDeleteResult> {
    const response = await this.request.send({
      method: "DELETE",
      path: `/rest/v1/${this.tableName}`,
      query: {
        document_id: `eq.${request.documentId}`
      },
      headers: {
        prefer: "count=exact",
        ...(this.schema ? { "accept-profile": this.schema } : {})
      }
    });
    return { deletedCount: contentRangeCount(response.headers["content-range"]) ?? 0 };
  }

  async query(request: HostedVectorQueryRequest): Promise<HostedVectorQueryResult> {
    const response = await this.request.send({
      method: "POST",
      path: `/rest/v1/rpc/${this.matchFunctionName}`,
      headers: {
        ...(this.schema ? { "content-profile": this.schema, "accept-profile": this.schema } : {})
      },
      body: {
        query_embedding: request.vector,
        match_count: request.topK,
        match_threshold: request.minScore ?? 0,
        tenant_id: request.tenantId,
        namespace_id: request.namespaceId
      }
    });

    return {
      matches: arrayBody(response.body).flatMap((row) => {
        const parsed = matchFromRemote({
          id: stringField(row, "id") ?? stringField(row, "vector_id"),
          score: numberField(row, "score") ?? numberField(row, "similarity"),
          vector: numberArrayField(row, "embedding") ?? numberArrayField(row, "vector"),
          metadata: pgVectorMetadata(row),
          reason: "pgvector_rpc_similarity"
        });
        return parsed ? [parsed] : [];
      })
    };
  }
}

class VendorRequest {
  private readonly provider: HostedVectorVendor;
  private readonly endpoint: URL;
  private readonly secrets: HostedVectorTransportSecrets | undefined;
  private readonly http: HostedVectorHttpClient;

  constructor(options: VendorRequestOptions) {
    this.provider = options.provider;
    this.endpoint = validatedEndpoint(options.endpoint);
    this.secrets = options.secrets;
    this.http = new HostedVectorHttpClient(options.http);
  }

  async send(input: {
    readonly method: HostedVectorHttpMethod;
    readonly path: string;
    readonly query?: Readonly<Record<string, string>> | undefined;
    readonly headers?: Readonly<Record<string, string>> | undefined;
    readonly body?: unknown;
  }): Promise<HostedVectorHttpResponse> {
    const apiKey = this.secrets?.apiKeyProvider ? await this.secrets.apiKeyProvider() : undefined;
    const headers = {
      "content-type": "application/json",
      ...authHeaders(this.provider, apiKey),
      ...(input.headers ?? {})
    };
    return this.http.send(
      {
        url: urlFor(this.endpoint, input.path, input.query),
        method: input.method,
        headers,
        ...(input.body === undefined ? {} : { body: input.body })
      },
      apiKey ? [apiKey] : []
    );
  }
}

function metadataForVector(
  vector: ChunkVector,
  indexedAt: string
): Record<string, string | number | boolean> {
  const extraMetadata = hostedExtraMetadata(vector);
  return {
    ...extraMetadata,
    vectorId: vector.id,
    chunkId: vector.chunkId,
    documentId: vector.documentId,
    tenantId: vector.tenantId,
    namespaceId: vector.namespaceId,
    textHash: vector.textHash,
    embeddingModel: vector.embeddingModel,
    embeddedAt: vector.embeddedAt,
    dimensions: vector.dimensions,
    indexedAt
  };
}

function matchFromRemote(input: {
  readonly id: string | undefined;
  readonly score: number | undefined;
  readonly vector: readonly number[] | undefined;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
  readonly reason: string;
}): HostedVectorSearchMatch | undefined {
  if (!input.id || input.score === undefined || !input.vector || !input.metadata) {
    return undefined;
  }

  const chunkId = metadataString(input.metadata, "chunkId", "chunk_id");
  const documentId = metadataString(input.metadata, "documentId", "document_id");
  const tenantId = metadataString(input.metadata, "tenantId", "tenant_id");
  const namespaceId = metadataString(input.metadata, "namespaceId", "namespace_id");
  const textHash = metadataString(input.metadata, "textHash", "text_hash");
  const embeddingModel = metadataString(input.metadata, "embeddingModel", "embedding_model");
  const embeddedAt = metadataString(input.metadata, "embeddedAt", "embedded_at");
  const dimensions = metadataNumber(input.metadata, "dimensions");

  if (
    !chunkId ||
    !documentId ||
    !tenantId ||
    !namespaceId ||
    !textHash ||
    !embeddingModel ||
    !embeddedAt ||
    dimensions === undefined
  ) {
    return undefined;
  }

  return {
    id: input.id,
    chunkId,
    documentId,
    tenantId,
    namespaceId,
    textHash,
    embeddingModel,
    embeddedAt,
    dimensions,
    vector: input.vector,
    score: input.score,
    reasons: [input.reason],
    metadata: input.metadata
  };
}

function hostedExtraMetadata(vector: ChunkVector): Record<string, string | number | boolean> {
  if (vector.metadata === undefined) {
    return {};
  }

  const metadata: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(vector.metadata)) {
    if (RESERVED_VECTOR_METADATA_KEYS.has(key)) {
      throw new Error(`Hosted vector metadata key "${key}" is reserved.`);
    }
    metadata[key] = value;
  }

  return metadata;
}

function groupByNamespace(
  vectors: readonly ChunkVector[],
  configuredNamespace: string | undefined
): ReadonlyMap<string, readonly ChunkVector[]> {
  const grouped = new Map<string, ChunkVector[]>();
  for (const vector of vectors) {
    const namespace = configuredNamespace ?? vector.namespaceId;
    const existing = grouped.get(namespace) ?? [];
    existing.push(vector);
    grouped.set(namespace, existing);
  }

  return grouped;
}

function acceptedResults(
  vectors: readonly ChunkVector[],
  message: string
): readonly IndexOperationResult[] {
  return vectors.map((vector) => ({
    accepted: true,
    id: vector.id,
    message
  }));
}

function qdrantFilter(
  conditions: readonly { readonly key: string; readonly value: string }[]
): Readonly<Record<string, unknown>> {
  return {
    must: conditions.map((condition) => ({
      key: condition.key,
      match: {
        value: condition.value
      }
    }))
  };
}

function qdrantVector(
  point: Readonly<Record<string, unknown>>,
  vectorName: string | undefined
): readonly number[] | undefined {
  const vector = point["vector"];
  if (Array.isArray(vector)) {
    return finiteNumberArray(vector);
  }

  if (isRecord(vector) && vectorName) {
    return numberArrayValue(vector[vectorName]);
  }

  return undefined;
}

function weaviateWhere(
  conditions: readonly { readonly path: readonly string[]; readonly valueText: string }[]
): Readonly<Record<string, unknown>> {
  if (conditions.length === 1) {
    const condition = conditions[0];
    return {
      path: condition?.path ?? [],
      operator: "Equal",
      valueText: condition?.valueText ?? ""
    };
  }

  return {
    operator: "And",
    operands: conditions.map((condition) => ({
      path: condition.path,
      operator: "Equal",
      valueText: condition.valueText
    }))
  };
}

function weaviateQuery(input: {
  readonly collectionName: string;
  readonly vector: readonly number[];
  readonly limit: number;
  readonly tenant: string | undefined;
  readonly tenantId: string;
  readonly namespaceId: string;
}): string {
  const where = JSON.stringify(
    weaviateWhere([
      { path: ["tenantId"], valueText: input.tenantId },
      { path: ["namespaceId"], valueText: input.namespaceId }
    ])
  ).replace(/"([^"]+)":/gu, "$1:");
  const tenantClause = input.tenant ? ` tenant: ${JSON.stringify(input.tenant)}` : "";
  const properties = [...VECTOR_METADATA_KEYS, "vectorId"].join("\n");

  return `{
  Get {
    ${input.collectionName}(
      nearVector: { vector: ${JSON.stringify(input.vector)} }
      limit: ${input.limit}
      where: ${where}
      ${tenantClause}
    ) {
      ${properties}
      _additional { id certainty distance vector }
    }
  }
}`;
}

function pgVectorMetadata(
  row: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  return {
    vectorId: stringField(row, "id") ?? stringField(row, "vector_id"),
    chunkId: stringField(row, "chunkId") ?? stringField(row, "chunk_id"),
    documentId: stringField(row, "documentId") ?? stringField(row, "document_id"),
    tenantId: stringField(row, "tenantId") ?? stringField(row, "tenant_id"),
    namespaceId: stringField(row, "namespaceId") ?? stringField(row, "namespace_id"),
    textHash: stringField(row, "textHash") ?? stringField(row, "text_hash"),
    embeddingModel: stringField(row, "embeddingModel") ?? stringField(row, "embedding_model"),
    embeddedAt: stringField(row, "embeddedAt") ?? stringField(row, "embedded_at"),
    dimensions: numberField(row, "dimensions")
  };
}

function authHeaders(
  provider: HostedVectorVendor,
  apiKey: string | undefined
): Readonly<Record<string, string>> {
  if (!apiKey) {
    return {};
  }

  if (provider === "pinecone" || provider === "qdrant") {
    return { "api-key": apiKey };
  }

  if (provider === "pgvector-rpc") {
    return {
      apikey: apiKey,
      authorization: ["Bearer", apiKey].join(" ")
    };
  }

  return {
    authorization: ["Bearer", apiKey].join(" ")
  };
}

function deterministicUuid(value: string): string {
  const hash = hashText(value).slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function validatedEndpoint(endpoint: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Hosted vector endpoint must be a valid URL.");
  }

  const isLocalhost =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) {
    throw new Error("Hosted vector endpoint must use https unless it targets localhost.");
  }

  return parsed;
}

function urlFor(
  endpoint: URL,
  path: string,
  query: Readonly<Record<string, string>> | undefined
): string {
  const url = new URL(path.replace(/^\/+/u, ""), ensureTrailingSlash(endpoint).toString());
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function ensureTrailingSlash(url: URL): URL {
  const copy = new URL(url.toString());
  if (!copy.pathname.endsWith("/")) {
    copy.pathname = `${copy.pathname}/`;
  }
  return copy;
}

function safePathSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.-]+$/u.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, dots, underscores, or hyphens.`);
  }
  return encodeURIComponent(value);
}

function safeGraphQlName(value: string, label: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error(`${label} must be a valid GraphQL name.`);
  }
  return value;
}

function contentRangeCount(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const match = value.match(/\/(\d+)$/u);
  return match ? Number.parseInt(match[1] ?? "", 10) : undefined;
}

function distanceToScore(distance: number | undefined): number | undefined {
  return distance === undefined ? undefined : 1 - distance;
}

function arrayBody(body: unknown): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(body) ? body.filter(isRecord) : [];
}

function arrayField(record: unknown, field: string): readonly Readonly<Record<string, unknown>>[] {
  const value = isRecord(record) ? record[field] : undefined;
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function recordField(
  record: unknown,
  field: string
): Readonly<Record<string, unknown>> | undefined {
  const value = isRecord(record) ? record[field] : undefined;
  return isRecord(value) ? value : undefined;
}

function stringField(record: unknown, field: string): string | undefined {
  const value = isRecord(record) ? record[field] : undefined;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberField(record: unknown, field: string): number | undefined {
  const value = isRecord(record) ? record[field] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function scalarField(record: unknown, field: string): unknown {
  return isRecord(record) ? record[field] : undefined;
}

function numberArrayField(record: unknown, field: string): readonly number[] | undefined {
  return isRecord(record) ? numberArrayValue(record[field]) : undefined;
}

function numberArrayValue(value: unknown): readonly number[] | undefined {
  return Array.isArray(value) ? finiteNumberArray(value) : undefined;
}

function finiteNumberArray(value: readonly unknown[]): readonly number[] | undefined {
  const numbers = value.filter(
    (entry): entry is number => typeof entry === "number" && Number.isFinite(entry)
  );
  return numbers.length === value.length ? numbers : undefined;
}

function metadataString(
  metadata: Readonly<Record<string, unknown>>,
  camelKey: string,
  snakeKey?: string
): string | undefined {
  const value = metadata[camelKey] ?? (snakeKey ? metadata[snakeKey] : undefined);
  return typeof value === "string" && value.trim() ? value : undefined;
}

function metadataNumber(
  metadata: Readonly<Record<string, unknown>>,
  key: string
): number | undefined {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return boundedInteger(value, fallback, 1, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Expected integer between ${minimum} and ${maximum}, received ${value}.`);
  }

  return value;
}

function redactVectorText(value: string, secrets: readonly string[] = []): string {
  let output = value;
  for (const secret of secrets) {
    if (secret) {
      output = output.split(secret).join("[REDACTED]");
    }
  }

  for (const rule of VECTOR_REDACTION_RULES) {
    output = output.replace(rule.pattern, rule.replacement);
  }

  return output;
}

function hostedVectorErrorMessage(response: HostedVectorHttpResponse): string {
  if (typeof response.body === "string") {
    return response.body;
  }
  if (isRecord(response.body)) {
    const error = response.body["error"];
    if (typeof error === "string") {
      return error;
    }
    if (isRecord(error) && typeof error["message"] === "string") {
      return error["message"];
    }
    if (typeof response.body["message"] === "string") {
      return response.body["message"];
    }
  }
  return `Hosted vector request failed with HTTP ${response.status}.`;
}

function isRetryableTransportError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("timeout") || message.includes("aborted") || message.includes("network");
}

function serializeJsonBody(body: unknown): string {
  const serialized = JSON.stringify(body);
  if (serialized === undefined) {
    throw new Error("Hosted vector request body must be JSON serializable.");
  }
  return serialized;
}

function parseJsonBody(text: string): unknown {
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function headersToRecord(headers: HostedVectorFetchResponseHeaders): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

function defaultFetchLike(): HostedVectorFetchLike {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("Global fetch is not available. Pass fetch to HostedVectorHttpClient.");
  }

  return async (url, init) => globalThis.fetch(url, init);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
