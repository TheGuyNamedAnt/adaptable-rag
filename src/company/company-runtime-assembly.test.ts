import assert from "node:assert/strict";
import test from "node:test";

import type { CorpusAdapter, CorpusLoadRequest, CorpusLoadResult } from "../corpus/adapter.js";
import type { DocumentParser } from "../parsing/parser.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import type {
  SourceConnector,
  SourceConnectorSyncRequest,
  SourceConnectorSyncResult
} from "../sync/source-connector.js";
import { InMemorySourceSyncLedgerStore } from "../sync/sync-ledger.js";
import { makePrincipal } from "../test-support/fixtures.js";
import type { CompanyAdapterPack } from "./company-adapter-pack.js";
import { CompanyDeploymentRegistry } from "./company-deployment-registry.js";
import type { CompanyProfile } from "./company-profile.js";
import {
  assembleCompanyProductionSourceSyncRuntimes,
  assembleCompanyRuntime
} from "./company-runtime-assembly.js";
import { createProductionRagApp, type ProductionRagAppConfig } from "../runtime/production-app.js";

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

const parser: DocumentParser = {
  id: "acme-parser",
  description: "Fixture parser.",
  capabilities: {
    inputMode: "text",
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

const financeParser: DocumentParser = {
  id: "finance-parser",
  description: "Finance parser.",
  capabilities: {
    inputMode: "text",
    emitsLayout: false,
    emitsTables: false,
    emitsVisualAssets: false
  },
  async parse() {
    return {
      sourceId: "finance",
      parserId: "finance-parser",
      document: { body: "finance parsed" },
      warnings: []
    };
  }
};

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
      parserIds: ["acme-parser"],
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
    },
    {
      id: "finance",
      kind: "docs",
      namespaceId: "acme-finance",
      name: "Acme Finance",
      purpose: "Answer Acme finance documentation questions.",
      baseProfile: genericDocsProfile,
      parserIds: ["finance-parser"],
      corpusSources: [
        {
          id: "finance",
          adapter: "acme-finance",
          description: "Acme finance docs.",
          enabled: true,
          trustTierFloor: "trusted_internal"
        }
      ],
      evals: {
        goldenSetPath: "profiles/acme/finance/golden.jsonl",
        adversarialSetPath: "profiles/acme/finance/adversarial.jsonl",
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
    },
    {
      id: "finance",
      adapterId: "acme-finance",
      sourceSystem: "finance-drive",
      useCaseIds: ["finance"]
    }
  ]
};

const adapterPack: CompanyAdapterPack = {
  id: "acme-pack",
  companyId: "acme",
  description: "Acme adapter pack.",
  corpusAdapters: [
    new EmptyAdapter("acme-docs"),
    new EmptyAdapter("acme-finance"),
    new EmptyAdapter("unused-adapter")
  ],
  sourceConnectors: [new EmptySourceConnector("docs"), new EmptySourceConnector("finance")],
  parsers: [parser, financeParser],
  connectorTests: [
    { connectorId: "docs", command: "npm test -- acme-docs" },
    { connectorId: "finance", command: "npm test -- acme-finance" }
  ]
};

test("assembleCompanyRuntime resolves profile plus ingestion extension inputs", () => {
  const registry = new CompanyDeploymentRegistry([{ company, adapterPacks: [adapterPack] }]);
  const assembly = assembleCompanyRuntime(registry, {
    companyId: "acme",
    useCaseId: "docs"
  });

  assert.equal(assembly.resolution.profile.id, "acme.docs");
  assert.deepEqual(assembly.declaredSourceIds, ["docs"]);
  assert.deepEqual(assembly.declaredAdapterIds, ["acme-docs"]);
  assert.deepEqual(
    assembly.corpusAdapterExtensions.map((extension) => extension.adapter.id),
    ["acme-docs"]
  );
  assert.deepEqual(
    assembly.parserExtensions.map((extension) => extension.parser.id),
    ["acme-parser"]
  );
  assert.deepEqual(
    assembly.sourceConnectorRegistrations.map((registration) => [
      registration.connectorId,
      registration.sourceSystem,
      registration.sourceIds
    ]),
    [["docs", "confluence", ["docs"]]]
  );
  assert.deepEqual(assembly.connectorTestCommands, ["npm test -- acme-docs"]);
});

