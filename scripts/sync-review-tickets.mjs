#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildReviewTicketPayloads,
  DryRunReviewTicketSyncSink,
  FetchProviderTransport,
  redactText,
  renderReviewTicketSyncMarkdown,
  ReviewTicketWebhookSink,
  syncReviewTickets
} from "../dist/index.js";

const options = parseArgs(process.argv.slice(2));

try {
  const env = await syncEnv(options.envFile);
  const runtimeOptions = optionsFromEnv(options, env);
  const ticketExport =
    runtimeOptions.ticketsPath === undefined
      ? await buildTicketsFromQueueAndLedger(runtimeOptions)
      : {
          tickets: await readRequiredJson(
            runtimeOptions.ticketsPath,
            "Review ticket payloads",
            "Run scripts/export-admin-review-workflow.mjs or npm run review:sync without --tickets."
          )
        };
  const sinks = buildSinks(runtimeOptions, env);
  const report = await syncReviewTickets({
    tickets: ticketExport.tickets,
    sinks,
    mode: runtimeOptions.mode,
    ...(runtimeOptions.generatedAt === undefined
      ? {}
      : { generatedAt: runtimeOptions.generatedAt }),
    ...(runtimeOptions.syncId === undefined ? {} : { syncId: runtimeOptions.syncId }),
    requireSink: runtimeOptions.mode === "live"
  });

  if (runtimeOptions.reportDir) {
    await writeReviewSyncArtifacts(runtimeOptions.reportDir, ticketExport.tickets, report);
  }

  const summary = `${report.ticketCount} ticket payload(s), ${report.syncedTicketCount} synced, ${report.failedTicketCount} failed, ${report.skippedTicketCount} skipped.`;
  if (report.status === "passed") {
    console.log(`Review ticket sync passed: ${summary}`);
    if (runtimeOptions.reportDir) {
      console.log(`Review ticket sync artifacts written to ${runtimeOptions.reportDir}.`);
    }
  } else {
    console.error(`Review ticket sync failed: ${summary}`);
    for (const error of report.errors) {
      console.error(`- ${error}`);
    }
    if (runtimeOptions.reportDir) {
      console.error(`Review ticket sync artifacts written to ${runtimeOptions.reportDir}.`);
    }
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: redactText(error instanceof Error ? error.message : "Review ticket sync failed.")
      }
    })
  );
  process.exitCode = 1;
}

async function writeReviewSyncArtifacts(reportDir, tickets, report) {
  await mkdir(reportDir, { recursive: true });
  await writeJson(path.join(reportDir, "tickets.json"), tickets);
  await writeJson(path.join(reportDir, "sync.json"), report);
  await writeFile(path.join(reportDir, "sync.md"), renderReviewTicketSyncMarkdown(report), "utf8");
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(`${filePath}.tmp`, filePath);
}

async function buildTicketsFromQueueAndLedger(runtimeOptions) {
  const queue = await readRequiredJson(
    runtimeOptions.queuePath,
    "Human review queue",
    "Run npm run review:queue first."
  );
  const ledger = await readOptionalJson(
    runtimeOptions.ledgerPath,
    runtimeOptions.ledgerExplicit,
    "Review decision ledger"
  );
  return buildReviewTicketPayloads({
    queue,
    ...(ledger === undefined ? {} : { ledger }),
    includeResolved: runtimeOptions.includeResolved
  });
}

async function readRequiredJson(filePath, label, hint) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`${label} not found at ${filePath}. ${hint}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${label} at ${filePath} is not valid JSON.`);
    }
    throw error;
  }
}

async function readOptionalJson(filePath, explicit, label) {
  if (filePath === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (isNotFound(error) && !explicit) {
      return undefined;
    }
    if (isNotFound(error)) {
      throw new Error(`${label} not found at ${filePath}.`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${label} at ${filePath} is not valid JSON.`);
    }
    throw error;
  }
}

function buildSinks(options, env) {
  if (!options.webhookUrl) {
    if (options.mode === "live") {
      throw new Error(
        "Live review ticket sync requires --webhook-url or RAG_REVIEW_SYNC_WEBHOOK_URL."
      );
    }
    return [new DryRunReviewTicketSyncSink({ id: "dry_run" })];
  }

  return [
    new ReviewTicketWebhookSink({
      id: options.sinkId,
      endpoint: options.webhookUrl,
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
                requiredEnv(env, options.webhookTokenEnv, "review ticket webhook token"),
              secretId: options.webhookTokenEnv
            }
          })
    })
  ];
}

async function syncEnv(envFile) {
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
    ticketsPath: options.ticketsPath ?? env.RAG_REVIEW_TICKETS_PATH,
    queuePath:
      options.queuePath ??
      env.RAG_REVIEW_QUEUE_PATH ??
      path.join(".rag", "human-review", "latest", "queue.json"),
    ledgerPath:
      options.ledgerPath ??
      env.RAG_REVIEW_LEDGER_PATH ??
      path.join(".rag", "review-ledger", "latest", "ledger.json"),
    ledgerExplicit: options.ledgerExplicit ?? false,
    reportDir:
      options.reportDir ??
      env.RAG_REVIEW_SYNC_REPORT_DIR ??
      path.join(".rag", "review-sync", "latest"),
    mode: options.mode ?? parseMode(env.RAG_REVIEW_SYNC_MODE ?? "dry_run"),
    sinkId: options.sinkId ?? env.RAG_REVIEW_SYNC_SINK_ID ?? "review_ticket_webhook",
    webhookUrl: options.webhookUrl ?? env.RAG_REVIEW_SYNC_WEBHOOK_URL,
    webhookTokenEnv: options.webhookTokenEnv ?? env.RAG_REVIEW_SYNC_WEBHOOK_TOKEN_ENV,
    timeoutMs: options.timeoutMs ?? numericEnv(env.RAG_REVIEW_SYNC_WEBHOOK_TIMEOUT_MS, 10000),
    maxRetries: options.maxRetries ?? numericEnv(env.RAG_REVIEW_SYNC_WEBHOOK_MAX_RETRIES, 2),
    backoffMs: options.backoffMs ?? numericEnv(env.RAG_REVIEW_SYNC_WEBHOOK_BACKOFF_MS, 250),
    includeResolved: options.includeResolved ?? env.RAG_REVIEW_SYNC_INCLUDE_RESOLVED === "true",
    generatedAt: options.generatedAt,
    syncId: options.syncId
  };
}

function parseArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--queue":
        options.queuePath = requiredValue(args, ++index, arg);
        break;
      case "--tickets":
        options.ticketsPath = requiredValue(args, ++index, arg);
        break;
      case "--ledger":
        options.ledgerPath = requiredValue(args, ++index, arg);
        options.ledgerExplicit = true;
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
      case "--webhook-token-env":
        options.webhookTokenEnv = requiredValue(args, ++index, arg);
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
      case "--include-resolved":
        options.includeResolved = true;
        break;
      case "--generated-at":
        options.generatedAt = requiredValue(args, ++index, arg);
        break;
      case "--sync-id":
        options.syncId = requiredValue(args, ++index, arg);
        break;
      case "--env-file":
        options.envFile = requiredValue(args, ++index, arg);
        break;
      default:
        throw new Error(`Unknown review ticket sync argument "${arg}".`);
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
  throw new Error("Review ticket sync mode must be dry_run or live.");
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
