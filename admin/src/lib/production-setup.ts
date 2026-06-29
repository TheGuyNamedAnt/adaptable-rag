import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AdminDoctorCheck,
  AdminDoctorStatus,
  AdminMetadataArea,
  AdminMetadataRuntime
} from "@/lib/admin-doctor";
import {
  getStorageDashboard,
  type StorageDashboardResult,
  type StorageSurfaceSummary
} from "@/lib/storage-dashboard";
import { resolveRagRepoRoot } from "@/lib/repo-root";

export type ProductionSetupStatus = AdminDoctorStatus | "pending";

export interface ProductionSetupChecklist {
  readonly generatedAt: string;
  readonly status: ProductionSetupStatus;
  readonly nextAction?: string;
  readonly summary: {
    readonly stepCount: number;
    readonly passedCount: number;
    readonly warningCount: number;
    readonly failedCount: number;
    readonly pendingCount: number;
  };
  readonly steps: readonly ProductionSetupStep[];
}

export interface ProductionSetupStep {
  readonly id: string;
  readonly area: string;
  readonly title: string;
  readonly status: ProductionSetupStatus;
  readonly detail: string;
  readonly evidence: readonly string[];
  readonly env: readonly string[];
  readonly commands: readonly string[];
  readonly recheckPath: string;
}

export interface CompanyPostgresSmokeReadState {
  readonly status: "available" | "missing" | "invalid";
  readonly path: string;
  readonly error?: string;
  readonly report?: CompanyPostgresSmokeReport;
}

export interface CompanyPostgresSmokeReport {
  readonly status?: string;
  readonly runId?: string;
  readonly checkedAt?: string;
  readonly failures?: readonly string[];
  readonly warnings?: readonly string[];
}

const CORE_STORAGE_SURFACES = new Set<StorageSurfaceSummary["id"]>([
  "index",
  "vector",
  "source_sync_ledger"
]);

const STORAGE_ENV = [
  "RAG_INDEX_KIND=postgres",
  "RAG_VECTOR_KIND=postgres",
  "RAG_VECTOR_DIMENSIONS=1536",
  "RAG_SOURCE_SYNC_LEDGER_KIND=postgres",
  "RAG_POSTGRES_URL_ENV=RAG_DATABASE_URL",
  "RAG_DATABASE_URL=<secret-manager-postgres-url>",
  "RAG_POSTGRES_SCHEMA=rag_core"
] as const;

const HTTP_AUTH_ENV = [
  "RAG_HTTP_AUTH_MODE=required",
  "RAG_HTTP_AUTH_HEADER=authorization",
  "RAG_HTTP_AUTH_TOKEN_ENV=RAG_HTTP_AUTH_TOKEN",
  "RAG_HTTP_AUTH_TOKEN=replace_with_secret_manager_value",
  "RAG_ADMIN_RAG_AUTH_TOKEN_ENV=RAG_HTTP_AUTH_TOKEN"
] as const;

const TRACE_HISTORY_ENV = [
  "RAG_ADMIN_TRACE_HISTORY_KIND=postgres",
  "RAG_ADMIN_TRACE_POSTGRES_URL_ENV=RAG_DATABASE_URL",
  "RAG_ADMIN_TRACE_POSTGRES_SCHEMA=rag_core"
] as const;

const CONNECTOR_STATE_ENV = [
  "RAG_ADMIN_CONNECTOR_STATE_KIND=postgres",
  "RAG_ADMIN_CONNECTOR_POSTGRES_URL_ENV=RAG_DATABASE_URL",
  "RAG_ADMIN_CONNECTOR_POSTGRES_SCHEMA=rag_core"
] as const;

const REVIEW_WORKFLOW_ENV = [
  "RAG_ADMIN_REVIEW_STATE_KIND=postgres",
  "RAG_ADMIN_REVIEW_POSTGRES_URL_ENV=RAG_DATABASE_URL",
  "RAG_ADMIN_REVIEW_POSTGRES_SCHEMA=rag_core"
] as const;

const STORAGE_MIGRATION_COMMAND = [
  'psql "$RAG_DATABASE_URL" -f deploy/postgres/001_core_storage.sql',
  'psql "$RAG_DATABASE_URL" -f deploy/postgres/002_vector_hnsw_1536.sql',
  'psql "$RAG_DATABASE_URL" -f deploy/postgres/003_ingestion_failure_stage.sql',
  'psql "$RAG_DATABASE_URL" -f deploy/postgres/004_admin_trace_history.sql',
  'psql "$RAG_DATABASE_URL" -f deploy/postgres/005_admin_connector_state.sql',
  'psql "$RAG_DATABASE_URL" -f deploy/postgres/006_admin_review_queue.sql'
].join("\n");

