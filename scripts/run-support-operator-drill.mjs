#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  redactText,
  renderRagSupportEventExportMarkdown,
  renderRagSupportKnowledgeApprovalLedgerMarkdown,
  renderRagSupportKnowledgeCandidateQueueMarkdown,
  renderRagSupportKnowledgeFlowMarkdown,
  renderRagSupportOperatorDrillMarkdown,
  runRagSupportOperatorDrill
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
  const exporter = {
    id: options.exporterId,
    description: "File-backed safe support event exporter for the support operator drill.",
    exportEvents: () => ({
      events,
      approvalDecisions,
      ...(previousLedger === undefined ? {} : { previousLedger }),
      metadata: {
        source: "file-support-operator-drill"
      }
    })
  };
  const result = await runRagSupportOperatorDrill({
    ...(options.drillId === undefined ? {} : { drillId: options.drillId }),
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
    exporter,
    exportRequest: {
      ...(options.exportId === undefined ? {} : { exportId: options.exportId }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor })
    },
    exportExpectations: {
      minEvents: options.minEvents,
      allowApprovalDecisions: options.allowApprovalDecisions,
      allowExportWarnings: options.allowExportWarnings,
      allowLedgerConflicts: options.allowLedgerConflicts,
      ...(options.allowedSourceSystems === undefined
        ? {}
        : { allowedSourceSystems: options.allowedSourceSystems })
    },
    ...(options.defaultReviewerDestination === undefined
      ? {}
      : { defaultReviewerDestination: options.defaultReviewerDestination }),
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
    await writeSupportOperatorDrillArtifacts(options.reportDir, result);
  }

  console.log(
    `Support operator drill ${result.status}: ${result.exportContract.metrics.eventCount} event(s), ${result.exportContract.issues.length} export issue(s), ${result.supportKnowledgeFlow?.metrics.approvedArtifactCount ?? 0} approved artifact(s), answerable before ingestion: no.`
  );
  if (result.status === "ready_for_ingestion" && options.reportDir) {
    console.log(
      `Next gate: point RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH at ${path.join(
        options.reportDir,
        "approved-knowledge.sources.json"
      )} and run production ingestion.`
    );
  }
  if (options.reportDir) {
    console.log(`Support operator drill artifacts written to ${options.reportDir}.`);
  }
  if (result.status === "failed_export_contract" || result.status === "blocked") {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: redactText(
          error instanceof Error ? error.message : "Support operator drill failed."
        )
      }
    })
  );
  process.exitCode = 1;
}

