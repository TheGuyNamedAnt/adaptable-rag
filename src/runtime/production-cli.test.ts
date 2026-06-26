import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { APPROVED_KNOWLEDGE_ARTIFACT_ADAPTER_ID } from "../corpus/approved-knowledge-artifact-adapter.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile, type ValidatedRagProfile } from "../profiles/profile-validation.js";
import { buildRagSupportKnowledgeApprovalLedger } from "../support-bridge/approval-ledger.js";
import { buildRagSupportEventIdempotencyLedger } from "../support-bridge/idempotency-ledger.js";
import { buildRagSupportKnowledgeCandidateQueue } from "../support-bridge/knowledge-candidate-queue.js";
import { buildRagSupportEvent } from "../support-bridge/support-event.js";
import { makeIndexedFixture } from "../test-support/fixtures.js";
import { runProductionRagCli } from "./production-cli.js";
import type {
  ProductionRagAnswerInput,
  ProductionRagAnswerResponse,
  ProductionRagApp,
  ProductionRagAppConfig
} from "./production-app.js";
import { InMemorySourceSyncLedgerStore } from "../sync/sync-ledger.js";

const CLI_TEST_ENV = {
  RAG_INDEX_KIND: "memory",
  RAG_HTTP_AUTH_MODE: "disabled",
  RAG_HTTP_LOG_MODE: "disabled"
} as const;
const APPROVED_PROFILE_ID = "approved-artifact-profile";
const APPROVED_NAMESPACE_ID = "approved-artifact-namespace";
const APPROVED_SOURCE_ID = "approved_knowledge_approved-artifact-profile";

function fakeApp(
  config: ProductionRagAppConfig,
  onAnswer: (input: ProductionRagAnswerInput) => void = () => undefined,
  options: {
    readonly profileOverride?: ValidatedRagProfile;
    readonly sourceSyncLedgerStore?: ProductionRagApp["sourceSyncLedgerStore"];
  } = {}
): ProductionRagApp {
  const { index } = makeIndexedFixture();
  const profile =
    options.profileOverride ??
    assertValidProfile({
      ...genericDocsProfile,
      namespaceId: "test-namespace"
    });

  return {
    config,
    profile,
    chunkStore: index,
    ...(options.sourceSyncLedgerStore === undefined
      ? {}
      : { sourceSyncLedgerStore: options.sourceSyncLedgerStore }),
    runtime: {} as unknown as ProductionRagApp["runtime"],
    answer: async (input): Promise<ProductionRagAnswerResponse> => {
      onAnswer(input);
      return {
        status: "refused",
        refusal: {
          code: "no_evidence",
          message: "No evidence.",
          detail: "No evidence."
        },
        trace: {} as unknown as ProductionRagAnswerResponse["trace"]
      };
    },
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
          id: "model",
          provider: "json-chat",
          modelName: "answer-model"
        }
      }
    }),
    selfTest: async () => ({
      status: "passed",
      checkedAt: "2026-06-24T00:00:00.000Z",
      profileId: profile.id,
      namespaceId: profile.namespaceId,
      retrievalMode: profile.retrieval.mode,
      probeProviders: false,
      checkCount: 0,
      failedCount: 0,
      skippedCount: 0,
      checks: []
    })
  };
}

test("production CLI prints help without building the app", async () => {
  const stdout: string[] = [];
  const exitCode = await runProductionRagCli({
    argv: ["help"],
    stdout: (line) => stdout.push(line),
    stderr: () => undefined
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout[0]?.includes("validate-config"), true);
  assert.equal(stdout[0]?.includes("ingest"), true);
  assert.equal(stdout[0]?.includes("answer"), true);
});

test("production CLI validates config through the app health boundary", async () => {
  const stdout: string[] = [];
  const exitCode = await runProductionRagCli({
    argv: ["validate-config"],
    env: {
      ...CLI_TEST_ENV,
      RAG_MODEL_API_KEY: "model-secret"
    },
    stdout: (line) => stdout.push(line),
    stderr: () => undefined,
    appFactory: (config) => fakeApp(config)
  });

  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(stdout[0] ?? "{}").status, "ready");
  assert.equal(stdout.join("\n").includes("model-secret"), false);
});

