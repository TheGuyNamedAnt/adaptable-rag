#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createProductionRagApp,
  loadProductionRagAppConfigFromEnv,
  PROVIDER_SMOKE_PROVIDERS,
  redactText,
  renderProviderSmokeHtmlReport,
  runProviderSmokePack
} from "../dist/index.js";

const options = parseArgs(process.argv.slice(2));

try {
  const env = await smokeEnv(options.envFile);
  const envRequiredProviders = parseOptionalRequiredProviders(env.RAG_SMOKE_REQUIRED_PROVIDERS);
  const requiredProviders = options.requiredProviders ?? envRequiredProviders;
  const app = createProductionRagApp({
    config: loadProductionRagAppConfigFromEnv({
      env,
      cwd: process.cwd()
    }),
    env
  });
  const report = await runProviderSmokePack({
    app,
    ...(options.requestedAt === undefined ? {} : { requestedAt: options.requestedAt }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(requiredProviders === undefined ? {} : { requiredProviders })
  });

  if (options.reportDir) {
    await writeSmokeArtifacts(options.reportDir, report);
  }

  if (report.status === "passed") {
    console.log(
      `Provider smoke passed: ${report.summary.passedRequiredProviderCount}/${report.summary.requiredProviderCount} required providers passed.`
    );
    console.log(
      `Provider probe checks: ${report.summary.providerProbeCheckCount} total, ${report.summary.skippedProviderProbeCheckCount} skipped.`
    );
    if (options.reportDir) {
      console.log(`Provider smoke report written to ${options.reportDir}.`);
    }
  } else {
    console.error(`Provider smoke failed: ${report.failures.length} failure(s).`);
    for (const failure of report.failures) {
      console.error(`- ${failure}`);
    }
    if (options.reportDir) {
      console.error(`Provider smoke report written to ${options.reportDir}.`);
    }
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: redactText(error instanceof Error ? error.message : "Provider smoke failed.")
      }
    })
  );
  process.exitCode = 1;
}

async function writeSmokeArtifacts(reportDir, report) {
  await mkdir(reportDir, { recursive: true });
  await writeJson(path.join(reportDir, "smoke.json"), report);
  await writeJson(path.join(reportDir, "self-test.json"), report.selfTest);
  await writeFile(
    path.join(reportDir, "report.html"),
    renderProviderSmokeHtmlReport(report),
    "utf8"
  );
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(`${filePath}.tmp`, filePath);
}

async function smokeEnv(envFile) {
  if (envFile === undefined) {
    return process.env;
  }

  const fileEnv = parseEnvFile(await readFile(envFile, "utf8"));
  return {
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

function parseArgs(args) {
  const options = {};
  const requiredProviders = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--report-dir":
        options.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--env-file":
        options.envFile = requiredValue(args, ++index, arg);
        break;
      case "--requested-at":
        options.requestedAt = requiredValue(args, ++index, arg);
        break;
      case "--run-id":
        options.runId = requiredValue(args, ++index, arg);
        break;
      case "--required-provider":
      case "--required-providers":
        requiredProviders.push(...parseRequiredProviders(requiredValue(args, ++index, arg)));
        break;
      default:
        throw new Error(`Unknown provider smoke argument "${arg}".`);
    }
  }

  if (requiredProviders.length > 0) {
    options.requiredProviders = PROVIDER_SMOKE_PROVIDERS.filter((provider) =>
      requiredProviders.includes(provider)
    );
  }

  return options;
}

function parseRequiredProviders(value) {
  const providers = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const invalid = providers.filter((provider) => !PROVIDER_SMOKE_PROVIDERS.includes(provider));

  if (invalid.length > 0) {
    throw new Error(
      `Unknown required provider "${invalid[0]}". Expected one of: ${PROVIDER_SMOKE_PROVIDERS.join(", ")}.`
    );
  }

  return providers;
}

function parseOptionalRequiredProviders(value) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  return PROVIDER_SMOKE_PROVIDERS.filter((provider) =>
    parseRequiredProviders(value).includes(provider)
  );
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}
