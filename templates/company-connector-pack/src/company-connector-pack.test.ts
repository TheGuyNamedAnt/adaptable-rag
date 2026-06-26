import assert from "node:assert/strict";
import test from "node:test";

import { CompanyDeploymentRegistry, hashText, runCompanyPackContractTests } from "adaptable-rag";

import {
  createCompanyConnectorAdapterPack,
  type CompanyDocsClient,
  type CompanyDocsItem
} from "./company-adapter-pack.js";
import { companyProfile } from "./company-profile.js";

const FIXED_NOW = "2026-06-24T00:00:00.000Z";

test("company connector pack passes the generic pack contract gate", async () => {
  const client = new FixtureCompanyDocsClient();
  const registry = new CompanyDeploymentRegistry([
    {
      company: companyProfile,
      adapterPacks: [createCompanyConnectorAdapterPack({ client })]
    }
  ]);

  const report = await runCompanyPackContractTests({
    registry,
    company: {
      companyId: companyProfile.companyId,
      useCaseId: "docs"
    },
    requestedBy: {
      userId: "connector_contract_test",
      tenantId: companyProfile.defaultTenantId,
      namespaceIds: ["company-docs"],
      teamIds: ["docs"],
      roles: ["docs_reader"],
      tags: ["trusted_internal"]
    },
    requestedAt: FIXED_NOW,
    now: () => FIXED_NOW,
    expectations: {
      corpusAdapter: {
        minLoadedRecords: 1,
        minAcceptedDocuments: 1,
        maxRejectedRecords: 0,
        allowAdapterWarnings: false
      },
      connector: {
        minDeltaReturnedRecords: 2,
        requireFullComplete: true,
        requireSafeAccessBoundary: true,
        allowConnectorWarnings: false
      },
      permissionMapperNativeAcl: {
        tenantId: companyProfile.defaultTenantId,
        namespaceId: "company-docs",
        teamIds: ["docs"],
        roles: ["docs_reader"],
        tags: ["trusted_internal"]
      }
    }
  });

  assert.equal(report.status, "passed");
  assert.equal(report.checkedAdapterCount, 1);
  assert.equal(report.checkedConnectorCount, 1);
  assert.equal(report.checkedPermissionMapperCount, 1);
  assert.equal(report.checkedCaseCount, 4);
  assert.equal(report.adapterContracts[0]?.acceptedDocumentCount, 1);
  assert.deepEqual(
    client.loadCursors,
    [undefined, "company_docs_page_after_current"],
    "adapter contract should prove paginated source loading"
  );
  assert.deepEqual(client.syncCalls, [
    { mode: "delta", cursor: undefined },
    { mode: "full", cursor: "cursor_after_delta_company_docs" }
  ]);
  assert.equal(report.connectorContracts.cases[0]?.run.records.length, 2);
  assert.equal(
    report.connectorContracts.cases[0]?.run.records[0]?.accessScope.roles?.[0],
    "docs_reader"
  );
  assert.equal(report.connectorContracts.cases[1]?.run.deleted[0]?.recordId, "company_doc_retired");
  assert.equal(report.connectorContracts.cases[1]?.run.metrics.tombstonedMissingCount, 1);
  assert.equal(
    JSON.stringify(report.connectorContracts.cases[1]?.run.ledger).includes(
      "Retired document body"
    ),
    false
  );
  assert.equal(report.permissionMapperContracts[0]?.scope?.namespaceId, "company-docs");
  assert.deepEqual(report.permissionMapperContracts[0]?.scope?.teamIds, ["docs"]);
});

class FixtureCompanyDocsClient implements CompanyDocsClient {
  readonly loadCursors: (string | undefined)[] = [];
  readonly syncCalls: { readonly mode: "delta" | "full"; readonly cursor: string | undefined }[] =
    [];

  async listDocuments(input: Parameters<CompanyDocsClient["listDocuments"]>[0]) {
    this.loadCursors.push(input.cursor);
    if (input.cursor === undefined) {
      return {
        items: [fixtureItem("company_doc_contract", "Company Connector Contract Fixture")],
        cursor: "company_docs_page_after_current"
      };
    }

    assert.equal(input.cursor, "company_docs_page_after_current");
    return {
      items: []
    };
  }

  async listChangedDocuments(input: Parameters<CompanyDocsClient["listChangedDocuments"]>[0]) {
    this.syncCalls.push({ mode: input.mode, cursor: input.cursor });

    if (input.mode === "delta") {
      return {
        items: [
          {
            operation: "upsert" as const,
            item: fixtureItem("company_doc_contract", "Company Connector Contract Fixture")
          },
          {
            operation: "upsert" as const,
            item: fixtureItem("company_doc_retired", "Retired Company Doc")
          }
        ],
        cursor: "cursor_after_delta_company_docs",
        complete: false
      };
    }

    assert.equal(input.cursor, "cursor_after_delta_company_docs");
    return {
      items: [
        {
          operation: "upsert" as const,
          item: fixtureItem("company_doc_contract", "Company Connector Contract Fixture")
        }
      ],
      complete: true
    };
  }
}

function fixtureItem(recordId: string, title: string): CompanyDocsItem {
  const body =
    recordId === "company_doc_retired"
      ? "Retired document body that must not be copied into sync ledgers."
      : "Contract fixture body that should be indexed but never copied into sync ledgers.";
  return {
    sourceItemId: `source_item_${recordId}`,
    recordId,
    title,
    body,
    updatedAt: FIXED_NOW,
    checksum: hashText(body),
    version: "1",
    originUri: "https://docs.company.example/internal/contract-fixture",
    owner: "docs-team",
    nativeAcl: {
      tenantId: companyProfile.defaultTenantId,
      namespaceId: "company-docs",
      roles: ["docs_reader"],
      tags: ["trusted_internal"]
    }
  };
}
