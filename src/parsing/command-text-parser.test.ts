import assert from "node:assert/strict";
import test from "node:test";

import { CommandTextParser } from "./command-text-parser.js";
import type { DocumentParseRequest } from "./parser.js";

const request: DocumentParseRequest = {
  sourceId: "text_source_1",
  sourceKind: "uploaded_file",
  title: "Notes.docx",
  contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  text: "Existing fallback text",
  requestedAt: "2026-06-25T00:00:00.000Z"
};

test("command text parser redacts runner failure diagnostics", async () => {
  const parser = new CommandTextParser({
    command: { executable: "markitdown-wrapper" },
    runner: async () => {
      throw new Error("markitdown failed token=super-secret password:hunter2 secret=leaked");
    }
  });

  const result = await parser.parse(request);
  const message = result.warnings[0]?.message ?? "";

  assert.equal(result.document.metadata?.["parserFailed"], true);
  assert.equal(result.document.metadata?.["parserFailureMessage"], message);
  assert.equal(message.includes("super-secret"), false);
  assert.equal(message.includes("hunter2"), false);
  assert.equal(message.includes("leaked"), false);
  assert.match(message, /token=\[REDACTED\]/u);
});

test("command text parser redacts returned warning diagnostics", async () => {
  const parser = new CommandTextParser({
    command: { executable: "markitdown-wrapper" },
    runner: async () => ({
      body: "Parsed text",
      warnings: [{ code: "parser_warning", message: "provider token=super-secret leaked" }]
    })
  });

  const result = await parser.parse(request);
  const message = result.warnings[0]?.message ?? "";

  assert.equal(result.document.body, "Parsed text");
  assert.equal(message.includes("super-secret"), false);
  assert.match(message, /token=\[REDACTED\]/u);
});
