import { DEFAULT_CHUNKING_POLICY } from "../chunking/chunk-policy.js";
import { chunkDocument } from "../chunking/chunker.js";
import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import type { IndexFilter } from "../indexing/index-types.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import type { RequestPrincipal } from "../security/access-scope.js";

export const FIXED_NOW = "2026-06-23T00:00:00.000Z";
export const TEST_PRINCIPAL: RequestPrincipal = {
  userId: "user_1",
  tenantId: "tenant_1",
  namespaceIds: ["test-namespace"],
  teamIds: ["support_team"],
  roles: ["support"],
  tags: ["support", "billing", "internal", "curated"]
};

interface IndexFilterOverrides {
  readonly namespaceId?: string;
  readonly tenantId?: string;
  readonly principal?: RequestPrincipal;
  readonly documentIds?: readonly string[];
  readonly chunkIds?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly sourceKinds?: IndexFilter["sourceKinds"];
  readonly trustTiers?: IndexFilter["trustTiers"];
  readonly includeSafetyFlags?: IndexFilter["includeSafetyFlags"];
  readonly excludeSafetyFlags?: IndexFilter["excludeSafetyFlags"];
  readonly accessTags?: readonly string[];
  readonly limit?: number;
}

export function makePrincipal(overrides: Partial<RequestPrincipal> = {}): RequestPrincipal {
  return {
    userId: overrides.userId ?? TEST_PRINCIPAL.userId,
    tenantId: overrides.tenantId ?? TEST_PRINCIPAL.tenantId,
    namespaceIds: overrides.namespaceIds ?? TEST_PRINCIPAL.namespaceIds,
    teamIds: overrides.teamIds ?? TEST_PRINCIPAL.teamIds,
    roles: overrides.roles ?? TEST_PRINCIPAL.roles,
    tags: overrides.tags ?? TEST_PRINCIPAL.tags
  };
}

export function makeIndexFilter(overrides: IndexFilterOverrides = {}): IndexFilter {
  const principal = overrides.principal ?? TEST_PRINCIPAL;
  const namespaceId = overrides.namespaceId ?? principal.namespaceIds[0] ?? "test-namespace";

  return {
    namespaceId,
    tenantId: overrides.tenantId ?? principal.tenantId,
    principal,
    ...(overrides.documentIds !== undefined ? { documentIds: overrides.documentIds } : {}),
    ...(overrides.chunkIds !== undefined ? { chunkIds: overrides.chunkIds } : {}),
    ...(overrides.sourceIds !== undefined ? { sourceIds: overrides.sourceIds } : {}),
    ...(overrides.sourceKinds !== undefined ? { sourceKinds: overrides.sourceKinds } : {}),
    ...(overrides.trustTiers !== undefined ? { trustTiers: overrides.trustTiers } : {}),
    ...(overrides.includeSafetyFlags !== undefined
      ? { includeSafetyFlags: overrides.includeSafetyFlags }
      : {}),
    ...(overrides.excludeSafetyFlags !== undefined
      ? { excludeSafetyFlags: overrides.excludeSafetyFlags }
      : {}),
    ...(overrides.accessTags !== undefined ? { accessTags: overrides.accessTags } : {}),
    ...(overrides.limit !== undefined ? { limit: overrides.limit } : {})
  };
}

export function makeDocument(overrides: Partial<RagDocument> = {}): RagDocument {
  const namespaceId = overrides.namespaceId ?? "test-namespace";
  const accessScope = overrides.accessScope ?? {
    tenantId: "tenant_1",
    namespaceId,
    tags: ["support"]
  };
  const title = overrides.title ?? "Test Policy";

  return {
    id: overrides.id ?? "doc_test_policy",
    namespaceId,
    title,
    body:
      overrides.body ??
      "Refund requests require review.\n\nBilling issues should be escalated to a human.",
    provenance: overrides.provenance ?? {
      sourceId: "curated_docs",
      sourceKind: "local_file",
      title,
      ingestedAt: FIXED_NOW,
      trustTier: "trusted_internal",
      sensitivity: "internal",
      capturedAt: FIXED_NOW
    },
    accessScope,
    ...(overrides.metadata ? { metadata: overrides.metadata } : {})
  };
}

export function makeChunks(document: RagDocument): readonly RagChunk[] {
  return chunkDocument({
    document,
    policy: {
      ...DEFAULT_CHUNKING_POLICY,
      maxCharacters: 80,
      overlapCharacters: 10,
      minCharacters: 10
    }
  }).chunks;
}

export function makeIndexedFixture(): {
  readonly index: InMemoryRagIndex;
  readonly document: RagDocument;
  readonly chunks: readonly RagChunk[];
} {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const document = makeDocument();
  const chunks = makeChunks(document);

  index.addDocument(document);
  index.addChunks(document.id, chunks);

  return {
    index,
    document,
    chunks
  };
}
