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
    now: () => FIXED_NOW
  });

  assert.equal(report.status, "passed");
  assert.equal(report.checkedAdapterCount, 1);
  assert.equal(report.checkedConnectorCount, 1);
  assert.equal(report.checkedPermissionMapperCount, 1);
  assert.equal(report.checkedCaseCount, 4);
  assert.equal(report.adapterContracts[0]?.acceptedDocumentCount, 1);
  assert.deepEqual(client.syncModes, ["delta", "full"]);
  assert.equal(
    report.connectorContracts.cases[0]?.run.records[0]?.accessScope.roles?.[0],
    "docs_reader"
  );
  assert.equal(
    report.connectorContracts.cases[1]?.run.deleted[0]?.recordId,
    "company_doc_contract"
  );
  assert.equal(report.permissionMapperContracts[0]?.scope?.namespaceId, "company-docs");
});

class FixtureCompanyDocsClient implements CompanyDocsClient {
  readonly syncModes: string[] = [];

  async listDocuments() {
    return {
      items: [fixtureItem()]
    };
  }

  async listChangedDocuments(input: Parameters<CompanyDocsClient["listChangedDocuments"]>[0]) {
    this.syncModes.push(input.mode);

    if (input.mode === "delta") {
      return {
        items: [
          {
            operation: "upsert" as const,
            item: fixtureItem()
          }
        ],
        cursor: "cursor_after_company_doc_contract",
        complete: false
      };
    }

    return {
      items: [],
      complete: true
    };
  }
}

function fixtureItem(): CompanyDocsItem {
  const body = "Contract fixture body that should be indexed but never copied into sync ledgers.";
  return {
    sourceItemId: "source_item_company_doc_contract",
    recordId: "company_doc_contract",
    title: "Company Connector Contract Fixture",
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