export async function getProductionSetupChecklist(): Promise<ProductionSetupChecklist> {
  const [dashboard, smokeReport] = await Promise.all([
    getStorageDashboard(),
    readCompanyPostgresSmokeReport()
  ]);
  return buildProductionSetupChecklist(dashboard, smokeReport);
}

export function buildProductionSetupChecklist(
  dashboard: StorageDashboardResult,
  smokeReport: CompanyPostgresSmokeReadState = missingCompanyPostgresSmokeReport()
): ProductionSetupChecklist {
  const steps: ProductionSetupStep[] = [];

  steps.push(runtimeConfigStep(dashboard));
  steps.push(runtimeStorageStep(dashboard));
  steps.push(storageMigrationStep(dashboard));
  steps.push(
    adminMetadataStep({
      area: "trace_history",
      title: "Trace history metadata",
      runtime: dashboard.adminDoctor.metadata.traceHistory,
      checks: dashboard.adminDoctor.checks.filter((check) => check.area === "trace_history"),
      env: TRACE_HISTORY_ENV,
      migrationCommand: 'psql "$RAG_DATABASE_URL" -f deploy/postgres/004_admin_trace_history.sql'
    })
  );
  steps.push(
    adminMetadataStep({
      area: "connector_state",
      title: "Connector action metadata",
      runtime: dashboard.adminDoctor.metadata.connectorState,
      checks: dashboard.adminDoctor.checks.filter((check) => check.area === "connector_state"),
      env: CONNECTOR_STATE_ENV,
      migrationCommand: 'psql "$RAG_DATABASE_URL" -f deploy/postgres/005_admin_connector_state.sql'
    })
  );
  steps.push(
    adminMetadataStep({
      area: "review_queue",
      title: "Review workflow metadata",
      runtime: dashboard.adminDoctor.metadata.reviewWorkflow,
      checks: dashboard.adminDoctor.checks.filter((check) => check.area === "review_queue"),
      env: REVIEW_WORKFLOW_ENV,
      migrationCommand: 'psql "$RAG_DATABASE_URL" -f deploy/postgres/006_admin_review_queue.sql'
    })
  );
  steps.push(companySmokeStep(steps, smokeReport));

  const summary = {
    stepCount: steps.length,
    passedCount: steps.filter((step) => step.status === "passed").length,
    warningCount: steps.filter((step) => step.status === "warning").length,
    failedCount: steps.filter((step) => step.status === "failed").length,
    pendingCount: steps.filter((step) => step.status === "pending").length
  };

  return {
    generatedAt: new Date().toISOString(),
    status: aggregateSetupStatus(steps.map((step) => step.status)),
    nextAction: steps.find((step) => step.status !== "passed")?.title,
    summary,
    steps
  };
}

function runtimeConfigStep(dashboard: StorageDashboardResult): ProductionSetupStep {
  const runtimeStatus =
    dashboard.runtimeDoctor.status === "unavailable"
      ? "failed"
      : dashboard.runtimeDoctor.data?.status === "passed"
        ? "passed"
        : dashboard.runtimeDoctor.data?.status === "failed"
          ? "failed"
          : "warning";
  const runtimeMessage =
    dashboard.runtimeDoctor.error ??
    dashboard.runtimeDoctor.data?.recommendations?.join(" ") ??
    `RAG service check reported ${dashboard.runtimeDoctor.data?.status ?? dashboard.runtimeDoctor.status}.`;
  const readableRuntimeMessage = readableRagServiceSetupMessage(runtimeMessage);

  return {
    id: "runtime_config",
    area: "RAG service",
    title: "RAG service connection",
    status: runtimeStatus,
    detail:
      runtimeStatus === "passed"
        ? "The RAG service CLI can load the production config and auth settings."
        : `The admin console is running, but the RAG service setup check cannot complete: ${readableRuntimeMessage}`,
    evidence: [
      `RAG service check: ${dashboard.runtimeDoctor.data?.status ?? dashboard.runtimeDoctor.status}`,
      `RAG service URL: ${dashboard.overview.endpoints.baseUrl}`
    ],
    env: HTTP_AUTH_ENV,
    commands: [
      "npm run build",
      "node dist/runtime/production-cli.js doctor --probe-providers false"
    ],
    recheckPath: "/storage"
  };
}

function readableRagServiceSetupMessage(message: string): string {
  const cleaned = message.replace(/^ProductionRagConfigError:\s*/u, "").trim();
  if (cleaned.includes("RAG_HTTP_AUTH_TOKEN") && cleaned.includes("RAG_HTTP_AUTH_MODE=required")) {
    return "RAG HTTP auth is set to required, but no auth token env var is configured. Add RAG_HTTP_AUTH_TOKEN, RAG_HTTP_AUTH_TOKEN_ENV, or RAG_HTTP_AUTH_TOKEN_ENVS for this environment.";
  }
  return cleaned || "The RAG service setup check did not return a readable error.";
}

