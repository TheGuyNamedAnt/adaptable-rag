import assert from "node:assert/strict";
import test from "node:test";

import type { DocumentLayout } from "../documents/layout.js";
import { assertDocumentParserContract } from "./parser-contract.js";
import {
  buildCommandInput,
  CommandLayoutParser,
  type CommandLayoutParserInput
} from "./command-layout-parser.js";
import type { DocumentParseRequest } from "./parser.js";

const requestedAt = "2026-06-25T00:00:00.000Z";
const body = "Figure 1\n\nRevenue increased.";
const request: DocumentParseRequest = {
  sourceId: "visual_doc_1",
  sourceKind: "uploaded_file",
  title: "Visual report.pdf",
  contentType: "application/pdf",
  text: body,
  bytes: new Uint8Array([1, 2, 3]),
  requestedAt
};

test("command layout parser returns validated layout and visual assets from local runner", async () => {
  const inputs: CommandLayoutParserInput[] = [];
  const parser = new CommandLayoutParser({
    command: { executable: "docling-wrapper" },
    runner: async (_command, input) => {
      inputs.push(input);
      return {
        body,
        layout: layoutFixture(),
        metadata: { engine: "docling-wrapper" },
        warnings: [{ code: "low_confidence_region", message: "One region was low confidence." }]
      };
    }
  });

  const result = await assertDocumentParserContract({
    parser,
    request,
    expectations: { requireLayout: true, allowParserWarnings: true }
  });

  assert.equal(result.layoutIssueCount, 0);
  assert.equal(inputs[0]?.bytesBase64, "AQID");
});

test("command layout parser falls back with a warning when runner output is invalid", async () => {
  const parser = new CommandLayoutParser({
    command: { executable: "bad-wrapper" },
    runner: async () => ({ body: "missing layout" })
  });

  const result = await parser.parse(request);

  assert.equal(result.document.body, body);
  assert.equal(result.document.layout, undefined);
  assert.equal(result.warnings[0]?.code, "command_layout_failed");
});

test("command layout parser redacts runner failure diagnostics", async () => {
  const parser = new CommandLayoutParser({
    command: { executable: "bad-wrapper" },
    runner: async () => {
      throw new Error("docling failed token=super-secret password=hunter2");
    }
  });

  const result = await parser.parse(request);
  const message = result.warnings[0]?.message ?? "";

  assert.equal(result.document.metadata?.["parserFailed"], true);
  assert.equal(message.includes("super-secret"), false);
  assert.equal(message.includes("hunter2"), false);
  assert.match(message, /token=\[REDACTED\]/u);
});

test("command input describes the normalized visual layout contract", () => {
  const input = buildCommandInput(request);

  assert.equal(input.contentType, "application/pdf");
  assert.match(input.contract.output, /layout\.visualAssets/);
  assert.match(input.contract.requirement, /Visual assets/);
});

function layoutFixture(): DocumentLayout {
  return {
    parserId: "docling-wrapper",
    strategy: "hybrid",
    pages: [
      {
        pageNumber: 1,
        width: 1200,
        height: 1600,
        unit: "pixel",
        visualAssetId: "page_1"
      }
    ],
    regions: [
      {
        id: "figure_1",
        kind: "figure",
        pageNumber: 1,
        box: { pageNumber: 1, x: 120, y: 200, width: 500, height: 320, unit: "pixel" }
      },
      {
        id: "caption_1",
        kind: "figure_caption",
        pageNumber: 1,
        text: "Figure 1",
        characterStart: 0,
        characterEnd: 8,
        box: { pageNumber: 1, x: 120, y: 530, width: 500, height: 60, unit: "pixel" }
      },
      {
        id: "paragraph_1",
        kind: "paragraph",
        pageNumber: 1,
        text: "Revenue increased.",
        characterStart: 10,
        characterEnd: body.length,
        box: { pageNumber: 1, x: 120, y: 620, width: 700, height: 80, unit: "pixel" }
      }
    ],
    relations: [
      {
        id: "caption_for_figure_1",
        kind: "caption_for",
        fromRegionId: "caption_1",
        toRegionId: "figure_1",
        confidence: 0.97
      },
      {
        id: "paragraph_explains_figure_1",
        kind: "explains",
        fromRegionId: "paragraph_1",
        toRegionId: "figure_1",
        confidence: 0.84
      }
    ],
    visualAssets: [
      {
        id: "page_1",
        kind: "page_image",
        pageNumber: 1,
        mediaType: "image/png",
        uri: "file:///tmp/page-1.png"
      },
      {
        id: "figure_crop_1",
        kind: "figure",
        pageNumber: 1,
        mediaType: "image/png",
        uri: "file:///tmp/figure-1.png",
        box: { pageNumber: 1, x: 120, y: 200, width: 500, height: 320, unit: "pixel" }
      }
    ],
    tables: []
  };
}
