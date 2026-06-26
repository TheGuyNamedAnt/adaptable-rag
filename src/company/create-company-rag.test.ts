import assert from "node:assert/strict";
import test from "node:test";

import type { CorpusAdapter, CorpusLoadRequest, CorpusLoadResult } from "../corpus/adapter.js";
import type { CorpusRecord } from "../corpus/corpus-record.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import type {
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import type {
  SourceConnector,
  SourceConnectorSyncRequest,
  SourceConnectorSyncResult
} from "../sync/source-connector.js";
import { FIXED_NOW, makePrincipal } from "../test-support/fixtures.js";
import type { CompanyAdapterPack } from "./company-adapter-pack.js";
import { CompanyDeploymentRegistry } from "./company-deployment-registry.js";
import type { CompanyProfile } from "./company-profile.js";
import { createCompanyRag } from "./create-company-rag.js";

class StaticCompanyAdapter implements CorpusAdapter {
  readonly id = "acme-docs";
  readonly description = "Acme docs adapter.";

  async load(request: CorpusLoadRequest): Promise<CorpusLoadResult> {
    const record: CorpusRecord = {
      id: "acme_policy",
      sourceId: request.source.id,
      sourceKind: "api_response",
      title: "Acme Policy",
      body: "Acme refunds require support review.",
      trustTier: "trusted_internal",
      sensitivity: "internal",
      capturedAt: request.requestedAt,
      accessScope: {
        tenantId: request.requestedBy.tenantId,
        namespaceId: request.profile.namespaceId,
        tags: ["support"]
      },
      metadata: {
        sourceTags: "support,trusted"
      }
    };

    return {
      sourceId: request.source.id,
      records: [record],
      warnings: []
    };
  }
}

class StaticSourceConnector implements SourceConnector {
  readonly id = "docs";
  readonly description = "Acme docs source connector.";

  async sync(request: SourceConnectorSyncRequest): Promise<SourceConnectorSyncResult> {
    return {
      sourceId: request.source.id,
      complete: true,
      items: []
    };
  }
}

class MockProviderTransport implements ProviderTransport {
  readonly requests: ProviderHttpRequest[] = [];

  async send(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(request);
    return {
      status: 200,
      headers: {},
      body: {
        output_text: JSON.stringify({
          answer: "Acme refunds require support review.",
          citationChunkIds: ["chunk_acme_policy_0"],
          evidenceSummary: "The cited policy says refunds require support review.",
          confidence: "high"
        })
      },
      latencyMs: 1
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
          description: "Acme docs API.",
          enabled: true,
          trustTierFloor: "trusted_internal",
          tags: ["support", "trusted"]
        }
      ],
      evals: {
        goldenSetPath: "profiles/acme/docs/golden.jsonl",
        adversarialSetPath: "profiles/acme/docs/adversarial.jsonl",
        requiredChecks: genericDocsProfile.evals.requiredChecks
      },
      overrides: {
        freshnessPolicy: {
          mode: "versioned",
          requireCapturedAt: true
        },
        citationPolicy: {
          allowedSourceKindsForCitations: ["api_response"]
        }
      }
    }
  ],
  connectors: [
    {
      id: "docs",
      adapterId: "acme-docs",
      sourceSystem: "acme-api",
      useCaseIds: ["docs"],
      contractTestCommand: "npm test -- acme-docs"
    }
  ]
};

const adapterPack: CompanyAdapterPack = {
  id: "acme-pack",
  companyId: "acme",
  description: "Acme adapter pack.",
  corpusAdapters: [new StaticCompanyAdapter()],
  sourceConnectors: [new StaticSourceConnector()]
};

test("createCompanyRag builds a plug-and-play RAG from company registry and adapter pack", async () => {
  const registry = new CompanyDeploymentRegistry([{ company, adapterPacks: [adapterPack] }]);
  const rag = createCompanyRag({
    registry,
    company: { companyId: "acme", useCaseId: "docs" },
    config: productionConfig(),
    transport: new MockProviderTransport(),
    env: providerEnv(),
    now: () => FIXED_NOW
  });
  const principal = makePrincipal({
    tenantId: "tenant_acme",
    namespaceIds: ["acme-docs"],
    tags: ["support"]
  });
  const ingest = await rag.ingest({
    tenantId: "tenant_acme",
    namespaceId: "acme-docs",
    principal
  });
  const docs = rag.inspect.documents({
    tenantId: "tenant_acme",
    namespaceId: "acme-docs",
    principal
  });

  assert.equal(rag.companyRuntime.resolution.profile.id, "acme.docs");
  assert.deepEqual(rag.companyRuntime.declaredAdapterIds, ["acme-docs"]);
  assert.equal(ingest.status, "completed");
  assert.equal(ingest.counts.documentsAccepted, 1);
  assert.equal(docs.length, 1);
  assert.equal(docs[0]?.document.title, "Acme Policy");
});

function providerEnv(): Readonly<Record<string, string>> {
  return {
    RAG_MODEL_PROVIDER: "json-chat",
    RAG_MODEL_MODEL_NAME: "answer-model",
    RAG_MODEL_ENDPOINT: "https://provider.example.test/v1/chat",
    RAG_MODEL_API_KEY: "model-secret"
  };
}

function productionConfig() {
  return {
    storage: {
      index: { kind: "memory" as const },
      vector: { kind: "none" as const },
      visualVector: { kind: "none" as const }
    },
    providers: {
      modelPrefix: "RAG_MODEL",
      embeddingPrefix: "RAG_EMBEDDING",
      visualEmbeddingPrefix: "RAG_VISUAL_EMBEDDING",
      rerankPrefix: "RAG_RERANK",
      groundingJudgePrefix: "RAG_GROUNDING_JUDGE",
      embeddingMode: "disabled" as const,
      visualEmbeddingMode: "disabled" as const,
      rerankProviderMode: "disabled" as const,
      groundingJudgeProviderMode: "disabled" as const
    },
    http: {
      host: "127.0.0.1",
      port: 0,
      maxBodyBytes: 65536,
      auth: {
        mode: "disabled" as const,
        headerName: "authorization",
        tokenSha256s: []
      },
      rateLimit: {
        mode: "disabled" as const,
        windowMs: 60_000,
        maxRequests: 60,
        maxKeys: 100
      },
      operations: {
        logMode: "disabled" as const,
        requestIdHeader: "x-request-id",
        readinessPath: "/ready",
        metricsPath: "/metrics"
      }
    }
  };
}
