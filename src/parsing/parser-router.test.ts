import assert from "node:assert/strict";
import test from "node:test";

import type { DocumentLayout } from "../documents/layout.js";
import { DocumentParserRouter, type ParserRouterTrace } from "./parser-router.js";
import type {
  DocumentParseRequest,
  DocumentParseResult,
  DocumentParser,
  DocumentParserCapabilities
} from "./parser.js";

const requestedAt = "2026-06-25T00:00:00.000Z";
const request: DocumentParseRequest = {
  sourceId: "source_1",
  sourceKind: "uploaded_file",
  title: "Import.pdf",
  contentType: "application/pdf",
  text: "plain text",
  bytes: new Uint8Array([1, 2, 3]),
  requestedAt
};

test("parser router chooses the fast parser when it satisfies policy", async () => {
  const fast = fakeParser("fast", { body: "native text" });
  const layout = fakeParser("layout", { body: "layout text", layout: layoutFixture() });
  const router = new DocumentParserRouter({
    candidates: [
      { parser: layout, tier: "layout_local" },
      { parser: fast, tier: "fast_native" }
    ]
  });

  const result = await router.parse(request);

  assert.equal(result.parserId, "parser-router");
  assert.equal(result.document.body, "native text");
  assert.equal(result.document.metadata?.["parserRouterSelectedParserId"], "fast");
  assert.equal(result.document.metadata?.["parserRouterSelectedScore"], 100);
  assert.equal(result.document.metadata?.["parserRouterAttemptCount"], 1);
  assert.equal(fast.parseCount, 1);
  assert.equal(layout.parseCount, 0);

  const trace = parserRouterTrace(result);
  assert.equal(trace.selectedParserId, "fast");
  assert.deepEqual(
    trace.attempts.map((attempt) => `${attempt.parserId}:${attempt.status}`),
    ["fast:accepted", "layout:skipped"]
  );
  assert.deepEqual(trace.attempts[1]?.reasons, [
    "higher-ranked parser accepted before this parser was attempted"
  ]);
});

test("parser router falls back when the fast parser does not satisfy quality", async () => {
  const fast = fakeParser("fast", { body: "" });
  const layout = fakeParser("layout", { body: "layout text", layout: layoutFixture() });
  const router = new DocumentParserRouter({
    candidates: [
      { parser: fast, tier: "fast_native" },
      { parser: layout, tier: "layout_local" }
    ],
    policy: { requireLayout: true, minimumBodyCharacters: 5 }
  });

  const result = await router.parse(request);

  assert.equal(result.document.body, "layout text");
  assert.equal(result.document.metadata?.["parserRouterSelectedParserId"], "layout");
  assert.equal(result.document.metadata?.["parserRouterSelectedScore"], 100);
  assert.equal(result.document.metadata?.["parserRouterRejectedAttemptCount"], 1);
  assert.equal(result.document.metadata?.["parserRouterFailedAttemptCount"], 0);
  assert.equal(result.document.metadata?.["parserRouterSkippedCandidateCount"], 0);
  assert.equal(result.warnings[0]?.code, "parser_router_attempt_rejected");

  const trace = parserRouterTrace(result);
  assert.equal(trace.selectedParserId, "layout");
  assert.deepEqual(
    trace.attempts.map((attempt) => `${attempt.parserId}:${attempt.status}`),
    ["fast:rejected", "layout:accepted"]
  );
  assert.equal(trace.attempts[0]?.qualityScore, 35);
  assert.deepEqual(trace.attempts[0]?.reasons, [
    "body had 0 character(s), below 5",
    "layout was required but missing"
  ]);
});

test("parser router can require layout only for selected content types", async () => {
  const fast = fakeParser("fast", { body: "native text" });
  const layout = fakeParser("layout", { body: "layout text", layout: layoutFixture() });
  const router = new DocumentParserRouter({
    candidates: [
      { parser: fast, tier: "fast_native" },
      { parser: layout, tier: "layout_local" }
    ],
    policy: {
      requireLayoutContentTypes: [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ]
    }
  });

  const docxResult = await router.parse({
    ...request,
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  });
  const textResult = await router.parse({ ...request, contentType: "text/plain" });

  assert.equal(docxResult.document.metadata?.["parserRouterSelectedParserId"], "layout");
  assert.equal(docxResult.document.metadata?.["parserRouterRejectedAttemptCount"], 1);
  assert.equal(textResult.document.metadata?.["parserRouterSelectedParserId"], "fast");
});