test("production CLI can run startup self-tests from validate-config", async () => {
  const stdout: string[] = [];
  let capturedProbeProviders: boolean | undefined;
  const exitCode = await runProductionRagCli({
    argv: ["validate-config", "--self-test", "true", "--probe-providers", "true"],
    env: {
      ...CLI_TEST_ENV,
      RAG_MODEL_API_KEY: "model-secret"
    },
    stdout: (line) => stdout.push(line),
    stderr: () => undefined,
    appFactory: (config) => {
      const app = fakeApp(config);
      return {
        ...app,
        selfTest: async (options = {}) => {
          capturedProbeProviders = options.probeProviders;
          return {
            status: "passed",
            checkedAt: options.requestedAt ?? "2026-06-24T00:00:00.000Z",
            profileId: app.profile.id,
            namespaceId: app.profile.namespaceId,
            retrievalMode: app.profile.retrieval.mode,
            probeProviders: options.probeProviders === true,
            checkCount: 1,
            failedCount: 0,
            skippedCount: 0,
            checks: [
              {
                id: "retriever_supports_profile_mode",
                kind: "capability",
                status: "passed",
                message: "Retriever can serve keyword."
              }
            ]
          };
        }
      };
    },
    now: () => "2026-06-24T00:00:00.000Z"
  });

  const parsed = JSON.parse(stdout[0] ?? "{}") as {
    readonly status?: string;
    readonly probeProviders?: boolean;
  };

  assert.equal(exitCode, 0);
  assert.equal(parsed.status, "passed");
  assert.equal(parsed.probeProviders, true);
  assert.equal(capturedProbeProviders, true);
  assert.equal(stdout.join("\n").includes("model-secret"), false);
});

test("production CLI exposes health ready metrics and doctor commands", async () => {
  const commands = ["health", "ready", "metrics", "doctor"] as const;

  for (const command of commands) {
    const stdout: string[] = [];
    const exitCode = await runProductionRagCli({
      argv: [command],
      env: {
        ...CLI_TEST_ENV,
        RAG_MODEL_API_KEY: "model-secret"
      },
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
      appFactory: (config) => fakeApp(config),
      now: () => "2026-06-24T00:00:00.000Z",
      nowMs: () => Date.parse("2026-06-24T00:00:00.000Z")
    });
    const parsed = JSON.parse(stdout[0] ?? "{}") as {
      readonly status?: string;
      readonly ready?: boolean;
      readonly health?: unknown;
      readonly selfTest?: unknown;
    };

    assert.equal(exitCode, 0);
    if (command === "health") {
      assert.equal(parsed.status, "ready");
    }
    if (command === "ready") {
      assert.equal(parsed.status, "ready");
      assert.equal(parsed.ready, true);
      assert.notEqual(parsed.selfTest, undefined);
    }
    if (command === "metrics") {
      assert.equal(parsed.status, "ok");
      assert.notEqual(parsed.health, undefined);
    }
    if (command === "doctor") {
      assert.equal(parsed.status, "passed");
      assert.notEqual(parsed.selfTest, undefined);
    }
  }
});

test("production CLI backs up and restores local JSON index storage", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rag-cli-backup-"));
  const indexPath = path.join(tmp, "index.json");
  const backupPath = path.join(tmp, "backup.json");
  await writeFile(indexPath, JSON.stringify({ documents: [{ id: "before" }] }));

  const backupStdout: string[] = [];
  const backupExitCode = await runProductionRagCli({
    argv: ["backup", "--output", backupPath],
    env: {
      ...CLI_TEST_ENV,
      RAG_INDEX_KIND: "json_file",
      RAG_INDEX_PATH: indexPath,
      RAG_MODEL_API_KEY: "model-secret"
    },
    cwd: tmp,
    stdout: (line) => backupStdout.push(line),
    stderr: () => undefined,
    appFactory: (config) => fakeApp(config),
    now: () => "2026-06-24T00:00:00.000Z"
  });

  assert.equal(backupExitCode, 0);
  assert.equal(JSON.parse(backupStdout[0] ?? "{}").status, "completed");
  await writeFile(indexPath, JSON.stringify({ documents: [{ id: "after" }] }));

  const restoreStdout: string[] = [];
  const restoreExitCode = await runProductionRagCli({
    argv: ["restore", "--input", backupPath],
    env: {
      ...CLI_TEST_ENV,
      RAG_INDEX_KIND: "json_file",
      RAG_INDEX_PATH: indexPath,
      RAG_MODEL_API_KEY: "model-secret"
    },
    cwd: tmp,
    stdout: (line) => restoreStdout.push(line),
    stderr: () => undefined,
    appFactory: (config) => fakeApp(config),
    now: () => "2026-06-24T00:00:00.000Z"
  });

  assert.equal(restoreExitCode, 0);
  assert.equal(JSON.parse(restoreStdout[0] ?? "{}").status, "completed");
  assert.equal(
    await readFile(indexPath, "utf8"),
    JSON.stringify({ documents: [{ id: "before" }] })
  );
});

