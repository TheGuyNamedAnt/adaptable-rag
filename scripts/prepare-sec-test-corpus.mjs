#!/usr/bin/env node
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_REPORT_DIR = path.join(".rag", "sec-company-corpus");
const SEC_ARCHIVES_BASE = "https://www.sec.gov/Archives/edgar/data";
const DEFAULT_USER_AGENT =
  process.env.SEC_USER_AGENT ??
  "adaptable-rag-test-corpus/0.1 contact=local-testing@example.invalid";

const COMPANIES = [
  {
    id: "berkshire-2024",
    name: "Berkshire Hathaway Inc.",
    cik: "1067983",
    accession: "000095017025025210",
    filedAt: "2025-02-24",
    description: "Large multi-industry holding-company filing with a large Exhibit 21 graph.",
    files: [
      {
        name: "brka-20241231.htm",
        kind: "10-k-html",
        tests: ["long-form text retrieval", "tables", "risk disclosures", "citation grounding"]
      },
      {
        name: "0000950170-25-025210.txt",
        kind: "complete-submission-text",
        tests: ["complete filing fallback", "filing boundary detection"]
      },
      {
        name: "brka-ex21.htm",
        kind: "subsidiary-exhibit",
        tests: ["entity extraction", "ownership graph", "jurisdiction extraction"]
      },
      {
        name: "Financial_Report.xlsx",
        kind: "financial-workbook",
        tests: ["spreadsheet parsing", "table preservation"]
      },
      {
        name: "0000950170-25-025210-xbrl.zip",
        kind: "xbrl-archive",
        tests: ["binary skip behavior", "structured source boundary"]
      },
      {
        name: "FilingSummary.xml",
        kind: "filing-summary-xml",
        tests: ["xml ingestion", "section inventory"]
      },
      {
        name: "MetaLinks.json",
        kind: "metadata-json",
        tests: ["json ingestion", "metadata handling"]
      },
      {
        name: "img69350790_0.jpg",
        kind: "filing-image",
        tests: ["visual asset routing", "image skip/failure behavior"]
      }
    ]
  },
  {
    id: "alphabet-2024",
    name: "Alphabet Inc.",
    cik: "1652044",
    accession: "000165204425000014",
    filedAt: "2025-02-04",
    description: "Cleaner holding-company filing with a small, easy-to-check Exhibit 21 graph.",
    files: [
      {
        name: "goog-20241231.htm",
        kind: "10-k-html",
        tests: ["long-form retrieval", "financial tables", "citation grounding"]
      },
      {
        name: "0001652044-25-000014.txt",
        kind: "complete-submission-text",
        tests: ["complete filing fallback"]
      },
      {
        name: "googexhibit2101q42024.htm",
        kind: "subsidiary-exhibit",
        tests: ["small graph truth set", "jurisdiction extraction"]
      },
      {
        name: "Financial_Report.xlsx",
        kind: "financial-workbook",
        tests: ["spreadsheet parsing", "table preservation"]
      },
      {
        name: "0001652044-25-000014-xbrl.zip",
        kind: "xbrl-archive",
        tests: ["binary skip behavior", "structured source boundary"]
      },
      {
        name: "FilingSummary.xml",
        kind: "filing-summary-xml",
        tests: ["xml ingestion", "section inventory"]
      },
      {
        name: "goog-20241231_g1.jpg",
        kind: "filing-image",
        tests: ["visual asset routing"]
      },
      {
        name: "goog-20241231_g2.jpg",
        kind: "filing-image",
        tests: ["visual asset routing"]
      }
    ]
  },
  {
    id: "microsoft-2025",
    name: "Microsoft Corporation",
    cik: "789019",
    accession: "000095017025100235",
    filedAt: "2025-07-30",
    description: "Technology filing with relationship disclosures and material contract exhibits.",
    files: [
      {
        name: "msft-20250630.htm",
        kind: "10-k-html",
        tests: ["relationship retrieval", "financial tables", "citation grounding"]
      },
      {
        name: "0000950170-25-100235.txt",
        kind: "complete-submission-text",
        tests: ["complete filing fallback"]
      },
      {
        name: "msft-ex21.htm",
        kind: "subsidiary-exhibit",
        tests: ["entity extraction", "ownership graph"]
      },
      {
        name: "msft-ex10_7.htm",
        kind: "material-contract",
        tests: ["contract relation extraction", "party extraction"]
      },
      {
        name: "msft-ex10_8.htm",
        kind: "material-contract",
        tests: ["contract relation extraction", "party extraction"]
      },
      {
        name: "0000950170-25-100235-xbrl.zip",
        kind: "xbrl-archive",
        tests: ["binary skip behavior", "structured source boundary"]
      },
      {
        name: "FilingSummary.xml",
        kind: "filing-summary-xml",
        tests: ["xml ingestion", "section inventory"]
      },
      {
        name: "MetaLinks.json",
        kind: "metadata-json",
        tests: ["json ingestion", "metadata handling"]
      }
    ]
  },
  {
    id: "aflac-2025-pdf",
    name: "Aflac Incorporated",
    cik: "4977",
    accession: "000162828026019627",
    filedAt: "2026-03-19",
    description: "PDF-only 10-K bundle for parser and page citation stress testing.",
    files: [
      {
        name: "afl12312510k.pdf",
        kind: "10-k-pdf",
        tests: ["pdf parsing", "page citations", "table preservation", "visual extraction"]
      },
      {
        name: "0001628280-26-019627.txt",
        kind: "complete-submission-text",
        tests: ["complete filing fallback"]
      }
    ]
  }
];

