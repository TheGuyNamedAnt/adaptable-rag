import type { SourceSensitivity } from "../documents/trust-tier.js";
import type { AccessScope } from "../security/access-scope.js";
import { hashText } from "../shared/hash.js";
import { hashStableValue } from "../shared/stable-hash.js";
import type { RagSupportApprovedKnowledgeArtifact } from "../support-bridge/approval-ledger.js";
import type {
  CorpusAdapter,
  CorpusAdapterWarning,
  CorpusLoadRequest,
  CorpusLoadResult
} from "./adapter.js";
import type { CorpusRecord, CorpusRecordMetadata } from "./corpus-record.js";

export const APPROVED_KNOWLEDGE_ARTIFACT_ADAPTER_ID = "approved_knowledge_artifact";

export type ApprovedKnowledgeArtifactCorpusWarningCode =
  | "missing_source_config"
  | "approved_artifacts_truncated"
  | "artifact_filtered"
  | "artifact_not_approved"
  | "artifact_not_ready_for_ingestion"
  | "artifact_ingestion_hint_mismatch"
  | "artifact_source_mismatch"
  | "artifact_body_hash_mismatch"
  | "artifact_empty_body"
  | "artifact_namespace_mismatch";

export interface ApprovedKnowledgeArtifactAccessScopeConfig {
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly teamIds?: readonly string[];
  readonly userIds?: readonly string[];
  readonly roles?: readonly string[];
  readonly tags?: readonly string[];
}

export interface ApprovedKnowledgeArtifactSourceConfig {
  readonly sourceId: string;
  readonly artifacts: readonly RagSupportApprovedKnowledgeArtifact[];
  readonly artifactIds?: readonly string[];
  readonly maxArtifacts?: number;
  readonly pathPrefix?: string;
  readonly originUriBase?: string;
  readonly owner?: string;
  readonly accessScope?: ApprovedKnowledgeArtifactAccessScopeConfig;
  readonly capturedAt?: string;
  readonly metadata?: CorpusRecordMetadata;
}

export interface ApprovedKnowledgeArtifactCorpusAdapterOptions {
  readonly id?: string;
  readonly description?: string;
  readonly sources: readonly ApprovedKnowledgeArtifactSourceConfig[];
  readonly defaultMaxArtifacts?: number;
}

const DEFAULT_MAX_ARTIFACTS = 1_000;

export class ApprovedKnowledgeArtifactCorpusAdapter implements CorpusAdapter {
  readonly id: string;
  readonly description: string;

  private readonly sources: ReadonlyMap<string, ApprovedKnowledgeArtifactSourceConfig>;
  private readonly defaultMaxArtifacts: number;

  constructor(options: ApprovedKnowledgeArtifactCorpusAdapterOptions) {
    this.id = options.id ?? APPROVED_KNOWLEDGE_ARTIFACT_ADAPTER_ID;
    this.description =
      options.description ??
      "Loads human-approved support knowledge artifacts as derived corpus records.";
    this.sources = sourceConfigMap(options.sources);
    this.defaultMaxArtifacts = positiveInteger(options.defaultMaxArtifacts, DEFAULT_MAX_ARTIFACTS);

    if (!this.id.trim()) {
      throw new Error("ApprovedKnowledgeArtifactCorpusAdapter id is required.");
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
          `No approved knowledge artifact source config exists for source "${request.source.id}".`
        )
      );
      return {
        sourceId: request.source.id,
        records: [],
        warnings
      };
    }

    const selectedArtifacts = artifactsForConfig(config, request.source.id, warnings);
    const maxArtifacts = positiveInteger(config.maxArtifacts, this.defaultMaxArtifacts);
    const cappedArtifacts = selectedArtifacts.slice(0, maxArtifacts);
    if (selectedArtifacts.length > maxArtifacts) {
      warnings.push(
        warning(
          request.source.id,
          "approved_artifacts_truncated",
          `Approved artifact source returned ${selectedArtifacts.length} artifacts; only ${maxArtifacts} were loaded.`
        )
      );
    }

    const records = cappedArtifacts.flatMap((artifact, index) => {
      const record = recordFromArtifact({
        artifact,
        artifactIndex: index,
        config,
        request,
        warnings
      });
      return record ? [record] : [];
    });

    return {
      sourceId: request.source.id,
      records,
      warnings
    };
  }
}