test("production CLI loads a company deployment module into validate-config", async () => {
  const modulePath = await writeCompanyDeploymentModule();
  const stdout: string[] = [];
  const exitCode = await runProductionRagCli({
    argv: ["validate-config"],
    env: {
      ...CLI_TEST_ENV,
      RAG_COMPANY_MODULE_PATH: modulePath,
      RAG_COMPANY_USE_CASE_ID: "docs"
    },
    stdout: (line) => stdout.push(line),
    stderr: () => undefined,
    appFactory: (config) =>
      fakeApp(config, () => undefined, {
        profileOverride: assertValidProfile(config.profile)
      })
  });

  const parsed = JSON.parse(stdout[0] ?? "{}") as {
    readonly status?: string;
    readonly profileId?: string;
    readonly namespaceId?: string;
    readonly companyDeployment?: {
      readonly companyId?: string;
      readonly useCaseId?: string;
      readonly profileId?: string;
      readonly namespaceId?: string;
      readonly adapterPackCount?: number;
      readonly packContracts?: { readonly status?: string };
    };
  };

  assert.equal(exitCode, 0);
  assert.equal(parsed.status, "ready");
  assert.equal(parsed.profileId, "cli_company.docs");
  assert.equal(parsed.namespaceId, "cli-company-docs");
  assert.equal(parsed.companyDeployment?.companyId, "cli_company");
  assert.equal(parsed.companyDeployment?.useCaseId, "docs");
  assert.equal(parsed.companyDeployment?.profileId, "cli_company.docs");
  assert.equal(parsed.companyDeployment?.namespaceId, "cli-company-docs");
  assert.equal(parsed.companyDeployment?.adapterPackCount, 1);
  assert.equal(parsed.companyDeployment?.packContracts?.status, "not_run");
});

test("production CLI injects company adapter packs into ingestion", async () => {
  const modulePath = await writeCompanyDeploymentModule();
  const stdout: string[] = [];
  const exitCode = await runProductionRagCli({
    argv: [
      "ingest",
      "--tenant-id",
      "tenant_cli_company",
      "--namespace-id",
      "cli-company-docs",
      "--user-id",
      "user_1",
      "--principal-namespace-id",
      "cli-company-docs",
      "--role",
      "reader",
      "--source-id",
      "cli_docs",
      "--overwrite",
      "replace",
      "--run-id",
      "cli_company_ingest_test",
      "--requested-at",
      "2026-06-24T00:00:00.000Z"
    ],
    env: {
      ...CLI_TEST_ENV,
      RAG_COMPANY_MODULE_PATH: modulePath,
      RAG_COMPANY_USE_CASE_ID: "docs"
    },
    stdout: (line) => stdout.push(line),
    stderr: () => undefined,
    appFactory: (config) =>
      fakeApp(config, () => undefined, {
        profileOverride: assertValidProfile(config.profile)
      })
  });

  const result = JSON.parse(stdout[0] ?? "{}") as {
    readonly status?: string;
    readonly runId?: string;
    readonly loadedSourceIds?: readonly string[];
    readonly counts?: {
      readonly documentsAccepted?: number;
      readonly chunksAccepted?: number;
      readonly recordsRejected?: number;
    };
  };

  assert.equal(exitCode, 0);
  assert.equal(result.status, "completed");
  assert.equal(result.runId, "cli_company_ingest_test");
  assert.deepEqual(result.loadedSourceIds, ["cli_docs"]);
  assert.equal(result.counts?.documentsAccepted, 1);
  assert.equal(result.counts?.chunksAccepted, 1);
  assert.equal(result.counts?.recordsRejected, 0);
  assert.equal(stdout.join("\n").includes("CLI company adapter body"), false);
});

test("production CLI can require company pack contracts before startup", async () => {
  const modulePath = await writeCompanyDeploymentModule();
  const stdout: string[] = [];
  const exitCode = await runProductionRagCli({
    argv: ["validate-config", "--run-pack-contracts", "true"],
    env: {
      ...CLI_TEST_ENV,
      RAG_COMPANY_MODULE_PATH: modulePath,
      RAG_COMPANY_USE_CASE_ID: "docs"
    },
    stdout: (line) => stdout.push(line),
    stderr: () => undefined,
    appFactory: (config) =>
      fakeApp(config, () => undefined, {
        profileOverride: assertValidProfile(config.profile)
      }),
    now: () => "2026-06-24T00:00:00.000Z"
  });

  const parsed = JSON.parse(stdout[0] ?? "{}") as {
    readonly companyDeployment?: {
      readonly packContracts?: {
        readonly status?: string;
        readonly checkedAdapterCount?: number;
        readonly errorCount?: number;
      };
    };
  };

  assert.equal(exitCode, 0);
  assert.equal(parsed.companyDeployment?.packContracts?.status, "passed");
  assert.equal(parsed.companyDeployment?.packContracts?.checkedAdapterCount, 1);
  assert.equal(parsed.companyDeployment?.packContracts?.errorCount, 0);
});

