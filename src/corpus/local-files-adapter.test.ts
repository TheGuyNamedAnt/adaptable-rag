import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { DocumentLayout } from "../documents/layout.js";
import type { DocumentParser, DocumentParseResult } from "../parsing/parser.js";
import { hashText } from "../shared/hash.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { CorpusAdapterRegistry } from "./adapter-registry.js";
import { sampleSupportProfile } from "../profiles/examples/sample-support.profile.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { IngestPipeline } from "../ingestion/ingest-pipeline.js";
import { FIXED_NOW, makeIndexFilter, makePrincipal } from "../test-support/fixtures.js";
import { LocalFilesCorpusAdapter } from "./local-files-adapter.js";

const genericProfile = assertValidProfile(genericDocsProfile);
const sampleProfile = assertValidProfile(sampleSupportProfile);
const genericSource = genericProfile.corpusSources[0];
const feedbackSource = sampleProfile.corpusSources.find(
  (source) => source.id === "feedback_examples"
);

assert.ok(genericSource);
assert.ok(feedbackSource);

test("loads local text files as corpus records with safe defaults", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-local-files-"));
  try {
    const body = "# Deployment Guide\n\nDeployment approval requires a rollback note.";
    await writeFile(path.join(tempDir, "deployment-guide.md"), body);

    const principal = makePrincipal({
      tenantId: "tenant_1",
      namespaceIds: [genericProfile.namespaceId],
      tags: ["curated", "docs"]
    });
    const adapter = new LocalFilesCorpusAdapter({
      sources: [
        {
          sourceId: genericSource.id,
          rootDir: tempDir,
          capturedAt: FIXED_NOW,
          originUriBase: "repo://docs"
        }
      ]
    });
    const loaded = await adapter.load({
      profile: genericProfile,
      source: genericSource,
      requestedBy: principal,
      runId: "local_files_test",
      requestedAt: FIXED_NOW
    });

    assert.equal(loaded.warnings.length, 0);
    assert.equal(loaded.records.length, 1);
    const record = loaded.records[0];
    assert.ok(record);
    assert.equal(record.sourceId, genericSource.id);
    assert.equal(record.sourceKind, "local_file");
    assert.equal(record.title, "Deployment Guide");
    assert.equal(record.path, "deployment-guide.md");
    assert.equal(record.originUri, "repo://docs/deployment-guide.md");
    assert.equal(record.capturedAt, FIXED_NOW);
    assert.equal(record.checksum, hashText(body));
    assert.deepEqual(record.accessScope, {
      tenantId: "tenant_1",
      namespaceId: genericProfile.namespaceId,
      tags: genericSource.tags
    });
    assert.equal(record.metadata?.["relativePath"], "deployment-guide.md");
    assert.equal(record.metadata?.["extension"], ".md");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loads parser-backed local files with layout evidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-local-files-"));
  try {
    await writeFile(path.join(tempDir, "policy.pdf"), new Uint8Array([37, 80, 68, 70, 0]));
    const parsedBody = "Parsed PDF Title\n\nParsed fact from PDF.";
    const parser = fixtureParser({
      body: parsedBody,
      layout: layoutForParsedBody(parsedBody)
    });
    const principal = makePrincipal({
      tenantId: "tenant_1",
      namespaceIds: [genericProfile.namespaceId],
      tags: ["curated", "docs"]
    });
    const adapter = new LocalFilesCorpusAdapter({
      parsers: [parser],
      sources: [
        {
          sourceId: genericSource.id,
          rootDir: tempDir,
          includeExtensions: [".pdf"],
          parserId: parser.id,
          parserRequireLayout: true,
          capturedAt: FIXED_NOW
        }
      ]
    });

    const loaded = await adapter.load({
      profile: genericProfile,
      source: genericSource,
      requestedBy: principal,
      runId: "local_files_parser_test",
      requestedAt: FIXED_NOW
    });

    assert.equal(loaded.warnings.length, 0);
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.records[0]?.body, parsedBody);
    assert.equal(loaded.records[0]?.layout?.parserId, parser.id);
    assert.equal(loaded.records[0]?.checksum, hashText(parsedBody));
    assert.equal(loaded.records[0]?.metadata?.["parserId"], parser.id);

    const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
    const pipeline = new IngestPipeline({
      adapterRegistry: new CorpusAdapterRegistry([adapter]),
      documentStore: index,
      chunkStore: index,
      now: () => FIXED_NOW
    });
    const result = await pipeline.ingest({
      profile: genericProfile,
      requestedBy: principal,
      sourceIds: [genericSource.id],
      requestedAt: FIXED_NOW
    });

    assert.equal(result.rejectedRecords.length, 0);
    assert.equal(result.documents.length, 1);
    assert.equal(result.chunks.length, 3);
    const layoutRegionIds = result.chunks.flatMap((chunk) => chunk.citation.layoutRegionIds ?? []);
    assert.equal(layoutRegionIds.includes("region_title"), true);
    assert.equal(layoutRegionIds.includes("region_body"), true);
    assert.equal(
      result.chunks.reduce(
        (count, chunk) => count + (chunk.citation.boundingBoxes?.length ?? 0),
        0
      ),
      5
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("parser-backed local files respect parserConcurrency and keep deterministic outputs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-local-files-"));
  try {
    for (const filename of ["a.pdf", "b.pdf", "c.pdf", "d.pdf"]) {
      await writeFile(path.join(tempDir, filename), new Uint8Array([37, 80, 68, 70]));
    }

    let activeParses = 0;
    let maxActiveParses = 0;
    const parser: DocumentParser = {
      id: "slow-pdf-parser",
      description: "Slow fixture parser for concurrency tests.",
      version: "1.0.0",
      capabilities: {
        inputMode: "binary",
        emitsLayout: false,
        emitsTables: false,
        emitsVisualAssets: false,
        supportedContentTypes: ["application/pdf"]
      },
      async parse(request): Promise<DocumentParseResult> {
        activeParses += 1;
        maxActiveParses = Math.max(maxActiveParses, activeParses);
        try {
          await delay(delayForPath(request.path));
          return {
            sourceId: request.sourceId,
            parserId: "slow-pdf-parser",
            parserVersion: "1.0.0",
            document: {
              body: `Parsed ${request.path ?? "unknown"}`
            },
            warnings: [
              {
                code: "concurrency_probe",
                message: `Completed ${request.path ?? "unknown"}`
              }
            ]
          };
        } finally {
          activeParses -= 1;
        }
      }
    };

    const loaded = await new LocalFilesCorpusAdapter({
      parsers: [parser],
      sources: [
        {
          sourceId: genericSource.id,
          rootDir: tempDir,
          includeExtensions: [".pdf"],
          parserId: parser.id,
          parserConcurrency: 2,
          capturedAt: FIXED_NOW
        }
      ]
    }).load({
      profile: genericProfile,
      source: genericSource,
      requestedBy: makePrincipal({
        tenantId: "tenant_1",
        namespaceIds: [genericProfile.namespaceId],
        tags: ["curated", "docs"]
      }),
      runId: "local_files_concurrent_parser_test",
      requestedAt: FIXED_NOW
    });

    assert.equal(maxActiveParses, 2);
    assert.deepEqual(
      loaded.records.map((record) => record?.path),
      ["a.pdf", "b.pdf", "c.pdf", "d.pdf"]
    );
    assert.deepEqual(
      loaded.warnings.map((warning) => warning.message.match(/for ([^:]+):/u)?.[1]),
      ["a.pdf", "b.pdf", "c.pdf", "d.pdf"]
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("auto-selects registered parser by file type without source parserId", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-local-files-"));
  try {
    await writeFile(path.join(tempDir, "policy.pdf"), new Uint8Array([37, 80, 68, 70]));
    const parsedBody = "Auto Parsed PDF\n\nAuto parsed fact from PDF.";
    const parser = fixtureParser({
      body: parsedBody,
      layout: layoutForParsedBody(parsedBody)
    });

    const loaded = await new LocalFilesCorpusAdapter({
      parsers: [parser],
      sources: [
        {
          sourceId: genericSource.id,
          rootDir: tempDir,
          includeExtensions: [".pdf"],
          capturedAt: FIXED_NOW
        }
      ]
    }).load({
      profile: genericProfile,
      source: genericSource,
      requestedBy: makePrincipal({
        tenantId: "tenant_1",
        namespaceIds: [genericProfile.namespaceId],
        tags: ["curated", "docs"]
      }),
      runId: "local_files_auto_parser_test",
      requestedAt: FIXED_NOW
    });

    assert.equal(loaded.warnings.length, 0);
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.records[0]?.body, parsedBody);
    assert.equal(loaded.records[0]?.layout?.parserId, parser.id);
    assert.equal(loaded.records[0]?.metadata?.["parserId"], parser.id);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("auto-selects parser from file signature when extension is wrong", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-local-files-"));
  try {
    await writeFile(path.join(tempDir, "policy.txt"), new Uint8Array([37, 80, 68, 70, 45]));
    const parsedBody = "Signature Parsed PDF\n\nParsed despite a .txt extension.";
    const parser = fixtureParser({
      body: parsedBody,
      layout: layoutForParsedBody(parsedBody)
    });

    const loaded = await new LocalFilesCorpusAdapter({
      parsers: [parser],
      sources: [
        {
          sourceId: genericSource.id,
          rootDir: tempDir,
          includeExtensions: [".txt"],
          capturedAt: FIXED_NOW
        }
      ]
    }).load({
      profile: genericProfile,
      source: genericSource,
      requestedBy: makePrincipal({
        tenantId: "tenant_1",
        namespaceIds: [genericProfile.namespaceId],
        tags: ["curated", "docs"]
      }),
      runId: "local_files_signature_parser_test",
      requestedAt: FIXED_NOW
    });

    assert.equal(loaded.warnings.length, 0);
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.records[0]?.body, parsedBody);
    assert.equal(loaded.records[0]?.metadata?.["extension"], ".txt");
    assert.equal(loaded.records[0]?.metadata?.["contentType"], "application/pdf");
    assert.equal(loaded.records[0]?.metadata?.["contentTypeSource"], "signature");
    assert.equal(loaded.records[0]?.metadata?.["extensionContentType"], "text/plain");
    assert.equal(loaded.records[0]?.metadata?.["signatureContentType"], "application/pdf");
    assert.equal(loaded.records[0]?.metadata?.["parserId"], parser.id);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("auto-selects text parser from HTML signature when extension is wrong", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-local-files-"));
  try {
    await writeFile(
      path.join(tempDir, "policy.txt"),
      "<!doctype html><html><body><h1>HTML Policy</h1></body></html>"
    );
    const parser: DocumentParser = {
      id: "fixture-html-parser",
      description: "Fixture HTML parser for local file tests.",
      version: "1.0.0",
      capabilities: {
        inputMode: "text",
        emitsLayout: false,
        emitsTables: false,
        emitsVisualAssets: false,
        supportedContentTypes: ["text/html"]
      },
      async parse(request): Promise<DocumentParseResult> {
        assert.equal(request.contentType, "text/html");
        assert.match(request.text ?? "", /HTML Policy/u);
        return {
          sourceId: request.sourceId,
          parserId: "fixture-html-parser",
          parserVersion: "1.0.0",
          document: {
            body: "HTML Policy"
          },
          warnings: []
        };
      }
    };

    const loaded = await new LocalFilesCorpusAdapter({
      parsers: [parser],
      sources: [
        {
          sourceId: genericSource.id,
          rootDir: tempDir,
          includeExtensions: [".txt"],
          capturedAt: FIXED_NOW
        }
      ]
    }).load({
      profile: genericProfile,
      source: genericSource,
      requestedBy: makePrincipal({
        tenantId: "tenant_1",
        namespaceIds: [genericProfile.namespaceId],
        tags: ["curated", "docs"]
      }),
      runId: "local_files_html_signature_parser_test",
      requestedAt: FIXED_NOW
    });

    assert.equal(loaded.warnings.length, 0);
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.records[0]?.body, "HTML Policy");
    assert.equal(loaded.records[0]?.metadata?.["contentType"], "text/html");
    assert.equal(loaded.records[0]?.metadata?.["contentTypeSource"], "signature");
    assert.equal(loaded.records[0]?.metadata?.["parserId"], parser.id);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("prefers HTML extension over XML signature for SEC-style HTML files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-local-files-"));
  try {
    await writeFile(
      path.join(tempDir, "filing.htm"),
      '<?xml version="1.0" encoding="utf-8"?><html><body><h1>SEC Filing</h1></body></html>'
    );
    const parser: DocumentParser = {
      id: "fixture-sec-html-parser",
      description: "Fixture SEC HTML parser for local file tests.",
      version: "1.0.0",
      capabilities: {
        inputMode: "text",
        emitsLayout: false,
        emitsTables: true,
        emitsVisualAssets: false,
        supportedContentTypes: ["text/html"]
      },
      async parse(request): Promise<DocumentParseResult> {
        assert.equal(request.contentType, "text/html");
        assert.match(request.text ?? "", /SEC Filing/u);
        return {
          sourceId: request.sourceId,
          parserId: "fixture-sec-html-parser",
          parserVersion: "1.0.0",
          document: {
            body: "SEC Filing"
          },
          warnings: []
        };
      }
    };

    const loaded = await new LocalFilesCorpusAdapter({
      parsers: [parser],
      sources: [
        {
          sourceId: genericSource.id,
          rootDir: tempDir,
          includeExtensions: [".htm"],
          capturedAt: FIXED_NOW
        }
      ]
    }).load({
      profile: genericProfile,
      source: genericSource,
      requestedBy: makePrincipal({
        tenantId: "tenant_1",
        namespaceIds: [genericProfile.namespaceId],
        tags: ["curated", "docs"]
      }),
      runId: "local_files_sec_html_xml_signature_test",
      requestedAt: FIXED_NOW
    });

    assert.equal(loaded.warnings.length, 0);
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.records[0]?.body, "SEC Filing");
    assert.equal(loaded.records[0]?.metadata?.["contentType"], "text/html");
    assert.equal(loaded.records[0]?.metadata?.["contentTypeSource"], "extension");
    assert.equal(loaded.records[0]?.metadata?.["extensionContentType"], "text/html");
    assert.equal(loaded.records[0]?.metadata?.["signatureContentType"], "application/xml");
    assert.equal(loaded.records[0]?.metadata?.["parserId"], parser.id);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("auto parser selection does not guess for unknown content types", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-local-files-"));
  try {
    const body = "export const policy = 'raw text path';";
    await writeFile(path.join(tempDir, "policy.ts"), body);
    let parserAttempted = false;
    const catchAllParser: DocumentParser = {
      id: "catch-all-parser",
      description: "Should not be used for unknown content types in auto mode.",
      version: "1.0.0",
      capabilities: {
        inputMode: "text",
        emitsLayout: false,
        emitsTables: false,
        emitsVisualAssets: false
      },
      async parse(): Promise<DocumentParseResult> {
        parserAttempted = true;
        throw new Error("Auto mode should not guess parser for unknown file types.");
      }
    };

    const loaded = await new LocalFilesCorpusAdapter({
      parsers: [catchAllParser],
      sources: [
        {
          sourceId: genericSource.id,
          rootDir: tempDir,
          includeExtensions: [".ts"],
          capturedAt: FIXED_NOW
        }
      ]
    }).load({
      profile: genericProfile,
      source: genericSource,
      requestedBy: makePrincipal({
        tenantId: "tenant_1",
        namespaceIds: [genericProfile.namespaceId],
        tags: ["curated", "docs"]
      }),
      runId: "local_files_unknown_auto_parser_test",
      requestedAt: FIXED_NOW
    });

    assert.equal(parserAttempted, false);
    assert.equal(loaded.warnings.length, 0);
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.records[0]?.body, body);
    assert.equal(loaded.records[0]?.metadata?.["parserId"], undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("parserMode disabled keeps parser-backed local files on raw-file path", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-local-files-"));
  try {
    await writeFile(path.join(tempDir, "policy.pdf"), new Uint8Array([37, 80, 68, 70, 0]));
    const parser = fixtureParser({
      body: "This body should not be used.",
      layout: layoutForParsedBody("This body should not be used.")
    });

    const loaded = await new LocalFilesCorpusAdapter({
      parsers: [parser],
      sources: [
        {
          sourceId: genericSource.id,
          rootDir: tempDir,
          includeExtensions: [".pdf"],
          parserMode: "disabled"
        }
      ]
    }).load({
      profile: genericProfile,
      source: genericSource,
      requestedBy: makePrincipal({
        tenantId: "tenant_1",
        namespaceIds: [genericProfile.namespaceId],
        tags: ["curated", "docs"]
      }),
      runId: "local_files_parser_disabled_test",
      requestedAt: FIXED_NOW
    });

    assert.equal(loaded.records.length, 0);
    assertWarningCodes(loaded.warnings, ["binary_file_skipped"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("raw html fallback strips tags and preserves table rows", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-local-files-"));
  try {
    const html = `<!doctype html>
<html>
  <head>
    <style>.hidden { display: none; }</style>
    <script>window.secret = "do not index";</script>
  </head>
  <body>
    <h1>Exhibit 21</h1>
    <table>
      <tr><th>Name of Subsidiary</th><th>Jurisdiction</th></tr>
      <tr><td>Google LLC</td><td>Delaware</td></tr>
      <tr><td>XXVI Holdings Inc.</td><td>Delaware</td></tr>
    </table>
    <p>Alphabet &amp; subsidiaries filing.</p>
  </body>
    </html>`;
    await writeFile(path.join(tempDir, "exhibit.htm"), html);
    let parserAttempted = false;
    const parser: DocumentParser = {
      id: "fixture-html-parser",
      description: "Fixture HTML parser that should be bypassed.",
      version: "1.0.0",
      capabilities: {
        inputMode: "text",
        emitsLayout: true,
        emitsTables: true,
        emitsVisualAssets: false,
        supportedContentTypes: ["text/html"]
      },
      async parse(): Promise<DocumentParseResult> {
        parserAttempted = true;
        throw new Error("Parser should be disabled.");
      }
    };

    const loaded = await new LocalFilesCorpusAdapter({
      parsers: [parser],
      sources: [
        {
          sourceId: genericSource.id,
          rootDir: tempDir,
          includeExtensions: [".htm"],
          parserMode: "disabled",
          capturedAt: FIXED_NOW
        }
      ]
    }).load({
      profile: genericProfile,
      source: genericSource,
      requestedBy: makePrincipal({
        tenantId: "tenant_1",
        namespaceIds: [genericProfile.namespaceId],
        tags: ["curated", "docs"]
      }),
      runId: "local_files_raw_html_fallback_test",
      requestedAt: FIXED_NOW
    });

    const record = loaded.records[0];
    assert.equal(parserAttempted, false);
    assert.equal(loaded.warnings.length, 0);
    assert.ok(record);
    assert.equal(record.body.includes("<td>"), false);
    assert.equal(record.body.includes("display: none"), false);
    assert.equal(record.body.includes("do not index"), false);
    assert.equal(record.body.includes("Name of Subsidiary | Jurisdiction"), true);
    assert.equal(record.body.includes("Google LLC | Delaware"), true);
    assert.equal(record.body.includes("Alphabet & subsidiaries filing."), true);
    assert.equal(record.checksum, hashText(record.body));
    assert.equal(record.metadata?.["contentType"], "text/html");
    assert.equal(record.metadata?.["rawTextTransform"], "html_to_text");
    assert.equal(record.metadata?.["rawTextOriginalHash"], hashText(html));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("parser-backed local files fail closed on missing parser and required layout", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-local-files-"));
  try {
    await writeFile(path.join(tempDir, "policy.pdf"), new Uint8Array([37, 80, 68, 70]));
    const principal = makePrincipal({
      tenantId: "tenant_1",
      namespaceIds: [genericProfile.namespaceId],
      tags: ["curated", "docs"]
    });

    const missingParser = await new LocalFilesCorpusAdapter({
      sources: [
        {
          sourceId: genericSource.id,
          rootDir: tempDir,
          includeExtensions: [".pdf"],
          parserId: "missing-parser",
          parserRequireLayout: true
        }
      ]
    }).load({
      profile: genericProfile,
      source: genericSource,
      requestedBy: principal,
      runId: "local_files_missing_parser_test",
      requestedAt: FIXED_NOW
    });

    assert.equal(missingParser.records.length, 0);
    assertWarningCodes(missingParser.warnings, ["parser_missing"]);

    const noLayout = await new LocalFilesCorpusAdapter({
      parsers: [fixtureParser({ body: "Parsed body without layout." })],
      sources: [
        {
          sourceId: genericSource.id,
          rootDir: tempDir,
          includeExtensions: [".pdf"],
          parserId: "fixture-pdf-parser",
          parserRequireLayout: true
        }
      ]
    }).load({
      profile: genericProfile,
      source: genericSource,
      requestedBy: principal,
      runId: "local_files_missing_layout_test",
      requestedAt: FIXED_NOW
    });

    assert.equal(noLayout.records.length, 0);
    assertWarningCodes(noLayout.warnings, ["parser_output_invalid"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("redacts parser diagnostics before returning local-files warnings", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-local-files-"));
  try {
    await writeFile(path.join(tempDir, "policy.pdf"), new Uint8Array([37, 80, 68, 70]));
    const body = "Parsed warning body.";
    const parser = fixtureParser({
      body,
      layout: layoutForParsedBody(body),
      warnings: [
        {
          code: "ocr_provider_warning",
          message: "provider token=super-secret-token returned low confidence"
        }
      ]
    });
    const loaded = await new LocalFilesCorpusAdapter({
      parsers: [parser],
      sources: [
        {
          sourceId: genericSource.id,
          rootDir: tempDir,
          includeExtensions: [".pdf"],
          parserId: parser.id
        }
      ]
    }).load({
      profile: genericProfile,
      source: genericSource,
      requestedBy: makePrincipal({
        tenantId: "tenant_1",
        namespaceIds: [genericProfile.namespaceId],
        tags: ["curated", "docs"]
      }),
      runId: "local_files_parser_warning_test",
      requestedAt: FIXED_NOW
    });

    assert.equal(loaded.records.length, 1);
    assertWarningCodes(loaded.warnings, ["parser_warning"]);
    assert.equal(JSON.stringify(loaded.warnings).includes("super-secret-token"), false);
    assert.equal(JSON.stringify(loaded.warnings).includes("[REDACTED]"), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("skips hidden, excluded, oversized, symlinked, and unsupported local files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-local-files-"));
  try {
    await mkdir(path.join(tempDir, "node_modules"), { recursive: true });
    await writeFile(path.join(tempDir, "public.md"), "Public support policy.");
    await writeFile(path.join(tempDir, ".hidden.md"), "Hidden policy.");
    await writeFile(path.join(tempDir, "node_modules", "package.md"), "Dependency docs.");
    await writeFile(path.join(tempDir, "archive.bin"), "unsupported binary-looking fixture");
    await writeFile(path.join(tempDir, "large.md"), "This file is larger than the configured cap.");
    await symlink("public.md", path.join(tempDir, "linked.md"));

    const adapter = new LocalFilesCorpusAdapter({
      sources: [
        {
          sourceId: genericSource.id,
          rootDir: tempDir,
          capturedAt: FIXED_NOW,
          maxFileBytes: 25
        }
      ]
    });
    const loaded = await adapter.load({
      profile: genericProfile,
      source: genericSource,
      requestedBy: makePrincipal({
        tenantId: "tenant_1",
        namespaceIds: [genericProfile.namespaceId],
        tags: ["curated", "docs"]
      }),
      runId: "local_files_skip_test",
      requestedAt: FIXED_NOW
    });

    assert.deepEqual(
      loaded.records.map((record) => record?.path),
      ["public.md"]
    );
    assertWarningCodes(loaded.warnings, [
      "hidden_path_skipped",
      "excluded_directory_skipped",
      "extension_skipped",
      "file_too_large",
      "symlink_skipped"
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("does not load explicit files outside the configured source root", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-local-files-"));
  try {
    const rootDir = path.join(tempDir, "root");
    await mkdir(rootDir);
    await writeFile(path.join(tempDir, "outside.md"), "Outside root.");

    const adapter = new LocalFilesCorpusAdapter({
      sources: [
        {
          sourceId: genericSource.id,
          rootDir,
          files: ["../outside.md"],
          capturedAt: FIXED_NOW
        }
      ]
    });
    const loaded = await adapter.load({
      profile: genericProfile,
      source: genericSource,
      requestedBy: makePrincipal({
        tenantId: "tenant_1",
        namespaceIds: [genericProfile.namespaceId],
        tags: ["curated", "docs"]
      }),
      runId: "local_files_traversal_test",
      requestedAt: FIXED_NOW
    });

    assert.equal(loaded.records.length, 0);
    assertWarningCodes(loaded.warnings, ["path_outside_root"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ingests local files through the pipeline into the index", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-local-files-"));
  try {
    await writeFile(
      path.join(tempDir, "refund-policy.md"),
      "# Refund Policy\n\nRefund policy requires support review."
    );

    const principal = makePrincipal({
      tenantId: "tenant_1",
      namespaceIds: [genericProfile.namespaceId],
      roles: ["reader"],
      tags: ["curated", "docs"]
    });
    const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
    const registry = new CorpusAdapterRegistry([
      new LocalFilesCorpusAdapter({
        sources: [
          {
            sourceId: genericSource.id,
            rootDir: tempDir,
            capturedAt: FIXED_NOW,
            accessScope: {
              roles: ["reader"],
              tags: ["curated", "docs"]
            }
          }
        ]
      })
    ]);
    const pipeline = new IngestPipeline({
      adapterRegistry: registry,
      documentStore: index,
      chunkStore: index,
      now: () => FIXED_NOW
    });

    const result = await pipeline.ingest({
      profile: genericProfile,
      requestedBy: principal,
      requestedAt: FIXED_NOW
    });

    const filter = makeIndexFilter({
      namespaceId: genericProfile.namespaceId,
      tenantId: principal.tenantId,
      principal
    });
    assert.equal(result.rejectedRecords.length, 0);
    assert.equal(result.documents.length, 1);
    assert.equal(result.chunks.length, 1);
    assert.equal(index.findDocuments(filter).length, 1);
    assert.equal(index.findChunks(filter).length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("adapter output cannot promote records above a source trust floor", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-local-files-"));
  try {
    await writeFile(
      path.join(tempDir, "feedback-ticket.md"),
      "# Feedback Ticket\n\nUser reported a billing problem."
    );

    const principal = makePrincipal({
      tenantId: "tenant_1",
      namespaceIds: [sampleProfile.namespaceId],
      roles: ["support"],
      tags: ["examples", "user_provided"]
    });
    const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
    const pipeline = new IngestPipeline({
      adapterRegistry: new CorpusAdapterRegistry([
        new LocalFilesCorpusAdapter({
          sources: [
            {
              sourceId: feedbackSource.id,
              rootDir: tempDir,
              capturedAt: FIXED_NOW,
              sourceKind: "support_ticket",
              trustTier: "trusted_internal",
              sensitivity: "confidential"
            }
          ]
        })
      ]),
      documentStore: index,
      chunkStore: index,
      now: () => FIXED_NOW
    });

    const result = await pipeline.ingest({
      profile: sampleProfile,
      requestedBy: principal,
      sourceIds: [feedbackSource.id],
      requestedAt: FIXED_NOW
    });

    assert.equal(result.rejectedRecords.length, 0);
    assert.equal(result.documents.length, 1);
    assert.equal(result.documents[0]?.provenance.trustTier, "user_provided");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("returns a warning instead of records when source config is missing", async () => {
  const adapter = new LocalFilesCorpusAdapter({ sources: [] });
  const loaded = await adapter.load({
    profile: genericProfile,
    source: genericSource,
    requestedBy: makePrincipal({
      tenantId: "tenant_1",
      namespaceIds: [genericProfile.namespaceId],
      tags: ["curated", "docs"]
    }),
    runId: "local_files_missing_config_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(loaded.records.length, 0);
  assertWarningCodes(loaded.warnings, ["missing_source_config"]);
});

function assertWarningCodes(
  warnings: readonly { readonly code: string }[],
  expectedCodes: readonly string[]
): void {
  for (const code of expectedCodes) {
    assert.equal(
      warnings.some((warning) => warning.code === code),
      true,
      `Expected warning code ${code}. Actual: ${warnings.map((warning) => warning.code).join(", ")}`
    );
  }
}

function fixtureParser(options: {
  readonly body: string;
  readonly layout?: DocumentLayout;
  readonly warnings?: readonly { readonly code: string; readonly message: string }[];
}): DocumentParser {
  return {
    id: "fixture-pdf-parser",
    description: "Fixture PDF parser for local file tests.",
    version: "1.0.0",
    capabilities: {
      inputMode: "binary",
      emitsLayout: options.layout !== undefined,
      emitsTables: false,
      emitsVisualAssets: false,
      supportedContentTypes: ["application/pdf"]
    },
    async parse(request): Promise<DocumentParseResult> {
      assert.ok(request.bytes);
      assert.equal(request.contentType, "application/pdf");
      return {
        sourceId: request.sourceId,
        parserId: "fixture-pdf-parser",
        parserVersion: "1.0.0",
        document: {
          body: options.body,
          ...(options.layout ? { layout: options.layout } : {})
        },
        warnings: options.warnings ?? []
      };
    }
  };
}

function delayForPath(filePath: string | undefined): number {
  switch (filePath) {
    case "a.pdf":
      return 40;
    case "b.pdf":
      return 5;
    case "c.pdf":
      return 15;
    case "d.pdf":
      return 1;
    default:
      return 1;
  }
}

function layoutForParsedBody(body: string): DocumentLayout {
  const titleEnd = body.includes("\n\n") ? body.indexOf("\n\n") : body.length;
  const bodyStart = titleEnd === body.length ? 0 : titleEnd + 2;
  return {
    parserId: "fixture-pdf-parser",
    parserVersion: "1.0.0",
    strategy: "ocr_layout",
    pages: [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        unit: "point"
      }
    ],
    regions: [
      {
        id: "region_title",
        kind: "title",
        pageNumber: 1,
        text: body.slice(0, titleEnd),
        characterStart: 0,
        characterEnd: titleEnd,
        box: {
          pageNumber: 1,
          x: 40,
          y: 40,
          width: 300,
          height: 30,
          unit: "point"
        }
      },
      {
        id: "region_body",
        kind: "paragraph",
        pageNumber: 1,
        text: body.slice(bodyStart),
        characterStart: bodyStart,
        characterEnd: body.length,
        box: {
          pageNumber: 1,
          x: 40,
          y: 90,
          width: 400,
          height: 80,
          unit: "point"
        }
      }
    ]
  };
}
