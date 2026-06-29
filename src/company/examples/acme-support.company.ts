import type { CorpusAdapter, CorpusLoadRequest, CorpusLoadResult } from "../../corpus/adapter.js";
import type { CorpusRecord } from "../../corpus/corpus-record.js";
import { genericDocsProfile } from "../../profiles/examples/generic-docs.profile.js";
import { ownerDefinedAclMapper } from "../../security/connector-acl-mapper.js";
import { hashText } from "../../shared/hash.js";
import type {
  SourceConnector,
  SourceConnectorSyncRequest,
  SourceConnectorSyncResult
} from "../../sync/source-connector.js";
import type { CompanyAdapterPack } from "../company-adapter-pack.js";
import type { CompanyDeploymentManifest } from "../company-deployment-module.js";
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
  permissionMappers: [
    {
      sourceSystem: "acme-api",
      mapper: ownerDefinedAclMapper({
        id: "acme-support-acl-mapper",
        description: "Maps Acme API ACL claims into portable RAG access scope.",
        map: ({ nativeAcl, context }) => {
          const acl = asRecord(nativeAcl);
          const role = firstString(acl?.["role"]);
          const groups = stringList(acl?.["groups"]);
          const userId = firstString(acl?.["user_id"]);
          return {
            tenantId: firstString(acl?.["tenant_id"]) ?? context.defaultTenantId,
            namespaceId: firstString(acl?.["workspace_id"]) ?? context.defaultNamespaceId,
            ...(userId === undefined ? {} : { userIds: [userId] }),
            roles: role === undefined ? ["support"] : [role],
            tags: uniqueSorted([...context.defaultTags, ...groups])
          };
        }
      })
    }
  ],
  connectorTests: [
    {
      connectorId: "support_api",
      command:
        "npm run company:validate -- --module dist/company/examples/acme-support.company.js --export acmeSupportDeployment --run-pack-contracts --use-case support"
    }
  ]
};

export const acmeSupportAdapterPacks = [acmeSupportAdapterPack] as const;

export const acmeSupportDeployment: CompanyDeploymentManifest = {
  company: acmeSupportCompanyProfile,
  adapterPacks: acmeSupportAdapterPacks,
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
      "profiles/acme/support/golden.jsonl",
      "profiles/acme/support/adversarial.jsonl"
    ],
    goldenSetPaths: ["profiles/acme/support/golden.jsonl"],
    adversarialSetPaths: ["profiles/acme/support/adversarial.jsonl"]
  },
  smoke: {
    validateCommand:
      "npm run company:validate -- --module dist/company/examples/acme-support.company.js --export acmeSupportDeployment --run-pack-contracts --use-case support --principal-role support --principal-tag trusted",
    smokeCommand:
      "npm run company:smoke -- --export acmeSupportDeployment --use-case support --tenant-id tenant_acme --namespace-id acme-support --source-id support_docs",
    postgresSmokeCommand:
      "npm run company:smoke:postgres -- --export acmeSupportDeployment --use-case support --tenant-id tenant_acme --namespace-id acme-support --source-id support_docs"
  }
};

export const companyDeployment = acmeSupportDeployment;

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

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value
      .find((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
      ?.trim();
  }
  return undefined;
}

function stringList(value: unknown): readonly string[] {
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    .map((entry) => entry.trim());
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))].sort();
}
