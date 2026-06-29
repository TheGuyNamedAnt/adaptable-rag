#!/usr/bin/env node
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";

const options = parseArgs(process.argv.slice(2));

try {
  const artifact = await fetchAdminReviewExport(options);
  await writeArtifacts(options.reportDir, artifact);
  console.log(
    `Admin review workflow export built: ${artifact.summary.exportedDecisionCount} decision(s), ${artifact.summary.exportedTicketCount} ticket payload(s).`
  );
  console.log(`Admin review workflow artifacts written to ${options.reportDir}.`);
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: redactText(
          error instanceof Error ? error.message : "Admin review workflow export failed."
        )
      }
    })
  );
  process.exitCode = 1;
}

async function fetchAdminReviewExport(options) {
  const url = new URL("/api/rag/review/export", options.adminUrl);
  if (options.status) url.searchParams.set("status", options.status);
  if (options.owner) url.searchParams.set("owner", options.owner);
  if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
  if (options.offset !== undefined) url.searchParams.set("offset", String(options.offset));

  const headers = {};
  if (options.authTokenEnv) {
    const token = process.env[options.authTokenEnv];
    if (!token) {
      throw new Error(`Admin auth token env ${options.authTokenEnv} is required.`);
    }
    headers.authorization = `Bearer ${token}`;
  }

  const response = await globalThis.fetch(url, { headers });
  const body = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`Admin review export returned non-JSON response: ${body.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(parsed.error ?? `Admin review export failed with HTTP ${response.status}.`);
  }
  return parsed;
}

async function writeArtifacts(reportDir, artifact) {
  await mkdir(reportDir, { recursive: true });
  await writeJson(path.join(reportDir, "export.json"), artifact);
  await writeJson(path.join(reportDir, "tickets.json"), artifact.tickets ?? []);
  await writeFile(path.join(reportDir, "export.md.tmp"), renderMarkdown(artifact), "utf8");
  await rename(path.join(reportDir, "export.md.tmp"), path.join(reportDir, "export.md"));
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(`${filePath}.tmp`, filePath);
}

function renderMarkdown(artifact) {
  return [
    "# Admin Review Workflow Export",
    "",
    `- Export ID: \`${md(artifact.exportId)}\``,
    `- Generated: \`${md(artifact.generatedAt)}\``,
    `- Status: **${md(artifact.status)}**`,
    `- Decisions: ${artifact.summary?.exportedDecisionCount ?? 0}`,
    `- Tickets: ${artifact.summary?.exportedTicketCount ?? 0}`,
    `- Queue snapshots: ${artifact.summary?.queueSnapshotCount ?? 0}`,
    `- Missing queue snapshots: ${artifact.summary?.missingQueueSnapshotCount ?? 0}`,
    "",
    "## Tickets",
    "",
    ticketTable(artifact.tickets ?? []),
    "",
    "## Evidence Boundary",
    "",
    (artifact.evidenceBoundary ?? []).map((entry) => `- ${md(entry)}`).join("\n"),
    ""
  ].join("\n");
}

function ticketTable(tickets) {
  if (tickets.length === 0) return "No admin review ticket payloads.";
  return [
    "| Payload | Operation | Status | Dedupe key |",
    "| --- | --- | --- | --- |",
    ...tickets.map(
      (ticket) =>
        `| \`${md(ticket.payloadId)}\` | ${md(ticket.operation)} | ${md(ticket.status)} | \`${md(ticket.dedupeKey)}\` |`
    )
  ].join("\n");
}

function parseArgs(args) {
  const options = {
    adminUrl: process.env.RAG_ADMIN_URL ?? "http://127.0.0.1:8788",
    reportDir: path.join(".rag", "admin-review-export", "latest"),
    authTokenEnv: process.env.RAG_ADMIN_EXPORT_AUTH_TOKEN_ENV
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--admin-url":
        options.adminUrl = requiredValue(args, ++index, arg);
        break;
      case "--report-dir":
        options.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--status":
        options.status = parseStatus(requiredValue(args, ++index, arg));
        break;
      case "--owner":
        options.owner = requiredValue(args, ++index, arg);
        break;
      case "--limit":
        options.limit = positiveInteger(requiredValue(args, ++index, arg), arg);
        break;
      case "--offset":
        options.offset = nonNegativeInteger(requiredValue(args, ++index, arg), arg);
        break;
      case "--auth-token-env":
        options.authTokenEnv = requiredValue(args, ++index, arg);
        break;
      default:
        throw new Error(`Unknown admin review export argument "${arg}".`);
    }
  }

  return options;
}

function parseStatus(value) {
  if (
    value === "open" ||
    value === "acknowledged" ||
    value === "in_review" ||
    value === "resolved" ||
    value === "dismissed"
  ) {
    return value;
  }
  throw new Error("--status must be one of open, acknowledged, in_review, resolved, or dismissed.");
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function md(value) {
  return redactText(String(value ?? ""))
    .replace(/\|/gu, "\\|")
    .replace(/`/gu, "\\`");
}

function redactText(value) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|secret|password)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgres://[redacted]@")
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, "sk-[redacted]");
}
