#!/usr/bin/env node
/* global AbortController, clearTimeout, fetch, setTimeout */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const options = parseArgs(process.argv.slice(2));
const children = new Map();
let shuttingDown = false;

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const stackEnv = stackEnvironment(options.mode);
const ragBaseUrl = (stackEnv.RAG_ADMIN_RAG_BASE_URL ?? "http://127.0.0.1:8787").replace(
  /\/+$/u,
  ""
);
const adminBaseUrl = `http://${stackEnv.RAG_ADMIN_HOST ?? "127.0.0.1"}:${stackEnv.RAG_ADMIN_PORT ?? "8788"}`;

process.once("SIGINT", () => {
  void shutdown(130);
});
process.once("SIGTERM", () => {
  void shutdown(143);
});

try {
  if (options.build) {
    await runCommand("build", npmCommand, ["run", "build"], { env: stackEnv });
    if (options.mode === "start") {
      await runCommand("admin-build", npmCommand, ["run", "admin:build"], { env: stackEnv });
    }
  }

  if (options.ragMode !== "external") {
    if (await urlOk(`${ragBaseUrl}/health`, 1_000, [200])) {
      log("stack", `Using existing RAG HTTP service at ${ragBaseUrl}.`);
    } else {
      startProcess("rag", process.execPath, ["dist/runtime/production-cli.js", "serve"], {
        env: stackEnv
      });
      await waitForUrl("rag", `${ragBaseUrl}/health`, options.ragWaitMs, [200]);
    }
  } else {
    await waitForUrl("rag", `${ragBaseUrl}/health`, options.ragWaitMs, [200]);
  }

  if (options.worker) {
    startProcess("worker", process.execPath, ["dist/runtime/production-cli.js", "worker"], {
      env: stackEnv
    });
  }

  if (await urlOk(adminBaseUrl, 1_000, [200, 301, 302, 307, 308, 401, 403])) {
    log("stack", `Using existing admin UI at ${adminBaseUrl}.`);
  } else {
    const adminArgs =
      options.mode === "start"
        ? [
            "--prefix",
            "admin",
            "run",
            "start",
            "--",
            "-H",
            hostForNext(stackEnv),
            "-p",
            portForNext(stackEnv)
          ]
        : [
            "--prefix",
            "admin",
            "run",
            "dev",
            "--",
            "-H",
            hostForNext(stackEnv),
            "-p",
            portForNext(stackEnv)
          ];
    startProcess("admin", npmCommand, adminArgs, { env: stackEnv });
    await waitForUrl(
      "admin",
      adminBaseUrl,
      options.adminWaitMs,
      [200, 301, 302, 307, 308, 401, 403]
    );
  }

  log("stack", `Admin UI ready at ${adminBaseUrl}.`);
  log("stack", `RAG HTTP ready at ${ragBaseUrl}.`);

  if (options.smoke) {
    await shutdown(0);
  }
} catch (error) {
  log("stack", error instanceof Error ? error.message : "Admin stack failed to start.");
  await shutdown(1);
}

