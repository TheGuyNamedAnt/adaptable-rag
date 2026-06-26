import type { SourceKind } from "../documents/provenance.js";
import type { SourceSensitivity, TrustTier } from "../documents/trust-tier.js";
import type { ConnectorAclMapper } from "../security/connector-acl-mapper.js";
import type {
  CorpusAdapter,
  CorpusAdapterWarning,
  CorpusLoadRequest,
  CorpusLoadResult
} from "./adapter.js";
import type { CorpusRecordMetadata } from "./corpus-record.js";
import {
  mapStructuredCorpusRecord,
  redactDiagnosticMessage,
  structuredDefaults,
  type StructuredRecordFieldMapping,
  type StructuredRecordMappingWarningCode
} from "./structured-record-mapper.js";

export const DATABASE_CORPUS_ADAPTER_ID = "database";

export type DatabaseCorpusParameterValue = string | number | boolean | null;
export type DatabaseCorpusParameters = Readonly<Record<string, DatabaseCorpusParameterValue>>;

export type DatabaseCorpusWarningCode =
  | "missing_source_config"
  | "database_query_failed"
  | "database_client_warning"
  | "database_rows_truncated"
  | StructuredRecordMappingWarningCode;

export interface DatabaseCorpusQueryRequest {
  readonly sourceId: string;
  readonly queryName: string;
  readonly parameters: DatabaseCorpusParameters;
  readonly maxRows: number;
  readonly requestedByTenantId: string;
  readonly runId: string;
  readonly requestedAt: string;
}

export interface DatabaseCorpusQueryResult {
  readonly rows: readonly unknown[];
  readonly warnings?: readonly string[];
}

export interface DatabaseCorpusClient {
  query(request: DatabaseCorpusQueryRequest): Promise<DatabaseCorpusQueryResult>;
}

export interface DatabaseCorpusSourceConfig {
  readonly sourceId: string;
  readonly queryName: string;
  readonly parameters?: DatabaseCorpusParameters;
  readonly maxRows?: number;
  readonly idPrefix?: string;
  readonly pathPrefix?: string;
  readonly originUriBase?: string;
  readonly sourceKind?: SourceKind;
  readonly trustTier?: TrustTier;
  readonly sensitivity?: SourceSensitivity;
  readonly accessScope?: DatabaseCorpusAccessScopeConfig;
  readonly aclMapper?: ConnectorAclMapper;
  readonly capturedAt?: string;
  readonly owner?: string;
  readonly metadata?: CorpusRecordMetadata;
  readonly mapping: StructuredRecordFieldMapping;
}

export interface DatabaseCorpusAccessScopeConfig {
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly teamIds?: readonly string[];
  readonly userIds?: readonly string[];
  readonly roles?: readonly string[];
  readonly tags?: readonly string[];
}

export interface DatabaseCorpusAdapterOptions {
  readonly id?: string;
  readonly description?: string;
  readonly client: DatabaseCorpusClient;
  readonly sources: readonly DatabaseCorpusSourceConfig[];
  readonly defaultMaxRows?: number;
}

const DEFAULT_MAX_ROWS = 1_000;

export class DatabaseCorpusAdapter implements CorpusAdapter {
  readonly id: string;
  readonly description: string;

  private readonly client: DatabaseCorpusClient;
  private readonly sources: ReadonlyMap<string, DatabaseCorpusSourceConfig>;
  private readonly defaultMaxRows: number;

  constructor(options: DatabaseCorpusAdapterOptions) {
    this.id = options.id ?? DATABASE_CORPUS_ADAPTER_ID;
    this.description =
      options.description ?? "Loads database query rows as structured corpus records.";
    this.client = options.client;
    this.sources = sourceConfigMap(options.sources);
    this.defaultMaxRows = positiveInteger(options.defaultMaxRows, DEFAULT_MAX_ROWS);

    if (!this.id.trim()) {
      throw new Error("DatabaseCorpusAdapter id is required.");
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
          `No database source config exists for source "${request.source.id}".`
        )
      );
      return {
        sourceId: request.source.id,
        records: [],
        warnings
      };
    }

    const maxRows = positiveInteger(config.maxRows, this.defaultMaxRows);
    let queryResult: DatabaseCorpusQueryResult;
    try {
      queryResult = await this.client.query({
        sourceId: request.source.id,
        queryName: config.queryName,
        parameters: config.parameters ?? {},
        maxRows,
        requestedByTenantId: request.requestedBy.tenantId,
        runId: request.runId,
        requestedAt: request.requestedAt
      });
    } catch (error) {
      warnings.push(
        warning(
          request.source.id,
          "database_query_failed",
          `Database query failed: ${redactDiagnosticMessage(error)}`
        )
      );
      return {
        sourceId: request.source.id,
        records: [],
        warnings
      };
    }

    for (const clientWarning of queryResult.warnings ?? []) {
      warnings.push(
        warning(
          request.source.id,
          "database_client_warning",
          `Database client warning: ${redactDiagnosticMessage(clientWarning)}`
        )
      );
    }

    const rows = queryResult.rows.slice(0, maxRows);
    if (queryResult.rows.length > maxRows) {
      warnings.push(
        warning(
          request.source.id,
          "database_rows_truncated",
          `Database query returned ${queryResult.rows.length} rows; only ${maxRows} were loaded.`
        )
      );
    }

    const records = rows.flatMap((row, index) => {
      const mapped = mapStructuredCorpusRecord({
        sourceId: request.source.id,
        source: request.source,
        item: row,
        itemIndex: index,
        mapping: config.mapping,
        defaults: structuredDefaults({
          sourceKind: config.sourceKind ?? "database_row",
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
      return mapped.record ? [mapped.record] : [];
    });

    return {
      sourceId: request.source.id,
      records,
      warnings
    };
  }
}

function sourceConfigMap(
  configs: readonly DatabaseCorpusSourceConfig[]
): ReadonlyMap<string, DatabaseCorpusSourceConfig> {
  const map = new Map<string, DatabaseCorpusSourceConfig>();

  for (const config of configs) {
    if (!config.sourceId.trim()) {
      throw new Error("Database source config sourceId is required.");
    }

    if (!config.queryName.trim()) {
      throw new Error(`Database source config "${config.sourceId}" queryName is required.`);
    }

    if (map.has(config.sourceId)) {
      throw new Error(`Duplicate database source config "${config.sourceId}".`);
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
  code: DatabaseCorpusWarningCode,
  message: string
): CorpusAdapterWarning {
  return {
    sourceId,
    code,
    message
  };
}
