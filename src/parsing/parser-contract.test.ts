import assert from "node:assert/strict";
import test from "node:test";

import type { DocumentLayout } from "../documents/layout.js";
import type { DocumentParser, DocumentParseRequest, DocumentParseResult } from "./parser.js";
import {
  DocumentParserContractError,
  assertDocumentParserContract,
  validateDocumentParserContract
} from "./parser-contract.js";

const request: DocumentParseRequest = {
  sourceId: "uploaded_policy_pdf",
  sourceKind: "uploaded_file",
  title: "Policy PDF",
  contentType: "application/pdf",
  bytes: new Uint8Array([1, 2, 3]),
  requestedAt: "2026-06-24T00:00:00.000Z"
};

function validLayout(): DocumentLayout {
  return {
    parserId: "fixture-parser",
    strategy: "ocr_layout",
    pages: [
      {
        pageNumber: 1,
        width: 100,
        height: 100,
        unit: "normalized"
      }
    ],
    regions: [
      {
        id: "region_1",
        kind: "paragraph",
        pageNumber: 1,
        text: "Parsed body",
        characterStart: 0,
        characterEnd: 11,
        box: {
          pageNumber: 1,
          x: 0.1,
          y: 0.1,
          width: 0.4,
          height: 0.1,
          unit: "normalized"
        }
      }
    ]
  };
}

function parser(overrides: Partial<DocumentParser> = {}): DocumentParser {
  const base: DocumentParser = {
    id: "fixture-parser",
    description: "Fixture parser",
    version: "1.0.0",
    capabilities: {
      inputMode: "binary",
      emitsLayout: true,
      emitsTables: false,
      emitsVisualAssets: false
    },
    async parse(parseRequest) {
      return {
        sourceId: parseRequest.sourceId,
        parserId: "fixture-parser",
        parserVersion: "1.0.0",
        document: {
          body: "Parsed body",
          layout: validLayout()
        },
        warnings: []
      };
    }
  };

  return {
    ...base,
    ...overrides
  };
}

test("accepts a parser that returns non-empty body and valid layout", async () => {
  const result = await assertDocumentParserContract({
    parser: parser(),
    request,
    expectations: {
      requireLayout: true
    }
  });

  assert.equal(result.bodyLength, "Parsed body".length);
  assert.equal(result.issues.length, 0);
});

test("rejects parser layouts that do not validate against parsed text", async () => {
  const result = await validateDocumentParserContract({
    parser: parser({
      async parse(parseRequest): Promise<DocumentParseResult> {
        return {
          sourceId: parseRequest.sourceId,
          parserId: "fixture-parser",
          document: {
            body: "Different body",
            layout: validLayout()
          },
          warnings: []
        };
      }
    }),
    request,
    expectations: {
      requireLayout: true
    }
  });

  assert.equal(
    result.issues.some((issue) => issue.code === "layout_invalid"),
    true
  );
});

test("rejects secret-looking parser warnings", async () => {
  const result = await validateDocumentParserContract({
    parser: parser({
      async parse(parseRequest): Promise<DocumentParseResult> {
        return {
          sourceId: parseRequest.sourceId,
          parserId: "fixture-parser",
          document: {
            body: "Parsed body",
            layout: validLayout()
          },
          warnings: [
            {
              code: "ocr_warning",
              message: "provider token=super-secret-token leaked"
            }
          ]
        };
      }
    }),
    request,
    expectations: {
      requireLayout: true
    }
  });

  assert.equal(
    result.issues.some((issue) => issue.code === "parser_warning_leaks_sensitive_diagnostics"),
    true
  );
});

test("rejects capability dishonesty and thrown parsers", async () => {
  const dishonest = await validateDocumentParserContract({
    parser: parser({
      capabilities: {
        inputMode: "binary",
        emitsLayout: false,
        emitsTables: false,
        emitsVisualAssets: false
      }
    }),
    request,
    expectations: {
      requireLayout: true
    }
  });

  assert.equal(
    dishonest.issues.some((issue) => issue.code === "declared_capability_mismatch"),
    true
  );

  await assert.rejects(
    () =>
      assertDocumentParserContract({
        parser: parser({
          async parse() {
            throw new Error("boom");
          }
        }),
        request
      }),
    DocumentParserContractError
  );
});

test("permits intentionally empty parser fixtures only when declared", async () => {
  const { bytes: _bytes, ...textRequest } = request;
  const emptyParser = parser({
    capabilities: {
      inputMode: "text",
      emitsLayout: false,
      emitsTables: false,
      emitsVisualAssets: false
    },
    async parse(parseRequest): Promise<DocumentParseResult> {
      return {
        sourceId: parseRequest.sourceId,
        parserId: "fixture-parser",
        document: {
          body: ""
        },
        warnings: []
      };
    }
  });

  const rejected = await validateDocumentParserContract({
    parser: emptyParser,
    request: {
      ...textRequest,
      text: ""
    }
  });
  const accepted = await validateDocumentParserContract({
    parser: emptyParser,
    request: {
      ...textRequest,
      text: ""
    },
    expectations: {
      allowEmptyBody: true
    }
  });

  assert.equal(
    rejected.issues.some((issue) => issue.code === "empty_body"),
    true
  );
  assert.equal(
    accepted.issues.some((issue) => issue.code === "empty_body"),
    false
  );
});