test("parser router treats table preference as scoring, not a hard requirement", async () => {
  const fast = fakeParser("fast", { body: "Investor | Shares\nAcme LLC | 100" });
  const table = fakeParser("table", { body: "layout text", layout: tableLayoutFixture() });
  const router = new DocumentParserRouter({
    candidates: [
      { parser: fast, tier: "fast_native" },
      { parser: table, tier: "layout_local" }
    ],
    policy: { preferTables: true }
  });

  const result = await router.parse(request);

  assert.equal(result.document.metadata?.["parserRouterSelectedParserId"], "table");
  assert.equal(fast.parseCount, 1);
  assert.equal(table.parseCount, 1);
  const trace = parserRouterTrace(result);
  assert.deepEqual(
    trace.attempts.map(
      (attempt) => `${attempt.parserId}:${attempt.status}:${attempt.qualityScore}`
    ),
    ["fast:accepted:92", "table:accepted:100"]
  );
});

test("parser router returns best available parse when soft preferences cannot be satisfied", async () => {
  const flattenedTable = "Balance Sheet\nCash,Debt,Equity\n10,2,8\n20,3,17";
  const fast = fakeParser("fast", { body: flattenedTable });
  const fallback = fakeParser("fallback", { body: flattenedTable });
  const router = new DocumentParserRouter({
    candidates: [
      { parser: fast, tier: "fast_native" },
      { parser: fallback, tier: "fallback" }
    ],
    policy: { preferTables: true }
  });

  const result = await router.parse(request);

  assert.equal(result.document.metadata?.["parserRouterSelectedParserId"], "fast");
  assert.equal(result.document.metadata?.["parserRouterSelectedScore"], 92);
  assert.equal(fast.parseCount, 1);
  assert.equal(fallback.parseCount, 1);
});

test("parser router does not chase table preference for non-table content", async () => {
  const fast = fakeParser("fast", { body: "native text without a table" });
  const fallback = fakeParser("fallback", { body: "fallback text" });
  const router = new DocumentParserRouter({
    candidates: [
      { parser: fast, tier: "fast_native" },
      { parser: fallback, tier: "fallback" }
    ],
    policy: { preferTables: true }
  });

  const result = await router.parse(request);

  assert.equal(result.document.metadata?.["parserRouterSelectedParserId"], "fast");
  assert.equal(result.document.metadata?.["parserRouterSelectedScore"], 100);
  assert.equal(fast.parseCount, 1);
  assert.equal(fallback.parseCount, 0);
});

test("parser router skips paid cloud candidates unless policy allows them", async () => {
  const paid = fakeParser("paid", { body: "cloud text", layout: layoutFixture() });
  const fallback = fakeParser("fallback", { body: "fallback text" });
  const router = new DocumentParserRouter({
    candidates: [
      { parser: paid, tier: "paid_cloud" },
      { parser: fallback, tier: "fallback" }
    ]
  });

  const result = await router.parse(request);

  assert.equal(result.document.metadata?.["parserRouterSelectedParserId"], "fallback");
  assert.equal(result.document.metadata?.["parserRouterSkippedCandidateCount"], 1);
  assert.equal(paid.parseCount, 0);

  const trace = parserRouterTrace(result);
  assert.deepEqual(
    trace.attempts.map((attempt) => `${attempt.parserId}:${attempt.status}`),
    ["paid:skipped", "fallback:accepted"]
  );
  assert.deepEqual(trace.attempts[0]?.reasons, ["paid cloud candidates are disabled by policy"]);
});

test("parser router can use paid cloud candidates when policy allows them", async () => {
  const paid = fakeParser("paid", { body: "cloud text", layout: layoutFixture() });
  const fallback = fakeParser("fallback", { body: "fallback text" });
  const router = new DocumentParserRouter({
    candidates: [
      { parser: paid, tier: "paid_cloud" },
      { parser: fallback, tier: "fallback" }
    ],
    policy: { allowPaidCloud: true }
  });

  const result = await router.parse(request);

  assert.equal(result.document.metadata?.["parserRouterSelectedParserId"], "paid");
  assert.equal(paid.parseCount, 1);
  assert.equal(fallback.parseCount, 0);
});

