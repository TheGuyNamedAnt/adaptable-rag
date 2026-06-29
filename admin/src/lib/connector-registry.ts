import "server-only";

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  getDisabledConnectorOverrides,
  type DisabledConnectorOverride
} from "@/lib/connector-admin-state";
import { resolveRagRepoRoot } from "@/lib/repo-root";

export type ConnectorStatus = "passed" | "failed" | "warning" | "unknown";

export interface ConnectorRegistryResult {
  readonly generatedAt: string;
  readonly deployments: readonly ConnectorDeploymentRecord[];
  readonly connectors: readonly ConnectorRegistryRecord[];
  readonly catalog: readonly ConnectorCatalogRecord[];
}

export interface ConnectorDeploymentRecord {
  readonly artifactId: string;
  readonly companyId: string;
  readonly companyName: string;
  readonly status: string;
  readonly profileCount: number;
  readonly connectorCount: number;
  readonly evalPackCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly contractStatus?: string;
  readonly checkedCaseCount?: number;
}

export interface ConnectorRegistryRecord {
  readonly id: string;
  readonly companyId: string;
  readonly companyName: string;
  readonly profileId?: string;
  readonly namespaceId?: string;
  readonly sourceId: string;
  readonly connectorId: string;
  readonly sourceSystem: string;
  readonly adapterId?: string;
  readonly status: ConnectorStatus;
  readonly enabled: boolean;
  readonly disabledAt?: string;
  readonly disabledBy?: string;
  readonly disabledReason?: string;
  readonly modes: readonly string[];
  readonly lastCheckedAt?: string;
  readonly runStatus?: string;
  readonly completeFullSync?: boolean;
  readonly returnedRecordCount: number;
  readonly deletedItemCount: number;
  readonly failedItemCount: number;
  readonly warningCount: number;
  readonly errorCount: number;
}

export interface ConnectorCatalogRecord {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly sourceSystem: string;
  readonly status: "template" | "planned";
  readonly notes: string;
}

interface DeploymentArtifact {
  readonly status?: string;
  readonly companyId?: string;
  readonly companyName?: string;
  readonly profileCount?: number;
  readonly connectorCount?: number;
  readonly evalPackCount?: number;
  readonly errorCount?: number;
  readonly warningCount?: number;
  readonly profiles?: readonly DeploymentProfileArtifact[];
  readonly connectorContracts?: ConnectorContractsArtifact;
}

interface DeploymentProfileArtifact {
  readonly id?: string;
  readonly namespaceId?: string;
  readonly sourceIds?: readonly string[];
  readonly adapterIds?: readonly string[];
}

interface ConnectorContractsArtifact {
  readonly status?: string;
  readonly checkedCaseCount?: number;
  readonly reports?: readonly ConnectorContractReportArtifact[];
}

interface ConnectorContractReportArtifact {
  readonly status?: string;
  readonly companyId?: string;
  readonly useCaseId?: string;
  readonly profileId?: string;
  readonly namespaceId?: string;
  readonly requestedAt?: string;
  readonly cases?: readonly ConnectorContractCaseArtifact[];
}

interface ConnectorContractCaseArtifact {
  readonly status?: string;
  readonly connectorId?: string;
  readonly sourceSystem?: string;
  readonly adapterId?: string;
  readonly sourceId?: string;
  readonly mode?: string;
  readonly runStatus?: string;
  readonly complete?: boolean;
  readonly errorCount?: number;
  readonly warningCount?: number;
  readonly metrics?: {
    readonly returnedRecordCount?: number;
    readonly deletedItemCount?: number;
    readonly failedItemCount?: number;
    readonly warningCount?: number;
  };
}

const CONNECTOR_CATALOG: readonly ConnectorCatalogRecord[] = [
  {
    id: "google_drive",
    label: "Google Drive",
    category: "Document store",
    sourceSystem: "google-drive",
    status: "template",
    notes: "OAuth, shared-drive scope, stable file ids, ACL mapping, delta cursor."
  },
  {
    id: "slack",
    label: "Slack",
    category: "Collaboration",
    sourceSystem: "slack",
    status: "template",
    notes: "Channel/user scopes, thread ids, edited/deleted message handling."
  },
  {
    id: "notion",
    label: "Notion",
    category: "Workspace wiki",
    sourceSystem: "notion",
    status: "template",
    notes: "Database/page ids, block traversal, permissions, incremental sync."
  },
  {
    id: "s3",
    label: "S3",
    category: "Object storage",
    sourceSystem: "s3",
    status: "template",
    notes: "Bucket prefixes, object versions, checksum-based idempotency."
  },
  {
    id: "zendesk",
    label: "Zendesk",
    category: "Support",
    sourceSystem: "zendesk",
    status: "template",
    notes: "Articles, tickets, organizations, brands, and support ACLs."
  }
];

