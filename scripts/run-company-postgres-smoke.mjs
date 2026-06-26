#!/usr/bin/env node
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import pg from "pg";

import { redactText, runProductionRagCli } from "../dist/index.js";

const { Client } = pg;
const options = parseArgs(process.argv.slice(2));

let localProvider;

try {
  const requestedAt = options.requestedAt ?? new Date().toISOString();
  const runId = options.runId ?? `company_postgres_smoke_${safeId(requestedAt)}`;
  const fileEnv =
    options.envFile === undefined ? {} : parseEnvFile(await readFile(options.envFile, "utf8"));
  const baseEnv = {
    ...fileEnv,
    ...process.env
  };
  const database = resolveDatabase(baseEnv, options);
  const schema = safeSqlIdentifier(
    options.schema ?? baseEnv.RAG_POSTGRES_SCHEMA ?? "rag_core",
    "Postgres schema"
  );
  const vectorDimensions = positiveInteger(
    options.vectorDimensions ?? baseEnv.RAG_VECTOR_DIMENSIONS ?? "1536",
    "RAG_VECTOR_DIMENSIONS"
  );

  if (options.localProvider) {
    localProvider = options.dryRun
      ? {
          baseUrl: "http://127.0.0.1:0",
          close: async () => undefined
        }
      : await startLocalProvider({ vectorDimensions });
  }

  const env = postgresSmokeEnv({
    baseEnv,
    database,
    schema,
    vectorDimensions,
    options,
    localProvider
  });
  const gates = {};
  const failures = [];

  if (options.dryRun) {
    gates.migrations = plannedGate("Would apply Postgres core and pgvector migrations.");
    gates.readiness = plannedGate("Would run validate-config with startup self-test.");
    gates.fullSmoke = plannedGate("Would run full company smoke against Postgres.");
    gates.deltaSmoke = plannedGate("Would run delta company smoke against Postgres.");
  } else {
    gates.migrations = await migrationGate({
      options,
      database,
      schema,
      vectorDimensions
    });
    collectGateFailure(failures, "migrations", gates.migrations);

    if (shouldContinue(failures, options)) {
      gates.readiness = await readinessGate({
        env,
        requestedAt,
        probeProviders: options.probeProviders
      });
      collectGateFailure(failures, "readiness", gates.readiness);
    } else {
      gates.readiness = skippedGate("Skipped because migrations failed.");
    }

    if (!options.skipFull && shouldContinue(failures, options)) {
      gates.fullSmoke = await companySmokeGate({
        mode: "full",
        env,
        options,
        requestedAt,
        runId,
        deleteMissing: options.fullDeleteMissing
      });
      collectGateFailure(failures, "full_smoke", gates.fullSmoke);
    } else {
      gates.fullSmoke = skippedGate(
        options.skipFull ? "Skipped by --skip-full." : "Skipped because readiness failed."
      );
    }

    if (!options.skipDelta && shouldContinue(failures, options)) {
      gates.deltaSmoke = await companySmokeGate({
        mode: "delta",
        env,
        options,
        requestedAt,
        runId
      });
      collectGateFailure(failures, "delta_smoke", gates.deltaSmoke);
    } else {
      gates.deltaSmoke = skippedGate(
        options.skipDelta ? "Skipped by --skip-delta." : "Skipped because a prior gate failed."
      );
    }
  }

  const report = {
    status: options.dryRun ? "planned" : failures.length === 0 ? "passed" : "failed",
    runId,
    checkedAt: requestedAt,
    postgres: {
      schema,
      vectorDimensions,
      databaseUrlEnv: database.envName,
      storage: {
        index: "postgres",
        vector: "postgres",
        sourceSyncLedger: "postgres"
      },
      migrations: {
        apply: !options.skipMigrations,
        resetSchema: options.resetSchema,
        migrationDir: options.migrationDir
      },
      localProvider: options.localProvider
    },
    companyDeployment: {
      modulePath: options.modulePath,
      companyExportName: options.exportName,
      adapterPackExports: options.adapterPackExportNames,
      useCaseId: options.useCaseId,
      tenantId: options.tenantId,
      namespaceId: options.namespaceId,
      sourceIds: options.sourceIds
    },
    gates,
    failures
  };

  await writeReport(options.reportDir, report);
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "failed") {
    process.exitCode = 1;
  }
} catch (error) {
  const requestedAt = options.requestedAt ?? new Date().toISOString();
  const report = {
    status: "failed",
    runId: options.runId ?? `company_postgres_smoke_${safeId(requestedAt)}`,
    checkedAt: requestedAt,
    postgres: {
      schema: options.schema,
      vectorDimensions: options.vectorDimensions,
      databaseUrlEnv: options.databaseUrlEnv
    },
    gates: {},
    failures: [
      {
        gate: "startup",
        message: safeText(error instanceof Error ? error.message : "Postgres company smoke failed.")
      }
    ]
  };

  await writeReport(options.reportDir, report);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await localProvider?.close();
}