export function approvedKnowledgeArtifactCorpusAdapterEvidenceBoundary(): readonly string[] {
  return [
    "Includes approved artifact ids, approved artifact body text, source event ids, ticket ids, payload hashes, approval metadata, and safe ingestion hints.",
    "Excludes raw ticket payloads, raw customer messages, raw diagnostics, raw model prompts, unapproved candidates, credentials, and raw reviewer identifiers.",
    "This adapter only creates corpus records; profile source declaration, checksum validation, trust-floor enforcement, access boundaries, chunking, and indexing remain enforced by the ingestion pipeline."
  ];
}

interface RecordFromArtifactInput {
  readonly artifact: RagSupportApprovedKnowledgeArtifact;
  readonly artifactIndex: number;
  readonly config: ApprovedKnowledgeArtifactSourceConfig;
  readonly request: CorpusLoadRequest;
  readonly warnings: CorpusAdapterWarning[];
}

function recordFromArtifact(input: RecordFromArtifactInput): CorpusRecord | undefined {
  const { artifact, config, request, warnings } = input;
  const artifactLabel = artifactIdForMessage(artifact, input.artifactIndex);

  if (artifact.status !== "approved_for_ingestion") {
    warnings.push(
      warning(
        request.source.id,
        "artifact_not_approved",
        `Approved artifact "${artifactLabel}" does not have approved_for_ingestion status.`
      )
    );
    return undefined;
  }

  if (
    artifact.corpusAdmission.currentRuntimeAnswerable !== false ||
    artifact.corpusAdmission.approvedForIngestion !== true ||
    artifact.corpusAdmission.answerableAfterIngestion !== true ||
    artifact.corpusAdmission.requiredNextGate !== "corpus_ingestion"
  ) {
    warnings.push(
      warning(
        request.source.id,
        "artifact_not_ready_for_ingestion",
        `Approved artifact "${artifactLabel}" has an invalid corpus admission state.`
      )
    );
    return undefined;
  }

  if (
    artifact.ingestionHint.adapter !== APPROVED_KNOWLEDGE_ARTIFACT_ADAPTER_ID ||
    artifact.ingestionHint.sourceKind !== "derived_summary" ||
    artifact.ingestionHint.trustTier !== "generated_or_derived" ||
    !["internal", "public"].includes(artifact.ingestionHint.sensitivity)
  ) {
    warnings.push(
      warning(
        request.source.id,
        "artifact_ingestion_hint_mismatch",
        `Approved artifact "${artifactLabel}" has an ingestion hint that this adapter cannot serve.`
      )
    );
    return undefined;
  }

  if (artifact.ingestionHint.sourceId !== request.source.id) {
    warnings.push(
      warning(
        request.source.id,
        "artifact_source_mismatch",
        `Approved artifact "${artifactLabel}" is intended for source "${safeMessageText(
          artifact.ingestionHint.sourceId
        )}".`
      )
    );
    return undefined;
  }

  if (artifact.namespaceId && artifact.namespaceId !== request.profile.namespaceId) {
    warnings.push(
      warning(
        request.source.id,
        "artifact_namespace_mismatch",
        `Approved artifact "${artifactLabel}" is intended for a different namespace.`
      )
    );
    return undefined;
  }

  const rawBody = artifact.body;
  const body = rawBody.trim();
  if (!body) {
    warnings.push(
      warning(
        request.source.id,
        "artifact_empty_body",
        `Approved artifact "${artifactLabel}" has an empty body.`
      )
    );
    return undefined;
  }

  if (artifact.bodyHash !== approvedArtifactBodyHash(rawBody)) {
    warnings.push(
      warning(
        request.source.id,
        "artifact_body_hash_mismatch",
        `Approved artifact "${artifactLabel}" body hash does not match the approved body.`
      )
    );
    return undefined;
  }

  const path = prefixedPath(
    config.pathPrefix ?? "approved-knowledge",
    `${safeId(artifact.artifactId)}.json`
  );
  const originUri = originUriFromBase(config.originUriBase, artifact.artifactId);
  const sensitivity: SourceSensitivity =
    artifact.ingestionHint.sensitivity === "public" ? "public" : "internal";

  return {
    id: documentId(request.source.id, artifact.artifactId),
    sourceId: request.source.id,
    sourceKind: "derived_summary",
    title: artifact.title.trim() || artifact.artifactId,
    body,
    trustTier: "generated_or_derived",
    sensitivity,
    accessScope: accessScopeForArtifact(artifact, config, request),
    ...(originUri ? { originUri } : {}),
    path,
    ...(config.owner ? { owner: config.owner } : {}),
    capturedAt: config.capturedAt ?? artifact.approvedAt ?? request.requestedAt,
    checksum: hashText(body),
    metadata: metadataForArtifact(artifact, config)
  };
}

