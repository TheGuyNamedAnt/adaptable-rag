#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VALID_DATASETS = new Set(["all", "omnidocbench", "tablebank", "docvqa", "chartqa"]);
const VALID_INPUT_MODES = new Set(["auto", "all", "image", "pdf"]);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const LOCAL_BENCHMARK_PYTHON = path.join(
  REPO_ROOT,
  ".rag",
  "parser-benchmark-venv",
  "bin",
  "python"
);

export async function checkParserBenchmarkEnvironment(options = {}) {
  const dataset = options.dataset ?? "all";
  const inputMode = options.inputMode ?? "auto";
  const checks = [];

  for (const scriptPath of [
    "scripts/pdf-rag-parser.mjs",
    "scripts/docling-rag-parser.mjs",
    "scripts/markitdown-rag-parser.mjs",
    "scripts/openpyxl-rag-parser.mjs"
  ]) {
    checks.push(await fileCheck(scriptPath));
  }

  const pythonChecks = {
    pdf: await pythonAnyModuleCheck(
      "python_pdf_text",
      pythonFor("pdf"),
      ["pdfplumber", "pypdf"],
      "Install `pdfplumber` or `pypdf`, or set RAG_PDF_PYTHON/RAG_DOCLING_PYTHON."
    ),
    docling: await pythonModuleCheck(
      "python_docling",
      pythonFor("docling"),
      "docling",
      "Install `docling`, or set RAG_DOCLING_PYTHON."
    ),
    markitdown: await pythonModuleCheck(
      "python_markitdown",
      pythonFor("markitdown"),
      "markitdown",
      "Install `markitdown[all]`, or set RAG_MARKITDOWN_PYTHON."
    ),
    openpyxl: await pythonModuleCheck(
      "python_openpyxl",
      pythonFor("openpyxl"),
      "openpyxl",
      "Install `openpyxl`, or set RAG_OPENPYXL_PYTHON."
    )
  };
  checks.push(...Object.values(pythonChecks));

  const paddleocr = await commandCheck(
    "command_paddleocr",
    "paddleocr-rag-parser",
    "Install or expose `paddleocr-rag-parser` if you want PaddleOCR image parsing."
  );
  const mineru = await commandCheck(
    "command_mineru",
    "mineru-rag-parser",
    "Install or expose `mineru-rag-parser` if you want MinerU image parsing."
  );
  checks.push(paddleocr, mineru);

  checks.push(...requiredCapabilityChecks(dataset, inputMode, { pythonChecks, paddleocr, mineru }));

  return {
    dataset,
    inputMode,
    status: overallStatus(checks),
    checks
  };
}

export function renderParserBenchmarkEnvironmentReport(report) {
  const lines = [
    `Parser benchmark environment: ${report.status}`,
    `dataset=${report.dataset}`,
    `inputMode=${report.inputMode}`,
    ...report.checks.map((check) => `- ${check.status.toUpperCase()} ${check.id}: ${check.message}`)
  ];
  return lines.join("\n");
}

function requiredCapabilityChecks(dataset, inputMode, context) {
  const checks = [];
  const modes = requiredModes(dataset, inputMode);

  if (modes.includes("pdf")) {
    const hasPdfParser =
      context.pythonChecks.pdf.status === "passed" ||
      context.pythonChecks.docling.status === "passed";
    checks.push({
      id: "capability_pdf_benchmark_parser",
      status: hasPdfParser ? "passed" : "failed",
      message: hasPdfParser
        ? "At least one local PDF parser is available."
        : "PDF benchmark mode needs `pdfplumber`/`pypdf` or `docling`."
    });
  }

  if (modes.includes("image")) {
    const hasImageParser =
      context.pythonChecks.docling.status === "passed" ||
      context.paddleocr.status === "passed" ||
      context.mineru.status === "passed";
    checks.push({
      id: "capability_image_benchmark_parser",
      status: hasImageParser ? "passed" : "failed",
      message: hasImageParser
        ? "At least one local image parser is available."
        : "Image benchmarks need `docling`, `paddleocr-rag-parser`, or `mineru-rag-parser`."
    });

    const hasTableCapableImageParser =
      context.pythonChecks.docling.status === "passed" || context.mineru.status === "passed";
    if (dataset === "all" || dataset === "tablebank" || dataset === "omnidocbench") {
      checks.push({
        id: "capability_table_image_parser",
        status: hasTableCapableImageParser ? "passed" : "warning",
        message: hasTableCapableImageParser
          ? "A table-capable image parser is available."
          : "Table-heavy image benchmarks should use Docling or MinerU for meaningful table recall."
      });
    }
  }

  if (context.pythonChecks.markitdown.status !== "passed") {
    checks.push({
      id: "capability_markitdown_optional",
      status: "skipped",
      message:
        "MarkItDown is optional for these benchmark modes, but useful for broader document parsing."
    });
  }

  if (context.pythonChecks.openpyxl.status !== "passed") {
    checks.push({
      id: "capability_openpyxl_optional",
      status: "skipped",
      message: "OpenPyXL is optional for these benchmark modes, but needed for spreadsheet parsing."
    });
  }

  return checks;
}

