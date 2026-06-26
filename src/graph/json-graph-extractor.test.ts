import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderBoundaryConfig,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import { FIXED_NOW, makeChunks, makeDocument } from "../test-support/fixtures.js";
import { runGraphExtractor, type GraphExtractionRequest } from "./graph-extractor.js";
import type { GraphOntology } from "./graph-types.js";
import {
  buildJsonGraphExtractionRequestBody,
  JsonGraphExtractor,
  parseJsonGraphExtractionResponse
} from "./json-graph-extractor.js";
import { ownershipGraphOntology } from "./ownership-ontology.js";

class MockProviderTransport implements ProviderTransport {
  readonly requests: ProviderHttpRequest[] = [];
  private readonly results: Array<ProviderHttpResponse | Error>;

  constructor(results: Array<ProviderHttpResponse | Error>) {
    this.results = [...results];
  }

  async send(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(request);
    const next = this.results.shift();
    if (next instanceof Error) {
      throw next;
    }
    if (!next) {
      throw new Error("No mock provider response configured.");
    }
    return next;
  }
}

const document = makeDocument({
  id: "doc_ownership",
  title: "Ownership memo",
  body: "Parent LLC owns Child LLC."
});
const chunks = makeChunks(document);
const chunkId = chunks[0]?.id ?? "missing_chunk";
const request: GraphExtractionRequest = {
  profile: {
    id: "profile_test",
    namespaceId: "test-namespace"
  },
  ontology: ownershipGraphOntology,
  documents: [document],
  chunks,
  extractionId: "extract_graph_1",
  requestedAt: FIXED_NOW
};

test("json graph extractor sends provider request and returns validated graph batch", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              entities: [
                {
                  id: "entity_parent",
                  kind: "legal_entity",
                  name: "Parent LLC",
                  normalizedName: "parent",
                  confidence: 0.94,
                  evidenceChunkIds: [chunkId]
                },
                {
                  id: "entity_child",
                  kind: "legal_entity",
                  name: "Child LLC",
                  normalizedName: "child",
                  confidence: 0.91,
                  evidenceChunkIds: [chunkId]
                }
              ],
              relations: [
                {
                  id: "relation_parent_owns_child",
                  relationKind: "owns",
                  sourceEntityId: "entity_parent",
                  targetEntityId: "entity_child",
                  factStrength: "explicit_fact",
                  confidence: 0.89,
                  evidenceChunkIds: [chunkId]
                }
              ]
            })
          }
        }
      ],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 10,
        total_tokens: 30
      }
    })
  ]);
  const extractor = new JsonGraphExtractor({
    config: providerConfig(),
    secrets: { apiKeyProvider: () => "graph-secret", secretId: "graph-secret-id" },
    transport,
    supportedOntologyIds: [ownershipGraphOntology.id],
    now: () => FIXED_NOW
  });

  const result = await runGraphExtractor(extractor, request, { now: () => FIXED_NOW });

  assert.equal(result.status, "succeeded");
  assert.equal(result.batch.entities.length, 2);
  assert.equal(result.batch.relations.length, 1);
  assert.equal(result.batch.entities[0]?.status, "proposed");
  assert.equal(result.batch.entities[0]?.evidence[0]?.chunkId, chunkId);
  assert.equal(result.batch.entities[0]?.accessScope.namespaceId, "test-namespace");
  assert.equal(result.batch.relations[0]?.verificationStatus, "not_checked");
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0]?.headers.authorization, "Bearer graph-secret");
});

test("json graph extractor accepts owner-defined ontology kinds", async () => {
  const customOntology: GraphOntology = {
    id: "product-support-ontology",
    entityKinds: ["ticket", "feature"],
    relationKinds: ["blocked_by"],
    requiredEvidenceForRelations: true,
    allowInferredRelations: false
  };
  const customDocument = makeDocument({
    id: "doc_ticket",
    title: "Ticket triage",
    body: "Ticket 123 is blocked by Billing Sync."
  });
  const customChunks = makeChunks(customDocument);
  const customChunkId = customChunks[0]?.id ?? "missing_chunk";
  const transport = new MockProviderTransport([
    okResponse({
      output_text: JSON.stringify({
        entities: [
          {
            id: "ticket_123",
            kind: "ticket",
            name: "Ticket 123",
            confidence: 0.92,
            evidenceChunkIds: [customChunkId]
          },
          {
            id: "feature_billing_sync",
            kind: "feature",
            name: "Billing Sync",
            confidence: 0.91,
            evidenceChunkIds: [customChunkId]
          }
        ],
        relations: [
          {
            id: "rel_ticket_blocked_by_feature",
            relationKind: "blocked_by",
            sourceEntityId: "ticket_123",
            targetEntityId: "feature_billing_sync",
            factStrength: "explicit_fact",
            confidence: 0.9,
            evidenceChunkIds: [customChunkId]
          }
        ]
      })
    })
  ]);
  const extractor = new JsonGraphExtractor({
    config: providerConfig(),
    secrets: { apiKeyProvider: () => "graph-secret" },
    transport,
    supportedOntologyIds: [customOntology.id],
    now: () => FIXED_NOW
  });

  const result = await runGraphExtractor(
    extractor,
    {
      profile: request.profile,
      ontology: customOntology,
      documents: [customDocument],
      chunks: customChunks,
      extractionId: "extract_custom_graph",
      requestedAt: FIXED_NOW
    },
    { now: () => FIXED_NOW }
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.batch.entities[0]?.kind, "ticket");
  assert.equal(result.batch.relations[0]?.relationKind, "blocked_by");
});

