#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_OUTPUT_DIR = path.join(".rag", "excel-parser-corpus");
const FIXED_CAPTURED_AT = "2026-06-25T00:00:00.000Z";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.outputDir, { recursive: true });

  await runPython(options.python, PYTHON_GENERATOR, [path.resolve(options.outputDir)]);

  const files = [
    "multi_sheet_financials.xlsx",
    "formulas_merged_hidden.xlsx",
    "large_sheet.xlsx",
    "empty_workbook.xlsx",
    "macro_extension.xlsm",
    "legacy_binary.xls",
    "comma_export.csv",
    "tab_export.tsv"
  ];

  const sourceConfig = {
    sources: [
      {
        sourceId: "curated_docs",
        rootDir: ".",
        files,
        recursive: false,
        includeExtensions: [".xlsx", ".xlsm", ".xls", ".csv", ".tsv"],
        maxFileBytes: 20_000_000,
        sourceKind: "local_file",
        trustTier: "trusted_internal",
        sensitivity: "internal",
        capturedAt: FIXED_CAPTURED_AT,
        accessScope: {
          tenantId: "tenant_1",
          namespaceId: "generic-docs",
          roles: ["admin"],
          tags: ["excel-parser-stress"]
        },
        metadata: {
          corpus: "excel-parser-corpus",
          mode: "excel-stress"
        }
      }
    ]
  };

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    outputDir: options.outputDir,
    files: [
      {
        path: "multi_sheet_financials.xlsx",
        tests: ["multiple sheets", "ownership table", "text notes"]
      },
      {
        path: "formulas_merged_hidden.xlsx",
        tests: ["formulas", "merged cells", "hidden row", "hidden sheet", "chart", "embedded image"]
      },
      {
        path: "large_sheet.xlsx",
        tests: ["large worksheet", "row/column provenance"]
      },
      {
        path: "empty_workbook.xlsx",
        tests: ["empty workbook fail-soft behavior"]
      },
      {
        path: "macro_extension.xlsm",
        tests: ["macro-enabled extension routing"]
      },
      {
        path: "legacy_binary.xls",
        tests: ["legacy binary XLS unsupported fail-closed behavior"]
      },
      {
        path: "comma_export.csv",
        tests: ["CSV delimited table parser"]
      },
      {
        path: "tab_export.tsv",
        tests: ["TSV delimited table parser"]
      }
    ],
    expectations: {
      shouldParse: [
        "multi_sheet_financials.xlsx",
        "formulas_merged_hidden.xlsx",
        "large_sheet.xlsx",
        "macro_extension.xlsm",
        "comma_export.csv",
        "tab_export.tsv"
      ],
      mayWarn: ["formulas_merged_hidden.xlsx"],
      shouldFailClosed: ["empty_workbook.xlsx", "legacy_binary.xls"]
    }
  };

  await writeJson(path.join(options.outputDir, "local-files.sources.json"), sourceConfig);
  await writeJson(path.join(options.outputDir, "manifest.json"), manifest);
  await writeFile(path.join(options.outputDir, "README.md"), renderReadme(manifest), "utf8");

  console.log(
    JSON.stringify(
      {
        status: "completed",
        outputDir: options.outputDir,
        fileCount: files.length,
        sourceConfigPath: path.join(options.outputDir, "local-files.sources.json")
      },
      null,
      2
    )
  );
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function renderReadme(manifest) {
  return [
    "# Excel Parser Corpus",
    "",
    "Generated spreadsheet fixtures for parser-level RAG testing.",
    "",
    "## Files",
    "",
    "| File | Tests |",
    "| --- | --- |",
    ...manifest.files.map((file) => `| ${file.path} | ${file.tests.join(", ")} |`),
    "",
    "## Expectations",
    "",
    `- Should parse: ${manifest.expectations.shouldParse.join(", ")}`,
    `- May warn: ${manifest.expectations.mayWarn.join(", ")}`,
    `- Should fail closed: ${manifest.expectations.shouldFailClosed.join(", ")}`,
    ""
  ].join("\n");
}

function runPython(python, source, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-", ...args], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (stdout.trim()) {
        process.stdout.write(stdout);
      }
      if (stderr.trim()) {
        process.stderr.write(stderr);
        if (!stderr.endsWith("\n")) {
          process.stderr.write("\n");
        }
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Excel fixture generation failed with exit code ${code}.`));
      }
    });
    child.stdin.end(source);
  });
}

function parseArgs(args) {
  const parsed = {
    outputDir: DEFAULT_OUTPUT_DIR,
    python:
      process.env.RAG_EXCEL_PYTHON ??
      process.env.RAG_OPENPYXL_PYTHON ??
      process.env.RAG_DOCLING_PYTHON ??
      "python3"
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--output-dir") {
      parsed.outputDir = requiredValue(arg, value);
      index += 1;
    } else if (arg === "--python") {
      parsed.python = requiredValue(arg, value);
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

const PYTHON_GENERATOR = String.raw`
import csv
import sys
from pathlib import Path

from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.drawing.image import Image as SpreadsheetImage
from openpyxl.styles import Font, PatternFill
from PIL import Image, ImageDraw

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)

