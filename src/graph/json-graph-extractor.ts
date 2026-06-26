import type { RagChunk } from "../documents/chunk.js";
import type {
  ProviderAdapterSecrets,
  ProviderBoundaryConfig,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderMappedError,
  ProviderTransport
} from "../shared/provider-boundary.js";
import {
  defaultProviderRequestHeaders,
  mapProviderStatus,
  mapTransportError,
  redactText,
  validateProviderConfig
} from "../shared/provider-boundary.js";
import {
  buildGraphExtractionTrace,
  type GraphExtractionRequest,
  type GraphExtractionResult,
  type GraphExtractor
} from "./graph-extractor.js";
import type {
  GraphEntityKind,
  GraphEntityProposal,
  GraphExtractionBatch,
  GraphFactStrength,
  GraphRelationKind,
  GraphRelationProposal
} from "./graph-types.js";
import { isGraphEntityKind, isGraphRelationKind } from "./graph-types.js";
import { validateGraphExtractionBatch } from "./graph-validation.js";

export interface JsonGraphExtractorOptions {
  readonly config: ProviderBoundaryConfig;
  readonly secrets: ProviderAdapterSecrets;
  readonly transport: ProviderTransport;
  readonly supportedOntologyIds: readonly string[];
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly temperature?: number;
  readonly maxChunkCharacters?: number;
}

interface ProviderGraphEntity {
  readonly id: string;
  readonly kind: GraphEntityKind;
  readonly name: string;
  readonly normalizedName?: string;
  readonly aliases: readonly string[];
  readonly confidence: number;
  readonly evidenceChunkIds: readonly string[];
}

interface ProviderGraphRelation {
  readonly id: string;
  readonly relationKind: GraphRelationKind;
  readonly sourceEntityId: string;
  readonly targetEntityId: string;
  readonly factStrength: GraphFactStrength;
  readonly confidence: number;
  readonly evidenceChunkIds: readonly string[];
}

interface ProviderGraphPayload {
  readonly entities: readonly ProviderGraphEntity[];
  readonly relations: readonly ProviderGraphRelation[];
  readonly warnings: readonly string[];
}

const DEFAULT_MAX_CHUNK_CHARACTERS = 1800;

export class JsonGraphExtractor implements GraphExtractor {
  readonly id: string;
  readonly supportedOntologyIds: readonly string[];

  private readonly options: JsonGraphExtractorOptions;

  constructor(options: JsonGraphExtractorOptions) {
    validateProviderConfig(options.config);
    this.id = options.config.id;
    this.supportedOntologyIds = options.supportedOntologyIds;
    this.options = options;
  }

  async extract(request: GraphExtractionRequest): Promise<GraphExtractionResult> {
    const now = this.options.now ?? (() => new Date().toISOString());
    const startedAt = request.requestedAt ?? now();
    const extractionId =
      request.extractionId ?? `graph_extraction_${startedAt.replace(/[^0-9a-z]/gi, "")}`;
    const apiKey = await this.options.secrets.apiKeyProvider();

    if (!apiKey.trim()) {
      return this.failedResult({
        request,
        extractionId,
        startedAt,
        finishedAt: now(),
        code: "auth_error",
        message: "Provider API key is missing.",
        retryable: false
      });
    }

    const httpRequest: ProviderHttpRequest = {
      requestId: extractionId,
      url: this.options.config.endpoint,
      method: "POST",
      headers: defaultProviderRequestHeaders({ apiKey, requestId: extractionId }),
      body: buildJsonGraphExtractionRequestBody(request, {
        modelName: this.options.config.modelName,
        ...(this.options.temperature === undefined
          ? {}
          : { temperature: this.options.temperature }),
        maxChunkCharacters: this.options.maxChunkCharacters ?? DEFAULT_MAX_CHUNK_CHARACTERS
      }),
      timeoutMs: this.options.config.timeoutMs
    };
    const maxAttempts = this.options.config.retryPolicy.maxRetries + 1;
    let finalError: ProviderMappedError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await this.options.transport.send(httpRequest);
        const mapped = mapProviderStatus(response);

        if (!mapped) {
          return this.parseSuccess({
            request,
            extractionId,
            startedAt,
            finishedAt: now(),
            response
          });
        }

        finalError = mapped;
        if (!mapped.retryable || attempt >= maxAttempts) {
          break;
        }
      } catch (error) {
        finalError = mapTransportError(error);
        if (!finalError.retryable || attempt >= maxAttempts) {
          break;
        }
      }

