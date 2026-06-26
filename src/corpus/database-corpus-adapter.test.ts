import assert from "node:assert/strict";
import test from "node:test";

import { IngestPipeline } from "../ingestion/ingest-pipeline.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import type { RagProfile } from "../profiles/profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { KeywordRetriever } from "../retrieval/keyword-retriever.js";
import { ownerDefinedAclMapper } from "../security/connector-acl-mapper.js";
import { hashText } from "../shared/hash.js";
import { FIXED_NOW, makeIndexFilter, makePrincipal } from "../test-support/fixtures.js";
import { CorpusAdapterRegistry } from "./adapter-registry.js";
import {
  DATABASE_CORPUS_ADAPTER_ID,
  DatabaseCorpusAdapter,
  type DatabaseCorpusClient,
  type DatabaseCorpusQueryRequest,
  type DatabaseCorpusQueryResult
} from "./database-corpus-adapter.js";

class StaticDatabaseClient implements DatabaseCorpusClient {
  readonly requests: DatabaseCorpusQueryRequest[] = [];

  constructor(private readonly result: DatabaseCorpusQueryResult) {}

  async query(request: DatabaseCorpusQueryRequest): Promise<DatabaseCorpusQueryResult> {
    this.requests.push(request);
    return this.result;
  }
}

class FailingDatabaseClient implements DatabaseCorpusClient {
  async query(_request: DatabaseCorpusQueryRequest): Promise<DatabaseCorpusQueryResult> {
    throw new Error(
      "database failed for postgresql://rag:secret-password@db.example/app api_key=secret-key"
    );
  }
}

test("loads database rows as checksummed corpus records with safe defaults", async () => {
  const profile = databaseProfile("trusted_internal");
  const source = profile.corpusSources[0];
  assert.ok(source);

  const body = "Refund database policy requires a support owner and rollback note.";
  const client = new StaticDatabaseClient({
    rows: [
      {
        doc_id: 42,
        title: "Refund Database Policy",
        body,
        captured_at: "2026-06-20T00:00:00.000Z",
        url: "postgres://policies/42",
        teams: ["support"],
        roles: "reader,admin",
        revision: 7
      }
    ]
  });
  const adapter = new DatabaseCorpusAdapter({
    client,
    sources: [
      {
        sourceId: source.id,
        queryName: "support_policies_for_rag",
        parameters: { active: true },
        maxRows: 50,
        trustTier: "trusted_internal",
        sensitivity: "confidential",
        accessScope: {
          tags: ["database", "trusted"]
        },
        metadata: {
          connector: "postgres"
        },
        mapping: {
          id: "doc_id",
          title: "title",
          body: "body",
          capturedAt: "captured_at",
          originUri: "url",
          accessScope: {
            teamIds: "teams",
            roles: "roles"
          },
          metadataFields: ["revision"]
        }
      }
    ]
  });
  const principal = makePrincipal({
    tenantId: "tenant_1",
    namespaceIds: [profile.namespaceId]
  });

  const loaded = await adapter.load({
    profile,
    source,
    requestedBy: principal,
    runId: "db_load_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(client.requests.length, 1);
  assert.equal(client.requests[0]?.queryName, "support_policies_for_rag");
  assert.deepEqual(client.requests[0]?.parameters, { active: true });
  assert.equal(client.requests[0]?.maxRows, 50);
  assert.equal(loaded.warnings.length, 0);
  assert.equal(loaded.records.length, 1);
  const record = loaded.records[0];
  assert.ok(record);
  assert.equal(record.sourceId, source.id);
  assert.equal(record.sourceKind, "database_row");
  assert.equal(record.title, "Refund Database Policy");
  assert.equal(record.body, body);
  assert.equal(record.sensitivity, "confidential");
  assert.equal(record.checksum, hashText(body));
  assert.deepEqual(record.accessScope, {
    tenantId: "tenant_1",
    namespaceId: profile.namespaceId,
    teamIds: ["support"],
    roles: ["reader", "admin"],
    tags: ["database", "trusted"]
  });
  assert.equal(record.metadata?.["upstreamRecordId"], "42");
  assert.equal(record.metadata?.["revision"], 7);
  assert.equal(record.metadata?.["connector"], "postgres");
});

test("ingests database rows through the pipeline without allowing source self-promotion", async () => {
  const profile = databaseProfile("user_provided");
  const source = profile.corpusSources[0];
  assert.ok(source);

  const body = "User-provided support row still needs review before it can ground an answer.";
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const pipeline = new IngestPipeline({
    adapterRegistry: new CorpusAdapterRegistry([
      new DatabaseCorpusAdapter({
        client: new StaticDatabaseClient({
          rows: [
            {
              id: "support_row_1",
              body,
              title: "Support Row"
            }
          ]
        }),
        sources: [
          {
            sourceId: source.id,
            queryName: "support_rows",
            trustTier: "trusted_internal",
            mapping: {
              id: "id",
              title: "title",
              body: "body"
            }
          }
        ]
      })
    ]),
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  });
  const principal = makePrincipal({
    tenantId: "tenant_1",
    namespaceIds: [profile.namespaceId],
    roles: ["reader"],
    tags: ["database", "trusted"]
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    requestedAt: FIXED_NOW
  });

  assert.equal(result.rejectedRecords.length, 0);
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0]?.provenance.trustTier, "user_provided");
  assert.equal(
    index.findDocuments(
      makeIndexFilter({
        namespaceId: profile.namespaceId,
        tenantId: principal.tenantId,
        principal
      })
    ).length,
    1
  );
});

