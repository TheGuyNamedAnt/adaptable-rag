import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("company deployment smoke script gates packs, sync, self-test, and writes a safe artifact", () => {
  const reportDir = mkdtempSync(path.join(os.tmpdir(), "rag-company-smoke-pass-"));
  const result = spawnCompanySmoke([
    "--run-id",
    "company_smoke_test",
    "--requested-at",
    "2026-06-24T00:00:00.000Z",
    "--report-dir",
    reportDir
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");

  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "passed");
  assert.equal(summary.companyDeployment.companyId, "acme");
  assert.equal(summary.companyDeployment.useCaseId, "support");
  assert.equal(summary.companyDeployment.moduleExportName, "acmeSupportDeployment");
  assert.equal(summary.companyDeployment.companyExportPath, "acmeSupportDeployment.company");
  assert.deepEqual(summary.companyDeployment.adapterPackExports, [
    "acmeSupportDeployment.adapterPacks"
  ]);
  assert.deepEqual(summary.companyDeployment.environment.requiredEnv, ["RAG_DATABASE_URL"]);
  assert.equal(summary.gates.packContracts.status, "passed");
  assert.equal(summary.gates.sync.status, "passed");
  assert.equal(summary.gates.sync.syncStatus, "succeeded");
  assert.equal(summary.gates.selfTest.status, "passed");
  assert.deepEqual(summary.failures, []);

  const artifact = JSON.parse(readFileSync(path.join(reportDir, "smoke.json"), "utf8"));
  assert.deepEqual(artifact, summary);
  assertSafeSmokeOutput(result.stdout);
});

test("company deployment smoke script fails closed while still writing a safe artifact", () => {
  const reportDir = mkdtempSync(path.join(os.tmpdir(), "rag-company-smoke-fail-"));
  const result = spawnCompanySmoke([
    "--run-id",
    "company_smoke_bad_source",
    "--requested-at",
    "2026-06-24T00:00:00.000Z",
    "--source-id",
    "missing_source",
    "--report-dir",
    reportDir
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");

  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "failed");
  assert.equal(summary.gates.packContracts.status, "passed");
  assert.equal(summary.gates.sync.status, "failed");
  assert.equal(summary.gates.selfTest.status, "passed");
  assert.equal(summary.failures[0]?.gate, "sync");
  assert.match(summary.gates.sync.stderr[0], /Unknown company source ids/u);

  const artifact = JSON.parse(readFileSync(path.join(reportDir, "smoke.json"), "utf8"));
  assert.deepEqual(artifact, summary);
  assertSafeSmokeOutput(result.stdout);
});

function spawnCompanySmoke(extraArgs: readonly string[]) {
  return spawnSync(
    process.execPath,
    [
      "scripts/run-company-deployment-smoke.mjs",
      "--module",
      "dist/company/examples/acme-support.company.js",
      "--use-case",
      "support",
      ...extraArgs
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? ""
      }
    }
  );
}

function assertSafeSmokeOutput(output: string): void {
  assert.doesNotMatch(output, /Acme support agents may use approved internal policy snippets/iu);
  assert.doesNotMatch(output, /acme_support_contract_cursor/iu);
  assert.doesNotMatch(output, /company-smoke-placeholder/iu);
  assert.doesNotMatch(output, /bearer|api[_-]?key|token/iu);
}
