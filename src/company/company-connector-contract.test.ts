import assert from "node:assert/strict";
import test from "node:test";

import type { CorpusAdapter, CorpusLoadRequest, CorpusLoadResult } from "../corpus/adapter.js";
import type { CorpusRecord } from "../corpus/corpus-record.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import type {
  SourceConnector,
  SourceConnectorSyncRequest,
  SourceConnectorSyncResult
} from "../sync/source-connector.js";
import { FIXED_NOW, makePrincipal } from "../test-support/fixtures.js";
import type { CompanyAdapterPack } from "./company-adapter-pack.js";
import {
  assertCompanyConnectorContractTests,
  CompanyConnectorContractError,
  runCompanyConnectorContractTests
} from "./company-connector-contract.js";
import { CompanyDeploymentRegistry } from "./company-deployment-registry.js";
import type { CompanyProfile } from "./company-profile.js";

class EmptyAdapter implements CorpusAdapter {
  readonly description = "Empty contract test adapter.";

  constructor(readonly id: string) {}

  async load(request: CorpusLoadRequest): Promise<CorpusLoadResult> {
    return {
      sourceId: request.source.id,
      records: [],
      warnings: []
    };
  }
}

class DeltaThenFullConnector implements SourceConnector {
  readonly id = "docs";
  readonly description = "Contract fixture source connector.";
  readonly requests: SourceConnectorSyncRequest[] = [];

  async sync(request: SourceConnectorSyncRequest): Promise<SourceConnectorSyncResult> {
    this.requests.push(request);
    if (request.mode === "delta") {
      return {
        sourceId: request.source.id,
        nextCursor: "cursor_delta",
        complete: false,
        items: [
          {
            operation: "upsert",
            sourceItemId: "source_item_contract",
            version: "1",
            record: record({
              id: "doc_contract",
              sourceId: request.source.id,
              body: "Unique body that must never be copied into the sync ledger."
            })
          }
        ]
      };
    }

    return {
      sourceId: request.source.id,
      complete: true,
      items: []
    };
  }
}

class UnsafeConnector implements SourceConnector {
  readonly id = "docs";
  readonly description = "Unsafe contract fixture source connector.";

  async sync(request: SourceConnectorSyncRequest): Promise<SourceConnectorSyncResult> {
    return {
      sourceId: "wrong_source",
      complete: false,
      warnings: [
        {
          sourceId: "wrong_source",
          code: "",
          message: "api_key=leaked-secret"
        }
      ],
      items: [
        {
          operation: "upsert",
          sourceItemId: "source_item_bad",
          version: "1",
          record: record({
            id: "doc_bad",
            sourceId: "wrong_source",
            accessScope: {
              tenantId: request.requestedBy.tenantId,
              namespaceId: "wrong_namespace"
            }
          })
        }
      ]
    };
  }
}

class LeakyErrorConnector implements SourceConnector {
  readonly id = "docs";
  readonly description = "Leaky error fixture source connector.";

  async sync(request: SourceConnectorSyncRequest): Promise<SourceConnectorSyncResult> {
    const body = "Private customer contract clause should never appear in diagnostics.";
    return {
      sourceId: request.source.id,
      complete: false,
      items: [
        {
          operation: "upsert",
          sourceItemId: "source_item_private",
          version: "1",
          record: record({
            id: "doc_private",
            sourceId: request.source.id,
            body
          })
        },
        {
          operation: "error",
          sourceItemId: "source_item_error",
          recordId: "doc_error",
          errorCode: "parse_failed",
          message: `Parser failed near text: ${body}`,
          retryable: false
        }
      ]
    };
  }
}

const principal = makePrincipal({
  tenantId: "tenant_acme",
  namespaceIds: ["acme-docs"],
  roles: ["admin"],
  tags: ["contract-test"]
});

test("company connector contract runner validates delta, full sync, ACLs, and tombstone ledger safety", async () => {
  const connector = new DeltaThenFullConnector();
  const report = await runCompanyConnectorContractTests({
    registry: registryWith(connector),
    company: { companyId: "acme", useCaseId: "docs" },
    requestedBy: principal,
    requestedAt: FIXED_NOW,
    now: () => FIXED_NOW
  });

  assert.equal(report.status, "passed");
  assert.equal(report.checkedConnectorCount, 1);
  assert.equal(report.checkedSourceCount, 1);
  assert.equal(report.checkedCaseCount, 2);
  assert.deepEqual(
    report.cases.map((contractCase) => [contractCase.mode, contractCase.status]),
    [
      ["delta", "passed"],
      ["full", "passed"]
    ]
  );
  assert.deepEqual(
    connector.requests.map((request) => request.mode),
    ["delta", "full"]
  );
  assert.equal(connector.requests[1]?.previousCursor, "cursor_delta");
  assert.equal(report.cases[1]?.run.deleted[0]?.recordId, "doc_contract");
  assert.equal(report.cases[1]?.run.ledger.entries[0]?.status, "deleted");
  assert.equal(
    JSON.stringify(report.cases[0]?.run.ledger).includes("Unique body that must never be copied"),
    false
  );
});