      await this.options.sleep?.(this.options.config.retryPolicy.backoffMs);
    }

    return this.failedResult({
      request,
      extractionId,
      startedAt,
      finishedAt: now(),
      code: finalError?.code ?? "provider_error",
      message: redactText(finalError?.message ?? "Provider request failed.", [
        apiKey,
        this.options.secrets.secretId ?? ""
      ]),
      retryable: finalError?.retryable ?? false
    });
  }

  private parseSuccess(input: {
    readonly request: GraphExtractionRequest;
    readonly extractionId: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly response: ProviderHttpResponse;
  }): GraphExtractionResult {
    try {
      const payload = parseJsonGraphExtractionResponse(input.response);
      const batch = toGraphExtractionBatch({
        request: input.request,
        extractionId: input.extractionId,
        createdAt: input.finishedAt,
        payload
      });
      const validation = validateGraphExtractionBatch(batch);
      if (!validation.valid) {
        return {
          status: "failed",
          failure: {
            code: "invalid_graph_batch",
            message: "Provider graph extraction did not satisfy the graph validation contract.",
            retryable: false
          },
          validationIssues: validation.issues,
          trace: buildGraphExtractionTrace({
            request: input.request,
            extractionId: input.extractionId,
            startedAt: input.startedAt,
            finishedAt: input.finishedAt,
            status: "failed",
            entityCount: batch.entities.length,
            relationCount: batch.relations.length,
            validationErrorCount: validation.issues.length
          })
        };
      }

      return {
        status: "succeeded",
        batch,
        validationIssues: validation.issues,
        trace: buildGraphExtractionTrace({
          request: input.request,
          extractionId: input.extractionId,
          startedAt: input.startedAt,
          finishedAt: input.finishedAt,
          status: "succeeded",
          entityCount: batch.entities.length,
          relationCount: batch.relations.length,
          validationErrorCount: validation.issues.length
        })
      };
    } catch (error) {
      return this.failedResult({
        request: input.request,
        extractionId: input.extractionId,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        code: "invalid_response",
        message: error instanceof Error ? error.message : "Provider response was invalid.",
        retryable: false
      });
    }
  }

  private failedResult(input: {
    readonly request: GraphExtractionRequest;
    readonly extractionId: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  }): GraphExtractionResult {
    return {
      status: "failed",
      failure: {
        code: input.code,
        message: input.message,
        retryable: input.retryable
      },
      validationIssues: [],
      trace: buildGraphExtractionTrace({
        request: input.request,
        extractionId: input.extractionId,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        status: "failed"
      })
    };
  }
}

export function buildJsonGraphExtractionRequestBody(
  request: GraphExtractionRequest,
  options: {
    readonly modelName: string;
    readonly temperature?: number;
    readonly maxChunkCharacters?: number;
  }
): Record<string, unknown> {
  const maxChunkCharacters = options.maxChunkCharacters ?? DEFAULT_MAX_CHUNK_CHARACTERS;

  return {
    model: options.modelName,
    messages: [
      {
        role: "system",
        content:
          "Extract only evidence-supported graph entities and relationships. Return strict JSON. Use only supplied chunkIds as evidence. Do not invent access, trust, source, or citation fields."
      },
      {
        role: "user",
        content: JSON.stringify({
          namespaceId: request.profile.namespaceId,
          ontology: {
            id: request.ontology.id,
            entityKinds: request.ontology.entityKinds,
            relationKinds: request.ontology.relationKinds,
            requiredEvidenceForRelations: request.ontology.requiredEvidenceForRelations,
            allowInferredRelations: request.ontology.allowInferredRelations
          },
          documents: request.documents.map((document) => ({
            id: document.id,
            title: document.title,
            sourceId: document.provenance.sourceId
          })),
          chunks: request.chunks.map((chunk) => ({
            id: chunk.id,
            documentId: chunk.documentId,
            title: chunk.citation.title,
            text: chunk.text.slice(0, maxChunkCharacters)
          })),
          contract: {
            output:
              'Return {"entities":[{"id":"entity_snake_case","kind":"legal_entity","name":"...","normalizedName":"...","aliases":[],"confidence":0.0-1.0,"evidenceChunkIds":["chunk_id"]}],"relations":[{"id":"relation_snake_case","relationKind":"owns","sourceEntityId":"entity_parent","targetEntityId":"entity_child","factStrength":"explicit_fact","confidence":0.0-1.0,"evidenceChunkIds":["chunk_id"]}],"warnings":[]}.',
            allowedChunkIds: request.chunks.map((chunk) => chunk.id),
            allowedEntityKinds: request.ontology.entityKinds,
            allowedRelationKinds: request.ontology.relationKinds
          }
        })
      }
    ],
    response_format: { type: "json_object" },
    temperature: options.temperature ?? 0
  };
}

