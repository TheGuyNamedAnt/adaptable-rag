import type { IndexFilter } from "./index-types.js";
import { hashStableValue } from "../shared/stable-hash.js";

export type IndexFilterValidationCode =
  | "missing_filter"
  | "missing_namespace"
  | "missing_tenant"
  | "missing_principal"
  | "tenant_mismatch"
  | "namespace_not_granted"
  | "invalid_filter_list"
  | "invalid_limit";

export interface IndexFilterValidationIssue {
  readonly code: IndexFilterValidationCode;
  readonly path: string;
  readonly message: string;
}

export interface IndexFilterValidationResult {
  readonly valid: boolean;
  readonly issues: readonly IndexFilterValidationIssue[];
}

export interface IndexTraceFilter {
  readonly namespaceId: string;
  readonly tenantId: string;
  readonly principalHash: string;
  readonly principalNamespaceCount: number;
  readonly principalTeamCount: number;
  readonly principalRoleCount: number;
  readonly principalTagCount: number;
  readonly documentIdCount: number;
  readonly chunkIdCount: number;
  readonly sourceIdCount: number;
  readonly sourceKindCount: number;
  readonly trustTierCount: number;
  readonly includeSafetyFlagCount: number;
  readonly excludeSafetyFlagCount: number;
  readonly accessTagCount: number;
  readonly limit?: number;
}

const LIST_FIELDS = [
  "documentIds",
  "chunkIds",
  "sourceIds",
  "sourceKinds",
  "trustTiers",
  "includeSafetyFlags",
  "excludeSafetyFlags",
  "accessTags"
] as const;

export function validateIndexFilter(filter: unknown): IndexFilterValidationResult {
  const issues: IndexFilterValidationIssue[] = [];

  if (!isRecord(filter)) {
    return result([
      issue(
        "missing_filter",
        "filter",
        "Index reads require a tenant, namespace, and principal filter."
      )
    ]);
  }

  const namespaceId = stringField(filter["namespaceId"]);
  const tenantId = stringField(filter["tenantId"]);
  const principal = filter["principal"];

  if (!namespaceId.trim()) {
    issues.push(issue("missing_namespace", "namespaceId", "Index filter namespaceId is required."));
  }

  if (!tenantId.trim()) {
    issues.push(issue("missing_tenant", "tenantId", "Index filter tenantId is required."));
  }

  if (!isRecord(principal)) {
    issues.push(issue("missing_principal", "principal", "Index filter principal is required."));
  } else {
    const principalTenantId = stringField(principal["tenantId"]);
    const namespaceIds = stringArray(principal["namespaceIds"]);

    if (
      !stringField(principal["userId"]).trim() ||
      !principalTenantId.trim() ||
      !namespaceIds ||
      namespaceIds.length === 0 ||
      !stringArray(principal["teamIds"]) ||
      !stringArray(principal["roles"]) ||
      !stringArray(principal["tags"])
    ) {
      issues.push(
        issue(
          "missing_principal",
          "principal",
          "Principal must include userId, tenantId, namespaceIds, teamIds, roles, and tags."
        )
      );
    }

    if (tenantId.trim() && principalTenantId.trim() && tenantId !== principalTenantId) {
      issues.push(
        issue("tenant_mismatch", "tenantId", "Index filter tenantId must match principal tenantId.")
      );
    }

    if (namespaceId.trim() && namespaceIds && !namespaceIds.includes(namespaceId)) {
      issues.push(
        issue(
          "namespace_not_granted",
          "namespaceId",
          "Principal is not granted the requested namespaceId."
        )
      );
    }
  }

  for (const field of LIST_FIELDS) {
    const value = filter[field];
    if (value !== undefined && !stringArray(value)) {
      issues.push(
        issue("invalid_filter_list", field, `${field} must be an array of strings when provided.`)
      );
    }
  }

  const limit = filter["limit"];
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0)) {
    issues.push(
      issue("invalid_limit", "limit", "Index filter limit must be a non-negative integer.")
    );
  }

  return result(issues);
}

export function assertValidIndexFilter(filter: unknown): asserts filter is IndexFilter {
  const validation = validateIndexFilter(filter);
  if (!validation.valid) {
    const details = validation.issues
      .map((validationIssue) => `${validationIssue.path}: ${validationIssue.message}`)
      .join("\n");
    throw new Error(`Invalid index filter:\n${details}`);
  }
}

export function isValidIndexFilter(filter: unknown): filter is IndexFilter {
  return validateIndexFilter(filter).valid;
}

export function redactIndexFilterForTrace(filter: IndexFilter): IndexTraceFilter {
  return {
    namespaceId: filter.namespaceId,
    tenantId: filter.tenantId,
    principalHash: hashStableValue({
      userId: filter.principal.userId,
      tenantId: filter.principal.tenantId,
      namespaceIds: filter.principal.namespaceIds,
      teamIds: filter.principal.teamIds,
      roles: filter.principal.roles,
      tags: filter.principal.tags
    }),
    principalNamespaceCount: filter.principal.namespaceIds.length,
    principalTeamCount: filter.principal.teamIds.length,
    principalRoleCount: filter.principal.roles.length,
    principalTagCount: filter.principal.tags.length,
    documentIdCount: filter.documentIds?.length ?? 0,
    chunkIdCount: filter.chunkIds?.length ?? 0,
    sourceIdCount: filter.sourceIds?.length ?? 0,
    sourceKindCount: filter.sourceKinds?.length ?? 0,
    trustTierCount: filter.trustTiers?.length ?? 0,
    includeSafetyFlagCount: filter.includeSafetyFlags?.length ?? 0,
    excludeSafetyFlagCount: filter.excludeSafetyFlags?.length ?? 0,
    accessTagCount: filter.accessTags?.length ?? 0,
    ...(filter.limit !== undefined ? { limit: filter.limit } : {})
  };
}

function result(issues: readonly IndexFilterValidationIssue[]): IndexFilterValidationResult {
  return {
    valid: issues.length === 0,
    issues
  };
}

function issue(
  code: IndexFilterValidationCode,
  path: string,
  message: string
): IndexFilterValidationIssue {
  return {
    code,
    path,
    message
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.every((item) => typeof item === "string") ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
