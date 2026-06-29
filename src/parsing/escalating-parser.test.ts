import assert from "node:assert/strict";
import test from "node:test";

import type { DocumentLayout } from "../documents/layout.js";
import {
  EscalatingDocumentParser,
  escalationParsersForRisks,
  type ParserEscalationCandidate
} from "./escalating-parser.js";
import type {
  DocumentParseRequest,
  DocumentParseResult,
  DocumentParser,
  DocumentParserCapabilities
} from "./parser.js";

const request: DocumentParseRequest = {
  sourceId: "source_1",
  sourceKind: "uploaded_file",
  title: "Mixed report.pdf",
  contentType: "application/pdf",
  text: "fallback text",
  bytes: new Uint8Array([1, 2, 3]),
  requestedAt: "2026-06-25T00:00:00.000Z"
};

test("escalating parser selects a stronger parser when primary output has layout risks", async () => {
  const primary = fakeParser("markitdown", { body: "Revenue | Cost\n10 | 5" });
  const stronger = fakeParser("docling", {
    body: "Revenue | Cost\n10 | 5",
    layout: tableLayout("Revenue | Cost\n10 | 5")
  });
  const parser = new EscalatingDocumentParser({
    parserId: "escalating-wrapper",
    primaryParser: primary,
    escalationParsers: [candidate(stronger, ["layout_missing_for_complex_document"])]
  });

  const result = await parser.parse(request);

  assert.equal(result.parserId, "escalating-wrapper");
  assert.equal(result.document.metadata?.["parserEscalationSelectedParserId"], "docling");
  assert.equal(result.document.metadata?.["parserEscalationApplied"], true);
  assert.equal(primary.parseCount, 1);
  assert.equal(stronger.parseCount, 1);
});

test("escalating parser keeps a clean primary result without running escalation parsers", async () => {
  const primary = fakeParser("docling", {
    body: "Clean page text",
    layout: textLayout("Clean page text")
  });
  const stronger = fakeParser("mineru", {
    body: "Clean page text",
    layout: textLayout("Clean page text")
  });
  const parser = new EscalatingDocumentParser({
    primaryParser: primary,
    escalationParsers: [candidate(stronger, ["ocr_likely_needed"])]
  });

  const result = await parser.parse(request);

  assert.equal(result.document.metadata?.["parserEscalationSelectedParserId"], "docling");
  assert.equal(result.document.metadata?.["parserEscalationApplied"], false);
  assert.equal(primary.parseCount, 1);
  assert.equal(stronger.parseCount, 0);
});

test("escalating parser tries escalation parsers when the primary parser throws", async () => {
  const primary = throwingParser("primary");
  const stronger = fakeParser("ocr", {
    body: "Recovered OCR text",
    layout: textLayout("Recovered OCR text")
  });
  const parser = new EscalatingDocumentParser({
    primaryParser: primary,
    escalationParsers: [candidate(stronger, ["ocr_likely_needed"])]
  });

  const result = await parser.parse(request);

  assert.equal(result.parserId, "escalating-document-parser");
  assert.equal(result.document.metadata?.["parserEscalationSelectedParserId"], "ocr");
  assert.equal(result.document.metadata?.["parserEscalationApplied"], true);
  assert.equal(stronger.parseCount, 1);
});

test("escalation parser selection uses candidates that address any detected risk", () => {
  const table = fakeParser("table", { body: "table" });
  const ocr = fakeParser("ocr", { body: "ocr" });
  const selected = escalationParsersForRisks(
    ["table_structure_missing", "ocr_likely_needed"],
    [candidate(table, ["table_structure_missing"]), candidate(ocr, ["ocr_likely_needed"])]
  );

  assert.deepEqual(
    selected.map((entry) => entry.parser.id),
    ["table", "ocr"]
  );
});

function candidate(
  parser: DocumentParser,
  addressesRisks: ParserEscalationCandidate["addressesRisks"]
): ParserEscalationCandidate {
  return { parser, addressesRisks };
}

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
      emitsVisualAssets: false,
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
      throw new Error("boom");
    }
  };
}

function textLayout(body: string): DocumentLayout {
  return {
    parserId: "fixture-layout",
    strategy: "text_extraction",
    pages: [{ pageNumber: 1, width: 1, height: 1, unit: "normalized" }],
    regions: [
      {
        id: "region_1",
        kind: "paragraph",
        pageNumber: 1,
        text: body,
        characterStart: 0,
        characterEnd: body.length
      }
    ]
  };
}

function tableLayout(body: string): DocumentLayout {
  return {
    ...textLayout(body),
    strategy: "table_structure",
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
