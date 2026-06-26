import { isSourceKind, type SourceKind } from "../documents/provenance.js";
import {
  isSourceSensitivity,
  isTrustTier,
  type SourceSensitivity,
  type TrustTier
} from "../documents/trust-tier.js";
import type { CorpusSourceConfig } from "../profiles/profile.js";
import type { AccessScope, RequestPrincipal } from "../security/access-scope.js";
import type { ConnectorAclMapper } from "../security/connector-acl-mapper.js";
import { hashText } from "../shared/hash.js";
import type { CorpusAdapterWarning } from "./adapter.js";
import type { CorpusRecord, CorpusRecordMetadata } from "./corpus-record.js";

export type StructuredRecord = Readonly<Record<string, unknown>>;

export type StructuredRecordMappingWarningCode =
  | "invalid_record_shape"
  | "missing_required_field"
  | "empty_record_body"
  | "invalid_source_kind"
  | "invalid_trust_tier"
  | "invalid_sensitivity"
  | "invalid_access_scope_field"
  | "acl_mapper_failed"
  | "metadata_value_skipped";

export interface StructuredAccessScopeFieldMapping {
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly teamIds?: string;
  readonly userIds?: string;
  readonly roles?: string;
  readonly tags?: string;
}

export interface StructuredAccessScopeDefaults {
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly teamIds?: readonly string[];
  readonly userIds?: readonly string[];
  readonly roles?: readonly string[];
  readonly tags?: readonly string[];
}

export interface StructuredRecordFieldMapping {
  readonly id: string;
  readonly body: string;
  readonly title?: string;
  readonly sourceKind?: string;
  readonly trustTier?: string;
  readonly sensitivity?: string;
  readonly originUri?: string;
  readonly path?: string;
  readonly owner?: string;
  readonly capturedAt?: string;
  readonly accessScope?: StructuredAccessScopeFieldMapping;
  readonly accessScopeFrom?: string;
  readonly metadataFields?: readonly string[];
}

export interface StructuredRecordDefaults {
  readonly sourceKind: SourceKind;
  readonly trustTier: TrustTier;
  readonly sensitivity: SourceSensitivity;
  readonly accessScope?: StructuredAccessScopeDefaults;
  readonly title?: string;
  readonly owner?: string;
  readonly capturedAt?: string;
  readonly metadata?: CorpusRecordMetadata;
}

export interface StructuredRecordMappingInput {
  readonly sourceId: string;
  readonly source?: CorpusSourceConfig | undefined;
  readonly item: unknown;
  readonly itemIndex: number;
  readonly mapping: StructuredRecordFieldMapping;
  readonly defaults: StructuredRecordDefaults;
  readonly requestedBy: RequestPrincipal;
  readonly profileNamespaceId: string;
  readonly sourceTags?: readonly string[] | undefined;
  readonly aclMapper?: ConnectorAclMapper | undefined;
  readonly fallbackCapturedAt: string;
  readonly idPrefix?: string | undefined;
  readonly originUriBase?: string | undefined;
  readonly pathPrefix?: string | undefined;
}

export interface StructuredRecordMappingResult {
  readonly record?: CorpusRecord;
  readonly warnings: readonly CorpusAdapterWarning[];
}

const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `((?:${["api[_-]?key", "token", "password", "secret"].join("|")})\\s*[:=]\\s*)[^\\s,;]+`,
  "giu"
);

export function mapStructuredCorpusRecord(
  input: StructuredRecordMappingInput
): StructuredRecordMappingResult {
  const warnings: CorpusAdapterWarning[] = [];
  const item = input.item;

  if (!isRecord(item)) {
    return {
      warnings: [
        warning(
          input.sourceId,
          "invalid_record_shape",
          `Structured corpus item at index ${input.itemIndex} is not an object.`
        )
      ]
    };
  }

  const upstreamId = scalarStringAtPath(item, input.mapping.id);
  if (!upstreamId) {
    return {
      warnings: [
        warning(
          input.sourceId,
          "missing_required_field",
          `Structured corpus item at index ${input.itemIndex} is missing id field "${input.mapping.id}".`
        )
      ]
    };
  }

  const body = scalarStringAtPath(item, input.mapping.body);
  if (!body) {
    return {
      warnings: [
        warning(
          input.sourceId,
          "missing_required_field",
          `Structured corpus item "${upstreamId}" is missing body field "${input.mapping.body}".`
        )
      ]
    };
  }

  if (!body.trim()) {
    return {
      warnings: [
        warning(
          input.sourceId,
          "empty_record_body",
          `Structured corpus item "${upstreamId}" has an empty body.`
        )
      ]
    };
  }

  const sourceKind = mappedSourceKind(item, input, upstreamId, warnings);
  const trustTier = mappedTrustTier(item, input, upstreamId, warnings);
  const sensitivity = mappedSensitivity(item, input, upstreamId, warnings);
  if (!sourceKind || !trustTier || !sensitivity) {
    return { warnings };
  }

  const title =
    optionalScalarStringAtPath(item, input.mapping.title) ??
    input.defaults.title ??
    titleFromBody(body) ??
    upstreamId;
  const path = optionalScalarStringAtPath(item, input.mapping.path);
  const originUri =
    optionalScalarStringAtPath(item, input.mapping.originUri) ??
    originUriFromBase(input.originUriBase, path ?? upstreamId);
  const owner = optionalScalarStringAtPath(item, input.mapping.owner) ?? input.defaults.owner;
  const capturedAt =
    optionalScalarStringAtPath(item, input.mapping.capturedAt) ??
    input.defaults.capturedAt ??
    input.fallbackCapturedAt;

  return {
    record: {
      id: documentId(input.sourceId, input.idPrefix, upstreamId),
      sourceId: input.sourceId,
      sourceKind,
      title,
      body,
      trustTier,
      sensitivity,
      accessScope: accessScopeForItem(item, input, upstreamId, warnings),
      ...(originUri ? { originUri } : {}),
      ...(path ? { path: prefixedPath(input.pathPrefix, path) } : {}),
      ...(owner ? { owner } : {}),
      capturedAt,
      checksum: hashText(body),
      metadata: metadataForItem(item, input, upstreamId, warnings)
    },
    warnings
  };
}