function parseArgs(args) {
  const options = {
    modulePath: "dist/company/examples/acme-support.company.js",
    exportName: "acmeSupportCompanyProfile",
    adapterPackExportNames: ["acmeSupportAdapterPack"],
    useCaseId: "support",
    tenantId: "tenant_acme",
    namespaceId: "acme-support",
    sourceIds: ["support_docs"],
    principalNamespaceIds: [],
    principalTeamIds: [],
    principalRoles: ["support"],
    principalTags: ["trusted"],
    principalUserId: "postgres_company_smoke",
    reportDir: path.join(".rag", "company-postgres-smoke", "latest"),
    migrationDir: path.join("deploy", "postgres"),
    fullDeleteMissing: false,
    skipMigrations: false,
    resetSchema: false,
    skipFull: false,
    skipDelta: false,
    continueOnFailure: false,
    dryRun: false,
    localProvider: false,
    probeProviders: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--env-file":
        options.envFile = requiredValue(args, ++index, arg);
        break;
      case "--database-url":
        options.databaseUrl = requiredValue(args, ++index, arg);
        break;
      case "--database-url-env":
        options.databaseUrlEnv = requiredValue(args, ++index, arg);
        break;
      case "--schema":
        options.schema = requiredValue(args, ++index, arg);
        break;
      case "--vector-dimensions":
        options.vectorDimensions = requiredValue(args, ++index, arg);
        break;
      case "--migration-dir":
        options.migrationDir = requiredValue(args, ++index, arg);
        break;
      case "--module":
        options.modulePath = requiredValue(args, ++index, arg);
        break;
      case "--export":
        options.exportName = requiredValue(args, ++index, arg);
        break;
      case "--adapter-pack-export":
        options.adapterPackExportNames.push(requiredValue(args, ++index, arg));
        break;
      case "--clear-adapter-pack-exports":
        options.adapterPackExportNames = [];
        break;
      case "--use-case":
        options.useCaseId = requiredValue(args, ++index, arg);
        break;
      case "--tenant-id":
        options.tenantId = requiredValue(args, ++index, arg);
        break;
      case "--namespace-id":
        options.namespaceId = requiredValue(args, ++index, arg);
        break;
      case "--source-id":
        options.sourceIds.push(requiredValue(args, ++index, arg));
        break;
      case "--clear-source-ids":
        options.sourceIds = [];
        break;
      case "--principal-user-id":
        options.principalUserId = requiredValue(args, ++index, arg);
        break;
      case "--principal-tenant-id":
        options.principalTenantId = requiredValue(args, ++index, arg);
        break;
      case "--principal-namespace-id":
        options.principalNamespaceIds.push(requiredValue(args, ++index, arg));
        break;
      case "--principal-team-id":
        options.principalTeamIds.push(requiredValue(args, ++index, arg));
        break;
      case "--principal-role":
        options.principalRoles.push(requiredValue(args, ++index, arg));
        break;
      case "--principal-tag":
        options.principalTags.push(requiredValue(args, ++index, arg));
        break;
      case "--report-dir":
        options.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--requested-at":
        options.requestedAt = requiredValue(args, ++index, arg);
        break;
      case "--run-id":
        options.runId = requiredValue(args, ++index, arg);
        break;
      case "--full-delete-missing":
        options.fullDeleteMissing = booleanValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--skip-migrations":
        options.skipMigrations = true;
        break;
      case "--reset-schema":
        options.resetSchema = true;
        break;
      case "--skip-full":
        options.skipFull = true;
        break;
      case "--skip-delta":
        options.skipDelta = true;
        break;
      case "--continue-on-failure":
        options.continueOnFailure = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--local-provider":
        options.localProvider = true;
        break;
      case "--probe-providers":
        options.probeProviders = true;
        break;
      default:
        throw new Error(`Unknown Postgres company smoke argument "${arg}".`);
    }
  }

  return options;
}