function runtimeStorageStep(dashboard: StorageDashboardResult): ProductionSetupStep {
  const requiredSurfaces = dashboard.surfaces.filter((surface) =>
    CORE_STORAGE_SURFACES.has(surface.id)
  );
  const nonPostgres = requiredSurfaces.filter((surface) => surface.storageKind !== "postgres");
  const nonDurable = requiredSurfaces.filter((surface) => surface.durable !== true);
  const status =
    requiredSurfaces.length === 0
      ? "failed"
      : nonPostgres.length === 0 && nonDurable.length === 0
        ? "passed"
        : "failed";
  const currentKinds = requiredSurfaces.map(
    (surface) =>
      `${surface.label}: ${surface.storageKind}${surface.durable ? ", durable" : ", not durable"}`
  );

  return {
    id: "runtime_postgres_storage",
    area: "Storage",
    title: "Postgres storage target",
    status,
    detail:
      status === "passed"
        ? "Document/chunk storage, text vectors, and source sync ledger are Postgres backed."
        : "Company deployments need Postgres document/chunk storage, pgvector text vectors, and a Postgres source-sync ledger.",
    evidence: currentKinds.length
      ? currentKinds
      : ["RAG service health did not expose storage surfaces."],
    env: STORAGE_ENV,
    commands: ["node dist/runtime/production-cli.js validate-config --self-test true"],
    recheckPath: "/storage"
  };
}

function storageMigrationStep(dashboard: StorageDashboardResult): ProductionSetupStep {
  const failedChecks = dashboard.runtimeStorageChecks.filter((check) => check.status === "failed");
  const allChecksPassed =
    dashboard.runtimeStorageChecks.length > 0 &&
    dashboard.runtimeStorageChecks.every((check) => check.status === "passed");
  const status: ProductionSetupStatus =
    failedChecks.length > 0 ? "failed" : allChecksPassed ? "passed" : "pending";
  const checkEvidence = dashboard.runtimeStorageChecks.map(
    (check) => `${check.id ?? "storage_check"}: ${check.status ?? "unknown"}`
  );

  return {
    id: "postgres_migrations",
    area: "Storage",
    title: "Postgres migrations",
    status,
    detail:
      status === "passed"
        ? "RAG service storage self-tests passed against the configured schema."
        : "Apply the core storage, pgvector, ingestion failure-stage, trace history, connector state, and review queue migrations before promotion.",
    evidence: checkEvidence.length
      ? checkEvidence
      : ["RAG service storage checks are not available yet."],
    env: ["RAG_DATABASE_URL=<secret-manager-postgres-url>"],
    commands: [STORAGE_MIGRATION_COMMAND],
    recheckPath: "/storage"
  };
}

function adminMetadataStep(input: {
  readonly area: AdminMetadataArea;
  readonly title: string;
  readonly runtime: AdminMetadataRuntime;
  readonly checks: readonly AdminDoctorCheck[];
  readonly env: readonly string[];
  readonly migrationCommand: string;
}): ProductionSetupStep {
  const failed = input.checks.filter((check) => check.status === "failed");
  const warnings = input.checks.filter((check) => check.status === "warning");
  const status: ProductionSetupStatus =
    failed.length > 0
      ? "failed"
      : input.runtime.effectiveKind === "postgres" && warnings.length === 0
        ? "passed"
        : "warning";
  const checkEvidence = input.checks.map((check) => `${check.label}: ${check.status}`);

  return {
    id: input.area,
    area: "Admin metadata",
    title: input.title,
    status,
    detail:
      status === "passed"
        ? `${input.title} is backed by Postgres and the required tables are present.`
        : `${input.title} should be Postgres backed for company deployments.`,
    evidence: [
      `Effective kind: ${input.runtime.effectiveKind}`,
      `Schema: ${input.runtime.schema}`,
      `URL: ${input.runtime.urlConfigured ? "configured" : "missing"}`,
      ...(checkEvidence.length ? checkEvidence : ["No metadata checks returned."])
    ],
    env: input.env,
    commands: uniqueSorted([
      input.migrationCommand,
      ...input.checks.flatMap((check) => (check.command ? [check.command] : []))
    ]),
    recheckPath: "/admin-ops"
  };
}

export async function readCompanyPostgresSmokeReport(): Promise<CompanyPostgresSmokeReadState> {
  const reportPath = companyPostgresSmokeReportPath();
  try {
    return {
      status: "available",
      path: reportPath,
      report: JSON.parse(
        await readFile(/*turbopackIgnore: true*/ reportPath, "utf8")
      ) as CompanyPostgresSmokeReport
    };
  } catch (error) {
    if (isNotFound(error)) {
      return { status: "missing", path: reportPath };
    }
    return {
      status: "invalid",
      path: reportPath,
      error: artifactErrorMessage(error)
    };
  }
}

