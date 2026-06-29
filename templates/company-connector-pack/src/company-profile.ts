import {
  genericDocsProfile,
  type CompanyDeploymentManifest,
  type CompanyProfile
} from "adaptable-rag";

import { companyAdapterPack } from "./company-adapter-pack.js";

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
        "npm run company:validate -- --module dist/company/company-profile.js --export companyDeployment --run-pack-contracts --use-case docs --contract-mode delta --contract-mode full --min-delta-returned-records 1 --disallow-connector-warnings"
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

export const companyDeployment: CompanyDeploymentManifest = {
  company: companyProfile,
  adapterPacks: [companyAdapterPack],
  environment: {
    requiredEnv: ["RAG_DATABASE_URL"],
    optionalEnv: [
      "RAG_COMPANY_DEPLOYMENT_EXPORT",
      "RAG_COMPANY_USE_CASE_ID",
      "RAG_COMPANY_NAMESPACE_ID",
      "RAG_COMPANY_PACK_CONTRACT_MODE"
    ]
  },
  evals: {
    requiredPaths: [
      "profiles/company-docs/docs/golden.jsonl",
      "profiles/company-docs/docs/adversarial.jsonl"
    ],
    goldenSetPaths: ["profiles/company-docs/docs/golden.jsonl"],
    adversarialSetPaths: ["profiles/company-docs/docs/adversarial.jsonl"]
  },
  smoke: {
    validateCommand:
      "npm run company:validate -- --module dist/company/company-profile.js --export companyDeployment --run-pack-contracts --use-case docs --contract-mode delta --contract-mode full --min-delta-returned-records 1 --disallow-connector-warnings",
    smokeCommand:
      "npm run company:smoke -- --module dist/company/company-profile.js --export companyDeployment --use-case docs --tenant-id tenant_company_docs --namespace-id company-docs --source-id company_docs_api",
    postgresSmokeCommand:
      "npm run company:smoke:postgres -- --module dist/company/company-profile.js --export companyDeployment --use-case docs --tenant-id tenant_company_docs --namespace-id company-docs --source-id company_docs_api"
  }
};
