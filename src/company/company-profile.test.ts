import assert from "node:assert/strict";
import test from "node:test";

import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import type { CompanyProfile } from "./company-profile.js";
import {
  assertCompanyDeploymentReady,
  buildCompanyRagProfiles,
  validateCompanyDeployment
} from "./company-profile.js";

const company: CompanyProfile = {
  companyId: "acme",
  companyName: "Acme Co",
  defaultTenantId: "tenant_acme",
  useCases: [
    {
      id: "support",
      kind: "support",
      namespaceId: "acme-support",
      name: "Acme Support",
      purpose: "Answer Acme support questions from approved support knowledge.",
      baseProfile: genericDocsProfile,
      outputMode: "support_triage",
      corpusSources: [
        {
          id: "acme_support_docs",
          adapter: "acme-support-docs",
          description: "Approved Acme support docs.",
          enabled: true,
          trustTierFloor: "trusted_internal",
          tags: ["support", "trusted"]
        }
      ],
      evals: {
        goldenSetPath: "profiles/acme/support/golden.jsonl",
        adversarialSetPath: "profiles/acme/support/adversarial.jsonl",
        requiredChecks: genericDocsProfile.evals.requiredChecks
      },
      overrides: {
        retrieval: {
          maxChunks: 10,
          preferSourceTags: ["support", "trusted"]
        },
        refusalPolicy: {
          refusalMessage: "I do not have enough Acme support evidence to answer that."
        }
      }
    }
  ],
  connectors: [
    {
      id: "support-docs",
      adapterId: "acme-support-docs",
      sourceSystem: "acme-admin",
      useCaseIds: ["support"],
      contractTestCommand: "npm test -- acme-support-docs"
    }
  ],
  evalPacks: []
};

test("buildCompanyRagProfiles turns company use cases into profile-scoped RAG profiles", () => {
  const profiles = buildCompanyRagProfiles(company);
  const profile = profiles[0];

  assert.ok(profile);
  assert.equal(profile.id, "acme.support");
  assert.equal(profile.namespaceId, "acme-support");
  assert.equal(profile.name, "Acme Support");
  assert.equal(profile.outputMode, "support_triage");
  assert.equal(profile.outputContract.mode, "support_triage");
  assert.equal(profile.outputContract.schemaName, "AcmeSupportSupportTriage");
  assert.equal(profile.corpusSources[0]?.id, "acme_support_docs");
  assert.equal(profile.corpusSources[0]?.adapter, "acme-support-docs");
  assert.equal(profile.retrieval.maxChunks, 10);
  assert.equal(
    profile.refusalPolicy.refusalMessage,
    "I do not have enough Acme support evidence to answer that."
  );
});

test("assertCompanyDeploymentReady returns validated generated profiles", () => {
  const deployment = assertCompanyDeploymentReady(company);

  assert.equal(deployment.ready, true);
  assert.equal(deployment.profileCount, 1);
  assert.equal(deployment.profiles[0]?.id, "acme.support");
});

test("validateCompanyDeployment reports onboarding gaps before production use", () => {
  const report = validateCompanyDeployment({
    ...company,
    useCases: [
      ...company.useCases,
      {
        ...company.useCases[0]!,
        id: "support",
        namespaceId: "acme-support",
        corpusSources: []
      }
    ],
    connectors: [
      {
        id: "orphan",
        adapterId: "missing-adapter",
        sourceSystem: "unknown",
        useCaseIds: ["missing-use-case"]
      }
    ]
  });

  assert.equal(report.ready, false);
  assert.equal(
    report.errors.some((issue) => issue.code === "duplicate_use_case"),
    true
  );
  assert.equal(
    report.errors.some((issue) => issue.code === "duplicate_namespace"),
    true
  );
  assert.equal(
    report.errors.some((issue) => issue.code === "missing_corpus_source"),
    true
  );
  assert.equal(
    report.errors.some((issue) => issue.code === "connector_without_use_case"),
    true
  );
  assert.equal(
    report.errors.some((issue) => issue.code === "connector_source_not_declared"),
    true
  );
  assert.equal(
    report.warnings.some((issue) => issue.code === "missing_connector_contract_test"),
    true
  );
});

test("validateCompanyDeployment scopes connector adapters to claimed use cases", () => {
  const report = validateCompanyDeployment({
    ...company,
    useCases: [
      company.useCases[0]!,
      {
        ...company.useCases[0]!,
        id: "finance",
        namespaceId: "acme-finance",
        name: "Acme Finance",
        corpusSources: [
          {
            id: "acme_finance_docs",
            adapter: "acme-finance-docs",
            description: "Approved Acme finance docs.",
            enabled: true,
            trustTierFloor: "trusted_internal"
          }
        ],
        evals: {
          goldenSetPath: "profiles/acme/finance/golden.jsonl",
          adversarialSetPath: "profiles/acme/finance/adversarial.jsonl",
          requiredChecks: genericDocsProfile.evals.requiredChecks
        }
      }
    ],
    connectors: [
      {
        id: "misrouted",
        adapterId: "acme-finance-docs",
        sourceSystem: "finance",
        useCaseIds: ["support"],
        contractTestCommand: "npm test -- acme-finance-docs"
      }
    ]
  });

  assert.equal(report.ready, false);
  assert.equal(
    report.errors.some((issue) => issue.code === "connector_source_not_declared"),
    true
  );
});

test("validateCompanyDeployment rejects duplicate and orphan eval packs", () => {
  const { evals: _evals, ...supportUseCaseWithoutEvals } = company.useCases[0]!;
  const report = validateCompanyDeployment({
    ...company,
    useCases: [supportUseCaseWithoutEvals],
    evalPacks: [
      {
        id: "support-evals-a",
        useCaseId: "support",
        goldenSetPath: "profiles/acme/support/golden-a.jsonl",
        adversarialSetPath: "profiles/acme/support/adversarial-a.jsonl",
        requiredChecks: genericDocsProfile.evals.requiredChecks
      },
      {
        id: "support-evals-b",
        useCaseId: "support",
        goldenSetPath: "profiles/acme/support/golden-b.jsonl",
        adversarialSetPath: "profiles/acme/support/adversarial-b.jsonl",
        requiredChecks: genericDocsProfile.evals.requiredChecks
      },
      {
        id: "orphan-evals",
        useCaseId: "missing",
        goldenSetPath: "profiles/acme/missing/golden.jsonl",
        adversarialSetPath: "profiles/acme/missing/adversarial.jsonl",
        requiredChecks: genericDocsProfile.evals.requiredChecks
      }
    ]
  });

  assert.equal(report.ready, false);
  assert.equal(
    report.errors.some((issue) => issue.code === "duplicate_eval_pack"),
    true
  );
  assert.equal(
    report.errors.some((issue) => issue.code === "eval_pack_without_use_case"),
    true
  );
});
