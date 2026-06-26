import type {
  RagSupportEventExportBundle,
  RagSupportEventExporter,
  RagSupportEventExporterContractExpectations,
  RagSupportEventExportRequest
} from "../support-bridge/support-event-exporter.js";
import {
  renderRagSupportEventExportMarkdown,
  validateRagSupportEventExporterContract,
  type RagSupportEventExportContractResult
} from "../support-bridge/support-event-exporter.js";
import {
  renderRagSupportKnowledgeFlowMarkdown,
  runRagSupportKnowledgeFlow,
  type RagSupportApprovedKnowledgeSourceConfigInput,
  type RagSupportKnowledgeFlowResult
} from "../support-bridge/support-knowledge-flow.js";
import type {
  ProductionIngestRuntime,
  ProductionRagIngestInput,
  ProductionRagIngestResponse
} from "./production-ingestion.js";

export const RAG_SUPPORT_OPERATOR_DRILL_SCHEMA_VERSION = 1;

export type RagSupportOperatorDrillStatus =
  | "failed_export_contract"
  | "blocked"
  | "awaiting_approval"
  | "ready_for_ingestion"
  | "ingested"
  | "ingestion_failed";

export type RagSupportOperatorDrillGateName =
  | "support_event_export"
  | "support_knowledge_approval"
  | "before_production_ingestion"
  | "after_production_ingestion";

export interface RagSupportOperatorDrillIndexStats {
  readonly documentCount: number;
  readonly chunkCount: number;
}

export interface RagSupportOperatorDrillProductionIngestionInput {
  readonly createRuntime: (
    input: RagSupportOperatorDrillProductionRuntimeInput
  ) => ProductionIngestRuntime | Promise<ProductionIngestRuntime>;
  readonly request: ProductionRagIngestInput;
  readonly indexStats?: () => RagSupportOperatorDrillIndexStats;
}

export interface RagSupportOperatorDrillProductionRuntimeInput {
  readonly exportBundle: RagSupportEventExportBundle;
  readonly supportKnowledgeFlow: RagSupportKnowledgeFlowResult;
}

export interface RagSupportOperatorDrillInput {
  readonly drillId?: string;
  readonly generatedAt?: string;
  readonly exporter: RagSupportEventExporter;
  readonly exportRequest?: RagSupportEventExportRequest;
  readonly exportExpectations?: RagSupportEventExporterContractExpectations;
  readonly defaultReviewerDestination?: string;
  readonly approvedKnowledgeSourceConfig?: RagSupportApprovedKnowledgeSourceConfigInput;
  readonly productionIngestion?: RagSupportOperatorDrillProductionIngestionInput;
}

export interface RagSupportOperatorDrillGateCheck {
  readonly name: RagSupportOperatorDrillGateName;
  readonly answerableByRuntime: boolean;
  readonly retrievalEligible: boolean;
  readonly documentCount?: number;
  readonly chunkCount?: number;
  readonly reason: string;
}

export interface RagSupportOperatorDrillIngestionFailure {
  readonly name: string;
  readonly message: string;
}

export interface RagSupportOperatorDrillResult {
  readonly schemaVersion: typeof RAG_SUPPORT_OPERATOR_DRILL_SCHEMA_VERSION;
  readonly drillId: string;
  readonly generatedAt: string;
  readonly status: RagSupportOperatorDrillStatus;
  readonly exportContract: RagSupportEventExportContractResult;
  readonly supportKnowledgeFlow?: RagSupportKnowledgeFlowResult;
  readonly ingestion?: ProductionRagIngestResponse;
  readonly ingestionFailure?: RagSupportOperatorDrillIngestionFailure;
  readonly preIngestionIndex?: RagSupportOperatorDrillIndexStats;
  readonly postIngestionIndex?: RagSupportOperatorDrillIndexStats;
  readonly gateChecks: readonly RagSupportOperatorDrillGateCheck[];
  readonly evidenceBoundary: readonly string[];
}

