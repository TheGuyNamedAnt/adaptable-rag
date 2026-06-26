#!/usr/bin/env node
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  InMemoryGraphStore,
  SqliteGraphStore,
  redactText,
  renderGraphStoreBenchmarkMarkdown,
  runGraphStoreBenchmark
} from "../dist/index.js";

const options = parseArgs(process.argv.slice(2));

try {
  const store = createStore(options);
  try {
    const report = runGraphStoreBenchmark({
      store,
      storeKind: options.storeKind,
      entityCount: options.entityCount,
      relationCount: options.relationCount,
      pageSize: options.pageSize,
      sampleCount: options.sampleCount,
      namespaceId: options.namespaceId,
      tenantId: options.tenantId,
      generatedAt: options.generatedAt,
      thresholds: options.thresholds
    });

    if (options.reportDir) {
      await writeGraphBenchmarkArtifacts(options.reportDir, report);
    }

    const summary = `${report.parameters.entityCount} entities, ${report.parameters.relationCount} relations, store=${report.storeKind}.`;
    if (report.status === "passed") {
      console.log(`Graph benchmark passed: ${summary}`);
      if (options.reportDir) {
        console.log(`Graph benchmark report written to ${options.reportDir}.`);
      }
    } else {
      console.error(`Graph benchmark failed: ${summary}`);
      for (const violation of report.violations) {
        console.error(`- ${violation.message}`);
      }
      if (options.reportDir) {
        console.error(`Graph benchmark report written to ${options.reportDir}.`);
      }
      process.exitCode = 1;
    }
  } finally {
    store.close?.();
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: redactText(error instanceof Error ? error.message : "Graph benchmark failed.")
      }
    })
  );
  process.exitCode = 1;
}

async function writeGraphBenchmarkArtifacts(reportDir, report) {
  await mkdir(reportDir, { recursive: true });
  await writeJson(path.join(reportDir, "benchmark.json"), report);
  await writeFile(
    path.join(reportDir, "report.md"),
    renderGraphStoreBenchmarkMarkdown(report),
    "utf8"
  );
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(`${filePath}.tmp`, filePath);
}

function createStore(options) {
  switch (options.storeKind) {
    case "memory":
      return new InMemoryGraphStore();
    case "sqlite":
      return new SqliteGraphStore({
        filePath: options.sqlitePath ?? path.join(options.reportDir, "graph.sqlite")
      });
    default:
      throw new Error(`Unsupported graph benchmark store "${options.storeKind}".`);
  }
}

function parseArgs(args) {
  const options = {
    storeKind: "sqlite",
    reportDir: path.join(".rag", "graph-benchmark", "latest"),
    thresholds: {}
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--store":
        options.storeKind = enumValue(requiredValue(args, ++index, arg), arg, ["memory", "sqlite"]);
        break;
      case "--sqlite-path":
        options.sqlitePath = requiredValue(args, ++index, arg);
        break;
      case "--entity-count":
        options.entityCount = integerValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--relation-count":
        options.relationCount = integerValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--page-size":
        options.pageSize = integerValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--sample-count":
        options.sampleCount = integerValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--namespace-id":
        options.namespaceId = requiredValue(args, ++index, arg);
        break;
      case "--tenant-id":
        options.tenantId = requiredValue(args, ++index, arg);
        break;
      case "--generated-at":
        options.generatedAt = requiredValue(args, ++index, arg);
        break;
      case "--report-dir":
        options.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--max-write-ms":
        options.thresholds.maxWriteMs = numericValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--max-entity-lookup-p95-ms":
        options.thresholds.maxEntityLookupP95Ms = numericValue(
          requiredValue(args, ++index, arg),
          arg
        );
        break;
      case "--max-relation-lookup-p95-ms":
        options.thresholds.maxRelationLookupP95Ms = numericValue(
          requiredValue(args, ++index, arg),
          arg
        );
        break;
      case "--max-entity-page-p95-ms":
        options.thresholds.maxEntityPageP95Ms = numericValue(
          requiredValue(args, ++index, arg),
          arg
        );
        break;
      case "--max-relation-page-p95-ms":
        options.thresholds.maxRelationPageP95Ms = numericValue(
          requiredValue(args, ++index, arg),
          arg
        );
        break;
      case "--max-entity-page-total-ms":
        options.thresholds.maxEntityPageTotalMs = numericValue(
          requiredValue(args, ++index, arg),
          arg
        );
        break;
      case "--max-relation-page-total-ms":
        options.thresholds.maxRelationPageTotalMs = numericValue(
          requiredValue(args, ++index, arg),
          arg
        );
        break;
      default:
        throw new Error(`Unknown graph benchmark argument "${arg}".`);
    }
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

function integerValue(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return parsed;
}

function numericValue(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative finite number.`);
  }
  return parsed;
}

function enumValue(value, flag, allowed) {
  if (!allowed.includes(value)) {
    throw new Error(`${flag} must be one of: ${allowed.join(", ")}.`);
  }
  return value;
}
