#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  analyzeParserQualityForDocuments,
  assertValidProfile,
  createBestCombinedLocalParserRouter,
  genericDocsProfile,
  LocalFilesCorpusAdapter
} from "../dist/index.js";
import { normalizeCorpusRecords } from "../dist/corpus/normalize.js";

const DEFAULT_REPORT_DIR = path.join(".rag", "parser-quality", "latest");
const FIXED_REQUESTED_AT = "2026-06-25T00:00:00.000Z";

const options = parseArgs(process.argv.slice(2));
const sourcesPath = options.sourcesPath ?? process.env.RAG_LOCAL_FILES_SOURCES_PATH;

if (!sourcesPath) {
  throw new Error("--sources or RAG_LOCAL_FILES_SOURCES_PATH is required.");
}

const profile = assertValidProfile(genericDocsProfile);
const reportDir = options.reportDir ?? DEFAULT_REPORT_DIR;
const localSources = await readLocalFilesSources(sourcesPath);
const adapter = new LocalFilesCorpusAdapter({
  sources: localSources,
  parsers: [createBestCombinedLocalParserRouter({ parserId: "best-local-parser" })]
});
const source = profile.corpusSources.find((candidate) => candidate.id === options.sourceId);

if (!source) {
  throw new Error(`Unknown profile source id "${options.sourceId}".`);
}

const loaded = await adapter.load({
  profile,
  source,
  requestedBy: {
    userId: options.userId,
    tenantId: options.tenantId,
    namespaceIds: [profile.namespaceId],
    roles: options.roles,
    tags: options.tags
  },
  runId: options.runId,
  requestedAt: FIXED_REQUESTED_AT
});
const normalized = normalizeCorpusRecords(loaded.records, {
  profile,
  source,
  requestedBy: {
    userId: options.userId,
    tenantId: options.tenantId,
    namespaceIds: [profile.namespaceId],
    roles: options.roles,
    tags: options.tags
  },
  ingestedAt: FIXED_REQUESTED_AT
});
const parserQuality = analyzeParserQualityForDocuments(normalized.documents);
const fileTypeSummary = summarizeByFileType(normalized.documents);
const report = {
  status: "completed",
  generatedAt: new Date().toISOString(),
  sourcesPath,
  sourceId: source.id,
  loadedRecordCount: loaded.records.filter(Boolean).length,
  acceptedDocumentCount: normalized.documents.length,
  rejectedRecordCount: normalized.rejectedRecords.length,
  adapterWarningCount: loaded.warnings.length,
  normalizationIssueCount: normalized.issues.length,
  parserQuality: parserQuality.summary,
  parserQualityWarnings: parserQuality.warnings,
  fileTypes: fileTypeSummary,
  adapterWarnings: loaded.warnings,
  normalizationIssues: normalized.issues,
  rejectedRecords: normalized.rejectedRecords
};

await mkdir(reportDir, { recursive: true });
await writeFile(path.join(reportDir, "parser-quality.json"), JSON.stringify(report, null, 2));
await writeFile(path.join(reportDir, "parser-quality.md"), renderMarkdown(report));

console.log(JSON.stringify(report, null, 2));

async function readLocalFilesSources(configPath) {
  const resolvedPath = path.resolve(configPath);
  const parsed = JSON.parse(await readFile(resolvedPath, "utf8"));
  const sources = Array.isArray(parsed) ? parsed : parsed.sources;
  if (!Array.isArray(sources)) {
    throw new Error(`${configPath} must be an array or an object with sources[].`);
  }

  const baseDirectory = path.dirname(resolvedPath);
  return sources.map((source) => ({
    ...source,
    rootDir: path.isAbsolute(source.rootDir)
      ? source.rootDir
      : path.resolve(baseDirectory, source.rootDir)
  }));
}

