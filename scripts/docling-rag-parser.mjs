#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(scriptDir, "docling_rag_parser.py");
const localBenchmarkPython = resolve(
  scriptDir,
  "..",
  ".rag",
  "parser-benchmark-venv",
  "bin",
  "python"
);
const python =
  process.env.RAG_DOCLING_PYTHON ??
  (existsSync(localBenchmarkPython) ? localBenchmarkPython : "python3");

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const child = spawn(python, [helperPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env
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
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
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
    process.exitCode = code ?? 1;
  });

  child.stdin.end(stdin);
});
