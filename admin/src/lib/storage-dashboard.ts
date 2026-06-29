import "server-only";

import {
  getAdminDoctor,
  type AdminDoctorCheck,
  type AdminDoctorResult,
  type AdminDoctorStatus
} from "@/lib/admin-doctor";
import {
  getOverview,
  getRuntimeDoctor,
  type OverviewResult,
  type ProductionHealth,
  type RuntimeDoctorCheck,
  type RuntimeDoctorResult
} from "@/lib/rag-admin-api";
import type { Availability } from "@/lib/rag-admin-api";

export interface StorageDashboardResult {
  readonly generatedAt: string;
  readonly status: AdminDoctorStatus;
  readonly overview: OverviewResult;
  readonly runtimeDoctor: Availability<RuntimeDoctorResult>;
  readonly adminDoctor: AdminDoctorResult;
  readonly surfaces: readonly StorageSurfaceSummary[];
  readonly runtimeStorageChecks: readonly RuntimeDoctorCheck[];
  readonly recommendations: readonly string[];
}

export interface StorageSurfaceSummary {
  readonly id: "index" | "vector" | "visual_vector" | "source_sync_ledger";
  readonly label: string;
  readonly storageKind: string;
  readonly durable: boolean;
  readonly status: AdminDoctorStatus;
  readonly detail: string;
  readonly documentCount?: number;
  readonly chunkCount?: number;
  readonly dimensions?: number;
}

export async function getStorageDashboard(): Promise<StorageDashboardResult> {
  const [overview, runtimeDoctor, adminDoctor] = await Promise.all([
    getOverview(),
    getRuntimeDoctor({ probeProviders: false }),
    safeAdminDoctor()
  ]);
  const health = overview.health ?? runtimeDoctor.data?.health;
  const runtimeStorageChecks =
    runtimeDoctor.data?.selfTest?.checks?.filter((check) => check.kind === "storage") ?? [];
  const recommendations = uniqueSorted([
    ...overview.errors,
    ...(runtimeDoctor.error ? [runtimeDoctor.error] : []),
    ...(runtimeDoctor.data?.recommendations ?? []),
    ...adminDoctor.recommendations
  ]);
  const status = aggregateStatus([
    overview.status === "unavailable"
      ? "failed"
      : overview.status === "partial"
        ? "warning"
        : "passed",
    runtimeDoctorStatus(runtimeDoctor),
    adminDoctor.status,
    ...storageSurfaces(health).map((surface) => surface.status)
  ]);

  return {
    generatedAt: new Date().toISOString(),
    status,
    overview,
    runtimeDoctor,
    adminDoctor,
    surfaces: storageSurfaces(health),
    runtimeStorageChecks,
    recommendations
  };
}

function storageSurfaces(health: ProductionHealth | undefined): readonly StorageSurfaceSummary[] {
  const indexKind = health?.index?.storageKind ?? "not_configured";
  const vectorKind = health?.vector?.storageKind ?? "not_configured";
  const visualKind = health?.visualVector?.storageKind ?? "not_configured";
  const ledgerKind = health?.sourceSyncLedger?.storageKind ?? "not_configured";
  return [
    {
      id: "index",
      label: "Document and chunk store",
      storageKind: indexKind,
      durable: health?.index?.durable === true,
      status: storageStatus(indexKind, health?.index?.durable),
      detail: storageDetail(indexKind, health?.index?.durable),
      documentCount: health?.index?.documentCount,
      chunkCount: health?.index?.chunkCount
    },
    {
      id: "vector",
      label: "Text vector index",
      storageKind: vectorKind,
      durable: health?.vector?.durable === true,
      status: storageStatus(vectorKind, health?.vector?.durable),
      detail: vectorDetail(vectorKind, health?.vector?.durable, health?.vector?.dimensions),
      dimensions: health?.vector?.dimensions
    },
    {
      id: "visual_vector",
      label: "Visual vector index",
      storageKind: visualKind,
      durable: health?.visualVector?.durable === true,
      status:
        visualKind === "not_configured"
          ? "warning"
          : storageStatus(visualKind, health?.visualVector?.durable),
      detail: vectorDetail(
        visualKind,
        health?.visualVector?.durable,
        health?.visualVector?.dimensions
      ),
      dimensions: health?.visualVector?.dimensions
    },
    {
      id: "source_sync_ledger",
      label: "Source sync ledger",
      storageKind: ledgerKind,
      durable: health?.sourceSyncLedger?.durable === true,
      status: storageStatus(ledgerKind, health?.sourceSyncLedger?.durable),
      detail: storageDetail(ledgerKind, health?.sourceSyncLedger?.durable)
    }
  ];
}