function resolveDatabase(env, currentOptions) {
  const envName = currentOptions.databaseUrlEnv ?? env.RAG_POSTGRES_URL_ENV ?? "RAG_DATABASE_URL";
  const databaseUrl = currentOptions.databaseUrl ?? env[envName] ?? env.RAG_POSTGRES_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error(
      `Postgres company smoke requires --database-url, ${envName}, or RAG_POSTGRES_URL.`
    );
  }

  return {
    envName,
    url: databaseUrl
  };
}

function postgresSmokeEnv(input) {
  const env = {
    ...input.baseEnv,
    RAG_INDEX_KIND: "postgres",
    RAG_VECTOR_KIND: "postgres",
    RAG_SOURCE_SYNC_LEDGER_KIND: "postgres",
    RAG_POSTGRES_URL_ENV: input.database.envName,
    [input.database.envName]: input.database.url,
    RAG_POSTGRES_SCHEMA: input.schema,
    RAG_VECTOR_DIMENSIONS: String(input.vectorDimensions),
    RAG_VISUAL_VECTOR_KIND: input.baseEnv.RAG_VISUAL_VECTOR_KIND ?? "none",
    RAG_COMPANY_MODULE_PATH: input.options.modulePath,
    RAG_COMPANY_PROFILE_EXPORT: input.options.exportName,
    RAG_COMPANY_ADAPTER_PACK_EXPORTS: input.options.adapterPackExportNames.join(","),
    RAG_COMPANY_USE_CASE_ID: input.options.useCaseId,
    RAG_COMPANY_PACK_CONTRACT_MODE: "required"
  };

  if (input.localProvider !== undefined) {
    Object.assign(env, {
      RAG_MODEL_PROVIDER: "json-chat",
      RAG_MODEL_MODEL_NAME: "postgres-smoke-json-chat",
      RAG_MODEL_ENDPOINT: `${input.localProvider.baseUrl}/chat`,
      RAG_MODEL_API_KEY: "postgres-smoke-local-provider",
      RAG_APP_EMBEDDING_MODE: "required",
      RAG_EMBEDDING_PROVIDER: "indexed-embedding",
      RAG_EMBEDDING_MODEL_NAME: "postgres-smoke-indexed-embedding",
      RAG_EMBEDDING_ENDPOINT: `${input.localProvider.baseUrl}/embeddings`,
      RAG_EMBEDDING_API_KEY: "postgres-smoke-local-provider",
      RAG_EMBEDDING_DIMENSIONS: String(input.vectorDimensions),
      RAG_APP_GROUNDING_JUDGE_MODE: "required",
      RAG_GROUNDING_JUDGE_PROVIDER: "json-grounding-judge",
      RAG_GROUNDING_JUDGE_MODEL_NAME: "postgres-smoke-grounding-judge",
      RAG_GROUNDING_JUDGE_ENDPOINT: `${input.localProvider.baseUrl}/judge`,
      RAG_GROUNDING_JUDGE_API_KEY: "postgres-smoke-local-provider",
      RAG_APP_RERANK_MODE: "disabled",
      RAG_APP_VISUAL_EMBEDDING_MODE: "disabled"
    });
  }

  return env;
}

