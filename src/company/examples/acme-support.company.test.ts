import assert from "node:assert/strict";
import test from "node:test";

import { assertCompanyDeploymentReady } from "../company-profile.js";
import { acmeSupportCompanyProfile } from "./acme-support.company.js";

test("acme support company example is deployment-ready", () => {
  const deployment = assertCompanyDeploymentReady(acmeSupportCompanyProfile);

  assert.equal(deployment.ready, true);
  assert.equal(deployment.companyId, "acme");
  assert.equal(deployment.profileCount, 1);
  assert.equal(deployment.profiles[0]?.id, "acme.support");
  assert.equal(deployment.profiles[0]?.namespaceId, "acme-support");
  assert.deepEqual(deployment.profiles[0]?.retrieval.preferSourceTags, ["support", "trusted"]);
  assert.deepEqual(
    deployment.profiles[0]?.corpusSources.map((source) => source.adapter),
    ["acme-support-api"]
  );
});