test("assembleCompanyRuntime scopes integrations to the selected use case", () => {
  const registry = new CompanyDeploymentRegistry([{ company, adapterPacks: [adapterPack] }]);
  const docs = assembleCompanyRuntime(registry, {
    companyId: "acme",
    useCaseId: "docs"
  });
  const finance = assembleCompanyRuntime(registry, {
    companyId: "acme",
    useCaseId: "finance"
  });

  assert.deepEqual(
    docs.corpusAdapterExtensions.map((extension) => extension.adapter.id),
    ["acme-docs"]
  );
  assert.deepEqual(
    docs.parserExtensions.map((extension) => extension.parser.id),
    ["acme-parser"]
  );
  assert.deepEqual(
    docs.sourceConnectorRegistrations.map((registration) => registration.connectorId),
    ["docs"]
  );
  assert.deepEqual(docs.connectorTestCommands, ["npm test -- acme-docs"]);

  assert.deepEqual(
    finance.corpusAdapterExtensions.map((extension) => extension.adapter.id),
    ["acme-finance"]
  );
  assert.deepEqual(
    finance.parserExtensions.map((extension) => extension.parser.id),
    ["finance-parser"]
  );
  assert.deepEqual(
    finance.sourceConnectorRegistrations.map((registration) => registration.connectorId),
    ["finance"]
  );
  assert.deepEqual(finance.connectorTestCommands, ["npm test -- acme-finance"]);
});

test("assembleCompanyRuntime can resolve by namespace and fails through registry lookup rules", () => {
  const registry = new CompanyDeploymentRegistry([{ company, adapterPacks: [adapterPack] }]);
  const assembly = assembleCompanyRuntime(registry, { namespaceId: "acme-docs" });

  assert.equal(assembly.resolution.company.companyId, "acme");
  assert.throws(
    () => assembleCompanyRuntime(registry, { namespaceId: "missing" }),
    /Company RAG profile lookup failed/
  );
});

test("assembleCompanyProductionSourceSyncRuntimes builds plug-and-play sync runtimes", async () => {
  const registry = new CompanyDeploymentRegistry([{ company, adapterPacks: [adapterPack] }]);
  const assembly = assembleCompanyRuntime(registry, { companyId: "acme", useCaseId: "docs" });
  const ledgerStore = new InMemorySourceSyncLedgerStore();
  const app = createProductionRagApp({
    config: productionConfig(assembly.resolution.profile),
    env: providerEnv(),
    sourceSyncLedgerStore: ledgerStore
  });

  const syncRuntimes = assembleCompanyProductionSourceSyncRuntimes(registry, {
    companyId: "acme",
    useCaseId: "docs",
    app
  });

  assert.equal(syncRuntimes.length, 1);
  assert.equal(syncRuntimes[0]?.connectorId, "docs");
  assert.deepEqual(syncRuntimes[0]?.sourceIds, ["docs"]);

  const principal = makePrincipal({
    tenantId: "tenant_acme",
    namespaceIds: ["acme-docs"],
    roles: ["admin"],
    tags: ["curated"]
  });
  const result = await syncRuntimes[0]?.runtime.sync({
    sourceId: "docs",
    requestedBy: principal,
    runId: "company_source_sync_runtime"
  });

  assert.equal(result?.status, "skipped");
  assert.equal(result?.ledgerSaved, true);
  assert.equal(
    (
      await ledgerStore.load({
        connectorId: "docs",
        sourceId: "docs",
        namespaceId: "acme-docs"
      })
    )?.status,
    "succeeded"
  );
});

function productionConfig(profile: ProductionRagAppConfig["profile"]): ProductionRagAppConfig {
  return {
    profile,
    storage: {
      index: { kind: "memory" },
      vector: { kind: "none" },
      sourceSyncLedger: { kind: "memory" }
    },
    providers: {
      modelPrefix: "RAG_MODEL",
      embeddingPrefix: "RAG_EMBEDDING",
      visualEmbeddingPrefix: "RAG_VISUAL_EMBEDDING",
      rerankPrefix: "RAG_RERANK",
      groundingJudgePrefix: "RAG_GROUNDING_JUDGE",
      embeddingMode: "disabled",
      visualEmbeddingMode: "disabled",
      rerankProviderMode: "disabled",
      groundingJudgeProviderMode: "disabled"
    },
    http: {
      host: "127.0.0.1",
      port: 0,
      maxBodyBytes: 65536,
      auth: {
        mode: "disabled",
        headerName: "authorization",
        tokenSha256s: []
      },
      rateLimit: {
        mode: "disabled",
        windowMs: 60_000,
        maxRequests: 60,
        maxKeys: 100
      },
      operations: {
        logMode: "disabled",
        requestIdHeader: "x-request-id",
        readinessPath: "/ready",
        metricsPath: "/metrics"
      }
    }
  };
}

function providerEnv(): Readonly<Record<string, string | undefined>> {
  return {
    RAG_MODEL_PROVIDER: "json-chat",
    RAG_MODEL_MODEL_NAME: "answer-model",
    RAG_MODEL_ENDPOINT: "https://provider.example.test/v1/chat",
    RAG_MODEL_API_KEY: "model-secret"
  };
}
