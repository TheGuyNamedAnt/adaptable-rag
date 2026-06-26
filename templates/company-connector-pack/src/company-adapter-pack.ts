import {
  ownerDefinedAclMapper,
  type AccessScope,
  type CompanyAdapterPack,
  type ConnectorAclMapper,
  type CorpusAdapter,
  type CorpusLoadRequest,
  type CorpusLoadResult,
  type CorpusRecord,
  type SourceConnector,
  type SourceConnectorSyncRequest,
  type SourceConnectorSyncResult
} from "adaptable-rag";

export interface CompanyDocsNativeAcl {
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly teamIds?: readonly string[];
  readonly userIds?: readonly string[];
  readonly roles?: readonly string[];
  readonly tags?: readonly string[];
}

interface NormalizedCompanyDocsNativeAcl {
  readonly tenantId: string | undefined;
  readonly namespaceId: string | undefined;
  readonly teamIds: readonly string[];
  readonly userIds: readonly string[];
  readonly roles: readonly string[];
  readonly tags: readonly string[];
}

export interface CompanyDocsItem {
  readonly sourceItemId: string;
  readonly recordId: string;
  readonly title: string;
  readonly body: string;
  readonly updatedAt: string;
  readonly checksum: string;
  readonly version?: string;
  readonly originUri?: string;
  readonly owner?: string;
  readonly nativeAcl: CompanyDocsNativeAcl;
}

export type CompanyDocsSyncItem =
  | {
      readonly operation: "upsert";
      readonly item: CompanyDocsItem;
    }
  | {
      readonly operation: "delete";
      readonly sourceItemId: string;
      readonly recordId: string;
      readonly deletedAt: string;
      readonly version?: string;
    }
  | {
      readonly operation: "error";
      readonly sourceItemId: string;
      readonly recordId?: string;
      readonly errorCode: string;
      readonly message: string;
      readonly retryable?: boolean;
    };

export interface CompanyDocsPage {
  readonly items: readonly CompanyDocsItem[];
  readonly cursor?: string;
}

export interface CompanyDocsSyncPage {
  readonly items: readonly CompanyDocsSyncItem[];
  readonly cursor?: string;
  readonly complete: boolean;
}

export interface CompanyDocsClient {
  listDocuments(input: {
    readonly sourceId: string;
    readonly requestedAt: string;
    readonly maxRecords?: number;
  }): Promise<CompanyDocsPage>;
  listChangedDocuments(input: {
    readonly sourceId: string;
    readonly mode: "delta" | "full";
    readonly requestedAt: string;
    readonly cursor?: string;
    readonly maxRecords?: number;
  }): Promise<CompanyDocsSyncPage>;
}

export interface CompanyConnectorAdapterPackOptions {
  readonly client: CompanyDocsClient;
  readonly companyId?: string;
  readonly packId?: string;
}

export const companyDocsClient: CompanyDocsClient = {
  async listDocuments(): Promise<CompanyDocsPage> {
    throw new Error("Replace companyDocsClient with the company-owned source client.");
  },
  async listChangedDocuments(): Promise<CompanyDocsSyncPage> {
    throw new Error("Replace companyDocsClient with the company-owned source client.");
  }
};

export const companyAdapterPack = createCompanyConnectorAdapterPack({
  client: companyDocsClient
});

export function createCompanyConnectorAdapterPack(
  options: CompanyConnectorAdapterPackOptions
): CompanyAdapterPack {
  return {
    id: options.packId ?? "company-docs-pack",
    companyId: options.companyId ?? "company_docs",
    description: "Company documentation connector pack.",
    corpusAdapters: [new CompanyDocsCorpusAdapter(options.client)],
    sourceConnectors: [new CompanyDocsSourceConnector(options.client)],
    permissionMappers: [
      {
        sourceSystem: "company-docs-api",
        mapper: companyDocsPermissionMapper
      }
    ],
    connectorTests: [
      {
        connectorId: "company_docs_api",
        command:
          "npm run company:validate -- --module dist/company/company-profile.js --export companyProfile --adapter-pack-export companyAdapterPack --run-pack-contracts --use-case docs"
      }
    ]
  };
}

export const companyDocsPermissionMapper: ConnectorAclMapper = ownerDefinedAclMapper({
  id: "company-docs-acl-mapper",
  description: "Maps company documentation ACLs into tenant, namespace, and principal scopes.",
  map(input) {
    const nativeAcl = normalizeNativeAcl(input.nativeAcl);
    const tags = uniqueStrings([...input.context.defaultTags, ...nativeAcl.tags]);

    return {
      tenantId: nativeAcl.tenantId ?? input.context.defaultTenantId,
      namespaceId: nativeAcl.namespaceId ?? input.context.defaultNamespaceId,
      ...(nativeAcl.teamIds.length === 0 ? {} : { teamIds: nativeAcl.teamIds }),
      ...(nativeAcl.userIds.length === 0 ? {} : { userIds: nativeAcl.userIds }),
      ...(nativeAcl.roles.length === 0 ? {} : { roles: nativeAcl.roles }),
      ...(tags.length === 0 ? {} : { tags })
    };
  }
});