export function parseJsonGraphExtractionResponse(
  response: ProviderHttpResponse
): ProviderGraphPayload {
  const record = extractJsonRecord(response.body);
  return {
    entities: readEntities(record["entities"]),
    relations: readRelations(record["relations"] ?? record["links"]),
    warnings: readStringArray(record["warnings"])
  };
}

function toGraphExtractionBatch(input: {
  readonly request: GraphExtractionRequest;
  readonly extractionId: string;
  readonly createdAt: string;
  readonly payload: ProviderGraphPayload;
}): GraphExtractionBatch {
  const chunksById = new Map(input.request.chunks.map((chunk) => [chunk.id, chunk] as const));

  return {
    id: input.extractionId,
    namespaceId: input.request.profile.namespaceId,
    ontology: input.request.ontology,
    entities: input.payload.entities.map((entity) =>
      toEntityProposal(entity, input.request.profile.namespaceId, chunksById, input.createdAt)
    ),
    relations: input.payload.relations.map((relation) =>
      toRelationProposal(relation, input.request.profile.namespaceId, chunksById, input.createdAt)
    ),
    createdAt: input.createdAt
  };
}

function toEntityProposal(
  entity: ProviderGraphEntity,
  namespaceId: string,
  chunksById: ReadonlyMap<string, RagChunk>,
  createdAt: string
): GraphEntityProposal {
  const evidenceChunks = evidenceChunksFor(entity.evidenceChunkIds, chunksById);
  const firstChunk = firstEvidenceChunk(evidenceChunks, entity.id);

  return {
    id: entity.id,
    namespaceId,
    kind: entity.kind,
    name: entity.name,
    normalizedName: entity.normalizedName ?? normalizeName(entity.name),
    aliases: entity.aliases,
    confidence: entity.confidence,
    trustTier: firstChunk.provenance.trustTier,
    accessScope: firstChunk.accessScope,
    evidence: evidenceChunks.map(toEvidenceAnchor),
    status: "proposed",
    createdAt
  };
}

function toRelationProposal(
  relation: ProviderGraphRelation,
  namespaceId: string,
  chunksById: ReadonlyMap<string, RagChunk>,
  createdAt: string
): GraphRelationProposal {
  const evidenceChunks = evidenceChunksFor(relation.evidenceChunkIds, chunksById);
  const firstChunk = firstEvidenceChunk(evidenceChunks, relation.id);

  return {
    id: relation.id,
    namespaceId,
    relationKind: relation.relationKind,
    sourceEntityId: relation.sourceEntityId,
    targetEntityId: relation.targetEntityId,
    factStrength: relation.factStrength,
    confidence: relation.confidence,
    trustTier: firstChunk.provenance.trustTier,
    accessScope: firstChunk.accessScope,
    evidence: evidenceChunks.map(toEvidenceAnchor),
    temporal: {
      observedAt: createdAt
    },
    verificationStatus: "not_checked",
    status: "proposed",
    createdAt
  };
}

function evidenceChunksFor(
  chunkIds: readonly string[],
  chunksById: ReadonlyMap<string, RagChunk>
): readonly RagChunk[] {
  return chunkIds.map((chunkId) => {
    const chunk = chunksById.get(chunkId);
    if (!chunk) {
      throw new Error(`Provider referenced unknown evidence chunk "${chunkId}".`);
    }
    return chunk;
  });
}

function firstEvidenceChunk(chunks: readonly RagChunk[], itemId: string): RagChunk {
  const first = chunks[0];
  if (!first) {
    throw new Error(`Provider graph item "${itemId}" must include evidenceChunkIds.`);
  }
  return first;
}

function toEvidenceAnchor(chunk: RagChunk) {
  return {
    chunkId: chunk.id,
    documentId: chunk.documentId,
    sourceId: chunk.provenance.sourceId,
    citation: chunk.citation,
    quoteHash: chunk.textHash,
    characterStart: chunk.characterStart,
    characterEnd: chunk.characterEnd
  };
}