export async function getConnectorRegistry(): Promise<ConnectorRegistryResult> {
  const artifacts = await readDeploymentArtifacts();
  const disabledOverrides = await getDisabledConnectorOverrides();
  const connectors = applyDisabledConnectorOverrides(
    connectorRecordsFromArtifacts(artifacts),
    disabledOverrides
  );
  return {
    generatedAt: new Date().toISOString(),
    deployments: artifacts.map(({ artifactId, deployment }) =>
      deploymentRecordFromArtifact(artifactId, deployment)
    ),
    connectors,
    catalog: CONNECTOR_CATALOG
  };
}

async function readDeploymentArtifacts(): Promise<
  readonly { readonly artifactId: string; readonly deployment: DeploymentArtifact }[]
> {
  const root = companyRoot();
  if (!existsSync(/*turbopackIgnore: true*/ root)) return [];
  const entries = await readdir(/*turbopackIgnore: true*/ root, { withFileTypes: true });
  const artifacts = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const deployment = await readJson<DeploymentArtifact>(
          path.join(/*turbopackIgnore: true*/ root, entry.name, "company-deployment.json")
        );
        return deployment ? { artifactId: entry.name, deployment } : undefined;
      })
  );
  return artifacts
    .filter(
      (
        artifact
      ): artifact is { readonly artifactId: string; readonly deployment: DeploymentArtifact } =>
        artifact !== undefined
    )
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
}

function deploymentRecordFromArtifact(
  artifactId: string,
  deployment: DeploymentArtifact
): ConnectorDeploymentRecord {
  return {
    artifactId,
    companyId: deployment.companyId ?? "unknown-company",
    companyName: deployment.companyName ?? deployment.companyId ?? "Unknown company",
    status: deployment.status ?? "unknown",
    profileCount: deployment.profileCount ?? deployment.profiles?.length ?? 0,
    connectorCount: deployment.connectorCount ?? 0,
    evalPackCount: deployment.evalPackCount ?? 0,
    errorCount: deployment.errorCount ?? 0,
    warningCount: deployment.warningCount ?? 0,
    contractStatus: deployment.connectorContracts?.status,
    checkedCaseCount: deployment.connectorContracts?.checkedCaseCount
  };
}

function connectorRecordsFromArtifacts(
  artifacts: readonly { readonly artifactId: string; readonly deployment: DeploymentArtifact }[]
): readonly ConnectorRegistryRecord[] {
  const records = new Map<string, ConnectorRegistryRecord>();
  const contractSourceKeys = new Set<string>();
  for (const { deployment } of artifacts) {
    for (const record of connectorRecordsFromContracts(deployment)) {
      contractSourceKeys.add(sourceRecordKey(record.companyId, record.sourceId));
      records.set(record.id, mergeConnectorRecord(records.get(record.id), record));
    }
  }
  for (const { deployment } of artifacts) {
    for (const record of connectorRecordsFromProfiles(deployment)) {
      if (contractSourceKeys.has(sourceRecordKey(record.companyId, record.sourceId))) {
        continue;
      }
      records.set(record.id, mergeConnectorRecord(records.get(record.id), record));
    }
  }
  return [...records.values()].sort((left, right) => {
    const statusDelta = statusRank(left.status) - statusRank(right.status);
    return statusDelta === 0 ? left.id.localeCompare(right.id) : statusDelta;
  });
}

function applyDisabledConnectorOverrides(
  records: readonly ConnectorRegistryRecord[],
  disabledOverrides: ReadonlyMap<string, DisabledConnectorOverride>
): readonly ConnectorRegistryRecord[] {
  return records.map((record) => {
    const override = disabledOverrides.get(record.id);
    if (!override) return record;
    return {
      ...record,
      enabled: false,
      disabledAt: override.disabledAt,
      disabledBy: override.disabledBy,
      disabledReason: override.reason
    };
  });
}