test("production CLI fails startup when required company pack contracts fail", async () => {
  const modulePath = await writeCompanyDeploymentModule({ emptyAdapter: true });
  const stderr: string[] = [];
  const exitCode = await runProductionRagCli({
    argv: ["validate-config"],
    env: {
      ...CLI_TEST_ENV,
      RAG_COMPANY_MODULE_PATH: modulePath,
      RAG_COMPANY_USE_CASE_ID: "docs",
      RAG_COMPANY_PACK_CONTRACT_MODE: "required"
    },
    stdout: () => undefined,
    stderr: (line) => stderr.push(line),
    appFactory: (config) =>
      fakeApp(config, () => undefined, {
        profileOverride: assertValidProfile(config.profile)
      }),
    now: () => "2026-06-24T00:00:00.000Z"
  });

  assert.equal(exitCode, 1);
  assert.equal(stderr[0]?.includes("Company pack contracts failed"), true);
  assert.equal(stderr.join("\n").includes("CLI company adapter body"), false);
});

test("production CLI syncs company source connectors through the selected module", async () => {
  const modulePath = await writeCompanyDeploymentModule();
  const ledgerStore = new InMemorySourceSyncLedgerStore();
  const stdout: string[] = [];
  const exitCode = await runProductionRagCli({
    argv: [
      "sync",
      "--mode",
      "delta",
      "--tenant-id",
      "tenant_cli_company",
      "--namespace-id",
      "cli-company-docs",
      "--user-id",
      "sync_operator",
      "--principal-namespace-id",
      "cli-company-docs",
      "--role",
      "reader",
      "--source-id",
      "cli_docs",
      "--run-id",
      "cli_company_sync_test",
      "--requested-at",
      "2026-06-24T00:00:00.000Z"
    ],
    env: {
      ...CLI_TEST_ENV,
      RAG_COMPANY_MODULE_PATH: modulePath,
      RAG_COMPANY_USE_CASE_ID: "docs"
    },
    stdout: (line) => stdout.push(line),
    stderr: () => undefined,
    appFactory: (config) =>
      fakeApp(config, () => undefined, {
        profileOverride: assertValidProfile(config.profile),
        sourceSyncLedgerStore: ledgerStore
      }),
    now: () => "2026-06-24T00:00:00.000Z"
  });

  const result = JSON.parse(stdout[0] ?? "{}") as {
    readonly status?: string;
    readonly mode?: string;
    readonly connectorCount?: number;
    readonly sourceCount?: number;
    readonly metrics?: {
      readonly syncedRecordCount?: number;
      readonly ingestedDocumentCount?: number;
      readonly ledgerSavedCount?: number;
    };
    readonly results?: readonly {
      readonly connectorId?: string;
      readonly sourceId?: string;
      readonly ledger?: { readonly saved?: boolean; readonly hasCursor?: boolean };
      readonly sync?: { readonly returnedRecordCount?: number; readonly warningCodes?: string[] };
      readonly ingest?: { readonly documentCount?: number; readonly chunkCount?: number };
    }[];
  };
  const saved = await ledgerStore.load({
    connectorId: "cli_docs_api",
    sourceId: "cli_docs",
    namespaceId: "cli-company-docs"
  });

  assert.equal(exitCode, 0);
  assert.equal(result.status, "succeeded");
  assert.equal(result.mode, "delta");
  assert.equal(result.connectorCount, 1);
  assert.equal(result.sourceCount, 1);
  assert.equal(result.metrics?.syncedRecordCount, 1);
  assert.equal(result.metrics?.ingestedDocumentCount, 1);
  assert.equal(result.metrics?.ledgerSavedCount, 1);
  assert.equal(result.results?.[0]?.connectorId, "cli_docs_api");
  assert.equal(result.results?.[0]?.sourceId, "cli_docs");
  assert.equal(result.results?.[0]?.ledger?.saved, true);
  assert.equal(result.results?.[0]?.ledger?.hasCursor, true);
  assert.equal(result.results?.[0]?.sync?.returnedRecordCount, 1);
  assert.equal(result.results?.[0]?.ingest?.documentCount, 1);
  assert.equal(result.results?.[0]?.ingest?.chunkCount, 1);
  assert.equal(saved?.cursor, "delta_cursor");
  assert.equal(stdout.join("\n").includes("CLI company adapter body"), false);
  assert.equal(stdout.join("\n").includes("delta_cursor"), false);
});

