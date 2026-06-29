#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_OUTPUT_DIR = path.join(".rag", "external-parser-corpus");
const FIXED_CAPTURED_AT = "2026-06-27T00:00:00.000Z";
const USER_AGENT = "adaptable-rag-parser-corpus/1.0 anton@example.invalid";

const FILES = [
  {
    path: "apache-poi/document/SampleDoc.docx",
    url: "https://raw.githubusercontent.com/apache/poi/trunk/test-data/document/SampleDoc.docx",
    source: "Apache POI test-data",
    license: "Apache License 2.0 repository",
    tests: ["DOCX paragraphs", "basic Word extraction"]
  },
  {
    path: "apache-poi/document/TestTableCellAlign.docx",
    url: "https://raw.githubusercontent.com/apache/poi/trunk/test-data/document/TestTableCellAlign.docx",
    source: "Apache POI test-data",
    license: "Apache License 2.0 repository",
    tests: ["DOCX tables", "table cell preservation"]
  },
  {
    path: "apache-poi/document/VariousPictures.docx",
    url: "https://raw.githubusercontent.com/apache/poi/trunk/test-data/document/VariousPictures.docx",
    source: "Apache POI test-data",
    license: "Apache License 2.0 repository",
    tests: ["DOCX embedded pictures", "mixed text and media document"]
  },
  {
    path: "apache-poi/spreadsheet/123233_charts.xlsx",
    url: "https://raw.githubusercontent.com/apache/poi/trunk/test-data/spreadsheet/123233_charts.xlsx",
    source: "Apache POI test-data",
    license: "Apache License 2.0 repository",
    tests: ["XLSX chart workbook", "visual asset mapping"]
  },
  {
    path: "apache-poi/spreadsheet/50867_with_table.xlsx",
    url: "https://raw.githubusercontent.com/apache/poi/trunk/test-data/spreadsheet/50867_with_table.xlsx",
    source: "Apache POI test-data",
    license: "Apache License 2.0 repository",
    tests: ["XLSX table workbook", "worksheet table preservation"]
  },
  {
    path: "apache-poi/spreadsheet/50755_workday_formula_example.xlsx",
    url: "https://raw.githubusercontent.com/apache/poi/trunk/test-data/spreadsheet/50755_workday_formula_example.xlsx",
    source: "Apache POI test-data",
    license: "Apache License 2.0 repository",
    tests: ["XLSX formulas", "formula text preservation"]
  },
  {
    path: "apache-poi/spreadsheet/suffix-generator.xlsm",
    url: "https://raw.githubusercontent.com/apache/poi/trunk/test-data/spreadsheet/0-www-crossref-org.lib.rivier.edu_education-files_suffix-generator.xlsm",
    source: "Apache POI test-data",
    license: "Apache License 2.0 repository",
    tests: ["macro-enabled XLSM", "worksheet extraction without macro execution"]
  },
  {
    path: "apache-poi/spreadsheet/SampleSS.xml",
    url: "https://raw.githubusercontent.com/apache/poi/trunk/test-data/spreadsheet/SampleSS.xml",
    source: "Apache POI test-data",
    license: "Apache License 2.0 repository",
    tests: ["XML spreadsheet-like data", "nested tag/value extraction"]
  },
  {
    path: "apache-poi/slideshow/SampleShow.pptx",
    url: "https://raw.githubusercontent.com/apache/poi/trunk/test-data/slideshow/SampleShow.pptx",
    source: "Apache POI test-data",
    license: "Apache License 2.0 repository",
    tests: ["PPTX slides", "speaker-facing text extraction"]
  },
  {
    path: "apache-poi/slideshow/bar-chart.pptx",
    url: "https://raw.githubusercontent.com/apache/poi/trunk/test-data/slideshow/bar-chart.pptx",
    source: "Apache POI test-data",
    license: "Apache License 2.0 repository",
    tests: ["PPTX chart slide", "chart-containing presentation"]
  },
  {
    path: "apache-poi/slideshow/line-chart.pptx",
    url: "https://raw.githubusercontent.com/apache/poi/trunk/test-data/slideshow/line-chart.pptx",
    source: "Apache POI test-data",
    license: "Apache License 2.0 repository",
    tests: ["PPTX line chart", "chart-containing presentation"]
  },
  {
    path: "apache-poi/images/GaiaTestImg.png",
    url: "https://raw.githubusercontent.com/apache/poi/trunk/test-data/document/GaiaTestImg.png",
    source: "Apache POI test-data",
    license: "Apache License 2.0 repository",
    tests: ["standalone PNG", "image parser routing"]
  },
  {
    path: "apache-poi/images/clock.jpg",
    url: "https://raw.githubusercontent.com/apache/poi/trunk/test-data/slideshow/clock.jpg",
    source: "Apache POI test-data",
    license: "Apache License 2.0 repository",
    tests: ["standalone JPG", "image parser routing"]
  },
  {
    path: "irs/fw4.pdf",
    url: "https://www.irs.gov/pub/irs-pdf/fw4.pdf",
    source: "IRS public forms",
    license: "U.S. government public form",
    tests: ["PDF form", "multi-page text and boxes"]
  },
  {
    path: "irs/f1040.pdf",
    url: "https://www.irs.gov/pub/irs-pdf/f1040.pdf",
    source: "IRS public forms",
    license: "U.S. government public form",
    tests: ["PDF tax form", "dense form layout"]
  },
  {
    path: "sec/aapl-20260328.htm",
    url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000013/aapl-20260328.htm",
    source: "SEC EDGAR filing",
    license: "SEC public filing",
    tests: ["HTML filing", "tables and section text"]
  },
  {
    path: "sec/company_tickers.json",
    url: "https://www.sec.gov/files/company_tickers.json",
    source: "SEC company tickers",
    license: "SEC public data",
    tests: ["JSON object array", "nested key/value extraction"]
  },
  {
    path: "chartqa/test_human.json",
    url: "https://raw.githubusercontent.com/vis-nlp/ChartQA/main/ChartQA%20Dataset/test/test_human.json",
    source: "ChartQA test split",
    license: "See ChartQA repository LICENSE",
    tests: ["chart question ground truth", "JSON benchmark metadata"]
  },
  {
    path: "chartqa/png/00339007006077.png",
    url: "https://raw.githubusercontent.com/vis-nlp/ChartQA/main/ChartQA%20Dataset/test/png/00339007006077.png",
    source: "ChartQA test split",
    license: "See ChartQA repository LICENSE",
    tests: ["chart PNG", "visual parser routing"]
  },
  {
    path: "chartqa/png/1201.png",
    url: "https://raw.githubusercontent.com/vis-nlp/ChartQA/main/ChartQA%20Dataset/test/png/1201.png",
    source: "ChartQA test split",
    license: "See ChartQA repository LICENSE",
    tests: ["chart PNG", "visual parser routing"]
  },
  {
    path: "chartqa/tables/00339007006077.csv",
    url: "https://raw.githubusercontent.com/vis-nlp/ChartQA/main/ChartQA%20Dataset/test/tables/00339007006077.csv",
    source: "ChartQA test split",
    license: "See ChartQA repository LICENSE",
    tests: ["chart source table", "CSV table preservation"]
  },
  {
    path: "chartqa/tables/1201.csv",
    url: "https://raw.githubusercontent.com/vis-nlp/ChartQA/main/ChartQA%20Dataset/test/tables/1201.csv",
    source: "ChartQA test split",
    license: "See ChartQA repository LICENSE",
    tests: ["chart source table", "CSV table preservation"]
  }
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const filesDir = path.join(options.outputDir, "files");
  await mkdir(filesDir, { recursive: true });

  const downloaded = [];
  for (const file of FILES) {
    downloaded.push(await downloadFile(file, filesDir));
  }

  const sourceConfig = {
    sources: [
      {
        sourceId: "curated_docs",
        rootDir: "files",
        files: downloaded.map((file) => file.path),
        recursive: false,
        includeExtensions: [
          ".csv",
          ".docx",
          ".htm",
          ".html",
          ".jpg",
          ".jpeg",
          ".json",
          ".pdf",
          ".png",
          ".pptx",
          ".xlsm",
          ".xlsx",
          ".xml"
        ],
        maxFileBytes: 5_000_000,
        parserMode: "auto",
        sourceKind: "local_file",
        trustTier: "trusted_internal",
        sensitivity: "internal",
        capturedAt: FIXED_CAPTURED_AT,
        accessScope: {
          tenantId: "tenant_1",
          namespaceId: "generic-docs",
          roles: ["admin"],
          tags: ["external-parser-corpus"]
        },
        metadata: {
          corpus: "external-parser-corpus",
          mode: "real-public-files"
        }
      }
    ]
  };

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    outputDir: options.outputDir,
    fileCount: downloaded.length,
    totalBytes: downloaded.reduce((sum, file) => sum + file.bytes, 0),
    files: downloaded
  };

  await writeJson(path.join(options.outputDir, "local-files.sources.json"), sourceConfig);
  await writeJson(path.join(options.outputDir, "manifest.json"), manifest);
  await writeFile(path.join(options.outputDir, "MANIFEST.md"), renderManifest(manifest), "utf8");

  console.log(
    JSON.stringify(
      {
        status: "completed",
        outputDir: options.outputDir,
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes,
        sourceConfigPath: path.join(options.outputDir, "local-files.sources.json"),
        manifestPath: path.join(options.outputDir, "manifest.json")
      },
      null,
      2
    )
  );
}

