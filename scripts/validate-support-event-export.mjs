#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildRagSupportEventExportBundle,
  redactText,
  renderRagSupportEventExportMarkdown,
  validateRagSupportEventExportBundle
} from "../dist/index.js";

const options = parseArgs(process.argv.slice(2));

try {
  const events = validateSupportEvents(
    await readRequiredRecords(options.eventsPath, "Support events", "events"),
    options.eventsPath
  );
  const approvalDecisions = validateDecisionRecords(
    await readOptionalRecords(
      options.decisionsPath,
      options.decisionsExplicit,
      "Support approval decisions",
      "decisions"
    ),
    options.decisionsPath
  );
  const previousLedger = await readOptionalJson(
    options.previousEventLedgerPath,
    "Previous support event ledger"
  );
  const bundle = buildRagSupportEventExportBundle({
    ...(options.exportId === undefined ? {} : { exportId: options.exportId }),
    exporterId: options.exporterId,
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
    events,
    approvalDecisions,
    ...(previousLedger === undefined ? {} : { previousLedger }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    metadata: {
      source: "file-export-validator"
    }
  });
  const issues = validateRagSupportEventExportBundle({
    bundle,
    expectations: {
      minEvents: options.minEvents,
      allowApprovalDecisions: options.allowApprovalDecisions,
      allowExportWarnings: options.allowExportWarnings,
      allowLedgerConflicts: options.allowLedgerConflicts,
      ...(options.allowedSourceSystems === undefined
        ? {}
        : { allowedSourceSystems: options.allowedSourceSystems })
    }
  });
  const validation = {
    status: issues.some((issue) => issue.severity === "error") ? "failed" : "passed",
    exporterId: bundle.exporterId,
    exportId: bundle.exportId,
    metrics: bundle.metrics,
    issues,
    evidenceBoundary: bundle.evidenceBoundary
  };

  if (options.reportDir) {
    await writeValidationArtifacts(options.reportDir, bundle, issues, validation);
  }

  console.log(
    `Support event export validation ${validation.status}: ${bundle.metrics.eventCount} event(s), ${issues.length} issue(s).`
  );
  if (options.reportDir) {
    console.log(`Support event export artifacts written to ${options.reportDir}.`);
  }
  if (validation.status === "failed") {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: redactText(
          error instanceof Error ? error.message : "Support event export validation failed."
        )
      }
    })
  );
  process.exitCode = 1;
}

async function writeValidationArtifacts(reportDir, bundle, issues, validation) {
  await mkdir(reportDir, { recursive: true });
  await writeJson(path.join(reportDir, "export.json"), bundle);
  await writeJson(path.join(reportDir, "validation.json"), validation);
  await writeFile(
    path.join(reportDir, "export.md"),
    renderRagSupportEventExportMarkdown(bundle, issues),
    "utf8"
  );
  await writeJsonl(path.join(reportDir, "events.jsonl"), bundle.events);
  await writeJsonl(path.join(reportDir, "decisions.jsonl"), bundle.approvalDecisions);
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(`${filePath}.tmp`, filePath);
}

async function writeJsonl(filePath, records) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  await writeFile(`${filePath}.tmp`, body.length === 0 ? "" : `${body}\n`, "utf8");
  await rename(`${filePath}.tmp`, filePath);
}

async function readRequiredRecords(filePath, label, objectKey) {
  try {
    return parseRecords(await readFile(filePath, "utf8"), filePath, label, objectKey);
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`${label} not found at ${filePath}.`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${label} at ${filePath} is not valid JSON or JSONL.`);
    }
    throw error;
  }
}

async function readOptionalRecords(filePath, explicit, label, objectKey) {
  try {
    return parseRecords(await readFile(filePath, "utf8"), filePath, label, objectKey);
  } catch (error) {
    if (isNotFound(error) && !explicit) {
      return [];
    }
    if (isNotFound(error)) {
      throw new Error(`${label} not found at ${filePath}.`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${label} at ${filePath} is not valid JSON or JSONL.`);
    }
    throw error;
  }
}