async function migrationGate(input) {
  if (input.options.skipMigrations) {
    return skippedGate("Skipped by --skip-migrations.");
  }

  const client = new Client({ connectionString: input.database.url });
  const migrationFiles = ["001_core_storage.sql", "002_vector_hnsw_1536.sql"];
  try {
    await client.connect();
    if (input.options.resetSchema) {
      await client.query(`drop schema if exists ${quoteIdent(input.schema)} cascade`);
    }

    for (const fileName of migrationFiles) {
      const rawSql = await readFile(path.join(input.options.migrationDir, fileName), "utf8");
      await client.query(
        migrationSql({
          sql: rawSql,
          schema: input.schema,
          vectorDimensions: input.vectorDimensions
        })
      );
    }

    return {
      status: "passed",
      schema: input.schema,
      vectorDimensions: input.vectorDimensions,
      appliedFiles: migrationFiles
    };
  } catch (error) {
    return {
      status: "failed",
      schema: input.schema,
      vectorDimensions: input.vectorDimensions,
      appliedFiles: [],
      error: safeText(error instanceof Error ? error.message : "Postgres migrations failed.")
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function readinessGate(input) {
  const cli = await runCliGate({
    argv: [
      "validate-config",
      "--self-test",
      "true",
      "--run-pack-contracts",
      "true",
      ...(input.probeProviders ? ["--probe-providers", "true"] : [])
    ],
    env: input.env,
    requestedAt: input.requestedAt
  });

  return {
    status: cli.exitCode === 0 && cli.output?.status === "passed" ? "passed" : "failed",
    exitCode: cli.exitCode,
    selfTestStatus: cli.output?.status,
    profileId: cli.output?.profileId,
    namespaceId: cli.output?.namespaceId,
    retrievalMode: cli.output?.retrievalMode,
    probeProviders: cli.output?.probeProviders,
    checkCount: cli.output?.checkCount,
    failedCount: cli.output?.failedCount,
    skippedCount: cli.output?.skippedCount,
    failedChecks: (cli.output?.checks ?? [])
      .filter((check) => check.status === "failed")
      .map((check) => ({
        id: check.id,
        kind: check.kind,
        message: safeText(check.message)
      })),
    stderr: cli.stderr,
    error: cli.output?.error
  };
}

async function runCliGate(input) {
  const stdout = [];
  const stderr = [];
  const exitCode = await runProductionRagCli({
    argv: input.argv,
    env: input.env,
    cwd: process.cwd(),
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    now: () => input.requestedAt
  });

  return {
    exitCode,
    output: parseJson(stdout.join("\n")),
    stderr: stderr.map(safeText)
  };
}

async function companySmokeGate(input) {
  const reportDir = path.join(input.options.reportDir, input.mode);
  const argv = [
    "scripts/run-company-deployment-smoke.mjs",
    "--module",
    input.options.modulePath,
    "--export",
    input.options.exportName,
    ...input.options.adapterPackExportNames.flatMap((exportName) => [
      "--adapter-pack-export",
      exportName
    ]),
    "--use-case",
    input.options.useCaseId,
    "--sync-mode",
    input.mode,
    "--tenant-id",
    input.options.tenantId,
    "--namespace-id",
    input.options.namespaceId,
    "--principal-user-id",
    input.options.principalUserId,
    "--principal-tenant-id",
    input.options.principalTenantId ?? input.options.tenantId,
    "--requested-at",
    input.requestedAt,
    "--run-id",
    `${input.runId}_${input.mode}`,
    "--report-dir",
    reportDir,
    ...(input.options.probeProviders ? ["--probe-providers"] : [])
  ];

  if (input.deleteMissing !== undefined) {
    argv.push("--delete-missing", String(input.deleteMissing));
  }

  for (const sourceId of input.options.sourceIds) {
    argv.push("--source-id", sourceId);
  }
  const namespaceIds =
    input.options.principalNamespaceIds.length === 0
      ? [input.options.namespaceId]
      : input.options.principalNamespaceIds;
  for (const namespaceId of namespaceIds) {
    argv.push("--principal-namespace-id", namespaceId);
  }
  for (const teamId of input.options.principalTeamIds) {
    argv.push("--principal-team-id", teamId);
  }
  for (const role of input.options.principalRoles) {
    argv.push("--principal-role", role);
  }
  for (const tag of input.options.principalTags) {
    argv.push("--principal-tag", tag);
  }

  const child = await runNodeJson({
    argv,
    env: input.env
  });

  return {
    status: child.exitCode === 0 && child.output?.status === "passed" ? "passed" : "failed",
    exitCode: child.exitCode,
    mode: input.mode,
    reportDir,
    smokeStatus: child.output?.status,
    metrics: child.output?.gates?.sync?.metrics,
    packContracts: child.output?.gates?.packContracts?.status,
    sync: child.output?.gates?.sync?.status,
    selfTest: child.output?.gates?.selfTest?.status,
    failures: child.output?.failures,
    stderr: child.stderr,
    error: child.output?.error
  };
}

function runNodeJson(input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, input.argv, {
      cwd: process.cwd(),
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        output: parseJson(stdout.join("")),
        stderr: stderr.join("").split(/\r?\n/u).filter(Boolean).map(safeText)
      });
    });
  });
}