test("company connector contract runner reports unsafe connector output", async () => {
  const report = await runCompanyConnectorContractTests({
    registry: registryWith(new UnsafeConnector()),
    company: { companyId: "acme", useCaseId: "docs" },
    requestedBy: principal,
    modes: ["delta"],
    requestedAt: FIXED_NOW,
    now: () => FIXED_NOW
  });

  assert.equal(report.status, "failed");
  assert.equal(report.checkedCaseCount, 1);
  assert.deepEqual(
    new Set(report.errors.map((error) => error.code)),
    new Set([
      "source_id_matched",
      "connector_warning_shape",
      "connector_warning_leaks_sensitive_diagnostics",
      "records_match_source",
      "records_have_safe_acl"
    ])
  );

  let thrown: unknown;
  try {
    await assertCompanyConnectorContractTests({
      registry: registryWith(new UnsafeConnector()),
      company: { companyId: "acme", useCaseId: "docs" },
      requestedBy: principal,
      modes: ["delta"],
      requestedAt: FIXED_NOW,
      now: () => FIXED_NOW
    });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof CompanyConnectorContractError);
  assert.equal(thrown.report.status, "failed");
});

test("company connector contract runner rejects connector errors that copy record bodies", async () => {
  const report = await runCompanyConnectorContractTests({
    registry: registryWith(new LeakyErrorConnector()),
    company: { companyId: "acme", useCaseId: "docs" },
    requestedBy: principal,
    modes: ["delta"],
    requestedAt: FIXED_NOW,
    now: () => FIXED_NOW
  });

  assert.equal(report.status, "failed");
  assert.equal(
    report.errors.some((error) => error.code === "connector_error_leaks_record_body"),
    true
  );
});

function registryWith(connector: SourceConnector): CompanyDeploymentRegistry {
  return new CompanyDeploymentRegistry([
    {
      company,
      adapterPacks: [
        {
          id: "acme-pack",
          companyId: "acme",
          description: "Acme contract test adapter pack.",
          corpusAdapters: [new EmptyAdapter("acme-docs")],
          sourceConnectors: [connector],
          connectorTests: [{ connectorId: "docs", command: "npm test -- acme-docs" }]
        } satisfies CompanyAdapterPack
      ]
    }
  ]);
}

const company: CompanyProfile = {
  companyId: "acme",
  companyName: "Acme Co",
  defaultTenantId: "tenant_acme",
  useCases: [
    {
      id: "docs",
      kind: "docs",
      namespaceId: "acme-docs",
      name: "Acme Docs",
      purpose: "Answer Acme documentation questions.",
      baseProfile: genericDocsProfile,
      corpusSources: [
        {
          id: "docs",
          adapter: "acme-docs",
          description: "Acme docs source.",
          enabled: true,
          trustTierFloor: "trusted_internal"
        }
      ],
      evals: {
        goldenSetPath: "profiles/acme/docs/golden.jsonl",
        adversarialSetPath: "profiles/acme/docs/adversarial.jsonl",
        requiredChecks: genericDocsProfile.evals.requiredChecks
      }
    }
  ],
  connectors: [
    {
      id: "docs",
      adapterId: "acme-docs",
      sourceSystem: "confluence",
      useCaseIds: ["docs"],
      contractTestCommand: "npm test -- acme-docs"
    }
  ]
};

function record(
  overrides: Partial<CorpusRecord> & Pick<CorpusRecord, "id" | "sourceId">
): CorpusRecord {
  return {
    title: "Contract Fixture",
    body: "Contract fixture body.",
    sourceKind: "local_file",
    trustTier: "trusted_internal",
    sensitivity: "internal",
    accessScope: {
      tenantId: "tenant_acme",
      namespaceId: "acme-docs",
      roles: ["support"],
      tags: ["contract-test"]
    },
    capturedAt: FIXED_NOW,
    checksum: `checksum_${overrides.id}`,
    ...overrides
  };
}