async function readOptionalJson(filePath, label) {
  if (filePath === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`${label} not found at ${filePath}.`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${label} at ${filePath} is not valid JSON.`);
    }
    throw error;
  }
}

function parseRecords(body, filePath, label, objectKey) {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return [];
  }

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed;
      }
      if (isRecord(parsed) && Array.isArray(parsed[objectKey])) {
        return parsed[objectKey];
      }
      if (isRecord(parsed)) {
        return [parsed];
      }
      throw new Error(`${label} at ${filePath} must be an array, object, or JSONL records.`);
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }

  return trimmed.split(/\r?\n/u).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new SyntaxError(`Invalid JSONL record ${index + 1}: ${error.message}`);
      }
      throw error;
    }
  });
}

function parseArgs(args) {
  const options = {
    eventsPath: path.join(".rag", "support-knowledge", "events.jsonl"),
    decisionsPath: path.join(".rag", "support-knowledge", "decisions.jsonl"),
    decisionsExplicit: false,
    reportDir: path.join(".rag", "support-export", "latest"),
    exporterId: "file_support_event_export",
    minEvents: 1,
    allowApprovalDecisions: true,
    allowExportWarnings: true,
    allowLedgerConflicts: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--events":
        options.eventsPath = requiredValue(args, ++index, arg);
        break;
      case "--decisions":
        options.decisionsPath = requiredValue(args, ++index, arg);
        options.decisionsExplicit = true;
        break;
      case "--previous-event-ledger":
        options.previousEventLedgerPath = requiredValue(args, ++index, arg);
        break;
      case "--report-dir":
        options.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--generated-at":
        options.generatedAt = requiredValue(args, ++index, arg);
        break;
      case "--export-id":
        options.exportId = requiredValue(args, ++index, arg);
        break;
      case "--exporter-id":
        options.exporterId = requiredValue(args, ++index, arg);
        break;
      case "--cursor":
        options.cursor = requiredValue(args, ++index, arg);
        break;
      case "--min-events":
        options.minEvents = nonNegativeInteger(requiredValue(args, ++index, arg), arg);
        break;
      case "--allow-empty":
        options.minEvents = 0;
        break;
      case "--disallow-approval-decisions":
        options.allowApprovalDecisions = false;
        break;
      case "--disallow-warnings":
        options.allowExportWarnings = false;
        break;
      case "--allow-ledger-conflicts":
        options.allowLedgerConflicts = true;
        break;
      case "--allowed-source-systems":
        options.allowedSourceSystems = requiredValue(args, ++index, arg)
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
        break;
      default:
        throw new Error(`Unknown support event export argument "${arg}".`);
    }
  }

  return options;
}

function validateSupportEvents(records, filePath) {
  return records.map((record, index) => {
    const event = requiredRecordValue(record, `${filePath}[${index}]`);
    if (event.schemaVersion !== 1) {
      throw new Error(`${filePath}[${index}].schemaVersion must be 1.`);
    }
    requiredStringProperty(event, "eventId", `${filePath}[${index}]`);
    requiredStringProperty(event, "idempotencyKey", `${filePath}[${index}]`);
    requiredStringProperty(event, "sourceSystem", `${filePath}[${index}]`);
    requiredStringProperty(event, "eventType", `${filePath}[${index}]`);
    requiredStringProperty(event, "eventVersion", `${filePath}[${index}]`);
    requiredStringProperty(event, "occurredAt", `${filePath}[${index}]`);
    requiredStringProperty(event, "observedAt", `${filePath}[${index}]`);
    requiredStringProperty(event, "summary", `${filePath}[${index}]`);
    requiredStringProperty(event, "payloadHash", `${filePath}[${index}]`);
    requiredRecordValue(
      event.proposedKnowledgeAction,
      `${filePath}[${index}].proposedKnowledgeAction`
    );
    requiredRecordValue(event.metadata, `${filePath}[${index}].metadata`);
    if (!Array.isArray(event.evidenceRefs)) {
      throw new Error(`${filePath}[${index}].evidenceRefs must be an array.`);
    }
    return event;
  });
}

function validateDecisionRecords(records, filePath) {
  return records.map((record, index) => requiredRecordValue(record, `${filePath}[${index}]`));
}

function requiredRecordValue(value, label) {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requiredStringProperty(record, key, label) {
  if (typeof record[key] !== "string" || record[key].trim().length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string.`);
  }
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function nonNegativeInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return parsed;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function isNotFound(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
