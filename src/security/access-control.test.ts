import assert from "node:assert/strict";
import test from "node:test";

import { makePrincipal } from "../test-support/fixtures.js";
import { accessDecisionAudit, assertAccessAllowed, evaluateAccess } from "./access-control.js";
import type { AccessScope } from "./access-scope.js";

const restrictedScope: AccessScope = {
  tenantId: "tenant_1",
  namespaceId: "test-namespace",
  userIds: ["user_1"],
  teamIds: ["support_team"],
  roles: ["support"],
  tags: ["support", "internal"]
};

test("allows a principal that satisfies tenant, namespace, user, team, role, and tag scope", () => {
  const decision = evaluateAccess(
    makePrincipal({ tags: ["support", "internal", "billing"] }),
    restrictedScope
  );

  assert.deepEqual(decision, {
    allowed: true,
    reason: "allowed"
  });
  assert.doesNotThrow(() =>
    assertAccessAllowed(makePrincipal({ tags: ["support", "internal"] }), restrictedScope)
  );
});

test("denies invalid principals", () => {
  assert.deepEqual(evaluateAccess(makePrincipal({ userId: "" }), restrictedScope), {
    allowed: false,
    reason: "invalid_principal"
  });
});

test("denies resources without a tenant or namespace boundary", () => {
  assert.deepEqual(
    evaluateAccess(makePrincipal(), { tenantId: "", namespaceId: "test-namespace" }),
    {
      allowed: false,
      reason: "missing_resource_scope"
    }
  );
});

test("denies tenant and namespace mismatches", () => {
  assert.equal(
    evaluateAccess(makePrincipal({ tenantId: "tenant_2" }), restrictedScope).reason,
    "tenant_mismatch"
  );
  assert.equal(
    evaluateAccess(makePrincipal({ namespaceIds: ["other-namespace"] }), restrictedScope).reason,
    "namespace_not_granted"
  );
});

test("denies user, team, and role mismatches", () => {
  assert.equal(
    evaluateAccess(makePrincipal({ userId: "user_2" }), restrictedScope).reason,
    "user_not_granted"
  );
  assert.equal(
    evaluateAccess(makePrincipal({ teamIds: ["other_team"] }), restrictedScope).reason,
    "team_not_granted"
  );
  assert.equal(
    evaluateAccess(makePrincipal({ roles: ["viewer"] }), restrictedScope).reason,
    "role_not_granted"
  );
});

test("requires all scoped tags, not any single matching tag", () => {
  assert.equal(
    evaluateAccess(makePrincipal({ tags: ["support"] }), restrictedScope).reason,
    "tag_not_granted"
  );
  assert.equal(
    evaluateAccess(makePrincipal({ tags: ["support", "internal"] }), restrictedScope).allowed,
    true
  );
});

test("throws with the denial reason when access is asserted", () => {
  assert.throws(
    () => assertAccessAllowed(makePrincipal({ roles: ["viewer"] }), restrictedScope),
    /Access denied: role_not_granted/
  );
});

test("builds a redacted access audit record for denials", () => {
  const principal = makePrincipal({
    userId: "raw_user_secret",
    teamIds: ["raw_team_secret"],
    roles: ["raw_role_secret"],
    tags: ["raw_tag_secret"]
  });
  const decision = evaluateAccess(principal, restrictedScope);
  const audit = accessDecisionAudit(principal, restrictedScope, decision);
  const serialized = JSON.stringify(audit);

  assert.equal(audit.allowed, false);
  assert.equal(audit.reason, "user_not_granted");
  assert.equal(audit.tenantId, "tenant_1");
  assert.equal(audit.namespaceId, "test-namespace");
  assert.equal(audit.scopedUserCount, 1);
  assert.equal(audit.scopedTeamCount, 1);
  assert.equal(audit.scopedRoleCount, 1);
  assert.equal(audit.scopedTagCount, 2);
  assert.equal(serialized.includes("raw_user_secret"), false);
  assert.equal(serialized.includes("raw_team_secret"), false);
  assert.equal(serialized.includes("raw_role_secret"), false);
  assert.equal(serialized.includes("raw_tag_secret"), false);
  assert.equal(typeof audit.principalHash, "string");
  assert.equal(audit.principalHash.length, 64);
  assert.equal(audit.scopeHash.length, 64);
});