test("parser router respects content type, input mode, and byte limits", async () => {
  const ineligible = fakeParser("image-only", {
    body: "image",
    capabilities: {
      inputMode: "binary",
      supportedContentTypes: ["image/png"],
      maxBytes: 1
    }
  });
  const eligible = fakeParser("pdf", {
    body: "pdf text",
    capabilities: { supportedContentTypes: ["application/pdf"], maxBytes: 10 }
  });
  const router = new DocumentParserRouter({
    candidates: [
      { parser: ineligible, tier: "visual_local" },
      { parser: eligible, tier: "layout_local" }
    ]
  });

  const result = await router.parse(request);

  assert.equal(result.document.metadata?.["parserRouterSelectedParserId"], "pdf");
  assert.equal(result.document.metadata?.["parserRouterSkippedCandidateCount"], 1);
  assert.equal(ineligible.parseCount, 0);

  const trace = parserRouterTrace(result);
  const skipped = trace.attempts.find((attempt) => attempt.parserId === "image-only");
  assert.equal(skipped?.status, "skipped");
  assert.deepEqual(skipped?.reasons, [
    "parser does not support contentType=application/pdf",
    "request bytes exceed parser maxBytes=1"
  ]);
});

test("parser router records failed parser attempts without leaking raw error text into metadata", async () => {
  const failing = failingParser("failing", new Error("provider token=secret failed"));
  const fallback = fakeParser("fallback", { body: "fallback text" });
  const router = new DocumentParserRouter({
    candidates: [
      { parser: failing, tier: "layout_local" },
      { parser: fallback, tier: "fallback" }
    ]
  });

  const result = await router.parse(request);

  assert.equal(result.document.metadata?.["parserRouterSelectedParserId"], "fallback");
  assert.equal(result.document.metadata?.["parserRouterFailedAttemptCount"], 1);
  assert.equal(result.warnings[0]?.code, "parser_router_attempt_failed");
  assert.equal((result.warnings[0]?.message ?? "").includes("token=secret"), false);
  assert.match(result.warnings[0]?.message ?? "", /token=\[REDACTED\]/u);

  const traceJson = String(result.document.metadata?.["parserRouterTraceJson"]);
  assert.equal(traceJson.includes("token=secret"), false);
  const trace = parserRouterTrace(result);
  assert.deepEqual(trace.attempts[0]?.reasons, ["parser failed during parse with Error"]);
});

test("parser router rejects parserFailed fallback results even when body is present", async () => {
  const failedFallback = fakeParser("failed-fallback", {
    body: "fallback body from failed parser",
    metadata: { parserFailed: true, parserFailureCode: "command_layout_failed" }
  });
  const clean = fakeParser("clean", { body: "clean parser body" });
  const router = new DocumentParserRouter({
    candidates: [
      { parser: failedFallback, tier: "layout_local" },
      { parser: clean, tier: "fallback" }
    ]
  });

  const result = await router.parse(request);

  assert.equal(result.document.metadata?.["parserRouterSelectedParserId"], "clean");
  assert.equal(result.document.metadata?.["parserRouterRejectedAttemptCount"], 1);
  assert.equal(result.warnings[0]?.code, "parser_router_attempt_rejected");
  const trace = parserRouterTrace(result);
  assert.equal(trace.attempts[0]?.status, "rejected");
  assert.equal(trace.attempts[0]?.parserFailed, true);
  assert.equal(trace.attempts[0]?.qualityScore, 40);
  assert.deepEqual(trace.attempts[0]?.reasons, ["parser reported failure"]);
});

test("parser router treats image placeholders as empty body text", async () => {
  const placeholder = fakeParser("placeholder-layout", {
    body: "<!-- image -->",
    layout: imagePlaceholderLayout()
  });
  const ocr = fakeParser("ocr", { body: "ocr text", layout: layoutFixture() });
  const router = new DocumentParserRouter({
    candidates: [
      { parser: placeholder, tier: "layout_local" },
      { parser: ocr, tier: "visual_local" }
    ]
  });
  const result = await router.parse({
    sourceId: request.sourceId,
    sourceKind: request.sourceKind,
    title: "scan.png",
    contentType: "image/png",
    bytes: new Uint8Array([1, 2, 3]),
    requestedAt
  });

  assert.equal(result.document.metadata?.["parserRouterSelectedParserId"], "ocr");
  assert.equal(result.document.metadata?.["parserRouterRejectedAttemptCount"], 1);
  const trace = parserRouterTrace(result);
  assert.equal(trace.attempts[0]?.bodyCharacters, 0);
  assert.deepEqual(trace.attempts[0]?.reasons, ["body had 0 character(s), below 1"]);
});

