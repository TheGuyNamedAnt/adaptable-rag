#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertValidProfile,
  chunkDocument,
  createBestCombinedLocalParserRouter,
  FakeVisualEmbeddingAdapter,
  genericDocsProfile,
  InMemoryRagIndex,
  InMemoryVisualVectorStore,
  LocalFilesCorpusAdapter,
  VisualEmbeddingIndexer,
  VisualRetriever
} from "../dist/index.js";
import { normalizeCorpusRecords } from "../dist/corpus/normalize.js";

const DEFAULT_SOURCES_PATH = path.join(".rag", "excel-parser-corpus", "local-files.sources.json");
const DEFAULT_REPORT_DIR = path.join(".rag", "excel-parser-corpus", "visual-retrieval-smoke");
const FIXED_REQUESTED_AT = "2026-06-25T00:00:00.000Z";
const TARGET_PATH = "formulas_merged_hidden.xlsx";
const EXPECTED_CHART_ASSET_ID = "sheet_1_chart_1";
const EXPECTED_IMAGE_ASSET_ID = "sheet_1_image_1";
const EXPECTED_CHART_TITLE = "Revenue by Quarter";
const EXPECTED_CHART_SHEET = "Model";
const EXPECTED_CHART_ANCHOR = "R2C5";

const options = parseArgs(process.argv.slice(2));

