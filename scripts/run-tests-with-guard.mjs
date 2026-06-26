#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const coverage = args.includes("--coverage");
const floors = {
  lines: readNumberArg("--coverage-lines", 80),
  branches: readNumberArg("--coverage-branches", 75),
  functions: readNumberArg("--coverage-functions", 85)
};
const testFiles = findTestFiles(path.join(root, "dist"));

if (testFiles.length === 0) {
  console.error("No compiled test files found under dist/**/*.test.js.");
  process.exit(1);
}

const nodeArgs = [...(coverage ? ["--experimental-test-coverage"] : []), "--test", ...testFiles];
const result = spawnSync(process.execPath, nodeArgs, {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});
const output = `${result.stdout}\n${result.stderr}`;

process.stdout.write(result.stdout);
process.stderr.write(result.stderr);

const testCount = parseTestCount(output);
if (testCount === undefined || testCount < 1) {
  console.error("Test guard failed: Node test output did not report at least one test.");
  process.exit(result.status && result.status !== 0 ? result.status : 1);
}

if (coverage) {
  const coverageSummary = parseCoverageSummary(output);
  if (!coverageSummary) {
    console.error("Coverage guard failed: no all-files coverage summary was found.");
    process.exit(result.status && result.status !== 0 ? result.status : 1);
  }

  const failures = [
    coverageSummary.lines < floors.lines
      ? `line coverage ${coverageSummary.lines}% is below ${floors.lines}%`
      : "",
    coverageSummary.branches < floors.branches
      ? `branch coverage ${coverageSummary.branches}% is below ${floors.branches}%`
      : "",
    coverageSummary.functions < floors.functions
      ? `function coverage ${coverageSummary.functions}% is below ${floors.functions}%`
      : ""
  ].filter(Boolean);

  if (failures.length > 0) {
    console.error(`Coverage guard failed:\n${failures.join("\n")}`);
    process.exit(result.status && result.status !== 0 ? result.status : 1);
  }
}

process.exit(result.status ?? 1);

function findTestFiles(directory) {
  if (!existsSync(directory)) {
    return [];
  }

  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...findTestFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".test.js")) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function readNumberArg(name, fallback) {
  const prefix = `${name}=`;
  const rawValue = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (rawValue === undefined) {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    console.error(`${name} must be a number between 0 and 100.`);
    process.exit(1);
  }

  return value;
}

function parseTestCount(output) {
  const summaryMatch = output.match(/(?:^|\n)\s*ℹ?\s*tests\s+(\d+)/u);
  if (summaryMatch?.[1]) {
    return Number(summaryMatch[1]);
  }

  const tapPlanMatch = output.match(/(?:^|\n)1\.\.(\d+)(?:\n|$)/u);
  return tapPlanMatch?.[1] ? Number(tapPlanMatch[1]) : undefined;
}

function parseCoverageSummary(output) {
  const line = output
    .split(/\r?\n/u)
    .find((candidate) => candidate.includes("all files") && candidate.includes("|"));

  if (!line) {
    return undefined;
  }

  const [, lines, branches, functions] = line
    .replace(/^ℹ\s*/u, "")
    .split("|")
    .map((part) => part.trim());

  const summary = {
    lines: Number(lines),
    branches: Number(branches),
    functions: Number(functions)
  };

  return Object.values(summary).every(Number.isFinite) ? summary : undefined;
}