test("production CLI can run full company sync with connector and source filters", async () => {
  const modulePath = await writeCompanyDeploymentModule();
  const stdout: string[] = [];
  const exitCode = await runProductionRagCli({
    argv: [
      "sync",
      "--mode",
      "full",
      "--tenant-id",
      "tenant_cli_company",
      "--namespace-id",
      "cli-company-docs",
      "--user-id",
      "sync_operator",
      "--principal-namespace-id",
      "cli-company-docs",
      "--role",
      "reader",
      "--connector-id",
      "cli_docs_api",
      "--source-id",
      "cli_docs",
      "--delete-missing",
      "false"
    ],
    env: {
      ...CLI_TEST_ENV,
      RAG_COMPANY_MODULE_PATH: modulePath,
      RAG_COMPANY_USE_CASE_ID: "docs"
    },
    stdout: (line) => stdout.push(line),
    stderr: () => undefined,
    appFactory: (config) =>
      fakeApp(config, () => undefined, {
        profileOverride: assertValidProfile(config.profile)
      }),
    now: () => "2026-06-24T00:00:00.000Z"
  });

  const result = JSON.parse(stdout[0] ?? "{}") as {
    readonly status?: string;
    readonly mode?: string;
    readonly results?: readonly {
      readonly mode?: string;
      readonly complete?: boolean;
      readonly sync?: { readonly returnedRecordCount?: number };
    }[];
  };

  assert.equal(exitCode, 0);
  assert.equal(result.status, "succeeded");
  assert.equal(result.mode, "full");
  assert.equal(result.results?.[0]?.mode, "full");
  assert.equal(result.results?.[0]?.complete, true);
  assert.equal(result.results?.[0]?.sync?.returnedRecordCount, 1);
  assert.equal(stdout.join("\n").includes("CLI company adapter body"), false);
  assert.equal(stdout.join("\n").includes("full_cursor"), false);
});

test("production CLI requires a company deployment module for sync", async () => {
  const stderr: string[] = [];
  const exitCode = await runProductionRagCli({
    argv: [
      "sync",
      "--tenant-id",
      "tenant_1",
      "--user-id",
      "user_1",
      "--principal-namespace-id",
      "test-namespace"
    ],
    env: CLI_TEST_ENV,
    stdout: () => undefined,
    stderr: (line) => stderr.push(line),
    appFactory: (config) => fakeApp(config)
  });

  assert.equal(exitCode, 1);
  assert.equal(stderr[0]?.includes("RAG_COMPANY_MODULE_PATH"), true);
});

test("production CLI parses answer flags into a production answer request", async () => {
  let captured: ProductionRagAnswerInput | undefined;
  const stdout: string[] = [];
  const exitCode = await runProductionRagCli({
    argv: [
      "answer",
      "--question",
      "What is the refund policy?",
      "--tenant-id",
      "tenant_1",
      "--namespace-id",
      "test-namespace",
      "--user-id",
      "user_1",
      "--principal-namespace-id",
      "test-namespace",
      "--role",
      "support",
      "--tag",
      "support,billing",
      "--source-id",
      "curated_docs",
      "--top-k",
      "3",
      "--include-rejected",
      "true"
    ],
    env: CLI_TEST_ENV,
    stdout: (line) => stdout.push(line),
    stderr: () => undefined,
    appFactory: (config) =>
      fakeApp(config, (input) => {
        captured = input;
      })
  });

  assert.equal(exitCode, 0);
  assert.equal(captured?.question, "What is the refund policy?");
  assert.equal(captured?.tenantId, "tenant_1");
  assert.equal(
    (captured?.principal as { readonly namespaceIds?: readonly string[] }).namespaceIds?.[0],
    "test-namespace"
  );
  assert.deepEqual((captured?.principal as { readonly tags?: readonly string[] }).tags, [
    "support",
    "billing"
  ]);
  assert.equal(captured?.topK, 3);
  assert.equal(captured?.includeRejected, true);
  assert.equal(JSON.parse(stdout[0] ?? "{}").status, "refused");
});

test("production CLI returns request errors for unsafe incomplete principals", async () => {
  const stderr: string[] = [];
  const exitCode = await runProductionRagCli({
    argv: [
      "answer",
      "--question",
      "What is the refund policy?",
      "--tenant-id",
      "tenant_1",
      "--namespace-id",
      "test-namespace",
      "--user-id",
      "user_1"
    ],
    env: CLI_TEST_ENV,
    stdout: () => undefined,
    stderr: (line) => stderr.push(line),
    appFactory: (config) => fakeApp(config)
  });

  assert.equal(exitCode, 2);
  assert.equal(stderr[0]?.includes("principal-namespace-id"), true);
});

test("production CLI rejects unknown commands and invalid flag values", async () => {
  const unknownStderr: string[] = [];
  const unknownExit = await runProductionRagCli({
    argv: ["unknown"],
    env: CLI_TEST_ENV,
    stdout: () => undefined,
    stderr: (line) => unknownStderr.push(line),
    appFactory: (config) => fakeApp(config)
  });

  assert.equal(unknownExit, 2);
  assert.equal(unknownStderr[0]?.includes("Unknown command"), true);

  const invalidTopKStderr: string[] = [];
  const invalidTopKExit = await runProductionRagCli({
    argv: [
      "answer",
      "--question=What is the refund policy?",
      "--tenant-id=tenant_1",
      "--namespace-id=test-namespace",
      "--user-id=user_1",
      "--principal-namespace-id=test-namespace",
      "--top-k=zero"
    ],
    env: CLI_TEST_ENV,
    stdout: () => undefined,
    stderr: (line) => invalidTopKStderr.push(line),
    appFactory: (config) => fakeApp(config)
  });

  assert.equal(invalidTopKExit, 2);
  assert.equal(invalidTopKStderr[0]?.includes("top-k"), true);

  const missingValueStderr: string[] = [];
  const missingValueExit = await runProductionRagCli({
    argv: ["answer", "--question"],
    env: CLI_TEST_ENV,
    stdout: () => undefined,
    stderr: (line) => missingValueStderr.push(line),
    appFactory: (config) => fakeApp(config)
  });

  assert.equal(missingValueExit, 2);
  assert.equal(missingValueStderr[0]?.includes("Missing value"), true);
});

