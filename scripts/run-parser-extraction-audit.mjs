#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  assertValidProfile,
  chunkDocument,
  createBestCombinedLocalParserRouter,
  genericDocsProfile,
  InMemoryRagIndex,
  KeywordRetriever,
  LocalFilesCorpusAdapter
} from "../dist/index.js";
import { normalizeCorpusRecords } from "../dist/corpus/normalize.js";
import { buildSearchableArtifacts } from "../dist/ingestion/searchable-artifacts.js";

const DEFAULT_SOURCES_PATH = path.join(".rag", "parser-smoke-corpus", "local-files.sources.json");
const DEFAULT_REPORT_DIR = path.join(".rag", "parser-extraction-audit", "latest");
const FIXED_REQUESTED_AT = "2026-06-25T00:00:00.000Z";

const options = parseArgs(process.argv.slice(2));
const sourcesPath = options.sourcesPath ?? process.env.RAG_LOCAL_FILES_SOURCES_PATH;

if (!sourcesPath) {
  throw new Error("--sources or RAG_LOCAL_FILES_SOURCES_PATH is required.");
}

const profile = assertValidProfile(genericDocsProfile);
const reportDir = options.reportDir ?? DEFAULT_REPORT_DIR;
const localSources = await readLocalFilesSources(sourcesPath);
const localSourceConfig = localSources.find((candidate) => candidate.sourceId === options.sourceId);
const source = profile.corpusSources.find((candidate) => candidate.id === options.sourceId);

if (!source) {
  throw new Error(`Unknown profile source id "${options.sourceId}".`);
}

const requestedBy = {
  userId: options.userId,
  tenantId: options.tenantId,
  namespaceIds: [profile.namespaceId],
  teamIds: uniqueStrings([...(localSourceConfig?.accessScope?.teamIds ?? [])]),
  roles: uniqueStrings([...options.roles, ...(localSourceConfig?.accessScope?.roles ?? [])]),
  tags: uniqueStrings([...options.tags, ...(localSourceConfig?.accessScope?.tags ?? [])])
};
const adapter = new LocalFilesCorpusAdapter({
  sources: localSources,
  parsers: [createBestCombinedLocalParserRouter({ parserId: "best-local-parser" })]
});
const loaded = await adapter.load({
  profile,
  source,
  requestedBy,
  runId: options.runId,
  requestedAt: FIXED_REQUESTED_AT
});
const normalized = normalizeCorpusRecords(loaded.records, {
  profile,
  source,
  requestedBy,
  ingestedAt: FIXED_REQUESTED_AT
});

await mkdir(reportDir, { recursive: true });

const parsedDocsPath = path.join(reportDir, "parsed-docs.json");
await writeFile(
  parsedDocsPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      sourcesPath,
      sourceId: source.id,
      acceptedDocumentCount: normalized.documents.length,
      rejectedRecordCount: normalized.rejectedRecords.length,
      adapterWarningCount: loaded.warnings.length,
      normalizationIssueCount: normalized.issues.length,
      documents: normalized.documents,
      adapterWarnings: loaded.warnings,
      normalizationIssues: normalized.issues,
      rejectedRecords: normalized.rejectedRecords
    },
    null,
    2
  )
);

const pythonReport = runOriginalExtractionAudit({
  pythonPath: options.pythonPath,
  parsedDocsPath,
  sourcesPath,
  reportDir
});
const searchability = await runSearchabilitySmoke({
  documents: normalized.documents,
  requestedBy,
  profile
});

const report = {
  status:
    pythonReport.status === "passed" && searchability.summary.failed === 0 ? "passed" : "failed",
  generatedAt: new Date().toISOString(),
  sourcesPath,
  sourceId: source.id,
  acceptedDocumentCount: normalized.documents.length,
  rejectedRecordCount: normalized.rejectedRecords.length,
  adapterWarningCount: loaded.warnings.length,
  normalizationIssueCount: normalized.issues.length,
  extractionAudit: {
    status: pythonReport.status,
    summary: pythonReport.summary
  },
  searchability: searchability.summary,
  adapterWarnings: loaded.warnings,
  normalizationIssues: normalized.issues,
  rejectedRecords: normalized.rejectedRecords
};

await writeFile(
  path.join(reportDir, "searchability-smoke.json"),
  JSON.stringify(searchability, null, 2)
);
await writeFile(
  path.join(reportDir, "parser-extraction-audit-summary.json"),
  JSON.stringify(report, null, 2)
);
await writeFile(path.join(reportDir, "parser-extraction-audit-summary.md"), renderMarkdown(report));

console.log(JSON.stringify(report, null, 2));

if (report.status !== "passed") {
  process.exitCode = 1;
}

async function readLocalFilesSources(configPath) {
  const resolvedPath = path.resolve(configPath);
  const parsed = JSON.parse(await readFile(resolvedPath, "utf8"));
  const sources = Array.isArray(parsed) ? parsed : parsed.sources;
  if (!Array.isArray(sources)) {
    throw new Error(`${configPath} must be an array or an object with sources[].`);
  }

  const baseDirectory = path.dirname(resolvedPath);
  return sources.map((sourceConfig) => ({
    ...sourceConfig,
    rootDir: path.isAbsolute(sourceConfig.rootDir)
      ? sourceConfig.rootDir
      : path.resolve(baseDirectory, sourceConfig.rootDir)
  }));
}

