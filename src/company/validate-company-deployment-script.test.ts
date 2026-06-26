import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("validate-company-deployment script exits zero for ready company modules", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/validate-company-deployment.mjs",
      "--module",
      "dist/company/examples/acme-support.company.js",
      "--export",
      "acmeSupportCompanyProfile"
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "ready");
  assert.equal(summary.companyId, "acme");
  assert.deepEqual(summary.profiles[0]?.adapterIds, ["acme-support-api"]);
});

test("validate-company-deployment script runs connector contracts from adapter pack exports", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/validate-company-deployment.mjs",
      "--module",
      "dist/company/examples/acme-support.company.js",
      "--export",
      "acmeSupportCompanyProfile",
      "--adapter-pack-export",
      "acmeSupportAdapterPack",
      "--run-connector-contracts",
      "--use-case",
      "support",
      "--contract-requested-at",
      "2026-06-24T00:00:00.000Z",
      "--principal-role",
      "support",
      "--principal-tag",
      "trusted"
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "ready");
  assert.equal(summary.connectorContracts.status, "passed");
  assert.deepEqual(summary.connectorContracts.adapterPackExports, ["acmeSupportAdapterPack"]);
  assert.equal(summary.connectorContracts.adapterPackValidation.warningCount, 1);
  assert.equal(
    summary.connectorContracts.adapterPackValidation.issues.some(
      (issue: { readonly code: string }) => issue.code === "permission_mapper_missing"
    ),
    true
  );
  assert.equal(summary.connectorContracts.checkedUseCaseCount, 1);
  assert.equal(summary.connectorContracts.checkedConnectorCount, 1);
  assert.equal(summary.connectorContracts.checkedCaseCount, 2);
  assert.deepEqual(
    summary.connectorContracts.reports[0]?.cases.map(
      (contractCase: { readonly mode: string; readonly status: string }) => [
        contractCase.mode,
        contractCase.status
      ]
    ),
    [
      ["delta", "passed"],
      ["full", "passed"]
    ]
  );
});

test("validate-company-deployment script auto-discovers company-prefixed adapter pack exports", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/validate-company-deployment.mjs",
      "--module",
      "dist/company/examples/acme-support.company.js",
      "--export",
      "acmeSupportCompanyProfile",
      "--run-connector-contracts",
      "--use-case",
      "support",
      "--contract-mode",
      "delta",
      "--contract-requested-at",
      "2026-06-24T00:00:00.000Z"
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.connectorContracts.status, "passed");
  assert.deepEqual(summary.connectorContracts.adapterPackExports, ["acmeSupportAdapterPack"]);
  assert.equal(summary.connectorContracts.checkedCaseCount, 1);
});

test("validate-company-deployment script runs full pack contracts", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/validate-company-deployment.mjs",
      "--module",
      "dist/company/examples/acme-support.company.js",
      "--export",
      "acmeSupportCompanyProfile",
      "--run-pack-contracts",
      "--use-case",
      "support",
      "--contract-mode",
      "delta",
      "--contract-requested-at",
      "2026-06-24T00:00:00.000Z",
      "--principal-role",
      "support",
      "--principal-tag",
      "trusted"
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "ready");
  assert.equal(summary.packContracts.status, "passed");
  assert.deepEqual(summary.packContracts.adapterPackExports, ["acmeSupportAdapterPack"]);
  assert.equal(summary.packContracts.checkedAdapterCount, 1);
  assert.equal(summary.packContracts.checkedConnectorCount, 1);
  assert.equal(summary.packContracts.checkedParserCount, 0);
  assert.equal(summary.packContracts.checkedCaseCount, 2);
  assert.equal(
    summary.packContracts.issues.some(
      (issue: { readonly upstreamCode?: string }) =>
        issue.upstreamCode === "permission_mapper_missing"
    ),
    true
  );
});

test("validate-company-deployment script exits nonzero with safe readiness issues", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/validate-company-deployment.mjs",
      "--module",
      "dist/company/examples/broken-support.company.js",
      "--export",
      "brokenSupportCompanyProfile"
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "failed");
  assert.equal(summary.companyId, "broken");
  assert.equal(summary.errorCount, 1);
  assert.equal(summary.issues[0]?.code, "duplicate_namespace");
  assert.equal(summary.issues[0]?.path, "useCases[1].namespaceId");
  assert.doesNotMatch(result.stdout, /secret|token|body|principal/iu);
});

