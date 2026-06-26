import { genericDocsProfile, type CompanyProfile } from "adaptable-rag";

export { companyAdapterPack, createCompanyConnectorAdapterPack } from "./company-adapter-pack.js";

export const companyProfile: CompanyProfile = {
  companyId: "company_docs",
  companyName: "Company Docs",
  defaultTenantId: "tenant_company_docs",
  useCases: [
    {
      id: "docs",
      kind: "docs",
      namespaceId: "company-docs",
      name: "Company Docs",
      purpose: "Answer questions from approved company documentation.",
      baseProfile: genericDocsProfile,
      corpusSources: [
        {
          id: "company_docs_api",
          adapter: "company-docs-api",
          description: "Approved company documentation API.",
          enabled: true,
          trustTierFloor: "trusted_internal",
          tags: ["company-docs", "trusted_internal"]
        }
      ],
      evals: {
        goldenSetPath: "profiles/company-docs/docs/golden.jsonl",
        adversarialSetPath: "profiles/company-docs/docs/adversarial.jsonl",
        requiredChecks: genericDocsProfile.evals.requiredChecks
      },
      overrides: {
        retrieval: {
          preferSourceTags: ["company-docs", "trusted_internal"],
          avoidSourceTagsUnlessNeeded: ["archive"]
        },
        freshnessPolicy: {
          mode: "versioned",
          requireCapturedAt: true
        },
        citationPolicy: {
          allowedSourceKindsForCitations: ["api_response", "derived_summary"]
        }
      }
    }
  ],
  connectors: [
    {
      id: "company_docs_api",
      adapterId: "company-docs-api",
      sourceSystem: "company-docs-api",
      useCaseIds: ["docs"],
      contractTestCommand:
        "npm run company:validate -- --module dist/company/company-profile.js --export companyProfile --adapter-pack-export companyAdapterPack --run-pack-contracts --use-case docs --contract-mode delta --contract-mode full --min-delta-returned-records 1 --disallow-connector-warnings"
    }
  ],
  evalPacks: [
    {
      id: "company-docs-evals",
      useCaseId: "docs",
      goldenSetPath: "profiles/company-docs/docs/golden.jsonl",
      adversarialSetPath: "profiles/company-docs/docs/adversarial.jsonl",
      requiredChecks: genericDocsProfile.evals.requiredChecks
    }
  ],
  permissionMapping: {
    sourceSystem: "company-docs-api",
    tenantClaim: "tenant_id",
    namespaceClaim: "workspace_id",
    principalIdClaim: "user_id",
    teamClaim: "team_ids",
    roleClaim: "roles",
    tagClaim: "groups"
  }
};