const SEED_QUESTIONS = [
  {
    id: "alphabet-subsidiaries",
    companyId: "alphabet-2024",
    question: "Which subsidiaries does Alphabet list in Exhibit 21?",
    expectedSources: ["alphabet-2024/googexhibit2101q42024.htm"],
    expectedAnswerContains: ["Google LLC", "XXVI Holdings Inc.", "Alphabet Capital US LLC"],
    capability: "graph_extraction"
  },
  {
    id: "berkshire-nebraska-subsidiaries",
    companyId: "berkshire-2024",
    question: "Which Berkshire subsidiaries are organized in Nebraska?",
    expectedSources: ["berkshire-2024/brka-ex21.htm"],
    expectedAnswerContains: [
      "Berkshire Hathaway Homestate Insurance Company",
      "Berkshire Hathaway Life Insurance Company of Nebraska",
      "GEICO Casualty Company"
    ],
    capability: "table_or_list_grounding"
  },
  {
    id: "berkshire-geico-entities",
    companyId: "berkshire-2024",
    question: "Which GEICO-related entities appear in Berkshire's subsidiary list?",
    expectedSources: ["berkshire-2024/brka-ex21.htm"],
    expectedAnswerContains: ["GEICO Corporation", "GEICO General Insurance Company"],
    capability: "entity_lookup"
  },
  {
    id: "microsoft-openai",
    companyId: "microsoft-2025",
    question: "How does Microsoft describe its relationship with OpenAI?",
    expectedSources: ["microsoft-2025/msft-20250630.htm"],
    expectedAnswerContains: ["strategic partnership", "investor"],
    capability: "relationship_retrieval"
  },
  {
    id: "unsupported-ownership-percentages",
    companyId: "berkshire-2024",
    question: "What exact ownership percentages does Berkshire report for each GEICO subsidiary?",
    expectedSources: ["berkshire-2024/brka-ex21.htm"],
    expectedBehavior: "refuse_or_qualify_if_percentages_not_supported",
    capability: "grounding_refusal"
  },
  {
    id: "acl-denied-berkshire",
    companyId: "berkshire-2024",
    question: "What subsidiaries does Berkshire list?",
    expectedBehavior: "deny_or_omit_when_principal_lacks_berkshire_access",
    capability: "acl_enforcement"
  }
];

const options = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();

try {
  await mkdir(options.outputDir, { recursive: true });
  const downloads = [];

  for (const company of COMPANIES) {
    const companyDir = path.join(options.outputDir, company.id);
    await mkdir(companyDir, { recursive: true });

    for (const file of company.files) {
      const url = fileUrl(company, file.name);
      const targetPath = path.join(companyDir, file.name);
      const result = await downloadFile({
        url,
        targetPath,
        force: options.force,
        dryRun: options.dryRun
      });
      downloads.push({
        companyId: company.id,
        companyName: company.name,
        cik: company.cik,
        accession: company.accession,
        filedAt: company.filedAt,
        fileName: file.name,
        relativePath: path.posix.join(company.id, file.name),
        kind: file.kind,
        tests: file.tests,
        url,
        ...result
      });
    }
  }

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    outputDir: options.outputDir,
    userAgent: DEFAULT_USER_AGENT,
    companies: COMPANIES.map((company) => ({
      id: company.id,
      name: company.name,
      cik: company.cik,
      accession: company.accession,
      filedAt: company.filedAt,
      description: company.description,
      sourceFolderUrl: `${SEC_ARCHIVES_BASE}/${company.cik}/${company.accession}/`
    })),
    downloads,
    seedQuestions: SEED_QUESTIONS
  };

  if (!options.dryRun) {
    await writeJson(path.join(options.outputDir, "manifest.json"), manifest);
    await writeJson(path.join(options.outputDir, "ground-truth.seed.json"), SEED_QUESTIONS);
    await writeJson(
      path.join(options.outputDir, "local-files.smoke.sources.json"),
      smokeLocalFilesConfig()
    );
    await writeJson(
      path.join(options.outputDir, "local-files.sec-html-smoke.sources.json"),
      secHtmlSmokeLocalFilesConfig()
    );
    await writeJson(
      path.join(options.outputDir, "local-files.full.sources.json"),
      fullLocalFilesConfig()
    );
    await writeJson(
      path.join(options.outputDir, "local-files.large-doc.sources.json"),
      largeDocLocalFilesConfig()
    );
    await writeJson(
      path.join(options.outputDir, "local-files.sec-html-large-doc.sources.json"),
      secHtmlLargeDocLocalFilesConfig()
    );
    await writeFile(path.join(options.outputDir, "README.md"), renderReport(manifest), "utf8");
  }

  const statusCounts = countBy(downloads, "status");
  console.log(
    JSON.stringify(
      {
        status: "completed",
        outputDir: options.outputDir,
        startedAt,
        completedAt: new Date().toISOString(),
        fileCount: downloads.length,
        statusCounts,
        manifestPath: path.join(options.outputDir, "manifest.json")
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        status: "failed",
        message: error instanceof Error ? error.message : "SEC test corpus preparation failed."
      },
      null,
      2
    )
  );
  process.exitCode = 1;
}

