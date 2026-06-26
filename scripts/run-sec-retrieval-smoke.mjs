#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { JsonFileRagIndex, KeywordRetriever } from "../dist/index.js";

const DEFAULT_INDEX_PATH = path.join(".rag", "sec-company-corpus", "smoke-index.json");
const DEFAULT_SEED_PATH = path.join(".rag", "sec-company-corpus", "ground-truth.seed.json");
const DEFAULT_REPORT_PATH = path.join(".rag", "sec-company-corpus", "retrieval-smoke.json");
const DEFAULT_MARKDOWN_PATH = path.join(".rag", "sec-company-corpus", "retrieval-smoke.md");

const options = parseArgs(process.argv.slice(2));

try {
  const index = new JsonFileRagIndex({
    filePath: options.indexPath,
    autosave: false
  });
  const retriever = new KeywordRetriever({ chunkStore: index });
  const seedQuestions = JSON.parse(await readFile(options.seedPath, "utf8"));
  const snapshot = index.snapshot();
  const indexedPaths = new Set(
    snapshot.documents.map((entry) => entry.document.provenance.path).filter(Boolean)
  );
  const filter = {
    namespaceId: options.namespaceId,
    tenantId: options.tenantId,
    principal: adminPrincipal(options),
    limit: options.candidatePoolLimit
  };

  const queryResults = [];
  for (const question of seedQuestions) {
    const expectedSources = Array.isArray(question.expectedSources) ? question.expectedSources : [];
    const indexedExpectedSources = expectedSources.filter((source) => indexedPaths.has(source));

    if (expectedSources.length > 0 && indexedExpectedSources.length === 0) {
      queryResults.push({
        id: question.id,
        question: question.question,
        status: "skipped_expected_source_not_indexed",
        expectedSources,
        indexedExpectedSources: [],
        top: []
      });
      continue;
    }

    if (expectedSources.length === 0) {
      queryResults.push({
        id: question.id,
        question: question.question,
        status: "skipped_no_expected_source",
        expectedSources,
        indexedExpectedSources,
        top: []
      });
      continue;
    }

    const result = await retriever.retrieve({
      query: question.question,
      filter,
      topK: options.topK,
      candidatePoolLimit: options.candidatePoolLimit,
      mode: "keyword"
    });
    const top = result.candidates.map((candidate) => summarizeCandidate(candidate));
    const expectedHit = top.find((candidate) => indexedExpectedSources.includes(candidate.path));

    queryResults.push({
      id: question.id,
      question: question.question,
      status: expectedHit ? "passed" : "failed_expected_source_not_retrieved",
      expectedSources,
      indexedExpectedSources,
      expectedSourceRank: expectedHit?.rank,
      candidateCount: result.candidates.length,
      top
    });
  }

  const denied = await retriever.retrieve({
    query: "What subsidiaries does Berkshire list?",
    filter: {
      namespaceId: options.namespaceId,
      tenantId: options.tenantId,
      principal: deniedPrincipal(options),
      limit: options.candidatePoolLimit
    },
    topK: options.topK,
    candidatePoolLimit: options.candidatePoolLimit,
    mode: "keyword"
  });

  const accessDeniedCheck = {
    id: "acl-denied-berkshire",
    status: denied.candidates.length === 0 ? "passed" : "failed_returned_denied_chunks",
    returnedCount: denied.candidates.length,
    top: denied.candidates.map((candidate) => summarizeCandidate(candidate))
  };

  const report = {
    generatedAt: new Date().toISOString(),
    indexPath: options.indexPath,
    seedPath: options.seedPath,
    indexStats: index.stats(),
    indexedSourcePaths: [...indexedPaths].sort(),
    summary: summarize(queryResults, accessDeniedCheck),
    results: queryResults,
    accessDeniedCheck
  };

  await mkdir(path.dirname(options.reportPath), { recursive: true });
  await writeJson(options.reportPath, report);
  await writeFile(options.markdownPath, renderMarkdown(report), "utf8");
  console.log(JSON.stringify(report.summary, null, 2));

  if (report.summary.failed > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify(
      {
        status: "failed",
        message: error instanceof Error ? error.message : "SEC retrieval smoke failed."
      },
      null,
      2
    )
  );
  process.exitCode = 1;
}