test("production CLI parses false boolean flags", async () => {
  let captured: ProductionRagAnswerInput | undefined;
  const exitCode = await runProductionRagCli({
    argv: [
      "answer",
      "--question",
      "What is the refund policy?",
      "--tenant-id",
      "tenant_1",
      "--namespace-id",
      "test-namespace",
      "--user-id",
      "user_1",
      "--principal-namespace-id",
      "test-namespace",
      "--include-rejected",
      "false"
    ],
    env: CLI_TEST_ENV,
    stdout: () => undefined,
    stderr: () => undefined,
    appFactory: (config) =>
      fakeApp(config, (input) => {
        captured = input;
      })
  });

  assert.equal(exitCode, 0);
  assert.equal(captured?.includeRejected, false);
});

test("production CLI ingests local files through the production ingestion runtime", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-cli-ingest-"));
  const docsDir = path.join(tempDir, "docs");
  await mkdir(docsDir);
  await writeFile(
    path.join(docsDir, "policy.md"),
    "CLI production ingest body must not be echoed.",
    "utf8"
  );
  const stdout: string[] = [];
  const exitCode = await runProductionRagCli({
    argv: [
      "ingest",
      "--tenant-id",
      "tenant_1",
      "--namespace-id",
      "test-namespace",
      "--user-id",
      "user_1",
      "--principal-namespace-id",
      "test-namespace",
      "--role",
      "admin",
      "--source-id",
      "curated_docs",
      "--overwrite",
      "replace",
      "--run-id",
      "cli_ingest_test"
    ],
    env: CLI_TEST_ENV,
    stdout: (line) => stdout.push(line),
    stderr: () => undefined,
    appFactory: (config) => fakeApp(config),
    ingestionConfig: {
      localFiles: {
        sources: [
          {
            sourceId: "curated_docs",
            rootDir: docsDir,
            includeExtensions: [".md"],
            accessScope: {
              tenantId: "tenant_1",
              namespaceId: "test-namespace",
              roles: ["admin"]
            }
          }
        ]
      }
    }
  });

  const result = JSON.parse(stdout[0] ?? "{}") as {
    readonly status?: string;
    readonly runId?: string;
    readonly counts?: {
      readonly documentsAccepted?: number;
      readonly chunksAccepted?: number;
    };
    readonly vector?: {
      readonly status?: string;
      readonly reason?: string;
    };
  };

  assert.equal(exitCode, 0);
  assert.equal(result.status, "completed");
  assert.equal(result.runId, "cli_ingest_test");
  assert.equal(result.counts?.documentsAccepted, 1);
  assert.equal(result.counts?.chunksAccepted, 1);
  assert.equal(result.vector?.reason, "vector_store_not_configured");
  assert.equal(stdout.join("\n").includes("CLI production ingest body"), false);
});

test("production CLI ingests approved knowledge ledger config from env", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-cli-approved-"));
  const ledger = approvedKnowledgeLedger();
  const artifact = ledger.approvedArtifacts[0];
  assert.ok(artifact);
  const ledgerPath = path.join(tempDir, "approval-ledger.json");
  const configPath = path.join(tempDir, "approved-knowledge.sources.json");
  await writeFile(ledgerPath, JSON.stringify(ledger), "utf8");
  await writeFile(
    configPath,
    JSON.stringify({
      sources: [
        {
          sourceId: APPROVED_SOURCE_ID,
          ledgerPath: "approval-ledger.json"
        }
      ]
    }),
    "utf8"
  );
  const stdout: string[] = [];
  const approvedProfile = approvedArtifactProfile();
  const exitCode = await runProductionRagCli({
    argv: [
      "ingest",
      "--tenant-id",
      "tenant_1",
      "--namespace-id",
      approvedProfile.namespaceId,
      "--user-id",
      "user_1",
      "--principal-namespace-id",
      approvedProfile.namespaceId,
      "--tag",
      "approved-knowledge",
      "--tag",
      "known_issue_candidate",
      "--tag",
      "customer_safe",
      "--source-id",
      APPROVED_SOURCE_ID,
      "--overwrite",
      "replace",
      "--run-id",
      "cli_approved_ingest_test"
    ],
    env: {
      ...CLI_TEST_ENV,
      RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH: configPath
    },
    stdout: (line) => stdout.push(line),
    stderr: () => undefined,
    appFactory: (config) =>
      fakeApp(config, () => undefined, {
        profileOverride: approvedProfile
      })
  });

  const result = JSON.parse(stdout[0] ?? "{}") as {
    readonly status?: string;
    readonly runId?: string;
    readonly loadedSourceIds?: readonly string[];
    readonly counts?: {
      readonly documentsAccepted?: number;
      readonly chunksAccepted?: number;
      readonly recordsRejected?: number;
    };
  };

  assert.equal(exitCode, 0);
  assert.equal(result.status, "completed");
  assert.equal(result.runId, "cli_approved_ingest_test");
  assert.deepEqual(result.loadedSourceIds, [APPROVED_SOURCE_ID]);
  assert.equal(result.counts?.documentsAccepted, 1);
  assert.equal(result.counts?.chunksAccepted, 1);
  assert.equal(result.counts?.recordsRejected, 0);
  assert.equal(stdout.join("\n").includes(artifact.body), false);
});