export class CompanyDocsCorpusAdapter implements CorpusAdapter {
  readonly id = "company-docs-api";
  readonly description = "Loads approved company documentation records.";
  private readonly client: CompanyDocsClient;

  constructor(client: CompanyDocsClient) {
    this.client = client;
  }

  async load(request: CorpusLoadRequest): Promise<CorpusLoadResult> {
    const page = await this.client.listDocuments({
      sourceId: request.source.id,
      requestedAt: request.requestedAt
    });

    return {
      sourceId: request.source.id,
      records: page.items.map((item) => recordFromCompanyDocsItem(item, request)),
      warnings: []
    };
  }
}

export class CompanyDocsSourceConnector implements SourceConnector {
  readonly id = "company_docs_api";
  readonly description = "Syncs approved company documentation changes.";
  private readonly client: CompanyDocsClient;

  constructor(client: CompanyDocsClient) {
    this.client = client;
  }

  async sync(request: SourceConnectorSyncRequest): Promise<SourceConnectorSyncResult> {
    const page = await this.client.listChangedDocuments({
      sourceId: request.source.id,
      mode: request.mode,
      requestedAt: request.requestedAt,
      ...(request.previousCursor === undefined ? {} : { cursor: request.previousCursor })
    });

    return {
      sourceId: request.source.id,
      items: page.items.map((item) => sourceConnectorItem(item, request)),
      ...(page.cursor === undefined ? {} : { nextCursor: page.cursor }),
      complete: page.complete
    };
  }
}

function sourceConnectorItem(item: CompanyDocsSyncItem, request: SourceConnectorSyncRequest) {
  if (item.operation === "upsert") {
    return {
      operation: "upsert" as const,
      sourceItemId: item.item.sourceItemId,
      ...(item.item.version === undefined ? {} : { version: item.item.version }),
      record: recordFromCompanyDocsItem(item.item, request),
      sourceAcl: redactedAclFingerprint(item.item.nativeAcl)
    };
  }

  if (item.operation === "delete") {
    return {
      operation: "delete" as const,
      sourceItemId: item.sourceItemId,
      recordId: item.recordId,
      deletedAt: item.deletedAt,
      ...(item.version === undefined ? {} : { version: item.version })
    };
  }

  return {
    operation: "error" as const,
    sourceItemId: item.sourceItemId,
    ...(item.recordId === undefined ? {} : { recordId: item.recordId }),
    errorCode: item.errorCode,
    message: item.message,
    retryable: item.retryable ?? true
  };
}

function recordFromCompanyDocsItem(
  item: CompanyDocsItem,
  request: CorpusLoadRequest | SourceConnectorSyncRequest
): CorpusRecord {
  return {
    id: item.recordId,
    sourceId: request.source.id,
    sourceKind: "api_response",
    title: item.title,
    body: item.body,
    trustTier: "trusted_internal",
    sensitivity: "internal",
    accessScope: accessScopeForItem(item, request),
    ...(item.originUri === undefined ? {} : { originUri: item.originUri }),
    ...(item.owner === undefined ? {} : { owner: item.owner }),
    capturedAt: item.updatedAt,
    checksum: item.checksum,
    metadata: {
      source_item_id: item.sourceItemId,
      source_system: "company-docs-api"
    }
  };
}

function accessScopeForItem(
  item: CompanyDocsItem,
  request: CorpusLoadRequest | SourceConnectorSyncRequest
): AccessScope {
  return companyDocsPermissionMapper.map({
    nativeAcl: item.nativeAcl,
    context: {
      source: request.source,
      requestedBy: request.requestedBy,
      defaultTenantId: request.requestedBy.tenantId,
      defaultNamespaceId: request.profile.namespaceId,
      defaultTags: request.source.tags ?? []
    }
  });
}

function normalizeNativeAcl(nativeAcl: unknown): NormalizedCompanyDocsNativeAcl {
  if (!isRecord(nativeAcl)) {
    return emptyNativeAcl();
  }

  return {
    tenantId: optionalString(nativeAcl["tenantId"]),
    namespaceId: optionalString(nativeAcl["namespaceId"]),
    teamIds: stringArray(nativeAcl["teamIds"]),
    userIds: stringArray(nativeAcl["userIds"]),
    roles: stringArray(nativeAcl["roles"]),
    tags: stringArray(nativeAcl["tags"])
  };
}

function emptyNativeAcl(): NormalizedCompanyDocsNativeAcl {
  return {
    tenantId: undefined,
    namespaceId: undefined,
    teamIds: [],
    userIds: [],
    roles: [],
    tags: []
  };
}

function redactedAclFingerprint(nativeAcl: CompanyDocsNativeAcl): Readonly<Record<string, number>> {
  return {
    teamCount: nativeAcl.teamIds?.length ?? 0,
    userCount: nativeAcl.userIds?.length ?? 0,
    roleCount: nativeAcl.roles?.length ?? 0,
    tagCount: nativeAcl.tags?.length ?? 0
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