function artifactsForConfig(
  config: ApprovedKnowledgeArtifactSourceConfig,
  sourceId: string,
  warnings: CorpusAdapterWarning[]
): readonly RagSupportApprovedKnowledgeArtifact[] {
  if (!config.artifactIds || config.artifactIds.length === 0) {
    return config.artifacts;
  }

  const allowed = new Set(config.artifactIds);
  const selected = config.artifacts.filter((artifact) => allowed.has(artifact.artifactId));
  const selectedIds = new Set(selected.map((artifact) => artifact.artifactId));
  for (const artifactId of config.artifactIds) {
    if (!selectedIds.has(artifactId)) {
      warnings.push(
        warning(
          sourceId,
          "artifact_filtered",
          `Configured approved artifact "${safeMessageText(artifactId)}" was not found.`
        )
      );
    }
  }

  return selected;
}

function accessScopeForArtifact(
  artifact: RagSupportApprovedKnowledgeArtifact,
  config: ApprovedKnowledgeArtifactSourceConfig,
  request: CorpusLoadRequest
): AccessScope {
  const configured = config.accessScope;
  const tags = uniqueStrings([
    ...(request.source.tags ?? []),
    ...(configured?.tags ?? []),
    "approved-knowledge",
    artifact.kind,
    artifact.visibility
  ]);

  return {
    tenantId: configured?.tenantId ?? request.requestedBy.tenantId,
    namespaceId: artifact.namespaceId ?? configured?.namespaceId ?? request.profile.namespaceId,
    ...(configured?.teamIds && configured.teamIds.length > 0
      ? { teamIds: uniqueStrings(configured.teamIds) }
      : {}),
    ...(configured?.userIds && configured.userIds.length > 0
      ? { userIds: uniqueStrings(configured.userIds) }
      : {}),
    ...(configured?.roles && configured.roles.length > 0
      ? { roles: uniqueStrings(configured.roles) }
      : {}),
    ...(tags.length > 0 ? { tags } : {})
  };
}