async function startLocalProvider(input) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = parseJson(Buffer.concat(chunks).toString("utf8")) ?? {};
    const url = request.url ?? "/";
    response.setHeader("content-type", "application/json");

    if (url.includes("embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [];
      response.end(
        JSON.stringify({
          data: inputs.map((text, index) => ({
            index,
            embedding: deterministicVector(String(text), input.vectorDimensions)
          }))
        })
      );
      return;
    }

    if (url.includes("judge")) {
      response.end(JSON.stringify({ verdict: "grounded", issues: [] }));
      return;
    }

    response.end(
      JSON.stringify({
        output_text: JSON.stringify({
          answer: "Startup self-test evidence is present.",
          citationChunkIds: ["startup_probe_chunk"],
          evidenceSummary: "Startup self-test evidence is present.",
          confidence: "high",
          actions: []
        })
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Local provider did not bind to a TCP port.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function deterministicVector(text, dimensions) {
  const vector = Array.from({ length: dimensions }, (_, index) => {
    const charCode = text.charCodeAt(index % Math.max(1, text.length)) || 17;
    return ((charCode + index * 31) % 997) / 997;
  });
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

function migrationSql(input) {
  const schemaSql = safeSqlIdentifier(input.schema, "Postgres schema");
  return input.sql
    .replace(/\brag_core\b/gu, schemaSql)
    .replace(/\b1536\b/gu, String(input.vectorDimensions));
}

function plannedGate(message) {
  return {
    status: "planned",
    message
  };
}

function skippedGate(reason) {
  return {
    status: "skipped",
    reason
  };
}

function collectGateFailure(failures, gateName, gate) {
  if (gate.status === "passed" || gate.status === "skipped" || gate.status === "planned") {
    return;
  }

  failures.push({
    gate: gateName,
    message: safeText(`${gateName} failed.`)
  });
}

function shouldContinue(failures, currentOptions) {
  return failures.length === 0 || currentOptions.continueOnFailure;
}

async function writeReport(reportDir, report) {
  await writeJson(path.join(reportDir, "postgres-company-smoke.json"), sanitize(report));
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(`${filePath}.tmp`, filePath);
}

function sanitize(value) {
  return JSON.parse(safeText(JSON.stringify(value)));
}

function parseEnvFile(body) {
  const values = {};
  for (const [index, rawLine] of body.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) {
      throw new Error(`Invalid env-file line ${index + 1}.`);
    }

    const name = normalized.slice(0, equalsIndex).trim();
    const rawValue = normalized.slice(equalsIndex + 1).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) {
      throw new Error(`Invalid env-file variable name "${name}" on line ${index + 1}.`);
    }

    values[name] = stripEnvQuotes(rawValue);
  }
  return values;
}

function stripEnvQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function parseJson(body) {
  if (!body.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(body);
  } catch {
    return {
      error: {
        name: "JsonParseError",
        message: "Command returned non-JSON output."
      }
    };
  }
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

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function safeSqlIdentifier(value, label) {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(value)) {
    throw new Error(`${label} must be a safe SQL identifier.`);
  }
  return value;
}

function quoteIdent(value) {
  return `"${safeSqlIdentifier(value, "Postgres identifier").replace(/"/gu, '""')}"`;
}

function safeText(value) {
  return redactText(String(value));
}

function safeId(value) {
  return value.replace(/[^0-9a-z_-]/gi, "");
}
