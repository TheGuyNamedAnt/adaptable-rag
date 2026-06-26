#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AlertWebhookSink,
  deliverAlerts,
  DryRunAlertDeliverySink,
  FetchProviderTransport,
  redactText
} from "../dist/index.js";

const options = parseArgs(process.argv.slice(2));

try {
  const env = await deliveryEnv(options.envFile);
  const runtimeOptions = optionsFromEnv(options, env);
  const alerts = await readAlerts(runtimeOptions.alertsPath);
  const sinks = buildSinks(runtimeOptions, env);
  const report = await deliverAlerts({
    alerts,
    sinks,
    mode: runtimeOptions.mode,
    ...(runtimeOptions.generatedAt === undefined
      ? {}
      : { generatedAt: runtimeOptions.generatedAt }),
    ...(runtimeOptions.deliveryId === undefined ? {} : { deliveryId: runtimeOptions.deliveryId }),
    requireSink: runtimeOptions.mode === "live"
  });

  if (runtimeOptions.reportDir) {
    await writeDeliveryArtifacts(runtimeOptions.reportDir, report);
  }

  const summary = `${report.alertCount} alert(s), ${report.deliveredAlertCount} delivered, ${report.failedAlertCount} failed, ${report.skippedAlertCount} skipped.`;
  if (report.status === "passed") {
    console.log(`Alert delivery passed: ${summary}`);
    if (runtimeOptions.reportDir) {
      console.log(`Alert delivery report written to ${runtimeOptions.reportDir}.`);
    }
  } else {
    console.error(`Alert delivery failed: ${summary}`);
    for (const error of report.errors) {
      console.error(`- ${error}`);
    }
    if (runtimeOptions.reportDir) {
      console.error(`Alert delivery report written to ${runtimeOptions.reportDir}.`);
    }
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: redactText(error instanceof Error ? error.message : "Alert delivery failed.")
      }
    })
  );
  process.exitCode = 1;
}

async function writeDeliveryArtifacts(reportDir, report) {
  await mkdir(reportDir, { recursive: true });
  await writeJson(path.join(reportDir, "delivery.json"), report);
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(`${filePath}.tmp`, filePath);
}