function metadataForArtifact(
  artifact: RagSupportApprovedKnowledgeArtifact,
  config: ApprovedKnowledgeArtifactSourceConfig
): CorpusRecordMetadata {
  const metadata: Record<string, string | number | boolean> = {
    ...(config.metadata ?? {}),
    artifactId: artifact.artifactId,
    artifactKey: artifact.artifactKey,
    approvalDecisionId: artifact.approvalDecisionId,
    approvedAt: artifact.approvedAt,
    bodyHash: artifact.bodyHash,
    candidateKind: artifact.kind,
    autoApproved: artifact.metadata.autoApproved === true,
    humanApproved: artifact.metadata.autoApproved !== true,
    sourceCandidateId: artifact.sourceCandidateId,
    sourceCandidateKey: artifact.sourceCandidateKey,
    visibility: artifact.visibility
  };

  addOptionalMetadata(metadata, "profileId", artifact.profileId);
  addOptionalMetadata(metadata, "namespaceId", artifact.namespaceId);
  addOptionalMetadata(metadata, "targetId", artifact.targetId);
  addOptionalMetadata(metadata, "knownIssueStatus", artifact.knownIssueStatus);
  addOptionalMetadata(metadata, "reviewerIdHash", artifact.reviewerIdHash);
  addListMetadata(metadata, "sourceEventIds", artifact.sourceEventIds);
  addListMetadata(metadata, "sourceIdempotencyKeys", artifact.sourceIdempotencyKeys);
  addListMetadata(metadata, "sourceTicketIds", artifact.sourceTicketIds);
  addListMetadata(metadata, "runIds", artifact.runIds);
  addListMetadata(metadata, "traceIds", artifact.traceIds);
  addListMetadata(metadata, "payloadHashes", artifact.payloadHashes);

  for (const [key, value] of Object.entries(artifact.metadata)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      metadata[`artifact.${key}`] = value;
    }
  }

  return metadata;
}

function sourceConfigMap(
  configs: readonly ApprovedKnowledgeArtifactSourceConfig[]
): ReadonlyMap<string, ApprovedKnowledgeArtifactSourceConfig> {
  const map = new Map<string, ApprovedKnowledgeArtifactSourceConfig>();

  for (const config of configs) {
    if (!config.sourceId.trim()) {
      throw new Error("Approved knowledge artifact source config sourceId is required.");
    }

    if (map.has(config.sourceId)) {
      throw new Error(`Duplicate approved knowledge artifact source config "${config.sourceId}".`);
    }

    map.set(config.sourceId, config);
  }

  return map;
}

function approvedArtifactBodyHash(body: string): string {
  return `sha256:${hashStableValue(body)}`;
}

function addOptionalMetadata(
  metadata: Record<string, string | number | boolean>,
  key: string,
  value: string | undefined
): void {
  if (value !== undefined && value.trim()) {
    metadata[key] = value;
  }
}

function addListMetadata(
  metadata: Record<string, string | number | boolean>,
  key: string,
  values: readonly string[]
): void {
  if (values.length > 0) {
    metadata[key] = values.join(",");
  }
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

function documentId(sourceId: string, artifactId: string): string {
  const safeStem = safeId(artifactId);
  const suffix = hashText(`${sourceId}:${artifactId}`).slice(0, 16);
  return [sourceId, safeStem || "approved_artifact", suffix].join("_");
}

function originUriFromBase(
  originUriBase: string | undefined,
  artifactId: string
): string | undefined {
  if (!originUriBase?.trim()) {
    return undefined;
  }

  return `${originUriBase.replace(/\/+$/u, "")}/${encodeURIComponent(artifactId)}`;
}

function prefixedPath(prefix: string, value: string): string {
  return `${prefix.replace(/\/+$/u, "")}/${value.replace(/^\/+/u, "")}`;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [
    ...new Set(
      values.map((value) => value.trim()).filter((value): value is string => Boolean(value))
    )
  ];
}

function safeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
}

function artifactIdForMessage(
  artifact: RagSupportApprovedKnowledgeArtifact,
  artifactIndex: number
): string {
  return safeMessageText(artifact.artifactId || `index_${artifactIndex}`);
}

function safeMessageText(value: string): string {
  return value
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [REDACTED]")
    .slice(0, 120);
}

function warning(
  sourceId: string,
  code: ApprovedKnowledgeArtifactCorpusWarningCode,
  message: string
): CorpusAdapterWarning {
  return {
    sourceId,
    code,
    message
  };
}