async function downloadFile(file, filesDir) {
  const response = await globalThis.fetch(file.url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "*/*"
    }
  });

  if (!response.ok) {
    throw new Error(`Download failed for ${file.url}: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const targetPath = path.join(filesDir, file.path);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, buffer);

  return {
    ...file,
    bytes: buffer.byteLength,
    contentType: response.headers.get("content-type") ?? "unknown"
  };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function renderManifest(manifest) {
  return [
    "# External Parser Corpus",
    "",
    "Downloaded real public files for parser-level RAG testing.",
    "",
    `- Generated at: ${manifest.generatedAt}`,
    `- Files: ${manifest.fileCount}`,
    `- Total bytes: ${manifest.totalBytes}`,
    "",
    "## Files",
    "",
    "| File | Source | Bytes | Tests | URL |",
    "| --- | --- | ---: | --- | --- |",
    ...manifest.files.map(
      (file) =>
        `| \`${file.path}\` | ${file.source} | ${file.bytes} | ${file.tests.join(", ")} | ${file.url} |`
    ),
    "",
    "## Notes",
    "",
    "- Downloaded files are stored under `.rag/external-parser-corpus/files/` and are ignored by git.",
    "- `manifest.json` keeps the original URL, source, license note, content type, size, and intended parser coverage for each file.",
    "- ChartQA JSON and CSV files provide benchmark-style ground truth, but answer-match evaluation is not wired into this parser audit yet.",
    ""
  ].join("\n");
}

function parseArgs(args) {
  const parsed = {
    outputDir: DEFAULT_OUTPUT_DIR
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--output-dir") {
      parsed.outputDir = requiredValue(arg, value);
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

await main();