async function downloadFile({ url, targetPath, force, dryRun }) {
  if (!force && !dryRun) {
    const existing = await existingFile(targetPath);
    if (existing) {
      return {
        status: "skipped_existing",
        bytes: existing.size
      };
    }
  }

  if (dryRun) {
    return {
      status: "dry_run",
      bytes: 0
    };
  }

  const response = await globalThis.fetch(url, {
    headers: {
      "User-Agent": DEFAULT_USER_AGENT,
      Accept: "*/*"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}.`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(`${targetPath}.tmp`, bytes);
  await rename(`${targetPath}.tmp`, targetPath);
  return {
    status: "downloaded",
    bytes: bytes.byteLength
  };
}

function fileUrl(company, fileName) {
  return `${SEC_ARCHIVES_BASE}/${company.cik}/${company.accession}/${fileName}`;
}

async function existingFile(filePath) {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile() ? fileStat : undefined;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(`${filePath}.tmp`, filePath);
}

function renderReport(manifest) {
  const lines = [
    "# SEC Company Test Corpus",
    "",
    "Public SEC EDGAR documents for exercising ingestion, parsing, graph extraction, retrieval, grounding, and ACL tests.",
    "",
    "## Companies",
    "",
    ...manifest.companies.map(
      (company) => `- ${company.name} (${company.id}): ${company.sourceFolderUrl}`
    ),
    "",
    "## Files",
    "",
    "| Company | File | Kind | Bytes | Status |",
    "| --- | --- | --- | ---: | --- |",
    ...manifest.downloads.map(
      (download) =>
        `| ${download.companyId} | ${download.relativePath} | ${download.kind} | ${download.bytes} | ${download.status} |`
    ),
    "",
    "## Seed Questions",
    "",
    ...manifest.seedQuestions.map(
      (question) => `- ${question.id}: ${question.question} (${question.capability})`
    ),
    "",
    "## Runtime Configs",
    "",
    "- `local-files.smoke.sources.json`: small mixed-file subset for first ingestion smoke tests.",
    "- `local-files.sec-html-smoke.sources.json`: SEC HTML subset for auto parser structured table/section chunking tests.",
    "- `local-files.full.sources.json`: full downloaded corpus for scale testing after smoke passes.",
    "- `local-files.large-doc.sources.json`: intentionally large 10-K HTML files for chunk-limit and sectioning tests.",
    "- `local-files.sec-html-large-doc.sources.json`: 10-K HTML files for auto parser large filing section/chunk tests.",
    ""
  ];

  return lines.join("\n");
}

function smokeLocalFilesConfig() {
  return {
    sources: [
      {
        sourceId: "curated_docs",
        rootDir: ".",
        files: [
          "berkshire-2024/brka-ex21.htm",
          "berkshire-2024/Financial_Report.xlsx",
          "alphabet-2024/googexhibit2101q42024.htm",
          "alphabet-2024/goog-20241231_g1.jpg",
          "microsoft-2025/msft-ex21.htm",
          "microsoft-2025/msft-ex10_7.htm",
          "aflac-2025-pdf/afl12312510k.pdf"
        ],
        recursive: false,
        includeExtensions: [".htm", ".xlsx", ".jpg", ".pdf"],
        parserMode: "disabled",
        maxFileBytes: 12000000,
        sourceKind: "local_file",
        trustTier: "trusted_internal",
        sensitivity: "internal",
        capturedAt: "2026-06-25T00:00:00.000Z",
        originUriBase: "https://www.sec.gov/Archives/edgar/data",
        accessScope: {
          tenantId: "tenant_1",
          namespaceId: "generic-docs",
          roles: ["admin"],
          tags: ["sec-test-corpus"]
        },
        metadata: {
          corpus: "sec-company-test-corpus",
          mode: "smoke"
        }
      }
    ]
  };
}

function secHtmlSmokeLocalFilesConfig() {
  return {
    sources: [
      {
        sourceId: "curated_docs",
        rootDir: ".",
        files: [
          "berkshire-2024/brka-ex21.htm",
          "alphabet-2024/googexhibit2101q42024.htm",
          "microsoft-2025/msft-ex21.htm",
          "microsoft-2025/msft-ex10_7.htm"
        ],
        recursive: false,
        includeExtensions: [".htm"],
        maxFileBytes: 12000000,
        sourceKind: "local_file",
        trustTier: "trusted_internal",
        sensitivity: "internal",
        capturedAt: "2026-06-25T00:00:00.000Z",
        originUriBase: "https://www.sec.gov/Archives/edgar/data",
        accessScope: {
          tenantId: "tenant_1",
          namespaceId: "generic-docs",
          roles: ["admin"],
          tags: ["sec-test-corpus"]
        },
        metadata: {
          corpus: "sec-company-test-corpus",
          mode: "sec-html-smoke"
        }
      }
    ]
  };
}

function fullLocalFilesConfig() {
  return {
    sources: [
      {
        sourceId: "curated_docs",
        rootDir: ".",
        files: downloadedCorpusFiles(),
        recursive: false,
        includeExtensions: [".json", ".htm", ".txt", ".xml", ".xlsx", ".zip", ".jpg", ".pdf"],
        maxFileBytes: 60000000,
        sourceKind: "local_file",
        trustTier: "trusted_internal",
        sensitivity: "internal",
        capturedAt: "2026-06-25T00:00:00.000Z",
        originUriBase: "https://www.sec.gov/Archives/edgar/data",
        accessScope: {
          tenantId: "tenant_1",
          namespaceId: "generic-docs",
          roles: ["admin"],
          tags: ["sec-test-corpus"]
        },
        metadata: {
          corpus: "sec-company-test-corpus",
          mode: "full"
        }
      }
    ]
  };
}

function downloadedCorpusFiles() {
  return COMPANIES.flatMap((company) =>
    company.files.map((file) => path.posix.join(company.id, file.name))
  );
}

function largeDocLocalFilesConfig() {
  return {
    sources: [
      {
        sourceId: "curated_docs",
        rootDir: ".",
        files: ["alphabet-2024/goog-20241231.htm", "microsoft-2025/msft-20250630.htm"],
        recursive: false,
        includeExtensions: [".htm"],
        maxFileBytes: 12000000,
        sourceKind: "local_file",
        trustTier: "trusted_internal",
        sensitivity: "internal",
        capturedAt: "2026-06-25T00:00:00.000Z",
        originUriBase: "https://www.sec.gov/Archives/edgar/data",
        accessScope: {
          tenantId: "tenant_1",
          namespaceId: "generic-docs",
          roles: ["admin"],
          tags: ["sec-test-corpus"]
        },
        metadata: {
          corpus: "sec-company-test-corpus",
          mode: "large-doc"
        }
      }
    ]
  };
}

function secHtmlLargeDocLocalFilesConfig() {
  return {
    sources: [
      {
        sourceId: "curated_docs",
        rootDir: ".",
        files: ["alphabet-2024/goog-20241231.htm", "microsoft-2025/msft-20250630.htm"],
        recursive: false,
        includeExtensions: [".htm"],
        maxFileBytes: 12000000,
        sourceKind: "local_file",
        trustTier: "trusted_internal",
        sensitivity: "internal",
        capturedAt: "2026-06-25T00:00:00.000Z",
        originUriBase: "https://www.sec.gov/Archives/edgar/data",
        accessScope: {
          tenantId: "tenant_1",
          namespaceId: "generic-docs",
          roles: ["admin"],
          tags: ["sec-test-corpus"]
        },
        metadata: {
          corpus: "sec-company-test-corpus",
          mode: "sec-html-large-doc"
        }
      }
    ]
  };
}

function parseArgs(args) {
  const parsed = {
    outputDir: DEFAULT_REPORT_DIR,
    force: false,
    dryRun: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--output-dir":
        parsed.outputDir = requiredValue(args, ++index, arg);
        break;
      case "--force":
        parsed.force = true;
        break;
      case "--dry-run":
        parsed.dryRun = true;
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

function countBy(items, key) {
  return items.reduce((counts, item) => {
    const value = String(item[key]);
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}
