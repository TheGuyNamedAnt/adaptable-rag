import assert from "node:assert/strict";
import test from "node:test";

import type { CorpusAdapter, CorpusLoadRequest, CorpusLoadResult } from "../corpus/adapter.js";
import type { CorpusRecord } from "../corpus/corpus-record.js";
import type { DocumentParser } from "../parsing/parser.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { ownerDefinedAclMapper } from "../security/connector-acl-mapper.js";
import { hashText } from "../shared/hash.js";
import type {
  SourceConnector,
  SourceConnectorSyncRequest,
  SourceConnectorSyncResult
} from "../sync/source-connector.js";
import { FIXED_NOW, makePrincipal } from "../test-support/fixtures.js";
import type { CompanyAdapterPack } from "./company-adapter-pack.js";
import { CompanyDeploymentRegistry } from "./company-deployment-registry.js";
import type { CompanyProfile } from "./company-profile.js";
import {
  assertCompanyPackContractTests,
  CompanyPackContractError,
  runCompanyPackContractTests
} from "./company-pack-contract.js";

class ContractAdapter implements CorpusAdapter {
  readonly id = "docs-adapter";
  readonly description = "Company pack contract adapter.";

  constructor(private readonly empty = false) {}

  async load(request: CorpusLoadRequest): Promise<CorpusLoadResult> {
    return {
      sourceId: request.source.id,
      records: this.empty ? [] : [record(request.source.id)],
      warnings: []
    };
  }
}

class ContractConnector implements SourceConnector {
  readonly id = "docs-connector";
  readonly description = "Company pack contract source connector.";

  async sync(request: SourceConnectorSyncRequest): Promise<SourceConnectorSyncResult> {
    if (request.mode === "delta") {
      return {
        sourceId: request.source.id,
        complete: false,
        nextCursor: "cursor_delta",
        items: [
          {
            operation: "upsert",
            sourceItemId: "source_item_pack_contract",
            version: "1",
            record: record(request.source.id)
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

const parser: DocumentParser = {
  id: "docs-parser",
  description: "Company pack contract parser.",
  capabilities: {
    inputMode: "text",
    emitsLayout: false,
    emitsTables: false,
    emitsVisualAssets: false
  },
  async parse(request) {
    return {
      sourceId: request.sourceId,
      parserId: "docs-parser",
      document: {
        body: request.text ?? ""
      },
      warnings: []
    };
  }
};

const principal = makePrincipal({
  tenantId: "tenant_acme",
  namespaceIds: ["acme-docs"],
  roles: ["reader"],
  tags: ["contract-test"]
});

test("company pack contract runner validates adapters, parsers, connectors, and permission mappers", async () => {
  const report = await assertCompanyPackContractTests({
    registry: registryWith(pack()),
    company: { companyId: "acme", useCaseId: "docs" },
    requestedBy: principal,
    requestedAt: FIXED_NOW,
    now: () => FIXED_NOW
  });

  assert.equal(report.status, "passed");
  assert.equal(report.checkedAdapterCount, 1);
  assert.equal(report.checkedParserCount, 1);
  assert.equal(report.checkedConnectorCount, 1);
  assert.equal(report.checkedPermissionMapperCount, 1);
  assert.equal(report.adapterContracts[0]?.acceptedDocumentCount, 1);
  assert.equal(report.parserContracts[0]?.bodyLength, "Parsed company pack fixture.".length);
  assert.equal(report.connectorContracts.checkedCaseCount, 2);
  assert.equal(report.permissionMapperContracts[0]?.scope?.namespaceId, "acme-docs");
});

test("company pack contract runner reports adapter, parser fixture, and mapper failures", async () => {
  const report = await runCompanyPackContractTests({
    registry: registryWith(
      pack({
        adapter: new ContractAdapter(true),
        includeParserTest: false,
        mapperNamespaceId: "wrong-namespace"
      })
    ),
    company: { companyId: "acme", useCaseId: "docs" },
    requestedBy: principal,
    modes: ["delta"],
    requestedAt: FIXED_NOW,
    now: () => FIXED_NOW
  });

  assert.equal(report.status, "failed");
  assert.equal(
    report.issues.some(
      (issue) =>
        issue.code === "adapter_contract_failed" &&
        issue.upstreamCode === "loaded_record_count_below_minimum"
    ),
    true
  );
  assert.equal(
    report.issues.some((issue) => issue.code === "parser_contract_fixture_missing"),
    true
  );
  assert.equal(
    report.issues.some((issue) => issue.code === "permission_mapper_scope_invalid"),
    true
  );

  await assert.rejects(
    () =>
      assertCompanyPackContractTests({
        registry: registryWith(pack({ adapter: new ContractAdapter(true) })),
        company: { companyId: "acme", useCaseId: "docs" },
        requestedBy: principal,
        modes: ["delta"],
        requestedAt: FIXED_NOW,
        now: () => FIXED_NOW
      }),
    CompanyPackContractError
  );
});

function registryWith(adapterPack: CompanyAdapterPack): CompanyDeploymentRegistry {
  return new CompanyDeploymentRegistry([{ company, adapterPacks: [adapterPack] }]);
}

function pack(
  options: {
    readonly adapter?: CorpusAdapter;
    readonly includeParserTest?: boolean;
    readonly mapperNamespaceId?: string;
  } = {}
): CompanyAdapterPack {
  return {
    id: "acme-pack",
    companyId: "acme",
    description: "Acme contract test adapter pack.",
    corpusAdapters: [options.adapter ?? new ContractAdapter()],
    sourceConnectors: [new ContractConnector()],
    parsers: [parser],
    permissionMappers: [
      {
        sourceSystem: "docs-api",
        mapper: ownerDefinedAclMapper({
          id: "docs-api-acl",
          map: ({ context }) => ({
            tenantId: context.defaultTenantId,
            namespaceId: options.mapperNamespaceId ?? context.defaultNamespaceId,
            tags: context.defaultTags
          })
        })
      }
    ],
    connectorTests: [{ connectorId: "docs-connector", command: "npm test -- docs-connector" }],
    parserTests:
      options.includeParserTest === false
        ? []
        : [
            {
              parserId: "docs-parser",
              request: {
                sourceId: "parser_fixture",
                sourceKind: "uploaded_file",
                title: "Parser Fixture",
                contentType: "text/plain",
                text: "Parsed company pack fixture.",
                requestedAt: FIXED_NOW
              }
            }
          ]
  };
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
      parserIds: ["docs-parser"],
      corpusSources: [
        {
          id: "docs",
          adapter: "docs-adapter",
          description: "Acme docs source.",
          enabled: true,
          trustTierFloor: "trusted_internal",
          tags: ["contract-test"]
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
      id: "docs-connector",
      adapterId: "docs-adapter",
      sourceSystem: "docs-api",
      useCaseIds: ["docs"],
      contractTestCommand: "npm test -- docs-connector"
    }
  ],
  permissionMapping: {
    sourceSystem: "docs-api",
    tenantClaim: "tenant_id",
    namespaceClaim: "namespace_id",
    principalIdClaim: "user_id"
  }
};

function record(sourceId: string): CorpusRecord {
  const body = "Company pack contract body.";
  return {
    id: "doc_pack_contract",
    sourceId,
    sourceKind: "api_response",
    title: "Company Pack Contract",
    body,
    trustTier: "trusted_internal",
    sensitivity: "internal",
    accessScope: {
      tenantId: "tenant_acme",
      namespaceId: "acme-docs",
      tags: ["contract-test"]
    },
    capturedAt: FIXED_NOW,
    checksum: hashText(body)
  };
}
