import type { RagSupportKnowledgeApprovalDecisionInput } from "./approval-ledger.js";
import {
  buildRagSupportEvent,
  type BuildRagSupportEventInput,
  type RagSupportEvent
} from "./support-event.js";
import type {
  RagSupportEventExportMetadata,
  RagSupportEventExporter,
  RagSupportEventExporterResult,
  RagSupportEventExportRequest,
  RagSupportEventExportWarning
} from "./support-event-exporter.js";

export const RAG_PROJECT_SUPPORT_CONNECTOR_TEMPLATE_VERSION = 1;

export type RagProjectSupportConnectorWarningCode =
  | "connector_source_failed"
  | "connector_mapper_failed";

export interface RagProjectSupportConnectorLoadRequest {
  readonly exportRequest: RagSupportEventExportRequest;
  readonly generatedAt: string;
  readonly cursor?: string;
  readonly maxRecords?: number;
  readonly profileId?: string;
  readonly namespaceId?: string;
}

export interface RagProjectSupportConnectorSourceResult<TRecord> {
  readonly records: readonly TRecord[];
  readonly cursor?: string;
  readonly warnings?: readonly RagSupportEventExportWarning[];
  readonly metadata?: RagSupportEventExportMetadata;
}

export interface RagProjectSupportConnectorSource<TRecord> {
  readonly id: string;
  readonly description: string;
  loadRecords(
    request: RagProjectSupportConnectorLoadRequest
  ):
    | RagProjectSupportConnectorSourceResult<TRecord>
    | Promise<RagProjectSupportConnectorSourceResult<TRecord>>;
}

export interface RagProjectSupportConnectorMapInput<TRecord> {
  readonly record: TRecord;
  readonly recordIndex: number;
  readonly sourceId: string;
  readonly request: RagProjectSupportConnectorLoadRequest;
}

export interface RagProjectSupportConnectorMappedRecord {
  readonly events?: readonly BuildRagSupportEventInput[];
  readonly approvalDecisions?: readonly RagSupportKnowledgeApprovalDecisionInput[];
  readonly warnings?: readonly RagSupportEventExportWarning[];
  readonly metadata?: RagSupportEventExportMetadata;
}

export interface RagProjectSupportEventConnectorOptions<TRecord> {
  readonly exporterId: string;
  readonly description: string;
  readonly source: RagProjectSupportConnectorSource<TRecord>;
  readonly mapRecord: (
    input: RagProjectSupportConnectorMapInput<TRecord>
  ) => RagProjectSupportConnectorMappedRecord | Promise<RagProjectSupportConnectorMappedRecord>;
  readonly metadata?: RagSupportEventExportMetadata;
}

export function createRagProjectSupportEventExporter<TRecord>(
  options: RagProjectSupportEventConnectorOptions<TRecord>
): RagSupportEventExporter {
  return {
    id: options.exporterId,
    description: options.description,
    exportEvents: (request) => exportProjectSupportEvents(options, request)
  };
}

export function ragProjectSupportConnectorTemplateEvidenceBoundary(): readonly string[] {
  return [
    "The project connector template includes connector ids, cursor positions, safe support event build inputs, support event outputs, hashed approval-decision shells, warning codes, and safe metadata.",
    "It excludes raw project support records, raw customer messages, raw diagnostics, raw generated answers, source bodies, credentials, routing secrets, full principal claims, and raw reviewer identifiers.",
    "Project-owned connector code must live outside the generic RAG core and must pass RagSupportEventExporter contract tests before its exports enter the support knowledge flow."
  ];
}

async function exportProjectSupportEvents<TRecord>(
  options: RagProjectSupportEventConnectorOptions<TRecord>,
  request: RagSupportEventExportRequest
): Promise<RagSupportEventExporterResult> {
  const generatedAt = request.generatedAt ?? new Date().toISOString();
  const loadRequest: RagProjectSupportConnectorLoadRequest = {
    exportRequest: request,
    generatedAt,
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(request.maxEvents === undefined ? {} : { maxRecords: request.maxEvents }),
    ...(request.profileId === undefined ? {} : { profileId: request.profileId }),
    ...(request.namespaceId === undefined ? {} : { namespaceId: request.namespaceId })
  };

  let sourceResult: RagProjectSupportConnectorSourceResult<TRecord>;
  try {
    sourceResult = await options.source.loadRecords(loadRequest);
  } catch (error) {
    return {
      events: [],
      warnings: [
        connectorWarning(
          "connector_source_failed",
          `Project support connector source failed: ${errorName(error)}.`
        )
      ],
      metadata: outputMetadata(options, {
        connector_source_id: options.source.id,
        connector_template_version: RAG_PROJECT_SUPPORT_CONNECTOR_TEMPLATE_VERSION
      })
    };
  }

  const events: RagSupportEvent[] = [];
  const approvalDecisions: RagSupportKnowledgeApprovalDecisionInput[] = [];
  const warnings: RagSupportEventExportWarning[] = [...(sourceResult.warnings ?? [])];
  const mappedMetadata: RagSupportEventExportMetadata[] = [];

  for (const [recordIndex, record] of sourceResult.records.entries()) {
    try {
      const mapped = await options.mapRecord({
        record,
        recordIndex,
        sourceId: options.source.id,
        request: loadRequest
      });
      events.push(...(mapped.events ?? []).map((event) => buildRagSupportEvent(event)));
      approvalDecisions.push(...(mapped.approvalDecisions ?? []));
      warnings.push(...(mapped.warnings ?? []));
      if (mapped.metadata !== undefined) {
        mappedMetadata.push(mapped.metadata);
      }
    } catch (error) {
      warnings.push(
        connectorWarning(
          "connector_mapper_failed",
          `Project support connector mapper failed for record ${recordIndex}: ${errorName(error)}.`
        )
      );
    }
  }

  return {
    events,
    ...(approvalDecisions.length === 0 ? {} : { approvalDecisions }),
    ...(warnings.length === 0 ? {} : { warnings }),
    ...(sourceResult.cursor === undefined ? {} : { cursor: sourceResult.cursor }),
    metadata: outputMetadata(options, {
      connector_source_id: options.source.id,
      connector_template_version: RAG_PROJECT_SUPPORT_CONNECTOR_TEMPLATE_VERSION,
      ...(sourceResult.metadata ?? {}),
      ...Object.assign({}, ...mappedMetadata)
    })
  };
}

function outputMetadata<TRecord>(
  options: RagProjectSupportEventConnectorOptions<TRecord>,
  metadata: RagSupportEventExportMetadata
): RagSupportEventExportMetadata {
  return {
    ...(options.metadata ?? {}),
    ...metadata
  };
}

function connectorWarning(
  code: RagProjectSupportConnectorWarningCode,
  message: string
): RagSupportEventExportWarning {
  return {
    code,
    message: safeDiagnostic(message)
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? safeDiagnostic(error.message || error.name) : "unknown_error";
}

function safeDiagnostic(value: string): string {
  return value
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [REDACTED]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}