function summarizeByFileType(documents) {
  const grouped = new Map();

  for (const document of documents) {
    const metadata = document.metadata ?? {};
    const extension = typeof metadata.extension === "string" ? metadata.extension : "unknown";
    const contentType = typeof metadata.contentType === "string" ? metadata.contentType : "unknown";
    const key = `${extension}|${contentType}`;
    const existing = grouped.get(key) ?? {
      extension,
      contentType,
      documentCount: 0,
      tracedDocumentCount: 0,
      averageSelectedScore: undefined,
      selectedScoreTotal: 0,
      lowScoreDocumentCount: 0,
      fallbackSelectedCount: 0,
      failedAttemptCount: 0,
      rejectedAttemptCount: 0,
      selectedParsers: {}
    };

    existing.documentCount += 1;
    if (typeof metadata.parserRouterTraceJson === "string") {
      existing.tracedDocumentCount += 1;
    }
    if (typeof metadata.parserRouterSelectedScore === "number") {
      existing.selectedScoreTotal += metadata.parserRouterSelectedScore;
      if (metadata.parserRouterSelectedScore < 80) {
        existing.lowScoreDocumentCount += 1;
      }
    }
    if (metadata.parserRouterSelectedTier === "fallback") {
      existing.fallbackSelectedCount += 1;
    }
    if (typeof metadata.parserRouterFailedAttemptCount === "number") {
      existing.failedAttemptCount += metadata.parserRouterFailedAttemptCount;
    }
    if (typeof metadata.parserRouterRejectedAttemptCount === "number") {
      existing.rejectedAttemptCount += metadata.parserRouterRejectedAttemptCount;
    }
    if (typeof metadata.parserRouterSelectedParserId === "string") {
      existing.selectedParsers[metadata.parserRouterSelectedParserId] =
        (existing.selectedParsers[metadata.parserRouterSelectedParserId] ?? 0) + 1;
    }

    grouped.set(key, existing);
  }

  return [...grouped.values()]
    .map(({ selectedScoreTotal, ...summary }) => ({
      ...summary,
      ...(summary.tracedDocumentCount === 0
        ? {}
        : {
            averageSelectedScore: Math.round(selectedScoreTotal / summary.tracedDocumentCount)
          })
    }))
    .sort(
      (first, second) =>
        first.extension.localeCompare(second.extension) ||
        first.contentType.localeCompare(second.contentType)
    );
}

function renderMarkdown(report) {
  const lines = [
    "# Parser Quality Report",
    "",
    `- Status: ${report.status}`,
    `- Sources: \`${report.sourcesPath}\``,
    `- Accepted documents: ${report.acceptedDocumentCount}`,
    `- Rejected records: ${report.rejectedRecordCount}`,
    `- Parser-quality warnings: ${report.parserQuality.warningCount}`,
    `- Readiness: ${report.parserQuality.readiness.status}`,
    `- Readiness message: ${report.parserQuality.readiness.message}`,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Traced documents | ${report.parserQuality.tracedDocumentCount} |`,
    `| Average selected score | ${report.parserQuality.averageSelectedScore ?? "n/a"} |`,
    `| Low-score documents | ${report.parserQuality.lowScoreDocumentCount} |`,
    `| Fallback selected | ${report.parserQuality.fallbackSelectedCount} |`,
    `| Failed attempts | ${report.parserQuality.failedAttemptCount} |`,
    `| Rejected attempts | ${report.parserQuality.rejectedAttemptCount} |`,
    `| Skipped candidates | ${report.parserQuality.skippedCandidateCount} |`,
    "",
    "## By File Type",
    "",
    "| Extension | Content type | Docs | Traced | Avg score | Low score | Fallback | Failed attempts | Rejected attempts | Selected parsers |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...report.fileTypes.map(
      (type) =>
        `| ${type.extension} | ${type.contentType} | ${type.documentCount} | ${type.tracedDocumentCount} | ${type.averageSelectedScore ?? "n/a"} | ${type.lowScoreDocumentCount} | ${type.fallbackSelectedCount} | ${type.failedAttemptCount} | ${type.rejectedAttemptCount} | ${selectedParserSummary(type.selectedParsers)} |`
    ),
    ""
  ];

  if (report.parserQualityWarnings.length > 0) {
    lines.push("## Warnings", "");
    for (const warning of report.parserQualityWarnings) {
      lines.push(`- ${warning.code}: ${warning.documentId} - ${warning.message}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function selectedParserSummary(selectedParsers) {
  const entries = Object.entries(selectedParsers);
  return entries.length === 0
    ? "n/a"
    : entries.map(([parserId, count]) => `${parserId} (${count})`).join(", ");
}

function parseArgs(args) {
  const parsed = {
    reportDir: DEFAULT_REPORT_DIR,
    runId: "parser_quality_report",
    sourceId: "curated_docs",
    tenantId: "tenant_1",
    userId: "parser_quality_report",
    roles: ["admin"],
    tags: ["sec-test-corpus"]
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
