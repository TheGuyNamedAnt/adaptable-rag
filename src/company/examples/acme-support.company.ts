import type { CorpusAdapter, CorpusLoadRequest, CorpusLoadResult } from "../../corpus/adapter.js";
import type { CorpusRecord } from "../../corpus/corpus-record.js";
import { genericDocsProfile } from "../../profiles/examples/generic-docs.profile.js";
import { hashText } from "../../shared/hash.js";
import type {
  SourceConnector,
  SourceConnectorSyncRequest,
  SourceConnectorSyncResult
} from "../../sync/source-connector.js";
import type { CompanyAdapterPack } from "../company-adapter-pack.js";
import type { CompanyProfile } from "../company-profile.js";

export const acmeSupportCompanyProfile: CompanyProfile = {
  companyId: "acme",
  companyName: "Acme Co",
  defaultTenantId: "tenant_acme",
  useCases: [
    {
      id: "support",
      kind: "support",
      namespaceId: "acme-support",
      name: "Acme Support",
      purpose: "Answer Acme support policy questions from approved internal sources.",
      baseProfile: genericDocsProfile,
      corpusSources: [
        {
          id: "support_docs",
          adapter: "acme-support-api",
          description: "Approved Acme support documentation API.",
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
          preferSourceTags: ["support", "trusted"],
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
      id: "support_api",
      adapterId: "acme-support-api",
      sourceSystem: "acme-api",
      useCaseIds: ["support"],
      contractTestCommand: "npm test -- acme-support-api"
    }
  ],
  evalPacks: [
    {
      id: "support-evals",
      useCaseId: "support",
      goldenSetPath: "profiles/acme/support/golden.jsonl",
      adversarialSetPath: "profiles/acme/support/adversarial.jsonl",
      requiredChecks: genericDocsProfile.evals.requiredChecks
    }
  ],
  permissionMapping: {
    sourceSystem: "acme-api",
    tenantClaim: "tenant_id",
    namespaceClaim: "workspace_id",
    principalIdClaim: "user_id",
    roleClaim: "role",
    tagClaim: "groups"
  }
};

class AcmeSupportCorpusAdapter implements CorpusAdapter {
  readonly id = "acme-support-api";
  readonly description = "Acme support API adapter used by the deployment fixture.";

  async load(request: CorpusLoadRequest): Promise<CorpusLoadResult> {
    return {
      sourceId: request.source.id,
      records: [acmeSupportRecord(request)],
      warnings: []
    };
  }
}

class AcmeSupportSourceConnector implements SourceConnector {
  readonly id = "support_api";
  readonly description = "Acme support source connector used by deployment contract checks.";

  async sync(request: SourceConnectorSyncRequest): Promise<SourceConnectorSyncResult> {
    if (request.mode === "delta") {
      return {
        sourceId: request.source.id,
        nextCursor: "acme_support_contract_cursor",
        complete: false,
        items: [
          {
            operation: "upsert",
            sourceItemId: "acme_support_policy_contract",
            version: "1",
            record: acmeSupportRecord(request)
          }
        ]
      };
    }

    return {
      sourceId: request.source.id,
      complete: true,
      items: []
    };
  }
}

export const acmeSupportAdapterPack: CompanyAdapterPack = {
  id: "acme-support-pack",
  companyId: "acme",
  description: "Acme support adapter pack.",
  corpusAdapters: [new AcmeSupportCorpusAdapter()],
  sourceConnectors: [new AcmeSupportSourceConnector()],
  connectorTests: [
    {
      connectorId: "support_api",
      command:
        "npm run company:validate -- --module dist/company/examples/acme-support.company.js --export acmeSupportCompanyProfile --adapter-pack-export acmeSupportAdapterPack --run-pack-contracts --use-case support"
    }
  ]
};

export const acmeSupportAdapterPacks = [acmeSupportAdapterPack] as const;

export const acmeSupportDeployment = {
  company: acmeSupportCompanyProfile,
  adapterPacks: acmeSupportAdapterPacks
} as const;

function acmeSupportRecord(request: CorpusLoadRequest | SourceConnectorSyncRequest): CorpusRecord {
  const body =
    "Acme support agents may use approved internal policy snippets for troubleshooting guidance.";
  return {
    id: "acme_support_policy_contract",
    sourceId: request.source.id,
    sourceKind: "api_response",
    title: "Acme Support Policy Contract Fixture",
    body,
    trustTier: "trusted_internal",
    sensitivity: "internal",
    accessScope: {
      tenantId: request.requestedBy.tenantId,
      namespaceId: request.profile.namespaceId,
      roles: ["support"],
      tags: ["trusted", "contract-test"]
    },
    originUri: "https://api.acme.example/support/policies/contract-fixture",
    capturedAt: request.requestedAt,
    checksum: hashText(body)
  };
}
