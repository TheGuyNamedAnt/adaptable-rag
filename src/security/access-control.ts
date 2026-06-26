import type { AccessDecision, AccessScope, RequestPrincipal } from "./access-scope.js";
import { hashStableValue } from "../shared/stable-hash.js";

export type AccessDenialReason =
  | "invalid_principal"
  | "missing_resource_scope"
  | "tenant_mismatch"
  | "namespace_not_granted"
  | "user_not_granted"
  | "team_not_granted"
  | "role_not_granted"
  | "tag_not_granted";

export interface DetailedAccessDecision extends AccessDecision {
  readonly allowed: boolean;
  readonly reason: AccessDenialReason | "allowed";
}

export interface AccessDecisionAudit {
  readonly allowed: boolean;
  readonly reason: AccessDenialReason | "allowed";
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly principalHash: string;
  readonly scopeHash: string;
  readonly scopedUserCount: number;
  readonly scopedTeamCount: number;
  readonly scopedRoleCount: number;
  readonly scopedTagCount: number;
}

export function evaluateAccess(
  principal: RequestPrincipal,
  scope: AccessScope
): DetailedAccessDecision {
  const principalValidation = validatePrincipal(principal);
  if (principalValidation) {
    return deny("invalid_principal");
  }

  if (!scope.tenantId.trim() || !scope.namespaceId.trim()) {
    return deny("missing_resource_scope");
  }

  if (scope.tenantId !== principal.tenantId) {
    return deny("tenant_mismatch");
  }

  if (!principal.namespaceIds.includes(scope.namespaceId)) {
    return deny("namespace_not_granted");
  }

  if (scope.userIds && scope.userIds.length > 0 && !scope.userIds.includes(principal.userId)) {
    return deny("user_not_granted");
  }

  if (scope.teamIds && scope.teamIds.length > 0 && !intersects(scope.teamIds, principal.teamIds)) {
    return deny("team_not_granted");
  }

  if (scope.roles && scope.roles.length > 0 && !intersects(scope.roles, principal.roles)) {
    return deny("role_not_granted");
  }

  if (scope.tags && scope.tags.length > 0 && !containsAll(principal.tags, scope.tags)) {
    return deny("tag_not_granted");
  }

  return {
    allowed: true,
    reason: "allowed"
  };
}

export function assertAccessAllowed(principal: RequestPrincipal, scope: AccessScope): void {
  const decision = evaluateAccess(principal, scope);
  if (!decision.allowed) {
    throw new Error(`Access denied: ${decision.reason}`);
  }
}

export function accessDecisionAudit(
  principal: RequestPrincipal,
  scope: AccessScope,
  decision: DetailedAccessDecision = evaluateAccess(principal, scope)
): AccessDecisionAudit {
  return {
    allowed: decision.allowed,
    reason: decision.reason,
    tenantId: scope.tenantId,
    namespaceId: scope.namespaceId,
    principalHash: hashStableValue({
      userId: principal.userId,
      tenantId: principal.tenantId,
      namespaceIds: principal.namespaceIds,
      teamIds: principal.teamIds,
      roles: principal.roles,
      tags: principal.tags
    }),
    scopeHash: hashStableValue(scope),
    scopedUserCount: scope.userIds?.length ?? 0,
    scopedTeamCount: scope.teamIds?.length ?? 0,
    scopedRoleCount: scope.roles?.length ?? 0,
    scopedTagCount: scope.tags?.length ?? 0
  };
}

function validatePrincipal(principal: RequestPrincipal): AccessDenialReason | undefined {
  if (
    !principal.userId.trim() ||
    !principal.tenantId.trim() ||
    principal.namespaceIds.length === 0
  ) {
    return "invalid_principal";
  }

  return undefined;
}

function deny(reason: AccessDenialReason): DetailedAccessDecision {
  return {
    allowed: false,
    reason
  };
}

function intersects(first: readonly string[], second: readonly string[]): boolean {
  return first.some((value) => second.includes(value));
}

function containsAll(values: readonly string[], required: readonly string[]): boolean {
  return required.every((value) => values.includes(value));
}
