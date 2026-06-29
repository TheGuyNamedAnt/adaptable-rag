#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CompanyDeploymentRegistry,
  assembleCompanyRuntime,
  loadCompanyDeploymentModule,
  redactText,
  runProductionRagCli
} from "../dist/index.js";

const options = parseArgs(process.argv.slice(2));

try {
  const env = await smokeEnv(options);
  const loaded = await loadCompanyDeploymentModule({
    modulePath: options.modulePath,
    cwd: process.cwd(),
    companyExportName: options.exportName,
    ...(options.adapterPackExportNames.length === 0
      ? {}
      : { adapterPackExportNames: options.adapterPackExportNames })
  });
  const registry = new CompanyDeploymentRegistry([
    {
      company: loaded.company,
      adapterPacks: loaded.adapterPacks
    }
  ]);
  const assembly = assembleCompanyRuntime(registry, companyRuntimeLookup(loaded.company, options));
  const requestedAt = options.requestedAt ?? new Date().toISOString();
  const runId = options.runId ?? `company_deployment_smoke_${safeId(requestedAt)}`;
  const tenantId = options.tenantId ?? loaded.company.defaultTenantId;
  const namespaceId = options.namespaceId ?? assembly.resolution.profile.namespaceId;
  const principalNamespaceIds =
    options.principalNamespaceIds.length === 0 ? [namespaceId] : options.principalNamespaceIds;
  const cliEnv = companyCliEnv({
    env,
    loaded,
    options,
    assembly
  });
  const gates = {};
  const failures = [];

  const packContracts = await runCliGate({
    argv: ["validate-config", "--run-pack-contracts", "true"],
    env: cliEnv,
    requestedAt
  });
  gates.packContracts = packContractGate(packContracts);
  collectGateFailure(failures, "pack_contracts", gates.packContracts);

  if (!options.skipSync) {
    const sync = await runCliGate({
      argv: syncArgv({
        options,
        runId,
        tenantId,
        namespaceId,
        principalNamespaceIds,
        requestedAt
      }),
      env: cliEnv,
      requestedAt
    });
    gates.sync = syncGate(sync);
    collectGateFailure(failures, "sync", gates.sync);
  } else {
    gates.sync = {
      status: "skipped",
      reason: "Sync was skipped by --skip-sync."
    };
  }

  const selfTest = await runCliGate({
    argv: [
      "validate-config",
      "--self-test",
      "true",
      "--run-pack-contracts",
      "false",
      ...(options.probeProviders ? ["--probe-providers", "true"] : [])
    ],
    env: cliEnv,
    requestedAt
  });
  gates.selfTest = selfTestGate(selfTest);
  collectGateFailure(failures, "self_test", gates.selfTest);

  const report = {
    status: failures.length === 0 ? "passed" : "failed",
    runId,
    checkedAt: requestedAt,
    companyDeployment: {
      companyId: assembly.resolution.company.companyId,
      useCaseId: assembly.resolution.useCaseId,
      profileId: assembly.resolution.profile.id,
      namespaceId: assembly.resolution.profile.namespaceId,
      moduleUrl: loaded.moduleUrl,
      moduleExportName: loaded.moduleExportName,
      companyExportName: loaded.companyExportName,
      companyExportPath: loaded.companyExportPath,
      ...(loaded.deploymentExportName === undefined
        ? {}
        : { deploymentExportName: loaded.deploymentExportName }),
      adapterPackExports: loaded.adapterPackExportNames,
      ...(loaded.environment === undefined
        ? {}
        : { environment: safeEnvironmentManifest(loaded.environment) }),
      ...(loaded.evals === undefined ? {} : { evals: safeEvalManifest(loaded.evals) }),
      ...(loaded.smoke === undefined ? {} : { smoke: safeSmokeManifest(loaded.smoke) })
    },
    gates,
    failures
  };

  await maybeWriteReport(options.reportDir, report);
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
} catch (error) {
  const requestedAt = options.requestedAt ?? new Date().toISOString();
  const report = {
    status: "failed",
    runId: options.runId ?? `company_deployment_smoke_${safeId(requestedAt)}`,
    checkedAt: requestedAt,
    companyDeployment: {
      modulePath: options.modulePath,
      companyExportName: options.exportName,
      adapterPackExports: options.adapterPackExportNames
    },
    gates: {},
    failures: [
      {
        gate: "startup",
        message: safeText(
          error instanceof Error ? error.message : "Company deployment smoke failed."
        )
      }
    ]
  };

  await maybeWriteReport(options.reportDir, report);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
}

