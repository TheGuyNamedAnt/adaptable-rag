import assert from "node:assert/strict";
import test from "node:test";

import type { CorpusAdapter, CorpusLoadRequest, CorpusLoadResult } from "../corpus/adapter.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { ownerDefinedAclMapper } from "../security/connector-acl-mapper.js";
import type {
  SourceConnector,
  SourceConnectorSyncRequest,
  SourceConnectorSyncResult
} from "../sync/source-connector.js";
import type { CompanyProfile } from "./company-profile.js";
import {
  assertCompanyAdapterPack,
  companyParsersFromPacks,
  createCompanyCorpusAdapterRegistry,
  validateCompanyAdapterPack,
  type CompanyAdapterPack
} from "./company-adapter-pack.js";

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
          description: "Acme docs.",
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
      useCaseIds: ["docs"]
    }
  ]
};

function pack(overrides: Partial<CompanyAdapterPack> = {}): CompanyAdapterPack {
  return {
    id: "acme-pack",
    companyId: "acme",
    description: "Acme adapter pack.",
    corpusAdapters: [new EmptyAdapter("acme-docs")],
    sourceConnectors: [new EmptySourceConnector("docs")],
    permissionMappers: [
      {
        sourceSystem: "confluence",
        mapper: ownerDefinedAclMapper({
          id: "confluence",
          map: ({ context }) => ({
            tenantId: context.defaultTenantId,
            namespaceId: context.defaultNamespaceId,
            tags: context.defaultTags
          })
        })
      }
    ],
    connectorTests: [{ connectorId: "docs", command: "npm test -- acme-docs" }],
    ...overrides
  };
}

test("validates a company adapter pack and builds adapter/parser collections", () => {
  const parser = {
    id: "acme-parser",
    description: "Fixture parser.",
    capabilities: {
      inputMode: "text" as const,
      emitsLayout: false,
      emitsTables: false,
      emitsVisualAssets: false
    },
    async parse() {
      return {
        sourceId: "docs",
        parserId: "acme-parser",
        document: { body: "parsed" },
        warnings: []
      };
    }
  };
  const currentPack = pack({ parsers: [parser] });
  const result = assertCompanyAdapterPack(company, currentPack);
  const registry = createCompanyCorpusAdapterRegistry([currentPack]);

  assert.equal(result.valid, true);
  assert.equal(result.adapterCount, 1);
  assert.equal(result.sourceConnectorCount, 1);
  assert.equal(result.permissionMapperCount, 1);
  assert.equal(registry.getRequired("acme-docs").id, "acme-docs");
  assert.deepEqual(
    companyParsersFromPacks([currentPack]).map((entry) => entry.id),
    ["acme-parser"]
  );
});

test("reports duplicate adapters, unused registrations, and missing connector tests", () => {
  const result = validateCompanyAdapterPack(company, {
    ...pack(),
    corpusAdapters: [new EmptyAdapter("other"), new EmptyAdapter("other")],
    sourceConnectors: [new EmptySourceConnector("docs"), new EmptySourceConnector("docs")],
    connectorTests: []
  });

  assert.equal(result.valid, false);
  assert.equal(
    result.errors.some((issue) => issue.code === "duplicate_adapter_id"),
    true
  );
  assert.equal(
    result.errors.some((issue) => issue.code === "duplicate_source_connector_id"),
    true
  );
  assert.equal(
    result.warnings.some((issue) => issue.code === "registered_adapter_unused"),
    true
  );
  assert.equal(
    result.warnings.some((issue) => issue.code === "connector_test_missing"),
    true
  );
});

test("rejects adapter packs for the wrong company", () => {
  assert.throws(
    () => assertCompanyAdapterPack(company, pack({ companyId: "wrong" })),
    /companyId "wrong" does not match company "acme"/
  );
});