test("production CLI serve shuts down gracefully on SIGTERM", async () => {
  const stdout: string[] = [];
  const signalSource = new EventEmitter();
  const port = await freePort();
  const exitCode = await runProductionRagCli({
    argv: ["serve"],
    env: {
      ...CLI_TEST_ENV,
      RAG_HTTP_PORT: String(port)
    },
    stdout: (line) => {
      stdout.push(line);
      if ((JSON.parse(line) as { readonly status?: string }).status === "listening") {
        setImmediate(() => signalSource.emit("SIGTERM"));
      }
    },
    stderr: () => undefined,
    signalSource,
    appFactory: (config) => fakeApp(config)
  });

  assert.equal(exitCode, 0);
  assert.equal(
    stdout.some((line) => line.includes('"status":"shutting_down"')),
    true
  );
  assert.equal(
    stdout.some((line) => line.includes('"status":"stopped"')),
    true
  );
});

function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("Expected an address object for test server."));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

function approvedArtifactProfile(): ValidatedRagProfile {
  return assertValidProfile({
    ...genericDocsProfile,
    id: APPROVED_PROFILE_ID,
    namespaceId: APPROVED_NAMESPACE_ID,
    corpusSources: [
      {
        id: APPROVED_SOURCE_ID,
        adapter: APPROVED_KNOWLEDGE_ARTIFACT_ADAPTER_ID,
        description: "Human-approved support knowledge artifacts.",
        enabled: true,
        trustTierFloor: "generated_or_derived",
        tags: ["approved-knowledge"]
      }
    ],
    trustPolicy: {
      ...genericDocsProfile.trustPolicy,
      allowedTrustTiers: [
        ...genericDocsProfile.trustPolicy.allowedTrustTiers,
        "generated_or_derived"
      ],
      minimumAnswerTrustTier: "generated_or_derived"
    },
    citationPolicy: {
      ...genericDocsProfile.citationPolicy,
      allowedSourceKindsForCitations: [
        ...genericDocsProfile.citationPolicy.allowedSourceKindsForCitations,
        "derived_summary"
      ]
    },
    evals: {
      goldenSetPath: "profiles/approved-artifact/evals/golden.jsonl",
      adversarialSetPath: "profiles/approved-artifact/evals/adversarial.jsonl",
      requiredChecks: genericDocsProfile.evals.requiredChecks
    }
  });
}