function parseArgs(args) {
  const options = {
    modulePath: "dist/company/examples/acme-support.company.js",
    exportName: "acmeSupportDeployment",
    adapterPackExportNames: [],
    connectorIds: [],
    sourceIds: [],
    principalNamespaceIds: [],
    principalTeamIds: [],
    principalRoles: [],
    principalTags: [],
    syncMode: "delta",
    reportDir: path.join(".rag", "company-smoke", "latest"),
    skipSync: false,
    probeProviders: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--module":
        options.modulePath = requiredValue(args, ++index, arg);
        break;
      case "--export":
        options.exportName = requiredValue(args, ++index, arg);
        break;
      case "--adapter-pack-export":
        options.adapterPackExportNames.push(requiredValue(args, ++index, arg));
        break;
      case "--use-case":
        options.useCaseId = requiredValue(args, ++index, arg);
        break;
      case "--company-id":
        options.companyId = requiredValue(args, ++index, arg);
        break;
      case "--profile-id":
        options.profileId = requiredValue(args, ++index, arg);
        break;
      case "--company-namespace-id":
        options.companyNamespaceId = requiredValue(args, ++index, arg);
        break;
      case "--tenant-id":
        options.tenantId = requiredValue(args, ++index, arg);
        break;
      case "--namespace-id":
        options.namespaceId = requiredValue(args, ++index, arg);
        break;
      case "--sync-mode":
      case "--mode":
        options.syncMode = syncMode(requiredValue(args, ++index, arg), arg);
        break;
      case "--connector-id":
        options.connectorIds.push(requiredValue(args, ++index, arg));
        break;
      case "--source-id":
        options.sourceIds.push(requiredValue(args, ++index, arg));
        break;
      case "--delete-missing":
        options.deleteMissing = booleanValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--overwrite":
        options.overwriteMode = overwriteMode(requiredValue(args, ++index, arg), arg);
        break;
      case "--requested-at":
        options.requestedAt = requiredValue(args, ++index, arg);
        break;
      case "--run-id":
        options.runId = requiredValue(args, ++index, arg);
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
      case "--env-file":
        options.envFile = requiredValue(args, ++index, arg);
        break;
      case "--report-dir":
        options.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--skip-sync":
        options.skipSync = true;
        break;
      case "--probe-providers":
        options.probeProviders = true;
        break;
      default:
        throw new Error(`Unknown company deployment smoke argument "${arg}".`);
    }
  }

  return options;
}

function companyRuntimeLookup(company, options) {
  if (options.companyNamespaceId !== undefined) {
    return { namespaceId: options.companyNamespaceId };
  }
  if (options.profileId !== undefined) {
    return { profileId: options.profileId };
  }

  const companyId = options.companyId ?? company.companyId;
  const useCaseId =
    options.useCaseId ?? (company.useCases.length === 1 ? company.useCases[0]?.id : undefined);
  if (useCaseId === undefined) {
    throw new Error("--use-case is required when the company module has multiple use cases.");
  }

  return {
    companyId,
    useCaseId
  };
}

function companyCliEnv(input) {
  return {
    ...input.env,
    RAG_COMPANY_MODULE_PATH: input.options.modulePath,
    RAG_COMPANY_DEPLOYMENT_EXPORT: input.options.exportName,
    ...(input.loaded.adapterPackExportNames.length === 0
      ? {}
      : { RAG_COMPANY_ADAPTER_PACK_EXPORTS: input.loaded.adapterPackExportNames.join(",") }),
    RAG_COMPANY_ID: input.assembly.resolution.company.companyId,
    RAG_COMPANY_USE_CASE_ID: input.assembly.resolution.useCaseId
  };
}

function syncArgv(input) {
  const argv = [
    "sync",
    "--mode",
    input.options.syncMode,
    "--tenant-id",
    input.tenantId,
    "--namespace-id",
    input.namespaceId,
    "--user-id",
    input.options.principalUserId ?? "company_deployment_smoke",
    "--principal-tenant-id",
    input.options.principalTenantId ?? input.tenantId,
    "--run-id",
    `${input.runId}_sync`,
    "--requested-at",
    input.requestedAt
  ];

  for (const namespaceId of input.principalNamespaceIds) {
    argv.push("--principal-namespace-id", namespaceId);
  }
  for (const teamId of input.options.principalTeamIds) {
    argv.push("--team-id", teamId);
  }
  for (const role of input.options.principalRoles.length === 0
    ? ["company_deployment_smoke"]
    : input.options.principalRoles) {
    argv.push("--role", role);
  }
  for (const tag of input.options.principalTags.length === 0
    ? ["company-smoke"]
    : input.options.principalTags) {
    argv.push("--tag", tag);
  }
  for (const connectorId of input.options.connectorIds) {
    argv.push("--connector-id", connectorId);
  }
  for (const sourceId of input.options.sourceIds) {
    argv.push("--source-id", sourceId);
  }
  if (input.options.deleteMissing !== undefined) {
    argv.push("--delete-missing", String(input.options.deleteMissing));
  }
  if (input.options.overwriteMode !== undefined) {
    argv.push("--overwrite", input.options.overwriteMode);
  }

  return argv;
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

function packContractGate(cli) {
  return {
    status:
      cli.exitCode === 0 && cli.output?.companyDeployment?.packContracts?.status === "passed"
        ? "passed"
        : "failed",
    exitCode: cli.exitCode,
    profileId: cli.output?.profileId,
    namespaceId: cli.output?.namespaceId,
    packContracts: cli.output?.companyDeployment?.packContracts,
    error: cli.output?.error,
    stderr: cli.stderr
  };
}

function syncGate(cli) {
  return {
    status:
      cli.exitCode === 0 && (cli.output?.status === "succeeded" || cli.output?.status === "skipped")
        ? "passed"
        : "failed",
    exitCode: cli.exitCode,
    syncStatus: cli.output?.status,
    mode: cli.output?.mode,
    connectorCount: cli.output?.connectorCount,
    sourceCount: cli.output?.sourceCount,
    metrics: cli.output?.metrics,
    results: cli.output?.results,
    error: cli.output?.error,
    stderr: cli.stderr
  };
}

function selfTestGate(cli) {
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
    error: cli.output?.error,
    stderr: cli.stderr
  };
}

