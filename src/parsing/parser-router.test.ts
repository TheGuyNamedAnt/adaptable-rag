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
  assert.match(result.warnings[0]?.message ?? "", /token=secret/u);

  const traceJson = String(result.document.metadata?.["parserRouterTraceJson"]);
  assert.equal(traceJson.includes("token=secret"), false);
  const trace = parserRouterTrace(result);
  assert.deepEqual(trace.attempts[0]?.reasons, ["parser failed during parse with Error"]);
});

function fakeParser(
  id: string,
  options: {
    readonly body: string;
    readonly layout?: DocumentLayout;
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
