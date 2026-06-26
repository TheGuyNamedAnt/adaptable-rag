import type { SourceKind } from "../documents/provenance.js";
import type { SourceSensitivity, TrustTier } from "../documents/trust-tier.js";
import type { ConnectorAclMapper } from "../security/connector-acl-mapper.js";
import type {
  CorpusAdapter,
  CorpusAdapterWarning,
  CorpusLoadRequest,
  CorpusLoadResult
} from "./adapter.js";
import type { CorpusRecord, CorpusRecordMetadata } from "./corpus-record.js";
import {
  mapStructuredCorpusRecord,
  redactDiagnosticMessage,
  structuredDefaults,
  type StructuredRecordFieldMapping,
  type StructuredRecordMappingWarningCode
} from "./structured-record-mapper.js";

export const SAAS_CORPUS_ADAPTER_ID = "saas-api";

export type SaasCorpusParameterValue = string | number | boolean | null;
export type SaasCorpusParameters = Readonly<Record<string, SaasCorpusParameterValue>>;

export type SaasCorpusWarningCode =
  | "missing_source_config"
  | "saas_fetch_failed"
  | "saas_client_warning"
  | "saas_invalid_page"
  | "saas_records_truncated"
  | "saas_page_limit_reached"
  | "saas_cursor_repeated"
  | StructuredRecordMappingWarningCode;

export interface SaasCorpusPageRequest {
  readonly sourceId: string;
  readonly endpointId: string;
  readonly parameters: SaasCorpusParameters;
  readonly cursor?: string;
  readonly pageSize: number;
  readonly requestedByTenantId: string;
  readonly runId: string;
  readonly requestedAt: string;
}

export interface SaasCorpusPageResult {
  readonly items: readonly unknown[];
  readonly nextCursor?: string;
  readonly warnings?: readonly string[];
}

export interface SaasCorpusClient {
  fetchPage(request: SaasCorpusPageRequest): Promise<SaasCorpusPageResult>;
}

export interface SaasCorpusSourceConfig {
  readonly sourceId: string;
  readonly endpointId: string;
  readonly parameters?: SaasCorpusParameters;
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly maxRecords?: number;
  readonly idPrefix?: string;
  readonly pathPrefix?: string;
  readonly originUriBase?: string;
  readonly sourceKind?: SourceKind;
  readonly trustTier?: TrustTier;
  readonly sensitivity?: SourceSensitivity;
  readonly accessScope?: SaasCorpusAccessScopeConfig;
  readonly aclMapper?: ConnectorAclMapper;
  readonly capturedAt?: string;
  readonly owner?: string;
  readonly metadata?: CorpusRecordMetadata;
  readonly mapping: StructuredRecordFieldMapping;
}

export interface SaasCorpusAccessScopeConfig {
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly teamIds?: readonly string[];
  readonly userIds?: readonly string[];
  readonly roles?: readonly string[];
  readonly tags?: readonly string[];
}

export interface SaasCorpusAdapterOptions {
  readonly id?: string;
  readonly description?: string;
  readonly client: SaasCorpusClient;
  readonly sources: readonly SaasCorpusSourceConfig[];
  readonly defaultPageSize?: number;
  readonly defaultMaxPages?: number;
  readonly defaultMaxRecords?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_RECORDS = 1_000;

export class SaasCorpusAdapter implements CorpusAdapter {
  readonly id: string;
  readonly description: string;

  private readonly client: SaasCorpusClient;
  private readonly sources: ReadonlyMap<string, SaasCorpusSourceConfig>;
  private readonly defaultPageSize: number;
  private readonly defaultMaxPages: number;
  private readonly defaultMaxRecords: number;

  constructor(options: SaasCorpusAdapterOptions) {
    this.id = options.id ?? SAAS_CORPUS_ADAPTER_ID;
    this.description =
      options.description ?? "Loads paginated SaaS/API objects as structured corpus records.";
    this.client = options.client;
    this.sources = sourceConfigMap(options.sources);
    this.defaultPageSize = positiveInteger(options.defaultPageSize, DEFAULT_PAGE_SIZE);
    this.defaultMaxPages = positiveInteger(options.defaultMaxPages, DEFAULT_MAX_PAGES);
    this.defaultMaxRecords = positiveInteger(options.defaultMaxRecords, DEFAULT_MAX_RECORDS);

    if (!this.id.trim()) {
      throw new Error("SaasCorpusAdapter id is required.");
    }
  }

