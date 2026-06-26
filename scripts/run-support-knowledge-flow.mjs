#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  redactText,
  renderRagSupportKnowledgeApprovalLedgerMarkdown,
  renderRagSupportKnowledgeCandidateQueueMarkdown,
  renderRagSupportKnowledgeFlowMarkdown,
  runRagSupportKnowledgeFlow
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
      "Support knowledge approval decisions",
      "decisions"
    ),
    options.decisionsPath
  );
  const previousEventLedger = await readOptionalJson(
    options.previousEventLedgerPath,
    "Previous support event ledger"
  );
  const previousCandidateQueue = await readOptionalJson(
    options.previousCandidateQueuePath,
    "Previous support knowledge candidate queue"
  );
  const result = runRagSupportKnowledgeFlow({
    ...(options.flowId === undefined ? {} : { flowId: options.flowId }),
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
    events,
    ...(previousEventLedger === undefined ? {} : { previousEventLedger }),
    ...(previousCandidateQueue === undefined ? {} : { previousCandidateQueue }),
    approvalDecisions,
    ...(options.defaultReviewerDestination === undefined
      ? {}
      : { defaultReviewerDestination: options.defaultReviewerDestination }),
    ...(options.autoApproveSafeTicketUpdates
      ? {
          autoApprovalPolicy: {
            enabled: true,
            reviewerIdHash: options.autoApprovalReviewerHash,
            ...(options.autoApprovalMaxDecisions === undefined
              ? {}
              : { maxDecisions: options.autoApprovalMaxDecisions })
          }
        }
      : {}),
    approvedKnowledgeSourceConfig: {
      enabled: options.sourceConfigEnabled,
      approvalLedgerPath: options.approvalLedgerPath,
      pathPrefix: options.sourcePathPrefix,
      ...(options.originUriBase === undefined ? {} : { originUriBase: options.originUriBase }),
      ...(options.owner === undefined ? {} : { owner: options.owner }),
      ...(options.accessScope === undefined ? {} : { accessScope: options.accessScope }),
      ...(options.capturedAt === undefined ? {} : { capturedAt: options.capturedAt }),
      ...(options.maxArtifacts === undefined ? {} : { maxArtifacts: options.maxArtifacts }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata })
    }
  });

  if (options.reportDir) {
    await writeSupportKnowledgeFlowArtifacts(options.reportDir, result);
  }

  console.log(
    `Support knowledge flow built: ${result.status}, ${result.metrics.approvedArtifactCount} approved artifact(s), ${result.metrics.autoApprovalDecisionCount} auto decision(s), ${result.metrics.approvedKnowledgeSourceCount} approved source config(s), answerable now: no.`
  );
  if (options.reportDir) {
    console.log(`Support knowledge flow artifacts written to ${options.reportDir}.`);
    console.log(
      `Next gate: point RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH at ${path.join(
        options.reportDir,
        "approved-knowledge.sources.json"
      )} and run production ingestion.`
    );
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: redactText(
          error instanceof Error ? error.message : "Support knowledge flow build failed."
        )
      }
    })
  );
  process.exitCode = 1;
}

async function writeSupportKnowledgeFlowArtifacts(reportDir, result) {
  await mkdir(reportDir, { recursive: true });
  await writeJson(path.join(reportDir, "flow.json"), result);
  await writeFile(
    path.join(reportDir, "flow.md"),
    renderRagSupportKnowledgeFlowMarkdown(result),
    "utf8"
  );
  await writeJson(path.join(reportDir, "event-ledger.json"), result.eventLedger);
  await writeJson(path.join(reportDir, "candidate-queue.json"), result.candidateQueue);
  await writeFile(
    path.join(reportDir, "candidate-queue.md"),
    renderRagSupportKnowledgeCandidateQueueMarkdown(result.candidateQueue),
    "utf8"
  );
  await writeJson(path.join(reportDir, "approval-ledger.json"), result.approvalLedger);
  await writeFile(
    path.join(reportDir, "approval-ledger.md"),
    renderRagSupportKnowledgeApprovalLedgerMarkdown(result.approvalLedger),
    "utf8"
  );
  await writeJson(
    path.join(reportDir, "approved-knowledge.sources.json"),
    result.approvedKnowledgeSourcesConfig
  );
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
    reportDir: path.join(".rag", "support-knowledge", "latest"),
    sourceConfigEnabled: true,
    approvalLedgerPath: "approval-ledger.json",
    sourcePathPrefix: "approved-knowledge",
    autoApproveSafeTicketUpdates: false,
    autoApprovalReviewerHash: "auto_support_ticket_sync"
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
      case "--previous-candidate-queue":
        options.previousCandidateQueuePath = requiredValue(args, ++index, arg);
        break;
      case "--report-dir":
        options.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--generated-at":
        options.generatedAt = requiredValue(args, ++index, arg);
        break;
      case "--flow-id":
        options.flowId = requiredValue(args, ++index, arg);
        break;
      case "--default-reviewer-destination":
        options.defaultReviewerDestination = requiredValue(args, ++index, arg);
        break;
      case "--auto-approve-safe-ticket-updates":
        options.autoApproveSafeTicketUpdates = true;
        break;
      case "--auto-approval-reviewer-hash":
        options.autoApprovalReviewerHash = requiredValue(args, ++index, arg);
        break;
      case "--auto-approval-max-decisions":
        options.autoApprovalMaxDecisions = positiveInteger(requiredValue(args, ++index, arg), arg);
        break;
      case "--approval-ledger-path":
        options.approvalLedgerPath = requiredValue(args, ++index, arg);
        break;
      case "--source-path-prefix":
        options.sourcePathPrefix = requiredValue(args, ++index, arg);
        break;
      case "--origin-uri-base":
        options.originUriBase = requiredValue(args, ++index, arg);
        break;
      case "--owner":
        options.owner = requiredValue(args, ++index, arg);
        break;
      case "--captured-at":
        options.capturedAt = requiredValue(args, ++index, arg);
        break;
      case "--max-artifacts":
        options.maxArtifacts = positiveInteger(requiredValue(args, ++index, arg), arg);
        break;
      case "--access-scope-json":
        options.accessScope = parseJsonRecord(requiredValue(args, ++index, arg), arg);
        break;
      case "--metadata-json":
        options.metadata = parseMetadata(requiredValue(args, ++index, arg), arg);
        break;
      case "--disable-source-config":
        options.sourceConfigEnabled = false;
        break;
      default:
        throw new Error(`Unknown support knowledge flow argument "${arg}".`);
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

function parseJsonRecord(value, flag) {
  const parsed = JSON.parse(value);
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new Error(`${flag} must be a JSON object.`);
  }
  return parsed;
}

function parseMetadata(value, flag) {
  const parsed = parseJsonRecord(value, flag);
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
      throw new Error(`${flag}.${key} must be a string, number, or boolean.`);
    }
  }
  return parsed;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function isNotFound(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