async function readAlerts(alertsPath) {
  try {
    const alerts = JSON.parse(await readFile(alertsPath, "utf8"));
    if (!Array.isArray(alerts)) {
      throw new Error(`Alert artifact at ${alertsPath} must be a JSON array.`);
    }
    return alerts;
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`Alert artifact not found at ${alertsPath}. Run npm run slo:check first.`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Alert artifact at ${alertsPath} is not valid JSON.`);
    }
    throw error;
  }
}

function buildSinks(options, env) {
  if (!options.webhookUrl) {
    if (options.mode === "live") {
      throw new Error("Live alert delivery requires --webhook-url or RAG_ALERT_WEBHOOK_URL.");
    }
    return [new DryRunAlertDeliverySink({ id: "dry_run" })];
  }

  return [
    new AlertWebhookSink({
      id: options.sinkId,
      endpoint: options.webhookUrl,
      format: options.format,
      transport: new FetchProviderTransport(),
      timeoutMs: options.timeoutMs,
      retryPolicy: {
        maxRetries: options.maxRetries,
        backoffMs: options.backoffMs,
        retryStatusCodes: [408, 429, 500, 502, 503, 504]
      },
      ...(options.webhookTokenEnv === undefined
        ? {}
        : {
            secrets: {
              apiKeyProvider: () =>
                requiredEnv(env, options.webhookTokenEnv, "alert webhook token"),
              secretId: options.webhookTokenEnv
            }
          }),
      ...(options.pagerDutyRoutingKeyEnv === undefined
        ? {}
        : {
            pagerDutyRoutingKeyProvider: () =>
              requiredEnv(env, options.pagerDutyRoutingKeyEnv, "PagerDuty routing key")
          })
    })
  ];
}

async function deliveryEnv(envFile) {
  if (envFile === undefined) {
    return process.env;
  }

  const fileEnv = parseEnvFile(await readFile(envFile, "utf8"));
  return {
    ...fileEnv,
    ...process.env
  };
}

function optionsFromEnv(options, env) {
  return {
    alertsPath:
      options.alertsPath ??
      env.RAG_ALERTS_PATH ??
      path.join(".rag", "slo", "latest", "alerts.json"),
    reportDir:
      options.reportDir ??
      env.RAG_ALERT_DELIVERY_REPORT_DIR ??
      path.join(".rag", "alert-delivery", "latest"),
    mode: options.mode ?? parseMode(env.RAG_ALERT_DELIVERY_MODE ?? "dry_run"),
    sinkId: options.sinkId ?? env.RAG_ALERT_SINK_ID ?? "webhook",
    webhookUrl: options.webhookUrl ?? env.RAG_ALERT_WEBHOOK_URL,
    format: options.format ?? parseFormat(env.RAG_ALERT_WEBHOOK_FORMAT ?? "generic"),
    webhookTokenEnv: options.webhookTokenEnv ?? env.RAG_ALERT_WEBHOOK_TOKEN_ENV,
    pagerDutyRoutingKeyEnv:
      options.pagerDutyRoutingKeyEnv ?? env.RAG_ALERT_PAGERDUTY_ROUTING_KEY_ENV,
    timeoutMs: options.timeoutMs ?? numericEnv(env.RAG_ALERT_WEBHOOK_TIMEOUT_MS, 10000),
    maxRetries: options.maxRetries ?? numericEnv(env.RAG_ALERT_WEBHOOK_MAX_RETRIES, 2),
    backoffMs: options.backoffMs ?? numericEnv(env.RAG_ALERT_WEBHOOK_BACKOFF_MS, 250),
    generatedAt: options.generatedAt,
    deliveryId: options.deliveryId
  };
}

function parseArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--alerts":
        options.alertsPath = requiredValue(args, ++index, arg);
        break;
      case "--report-dir":
        options.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--mode":
        options.mode = parseMode(requiredValue(args, ++index, arg));
        break;
      case "--webhook-url":
        options.webhookUrl = requiredValue(args, ++index, arg);
        break;
      case "--format":
        options.format = parseFormat(requiredValue(args, ++index, arg));
        break;
      case "--webhook-token-env":
        options.webhookTokenEnv = requiredValue(args, ++index, arg);
        break;
      case "--pagerduty-routing-key-env":
        options.pagerDutyRoutingKeyEnv = requiredValue(args, ++index, arg);
        break;
      case "--sink-id":
        options.sinkId = requiredValue(args, ++index, arg);
        break;
      case "--timeout-ms":
        options.timeoutMs = numericValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--max-retries":
        options.maxRetries = numericValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--backoff-ms":
        options.backoffMs = numericValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--generated-at":
        options.generatedAt = requiredValue(args, ++index, arg);
        break;
      case "--delivery-id":
        options.deliveryId = requiredValue(args, ++index, arg);
        break;
      case "--env-file":
        options.envFile = requiredValue(args, ++index, arg);
        break;
      default:
        throw new Error(`Unknown alert delivery argument "${arg}".`);
    }
  }

  return options;
}

function parseMode(value) {
  if (value === "dry-run" || value === "dry_run") {
    return "dry_run";
  }
  if (value === "live") {
    return "live";
  }
  throw new Error("Alert delivery mode must be dry_run or live.");
}

function parseFormat(value) {
  if (value === "generic" || value === "slack" || value === "pagerduty_events_v2") {
    return value;
  }
  throw new Error("Alert webhook format must be generic, slack, or pagerduty_events_v2.");
}

function numericEnv(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }
  return numericValue(value, "env numeric value");
}

function numericValue(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function requiredEnv(env, name, label) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} env ${name} is required.`);
  }
  return value;
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

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function isNotFound(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