  async load(request: CorpusLoadRequest): Promise<CorpusLoadResult> {
    const warnings: CorpusAdapterWarning[] = [];
    const config = this.sources.get(request.source.id);

    if (!config) {
      warnings.push(
        warning(
          request.source.id,
          "missing_source_config",
          `No SaaS source config exists for source "${request.source.id}".`
        )
      );
      return {
        sourceId: request.source.id,
        records: [],
        warnings
      };
    }

    const pageSize = positiveInteger(config.pageSize, this.defaultPageSize);
    const maxPages = positiveInteger(config.maxPages, this.defaultMaxPages);
    const maxRecords = positiveInteger(config.maxRecords, this.defaultMaxRecords);
    const records: CorpusRecord[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let hitRecordLimit = false;
    let itemIndex = 0;

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      if (cursor) {
        if (seenCursors.has(cursor)) {
          warnings.push(
            warning(
              request.source.id,
              "saas_cursor_repeated",
              `SaaS cursor repeated before page ${pageIndex}; pagination stopped.`
            )
          );
          break;
        }
        seenCursors.add(cursor);
      }

      const page = await fetchPage(this.client, config, request, pageSize, cursor, warnings);
      if (!page) {
        break;
      }

      if (!Array.isArray(page.items)) {
        warnings.push(
          warning(
            request.source.id,
            "saas_invalid_page",
            `SaaS endpoint "${config.endpointId}" returned a page without an items array.`
          )
        );
        break;
      }

      for (const item of page.items) {
        if (records.length >= maxRecords) {
          hitRecordLimit = true;
          break;
        }

        const mapped = mapStructuredCorpusRecord({
          sourceId: request.source.id,
          source: request.source,
          item,
          itemIndex,
          mapping: config.mapping,
          defaults: structuredDefaults({
            sourceKind: config.sourceKind ?? "api_response",
            trustTier: config.trustTier,
            trustTierFallback: request.source.trustTierFloor,
            sensitivity: config.sensitivity,
            accessScope: config.accessScope,
            owner: config.owner,
            capturedAt: config.capturedAt,
            metadata: config.metadata
          }),
          requestedBy: request.requestedBy,
          profileNamespaceId: request.profile.namespaceId,
          sourceTags: request.source.tags,
          aclMapper: config.aclMapper,
          fallbackCapturedAt: request.requestedAt,
          idPrefix: config.idPrefix,
          originUriBase: config.originUriBase,
          pathPrefix: config.pathPrefix
        });
        warnings.push(...mapped.warnings);
        if (mapped.record) {
          records.push(mapped.record);
        }
        itemIndex += 1;
      }

      if (hitRecordLimit) {
        warnings.push(
          warning(
            request.source.id,
            "saas_records_truncated",
            `SaaS source hit the maxRecords limit of ${maxRecords}; remaining items were not loaded.`
          )
        );
        break;
      }

      cursor =
        typeof page.nextCursor === "string" && page.nextCursor.trim() ? page.nextCursor : undefined;
      if (!cursor) {
        break;
      }

      if (pageIndex === maxPages - 1) {
        warnings.push(
          warning(
            request.source.id,
            "saas_page_limit_reached",
            `SaaS source hit the maxPages limit of ${maxPages}; remaining pages were not loaded.`
          )
        );
      }
    }

    return {
      sourceId: request.source.id,
      records,
      warnings
    };
  }
}

async function fetchPage(
  client: SaasCorpusClient,
  config: SaasCorpusSourceConfig,
  request: CorpusLoadRequest,
  pageSize: number,
  cursor: string | undefined,
  warnings: CorpusAdapterWarning[]
): Promise<SaasCorpusPageResult | undefined> {
  try {
    const page = await requestPage(client, config, request, pageSize, cursor);
    for (const clientWarning of page.warnings ?? []) {
      warnings.push(
        warning(
          request.source.id,
          "saas_client_warning",
          `SaaS client warning: ${redactDiagnosticMessage(clientWarning)}`
        )
      );
    }
    return page;
  } catch (error) {
    warnings.push(
      warning(
        request.source.id,
        "saas_fetch_failed",
        `SaaS fetch failed: ${redactDiagnosticMessage(error)}`
      )
    );
    return undefined;
  }
}

function requestPage(
  client: SaasCorpusClient,
  config: SaasCorpusSourceConfig,
  request: CorpusLoadRequest,
  pageSize: number,
  cursor: string | undefined
): Promise<SaasCorpusPageResult> {
  const pageRequest: SaasCorpusPageRequest = {
    sourceId: request.source.id,
    endpointId: config.endpointId,
    parameters: config.parameters ?? {},
    pageSize,
    requestedByTenantId: request.requestedBy.tenantId,
    runId: request.runId,
    requestedAt: request.requestedAt,
    ...(cursor ? { cursor } : {})
  };

  return client.fetchPage(pageRequest);
}

function sourceConfigMap(
  configs: readonly SaasCorpusSourceConfig[]
): ReadonlyMap<string, SaasCorpusSourceConfig> {
  const map = new Map<string, SaasCorpusSourceConfig>();

  for (const config of configs) {
    if (!config.sourceId.trim()) {
      throw new Error("SaaS source config sourceId is required.");
    }

    if (!config.endpointId.trim()) {
      throw new Error(`SaaS source config "${config.sourceId}" endpointId is required.`);
    }

    if (map.has(config.sourceId)) {
      throw new Error(`Duplicate SaaS source config "${config.sourceId}".`);
    }

    map.set(config.sourceId, config);
  }

  return map;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected positive integer, received ${value}.`);
  }

  return value;
}

function warning(
  sourceId: string,
  code: SaasCorpusWarningCode,
  message: string
): CorpusAdapterWarning {
  return {
    sourceId,
    code,
    message
  };
}