try {
  const profile = assertValidProfile(genericDocsProfile);
  const source = profile.corpusSources.find((candidate) => candidate.id === options.sourceId);
  if (!source) {
    throw new Error(`Unknown profile source id "${options.sourceId}".`);
  }

  const principal = adminPrincipal(profile, options);
  const adapter = new LocalFilesCorpusAdapter({
    sources: await readLocalFilesSources(options.sourcesPath),
    parsers: [createBestCombinedLocalParserRouter({ parserId: "best-local-parser" })]
  });
  const loaded = await adapter.load({
    profile,
    source,
    requestedBy: principal,
    runId: "excel_visual_retrieval_smoke",
    requestedAt: FIXED_REQUESTED_AT
  });
  const normalized = normalizeCorpusRecords(loaded.records, {
    profile,
    source,
    requestedBy: principal,
    ingestedAt: FIXED_REQUESTED_AT
  });
  const targetDocument = normalized.documents.find(
    (document) => document.provenance.path === TARGET_PATH
  );
  const visualDocuments = normalized.documents.filter(
    (document) => (document.layout?.visualAssets?.length ?? 0) > 0
  );
  const indexed = indexDocuments(visualDocuments);
  const targetChunks = indexed.chunks.filter((chunk) => chunk.documentId === targetDocument?.id);
  const visualDocumentIds = new Set(visualDocuments.map((document) => document.id));
  const visualChunks = indexed.chunks.filter((chunk) => visualDocumentIds.has(chunk.documentId));
  const visualAdapter = new FakeVisualEmbeddingAdapter({ dimensions: options.dimensions });
  const visualVectorStore = new InMemoryVisualVectorStore({
    chunkStore: indexed.index,
    dimensions: visualAdapter.dimensions,
    now: () => FIXED_REQUESTED_AT
  });
  const visualIndex = await new VisualEmbeddingIndexer({
    adapter: visualAdapter,
    visualVectorStore,
    now: () => FIXED_REQUESTED_AT
  }).indexChunks({
    documents: visualDocuments,
    chunks: visualChunks,
    requestedAt: FIXED_REQUESTED_AT,
    overwriteMode: "replace"
  });
  const retriever = new VisualRetriever({
    embeddingAdapter: visualAdapter,
    vectorStore: visualVectorStore,
    now: () => FIXED_REQUESTED_AT
  });
  const filter = {
    namespaceId: options.namespaceId,
    tenantId: options.tenantId,
    principal,
    limit: options.candidatePoolLimit
  };

  const chartVectorSearch = await searchVisualVectors({
    query: "Revenue by Quarter chart BarChart",
    adapter: visualAdapter,
    visualVectorStore,
    filter,
    topK: options.topK,
    candidatePoolLimit: options.candidatePoolLimit
  });
  const imageVectorSearch = await searchVisualVectors({
    query: "R18C5 embedded image png",
    adapter: visualAdapter,
    visualVectorStore,
    filter,
    topK: options.topK,
    candidatePoolLimit: options.candidatePoolLimit
  });
  const visualRetrieval = await retriever.retrieve({
    query: "What does the Revenue by Quarter spreadsheet chart show?",
    filter,
    topK: options.topK,
    candidatePoolLimit: options.candidatePoolLimit,
    mode: "visual",
    requestedAt: FIXED_REQUESTED_AT
  });
  const deniedRetrieval = await retriever.retrieve({
    query: "Revenue by Quarter chart",
    filter: {
      namespaceId: options.namespaceId,
      tenantId: options.tenantId,
      principal: deniedPrincipal(profile, options),
      limit: options.candidatePoolLimit
    },
    topK: options.topK,
    candidatePoolLimit: options.candidatePoolLimit,
    mode: "visual",
    includeRejected: true,
    requestedAt: FIXED_REQUESTED_AT
  });

  const targetAssets = targetDocument?.layout?.visualAssets ?? [];
  const checks = [
    check(
      "target_document_accepted",
      targetDocument !== undefined,
      "Target spreadsheet document was accepted.",
      `Expected accepted document ${TARGET_PATH}.`
    ),
    check(
      "target_document_chunked",
      targetChunks.length > 0,
      "Target spreadsheet produced chunks.",
      `Expected chunks for ${TARGET_PATH}.`
    ),
    check(
      "materialized_chart_asset",
      hasMaterializedVisualAsset(targetAssets, EXPECTED_CHART_ASSET_ID),
      "Materialized chart asset exists.",
      `Expected existing file URI for ${EXPECTED_CHART_ASSET_ID}.`
    ),
    check(
      "materialized_image_asset",
      hasMaterializedVisualAsset(targetAssets, EXPECTED_IMAGE_ASSET_ID),
      "Materialized embedded image asset exists.",
      `Expected existing file URI for ${EXPECTED_IMAGE_ASSET_ID}.`
    ),
    check(
      "visual_index_candidate_assets",
      visualIndex.candidateVisualAssetCount >= 2,
      "Visual index saw at least two candidate spreadsheet assets.",
      `Expected at least 2 candidate visual assets, got ${visualIndex.candidateVisualAssetCount}.`
    ),
    check(
      "visual_index_written",
      visualIndex.indexedVisualVectorCount >= 2,
      "Visual index wrote at least two spreadsheet visual vectors.",
      `Expected at least 2 visual vectors, got ${visualIndex.indexedVisualVectorCount}.`
    ),
    check(
      "chart_asset_retrieved",
      chartVectorSearch.candidates[0]?.visualVector.visualAssetId === EXPECTED_CHART_ASSET_ID,
      "Chart-specific visual vector search retrieves the chart asset first.",
      `Expected top visual asset ${EXPECTED_CHART_ASSET_ID}, got ${String(
        chartVectorSearch.candidates[0]?.visualVector.visualAssetId
      )}.`
    ),
    check(
      "image_asset_retrieved",
      imageVectorSearch.candidates[0]?.visualVector.visualAssetId === EXPECTED_IMAGE_ASSET_ID,
      "Image-specific visual vector search retrieves the embedded image asset first.",
      `Expected top visual asset ${EXPECTED_IMAGE_ASSET_ID}, got ${String(
        imageVectorSearch.candidates[0]?.visualVector.visualAssetId
      )}.`
    ),
    check(
      "visual_retrieval_returns_target",
      visualRetrieval.candidates[0]?.chunk.provenance.path === TARGET_PATH,
      "VisualRetriever returns the target spreadsheet as the top result.",
      `Expected top retrieved path ${TARGET_PATH}, got ${String(
        visualRetrieval.candidates[0]?.chunk.provenance.path
      )}.`
    ),
    check(
      "visual_retrieval_cites_chart_asset",
      visualRetrieval.candidates[0]?.citation.visualAssetId === EXPECTED_CHART_ASSET_ID,
      "VisualRetriever citation points at the exact chart visual asset.",
      `Expected citation visualAssetId ${EXPECTED_CHART_ASSET_ID}, got ${String(
        visualRetrieval.candidates[0]?.citation.visualAssetId
      )}.`
    ),
    check(
      "visual_retrieval_cites_chart_metadata",
      visualRetrieval.candidates[0]?.citation.visualAsset?.title === EXPECTED_CHART_TITLE &&
        visualRetrieval.candidates[0]?.citation.visualAsset?.sheetName === EXPECTED_CHART_SHEET &&
        visualRetrieval.candidates[0]?.citation.visualAsset?.anchorCell === EXPECTED_CHART_ANCHOR,
      "VisualRetriever citation includes sanitized chart title, sheet, and anchor metadata.",
      `Expected citation metadata ${EXPECTED_CHART_TITLE}/${EXPECTED_CHART_SHEET}/${EXPECTED_CHART_ANCHOR}, got ${JSON.stringify(
        visualRetrieval.candidates[0]?.citation.visualAsset ?? null
      )}.`
    ),
    check(
      "visual_retrieval_has_layout_citation",
      (visualRetrieval.candidates[0]?.citation.layoutRegionIds?.length ?? 0) > 0 &&
        visualRetrieval.candidates[0]?.citation.pageNumber === 1,
      "VisualRetriever citation keeps page and layout-region evidence.",
      "Expected page 1 plus layoutRegionIds on the top visual retrieval citation."
    ),
    check(
      "visual_acl_denial",
      deniedRetrieval.candidates.length === 0,
      "Denied principal receives no visual retrieval candidates.",
      `Expected denied retrieval to return 0 candidates, got ${deniedRetrieval.candidates.length}.`
    )
  ];

  const report = {
    generatedAt: new Date().toISOString(),
    sourcesPath: options.sourcesPath,
    sourceId: options.sourceId,
    targetPath: TARGET_PATH,
    loadedRecordCount: loaded.records.length,
    acceptedDocumentCount: normalized.documents.length,
    rejectedRecordCount: normalized.rejectedRecords.length,
    adapterWarningCount: loaded.warnings.length,
    normalizationIssueCount: normalized.issues.length,
    chunkCount: indexed.chunks.length,
    targetChunkCount: targetChunks.length,
    targetVisualAssetCount: targetAssets.length,
    visualIndex,
    visualVectorCount: await visualVectorStore.visualVectorCount(),
    summary: summarize(checks),
    checks,
    chartVectorSearch: summarizeVisualVectorSearch(chartVectorSearch),
    imageVectorSearch: summarizeVisualVectorSearch(imageVectorSearch),
    visualRetrieval: summarizeVisualRetrieval(visualRetrieval),
    deniedRetrieval: {
      returnedCount: deniedRetrieval.candidates.length,
      rejectedCount: deniedRetrieval.rejected.length,
      rejectionCodes: deniedRetrieval.rejected.map((rejection) => rejection.code)
    },
    adapterWarnings: loaded.warnings,
    normalizationIssues: normalized.issues,
    rejectedRecords: normalized.rejectedRecords
  };

  await mkdir(options.reportDir, { recursive: true });
  await writeJson(path.join(options.reportDir, "visual-retrieval-smoke.json"), report);
  await writeFile(
    path.join(options.reportDir, "visual-retrieval-smoke.md"),
    renderMarkdown(report),
    "utf8"
  );
  console.log(JSON.stringify(report.summary, null, 2));

  if (report.summary.failed > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify(
      {
        status: "failed",
        message: error instanceof Error ? error.message : "Excel visual retrieval smoke failed."
      },
      null,
      2
    )
  );
  process.exitCode = 1;
}