function runtimeDoctorStatus(runtimeDoctor: Availability<RuntimeDoctorResult>): AdminDoctorStatus {
  if (runtimeDoctor.status === "unavailable") return "warning";
  if (runtimeDoctor.data?.status === "failed") return "failed";
  if (runtimeDoctor.data?.status === "passed") return "passed";
  return "warning";
}

function storageStatus(kind: string, durable: boolean | undefined): AdminDoctorStatus {
  if (kind === "postgres" || kind === "hosted") return durable === false ? "warning" : "passed";
  if (kind === "sqlite" || kind === "json_file") return durable === true ? "warning" : "failed";
  if (kind === "memory" || kind === "not_configured" || kind === "none") return "warning";
  return durable ? "passed" : "warning";
}

function storageDetail(kind: string, durable: boolean | undefined): string {
  if (kind === "not_configured" || kind === "none") return "Not configured.";
  if (kind === "postgres") return "Production Postgres storage.";
  if (kind === "hosted") return "External durable storage.";
  if (kind === "sqlite") return "Durable local install target.";
  if (kind === "json_file") return "Local development persistence.";
  if (kind === "memory") return "In-memory only.";
  return durable ? "Durable storage." : "Non-durable storage.";
}

function vectorDetail(
  kind: string,
  durable: boolean | undefined,
  dimensions: number | undefined
): string {
  const base = storageDetail(kind, durable);
  return dimensions ? `${base} ${dimensions} dimensions.` : base;
}

async function safeAdminDoctor(): Promise<AdminDoctorResult> {
  try {
    return await getAdminDoctor();
  } catch (error) {
    const detail =
      error instanceof Error && error.message.trim()
        ? error.message.slice(0, 1200)
        : "Admin Doctor failed.";
    const failedCheck: AdminDoctorCheck = {
      id: "admin_doctor.unhandled_error",
      label: "Admin Doctor",
      status: "failed",
      area: "connector_state",
      detail,
      recommendation: "Fix the server-side admin Doctor error, then rerun the check."
    };
    return {
      generatedAt: new Date().toISOString(),
      status: "failed",
      checks: [failedCheck],
      metadata: {
        traceHistory: {
          area: "trace_history",
          configuredKind: "auto",
          effectiveKind: "json_file",
          schema: "rag_core",
          urlConfigured: false,
          requiredMigration: "deploy/postgres/004_admin_trace_history.sql",
          requiredTables: ["admin_answer_runs"]
        },
        connectorState: {
          area: "connector_state",
          configuredKind: "auto",
          effectiveKind: "json_file",
          schema: "rag_core",
          urlConfigured: false,
          requiredMigration: "deploy/postgres/005_admin_connector_state.sql",
          requiredTables: ["admin_connector_actions", "admin_connector_disabled_overrides"]
        },
        reviewWorkflow: {
          area: "review_queue",
          configuredKind: "auto",
          effectiveKind: "json_file",
          schema: "rag_core",
          urlConfigured: false,
          requiredMigration: "deploy/postgres/006_admin_review_queue.sql",
          requiredTables: ["admin_review_states"]
        }
      },
      recommendations: [failedCheck.recommendation ?? detail]
    };
  }
}

function aggregateStatus(statuses: readonly AdminDoctorStatus[]): AdminDoctorStatus {
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.some((status) => status === "warning")) return "warning";
  return "passed";
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))].sort();
}
