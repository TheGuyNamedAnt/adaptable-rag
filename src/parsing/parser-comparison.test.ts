import assert from "node:assert/strict";
import test from "node:test";

import type { DocumentLayout } from "../documents/layout.js";
import { compareParserResults, ParserComparisonMode } from "./parser-comparison.js";
import type {
  DocumentParseRequest,
  DocumentParseResult,
  DocumentParser,
  DocumentParserCapabilities
} from "./parser.js";

const request: DocumentParseRequest = {
  sourceId: "source_1",
  sourceKind: "uploaded_file",
  title: "Board deck.pdf",
  contentType: "application/pdf",
  text: "fallback text",
  bytes: new Uint8Array([1, 2, 3]),
  requestedAt: "2026-06-25T00:00:00.000Z"
};

test("parser comparison mode selects the highest quality parser behind wrapper metadata", async () => {
  const weak = fakeParser("weak-markdown", {
    body: "Revenue | Cost\n10 | 5"
  });
  const strong = fakeParser("strong-layout", {
    body: "Revenue | Cost\n10 | 5",
    layout: tableLayout("Revenue | Cost\n10 | 5")
  });
  const parser = new ParserComparisonMode([weak, strong], { parserId: "comparison-wrapper" });

  const result = await parser.parse(request);

  assert.equal(result.parserId, "comparison-wrapper");
  assert.equal(result.document.metadata?.["parserComparisonSelectedParserId"], "strong-layout");
  assert.equal(result.document.metadata?.["parserComparisonSelectedScore"], 100);
  assert.equal(weak.parseCount, 1);
  assert.equal(strong.parseCount, 1);
});

test("parser comparison skips parsers that exceed declared byte limits", async () => {
  const tooSmall = fakeParser("too-small", {
    body: "should not run",
    capabilities: { maxBytes: 1 }
  });
  const eligible = fakeParser("eligible", { body: "eligible text" });

  const result = await compareParserResults(request, [tooSmall, eligible]);

  assert.equal(result.selected.parserId, "eligible");
  assert.equal(tooSmall.parseCount, 0);
  assert.equal(eligible.parseCount, 1);
});

test("parser comparison mode returns failed metadata instead of throwing when all parsers fail", async () => {
  const parser = new ParserComparisonMode([throwingParser("failed-a"), throwingParser("failed-b")]);

  const result = await parser.parse(request);

  assert.equal(result.parserId, "parser-comparison-mode");
  assert.equal(result.document.body, "fallback text");
  assert.equal(result.document.metadata?.["parserFailed"], true);
  assert.equal(result.document.metadata?.["parserFailureCode"], "parser_comparison_failed");
  assert.equal(result.warnings[0]?.code, "parser_comparison_failed");
});

function fakeParser(
  id: string,
  options: {
    readonly body: string;
    readonly layout?: DocumentLayout;
    readonly capabilities?: Partial<DocumentParserCapabilities>;
  }
): DocumentParser & { parseCount: number } {
  return {
    id,
    description: `${id} fixture parser`,
    version: "1.0.0",
    parseCount: 0,
    capabilities: {
      inputMode: "text_or_binary",
      emitsLayout: options.layout !== undefined,
      emitsTables: options.layout?.tables !== undefined,
      emitsVisualAssets: options.layout?.visualAssets !== undefined,
      supportedContentTypes: ["application/pdf"],
      ...options.capabilities
    },
    async parse(parseRequest): Promise<DocumentParseResult> {
      this.parseCount += 1;
      return {
        sourceId: parseRequest.sourceId,
        parserId: id,
        parserVersion: "1.0.0",
        document: {
          body: options.body,
          ...(options.layout === undefined ? {} : { layout: options.layout })
        },
        warnings: []
      };
    }
  };
}

function throwingParser(id: string): DocumentParser {
  return {
    id,
    description: `${id} fixture parser`,
    version: "1.0.0",
    capabilities: {
      inputMode: "text_or_binary",
      emitsLayout: false,
      emitsTables: false,
      emitsVisualAssets: false,
      supportedContentTypes: ["application/pdf"]
    },
    async parse() {
      throw new Error("secret token=do-not-leak");
    }
  };
}

function tableLayout(body: string): DocumentLayout {
  return {
    parserId: "fixture-layout",
    strategy: "table_structure",
    pages: [{ pageNumber: 1, width: 1, height: 1, unit: "normalized" }],
    regions: [
      {
        id: "table_region",
        kind: "table",
        pageNumber: 1,
        text: body,
        characterStart: 0,
        characterEnd: body.length
      }
    ],
    tables: [
      {
        id: "table_1",
        pageNumber: 1,
        regionId: "table_region",
        cells: [
          { rowIndex: 0, columnIndex: 0, text: "Revenue" },
          { rowIndex: 0, columnIndex: 1, text: "Cost" },
          { rowIndex: 1, columnIndex: 0, text: "10" },
          { rowIndex: 1, columnIndex: 1, text: "5" }
        ]
      }
    ]
  };
}