function companySmokeStep(
  completedSteps: readonly ProductionSetupStep[],
  smokeReport: CompanyPostgresSmokeReadState
): ProductionSetupStep {
  const blockers = completedSteps.filter((step) => step.status === "failed");
  const warnings = completedSteps.filter((step) => step.status === "warning");
  const pending = completedSteps.filter((step) => step.status === "pending");
  const prerequisitesClean = blockers.length === 0 && warnings.length === 0 && pending.length === 0;
  const report = smokeReport.report;
  const reportPassed = smokeReport.status === "available" && report?.status === "passed";
  const reportFailed =
    smokeReport.status === "invalid" ||
    (smokeReport.status === "available" &&
      (report?.status === "failed" || (report?.failures?.length ?? 0) > 0));
  const status: ProductionSetupStatus = reportFailed
    ? "failed"
    : reportPassed
      ? prerequisitesClean
        ? "passed"
        : "warning"
      : prerequisitesClean
        ? "warning"
        : "pending";
  const artifactEvidence = smokeReportEvidence(smokeReport);
  const prerequisiteEvidence =
    blockers.length > 0
      ? blockers.map((step) => `Blocked by ${step.title}`)
      : warnings.length > 0
        ? warnings.map((step) => `Current prerequisite warning: ${step.title}`)
        : pending.length > 0
          ? pending.map((step) => `Waiting on ${step.title}`)
          : ["Storage and admin metadata prerequisites are ready."];

  return {
    id: "company_postgres_smoke",
    area: "Promotion gate",
    title: "Company Postgres smoke",
    status,
    detail:
      smokeReport.status === "invalid"
        ? "The latest company Postgres smoke artifact is invalid. Rerun the smoke or repair the report before promotion."
        : reportFailed
          ? "The latest company Postgres smoke failed. Fix the failures and rerun before promotion."
          : reportPassed && prerequisitesClean
            ? "The latest company Postgres smoke passed with clean current storage and admin prerequisites."
            : reportPassed
              ? "The latest company Postgres smoke passed, but current storage or admin prerequisites are not clean. Recheck and rerun if the environment changed."
              : prerequisitesClean
                ? "Run the production smoke with real provider settings before promoting company traffic."
                : "Run this after the RAG service storage and admin metadata checks are clean.",
    evidence: [...artifactEvidence, ...prerequisiteEvidence],
    env: ["RAG_COMPANY_PACK_CONTRACT_MODE=required"],
    commands: [
      [
        "npm run company:smoke:postgres -- \\",
        "  --env-file .env.company-production \\",
        "  --probe-providers \\",
        "  --report-dir .rag/company-postgres-smoke/latest"
      ].join("\n")
    ],
    recheckPath: "/connectors"
  };
}

function smokeReportEvidence(smokeReport: CompanyPostgresSmokeReadState): readonly string[] {
  if (smokeReport.status === "missing") {
    return [`Smoke report: missing at ${smokeReport.path}`];
  }
  if (smokeReport.status === "invalid") {
    return [
      `Smoke report: invalid at ${smokeReport.path}`,
      `Parse error: ${smokeReport.error ?? "unknown"}`
    ];
  }
  const report = smokeReport.report;
  return [
    `Smoke report: ${report?.status ?? "unknown"} at ${smokeReport.path}`,
    `Run: ${report?.runId ?? "n/a"}`,
    `Checked: ${report?.checkedAt ?? "n/a"}`,
    `Failures: ${report?.failures?.length ?? 0}`,
    `Warnings: ${report?.warnings?.length ?? 0}`
  ];
}

function aggregateSetupStatus(statuses: readonly ProductionSetupStatus[]): ProductionSetupStatus {
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.some((status) => status === "warning")) return "warning";
  if (statuses.some((status) => status === "pending")) return "warning";
  return "passed";
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function missingCompanyPostgresSmokeReport(): CompanyPostgresSmokeReadState {
  return { status: "missing", path: companyPostgresSmokeReportPath() };
}

function companyPostgresSmokeReportPath(): string {
  const configured = process.env.RAG_ADMIN_COMPANY_POSTGRES_SMOKE_REPORT?.trim();
  if (configured) {
    return path.resolve(/*turbopackIgnore: true*/ configured);
  }
  const root = resolveRagRepoRoot();
  return path.join(
    /*turbopackIgnore: true*/ root,
    ".rag",
    "company-postgres-smoke",
    "latest",
    "postgres-company-smoke.json"
  );
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code === "ENOENT"
    : false;
}

function artifactErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.slice(0, 800)
    : "Artifact could not be parsed.";
}
