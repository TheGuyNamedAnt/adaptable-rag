import assert from "node:assert/strict";
import test from "node:test";

import type { CorpusAdapter, CorpusLoadRequest, CorpusLoadResult } from "../corpus/adapter.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import type { CompanyAdapterPack } from "./company-adapter-pack.js";
import type { CompanyProfile } from "./company-profile.js";
import { CompanyDeploymentRegistry } from "./company-deployment-registry.js";
import { ownerDefinedAclMapper } from "../security/connector-acl-mapper.js";
import type {
  SourceConnector,
  SourceConnectorSyncRequest,
  SourceConnectorSyncResult
} from "../sync/source-connector.js";
import type { DocumentParser } from "../parsing/parser.js";

class EmptyAdapter implements CorpusAdapter {
  readonly description = "Empty test adapter.";

  constructor(readonly id: string) {}

  async load(request: CorpusLoadRequest): Promise<CorpusLoadResult> {
    return {
      sourceId: request.source.id,
      records: [],
      warnings: []
    };
  }
}

class EmptySourceConnector implements SourceConnector {
  readonly description = "Empty source connector.";

  constructor(readonly id: string) {}

  async sync(request: SourceConnectorSyncRequest): Promise<SourceConnectorSyncResult> {
    return {
      sourceId: request.source.id,
      complete: true,
      items: []
    };
  }
}

function parser(id: string): DocumentParser {
  return {
    id,
    description: "Empty parser.",
    capabilities: {
      inputMode: "text",
      emitsLayout: false,
      emitsTables: false,
      emitsVisualAssets: false
    },
    async parse() {
      return {
        sourceId: "docs",
        parserId: id,
        document: { body: "" },
        warnings: []
      };
    }
  };
}

function company(
  companyId: string,
  useCaseId = "support",
  namespaceId = `${companyId}-support`
): CompanyProfile {
  return {
    companyId,
    companyName: `${companyId} Co`,
    defaultTenantId: `tenant_${companyId}`,
    useCases: [
      {
        id: useCaseId,
        kind: "support",
        namespaceId,
        name: `${companyId} Support`,
        purpose: `Answer ${companyId} support questions from approved knowledge.`,
        baseProfile: genericDocsProfile,
        outputMode: "support_triage",
        corpusSources: [
          {
            id: `${companyId}_support_docs`,
            adapter: `${companyId}-support-docs`,
            description: `${companyId} support docs.`,
            enabled: true,
            trustTierFloor: "trusted_internal",
            tags: ["support", "trusted"]
          }
        ],
        evals: {
          goldenSetPath: `profiles/${companyId}/support/golden.jsonl`,
          adversarialSetPath: `profiles/${companyId}/support/adversarial.jsonl`,
          requiredChecks: genericDocsProfile.evals.requiredChecks
        }
      }
    ],
    connectors: [
      {
        id: "support-docs",
        adapterId: `${companyId}-support-docs`,
        sourceSystem: `${companyId}-admin`,
        useCaseIds: [useCaseId],
        contractTestCommand: `npm test -- ${companyId}-support-docs`
      }
    ]
  };
}

function multiSourceCompany(companyId: string): CompanyProfile {
  return {
    ...company(companyId),
    useCases: [
      {
        ...company(companyId).useCases[0]!,
        corpusSources: [
          {
            id: `${companyId}_support_docs`,
            adapter: `${companyId}-support-docs`,
            description: `${companyId} support docs.`,
            enabled: true,
            trustTierFloor: "trusted_internal",
            tags: ["support", "trusted"]
          },
          {
            id: `${companyId}_ticket_docs`,
            adapter: `${companyId}-ticket-docs`,
            description: `${companyId} ticket docs.`,
            enabled: true,
            trustTierFloor: "trusted_internal",
            tags: ["support", "tickets"]
          }
        ]
      }
    ],
    connectors: [
      {
        id: "support-docs",
        adapterId: `${companyId}-support-docs`,
        sourceSystem: `${companyId}-admin`,
        useCaseIds: ["support"],
        contractTestCommand: `npm test -- ${companyId}-support-docs`
      },
      {
        id: "ticket-docs",
        adapterId: `${companyId}-ticket-docs`,
        sourceSystem: `${companyId}-tickets`,
        useCaseIds: ["support"],
        contractTestCommand: `npm test -- ${companyId}-ticket-docs`
      }
    ]
  };
}

function adapterPack(companyId: string): CompanyAdapterPack {
  return {
    id: `${companyId}-pack`,
    companyId,
    description: `${companyId} adapter pack.`,
    corpusAdapters: [new EmptyAdapter(`${companyId}-support-docs`)],
    connectorTests: [{ connectorId: "support-docs", command: `npm test -- ${companyId}` }]
  };
}