function collectGateFailure(failures, gateName, gate) {
  if (gate.status === "passed" || gate.status === "skipped") {
    return;
  }

  failures.push({
    gate: gateName,
    message: safeText(`${gateName} failed with exit code ${gate.exitCode ?? "unknown"}.`)
  });
}

async function maybeWriteReport(reportDir, report) {
  if (reportDir === undefined) {
    return;
  }

  await writeJson(path.join(reportDir, "smoke.json"), report);
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(`${filePath}.tmp`, filePath);
}

async function smokeEnv(options) {
  const fileEnv =
    options.envFile === undefined ? {} : parseEnvFile(await readFile(options.envFile, "utf8"));
  return {
    RAG_INDEX_KIND: "memory",
    RAG_SOURCE_SYNC_LEDGER_KIND: "memory",
    RAG_VECTOR_KIND: "none",
    RAG_VISUAL_VECTOR_KIND: "none",
    RAG_HTTP_AUTH_MODE: "disabled",
    RAG_HTTP_LOG_MODE: "disabled",
    RAG_HTTP_RATE_LIMIT_MODE: "disabled",
    RAG_APP_EMBEDDING_MODE: "disabled",
    RAG_APP_VISUAL_EMBEDDING_MODE: "disabled",
    RAG_APP_RERANK_MODE: "disabled",
    RAG_APP_GROUNDING_JUDGE_MODE: "disabled",
    RAG_MODEL_PROVIDER: "json-chat",
    RAG_MODEL_MODEL_NAME: "company-smoke-model",
    RAG_MODEL_ENDPOINT: "https://provider.example.test/v1/chat",
    RAG_MODEL_API_KEY: "company-smoke-placeholder",
    ...fileEnv,
    ...process.env
  };
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
        message: "CLI gate returned non-JSON output."
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

function syncMode(value, flag) {
  if (value === "delta" || value === "full") {
    return value;
  }
  throw new Error(`${flag} must be delta or full.`);
}

function overwriteMode(value, flag) {
  if (value === "reject" || value === "replace") {
    return value;
  }
  throw new Error(`${flag} must be reject or replace.`);
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

function safeEnvironmentManifest(environment) {
  return {
    requiredEnv: safeStringArray(environment.requiredEnv),
    optionalEnv: safeStringArray(environment.optionalEnv)
  };
}

function safeEvalManifest(evals) {
  return {
    requiredPaths: safeStringArray(evals.requiredPaths),
    goldenSetPaths: safeStringArray(evals.goldenSetPaths),
    adversarialSetPaths: safeStringArray(evals.adversarialSetPaths)
  };
}

function safeSmokeManifest(smoke) {
  return {
    ...(smoke.validateCommand === undefined
      ? {}
      : { validateCommand: safeText(smoke.validateCommand) }),
    ...(smoke.packContractsCommand === undefined
      ? {}
      : { packContractsCommand: safeText(smoke.packContractsCommand) }),
    ...(smoke.smokeCommand === undefined ? {} : { smokeCommand: safeText(smoke.smokeCommand) }),
    ...(smoke.postgresSmokeCommand === undefined
      ? {}
      : { postgresSmokeCommand: safeText(smoke.postgresSmokeCommand) })
  };
}

function safeStringArray(values) {
  return (values ?? []).map((value) => safeText(value));
}

function safeText(value) {
  return redactText(String(value));
}

function safeId(value) {
  return value.replace(/[^0-9a-z_-]/gi, "");
}