async function writeCompanyDeploymentModule(
  options: {
    readonly emptyAdapter?: boolean;
  } = {}
): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-cli-company-"));
  const modulePath = path.join(tempDir, "company-deployment.mjs");
  const packageIndexUrl = new URL("../index.js", import.meta.url).href;

  await writeFile(
    modulePath,
    `import { genericDocsProfile, hashText } from ${JSON.stringify(packageIndexUrl)};

export const companyProfile = {
  companyId: "cli_company",
  companyName: "CLI Company",
  defaultTenantId: "tenant_cli_company",
  useCases: [
    {
      id: "docs",
      kind: "docs",
      namespaceId: "cli-company-docs",
      name: "CLI Company Docs",
      purpose: "Answer questions from CLI company documentation.",
      baseProfile: genericDocsProfile,
      corpusSources: [
        {
          id: "cli_docs",
          adapter: "cli-company-docs-api",
          description: "Approved CLI company documentation API.",
          enabled: true,
          trustTierFloor: "trusted_internal",
          tags: ["contract-test"]
        }
      ],
      evals: {
        goldenSetPath: "profiles/cli-company/docs/golden.jsonl",
        adversarialSetPath: "profiles/cli-company/docs/adversarial.jsonl",
        requiredChecks: genericDocsProfile.evals.requiredChecks
      }
    }
  ],
  connectors: [
    {
      id: "cli_docs_api",
      adapterId: "cli-company-docs-api",
      sourceSystem: "cli-docs-api",
      useCaseIds: ["docs"],
      contractTestCommand: "npm test -- cli-docs-api"
    }
  ]
};

class CliCompanyDocsAdapter {
  id = "cli-company-docs-api";
  description = "Loads CLI company documentation records.";

  async load(request) {
    const body = "CLI company adapter body.";
    return {
      sourceId: request.source.id,
      records: ${
        options.emptyAdapter === true
          ? "[]"
          : `[{
        id: "cli_company_doc_1",
        sourceId: request.source.id,
        sourceKind: "api_response",
        title: "CLI Company Doc",
        body,
        trustTier: "trusted_internal",
        sensitivity: "internal",
        accessScope: {
          tenantId: request.requestedBy.tenantId,
          namespaceId: request.profile.namespaceId,
          roles: ["reader"],
          tags: ["contract-test"]
        },
        originUri: "https://cli-company.example/docs/1",
        capturedAt: request.requestedAt,
        checksum: hashText(body)
      }]`
      },
      warnings: []
    };
  }
}

class CliCompanyDocsConnector {
  id = "cli_docs_api";
  description = "Syncs CLI company documentation records.";

  async sync(request) {
    const body = "CLI company adapter body.";
    return {
      sourceId: request.source.id,
      complete: true,
      nextCursor: request.mode === "full" ? "full_cursor" : "delta_cursor",
      items: ${
        options.emptyAdapter === true
          ? "[]"
          : `[{
        operation: "upsert",
        sourceItemId: "cli_company_doc_1",
        version: request.mode === "full" ? "full_1" : "delta_1",
        record: {
          id: "cli_company_doc_1",
          sourceId: request.source.id,
          sourceKind: "api_response",
          title: "CLI Company Doc",
          body,
          trustTier: "trusted_internal",
          sensitivity: "internal",
          accessScope: {
            tenantId: request.requestedBy.tenantId,
            namespaceId: request.profile.namespaceId,
            roles: ["reader"],
            tags: ["contract-test"]
          },
          originUri: "https://cli-company.example/docs/1",
          capturedAt: request.requestedAt,
          checksum: hashText(body)
        }
      }]`
      }
    };
  }
}

export const companyAdapterPack = {
  id: "cli-company-pack",
  companyId: "cli_company",
  description: "CLI company adapter pack.",
  corpusAdapters: [new CliCompanyDocsAdapter()],
  sourceConnectors: [new CliCompanyDocsConnector()]
};
`,
    "utf8"
  );

  return modulePath;
}

function approvedKnowledgeLedger() {
  const event = buildRagSupportEvent({
    eventId: "support_event_known_issue",
    sourceSystem: "admin_support",
    sourceEventId: "ticket_123:known_issue_signal",
    sourceTicketId: "ticket_123",
    runId: "run_ticket_123",
    traceId: "trace_ticket_123",
    profileId: APPROVED_PROFILE_ID,
    namespaceId: APPROVED_NAMESPACE_ID,
    eventType: "known_issue_candidate_created",
    occurredAt: "2026-06-24T00:00:00.000Z",
    summary: "Support ticket indicates a possible known issue.",
    evidenceRefs: [
      {
        refId: "artifact_ticket_123",
        kind: "ticket",
        sourceSystem: "admin_support",
        artifactPath: "support/artifacts/ticket_123.json",
        ticketId: "ticket_123",
        runId: "run_ticket_123",
        traceId: "trace_ticket_123",
        sensitivity: "internal_only",
        customerSafe: false
      }
    ],
    proposedKnowledgeAction: {
      kind: "known_issue_candidate",
      targetId: "known_issue_blocking_failure",
      knownIssueStatus: "candidate",
      title: "Possible blocking failure known issue",
      summary: "Create a known issue candidate from repeated blocking reports.",
      proposedWording: "We're checking whether this matches other reports.",
      requiresApproval: true,
      approverDestination: "engineering"
    }
  });
  const idempotencyLedger = buildRagSupportEventIdempotencyLedger({
    generatedAt: "2026-06-24T00:00:00.000Z",
    events: [event]
  });
  const queue = buildRagSupportKnowledgeCandidateQueue({
    generatedAt: "2026-06-24T00:00:00.000Z",
    events: [event],
    ledger: idempotencyLedger
  });
  const candidate = queue.candidates[0];
  assert.ok(candidate);

  return buildRagSupportKnowledgeApprovalLedger({
    generatedAt: "2026-06-24T00:00:00.000Z",
    queue,
    decisions: [
      {
        decisionId: "approval_decision_1",
        candidateId: candidate.candidateId,
        action: "approve",
        reviewerId: "reviewer_1",
        summary: "Approved known issue wording for CLI ingestion.",
        approvedTitle: "Blocking failure known issue",
        approvedBody:
          "Approved CLI knowledge says the blocking failure is known and engineering is investigating a fix. Support can tell customers that updates will be shared after the fix is confirmed.",
        visibility: "customer_safe",
        reasonCodes: ["confirmed_by_engineering"]
      }
    ]
  });
}
