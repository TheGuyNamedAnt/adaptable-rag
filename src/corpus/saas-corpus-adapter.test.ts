import assert from "node:assert/strict";
import test from "node:test";

import { IngestPipeline } from "../ingestion/ingest-pipeline.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import type { RagProfile } from "../profiles/profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { hashText } from "../shared/hash.js";
import { FIXED_NOW, makeIndexFilter, makePrincipal } from "../test-support/fixtures.js";
import { CorpusAdapterRegistry } from "./adapter-registry.js";
import {
  SAAS_CORPUS_ADAPTER_ID,
  SaasCorpusAdapter,
  type SaasCorpusClient,
  type SaasCorpusPageRequest,
  type SaasCorpusPageResult
} from "./saas-corpus-adapter.js";

class StaticSaasClient implements SaasCorpusClient {
  readonly requests: SaasCorpusPageRequest[] = [];

  constructor(private readonly pages: Readonly<Record<string, SaasCorpusPageResult>>) {}

  async fetchPage(request: SaasCorpusPageRequest): Promise<SaasCorpusPageResult> {
    this.requests.push(request);
    return this.pages[request.cursor ?? "first"] ?? { items: [] };
  }
}

class FailingSaasClient implements SaasCorpusClient {
  async fetchPage(_request: SaasCorpusPageRequest): Promise<SaasCorpusPageResult> {
    throw new Error("helpdesk failed token=super-secret password=bad-secret");
  }
}