function connectorRecordsFromContracts(
  deployment: DeploymentArtifact
): readonly ConnectorRegistryRecord[] {
  const records: ConnectorRegistryRecord[] = [];
  for (const report of deployment.connectorContracts?.reports ?? []) {
    for (const contractCase of report.cases ?? []) {
      if (!contractCase.sourceId) continue;
      const connectorId =
        contractCase.connectorId ?? contractCase.adapterId ?? contractCase.sourceId;
      records.push({
        id: connectorRecordId(deployment.companyId, connectorId, contractCase.sourceId),
        companyId: deployment.companyId ?? report.companyId ?? "unknown-company",
        companyName: deployment.companyName ?? deployment.companyId ?? "Unknown company",
        profileId: report.profileId,
        namespaceId: report.namespaceId,
        sourceId: contractCase.sourceId,
        connectorId,
        sourceSystem: contractCase.sourceSystem ?? "unknown-source-system",
        adapterId: contractCase.adapterId,
        status: contractStatus(
          contractCase.status,
          contractCase.errorCount,
          contractCase.warningCount
        ),
        enabled: true,
        modes: contractCase.mode ? [contractCase.mode] : [],
        lastCheckedAt: report.requestedAt,
        runStatus: contractCase.runStatus,
        completeFullSync: contractCase.mode === "full" ? contractCase.complete === true : undefined,
        returnedRecordCount: contractCase.metrics?.returnedRecordCount ?? 0,
        deletedItemCount: contractCase.metrics?.deletedItemCount ?? 0,
        failedItemCount: contractCase.metrics?.failedItemCount ?? 0,
        warningCount: contractCase.warningCount ?? contractCase.metrics?.warningCount ?? 0,
        errorCount: contractCase.errorCount ?? 0
      });
    }
  }
  return records;
}

function connectorRecordsFromProfiles(
  deployment: DeploymentArtifact
): readonly ConnectorRegistryRecord[] {
  const records: ConnectorRegistryRecord[] = [];
  for (const profile of deployment.profiles ?? []) {
    const adapterId = profile.adapterIds?.[0];
    for (const sourceId of profile.sourceIds ?? []) {
      const connectorId = adapterId ?? sourceId;
      records.push({
        id: connectorRecordId(deployment.companyId, connectorId, sourceId),
        companyId: deployment.companyId ?? "unknown-company",
        companyName: deployment.companyName ?? deployment.companyId ?? "Unknown company",
        profileId: profile.id,
        namespaceId: profile.namespaceId,
        sourceId,
        connectorId,
        sourceSystem: adapterId ?? "unknown-source-system",
        adapterId,
        status: deploymentStatus(deployment),
        enabled: deployment.status === "ready",
        modes: [],
        returnedRecordCount: 0,
        deletedItemCount: 0,
        failedItemCount: 0,
        warningCount: deployment.warningCount ?? 0,
        errorCount: deployment.errorCount ?? 0
      });
    }
  }
  return records;
}

function mergeConnectorRecord(
  current: ConnectorRegistryRecord | undefined,
  next: ConnectorRegistryRecord
): ConnectorRegistryRecord {
  if (!current) return next;
  const status =
    statusRank(next.status) < statusRank(current.status) ? next.status : current.status;
  return {
    ...current,
    ...next,
    status,
    modes: uniqueSorted([...current.modes, ...next.modes]),
    returnedRecordCount: current.returnedRecordCount + next.returnedRecordCount,
    deletedItemCount: current.deletedItemCount + next.deletedItemCount,
    failedItemCount: current.failedItemCount + next.failedItemCount,
    warningCount: current.warningCount + next.warningCount,
    errorCount: current.errorCount + next.errorCount,
    lastCheckedAt: newestIso(current.lastCheckedAt, next.lastCheckedAt)
  };
}

function contractStatus(
  status: string | undefined,
  errorCount: number | undefined,
  warningCount: number | undefined
): ConnectorStatus {
  if ((errorCount ?? 0) > 0 || status === "failed") return "failed";
  if ((warningCount ?? 0) > 0) return "warning";
  if (status === "passed") return "passed";
  return "unknown";
}

function deploymentStatus(deployment: DeploymentArtifact): ConnectorStatus {
  if ((deployment.errorCount ?? 0) > 0 || deployment.status === "failed") return "failed";
  if ((deployment.warningCount ?? 0) > 0) return "warning";
  if (deployment.status === "ready") return "passed";
  return "unknown";
}

function connectorRecordId(
  companyId: string | undefined,
  connectorId: string,
  sourceId: string
): string {
  return [companyId ?? "company", connectorId, sourceId].join(":");
}

function sourceRecordKey(companyId: string, sourceId: string): string {
  return `${companyId}:${sourceId}`;
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(/*turbopackIgnore: true*/ filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function companyRoot(): string {
  const configured = process.env.RAG_ADMIN_COMPANY_DIR?.trim();
  if (configured) {
    return path.resolve(/*turbopackIgnore: true*/ configured);
  }
  return path.join(/*turbopackIgnore: true*/ resolveRagRepoRoot(), ".rag", "company");
}

function statusRank(status: ConnectorStatus): number {
  switch (status) {
    case "failed":
      return 0;
    case "warning":
      return 1;
    case "unknown":
      return 2;
    case "passed":
      return 3;
  }
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function newestIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}