function indexDocuments(documents) {
  const index = new InMemoryRagIndex({ now: () => FIXED_REQUESTED_AT });
  const chunks = [];

  for (const document of documents) {
    const documentChunks = chunkDocument({ document }).chunks;
    index.addDocument(document, {
      overwriteMode: "replace",
      indexedAt: FIXED_REQUESTED_AT
    });
    index.addChunks(document.id, documentChunks, {
      overwriteMode: "replace",
      indexedAt: FIXED_REQUESTED_AT
    });
    chunks.push(...documentChunks);
  }

  return { index, chunks };
}

async function searchVisualVectors({
  query,
  adapter,
  visualVectorStore,
  filter,
  topK,
  candidatePoolLimit
}) {
  const embedding = await adapter.embedQuery({
    query,
    requestedAt: FIXED_REQUESTED_AT
  });
  if (embedding.status === "failed" || embedding.vectors.length === 0) {
    throw new Error(embedding.errorMessage ?? `Visual query embedding failed for "${query}".`);
  }

  return await visualVectorStore.findNearestVisualVectors({
    vectors: embedding.vectors,
    filter,
    topK,
    candidatePoolLimit,
    includeRejected: true
  });
}

function summarizeVisualVectorSearch(result) {
  return {
    candidatePoolSize: result.candidatePoolSize,
    returnedCount: result.candidates.length,
    rejectedCount: result.rejected.length,
    top: result.candidates.map((candidate) => ({
      rank: candidate.rank,
      score: round(candidate.score),
      path: candidate.chunk.provenance.path,
      locator: candidate.chunk.citation.locator,
      visualAssetId: candidate.visualVector.visualAssetId,
      visualAsset: candidate.visualVector.visualAsset,
      pageNumber: candidate.visualVector.pageNumber,
      layoutRegionIds: candidate.visualVector.layoutRegionIds ?? [],
      preview: preview(candidate.chunk.text)
    }))
  };
}

