import { genericDocsProfile } from "../../profiles/examples/generic-docs.profile.js";
import type { CompanyProfile } from "../company-profile.js";

export const brokenSupportCompanyProfile: CompanyProfile = {
  companyId: "broken",
  companyName: "Broken Co",
  defaultTenantId: "tenant_broken",
  useCases: [
    {
      id: "support",
      kind: "support",
      namespaceId: "shared-support",
      name: "Broken Support",
      purpose: "This fixture intentionally has deployment validation errors.",
      baseProfile: genericDocsProfile,
      corpusSources: [
        {
          id: "support_docs",
          adapter: "broken-support-api",
          description: "Broken support docs API.",
          enabled: true,
          trustTierFloor: "trusted_internal",
          tags: ["support"]
        }
      ],
      evals: {
        goldenSetPath: "profiles/broken/support/golden.jsonl",
        adversarialSetPath: "profiles/broken/support/adversarial.jsonl",
        requiredChecks: genericDocsProfile.evals.requiredChecks
      }
    },
    {
      id: "admin",
      kind: "docs",
      namespaceId: "shared-support",
      name: "Broken Admin",
      purpose: "This duplicate namespace should fail company readiness.",
      baseProfile: genericDocsProfile,
      corpusSources: [
        {
          id: "admin_docs",
          adapter: "broken-admin-api",
          description: "Broken admin docs API.",
          enabled: true,
          trustTierFloor: "trusted_internal",
          tags: ["admin"]
        }
      ],
      evals: {
        goldenSetPath: "profiles/broken/admin/golden.jsonl",
        adversarialSetPath: "profiles/broken/admin/adversarial.jsonl",
        requiredChecks: genericDocsProfile.evals.requiredChecks
      }
    }
  ],
  connectors: [
    {
      id: "support_api",
      adapterId: "broken-support-api",
      sourceSystem: "broken-api",
      useCaseIds: ["support"],
      contractTestCommand: "npm test -- broken-support-api"
    }
  ]
};