async function writeSupportOperatorDrillArtifacts(reportDir, result) {
  await mkdir(reportDir, { recursive: true });
  await writeJson(path.join(reportDir, "drill.json"), result);
  await writeFile(
    path.join(reportDir, "drill.md"),
    renderRagSupportOperatorDrillMarkdown(result),
    "utf8"
  );
  await writeJson(path.join(reportDir, "validation.json"), result.exportContract);

  if (result.exportContract.bundle) {
    const bundle = result.exportContract.bundle;
    await writeJson(path.join(reportDir, "export.json"), bundle);
    await writeFile(
      path.join(reportDir, "export.md"),
      renderRagSupportEventExportMarkdown(bundle, result.exportContract.issues),
      "utf8"
    );
    await writeJsonl(path.join(reportDir, "events.jsonl"), bundle.events);
    await writeJsonl(path.join(reportDir, "decisions.jsonl"), bundle.approvalDecisions);
  }

  if (result.supportKnowledgeFlow) {
    await writeJson(path.join(reportDir, "flow.json"), result.supportKnowledgeFlow);
    await writeFile(
      path.join(reportDir, "flow.md"),
      renderRagSupportKnowledgeFlowMarkdown(result.supportKnowledgeFlow),
      "utf8"
    );
    await writeJson(
      path.join(reportDir, "event-ledger.json"),
      result.supportKnowledgeFlow.eventLedger
    );
    await writeJson(
      path.join(reportDir, "candidate-queue.json"),
      result.supportKnowledgeFlow.candidateQueue
    );
    await writeFile(
      path.join(reportDir, "candidate-queue.md"),
      renderRagSupportKnowledgeCandidateQueueMarkdown(result.supportKnowledgeFlow.candidateQueue),
      "utf8"
    );
    await writeJson(
      path.join(reportDir, "approval-ledger.json"),
      result.supportKnowledgeFlow.approvalLedger
    );
    await writeFile(
      path.join(reportDir, "approval-ledger.md"),
      renderRagSupportKnowledgeApprovalLedgerMarkdown(result.supportKnowledgeFlow.approvalLedger),
      "utf8"
    );
    await writeJson(
      path.join(reportDir, "approved-knowledge.sources.json"),
      result.supportKnowledgeFlow.approvedKnowledgeSourcesConfig
    );
  }
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
    reportDir: path.join(".rag", "support-drill", "latest"),
    exporterId: "file_support_operator_drill_exporter",
    minEvents: 1,
    allowApprovalDecisions: true,
    allowExportWarnings: true,
    allowLedgerConflicts: false,
    sourceConfigEnabled: true,
    approvalLedgerPath: "approval-ledger.json",
    sourcePathPrefix: "approved-knowledge"
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
      case "--drill-id":
        options.drillId = requiredValue(args, ++index, arg);
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
      case "--default-reviewer-destination":
        options.defaultReviewerDestination = requiredValue(args, ++index, arg);
        break;
      case "--disable-source-config":
        options.sourceConfigEnabled = false;
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
      case "--access-scope-json":
        options.accessScope = parseJsonOption(requiredValue(args, ++index, arg), arg);
        break;
      case "--metadata-json":
        options.metadata = parseJsonOption(requiredValue(args, ++index, arg), arg);
        break;
      case "--captured-at":
        options.capturedAt = requiredValue(args, ++index, arg);
        break;
      case "--max-artifacts":
        options.maxArtifacts = positiveInteger(requiredValue(args, ++index, arg), arg);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function validateSupportEvents(records, filePath) {
  return records.map((record, index) => {
    const pathPrefix = `${filePath}[${index}]`;
    requireNumber(record, "schemaVersion", pathPrefix);
    requireString(record, "eventId", pathPrefix);
    requireString(record, "sourceSystem", pathPrefix);
    requireString(record, "sourceEventId", pathPrefix);
    requireString(record, "idempotencyKey", pathPrefix);
    requireString(record, "payloadHash", pathPrefix);
    requireString(record, "profileId", pathPrefix);
    requireString(record, "namespaceId", pathPrefix);
    requireString(record, "eventType", pathPrefix);
    requireString(record, "occurredAt", pathPrefix);
    requireString(record, "summary", pathPrefix);
    if (!Array.isArray(record.evidenceRefs)) {
      throw new Error(`${pathPrefix}.evidenceRefs must be an array.`);
    }
    if (!Array.isArray(record.evidenceBoundary)) {
      throw new Error(`${pathPrefix}.evidenceBoundary must be an array.`);
    }
    if (!isRecord(record.proposedKnowledgeAction)) {
      throw new Error(`${pathPrefix}.proposedKnowledgeAction must be an object.`);
    }
    return record;
  });
}

function validateDecisionRecords(records, filePath) {
  return records.map((record, index) => {
    const pathPrefix = `${filePath}[${index}]`;
    requireString(record, "candidateId", pathPrefix);
    requireString(record, "action", pathPrefix);
    if (!("reviewerIdHash" in record) && !("reviewerId" in record)) {
      throw new Error(`${pathPrefix}.reviewerIdHash is required unless reviewerId is provided.`);
    }
    if ("reviewerIdHash" in record) {
      requireString(record, "reviewerIdHash", pathPrefix);
    }
    if ("reviewerId" in record) {
      requireString(record, "reviewerId", pathPrefix);
    }
    return record;
  });
}

function requireString(record, key, pathPrefix) {
  if (!isRecord(record) || typeof record[key] !== "string" || record[key].trim().length === 0) {
    throw new Error(`${pathPrefix}.${key} must be a non-empty string.`);
  }
}

function requireNumber(record, key, pathPrefix) {
  if (!isRecord(record) || typeof record[key] !== "number") {
    throw new Error(`${pathPrefix}.${key} must be a number.`);
  }
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseJsonOption(value, flag) {
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) {
      throw new Error("not_object");
    }
    return parsed;
  } catch {
    throw new Error(`${flag} must be valid JSON object text.`);
  }
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function nonNegativeInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return parsed;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error) {
  return isRecord(error) && error.code === "ENOENT";
}
