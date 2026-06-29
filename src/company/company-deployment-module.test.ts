import assert from "node:assert/strict";
import test from "node:test";

import {
  adapterPacksFromModule,
  loadCompanyDeploymentModule,
  resolveCompanyDeploymentExport
} from "./company-deployment-module.js";
import {
  acmeSupportAdapterPack,
  acmeSupportCompanyProfile,
  acmeSupportDeployment
} from "./examples/acme-support.company.js";

test("loadCompanyDeploymentModule defaults to the standard companyDeployment manifest", async () => {
  const loaded = await loadCompanyDeploymentModule({
    modulePath: "dist/company/examples/acme-support.company.js"
  });

  assert.equal(loaded.company.companyId, "acme");
  assert.equal(loaded.moduleExportName, "companyDeployment");
  assert.equal(loaded.companyExportName, "companyDeployment");
  assert.equal(loaded.companyExportPath, "companyDeployment.company");
  assert.equal(loaded.deploymentExportName, "companyDeployment");
  assert.deepEqual(loaded.adapterPackExportNames, ["companyDeployment.adapterPacks"]);
  assert.equal(loaded.adapterPacks[0]?.id, "acme-support-pack");
  assert.deepEqual(loaded.environment?.requiredEnv, ["RAG_DATABASE_URL"]);
  assert.deepEqual(loaded.evals?.goldenSetPaths, ["profiles/acme/support/golden.jsonl"]);
  assert.match(loaded.smoke?.postgresSmokeCommand ?? "", /company:smoke:postgres/u);
});

test("loadCompanyDeploymentModule still supports profile exports with discovered adapter packs", async () => {
  const loaded = await loadCompanyDeploymentModule({
    modulePath: "dist/company/examples/acme-support.company.js",
    companyExportName: "acmeSupportCompanyProfile"
  });

  assert.equal(loaded.company.companyId, "acme");
  assert.equal(loaded.companyExportPath, "acmeSupportCompanyProfile");
  assert.equal(loaded.deploymentExportName, undefined);
  assert.deepEqual(loaded.adapterPackExportNames, ["acmeSupportAdapterPack"]);
  assert.equal(loaded.adapterPacks[0]?.id, "acme-support-pack");
});

test("resolveCompanyDeploymentExport exposes manifest metadata without requiring pack discovery", () => {
  const resolved = resolveCompanyDeploymentExport(
    {
      acmeSupportCompanyProfile,
      acmeSupportDeployment
    },
    {
      companyExportName: "acmeSupportDeployment"
    }
  );

  assert.equal(resolved.company.companyId, "acme");
  assert.equal(resolved.deploymentExportName, "acmeSupportDeployment");
  assert.equal(resolved.companyExportPath, "acmeSupportDeployment.company");
  assert.deepEqual(resolved.adapterPackExportNames, ["acmeSupportDeployment.adapterPacks"]);
  assert.deepEqual(resolved.evals?.requiredPaths, [
    "profiles/acme/support/golden.jsonl",
    "profiles/acme/support/adversarial.jsonl"
  ]);
});

test("adapterPacksFromModule resolves nested deployment adapter pack paths", () => {
  const resolved = adapterPacksFromModule(
    {
      acmeSupportDeployment,
      acmeSupportAdapterPack
    },
    {
      companyExportName: "acmeSupportDeployment",
      adapterPackExportNames: ["acmeSupportDeployment.adapterPacks"]
    }
  );

  assert.deepEqual(resolved.exportNames, ["acmeSupportDeployment.adapterPacks"]);
  assert.equal(resolved.adapterPacks[0]?.id, "acme-support-pack");
});