export async function runRagSupportOperatorDrill(
  input: RagSupportOperatorDrillInput
): Promise<RagSupportOperatorDrillResult> {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const drillId = input.drillId ?? `rag_support_operator_drill_${safeTimestamp(generatedAt)}`;
  const exportContract = await validateRagSupportEventExporterContract({
    exporter: input.exporter,
    request: {
      exportId: `${drillId}_export`,
      generatedAt,
      ...(input.exportRequest ?? {})
    },
    ...(input.exportExpectations === undefined ? {} : { expectations: input.exportExpectations })
  });
  const exportBundle = exportContract.bundle;

  if (
    exportContract.status === "failed" ||
    exportContract.issues.some((issue) => issue.severity === "error") ||
    exportBundle === undefined
  ) {
    return {
      schemaVersion: RAG_SUPPORT_OPERATOR_DRILL_SCHEMA_VERSION,
      drillId,
      generatedAt,
      status: "failed_export_contract",
      exportContract,
      gateChecks: [exportGateCheck(false)],
      evidenceBoundary: ragSupportOperatorDrillEvidenceBoundary()
    };
  }

  const supportKnowledgeFlow = runRagSupportKnowledgeFlow({
    flowId: `${drillId}_support_knowledge_flow`,
    generatedAt,
    events: exportBundle.events,
    approvalDecisions: exportBundle.approvalDecisions,
    ...(input.defaultReviewerDestination === undefined
      ? {}
      : { defaultReviewerDestination: input.defaultReviewerDestination }),
    ...(input.approvedKnowledgeSourceConfig === undefined
      ? {}
      : { approvedKnowledgeSourceConfig: input.approvedKnowledgeSourceConfig })
  });
  const preIngestionIndex = input.productionIngestion?.indexStats?.();
  const baseGateChecks = [
    exportGateCheck(true),
    approvalGateCheck(supportKnowledgeFlow),
    beforeIngestionGateCheck(preIngestionIndex)
  ];

  if (
    supportKnowledgeFlow.status === "blocked" ||
    supportKnowledgeFlow.status === "awaiting_approval" ||
    supportKnowledgeFlow.status === "no_changes" ||
    input.productionIngestion === undefined
  ) {
    return {
      schemaVersion: RAG_SUPPORT_OPERATOR_DRILL_SCHEMA_VERSION,
      drillId,
      generatedAt,
      status: statusBeforeIngestion(supportKnowledgeFlow),
      exportContract,
      supportKnowledgeFlow,
      ...(preIngestionIndex === undefined ? {} : { preIngestionIndex }),
      gateChecks: baseGateChecks,
      evidenceBoundary: ragSupportOperatorDrillEvidenceBoundary()
    };
  }

  try {
    const runtime = await input.productionIngestion.createRuntime({
      exportBundle,
      supportKnowledgeFlow
    });
    const ingestion = await runtime.ingest(input.productionIngestion.request);
    const postIngestionIndex = input.productionIngestion.indexStats?.();

    return {
      schemaVersion: RAG_SUPPORT_OPERATOR_DRILL_SCHEMA_VERSION,
      drillId,
      generatedAt,
      status: "ingested",
      exportContract,
      supportKnowledgeFlow,
      ingestion,
      ...(preIngestionIndex === undefined ? {} : { preIngestionIndex }),
      ...(postIngestionIndex === undefined ? {} : { postIngestionIndex }),
      gateChecks: [
        ...baseGateChecks,
        afterIngestionGateCheck(preIngestionIndex, postIngestionIndex)
      ],
      evidenceBoundary: ragSupportOperatorDrillEvidenceBoundary()
    };
  } catch (error) {
    const postIngestionIndex = input.productionIngestion.indexStats?.();

    return {
      schemaVersion: RAG_SUPPORT_OPERATOR_DRILL_SCHEMA_VERSION,
      drillId,
      generatedAt,
      status: "ingestion_failed",
      exportContract,
      supportKnowledgeFlow,
      ingestionFailure: {
        name: error instanceof Error ? error.name : "Error",
        message: safeText(error instanceof Error ? error.message : "Production ingestion failed.")
      },
      ...(preIngestionIndex === undefined ? {} : { preIngestionIndex }),
      ...(postIngestionIndex === undefined ? {} : { postIngestionIndex }),
      gateChecks: [
        ...baseGateChecks,
        afterIngestionGateCheck(preIngestionIndex, postIngestionIndex)
      ],
      evidenceBoundary: ragSupportOperatorDrillEvidenceBoundary()
    };
  }
}

export function renderRagSupportOperatorDrillMarkdown(
  result: RagSupportOperatorDrillResult
): string {
  return [
    "# Support Operator Drill",
    "",
    `- Drill ID: \`${md(result.drillId)}\``,
    `- Generated: \`${md(result.generatedAt)}\``,
    `- Status: **${md(result.status)}**`,
    "",
    "## Gate Checks",
    "",
    gateTable(result.gateChecks),
    "",
    "## Export Contract",
    "",
    result.exportContract.bundle
      ? renderRagSupportEventExportMarkdown(
          result.exportContract.bundle,
          result.exportContract.issues
        )
      : "_Export contract failed before a bundle was available._",
    "",
    "## Support Knowledge Flow",
    "",
    result.supportKnowledgeFlow
      ? renderRagSupportKnowledgeFlowMarkdown(result.supportKnowledgeFlow)
      : "_Support knowledge flow did not run._",
    "",
    "## Evidence Boundary",
    "",
    result.evidenceBoundary.map((entry) => `- ${md(entry)}`).join("\n"),
    ""
  ].join("\n");
}