test("parser router accepts visual-only image parses when a visual asset is emitted", async () => {
  const visualOnly = fakeParser("visual-only-layout", {
    body: "<!-- image -->",
    layout: imageVisualAssetLayout()
  });
  const router = new DocumentParserRouter({
    candidates: [{ parser: visualOnly, tier: "layout_local", requireLayout: true }]
  });
  const result = await router.parse({
    sourceId: request.sourceId,
    sourceKind: request.sourceKind,
    title: "scan.png",
    contentType: "image/png",
    bytes: new Uint8Array([1, 2, 3]),
    requestedAt
  });

  assert.equal(result.document.metadata?.["parserRouterSelectedParserId"], "visual-only-layout");
  const trace = parserRouterTrace(result);
  assert.equal(trace.attempts[0]?.status, "accepted");
  assert.equal(trace.attempts[0]?.bodyCharacters, 0);
  assert.equal(trace.attempts[0]?.visualAssetCount, 1);
});

function fakeParser(
  id: string,
  options: {
    readonly body: string;
    readonly layout?: DocumentLayout;
    readonly metadata?: Readonly<Record<string, string | number | boolean>>;
    readonly capabilities?: Partial<DocumentParserCapabilities>;
  }
): DocumentParser & { readonly parseCount: number } {
  let parseCount = 0;
  const parser: DocumentParser & { readonly parseCount: number } = {
    id,
    description: `${id} parser`,
    capabilities: {
      inputMode: "text_or_binary",
      emitsLayout: options.layout !== undefined,
      emitsTables: options.layout?.tables !== undefined,
      emitsVisualAssets: options.layout?.visualAssets !== undefined,
      ...options.capabilities
    },
    get parseCount() {
      return parseCount;
    },
    async parse(parseRequest: DocumentParseRequest): Promise<DocumentParseResult> {
      parseCount += 1;
      return {
        sourceId: parseRequest.sourceId,
        parserId: id,
        document: {
          body: options.body,
          ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
          ...(options.layout === undefined ? {} : { layout: options.layout })
        },
        warnings: []
      };
    }
  };
  return parser;
}

function failingParser(id: string, error: Error): DocumentParser & { readonly parseCount: number } {
  let parseCount = 0;
  const parser: DocumentParser & { readonly parseCount: number } = {
    id,
    description: `${id} parser`,
    capabilities: {
      inputMode: "text_or_binary",
      emitsLayout: false,
      emitsTables: false,
      emitsVisualAssets: false
    },
    get parseCount() {
      return parseCount;
    },
    async parse(): Promise<DocumentParseResult> {
      parseCount += 1;
      throw error;
    }
  };
  return parser;
}

function parserRouterTrace(result: DocumentParseResult): ParserRouterTrace {
  const traceJson = result.document.metadata?.["parserRouterTraceJson"];
  assert.equal(typeof traceJson, "string");
  if (typeof traceJson !== "string") {
    throw new Error("parserRouterTraceJson was not a string.");
  }
  return JSON.parse(traceJson) as ParserRouterTrace;
}

function layoutFixture(): DocumentLayout {
  return {
    parserId: "test-layout",
    strategy: "hybrid",
    pages: [{ pageNumber: 1, width: 612, height: 792, unit: "point" }],
    regions: [
      {
        id: "region_1",
        kind: "paragraph",
        pageNumber: 1,
        text: "layout text",
        characterStart: 0,
        characterEnd: 11
      }
    ],
    tables: [],
    visualAssets: []
  };
}

function tableLayoutFixture(): DocumentLayout {
  return {
    ...layoutFixture(),
    regions: [
      {
        id: "table_region",
        kind: "table",
        pageNumber: 1,
        text: "layout text",
        characterStart: 0,
        characterEnd: 11
      }
    ],
    tables: [{ id: "table_1", pageNumber: 1, regionId: "table_region", cells: [] }]
  };
}

function imagePlaceholderLayout(): DocumentLayout {
  return {
    parserId: "image-placeholder",
    strategy: "visual_page",
    pages: [{ pageNumber: 1, width: 160, height: 100, unit: "pixel" }],
    regions: [
      {
        id: "page_image_1",
        kind: "page_image",
        pageNumber: 1
      }
    ],
    tables: [],
    visualAssets: []
  };
}

function imageVisualAssetLayout(): DocumentLayout {
  return {
    ...imagePlaceholderLayout(),
    visualAssets: [
      {
        id: "page_image_asset",
        kind: "page_image",
        pageNumber: 1,
        mediaType: "image/png",
        uri: "file:///tmp/scan.png"
      }
    ]
  };
}