function summarizeCandidate(candidate) {
  return {
    rank: candidate.rank,
    score: round(candidate.score),
    path: candidate.chunk.provenance.path,
    title: candidate.chunk.provenance.title,
    locator: candidate.citation.locator,
    matchedTerms: candidate.matchedTerms,
    preview: candidate.chunk.text.slice(0, 240).replace(/\s+/g, " ")
  };
}

function summarize(results, accessDeniedCheck) {
  const counts = results.reduce(
    (total, result) => {
      total[result.status] = (total[result.status] ?? 0) + 1;
      return total;
    },
    {
      passed: 0,
      failed_expected_source_not_retrieved: 0,
      skipped_expected_source_not_indexed: 0,
      skipped_no_expected_source: 0
    }
  );
  const failed =
    counts.failed_expected_source_not_retrieved + (accessDeniedCheck.status === "passed" ? 0 : 1);

  return {
    status: failed === 0 ? "passed" : "failed",
    passed: counts.passed + (accessDeniedCheck.status === "passed" ? 1 : 0),
    failed,
    skipped: counts.skipped_expected_source_not_indexed + counts.skipped_no_expected_source,
    retrievalChecks: results.length,
    accessDeniedStatus: accessDeniedCheck.status
  };
}

function renderMarkdown(report) {
  const lines = [
    "# SEC Retrieval Smoke",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Summary",
    "",
    `- Status: ${report.summary.status}`,
    `- Passed: ${report.summary.passed}`,
    `- Failed: ${report.summary.failed}`,
    `- Skipped: ${report.summary.skipped}`,
    `- Documents: ${report.indexStats.documentCount}`,
    `- Chunks: ${report.indexStats.chunkCount}`,
    "",
    "## Retrieval Checks",
    "",
    "| Check | Status | Expected source rank | Top path |",
    "| --- | --- | ---: | --- |",
    ...report.results.map((result) => {
      const topPath = result.top[0]?.path ?? "";
      return `| ${result.id} | ${result.status} | ${result.expectedSourceRank ?? ""} | ${topPath} |`;
    }),
    "",
    "## Access Check",
    "",
    `- ${report.accessDeniedCheck.id}: ${report.accessDeniedCheck.status}`,
    `- Returned chunks: ${report.accessDeniedCheck.returnedCount}`,
    ""
  ];

  return `${lines.join("\n")}\n`;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function adminPrincipal(options) {
  return {
    userId: options.userId,
    tenantId: options.tenantId,
    namespaceIds: [options.namespaceId],
    teamIds: [],
    roles: ["admin"],
    tags: ["sec-test-corpus"]
  };
}

function deniedPrincipal(options) {
  return {
    userId: "denied_user",
    tenantId: options.tenantId,
    namespaceIds: [options.namespaceId],
    teamIds: [],
    roles: ["viewer"],
    tags: []
  };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function parseArgs(args) {
  const parsed = {
    indexPath: DEFAULT_INDEX_PATH,
    seedPath: DEFAULT_SEED_PATH,
    reportPath: DEFAULT_REPORT_PATH,
    markdownPath: DEFAULT_MARKDOWN_PATH,
    namespaceId: "generic-docs",
    tenantId: "tenant_1",
    userId: "user_1",
    topK: 5,
    candidatePoolLimit: 1000
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--index-path":
        parsed.indexPath = requiredValue(args, ++index, arg);
        break;
      case "--seed-path":
        parsed.seedPath = requiredValue(args, ++index, arg);
        break;
      case "--report-path":
        parsed.reportPath = requiredValue(args, ++index, arg);
        break;
      case "--markdown-path":
        parsed.markdownPath = requiredValue(args, ++index, arg);
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
        parsed.topK = Number.parseInt(requiredValue(args, ++index, arg), 10);
        break;
      case "--candidate-pool-limit":
        parsed.candidatePoolLimit = Number.parseInt(requiredValue(args, ++index, arg), 10);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(parsed.topK) || parsed.topK < 1) {
    throw new Error("--top-k must be a positive integer.");
  }
  if (!Number.isInteger(parsed.candidatePoolLimit) || parsed.candidatePoolLimit < parsed.topK) {
    throw new Error("--candidate-pool-limit must be an integer greater than or equal to top-k.");
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