test("owner-defined ACL mapper carries connector permissions into retrieval filters", async () => {
  const profile = databaseProfile("trusted_internal");
  const source = profile.corpusSources[0];
  assert.ok(source);

  const aclMapper = ownerDefinedAclMapper({
    id: "owner-drive-acl",
    map: ({ nativeAcl, context }) => {
      assert.equal(context.source.id, source.id);
      const acl = nativeAcl as {
        readonly tenant?: string;
        readonly namespace?: string;
        readonly allowedGroups?: readonly string[];
        readonly requiredLabels?: readonly string[];
      };
      return {
        tenantId: acl.tenant ?? context.defaultTenantId,
        namespaceId: acl.namespace ?? context.defaultNamespaceId,
        teamIds: acl.allowedGroups ?? [],
        tags: [...context.defaultTags, ...(acl.requiredLabels ?? [])]
      };
    }
  });
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const pipeline = new IngestPipeline({
    adapterRegistry: new CorpusAdapterRegistry([
      new DatabaseCorpusAdapter({
        client: new StaticDatabaseClient({
          rows: [
            {
              id: "public-policy",
              title: "Public Policy",
              body: "Public refund policy is visible to support.",
              acl: {
                allowedGroups: ["support_team"],
                requiredLabels: ["public"]
              }
            },
            {
              id: "board-policy",
              title: "Board Policy",
              body: "Board-only acquisition policy contains private ownership detail.",
              acl: {
                allowedGroups: ["board_team"],
                requiredLabels: ["board_only"]
              }
            }
          ]
        }),
        sources: [
          {
            sourceId: source.id,
            queryName: "owner_acl_rows",
            aclMapper,
            mapping: {
              id: "id",
              title: "title",
              body: "body",
              accessScopeFrom: "acl"
            }
          }
        ]
      })
    ]),
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  });
  const supportPrincipal = makePrincipal({
    tenantId: "tenant_1",
    namespaceIds: [profile.namespaceId],
    teamIds: ["support_team"],
    tags: ["database", "trusted", "public"]
  });

  const ingest = await pipeline.ingest({
    profile,
    requestedBy: supportPrincipal,
    requestedAt: FIXED_NOW
  });
  const retriever = new KeywordRetriever({ chunkStore: index, now: () => FIXED_NOW });
  const retrieved = await retriever.retrieve({
    query: "policy",
    filter: makeIndexFilter({
      namespaceId: profile.namespaceId,
      tenantId: supportPrincipal.tenantId,
      principal: supportPrincipal
    }),
    topK: 10,
    mode: "keyword",
    requestedAt: FIXED_NOW
  });

  assert.equal(ingest.rejectedRecords.length, 0);
  assert.equal(ingest.documents.length, 2);
  assert.deepEqual(
    ingest.documents.map((document) => document.accessScope),
    [
      {
        tenantId: "tenant_1",
        namespaceId: profile.namespaceId,
        teamIds: ["support_team"],
        tags: ["database", "trusted", "public"]
      },
      {
        tenantId: "tenant_1",
        namespaceId: profile.namespaceId,
        teamIds: ["board_team"],
        tags: ["database", "trusted", "board_only"]
      }
    ]
  );
  assert.equal(
    retrieved.candidates.some((candidate) => candidate.chunk.documentId.includes("public")),
    true
  );
  assert.equal(
    retrieved.candidates.some((candidate) => candidate.chunk.documentId.includes("board")),
    false
  );
});

