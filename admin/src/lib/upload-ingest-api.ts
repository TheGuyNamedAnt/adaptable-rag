import "server-only";

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolveRagRepoRoot } from "@/lib/repo-root";
import type { AdminUploadIngestionSummary } from "@/lib/upload-types";

const execFileAsync = promisify(execFile);

export interface UploadAvailability<T> {
  readonly status: "available" | "unavailable";
  readonly data?: T;
  readonly error?: string;
  readonly command?: readonly string[];
}

export interface UploadShellOverviewResult {
  readonly status: "available" | "partial" | "unavailable";
  readonly health?: {
    readonly index?: {
      readonly storageKind?: string;
    };
  };
}

export interface AdminUploadedLocalFilesIngestInput {
  readonly sourceConfigPath: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly sourceId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  readonly tags: readonly string[];
  readonly overwriteMode?: "reject" | "replace";
  readonly runId?: string;
  readonly requestedAt?: string;
}

export async function getUploadShellOverview(): Promise<UploadShellOverviewResult> {
  const [healthResult, readyResult] = await Promise.all([
    fetchRagJson<UploadShellOverviewResult["health"]>("/health"),
    fetchRagJson<{ readonly health?: UploadShellOverviewResult["health"] }>("/ready")
  ]);
  const availableCount = [healthResult, readyResult].filter(
    (result) => result.status === "available"
  ).length;

  return {
    status: availableCount === 2 ? "available" : availableCount > 0 ? "partial" : "unavailable",
    health: healthResult.data ?? readyResult.data?.health
  };
}

export async function ingestUploadedLocalFiles(
  input: AdminUploadedLocalFilesIngestInput
): Promise<UploadAvailability<AdminUploadIngestionSummary>> {
  const args = [
    "ingest",
    "--tenant-id",
    input.tenantId,
    "--namespace-id",
    input.namespaceId,
    "--user-id",
    input.userId,
    "--principal-namespace-id",
    input.namespaceId,
    "--source-id",
    input.sourceId,
    "--overwrite",
    input.overwriteMode ?? "replace"
  ];
  for (const role of input.roles) args.push("--role", role);
  for (const tag of input.tags) args.push("--tag", tag);
  if (input.runId) args.push("--run-id", input.runId);
  if (input.requestedAt) args.push("--requested-at", input.requestedAt);

  return runCliJson<AdminUploadIngestionSummary>(args, {
    env: uploadIngestEnv(input.sourceConfigPath)
  });
}

async function fetchRagJson<T>(pathname: string): Promise<UploadAvailability<T>> {
  const url = `${ragBaseUrl()}${pathname}`;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: ragHttpHeaders(),
      signal: AbortSignal.timeout(adminTimeoutMs())
    });
    const json = (await response.json()) as T;
    if (!response.ok) {
      return {
        status: "unavailable",
        error: `RAG HTTP endpoint ${pathname} returned ${response.status}.`
      };
    }
    return { status: "available", data: json };
  } catch (error) {
    return {
      status: "unavailable",
      error: safeErrorMessage(error, `RAG HTTP endpoint ${pathname} is unavailable.`)
    };
  }
}

async function runCliJson<T>(
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
  } = {}
): Promise<UploadAvailability<T>> {
  const root = repoRoot();
  const cliPath = ragCliPath(root);
  const command = [process.execPath, cliPath, ...args];

  if (!existsSync(/*turbopackIgnore: true*/ cliPath)) {
    return {
      status: "unavailable",
      error:
        "RAG service CLI has not been built yet. Run npm run build in the RAG repo before using upload ingestion.",
      command
    };
  }

  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: root,
      env: options.env ?? process.env,
      timeout: adminTimeoutMs(),
      maxBuffer: 1024 * 1024 * 4
    });
    return {
      status: "available",
      data: JSON.parse(result.stdout) as T,
      command
    };
  } catch (error) {
    return {
      status: "unavailable",
      error: safeErrorMessage(error, "RAG upload ingestion command failed."),
      command
    };
  }
}

function uploadIngestEnv(sourceConfigPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RAG_HTTP_AUTH_MODE: process.env.RAG_HTTP_AUTH_MODE ?? "disabled",
    RAG_MODEL_PROVIDER: process.env.RAG_MODEL_PROVIDER ?? "json-chat",
    RAG_MODEL_MODEL_NAME: process.env.RAG_MODEL_MODEL_NAME ?? "ingest-placeholder",
    RAG_MODEL_ENDPOINT:
      process.env.RAG_MODEL_ENDPOINT ?? "https://provider.example.invalid/v1/chat",
    RAG_MODEL_API_KEY: process.env.RAG_MODEL_API_KEY ?? "ingest-placeholder",
    RAG_RERANK_PROVIDER: process.env.RAG_RERANK_PROVIDER ?? "json-chat",
    RAG_RERANK_MODEL_NAME: process.env.RAG_RERANK_MODEL_NAME ?? "rerank-placeholder",
    RAG_RERANK_ENDPOINT:
      process.env.RAG_RERANK_ENDPOINT ?? "https://provider.example.invalid/v1/rerank",
    RAG_RERANK_API_KEY: process.env.RAG_RERANK_API_KEY ?? "rerank-placeholder",
    RAG_APP_EMBEDDING_MODE: process.env.RAG_APP_EMBEDDING_MODE ?? "disabled",
    RAG_APP_VISUAL_EMBEDDING_MODE: process.env.RAG_APP_VISUAL_EMBEDDING_MODE ?? "disabled",
    RAG_APP_GROUNDING_JUDGE_MODE: process.env.RAG_APP_GROUNDING_JUDGE_MODE ?? "disabled",
    RAG_LOCAL_FILES_SOURCES_PATH: sourceConfigPath
  };
}

function ragBaseUrl(): string {
  return (process.env.RAG_ADMIN_RAG_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
}

function ragHttpHeaders(): Record<string, string> {
  const token = ragHttpAuthToken();
  return {
    accept: "application/json",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
  };
}

function ragHttpAuthToken(): string | undefined {
  const tokenEnv = process.env.RAG_ADMIN_RAG_AUTH_TOKEN_ENV;
  const tokenFromPointer = tokenEnv ? process.env[tokenEnv]?.trim() : undefined;
  const token = tokenFromPointer ?? process.env.RAG_ADMIN_RAG_AUTH_TOKEN?.trim();
  return token ? token : undefined;
}

function repoRoot(): string {
  return resolveRagRepoRoot();
}

function ragCliPath(root: string): string {
  return path.resolve(
    /*turbopackIgnore: true*/
    process.env.RAG_ADMIN_CLI_PATH ??
      path.join(/*turbopackIgnore: true*/ root, "dist", "runtime", "production-cli.js")
  );
}

function adminTimeoutMs(): number {
  const configured = Number(process.env.RAG_ADMIN_TIMEOUT_MS ?? "12000");
  return Number.isFinite(configured) && configured > 0 ? configured : 12000;
}

function safeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function displayPath(value: string): string {
  return value.replace(repoRoot(), ".");
}
