import type { AccessScope, RequestPrincipal } from "./access-scope.js";

export interface ConnectorAclSourceRef {
  readonly id: string;
  readonly adapter: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly tags?: readonly string[];
}

export interface ConnectorAclMappingContext {
  readonly source: ConnectorAclSourceRef;
  readonly requestedBy: RequestPrincipal;
  readonly defaultTenantId: string;
  readonly defaultNamespaceId: string;
  readonly defaultTags: readonly string[];
}

export interface ConnectorAclMappingInput {
  readonly nativeAcl: unknown;
  readonly context: ConnectorAclMappingContext;
}

export interface ConnectorAclMapper {
  readonly id: string;
  readonly description: string;
  map(input: ConnectorAclMappingInput): AccessScope;
}

export function ownerDefinedAclMapper(options: {
  readonly id: string;
  readonly description?: string;
  readonly map: (input: ConnectorAclMappingInput) => AccessScope;
}): ConnectorAclMapper {
  if (!options.id.trim()) {
    throw new Error("ConnectorAclMapper id is required.");
  }

  return {
    id: options.id,
    description: options.description ?? "Owner-defined connector ACL mapper.",
    map: options.map
  };
}