function extractJsonRecord(body: unknown): Record<string, unknown> {
  if (isRecord(body) && (Array.isArray(body["entities"]) || Array.isArray(body["relations"]))) {
    return body;
  }

  const text = extractText(body);
  try {
    const parsed: unknown = JSON.parse(text.trim());
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Throw the normalized error below.
  }

  throw new Error("Graph extraction provider response must include a JSON object.");
}

function extractText(body: unknown): string {
  if (!isRecord(body)) {
    throw new Error("Provider response body must be an object.");
  }

  if (typeof body["output_text"] === "string") {
    return body["output_text"];
  }

  const choices = body["choices"];
  if (Array.isArray(choices)) {
    const first = choices[0];
    if (isRecord(first)) {
      const message = first["message"];
      if (isRecord(message) && typeof message["content"] === "string") {
        return message["content"];
      }
      if (typeof first["text"] === "string") {
        return first["text"];
      }
    }
  }

  const output = body["output"];
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!isRecord(item)) {
        continue;
      }
      const content = item["content"];
      if (!Array.isArray(content)) {
        continue;
      }
      for (const part of content) {
        if (isRecord(part) && typeof part["text"] === "string") {
          return part["text"];
        }
      }
    }
  }

  throw new Error("Provider response did not include graph extraction text.");
}

function readEntities(value: unknown): readonly ProviderGraphEntity[] {
  if (!Array.isArray(value)) {
    throw new Error("Graph extraction response must include entities array.");
  }
  return value.map(readEntity);
}

function readEntity(value: unknown): ProviderGraphEntity {
  if (!isRecord(value)) {
    throw new Error("Graph extraction entity must be an object.");
  }

  const id = readRequiredString(value["id"], "entity.id");
  const kind = readEntityKind(value["kind"]);
  const name = readRequiredString(value["name"], "entity.name");
  const normalizedName =
    typeof value["normalizedName"] === "string"
      ? value["normalizedName"]
      : typeof value["normalized_name"] === "string"
        ? value["normalized_name"]
        : undefined;

  return {
    id,
    kind,
    name,
    ...(normalizedName === undefined ? {} : { normalizedName }),
    aliases: readStringArray(value["aliases"]),
    confidence: readConfidence(value["confidence"], "entity.confidence"),
    evidenceChunkIds: readStringArray(value["evidenceChunkIds"] ?? value["evidence_chunk_ids"])
  };
}

function readRelations(value: unknown): readonly ProviderGraphRelation[] {
  if (!Array.isArray(value)) {
    throw new Error("Graph extraction response must include relations array.");
  }
  return value.map(readRelation);
}

function readRelation(value: unknown): ProviderGraphRelation {
  if (!isRecord(value)) {
    throw new Error("Graph extraction relation must be an object.");
  }

  return {
    id: readRequiredString(value["id"], "relation.id"),
    relationKind: readRelationKind(
      value["relationKind"] ?? value["relation_kind"] ?? value["type"]
    ),
    sourceEntityId: readRequiredString(
      value["sourceEntityId"] ?? value["source_entity_id"] ?? value["fromEntityId"],
      "relation.sourceEntityId"
    ),
    targetEntityId: readRequiredString(
      value["targetEntityId"] ?? value["target_entity_id"] ?? value["toEntityId"],
      "relation.targetEntityId"
    ),
    factStrength: readFactStrength(value["factStrength"] ?? value["fact_strength"]),
    confidence: readConfidence(value["confidence"], "relation.confidence"),
    evidenceChunkIds: readStringArray(value["evidenceChunkIds"] ?? value["evidence_chunk_ids"])
  };
}

function readEntityKind(value: unknown): GraphEntityKind {
  if (typeof value === "string" && isGraphEntityKind(value)) {
    return value;
  }
  throw new Error("Graph extraction entity kind is unsupported.");
}

function readRelationKind(value: unknown): GraphRelationKind {
  if (typeof value === "string" && isGraphRelationKind(value)) {
    return value;
  }
  throw new Error("Graph extraction relation kind is unsupported.");
}

function readFactStrength(value: unknown): GraphFactStrength {
  if (
    value === "explicit_fact" ||
    value === "inferred_fact" ||
    value === "co_mention" ||
    value === "semantic_association"
  ) {
    return value;
  }
  return "explicit_fact";
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(`Graph extraction response must include ${field}.`);
}

function readConfidence(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new Error(`Graph extraction response must include numeric ${field}.`);
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