test("json graph extractor rejects unknown evidence chunk ids before writing a valid batch", async () => {
  const extractor = new JsonGraphExtractor({
    config: providerConfig(),
    secrets: { apiKeyProvider: () => "graph-secret" },
    transport: new MockProviderTransport([
      okResponse({
        output_text: JSON.stringify({
          entities: [
            {
              id: "entity_parent",
              kind: "legal_entity",
              name: "Parent LLC",
              confidence: 0.94,
              evidenceChunkIds: ["missing_chunk"]
            }
          ],
          relations: []
        })
      })
    ]),
    supportedOntologyIds: [ownershipGraphOntology.id],
    now: () => FIXED_NOW
  });

  const result = await runGraphExtractor(extractor, request, { now: () => FIXED_NOW });

  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "invalid_response");
  assert.match(result.failure.message, /unknown evidence chunk/);
});

test("json graph extractor fails soft on malformed provider JSON", async () => {
  const extractor = new JsonGraphExtractor({
    config: providerConfig(),
    secrets: { apiKeyProvider: () => "graph-secret" },
    transport: new MockProviderTransport([
      okResponse({
        choices: [{ message: { content: "not json" } }]
      })
    ]),
    supportedOntologyIds: [ownershipGraphOntology.id],
    now: () => FIXED_NOW
  });

  const result = await runGraphExtractor(extractor, request, { now: () => FIXED_NOW });

  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "invalid_response");
});

test("json graph extractor retries retryable provider failures", async () => {
  const transport = new MockProviderTransport([
    {
      status: 429,
      headers: {},
      body: { error: { message: "rate limited" } },
      latencyMs: 5
    },
    okResponse({
      entities: [],
      relations: []
    })
  ]);
  const extractor = new JsonGraphExtractor({
    config: providerConfig({
      retryPolicy: {
        maxRetries: 1,
        backoffMs: 0,
        retryStatusCodes: [429]
      }
    }),
    secrets: { apiKeyProvider: () => "graph-secret" },
    transport,
    supportedOntologyIds: [ownershipGraphOntology.id],
    now: () => FIXED_NOW,
    sleep: async () => undefined
  });

  const result = await runGraphExtractor(extractor, request, { now: () => FIXED_NOW });

  assert.equal(result.status, "succeeded");
  assert.equal(transport.requests.length, 2);
});

test("json graph extraction request body limits chunk text and lists allowed ontology fields", () => {
  const body = buildJsonGraphExtractionRequestBody(request, {
    modelName: "graph-model",
    maxChunkCharacters: 8
  });

  assert.equal(body["model"], "graph-model");
  const messages = body["messages"];
  assert.equal(Array.isArray(messages), true);
  const user = Array.isArray(messages) ? messages[1] : undefined;
  assert.equal(typeof user, "object");
  const content = user && "content" in user ? user.content : undefined;
  assert.equal(typeof content, "string");
  const payload = JSON.parse(content as string);
  assert.equal(payload.chunks[0].text.length <= 8, true);
  assert.deepEqual(payload.contract.allowedRelationKinds, ownershipGraphOntology.relationKinds);
});

test("json graph response parser supports direct JSON provider bodies", () => {
  const parsed = parseJsonGraphExtractionResponse(
    okResponse({
      entities: [
        {
          id: "entity_parent",
          kind: "legal_entity",
          name: "Parent LLC",
          confidence: 0.9,
          evidenceChunkIds: [chunkId]
        }
      ],
      links: []
    })
  );

  assert.equal(parsed.entities[0]?.id, "entity_parent");
  assert.deepEqual(parsed.relations, []);
});

function providerConfig(overrides: Partial<ProviderBoundaryConfig> = {}): ProviderBoundaryConfig {
  return {
    id: "json-graph",
    provider: "json-graph",
    modelName: "graph-model",
    endpoint: "https://provider.example.invalid/v1/chat",
    timeoutMs: 5000,
    retryPolicy: {
      maxRetries: 0,
      backoffMs: 0,
      retryStatusCodes: [429, 500]
    },
    ...overrides
  };
}

function okResponse(body: unknown): ProviderHttpResponse {
  return {
    status: 200,
    headers: {},
    body,
    latencyMs: 12
  };
}