function summarizeVisualRetrieval(result) {
  return {
    returnedCount: result.candidates.length,
    rejectedCount: result.rejected.length,
    trace: result.trace,
    top: result.candidates.map((candidate) => ({
      rank: candidate.rank,
      score: round(candidate.score),
      path: candidate.chunk.provenance.path,
      locator: candidate.citation.locator,
      visualAssetId: candidate.citation.visualAssetId,
      visualAsset: candidate.citation.visualAsset,
      pageNumber: candidate.citation.pageNumber,
      layoutRegionIds: candidate.citation.layoutRegionIds ?? [],
      preview: preview(candidate.chunk.text)
    }))
  };
}

function hasMaterializedVisualAsset(assets, assetId) {
  const asset = assets.find((candidate) => candidate.id === assetId);
  if (!asset || typeof asset.uri !== "string" || !asset.uri.startsWith("file://")) {
    return false;
  }

  try {
    return existsSync(fileURLToPath(asset.uri));
  } catch {
    return false;
  }
}

function check(id, condition, passMessage, failMessage) {
  return {
    id,
    status: condition ? "passed" : "failed",
    message: condition ? passMessage : failMessage
  };
}

function summarize(checks) {
  const failed = checks.filter((candidate) => candidate.status === "failed").length;
  return {
    status: failed === 0 ? "passed" : "failed",
    passed: checks.length - failed,
    failed,
    total: checks.length
  };
}

