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
import {
  InMemoryIndexGenerationStore,
  InMemoryIngestionJobQueue,
  InMemoryIngestionLeaseStore
} from "./ingestion-scale.js";
import { runProductionRagCli } from "./production-cli.js";
import type {
  ProductionRagAnswerInput,
  ProductionRagAnswerResponse,
  ProductionRagApp,
  ProductionRagAppConfig
} from "./production-app.js";
import type {
  ProductionRagIngestInput,
  ProductionRagIngestResponse
} from "./production-ingestion.js";
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

function fakeIngestResponse(input: ProductionRagIngestInput): ProductionRagIngestResponse {
  return {
    status: "completed",
    runId: input.runId ?? "fake_ingest_run",
    startedAt: input.requestedAt ?? "2026-06-24T00:01:00.000Z",
    finishedAt: "2026-06-24T00:01:01.000Z",
    loadedSourceIds: input.sourceIds ?? [],
    counts: {
      documentsAccepted: 1,
      chunksAccepted: 1,
      recordsRejected: 0,
      indexWritesAccepted: 1,
      indexWritesRejected: 0,
      adapterWarnings: 0,
      normalizationIssues: 0,
      parserQualityWarnings: 0,
      searchableArtifactWarnings: 0,
      chunkingWarnings: 0,
      integrityErrors: 0,
      integrityWarnings: 0
    },
    index: {
      storageKind: "memory",
      durable: false,
      documentCount: 1,
      chunkCount: 1
    },
    parserQuality: {} as ProductionRagIngestResponse["parserQuality"],
    integrity: {} as ProductionRagIngestResponse["integrity"],
    warnings: {
      adapter: [],
      normalization: [],
      parserQuality: [],
      searchableArtifacts: [],
      chunking: [],
      index: [],
      embedding: [],
      visualEmbedding: []
    },
    artifacts: {
      documents: [
        {
          id: "doc_raw",
          namespaceId: input.namespaceId ?? "test-namespace",
          title: "Raw Artifact",
          body: "worker raw artifact body",
          provenance: {
            sourceId: input.sourceIds?.[0] ?? "source",
            sourceKind: "local_file",
            title: "Raw Artifact",
            ingestedAt: input.requestedAt ?? "2026-06-24T00:01:00.000Z",
            capturedAt: input.requestedAt ?? "2026-06-24T00:01:00.000Z",
            trustTier: "trusted_internal",
            sensitivity: "internal",
            checksum: "checksum"
          },
          accessScope: {
            tenantId: input.tenantId,
            namespaceId: input.namespaceId ?? "test-namespace"
          }
        }
      ],
      chunks: []
    }
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

test("production CLI exposes file-backed inspect commands", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rag-cli-inspect-"));
  await writeFile(
    path.join(tmp, "trace.json"),
    JSON.stringify({
      runId: "run_1",
      traceId: "trace_1",
      profileId: "profile_1",
      namespaceId: "namespace_1",
      startedAt: "2026-06-24T00:00:00.000Z",
      finishedAt: "2026-06-24T00:00:01.000Z",
      status: "succeeded",
      plannedQueryHashes: ["hash_query"],
      retrievedChunkIds: ["chunk_policy"],
      rejectedChunkIds: ["chunk_denied"],
      finalCitations: [
        {
          chunkId: "chunk_policy",
          sourceId: "source_policy",
          title: "Refund Policy"
        }
      ],
      safetyFlags: [],
      events: [
        {
          kind: "run_started",
          at: "2026-06-24T00:00:00.000Z",
          message: "Run started."
        }
      ]
    }),
    "utf8"
  );
  await writeFile(
    path.join(tmp, "context.json"),
    JSON.stringify({
      blocks: [
        {
          index: 0,
          chunkId: "chunk_policy",
          documentId: "doc_policy",
          citation: {
            chunkId: "chunk_policy",
            sourceId: "source_policy",
            title: "Refund Policy"
          },
          provenance: {
            sourceId: "source_policy",
            sourceKind: "local_file",
            trustTier: "trusted_internal"
          }
        }
      ],
      rejected: [
        {
          chunkId: "chunk_stale",
          documentId: "doc_stale",
          code: "stale_source",
          reason: "Source freshness policy rejected this chunk."
        }
      ]
    }),
    "utf8"
  );
  await writeFile(
    path.join(tmp, "summary.json"),
    JSON.stringify({
      passed: false,
      suiteCount: 1,
      caseCount: 1,
      failures: ["case_failed failed: citation precision too low"],
      suites: [
        {
          profileId: "profile_1",
          namespaceId: "namespace_1",
          passed: false,
          requiredChecks: ["citation_required"],
          coveredChecks: ["citation_required"],
          missingRequiredChecks: [],
          caseCount: 1,
          failures: ["case_failed failed: citation precision too low"],
          cases: [
            {
              id: "case_failed",
              setKind: "golden",
              checks: ["citation_required"],
              passed: false,
              failures: ["citation precision too low"],
              retrievedDocumentIds: ["doc_policy"],
              finalCitationCount: 1
            }
          ]
        }
      ]
    }),
    "utf8"
  );

  const runInspect = async (argv: readonly string[]): Promise<unknown> => {
    const stdout: string[] = [];
    const exitCode = await runProductionRagCli({
      argv,
      cwd: tmp,
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
      appFactory: () => {
        throw new Error("inspect commands should not build the production app.");
      }
    });
    assert.equal(exitCode, 0);
    return JSON.parse(stdout[0] ?? "{}") as unknown;
  };

  const trace = (await runInspect(["inspect-trace", "--trace", "trace.json"])) as {
    readonly traceId?: string;
    readonly eventCount?: number;
  };
  const citation = (await runInspect([
    "inspect-citation",
    "--context",
    "context.json",
    "--chunk-id",
    "chunk_policy"
  ])) as {
    readonly citations?: readonly {
      readonly chunkId?: string;
      readonly contextBlockIndex?: number;
    }[];
  };
  const evalFailure = (await runInspect(["inspect-eval-failure", "--summary", "summary.json"])) as {
    readonly failureCount?: number;
    readonly cases?: readonly { readonly caseId?: string }[];
  };

  assert.equal(trace.traceId, "trace_1");
  assert.equal(trace.eventCount, 1);
  assert.equal(citation.citations?.[0]?.chunkId, "chunk_policy");
  assert.equal(citation.citations?.[0]?.contextBlockIndex, 0);
  assert.equal(evalFailure.failureCount, 1);
  assert.equal(evalFailure.cases?.[0]?.caseId, "case_failed");
});

test("production CLI requires postgres storage for ingestion inspection", async () => {
  for (const command of ["inspect-ingestion-jobs", "inspect-ingestion-job"]) {
    const stderr: string[] = [];
    const exitCode = await runProductionRagCli({
      argv: command === "inspect-ingestion-job" ? [command, "--job-id", "job_1"] : [command],
      stdout: () => undefined,
      stderr: (line) => stderr.push(line),
      appFactory: () => {
        throw new Error("ingestion inspection should not build the production app.");
      }
    });

    assert.equal(exitCode, 1);
    assert.equal(stderr[0]?.includes("postgres index storage"), true);
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

test("production CLI worker processes queued ingestion jobs with injected stores", async () => {
  const queue = new InMemoryIngestionJobQueue();
  const leaseStore = new InMemoryIngestionLeaseStore();
  await queue.enqueue({
    queueId: "queue_policy",
    jobId: "job_policy",
    runId: "run_policy",
    tenantId: "tenant_1",
    namespaceId: "test-namespace",
    sourceIds: ["policy_docs"],
    enqueuedAt: "2026-06-24T00:00:00.000Z"
  });
  await queue.enqueue({
    queueId: "queue_help",
    jobId: "job_help",
    runId: "run_help",
    tenantId: "tenant_1",
    namespaceId: "test-namespace",
    sourceIds: ["help_docs"],
    enqueuedAt: "2026-06-24T00:00:00.000Z"
  });

  const ingestInputs: ProductionRagIngestInput[] = [];
  const stdout: string[] = [];
  const exitCode = await runProductionRagCli({
    argv: [
      "worker",
      "--max-jobs",
      "3",
      "--worker-id",
      "worker_cli",
      "--tenant-id",
      "tenant_1",
      "--namespace-id",
      "test-namespace",
      "--overwrite",
      "replace",
      "--user-id",
      "worker_user",
      "--principal-namespace-id",
      "test-namespace",
      "--role",
      "ingestion-worker",
      "--heartbeat-interval-ms",
      "0",
      "--requested-at",
      "2026-06-24T00:01:00.000Z"
    ],
    env: CLI_TEST_ENV,
    stdout: (line) => stdout.push(line),
    stderr: () => undefined,
    appFactory: (config) => fakeApp(config),
    workerQueue: queue,
    workerLeaseStore: leaseStore,
    ingestRuntimeFactory: () => ({
      ingest: async (input) => {
        ingestInputs.push(input);
        return fakeIngestResponse(input);
      }
    }),
    now: () => "2026-06-24T00:02:00.000Z"
  });

  const result = JSON.parse(stdout[0] ?? "{}") as {
    readonly workerId?: string;
    readonly attemptedCount?: number;
    readonly completedCount?: number;
    readonly idleCount?: number;
    readonly results?: readonly {
      readonly status?: string;
      readonly queueJob?: { readonly queueId?: string; readonly status?: string };
      readonly ingestion?: {
        readonly runId?: string;
        readonly loadedSourceIds?: readonly string[];
        readonly artifacts?: unknown;
      };
    }[];
  };

  assert.equal(exitCode, 0);
  assert.equal(result.workerId, "worker_cli");
  assert.equal(result.attemptedCount, 2);
  assert.equal(result.completedCount, 2);
  assert.equal(result.idleCount, 1);
  assert.deepEqual(
    ingestInputs
      .map((input) => ({
        tenantId: input.tenantId,
        namespaceId: input.namespaceId,
        sourceIds: input.sourceIds,
        runId: input.runId,
        overwriteMode: input.overwriteMode
      }))
      .sort((left, right) => String(left.runId).localeCompare(String(right.runId))),
    [
      {
        tenantId: "tenant_1",
        namespaceId: "test-namespace",
        sourceIds: ["help_docs"],
        runId: "run_help",
        overwriteMode: "replace"
      },
      {
        tenantId: "tenant_1",
        namespaceId: "test-namespace",
        sourceIds: ["policy_docs"],
        runId: "run_policy",
        overwriteMode: "replace"
      }
    ]
  );
  assert.equal(result.results?.[0]?.queueJob?.status, "completed");
  assert.deepEqual(
    result.results
      ?.filter((job) => job.status === "completed")
      .flatMap((job) => job.ingestion?.loadedSourceIds ?? [])
      .sort(),
    ["help_docs", "policy_docs"]
  );
  assert.equal(
    result.results?.some((job) => job.ingestion?.artifacts !== undefined),
    false
  );
  assert.equal(stdout.join("\n").includes("worker raw artifact body"), false);
});

test("production CLI enqueues backfill ingestion batches", async () => {
  const queue = new InMemoryIngestionJobQueue();
  const stdout: string[] = [];
  const exitCode = await runProductionRagCli({
    argv: [
      "enqueue-ingestion",
      "--plan-id",
      "plan_backfill",
      "--tenant-id",
      "tenant_1",
      "--namespace-id",
      "test-namespace",
      "--source-id",
      "policy_docs",
      "--source-id",
      "help_docs",
      "--source-id",
      "faq_docs",
      "--batch-size",
      "2",
      "--priority",
      "7",
      "--max-attempts",
      "4",
      "--available-at",
      "2026-06-24T00:05:00.000Z",
      "--metadata",
      "reason=quarterly_backfill"
    ],
    env: CLI_TEST_ENV,
    stdout: (line) => stdout.push(line),
    stderr: () => undefined,
    appFactory: (config) => fakeApp(config),
    workerQueue: queue,
    now: () => "2026-06-24T00:00:00.000Z"
  });

  const result = JSON.parse(stdout[0] ?? "{}") as {
    readonly mode?: string;
    readonly dryRun?: boolean;
    readonly plannedJobCount?: number;
    readonly enqueuedJobCount?: number;
    readonly plannedJobs?: readonly {
      readonly queueId?: string;
      readonly sourceIds?: readonly string[];
      readonly priority?: number;
      readonly maxAttempts?: number;
      readonly availableAt?: string;
      readonly metadata?: Record<string, unknown>;
    }[];
    readonly enqueuedJobs?: readonly { readonly status?: string }[];
  };
  const queued = await queue.list();

  assert.equal(exitCode, 0);
  assert.equal(result.mode, "backfill");
  assert.equal(result.dryRun, false);
  assert.equal(result.plannedJobCount, 2);
  assert.equal(result.enqueuedJobCount, 2);
  assert.equal(result.plannedJobs?.[0]?.queueId, "plan_backfill_queue_1");
  assert.deepEqual(result.plannedJobs?.[0]?.sourceIds, ["policy_docs", "help_docs"]);
  assert.equal(result.plannedJobs?.[0]?.priority, 7);
  assert.equal(result.plannedJobs?.[0]?.maxAttempts, 4);
  assert.equal(result.plannedJobs?.[0]?.availableAt, "2026-06-24T00:05:00.000Z");
  assert.equal(result.plannedJobs?.[0]?.metadata?.reason, "quarterly_backfill");
  assert.deepEqual(
    queued.map((job) => [job.queueId, job.status, job.sourceIds]),
    [
      ["plan_backfill_queue_1", "queued", ["policy_docs", "help_docs"]],
      ["plan_backfill_queue_2", "queued", ["faq_docs"]]
    ]
  );
  assert.equal(
    result.enqueuedJobs?.every((job) => job.status === "queued"),
    true
  );
});

test("production CLI dry-runs reindex queue plans with generation promotion metadata", async () => {
  const stdout: string[] = [];
  const exitCode = await runProductionRagCli({
    argv: [
      "enqueue-ingestion",
      "--mode",
      "reindex",
      "--dry-run",
      "true",
      "--plan-id",
      "plan_reindex",
      "--tenant-id",
      "tenant_1",
      "--namespace-id",
      "test-namespace",
      "--source-id",
      "policy_docs",
      "--batch-size",
      "1",
      "--generation-id",
      "gen_candidate",
      "--active-generation-id",
      "gen_active",
      "--profile-id",
      "test-profile",
      "--embedding-provider",
      "openai",
      "--embedding-model",
      "text-embedding-3-large",
      "--embedding-dimensions",
      "3072",
      "--embedding-config-hash",
      "embedding_cfg_hash",
      "--embedding-index-config-hash",
      "index_cfg_hash",
      "--chunking-policy-id",
      "default-chunking",
      "--chunking-policy-version",
      "2",
      "--required-eval-id",
      "retrieval_regression",
      "--metadata",
      "operator=search-team"
    ],
    env: CLI_TEST_ENV,
    stdout: (line) => stdout.push(line),
    stderr: () => undefined,
    appFactory: (config) => fakeApp(config),
    now: () => "2026-06-24T00:00:00.000Z"
  });

  const result = JSON.parse(stdout[0] ?? "{}") as {
    readonly mode?: string;
    readonly dryRun?: boolean;
    readonly plannedJobCount?: number;
    readonly enqueuedJobCount?: number;
    readonly candidateGeneration?: {
      readonly generationId?: string;
      readonly embeddingDimensions?: number;
    };
    readonly promotion?: {
      readonly candidateGenerationId?: string;
      readonly previousActiveGenerationId?: string;
      readonly requiredEvalIds?: readonly string[];
      readonly actions?: readonly string[];
    };
    readonly plannedJobs?: readonly {
      readonly metadata?: Record<string, unknown>;
    }[];
  };

  assert.equal(exitCode, 0);
  assert.equal(result.mode, "reindex");
  assert.equal(result.dryRun, true);
  assert.equal(result.plannedJobCount, 1);
  assert.equal(result.enqueuedJobCount, 0);
  assert.equal(result.candidateGeneration?.generationId, "gen_candidate");
  assert.equal(result.candidateGeneration?.embeddingDimensions, 3072);
  assert.equal(result.promotion?.candidateGenerationId, "gen_candidate");
  assert.equal(result.promotion?.previousActiveGenerationId, "gen_active");
  assert.deepEqual(result.promotion?.requiredEvalIds, ["retrieval_regression"]);
  assert.deepEqual(result.promotion?.actions, [
    "validate_candidate_generation",
    "run_required_evals",
    "switch_active_generation",
    "mark_previous_generation_deprecated"
  ]);
  assert.equal(result.plannedJobs?.[0]?.metadata?.operator, "search-team");
  assert.equal(result.plannedJobs?.[0]?.metadata?.reindexGenerationId, "gen_candidate");
});

test("production CLI inspects, cancels, and requeues ingestion queue jobs without building the app", async () => {
  const queue = new InMemoryIngestionJobQueue();
  await queue.enqueue({
    queueId: "queue_cancel",
    jobId: "job_cancel",
    tenantId: "tenant_1",
    namespaceId: "test-namespace",
    sourceIds: ["cancel_docs"],
    enqueuedAt: "2026-06-24T00:00:00.000Z"
  });
  await queue.enqueue({
    queueId: "queue_dead",
    jobId: "job_dead",
    tenantId: "tenant_1",
    namespaceId: "test-namespace",
    sourceIds: ["dead_docs"],
    maxAttempts: 1,
    enqueuedAt: "2026-06-24T00:00:00.000Z"
  });
  await queue.claimNext({
    workerId: "worker_cli",
    now: "2026-06-24T00:00:30.000Z",
    leaseTtlMs: 60_000,
    sourceIds: ["dead_docs"]
  });
  await queue.fail({
    queueId: "queue_dead",
    workerId: "worker_cli",
    now: "2026-06-24T00:01:00.000Z",
    retryable: true,
    errorName: "ProviderError",
    errorMessage: "Provider unavailable."
  });

  const runQueueCommand = async (argv: readonly string[]): Promise<unknown> => {
    const stdout: string[] = [];
    const exitCode = await runProductionRagCli({
      argv,
      env: CLI_TEST_ENV,
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
      appFactory: () => {
        throw new Error("queue control commands should not build the production app.");
      },
      workerQueue: queue,
      now: () => "2026-06-24T00:02:00.000Z"
    });
    assert.equal(exitCode, 0);
    return JSON.parse(stdout[0] ?? "{}") as unknown;
  };

  const inspected = (await runQueueCommand([
    "inspect-ingestion-queue",
    "--tenant-id",
    "tenant_1",
    "--namespace-id",
    "test-namespace",
    "--status",
    "dead_letter"
  ])) as {
    readonly count?: number;
    readonly jobs?: readonly { readonly queueId?: string; readonly status?: string }[];
  };
  const cancelled = (await runQueueCommand([
    "cancel-ingestion-queue-job",
    "--queue-id",
    "queue_cancel",
    "--reason",
    "Duplicate backfill request.",
    "--requested-at",
    "2026-06-24T00:02:30.000Z"
  ])) as {
    readonly status?: string;
    readonly queueJob?: {
      readonly queueId?: string;
      readonly status?: string;
      readonly errorMessage?: string;
    };
  };
  const requeued = (await runQueueCommand([
    "requeue-ingestion-queue-job",
    "--queue-id",
    "queue_dead",
    "--available-at",
    "2026-06-24T00:05:00.000Z",
    "--max-attempts",
    "3",
    "--reason",
    "Provider recovered.",
    "--metadata",
    "operator=search-team",
    "--requested-at",
    "2026-06-24T00:03:00.000Z"
  ])) as {
    readonly status?: string;
    readonly queueJob?: {
      readonly queueId?: string;
      readonly status?: string;
      readonly attempt?: number;
      readonly maxAttempts?: number;
      readonly availableAt?: string;
      readonly metadata?: Record<string, unknown>;
      readonly errorName?: string;
    };
  };

  assert.equal(inspected.count, 1);
  assert.equal(inspected.jobs?.[0]?.queueId, "queue_dead");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.queueJob?.status, "cancelled");
  assert.equal(cancelled.queueJob?.errorMessage, "Duplicate backfill request.");
  assert.equal(requeued.status, "requeued");
  assert.equal(requeued.queueJob?.status, "queued");
  assert.equal(requeued.queueJob?.attempt, 0);
  assert.equal(requeued.queueJob?.maxAttempts, 3);
  assert.equal(requeued.queueJob?.availableAt, "2026-06-24T00:05:00.000Z");
  assert.equal(requeued.queueJob?.errorName, "ProviderError");
  assert.equal(requeued.queueJob?.metadata?.operator, "search-team");
  assert.equal(requeued.queueJob?.metadata?.requeueReason, "Provider recovered.");
});

test("production CLI controls generation promotions without building the app", async () => {
  const generationStore = new InMemoryIndexGenerationStore();
  await generationStore.saveManifest({
    manifest: {
      generationId: "gen_active",
      tenantId: "tenant_1",
      namespaceId: "test-namespace",
      profileId: "test-profile",
      status: "active",
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-large",
      embeddingDimensions: 3072,
      embeddingConfigHash: "active_embedding_cfg_hash",
      embeddingIndexConfigHash: "active_index_cfg_hash",
      chunkingPolicyId: "default-chunking",
      chunkingPolicyVersion: 1,
      createdAt: "2026-06-23T00:00:00.000Z",
      promotedAt: "2026-06-23T00:00:00.000Z"
    },
    savedAt: "2026-06-23T00:00:00.000Z"
  });

  const runGenerationCommand = async (argv: readonly string[]): Promise<unknown> => {
    const stdout: string[] = [];
    const exitCode = await runProductionRagCli({
      argv,
      env: CLI_TEST_ENV,
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
      appFactory: () => {
        throw new Error("generation promotion commands should not build the production app.");
      },
      indexGenerationStore: generationStore,
      now: () => "2026-06-24T00:00:00.000Z"
    });
    assert.equal(exitCode, 0);
    return JSON.parse(stdout[0] ?? "{}") as unknown;
  };

  const planArgs = [
    "plan-generation-promotion",
    "--promotion-id",
    "promotion_1",
    "--tenant-id",
    "tenant_1",
    "--namespace-id",
    "test-namespace",
    "--profile-id",
    "test-profile",
    "--generation-id",
    "gen_candidate",
    "--embedding-provider",
    "openai",
    "--embedding-model",
    "text-embedding-3-large",
    "--embedding-dimensions",
    "3072",
    "--embedding-config-hash",
    "candidate_embedding_cfg_hash",
    "--embedding-index-config-hash",
    "candidate_index_cfg_hash",
    "--chunking-policy-id",
    "default-chunking",
    "--chunking-policy-version",
    "2",
    "--required-eval-id",
    "retrieval_regression",
    "--required-eval-id",
    "citation_regression",
    "--requested-at",
    "2026-06-24T00:00:00.000Z"
  ] as const;

  const savedPlan = (await runGenerationCommand(planArgs)) as {
    readonly status?: string;
    readonly dryRun?: boolean;
    readonly candidateGeneration?: { readonly generationId?: string };
    readonly activeGeneration?: { readonly generationId?: string };
    readonly promotion?: {
      readonly promotionId?: string;
      readonly status?: string;
      readonly previousActiveGenerationId?: string;
      readonly requiredEvalIds?: readonly string[];
    };
  };
  const inspectedCandidates = (await runGenerationCommand([
    "inspect-index-generations",
    "--tenant-id",
    "tenant_1",
    "--namespace-id",
    "test-namespace",
    "--generation-status",
    "candidate"
  ])) as {
    readonly count?: number;
    readonly manifests?: readonly { readonly generationId?: string; readonly status?: string }[];
  };
  const inspectedPromotion = (await runGenerationCommand([
    "inspect-generation-promotion",
    "--promotion-id",
    "promotion_1"
  ])) as {
    readonly promotionId?: string;
    readonly status?: string;
    readonly requiredEvalIds?: readonly string[];
  };

  const partial = (await runGenerationCommand([
    "record-generation-eval",
    "--promotion-id",
    "promotion_1",
    "--eval-id",
    "retrieval_regression",
    "--eval-status",
    "passed",
    "--recorded-at",
    "2026-06-24T00:01:00.000Z"
  ])) as { readonly status?: string };
  const ready = (await runGenerationCommand([
    "record-generation-eval",
    "--promotion-id",
    "promotion_1",
    "--eval-id",
    "citation_regression",
    "--eval-status",
    "passed",
    "--report-uri",
    "s3://evals/citation.json",
    "--summary",
    "Citation regression passed.",
    "--recorded-at",
    "2026-06-24T00:02:00.000Z"
  ])) as {
    readonly status?: string;
    readonly evalResults?: readonly { readonly evalId?: string; readonly reportUri?: string }[];
  };
  const promoted = (await runGenerationCommand([
    "promote-generation",
    "--promotion-id",
    "promotion_1",
    "--promoted-at",
    "2026-06-24T00:05:00.000Z"
  ])) as {
    readonly status?: string;
    readonly promotedAt?: string;
  };

  assert.equal(savedPlan.status, "saved");
  assert.equal(savedPlan.dryRun, false);
  assert.equal(savedPlan.candidateGeneration?.generationId, "gen_candidate");
  assert.equal(savedPlan.activeGeneration?.generationId, "gen_active");
  assert.equal(savedPlan.promotion?.promotionId, "promotion_1");
  assert.equal(savedPlan.promotion?.status, "planned");
  assert.equal(savedPlan.promotion?.previousActiveGenerationId, "gen_active");
  assert.deepEqual(savedPlan.promotion?.requiredEvalIds, [
    "retrieval_regression",
    "citation_regression"
  ]);
  assert.equal(inspectedCandidates.count, 1);
  assert.equal(inspectedCandidates.manifests?.[0]?.generationId, "gen_candidate");
  assert.equal(inspectedCandidates.manifests?.[0]?.status, "candidate");
  assert.equal(inspectedPromotion.promotionId, "promotion_1");
  assert.equal(inspectedPromotion.status, "planned");
  assert.deepEqual(inspectedPromotion.requiredEvalIds, [
    "retrieval_regression",
    "citation_regression"
  ]);
  assert.equal(partial.status, "planned");
  assert.equal(ready.status, "ready");
  assert.equal(ready.evalResults?.[1]?.evalId, "retrieval_regression");
  assert.equal(
    ready.evalResults?.find((result) => result.evalId === "citation_regression")?.reportUri,
    "s3://evals/citation.json"
  );
  assert.equal(promoted.status, "promoted");
  assert.equal(promoted.promotedAt, "2026-06-24T00:05:00.000Z");
  assert.equal(
    (
      await generationStore.getActiveManifest({
        tenantId: "tenant_1",
        namespaceId: "test-namespace"
      })
    )?.generationId,
    "gen_candidate"
  );
  assert.equal((await generationStore.getManifest("gen_active"))?.status, "deprecated");
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
