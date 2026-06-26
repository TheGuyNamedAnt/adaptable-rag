import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderBoundaryConfig,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import { assertDocumentParserContract } from "./parser-contract.js";
import type { DocumentParseRequest } from "./parser.js";
import {
  buildDeepDocJsonParserRequestBody,
  DeepDocJsonParser,
  parseDeepDocJsonParserResponse
} from "./deepdoc-json-parser.js";

class MockProviderTransport implements ProviderTransport {
  readonly requests: ProviderHttpRequest[] = [];
  private readonly responses: readonly ProviderHttpResponse[];

  constructor(responses: readonly ProviderHttpResponse[]) {
    this.responses = responses;
  }

  async send(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(request);
    const response = this.responses[this.requests.length - 1];
    if (!response) {
      throw new Error("No mock parser response configured.");
    }
    return response;
  }
}

const requestedAt = "2026-06-25T00:00:00.000Z";
const body = "Ownership table\n\nParent LLC | Child LLC";

const parseRequest: DocumentParseRequest = {
  sourceId: "source_1",
  sourceKind: "uploaded_file",
  title: "Ownership PDF",
  contentType: "application/pdf",
  text: body,
  requestedAt
};

test("deepdoc json parser returns validated layout from provider JSON", async () => {
  const transport = new MockProviderTransport([okResponse(payload())]);
  const parser = new DeepDocJsonParser({
    config: providerConfig(),
    secrets: { apiKeyProvider: () => "parser-secret" },
    transport,
    parserVersion: "1.0.0"
  });

  const result = await assertDocumentParserContract({
    parser,
    request: parseRequest,
    expectations: { requireLayout: true }
  });

  assert.equal(result.layoutIssueCount, 0);
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0]?.headers.authorization, "Bearer parser-secret");
});

test("deepdoc parser supports chat text JSON responses", () => {
  const parsed = parseDeepDocJsonParserResponse(
    okResponse({
      choices: [{ message: { content: JSON.stringify(payload()) } }]
    })
  );

  assert.equal(parsed.body, body);
  assert.equal(parsed.layout.tables?.[0]?.id, "table_1");
});

test("deepdoc parser returns warnings instead of throwing on invalid provider layout", async () => {
  const basePayload = payload();
  assert.equal(typeof basePayload["layout"], "object");
  const parser = new DeepDocJsonParser({
    config: providerConfig(),
    secrets: { apiKeyProvider: () => "parser-secret" },
    transport: new MockProviderTransport([
      okResponse({
        ...basePayload,
        layout: {
          ...(basePayload["layout"] as Record<string, unknown>),
          regions: [
            {
              id: "bad",
              kind: "table",
              pageNumber: 1,
              text: "wrong text",
              characterStart: 0,
              characterEnd: 5
            }
          ],
          tables: []
        }
      })
    ])
  });

  const result = await parser.parse(parseRequest);

  assert.equal(result.document.body, body);
  assert.equal(result.document.layout, undefined);
  assert.equal(result.warnings[0]?.code, "provider_layout_invalid");
});

test("deepdoc request body can carry binary input as base64", () => {
  const request: DocumentParseRequest = {
    sourceId: "binary_source",
    sourceKind: "uploaded_file",
    title: "Scan",
    contentType: "image/png",
    bytes: new Uint8Array([1, 2, 3]),
    requestedAt
  };

  const bodyPayload = buildDeepDocJsonParserRequestBody(request, "layout-model");

  assert.equal(bodyPayload["model"], "layout-model");
  assert.equal(bodyPayload["bytesBase64"], "AQID");
});

function payload(): Record<string, unknown> {
  return {
    body,
    layout: {
      parserId: "deepdoc-json",
      parserVersion: "1.0.0",
      strategy: "hybrid",
      pages: [{ pageNumber: 1, width: 600, height: 800, unit: "point" }],
      regions: [
        {
          id: "region_title",
          kind: "title",
          pageNumber: 1,
          text: "Ownership table",
          characterStart: 0,
          characterEnd: 15
        },
        {
          id: "region_table",
          kind: "table",
          pageNumber: 1,
          text: "Parent LLC | Child LLC",
          characterStart: 17,
          characterEnd: body.length
        }
      ],
      tables: [
        {
          id: "table_1",
          pageNumber: 1,
          regionId: "region_table",
          cells: [
            { rowIndex: 0, columnIndex: 0, text: "Parent LLC" },
            { rowIndex: 0, columnIndex: 1, text: "Child LLC" }
          ]
        }
      ],
      visualAssets: [
        {
          id: "page_image_1",
          kind: "page_image",
          pageNumber: 1,
          mediaType: "image/png"
        }
      ]
    },
    warnings: [{ code: "low_ocr_confidence", message: "One region had low OCR confidence." }]
  };
}

function providerConfig(overrides: Partial<ProviderBoundaryConfig> = {}): ProviderBoundaryConfig {
  return {
    id: "deepdoc-json",
    provider: "deepdoc-json",
    modelName: "layout-model",
    endpoint: "https://provider.example.invalid/v1/layout",
    timeoutMs: 5000,
    retryPolicy: { maxRetries: 0, backoffMs: 0, retryStatusCodes: [429, 500] },
    ...overrides
  };
}

function okResponse(responseBody: unknown): ProviderHttpResponse {
  return {
    status: 200,
    headers: {},
    body: responseBody,
    latencyMs: 12
  };
}