export function structuredDefaults(input: {
  readonly sourceKind: SourceKind;
  readonly trustTier?: TrustTier | undefined;
  readonly trustTierFallback?: TrustTier | undefined;
  readonly sensitivity?: SourceSensitivity | undefined;
  readonly accessScope?: StructuredAccessScopeDefaults | undefined;
  readonly title?: string | undefined;
  readonly owner?: string | undefined;
  readonly capturedAt?: string | undefined;
  readonly metadata?: CorpusRecordMetadata | undefined;
}): StructuredRecordDefaults {
  return {
    sourceKind: input.sourceKind,
    trustTier: input.trustTier ?? input.trustTierFallback ?? "unknown",
    sensitivity: input.sensitivity ?? "internal",
    ...(input.accessScope ? { accessScope: input.accessScope } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.owner ? { owner: input.owner } : {}),
    ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {})
  };
}

export function redactDiagnosticMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+/giu, "$1[REDACTED]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "auth [REDACTED]");
}

function mappedSourceKind(
  item: StructuredRecord,
  input: StructuredRecordMappingInput,
  upstreamId: string,
  warnings: CorpusAdapterWarning[]
): SourceKind | undefined {
  const value =
    optionalScalarStringAtPath(item, input.mapping.sourceKind) ?? input.defaults.sourceKind;
  if (isSourceKind(value)) {
    return value;
  }

  warnings.push(
    warning(
      input.sourceId,
      "invalid_source_kind",
      `Structured corpus item "${upstreamId}" has invalid source kind "${value}".`
    )
  );
  return undefined;
}

function mappedTrustTier(
  item: StructuredRecord,
  input: StructuredRecordMappingInput,
  upstreamId: string,
  warnings: CorpusAdapterWarning[]
): TrustTier | undefined {
  const value =
    optionalScalarStringAtPath(item, input.mapping.trustTier) ?? input.defaults.trustTier;
  if (isTrustTier(value)) {
    return value;
  }

  warnings.push(
    warning(
      input.sourceId,
      "invalid_trust_tier",
      `Structured corpus item "${upstreamId}" has invalid trust tier "${value}".`
    )
  );
  return undefined;
}

function mappedSensitivity(
  item: StructuredRecord,
  input: StructuredRecordMappingInput,
  upstreamId: string,
  warnings: CorpusAdapterWarning[]
): SourceSensitivity | undefined {
  const value =
    optionalScalarStringAtPath(item, input.mapping.sensitivity) ?? input.defaults.sensitivity;
  if (isSourceSensitivity(value)) {
    return value;
  }

  warnings.push(
    warning(
      input.sourceId,
      "invalid_sensitivity",
      `Structured corpus item "${upstreamId}" has invalid sensitivity "${value}".`
    )
  );
  return undefined;
}

