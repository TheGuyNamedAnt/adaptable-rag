import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("company Postgres smoke script plans the full production gate without leaking secrets", () => {
  const reportDir = mkdtempSync(path.join(os.tmpdir(), "rag-company-postgres-smoke-plan-"));
  const result = spawnPostgresSmoke([
    "--dry-run",
    "--database-url",
    "postgres://rag:super-secret-password@localhost:5432/rag",
    "--schema",
    "rag_core",
    "--vector-dimensions",
    "1536",
    "--local-provider",
    "--requested-at",
    "2026-06-26T00:00:00.000Z",
    "--run-id",
    "company_postgres_smoke_plan",
    "--report-dir",
    reportDir
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");

  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "planned");
  assert.equal(summary.postgres.storage.index, "postgres");
  assert.equal(summary.postgres.storage.vector, "postgres");
  assert.equal(summary.postgres.storage.sourceSyncLedger, "postgres");
  assert.equal(summary.postgres.vectorDimensions, 1536);
  assert.equal(summary.postgres.localProvider, true);
  assert.equal(summary.gates.migrations.status, "planned");
  assert.equal(summary.gates.readiness.status, "planned");
  assert.equal(summary.gates.fullSmoke.status, "planned");
  assert.equal(summary.gates.deltaSmoke.status, "planned");
  assert.deepEqual(summary.failures, []);

  const artifact = JSON.parse(
    readFileSync(path.join(reportDir, "postgres-company-smoke.json"), "utf8")
  );
  assert.deepEqual(artifact, summary);
  assertSafePostgresSmokeOutput(result.stdout);
});

test("company Postgres smoke script writes a safe artifact for startup failures", () => {
  const reportDir = mkdtempSync(path.join(os.tmpdir(), "rag-company-postgres-smoke-fail-"));
  const result = spawnPostgresSmoke([
    "--dry-run",
    "--database-url",
    "postgres://rag:super-secret-password@localhost:5432/rag",
    "--schema",
    "bad-schema",
    "--requested-at",
    "2026-06-26T00:00:00.000Z",
    "--run-id",
    "company_postgres_smoke_bad_schema",
    "--report-dir",
    reportDir
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");

  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "failed");
  assert.equal(summary.failures[0]?.gate, "startup");
  assert.match(summary.failures[0]?.message, /safe SQL identifier/u);

  const artifact = JSON.parse(
    readFileSync(path.join(reportDir, "postgres-company-smoke.json"), "utf8")
  );
  assert.deepEqual(artifact, summary);
  assertSafePostgresSmokeOutput(result.stdout);
});

function spawnPostgresSmoke(extraArgs: readonly string[]) {
  return spawnSync(process.execPath, ["scripts/run-company-postgres-smoke.mjs", ...extraArgs], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? ""
    }
  });
}

function assertSafePostgresSmokeOutput(output: string): void {
  assert.doesNotMatch(output, /super-secret-password/iu);
  assert.doesNotMatch(output, /postgres:\/\/rag:/iu);
  assert.doesNotMatch(output, /bearer|api[_-]?key|token/iu);
}