function parseArgs(args) {
  const parsed = {
    mode: "dev",
    build: true,
    smoke: false,
    ragMode: process.env.RAG_ADMIN_STACK_RAG_MODE === "external" ? "external" : "managed",
    worker: process.env.RAG_ADMIN_STACK_WORKER === "enabled",
    ragWaitMs: positiveInteger(process.env.RAG_ADMIN_STACK_RAG_WAIT_MS, 30_000),
    adminWaitMs: positiveInteger(process.env.RAG_ADMIN_STACK_UI_WAIT_MS, 60_000)
  };

  for (const arg of args) {
    if (arg === "--mode=dev" || arg === "--dev") {
      parsed.mode = "dev";
    } else if (arg === "--mode=start" || arg === "--start") {
      parsed.mode = "start";
    } else if (arg === "--no-build") {
      parsed.build = false;
    } else if (arg === "--smoke") {
      parsed.smoke = true;
    } else if (arg === "--external-rag") {
      parsed.ragMode = "external";
    } else if (arg === "--worker") {
      parsed.worker = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown admin stack option: ${arg}`);
    }
  }

  return parsed;
}

function stackEnvironment(mode) {
  const fileEnv = loadEnvFiles([".env", ".env.local", ".env.admin"]);
  const base = {
    ...fileEnv,
    ...process.env
  };
  const env = {
    ...base,
    ...defaultEnv(base, mode)
  };

  return env;
}

function defaultEnv(env, mode) {
  return {
    RAG_APP_PROFILE_PRESET: env.RAG_APP_PROFILE_PRESET ?? "generic-docs",
    RAG_HTTP_HOST: env.RAG_HTTP_HOST ?? "127.0.0.1",
    RAG_HTTP_PORT: env.RAG_HTTP_PORT ?? "8787",
    RAG_HTTP_AUTH_MODE: env.RAG_HTTP_AUTH_MODE ?? "disabled",
    RAG_HTTP_LOG_MODE: env.RAG_HTTP_LOG_MODE ?? "disabled",
    RAG_INDEX_KIND: env.RAG_INDEX_KIND ?? "json_file",
    RAG_INDEX_PATH: env.RAG_INDEX_PATH ?? ".rag/admin-dev/index.json",
    RAG_INDEX_PRETTY: env.RAG_INDEX_PRETTY ?? "true",
    RAG_VECTOR_KIND: env.RAG_VECTOR_KIND ?? "none",
    RAG_VISUAL_VECTOR_KIND: env.RAG_VISUAL_VECTOR_KIND ?? "none",
    RAG_SOURCE_SYNC_LEDGER_KIND: env.RAG_SOURCE_SYNC_LEDGER_KIND ?? "none",
    RAG_MODEL_PROVIDER: env.RAG_MODEL_PROVIDER ?? "json-chat",
    RAG_MODEL_MODEL_NAME: env.RAG_MODEL_MODEL_NAME ?? "admin-dev-placeholder",
    RAG_MODEL_ENDPOINT: env.RAG_MODEL_ENDPOINT ?? "https://provider.example.invalid/v1/chat",
    RAG_MODEL_API_KEY: env.RAG_MODEL_API_KEY ?? "admin-dev-placeholder",
    RAG_APP_EMBEDDING_MODE: env.RAG_APP_EMBEDDING_MODE ?? "disabled",
    RAG_APP_VISUAL_EMBEDDING_MODE: env.RAG_APP_VISUAL_EMBEDDING_MODE ?? "disabled",
    RAG_APP_RERANK_MODE: env.RAG_APP_RERANK_MODE ?? "disabled",
    RAG_APP_GROUNDING_JUDGE_MODE: env.RAG_APP_GROUNDING_JUDGE_MODE ?? "disabled",
    RAG_GROUNDING_JUDGE_REQUIREMENT: env.RAG_GROUNDING_JUDGE_REQUIREMENT ?? "optional",
    RAG_ADMIN_RAG_BASE_URL:
      env.RAG_ADMIN_RAG_BASE_URL ??
      `http://${env.RAG_HTTP_HOST ?? "127.0.0.1"}:${env.RAG_HTTP_PORT ?? "8787"}`,
    RAG_ADMIN_RAG_AUTH_TOKEN_ENV: env.RAG_ADMIN_RAG_AUTH_TOKEN_ENV ?? "RAG_HTTP_AUTH_TOKEN",
    RAG_ADMIN_REPO_ROOT: env.RAG_ADMIN_REPO_ROOT ?? root,
    RAG_ADMIN_CLI_PATH:
      env.RAG_ADMIN_CLI_PATH ?? path.join(root, "dist", "runtime", "production-cli.js"),
    RAG_ADMIN_HOST: env.RAG_ADMIN_HOST ?? "127.0.0.1",
    RAG_ADMIN_PORT: env.RAG_ADMIN_PORT ?? "8788",
    ...(mode === "dev" ? { RAG_ADMIN_AUTH_MODE: env.RAG_ADMIN_AUTH_MODE ?? "disabled" } : {})
  };
}

function loadEnvFiles(names) {
  const env = {};
  for (const name of names) {
    const filePath = path.join(root, name);
    if (!existsSync(filePath)) {
      continue;
    }
    Object.assign(env, parseEnvFile(readFileSync(filePath, "utf8")));
  }
  return env;
}

function parseEnvFile(body) {
  const env = {};
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    const value = stripEnvQuotes(line.slice(equalsIndex + 1).trim());
    if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      env[key] = value;
    }
  }
  return env;
}

function stripEnvQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function startProcess(name, command, args, options) {
  const child = spawn(command, args, {
    cwd: root,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.set(name, child);
  pipeOutput(name, child.stdout);
  pipeOutput(name, child.stderr);
  child.once("exit", (code, signal) => {
    children.delete(name);
    if (!shuttingDown) {
      log("stack", `${name} exited with ${signal ?? code ?? "unknown"}.`);
      void shutdown(code === 0 ? 0 : code || 1);
    }
  });
  child.once("error", (error) => {
    children.delete(name);
    if (!shuttingDown) {
      log("stack", `${name} failed to start: ${error.message}`);
      void shutdown(1);
    }
  });
}

function runCommand(name, command, args, options) {
  return new Promise((resolve, reject) => {
    log("stack", `Running ${name}...`);
    const child = spawn(command, args, {
      cwd: root,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    pipeOutput(name, child.stdout);
    pipeOutput(name, child.stderr);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${name} exited with ${signal ?? code ?? "unknown"}.`));
    });
  });
}

async function waitForUrl(name, url, timeoutMs, okStatuses) {
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    if (await urlOk(url, 1_000, okStatuses)) {
      return;
    }
    lastError = `Waiting for ${name} at ${url}.`;
    await sleep(500);
  }
  throw new Error(
    `${lastError || `Timed out waiting for ${name}`} Timed out after ${timeoutMs}ms.`
  );
}

async function urlOk(url, timeoutMs, okStatuses) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal
    });
    return okStatuses.includes(response.status);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function shutdown(code) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  const exits = [];
  for (const [name, child] of children) {
    log("stack", `Stopping ${name}...`);
    exits.push(waitForExit(child, name));
    child.kill("SIGTERM");
  }
  await Promise.all(exits);
  process.exit(code);
}

function waitForExit(child, name) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      log("stack", `Force stopping ${name}.`);
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function pipeOutput(name, stream) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) {
        log(name, line);
      }
    }
  });
  stream.on("end", () => {
    if (buffer.trim()) {
      log(name, buffer);
    }
  });
}

function log(name, message) {
  console.log(`[${name}] ${message}`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function hostForNext(env) {
  return env.RAG_ADMIN_HOST ?? "127.0.0.1";
}

function portForNext(env) {
  return env.RAG_ADMIN_PORT ?? "8788";
}

function positiveInteger(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function printHelp() {
  console.log(`Usage: node scripts/start-admin-stack.mjs [options]

Starts the local RAG HTTP service and the admin UI together.

Options:
  --mode=dev       Run Next dev server. Default.
  --mode=start     Run production admin server after building admin.
  --no-build       Do not run npm run build before starting services.
  --external-rag   Require an already-running RAG HTTP service instead of starting one.
  --worker         Also start the ingestion queue worker. Requires queue storage env.
  --smoke          Start services, wait for readiness, then stop and exit 0.
`);
}