function requiredModes(dataset, inputMode) {
  if (inputMode === "image" || inputMode === "pdf") {
    return [inputMode];
  }
  if (inputMode === "all" || dataset === "all") {
    return ["image", "pdf"];
  }
  if (dataset === "omnidocbench") {
    return ["image"];
  }
  return ["image"];
}

async function fileCheck(relativePath) {
  const absolutePath = path.join(REPO_ROOT, relativePath);
  try {
    await access(absolutePath);
    return {
      id: `file_${relativePath.replace(/[^a-z0-9]+/giu, "_").replace(/^_|_$/gu, "")}`,
      status: "passed",
      message: `${relativePath} exists.`
    };
  } catch {
    return {
      id: `file_${relativePath.replace(/[^a-z0-9]+/giu, "_").replace(/^_|_$/gu, "")}`,
      status: "failed",
      message: `${relativePath} is missing.`
    };
  }
}

async function pythonModuleCheck(id, python, moduleName, installHint) {
  return pythonAnyModuleCheck(id, python, [moduleName], installHint);
}

async function pythonAnyModuleCheck(id, python, moduleNames, installHint) {
  const pythonAvailable = await commandAvailable(python);
  if (!pythonAvailable) {
    return {
      id,
      status: "skipped",
      message: `${python} is not executable. ${installHint}`
    };
  }

  const code =
    "import importlib.util, sys; sys.exit(0 if any(importlib.util.find_spec(name) is not None for name in sys.argv[1:]) else 1)";
  const result = await run(python, ["-c", code, ...moduleNames]);
  if (result.ok) {
    return {
      id,
      status: "passed",
      message: `${python} has ${moduleNames.join(" or ")}.`
    };
  }
  return {
    id,
    status: "skipped",
    message: `${python} is missing ${moduleNames.join(" or ")}. ${installHint}`
  };
}

async function commandCheck(id, command, installHint) {
  const available = await commandAvailable(command);
  return {
    id,
    status: available ? "passed" : "skipped",
    message: available ? `${command} is available.` : `${command} is not on PATH. ${installHint}`
  };
}

async function commandAvailable(command) {
  if (command.includes("/") || command.includes("\\")) {
    try {
      await access(command);
      return true;
    } catch {
      return false;
    }
  }
  const result = await run("sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`]);
  return result.ok;
}

function pythonFor(kind) {
  if (kind === "pdf") {
    return (
      process.env.RAG_PDF_PYTHON ??
      process.env.RAG_DOCLING_PYTHON ??
      localBenchmarkPythonOrDefault()
    );
  }
  if (kind === "docling") {
    return process.env.RAG_DOCLING_PYTHON ?? localBenchmarkPythonOrDefault();
  }
  if (kind === "markitdown") {
    return process.env.RAG_MARKITDOWN_PYTHON ?? localBenchmarkPythonOrDefault();
  }
  return (
    process.env.RAG_OPENPYXL_PYTHON ??
    process.env.RAG_DOCLING_PYTHON ??
    localBenchmarkPythonOrDefault()
  );
}

function localBenchmarkPythonOrDefault() {
  return existsSync(LOCAL_BENCHMARK_PYTHON) ? LOCAL_BENCHMARK_PYTHON : "python3";
}

function overallStatus(checks) {
  if (checks.some((check) => check.status === "failed")) {
    return "failed";
  }
  if (checks.some((check) => check.status === "warning")) {
    return "warning";
  }
  return "passed";
}

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15_000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout,
        stderr,
        error: error instanceof Error ? error.message : undefined
      });
    });
  });
}

function shellQuote(value) {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function parseArgs(args) {
  const options = { dataset: "all", inputMode: "all", json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--dataset":
        options.dataset = requiredValue(args, ++index, arg);
        break;
      case "--input-mode":
        options.inputMode = requiredValue(args, ++index, arg);
        break;
      case "--json":
        options.json = booleanValue(requiredValue(args, ++index, arg), arg);
        break;
      default:
        throw new Error(`Unknown parser benchmark environment argument "${arg}".`);
    }
  }
  if (!VALID_DATASETS.has(options.dataset)) {
    throw new Error(`--dataset must be one of ${[...VALID_DATASETS].join(", ")}.`);
  }
  if (!VALID_INPUT_MODES.has(options.inputMode)) {
    throw new Error(`--input-mode must be one of ${[...VALID_INPUT_MODES].join(", ")}.`);
  }
  return options;
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function booleanValue(value, flag) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${flag} must be true or false.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = await checkParserBenchmarkEnvironment(options);
    console.log(
      options.json
        ? JSON.stringify(report, null, 2)
        : renderParserBenchmarkEnvironmentReport(report)
    );
    if (report.status === "failed") {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