test("registry resolves company deployments by use case, namespace, and profile id", () => {
  const registry = new CompanyDeploymentRegistry([company("acme"), company("globex")]);

  const byUseCase = registry.resolveProfileRequired({
    companyId: "acme",
    useCaseId: "support"
  });
  const byNamespace = registry.resolveProfileRequired({ namespaceId: "globex-support" });
  const byProfile = registry.resolveProfileRequired({ profileId: "acme.support" });

  assert.equal(byUseCase.profile.id, "acme.support");
  assert.equal(byUseCase.profile.namespaceId, "acme-support");
  assert.equal(byNamespace.company.companyId, "globex");
  assert.equal(byNamespace.profile.id, "globex.support");
  assert.equal(byProfile.useCaseId, "support");
  assert.equal(registry.listCompanies().length, 2);
  assert.equal(registry.listProfiles().length, 2);
});

test("registry attaches validated adapter packs to company entries", () => {
  const registry = new CompanyDeploymentRegistry([
    {
      company: company("acme"),
      adapterPacks: [adapterPack("acme")]
    }
  ]);
  const entry = registry.getCompanyRequired("acme");

  assert.equal(entry.adapterPacks.length, 1);
  assert.equal(entry.adapterPackReports[0]?.valid, true);
  assert.equal(entry.adapterPackReports[0]?.adapterCount, 1);
  assert.equal(entry.adapterPackCoverageReport?.valid, true);
  assert.equal(
    entry.adapterPackCoverageReport?.warnings.some(
      (issue) => issue.code === "declared_source_connector_missing"
    ),
    true
  );
});

test("registry allows multiple adapter packs to cover one company deployment", () => {
  const registry = new CompanyDeploymentRegistry([
    {
      company: multiSourceCompany("acme"),
      adapterPacks: [
        {
          id: "acme-support-pack",
          companyId: "acme",
          description: "Acme support docs adapter pack.",
          corpusAdapters: [new EmptyAdapter("acme-support-docs")]
        },
        {
          id: "acme-ticket-pack",
          companyId: "acme",
          description: "Acme ticket docs adapter pack.",
          corpusAdapters: [new EmptyAdapter("acme-ticket-docs")]
        }
      ]
    }
  ]);
  const entry = registry.getCompanyRequired("acme");

  assert.equal(entry.adapterPacks.length, 2);
  assert.equal(
    entry.adapterPackReports.every((report) => report.valid),
    true
  );
});

test("registry rejects duplicate implementations across adapter packs", () => {
  assert.throws(
    () =>
      new CompanyDeploymentRegistry([
        {
          company: multiSourceCompany("acme"),
          adapterPacks: [
            {
              id: "acme-support-pack",
              companyId: "acme",
              description: "Acme support docs adapter pack.",
              corpusAdapters: [new EmptyAdapter("acme-support-docs")],
              sourceConnectors: [new EmptySourceConnector("support-docs")],
              parsers: [parser("shared-parser")],
              permissionMappers: [
                {
                  sourceSystem: "acme-admin",
                  mapper: ownerDefinedAclMapper({
                    id: "shared-acl",
                    map: ({ context }) => ({
                      tenantId: context.defaultTenantId,
                      namespaceId: context.defaultNamespaceId
                    })
                  })
                }
              ]
            },
            {
              id: "acme-ticket-pack",
              companyId: "acme",
              description: "Acme ticket docs adapter pack.",
              corpusAdapters: [new EmptyAdapter("acme-ticket-docs")],
              sourceConnectors: [new EmptySourceConnector("support-docs")],
              parsers: [parser("shared-parser")],
              permissionMappers: [
                {
                  sourceSystem: "acme-admin",
                  mapper: ownerDefinedAclMapper({
                    id: "shared-acl",
                    map: ({ context }) => ({
                      tenantId: context.defaultTenantId,
                      namespaceId: context.defaultNamespaceId
                    })
                  })
                }
              ]
            }
          ]
        }
      ]),
    /provided by multiple adapter packs/
  );
});

test("registry rejects duplicate company ids and duplicate namespaces", () => {
  assert.throws(
    () => new CompanyDeploymentRegistry([company("acme"), company("acme")]),
    /Duplicate company deployment id/
  );

  assert.throws(
    () =>
      new CompanyDeploymentRegistry([
        company("acme", "support", "shared"),
        company("globex", "support", "shared")
      ]),
    /Duplicate company RAG namespaceId/
  );
});

test("registry fails closed for unready company deployments and missing lookups", () => {
  assert.throws(
    () =>
      new CompanyDeploymentRegistry([
        {
          ...company("broken"),
          useCases: []
        }
      ]),
    /is not ready/
  );

  const registry = new CompanyDeploymentRegistry([company("acme")]);

  assert.equal(registry.resolveProfile({ companyId: "acme", useCaseId: "missing" }), undefined);
  assert.throws(
    () => registry.resolveProfileRequired({ namespaceId: "missing" }),
    /Company RAG profile lookup failed/
  );
});

test("registry rejects invalid adapter packs before registration", () => {
  assert.throws(
    () =>
      new CompanyDeploymentRegistry([
        {
          company: company("acme"),
          adapterPacks: [
            {
              ...adapterPack("acme"),
              corpusAdapters: [new EmptyAdapter("wrong-adapter")]
            }
          ]
        }
      ]),
    /declares adapter "acme-support-docs"/
  );
});