test("loads paginated SaaS API items as checksummed corpus records", async () => {
  const profile = saasProfile();
  const source = profile.corpusSources[0];
  assert.ok(source);

  const client = new StaticSaasClient({
    first: {
      items: [
        {
          id: "ticket-1",
          subject: "Refund evidence",
          text: "Refund tickets require support review and receipt evidence.",
          updatedAt: "2026-06-21T00:00:00.000Z",
          assigneeIds: ["support-user"],
          labels: "support,refund",
          status: "open"
        },
        {
          id: "ticket-2",
          subject: "Trace evidence",
          text: "Every SaaS ticket answer needs a linked trace and citation.",
          updatedAt: "2026-06-22T00:00:00.000Z",
          assigneeIds: ["support-user"],
          labels: ["support", "trace"],
          status: "closed"
        }
      ],
      nextCursor: "page-2"
    },
    "page-2": {
      items: [
        {
          id: "ticket-3",
          subject: "Escalation evidence",
          text: "Billing disputes from SaaS tickets require human escalation.",
          updatedAt: "2026-06-23T00:00:00.000Z",
          assigneeIds: ["finance-user"],
          labels: ["support", "billing"],
          status: "open"
        }
      ]
    }
  });
  const adapter = new SaasCorpusAdapter({
    client,
    sources: [
      {
        sourceId: source.id,
        endpointId: "helpdesk_tickets",
        parameters: { project: "sample" },
        pageSize: 2,
        trustTier: "verified_partner",
        sensitivity: "confidential",
        originUriBase: "https://helpdesk.example.test/tickets",
        metadata: {
          connector: "helpdesk"
        },
        mapping: {
          id: "id",
          title: "subject",
          body: "text",
          capturedAt: "updatedAt",
          accessScope: {
            userIds: "assigneeIds",
            tags: "labels"
          },
          metadataFields: ["status"]
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
    runId: "saas_load_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(client.requests.length, 2);
  assert.equal(client.requests[0]?.endpointId, "helpdesk_tickets");
  assert.deepEqual(client.requests[0]?.parameters, { project: "sample" });
  assert.equal(client.requests[0]?.pageSize, 2);
  assert.equal(client.requests[1]?.cursor, "page-2");
  assert.equal(loaded.warnings.length, 0);
  assert.equal(loaded.records.length, 3);
  const record = loaded.records[0];
  assert.ok(record);
  assert.equal(record.sourceKind, "api_response");
  assert.equal(record.trustTier, "verified_partner");
  assert.equal(record.sensitivity, "confidential");
  assert.equal(record.checksum, hashText(record.body));
  assert.deepEqual(record.accessScope, {
    tenantId: "tenant_1",
    namespaceId: profile.namespaceId,
    userIds: ["support-user"],
    tags: ["support", "refund"]
  });
  assert.equal(record.metadata?.["connector"], "helpdesk");
  assert.equal(record.metadata?.["status"], "open");
});

test("stops SaaS pagination on repeated cursors and record limits", async () => {
  const profile = saasProfile();
  const source = profile.corpusSources[0];
  assert.ok(source);

  const loopClient = new StaticSaasClient({
    first: {
      items: [{ id: "one", subject: "One", text: "First SaaS item." }],
      nextCursor: "loop"
    },
    loop: {
      items: [{ id: "two", subject: "Two", text: "Second SaaS item." }],
      nextCursor: "loop"
    }
  });
  const loopAdapter = new SaasCorpusAdapter({
    client: loopClient,
    sources: [
      {
        sourceId: source.id,
        endpointId: "looping_endpoint",
        mapping: {
          id: "id",
          title: "subject",
          body: "text"
        }
      }
    ]
  });

  const looped = await loopAdapter.load({
    profile,
    source,
    requestedBy: makePrincipal({ tenantId: "tenant_1", namespaceIds: [profile.namespaceId] }),
    runId: "saas_loop_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(looped.records.length, 2);
  assert.equal(
    looped.warnings.some((warning) => warning.code === "saas_cursor_repeated"),
    true
  );

  const limited = await new SaasCorpusAdapter({
    client: new StaticSaasClient({
      first: {
        items: [
          { id: "one", subject: "One", text: "First SaaS item." },
          { id: "two", subject: "Two", text: "Second SaaS item." }
        ]
      }
    }),
    sources: [
      {
        sourceId: source.id,
        endpointId: "limited_endpoint",
        maxRecords: 1,
        mapping: {
          id: "id",
          title: "subject",
          body: "text"
        }
      }
    ]
  }).load({
    profile,
    source,
    requestedBy: makePrincipal({ tenantId: "tenant_1", namespaceIds: [profile.namespaceId] }),
    runId: "saas_limit_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(limited.records.length, 1);
  assert.equal(
    limited.warnings.some((warning) => warning.code === "saas_records_truncated"),
    true
  );
});

test("SaaS adapter records cannot cross tenant boundaries through ingestion", async () => {
  const profile = saasProfile();
  const source = profile.corpusSources[0];
  assert.ok(source);

  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const pipeline = new IngestPipeline({
    adapterRegistry: new CorpusAdapterRegistry([
      new SaasCorpusAdapter({
        client: new StaticSaasClient({
          first: {
            items: [
              {
                id: "foreign-ticket",
                subject: "Foreign tenant ticket",
                text: "This ticket belongs to another tenant and must not enter the index.",
                tenantId: "tenant_2"
              }
            ]
          }
        }),
        sources: [
          {
            sourceId: source.id,
            endpointId: "tenant_tickets",
            trustTier: "verified_partner",
            mapping: {
              id: "id",
              title: "subject",
              body: "text",
              accessScope: {
                tenantId: "tenantId"
              }
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
    namespaceIds: [profile.namespaceId]
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    requestedAt: FIXED_NOW
  });

  assert.equal(result.documents.length, 0);
  assert.equal(result.rejectedRecords.length, 1);
  assert.equal(
    result.normalizationIssues.some((issue) => issue.code === "principal_boundary_violation"),
    true
  );
  assert.equal(
    index.findDocuments(
      makeIndexFilter({
        namespaceId: profile.namespaceId,
        tenantId: principal.tenantId,
        principal
      })
    ).length,
    0
  );
});

test("SaaS fetch failures are returned as redacted adapter warnings", async () => {
  const profile = saasProfile();
  const source = profile.corpusSources[0];
  assert.ok(source);

  const adapter = new SaasCorpusAdapter({
    client: new FailingSaasClient(),
    sources: [
      {
        sourceId: source.id,
        endpointId: "failing_endpoint",
        mapping: {
          id: "id",
          body: "body"
        }
      }
    ]
  });
  const result = await adapter.load({
    profile,
    source,
    requestedBy: makePrincipal({ tenantId: "tenant_1", namespaceIds: [profile.namespaceId] }),
    runId: "saas_failure_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.records.length, 0);
  assert.equal(result.warnings[0]?.code, "saas_fetch_failed");
  assert.equal(result.warnings[0]?.message.includes("super-secret"), false);
  assert.equal(result.warnings[0]?.message.includes("bad-secret"), false);
});

function saasProfile() {
  const source = genericDocsProfile.corpusSources[0];
  assert.ok(source);

  return assertValidProfile({
    ...genericDocsProfile,
    id: "generic-saas",
    namespaceId: "generic-saas",
    corpusSources: [
      {
        ...source,
        id: "saas_docs",
        adapter: SAAS_CORPUS_ADAPTER_ID,
        description: "SaaS API support objects.",
        trustTierFloor: "verified_partner",
        tags: ["support", "saas"]
      }
    ]
  } satisfies RagProfile);
}