test("database adapter caps rows and redacts client errors", async () => {
  const profile = databaseProfile("trusted_internal");
  const source = profile.corpusSources[0];
  assert.ok(source);

  const adapter = new DatabaseCorpusAdapter({
    client: new StaticDatabaseClient({
      rows: [
        { id: "one", title: "One", body: "First body." },
        { id: "two", title: "Two", body: "Second body." },
        { id: "three", title: "Three", body: "Third body." }
      ]
    }),
    sources: [
      {
        sourceId: source.id,
        queryName: "limited_rows",
        maxRows: 2,
        mapping: {
          id: "id",
          title: "title",
          body: "body"
        }
      }
    ]
  });
  const loaded = await adapter.load({
    profile,
    source,
    requestedBy: makePrincipal({ tenantId: "tenant_1", namespaceIds: [profile.namespaceId] }),
    runId: "db_limit_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(loaded.records.length, 2);
  assert.equal(
    loaded.warnings.some((warning) => warning.code === "database_rows_truncated"),
    true
  );

  const failing = new DatabaseCorpusAdapter({
    client: new FailingDatabaseClient(),
    sources: [
      {
        sourceId: source.id,
        queryName: "fails",
        mapping: {
          id: "id",
          body: "body"
        }
      }
    ]
  });
  const failed = await failing.load({
    profile,
    source,
    requestedBy: makePrincipal({ tenantId: "tenant_1", namespaceIds: [profile.namespaceId] }),
    runId: "db_failure_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(failed.records.length, 0);
  assert.equal(failed.warnings[0]?.code, "database_query_failed");
  assert.equal(failed.warnings[0]?.message.includes("secret-password"), false);
  assert.equal(failed.warnings[0]?.message.includes("secret-key"), false);
});

function databaseProfile(trustTierFloor: "trusted_internal" | "user_provided") {
  const source = genericDocsProfile.corpusSources[0];
  assert.ok(source);

  return assertValidProfile({
    ...genericDocsProfile,
    id: `generic-database-${trustTierFloor}`,
    namespaceId: `generic-database-${trustTierFloor}`,
    corpusSources: [
      {
        ...source,
        id: "database_docs",
        adapter: DATABASE_CORPUS_ADAPTER_ID,
        description: "Database-backed policies.",
        trustTierFloor,
        tags: ["database", "trusted"]
      }
    ],
    citationPolicy: {
      ...genericDocsProfile.citationPolicy,
      allowedSourceKindsForCitations: [
        ...genericDocsProfile.citationPolicy.allowedSourceKindsForCitations,
        "database_row"
      ]
    }
  } satisfies RagProfile);
}
