export interface AccessScope {
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly teamIds?: readonly string[];
  readonly userIds?: readonly string[];
  readonly roles?: readonly string[];
  readonly tags?: readonly string[];
}

export interface RequestPrincipal {
  readonly userId: string;
  readonly tenantId: string;
  readonly namespaceIds: readonly string[];
  readonly teamIds: readonly string[];
  readonly roles: readonly string[];
  readonly tags: readonly string[];
}

export interface AccessDecision {
  readonly allowed: boolean;
  readonly reason: string;
}