test("validate-company-deployment script fails safely on connector contract issues", () => {
  const modulePath = writeUnsafeConnectorFixture();
  const result = spawnSync(
    process.execPath,
    [
      "scripts/validate-company-deployment.mjs",
      "--module",
      modulePath,
      "--export",
      "unsafeCompanyProfile",
      "--adapter-pack-export",
      "unsafeAdapterPack",
      "--run-connector-contracts",
      "--use-case",
      "support",
      "--contract-mode",
      "delta",
      "--contract-requested-at",
      "2026-06-24T00:00:00.000Z"
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "failed");
  assert.equal(summary.companyId, "unsafe");
  assert.equal(summary.connectorContracts.status, "failed");
  assert.equal(summary.connectorContracts.checkedCaseCount, 1);
  assert.deepEqual(
    new Set(
      summary.connectorContracts.issues.map((issue: { readonly code: string }) => issue.code)
    ),
    new Set([
      "source_id_matched",
      "connector_warning_shape",
      "connector_warning_leaks_sensitive_diagnostics",
      "records_match_source",
      "records_have_safe_acl"
    ])
  );
  assert.doesNotMatch(result.stdout, /leaked-secret|api_key=leaked-secret|Unsafe body text/iu);
});

function writeUnsafeConnectorFixture(): string {
  const fixtureDir = path.join(process.cwd(), ".rag", "company-script-tests");
  mkdirSync(fixtureDir, { recursive: true });
  const fixturePath = path.join(fixtureDir, "unsafe-company.mjs");
  const distUrl = pathToFileURL(path.join(process.cwd(), "dist", "index.js")).href;
  writeFileSync(
    fixturePath,
    `import { genericDocsProfile } from ${JSON.stringify(distUrl)};

export const unsafeCompanyProfile = {
  companyId: "unsafe",
  companyName: "Unsafe Co",
  defaultTenantId: "tenant_unsafe",
  useCases: [
    {
      id: "support",
      kind: "support",
      namespaceId: "unsafe-support",
      name: "Unsafe Support",
      purpose: "Exercise unsafe connector contract output.",
      baseProfile: genericDocsProfile,
      corpusSources: [
        {
          id: "support_docs",
          adapter: "unsafe-support-api",
          description: "Unsafe support docs API.",
          enabled: true,
          trustTierFloor: "trusted_internal"
        }
      ],
      evals: {
        goldenSetPath: "profiles/unsafe/support/golden.jsonl",
        adversarialSetPath: "profiles/unsafe/support/adversarial.jsonl",
        requiredChecks: genericDocsProfile.evals.requiredChecks
      }
    }
  ],
  connectors: [
    {
      id: "support_api",
      adapterId: "unsafe-support-api",
      sourceSystem: "unsafe-api",
      useCaseIds: ["support"],
      contractTestCommand: "npm test -- unsafe-support-api"
    }
  ]
};

class UnsafeAdapter {
  id = "unsafe-support-api";
  description = "Unsafe adapter fixture.";

  async load(request) {
    return {
      sourceId: request.source.id,
      records: [],
      warnings: []
    };
  }
}

class UnsafeConnector {
  id = "support_api";
  description = "Unsafe connector fixture.";

  async sync(request) {
    return {
      sourceId: "wrong_source",
      complete: false,
      warnings: [
        {
          sourceId: "wrong_source",
          code: "",
          message: "api_key=leaked-secret"
        }
      ],
      items: [
        {
          operation: "upsert",
          sourceItemId: "unsafe_item",
          version: "1",
          record: {
            id: "unsafe_doc",
            sourceId: "wrong_source",
            sourceKind: "api_response",
            title: "Unsafe Fixture",
            body: "Unsafe body text that must not appear in validator output.",
            trustTier: "trusted_internal",
            sensitivity: "internal",
            accessScope: {
              tenantId: request.requestedBy.tenantId,
              namespaceId: "wrong_namespace"
            },
            capturedAt: request.requestedAt,
            checksum: "checksum_unsafe"
          }
        }
      ]
    };
  }
}

export const unsafeAdapterPack = {
  id: "unsafe-pack",
  companyId: "unsafe",
  description: "Unsafe adapter pack fixture.",
  corpusAdapters: [new UnsafeAdapter()],
  sourceConnectors: [new UnsafeConnector()],
  connectorTests: [{ connectorId: "support_api", command: "npm test -- unsafe-support-api" }]
};
`,
    "utf8"
  );
  return fixturePath;
}