export function ragSupportOperatorDrillEvidenceBoundary(): readonly string[] {
  return [
    "Includes safe support event export metrics, contract issues, support knowledge flow metrics, approval artifact ids, approved artifact bodies needed for ingestion handoff, ingestion counts, index document/chunk counts, and gate-check statuses.",
    "Excludes raw admin ticket payloads, raw customer messages, raw diagnostics, rendered prompts, raw generated answers, credentials, routing secrets, full principal claims, and raw reviewer identifiers.",
    "The drill proves operational handoff gates; it does not make support events answerable before approved artifact ingestion and index admission complete."
  ];
}

function statusBeforeIngestion(
  supportKnowledgeFlow: RagSupportKnowledgeFlowResult
): RagSupportOperatorDrillStatus {
  if (supportKnowledgeFlow.status === "blocked") {
    return "blocked";
  }
  if (supportKnowledgeFlow.status === "ready_for_ingestion") {
    return "ready_for_ingestion";
  }
  return "awaiting_approval";
}

function exportGateCheck(passed: boolean): RagSupportOperatorDrillGateCheck {
  return {
    name: "support_event_export",
    answerableByRuntime: false,
    retrievalEligible: false,
    reason: passed
      ? "Safe support events are export handoff records only; they are not answerable corpus knowledge."
      : "Support events failed export validation and must not enter the support knowledge flow."
  };
}

function approvalGateCheck(
  supportKnowledgeFlow: RagSupportKnowledgeFlowResult
): RagSupportOperatorDrillGateCheck {
  return {
    name: "support_knowledge_approval",
    answerableByRuntime: false,
    retrievalEligible: false,
    reason:
      supportKnowledgeFlow.metrics.approvedArtifactCount > 0
        ? "Approved artifacts exist, but approval alone does not make them retrievable or answerable."
        : "No approved artifacts exist yet; support knowledge remains review work."
  };
}

function beforeIngestionGateCheck(
  indexStats: RagSupportOperatorDrillIndexStats | undefined
): RagSupportOperatorDrillGateCheck {
  return {
    name: "before_production_ingestion",
    answerableByRuntime: false,
    retrievalEligible: false,
    ...(indexStats === undefined
      ? {}
      : {
          documentCount: indexStats.documentCount,
          chunkCount: indexStats.chunkCount
        }),
    reason:
      "Before production ingestion, approved artifacts have not passed corpus normalization, chunking, access controls, or index admission."
  };
}

function afterIngestionGateCheck(
  before: RagSupportOperatorDrillIndexStats | undefined,
  after: RagSupportOperatorDrillIndexStats | undefined
): RagSupportOperatorDrillGateCheck {
  const chunkDelta =
    before === undefined || after === undefined ? 0 : after.chunkCount - before.chunkCount;
  const retrievalEligible = after !== undefined && chunkDelta > 0;

  return {
    name: "after_production_ingestion",
    answerableByRuntime: retrievalEligible,
    retrievalEligible,
    ...(after === undefined
      ? {}
      : {
          documentCount: after.documentCount,
          chunkCount: after.chunkCount
        }),
    reason: retrievalEligible
      ? "Production ingestion admitted approved artifacts into the index; answerability still depends on retrieval, access filters, grounding, and generation gates at query time."
      : "Production ingestion did not add retrievable chunks."
  };
}

function gateTable(gates: readonly RagSupportOperatorDrillGateCheck[]): string {
  if (gates.length === 0) {
    return "_No gate checks._";
  }

  return [
    "| Gate | Answerable | Retrieval Eligible | Chunks |",
    "| --- | --- | --- | --- |",
    ...gates.map(
      (gate) =>
        `| \`${md(gate.name)}\` | ${gate.answerableByRuntime ? "yes" : "no"} | ${gate.retrievalEligible ? "yes" : "no"} | ${gate.chunkCount ?? "n/a"} |`
    )
  ].join("\n");
}

function safeTimestamp(value: string): string {
  return value.replace(/[^0-9A-Za-z]+/g, "_").replace(/^_+|_+$/g, "");
}

function safeText(value: string): string {
  return value
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [REDACTED]")
    .slice(0, 500);
}

function md(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/`/g, "'");
}