def save_multi_sheet():
    wb = Workbook()
    summary = wb.active
    summary.title = "Summary"
    summary.append(["Metric", "Value", "Unit"])
    summary.append(["Revenue", 1250000, "USD"])
    summary.append(["EBITDA", 310000, "USD"])
    summary.append(["Debt", 420000, "USD"])
    ownership = wb.create_sheet("Ownership")
    ownership.append(["Parent", "Child", "Ownership %", "Jurisdiction"])
    ownership.append(["Parent Holdings LLC", "Alpha Subsidiary Inc.", 80, "Delaware"])
    ownership.append(["Parent Holdings LLC", "Beta Operations GmbH", 20, "Germany"])
    notes = wb.create_sheet("Notes")
    notes.append(["Note"])
    notes.append(["The ownership percentages are board-approved as of Q4."])
    wb.save(out / "multi_sheet_financials.xlsx")

def save_formulas_merged_hidden():
    wb = Workbook()
    sheet = wb.active
    sheet.title = "Model"
    sheet.merge_cells("A1:C1")
    sheet["A1"] = "Operating Model"
    sheet["A1"].font = Font(bold=True)
    sheet["A1"].fill = PatternFill("solid", fgColor="D9EAF7")
    rows = [
        ["Quarter", "Revenue", "Cost"],
        ["Q1", 100, 55],
        ["Q2", 120, 62],
        ["Q3", 140, 70],
        ["Total", "=SUM(B2:B4)", "=SUM(C2:C4)"],
        ["Margin", "=B5-C5", "=B6/B5"],
    ]
    for row in rows:
        sheet.append(row)
    sheet.row_dimensions[4].hidden = True
    sheet.column_dimensions["C"].hidden = True
    chart = BarChart()
    chart.title = "Revenue by Quarter"
    chart.add_data(Reference(sheet, min_col=2, min_row=1, max_row=4), titles_from_data=True)
    chart.set_categories(Reference(sheet, min_col=1, min_row=2, max_row=4))
    sheet.add_chart(chart, "E2")
    image_path = out / "embedded_source.png"
    image = Image.new("RGB", (220, 80), "#ffffff")
    draw = ImageDraw.Draw(image)
    draw.rectangle((10, 10, 210, 70), outline="#1f77b4", width=3)
    draw.text((24, 30), "Embedded revenue image", fill="#111111")
    image.save(image_path)
    sheet.add_image(SpreadsheetImage(str(image_path)), "E18")
    hidden = wb.create_sheet("HiddenAssumptions")
    hidden.sheet_state = "hidden"
    hidden.append(["Assumption", "Value"])
    hidden.append(["Discount Rate", "11%"])
    wb.save(out / "formulas_merged_hidden.xlsx")
    image_path.unlink(missing_ok=True)

def save_large_sheet():
    wb = Workbook()
    sheet = wb.active
    sheet.title = "Transactions"
    sheet.append(["Row", "Account", "Entity", "Amount", "Currency", "Scenario"])
    for index in range(1, 751):
        sheet.append([
            index,
            f"Account {index % 17}",
            f"Entity {index % 9}",
            index * 13.37,
            "USD",
            "Base" if index % 2 else "Downside",
        ])
    wb.save(out / "large_sheet.xlsx")

def save_empty_workbook():
    wb = Workbook()
    wb.active.title = "Empty"
    wb.save(out / "empty_workbook.xlsx")

def save_macro_extension():
    wb = Workbook()
    sheet = wb.active
    sheet.title = "MacroExtension"
    sheet.append(["Task", "Owner", "Status"])
    sheet.append(["Refresh model", "Finance", "Open"])
    wb.save(out / "macro_extension.xlsm")

def save_legacy_xls_placeholder():
    # Compound File Binary Format magic. This is intentionally unsupported and should fail closed.
    (out / "legacy_binary.xls").write_bytes(bytes.fromhex("D0CF11E0A1B11AE1") + bytes(2048))

def save_delimited():
    with (out / "comma_export.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["Entity", "Metric", "Value"])
        writer.writerow(["Alpha Subsidiary Inc.", "Revenue", "1250000"])
    with (out / "tab_export.tsv").open("w", newline="", encoding="utf-8") as handle:
        handle.write("Entity\tMetric\tValue\n")
        handle.write("Beta Operations GmbH\tDebt\t420000\n")

save_multi_sheet()
save_formulas_merged_hidden()
save_large_sheet()
save_empty_workbook()
save_macro_extension()
save_legacy_xls_placeholder()
save_delimited()
`;

await main();