function accessScopeForItem(
  item: StructuredRecord,
  input: StructuredRecordMappingInput,
  upstreamId: string,
  warnings: CorpusAdapterWarning[]
): AccessScope {
  if (input.aclMapper && input.mapping.accessScopeFrom) {
    const nativeAcl = valueAtPath(item, input.mapping.accessScopeFrom);
    try {
      return input.aclMapper.map({
        nativeAcl,
        context: {
          source: input.source ?? {
            id: input.sourceId,
            adapter: "structured",
            description: "Structured record ACL mapping source.",
            enabled: true,
            ...(input.sourceTags ? { tags: input.sourceTags } : {})
          },
          requestedBy: input.requestedBy,
          defaultTenantId: input.requestedBy.tenantId,
          defaultNamespaceId: input.profileNamespaceId,
          defaultTags: input.sourceTags ?? []
        }
      });
    } catch (error) {
      warnings.push(
        warning(
          input.sourceId,
          "acl_mapper_failed",
          `Structured corpus item "${upstreamId}" ACL mapper failed: ${errorName(error)}.`
        )
      );
    }
  }

  const mapping = input.mapping.accessScope;
  const defaults = input.defaults.accessScope;
  const teamIds = listField(
    stringListAtPath(item, mapping?.teamIds, input.sourceId, upstreamId, warnings),
    defaults?.teamIds
  );
  const userIds = listField(
    stringListAtPath(item, mapping?.userIds, input.sourceId, upstreamId, warnings),
    defaults?.userIds
  );
  const roles = listField(
    stringListAtPath(item, mapping?.roles, input.sourceId, upstreamId, warnings),
    defaults?.roles
  );
  const tags =
    stringListAtPath(item, mapping?.tags, input.sourceId, upstreamId, warnings) ??
    defaults?.tags ??
    input.sourceTags ??
    [];

  return {
    tenantId:
      optionalScalarStringAtPath(item, mapping?.tenantId) ??
      defaults?.tenantId ??
      input.requestedBy.tenantId,
    namespaceId:
      optionalScalarStringAtPath(item, mapping?.namespaceId) ??
      defaults?.namespaceId ??
      input.profileNamespaceId,
    ...(teamIds ? { teamIds } : {}),
    ...(userIds ? { userIds } : {}),
    ...(roles ? { roles } : {}),
    ...(tags.length > 0 ? { tags } : {})
  };
}

function metadataForItem(
  item: StructuredRecord,
  input: StructuredRecordMappingInput,
  upstreamId: string,
  warnings: CorpusAdapterWarning[]
): CorpusRecordMetadata {
  const metadata: Record<string, string | number | boolean> = {
    ...(input.defaults.metadata ?? {}),
    upstreamRecordId: upstreamId,
    upstreamRecordIndex: input.itemIndex
  };

  for (const field of input.mapping.metadataFields ?? []) {
    const value = valueAtPath(item, field);
    if (value === undefined || value === null) {
      continue;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      metadata[field] = value;
      continue;
    }

    warnings.push(
      warning(
        input.sourceId,
        "metadata_value_skipped",
        `Structured corpus item "${upstreamId}" metadata field "${field}" is not a scalar.`
      )
    );
  }

  return metadata;
}

function listField(
  mapped: readonly string[] | undefined,
  defaultValue: readonly string[] | undefined
): readonly string[] | undefined {
  const values = mapped ?? defaultValue;
  return values && values.length > 0 ? values : undefined;
}

function stringListAtPath(
  item: StructuredRecord,
  path: string | undefined,
  sourceId: string,
  upstreamId: string,
  warnings: CorpusAdapterWarning[]
): readonly string[] | undefined {
  if (!path) {
    return undefined;
  }

  const value = valueAtPath(item, path);
  if (value === undefined || value === null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const values = value
      .map((entry) => scalarToString(entry))
      .filter((entry): entry is string => Boolean(entry?.trim()))
      .map((entry) => entry.trim());
    return [...new Set(values)];
  }

  const scalar = scalarToString(value);
  if (scalar) {
    return [
      ...new Set(
        scalar
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
      )
    ];
  }

  warnings.push(
    warning(
      sourceId,
      "invalid_access_scope_field",
      `Structured corpus item "${upstreamId}" access field "${path}" is not a string list.`
    )
  );
  return undefined;
}

function scalarStringAtPath(item: StructuredRecord, path: string): string | undefined {
  return scalarToString(valueAtPath(item, path))?.trim();
}

function optionalScalarStringAtPath(
  item: StructuredRecord,
  path: string | undefined
): string | undefined {
  if (!path) {
    return undefined;
  }

  return scalarStringAtPath(item, path);
}

function valueAtPath(item: StructuredRecord, path: string): unknown {
  const parts = path
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  let current: unknown = item;

  for (const part of parts) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[part];
  }

  return current;
}

function scalarToString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return undefined;
}

function titleFromBody(body: string): string | undefined {
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) {
    return heading;
  }

  return body.trim().split(/\r?\n/u)[0]?.trim().slice(0, 80) || undefined;
}

function originUriFromBase(originUriBase: string | undefined, suffix: string): string | undefined {
  if (!originUriBase?.trim()) {
    return undefined;
  }

  const encodedSuffix = suffix
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${originUriBase.replace(/\/+$/u, "")}/${encodedSuffix}`;
}

function prefixedPath(prefix: string | undefined, value: string): string {
  if (!prefix?.trim()) {
    return value;
  }

  return `${prefix.replace(/\/+$/u, "")}/${value.replace(/^\/+/u, "")}`;
}

function documentId(sourceId: string, idPrefix: string | undefined, upstreamId: string): string {
  const safeStem = upstreamId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  const suffix = hashText(`${sourceId}:${upstreamId}`).slice(0, 16);
  const parts = [sourceId, idPrefix, safeStem || "record", suffix].filter(Boolean);
  return parts.join("_");
}

function warning(
  sourceId: string,
  code: StructuredRecordMappingWarningCode,
  message: string
): CorpusAdapterWarning {
  return {
    sourceId,
    code,
    message
  };
}

function isRecord(value: unknown): value is StructuredRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