function renderMarkdown(report) {
  const lines = [
    "# Excel Visual Retrieval Smoke",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Summary",
    "",
    `- Status: ${report.summary.status}`,
    `- Passed: ${report.summary.passed}`,
    `- Failed: ${report.summary.failed}`,
    `- Accepted documents: ${report.acceptedDocumentCount}`,
    `- Chunks: ${report.chunkCount}`,
    `- Target visual assets: ${report.targetVisualAssetCount}`,
    `- Indexed visual vectors: ${report.visualIndex.indexedVisualVectorCount}`,
    "",
    "## Checks",
    "",
    "| Check | Status | Message |",
    "| --- | --- | --- |",
    ...report.checks.map((checkResult) => {
      return `| ${checkResult.id} | ${checkResult.status} | ${escapeMarkdownCell(
        checkResult.message
      )} |`;
    }),
    "",
    "## Top Results",
    "",
    `- Chart vector top asset: ${report.chartVectorSearch.top[0]?.visualAssetId ?? "none"}`,
    `- Image vector top asset: ${report.imageVectorSearch.top[0]?.visualAssetId ?? "none"}`,
    `- VisualRetriever top path: ${report.visualRetrieval.top[0]?.path ?? "none"}`,
    `- VisualRetriever citation asset: ${report.visualRetrieval.top[0]?.visualAssetId ?? "none"}`,
    `- VisualRetriever citation metadata: ${visualAssetLabel(
      report.visualRetrieval.top[0]?.visualAsset
    )}`,
    `- Denied returned count: ${report.deniedRetrieval.returnedCount}`,
    ""
  ];

  return `${lines.join("\n")}\n`;
}

async function readLocalFilesSources(configPath) {
  const resolvedPath = path.resolve(configPath);
  const parsed = JSON.parse(await readFile(resolvedPath, "utf8"));
  const sources = Array.isArray(parsed) ? parsed : parsed.sources;
  if (!Array.isArray(sources)) {
    throw new Error("Local files source config must be an array or { sources }.");
  }

  const baseDirectory = path.dirname(resolvedPath);
  return sources.map((source) => ({
    ...source,
    rootDir: path.isAbsolute(source.rootDir)
      ? source.rootDir
      : path.resolve(baseDirectory, source.rootDir)
  }));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function adminPrincipal(profile, options) {
  return {
    userId: options.userId,
    tenantId: options.tenantId,
    namespaceIds: [profile.namespaceId],
    teamIds: [],
    roles: ["admin"],
    tags: ["excel-parser-stress"]
  };
}

function deniedPrincipal(profile, options) {
  return {
    userId: "excel_visual_denied",
    tenantId: options.tenantId,
    namespaceIds: [profile.namespaceId],
    teamIds: [],
    roles: ["viewer"],
    tags: []
  };
}

function parseArgs(args) {
  const parsed = {
    sourcesPath: DEFAULT_SOURCES_PATH,
    reportDir: DEFAULT_REPORT_DIR,
    sourceId: "curated_docs",
    namespaceId: "generic-docs",
    tenantId: "tenant_1",
    userId: "excel_visual_smoke",
    topK: 3,
    candidatePoolLimit: 100,
    dimensions: 24
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--sources":
        parsed.sourcesPath = requiredValue(args, ++index, arg);
        break;
      case "--report-dir":
        parsed.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--source-id":
        parsed.sourceId = requiredValue(args, ++index, arg);
        break;
      case "--namespace-id":
        parsed.namespaceId = requiredValue(args, ++index, arg);
        break;
      case "--tenant-id":
        parsed.tenantId = requiredValue(args, ++index, arg);
        break;
      case "--user-id":
        parsed.userId = requiredValue(args, ++index, arg);
        break;
      case "--top-k":
        parsed.topK = positiveInteger(requiredValue(args, ++index, arg), arg);
        break;
      case "--candidate-pool-limit":
        parsed.candidatePoolLimit = positiveInteger(requiredValue(args, ++index, arg), arg);
        break;
      case "--dimensions":
        parsed.dimensions = positiveInteger(requiredValue(args, ++index, arg), arg);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function preview(text) {
  return text.slice(0, 240).replace(/\s+/g, " ");
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function escapeMarkdownCell(value) {
  return String(value).replaceAll("|", "\\|").replace(/\s+/g, " ");
}

function visualAssetLabel(asset) {
  if (!asset) {
    return "none";
  }

  return [asset.title, asset.sheetName, asset.anchorCell].filter(Boolean).join(" / ");
}