function runOriginalExtractionAudit(input) {
  const pythonPath = input.pythonPath ?? defaultPythonPath();
  const scriptPath = path.resolve("scripts", "original_extraction_audit.py");
  const result = spawnSync(
    pythonPath,
    [
      scriptPath,
      "--parsed-docs",
      input.parsedDocsPath,
      "--sources",
      input.sourcesPath,
      "--report-dir",
      input.reportDir
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.error) {
    throw result.error;
  }
  let parsedOutput;
  try {
    parsedOutput = JSON.parse(result.stdout);
  } catch {
    parsedOutput = undefined;
  }
  if (result.status !== 0 && !parsedOutput) {
    throw new Error(`Original extraction audit failed with exit code ${result.status}.`);
  }
  if (!parsedOutput) {
    throw new Error("Original extraction audit did not print a JSON summary.");
  }

  return parsedOutput;
}

function defaultPythonPath() {
  const bundled = path.join(".rag", "parser-benchmark-venv", "bin", "python");
  if (existsSync(bundled)) {
    return bundled;
  }
  return process.env.PYTHON ?? "python3";
}

async function runSearchabilitySmoke(input) {
  const indexedAt = FIXED_REQUESTED_AT;
  const index = new InMemoryRagIndex({
    now: () => indexedAt
  });
  const warnings = [];
  const indexedDocuments = [];
  let chunkCount = 0;
  let derivedChunkCount = 0;

  for (const document of input.documents) {
    const bodyChunks = chunkDocument({ document }).chunks;
    const searchableArtifacts = buildSearchableArtifacts({ document, bodyChunks });
    warnings.push(...searchableArtifacts.warnings);
    const chunks = [...bodyChunks, ...searchableArtifacts.chunks];
    index.addDocument(document, { overwriteMode: "replace", indexedAt });
    index.addChunks(document.id, chunks, { overwriteMode: "replace", indexedAt });
    chunkCount += chunks.length;
    derivedChunkCount += searchableArtifacts.chunks.length;
    indexedDocuments.push({
      path: document.provenance.path ?? document.metadata?.relativePath ?? document.id,
      bodyChunkCount: bodyChunks.length,
      derivedChunkCount: searchableArtifacts.chunks.length
    });
  }

  const retriever = new KeywordRetriever({
    chunkStore: index,
    now: () => indexedAt
  });
  const filter = {
    namespaceId: input.profile.namespaceId,
    tenantId: input.requestedBy.tenantId,
    principal: input.requestedBy,
    limit: 1000
  };
  const checks = [];

  for (const check of retrievalChecks(input.documents)) {
    const result = await retriever.retrieve({
      query: check.query,
      topK: 10,
      mode: "keyword",
      filter,
      candidatePoolLimit: 5000,
      requestedAt: indexedAt,
      retrievalId: `parser_extraction_audit_${slug(check.id)}`
    });
    const matched = result.candidates.find((candidate) => {
      const relativePath =
        candidate.chunk.provenance.path ?? candidate.chunk.metadata?.relativePath ?? "";
      return check.expectedPaths.includes(String(relativePath));
    });
    checks.push({
      id: check.id,
      query: check.query,
      expectedPaths: check.expectedPaths,
      status: matched ? "passed" : "failed",
      topPaths: result.candidates.map((candidate) => ({
        path:
          candidate.chunk.provenance.path ?? candidate.chunk.metadata?.relativePath ?? "unknown",
        score: candidate.score,
        unitType: candidate.chunk.metadata?.searchableUnitType ?? "body_chunk",
        matchedTerms: candidate.matchedTerms
      }))
    });
  }

  const failed = checks.filter((check) => check.status !== "passed").length;
  return {
    status: failed === 0 ? "passed" : "failed",
    summary: {
      status: failed === 0 ? "passed" : "failed",
      indexedDocumentCount: input.documents.length,
      indexedChunkCount: chunkCount,
      derivedChunkCount,
      warningCount: warnings.length,
      checkCount: checks.length,
      failed
    },
    indexedDocuments,
    checks,
    warnings
  };
}

function retrievalChecks(documents) {
  const availablePaths = new Set(documents.map((document) => documentPath(document)));
  const fixedChecks = fixedRetrievalChecks().filter((check) =>
    check.expectedPaths.some((expectedPath) => availablePaths.has(expectedPath))
  );
  const fixedPaths = new Set(fixedChecks.flatMap((check) => check.expectedPaths));
  return [...fixedChecks, ...documentRetrievalChecks(documents, fixedPaths)];
}

function fixedRetrievalChecks() {
  return [
    {
      id: "chart_legend_searchable",
      query: "Alphabet Inc Class A NASDAQ Composite",
      expectedPaths: ["chart-page.jpg"]
    },
    {
      id: "diagram_labels_searchable",
      query: "Parse Chunk Index diagram",
      expectedPaths: ["diagram-notes.jpg"]
    },
    {
      id: "pdf_table_searchable",
      query: "Metric Revenue 125 Cost 75",
      expectedPaths: ["text-table-report.pdf"]
    },
    {
      id: "excel_formula_sheet_searchable",
      query: "HiddenAssumptions Discount Rate formula",
      expectedPaths: ["formulas_merged_hidden.xlsx"]
    },
    {
      id: "visual_table_searchable",
      query: "Metric Q1 Q2 Revenue Cost Margin",
      expectedPaths: ["large-chart-table.png", "large-table.png"]
    },
    {
      id: "multi_sheet_excel_searchable",
      query: "KPI Tickets Revenue Finance Owners",
      expectedPaths: ["multi-sheet-kpis.xlsx"]
    }
  ];
}

function documentRetrievalChecks(documents, skippedPaths) {
  const checks = [];

  for (const document of documents) {
    const pathForDocument = documentPath(document);
    if (!pathForDocument || skippedPaths.has(pathForDocument)) {
      continue;
    }
    const query = searchQueryForDocument(document);
    if (!query) {
      continue;
    }
    checks.push({
      id: `document_${slug(pathForDocument)}`,
      query,
      expectedPaths: [pathForDocument]
    });
    if (checks.length >= 12) {
      break;
    }
  }

  return checks;
}

function searchQueryForDocument(document) {
  const tokens = uniqueSearchTokens(searchTextForDocument(document));
  if (tokens.length < 2) {
    return undefined;
  }
  return tokens.slice(0, 6).join(" ");
}

function searchTextForDocument(document) {
  const parts = [document.body ?? ""];
  for (const table of document.layout?.tables ?? []) {
    for (const cell of table.cells ?? []) {
      if (typeof cell.text === "string") {
        parts.push(cell.text);
      }
    }
  }
  for (const region of document.layout?.regions ?? []) {
    if (typeof region.text === "string") {
      parts.push(region.text);
    }
  }
  return parts.join("\n");
}

function uniqueSearchTokens(text) {
  const stopWords = new Set([
    "about",
    "after",
    "also",
    "and",
    "are",
    "because",
    "been",
    "before",
    "being",
    "between",
    "both",
    "but",
    "can",
    "could",
    "does",
    "each",
    "for",
    "from",
    "had",
    "has",
    "have",
    "into",
    "its",
    "more",
    "not",
    "our",
    "shall",
    "should",
    "that",
    "the",
    "their",
    "there",
    "these",
    "this",
    "through",
    "under",
    "use",
    "was",
    "were",
    "when",
    "where",
    "which",
    "with",
    "would",
    "you",
    "your"
  ]);
  const seen = new Set();
  const tokens = [];

  for (const match of String(text).matchAll(/[a-z0-9][a-z0-9_-]{2,}/giu)) {
    const token = match[0].toLowerCase();
    if (stopWords.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= 24) {
      break;
    }
  }

  return tokens;
}

function documentPath(document) {
  return String(document.provenance?.path ?? document.metadata?.relativePath ?? document.id ?? "");
}

function renderMarkdown(report) {
  const lines = [
    "# Parser Extraction Audit",
    "",
    `- Status: ${report.status}`,
    `- Sources: \`${report.sourcesPath}\``,
    `- Accepted documents: ${report.acceptedDocumentCount}`,
    `- Extraction audit: ${report.extractionAudit.status}`,
    `- Extraction checks: ${report.extractionAudit.summary.checkCount}`,
    `- Extraction failures: ${report.extractionAudit.summary.failed}`,
    `- Searchability smoke: ${report.searchability.status}`,
    `- Search checks: ${report.searchability.checkCount}`,
    `- Search failures: ${report.searchability.failed}`,
    `- Indexed chunks: ${report.searchability.indexedChunkCount}`,
    `- Derived searchable chunks: ${report.searchability.derivedChunkCount}`,
    `- Searchability warnings: ${report.searchability.warningCount}`,
    ""
  ];

  return lines.join("\n");
}

function parseArgs(args) {
  const parsed = {
    sourcesPath: DEFAULT_SOURCES_PATH,
    reportDir: DEFAULT_REPORT_DIR,
    runId: "parser_extraction_audit",
    sourceId: "curated_docs",
    tenantId: "tenant_1",
    userId: "parser_extraction_audit",
    roles: ["admin"],
    tags: ["mixed-parser-smoke"]
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--sources") {
      parsed.sourcesPath = requiredValue(arg, value);
      index += 1;
    } else if (arg === "--report-dir") {
      parsed.reportDir = requiredValue(arg, value);
      index += 1;
    } else if (arg === "--run-id") {
      parsed.runId = requiredValue(arg, value);
      index += 1;
    } else if (arg === "--source-id") {
      parsed.sourceId = requiredValue(arg, value);
      index += 1;
    } else if (arg === "--python") {
      parsed.pythonPath = requiredValue(arg, value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function requiredValue(flag, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function slug(value) {
  return value.replace(/[^a-z0-9]+/giu, "_").replace(/^_+|_+$/gu, "");
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}
