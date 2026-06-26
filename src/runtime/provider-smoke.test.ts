import assert from "node:assert/strict";
import test from "node:test";

import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { makeIndexedFixture } from "../test-support/fixtures.js";
import type {
  ProductionRagAnswerInput,
  ProductionRagAnswerResponse,
  ProductionRagApp,
  ProductionRagAppConfig
} from "./production-app.js";
import {
  defaultRequiredProviders,
  renderProviderSmokeHtmlReport,
  runProviderSmokePack
} from "./provider-smoke.js";
import type { StartupSelfTestCheck, StartupSelfTestOptions } from "./startup-self-test.js";

const CHECKED_AT = "2026-06-24T00:00:00.000Z";

test("provider smoke passes when required configured providers pass", async () => {
  const app = fakeSmokeApp([
    providerCheck("model_provider_probe", "passed"),
    providerCheck("embedding_provider_probe", "skipped"),
    providerCheck("visual_embedding_provider_asset_probe", "skipped"),
    providerCheck("visual_embedding_provider_query_probe", "skipped"),
    providerCheck("rerank_provider_probe", "skipped"),
    providerCheck("grounding_judge_provider_probe", "skipped")
  ]);

  const report = await runProviderSmokePack({
    app,
    requestedAt: CHECKED_AT,
    requiredProviders: ["model"]
  });

  assert.equal(report.status, "passed");
  assert.equal(report.requiredProviders.includes("model"), true);
  assert.equal(report.summary.requiredProviderCount, 1);
  assert.equal(report.summary.passedRequiredProviderCount, 1);
  assert.equal(report.failures.length, 0);
  assert.equal(JSON.stringify(report).includes("model-secret"), false);
});

test("provider smoke treats configured adapters as required by default", async () => {
  const app = fakeSmokeApp(
    [
      providerCheck("model_provider_probe", "passed"),
      providerCheck("embedding_provider_probe", "skipped"),
      providerCheck("visual_embedding_provider_asset_probe", "skipped"),
      providerCheck("visual_embedding_provider_query_probe", "skipped"),
      providerCheck("rerank_provider_probe", "skipped"),
      providerCheck("grounding_judge_provider_probe", "skipped")
    ],
    {},
    {
      embeddingAdapter: {
        provider: "indexed-embedding",
        modelName: "embedding-model",
        dimensions: 3
      }
    }
  );

  const report = await runProviderSmokePack({ app, requestedAt: CHECKED_AT });

  assert.deepEqual(defaultRequiredProviders(app), ["model", "embedding"]);
  assert.equal(report.status, "failed");
  assert.equal(
    report.failures.includes('Required provider "embedding" smoke status was skipped.'),
    true
  );
});

test("provider smoke fails when required visual checks are missing", async () => {
  const app = fakeSmokeApp([
    providerCheck("model_provider_probe", "passed"),
    providerCheck("visual_embedding_provider_asset_probe", "passed")
  ]);

  const report = await runProviderSmokePack({
    app,
    requestedAt: CHECKED_AT,
    requiredProviders: ["model", "visual_embedding"]
  });
  const visualCoverage = report.providerCoverage.find(
    (coverage) => coverage.provider === "visual_embedding"
  );

  assert.equal(report.status, "failed");
  assert.equal(visualCoverage?.status, "missing");
  assert.equal(
    report.failures.includes('Required provider "visual_embedding" smoke status was missing.'),
    true
  );
});

test("provider smoke report redacts failure messages and escapes html", async () => {
  const app = fakeSmokeApp([
    providerCheck(
      "model_provider_probe",
      "failed",
      'Provider failed with bearer abc.secret and <script>alert("x")</script>'
    )
  ]);

  const report = await runProviderSmokePack({
    app,
    requestedAt: CHECKED_AT,
    requiredProviders: ["model"]
  });
  const html = renderProviderSmokeHtmlReport(report);

  assert.equal(report.status, "failed");
  assert.equal(JSON.stringify(report).includes("abc.secret"), false);
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("&lt;script&gt;"), true);
});

function fakeSmokeApp(
  checks: readonly StartupSelfTestCheck[],
  configOverrides: Partial<ProductionRagAppConfig> = {},
  runtimeOverrides: Readonly<Record<string, unknown>> = {}
): ProductionRagApp {
  const { index } = makeIndexedFixture();
  const profile = assertValidProfile({
    ...genericDocsProfile,
    namespaceId: "test-namespace"
  });
  const config: ProductionRagAppConfig = {
    profile,
    storage: {
      index: { kind: "memory" },
      vector: { kind: "none" },
      visualVector: { kind: "none" }
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
    },
    ...configOverrides
  };

  return {
    config,
    profile,
    chunkStore: index,
    runtime: {
      ...runtimeOverrides
    } as unknown as ProductionRagApp["runtime"],
    answer: async (_input: ProductionRagAnswerInput): Promise<ProductionRagAnswerResponse> => ({
      status: "refused",
      refusal: {
        code: "no_evidence",
        message: "No evidence.",
        detail: "No evidence."
      },
      trace: {} as ProductionRagAnswerResponse["trace"]
    }),
    health: () => ({
      status: "ready",
      profileId: profile.id,
      namespaceId: profile.namespaceId,
      retrievalMode: profile.retrieval.mode,
      index: {
        storageKind: "memory",
        durable: false,
        documentCount: 1,
        chunkCount: 2
      },
      providers: {
        model: {
          id: "model-provider",
          provider: "json-chat",
          modelName: "answer-model"
        }
      }
    }),
    selfTest: async (options: StartupSelfTestOptions = {}) => ({
      status: checks.some((check) => check.status === "failed") ? "failed" : "passed",
      checkedAt: options.requestedAt ?? CHECKED_AT,
      profileId: profile.id,
      namespaceId: profile.namespaceId,
      retrievalMode: profile.retrieval.mode,
      probeProviders: options.probeProviders === true,
      checkCount: checks.length,
      failedCount: checks.filter((check) => check.status === "failed").length,
      skippedCount: checks.filter((check) => check.status === "skipped").length,
      checks
    })
  };
}

function providerCheck(
  id: string,
  status: StartupSelfTestCheck["status"],
  message = `${id} ${status}`
): StartupSelfTestCheck {
  return {
    id,
    kind: "provider_probe",
    status,
    message,
    provider: "json-chat",
    modelName: "answer-model"
  };
}
