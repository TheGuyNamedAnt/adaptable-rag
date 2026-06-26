import type { CorpusSourceConfig, OutputMode, RagProfile } from "../profiles/profile.js";
import {
  assertValidProfile,
  validateProfile,
  type ProfileValidationIssue,
  type ValidatedRagProfile
} from "../profiles/profile-validation.js";

export type CompanyUseCaseKind = "docs" | "support" | "diligence" | "code_investigation" | "custom";

export interface CompanyProfile {
  readonly companyId: string;
  readonly companyName: string;
  readonly defaultTenantId: string;
  readonly useCases: readonly CompanyUseCaseProfile[];
  readonly connectors?: readonly CompanyConnectorRegistration[];
  readonly evalPacks?: readonly CompanyEvalPack[];
  readonly permissionMapping?: CompanyPermissionMapping;
}

export interface CompanyUseCaseProfile {
  readonly id: string;
  readonly kind: CompanyUseCaseKind;
  readonly namespaceId: string;
  readonly name: string;
  readonly purpose: string;
  readonly baseProfile: RagProfile;
  readonly outputMode?: OutputMode;
  readonly parserIds?: readonly string[];
  readonly corpusSources: readonly CorpusSourceConfig[];
  readonly evals?: RagProfile["evals"];
  readonly escalationRules?: RagProfile["escalationRules"];
  readonly overrides?: CompanyRagProfileOverrides;
}

export interface CompanyRagProfileOverrides {
  readonly retrieval?: Partial<RagProfile["retrieval"]>;
  readonly contextBudget?: Partial<RagProfile["contextBudget"]>;
  readonly freshnessPolicy?: Partial<RagProfile["freshnessPolicy"]>;
  readonly trustPolicy?: Partial<RagProfile["trustPolicy"]>;
  readonly citationPolicy?: Partial<RagProfile["citationPolicy"]>;
  readonly refusalPolicy?: Partial<RagProfile["refusalPolicy"]>;
  readonly redactionPolicy?: Partial<RagProfile["redactionPolicy"]>;
  readonly outputContract?: Partial<RagProfile["outputContract"]>;
  readonly actionPolicy?: Partial<RagProfile["actionPolicy"]>;
  readonly costLatencyBudget?: Partial<RagProfile["costLatencyBudget"]>;
  readonly securityPolicy?: Partial<RagProfile["securityPolicy"]>;
  readonly observabilityPolicy?: Partial<RagProfile["observabilityPolicy"]>;
  readonly memoryPolicy?: Partial<RagProfile["memoryPolicy"]>;
}

export interface CompanyConnectorRegistration {
  readonly id: string;
  readonly adapterId: string;
  readonly sourceSystem: string;
  readonly useCaseIds: readonly string[];
  readonly contractTestCommand?: string;
}

export interface CompanyEvalPack {
  readonly id: string;
  readonly useCaseId: string;
  readonly goldenSetPath: string;
  readonly adversarialSetPath: string;
  readonly requiredChecks: readonly string[];
}

export interface CompanyPermissionMapping {
  readonly sourceSystem: string;
  readonly tenantClaim: string;
  readonly namespaceClaim: string;
  readonly principalIdClaim: string;
  readonly teamClaim?: string;
  readonly roleClaim?: string;
  readonly tagClaim?: string;
}

export type CompanyDeploymentIssueSeverity = "error" | "warning";

export type CompanyDeploymentIssueCode =
  | "missing_company_identity"
  | "missing_use_case"
  | "duplicate_use_case"
  | "duplicate_namespace"
  | "missing_corpus_source"
  | "duplicate_corpus_source"
  | "connector_without_use_case"
  | "connector_source_not_declared"
  | "missing_connector_contract_test"
  | "missing_eval_pack"
  | "duplicate_eval_pack"
  | "eval_pack_without_use_case"
  | "profile_validation_failed"
  | "profile_validation_warning";

export interface CompanyDeploymentIssue {
  readonly severity: CompanyDeploymentIssueSeverity;
  readonly code: CompanyDeploymentIssueCode;
  readonly path: string;
  readonly message: string;
  readonly profileIssue?: ProfileValidationIssue;
}

export interface CompanyDeploymentReadinessReport {
  readonly ready: boolean;
  readonly companyId: string;
  readonly companyName: string;
  readonly profileCount: number;
  readonly connectorCount: number;
  readonly evalPackCount: number;
  readonly issues: readonly CompanyDeploymentIssue[];
  readonly errors: readonly CompanyDeploymentIssue[];
  readonly warnings: readonly CompanyDeploymentIssue[];
  readonly profiles: readonly RagProfile[];
}

export interface ValidatedCompanyDeployment extends CompanyDeploymentReadinessReport {
  readonly ready: true;
  readonly profiles: readonly ValidatedRagProfile[];
}

export function buildCompanyRagProfiles(company: CompanyProfile): readonly RagProfile[] {
  return company.useCases.map((useCase) => buildCompanyUseCaseProfile(company, useCase));
}

export function validateCompanyDeployment(
  company: CompanyProfile
): CompanyDeploymentReadinessReport {
  const issues: CompanyDeploymentIssue[] = [];
  validateCompanyShape(company, issues);

  const profiles = buildCompanyRagProfiles(company);
  profiles.forEach((profile, profileIndex) => {
    const profileResult = validateProfile(profile);
    for (const issue of profileResult.errors) {
      issues.push({
        severity: "error",
        code: "profile_validation_failed",
        path: `profiles[${profileIndex}].${issue.path}`,
        message: issue.message,
        profileIssue: issue
      });
    }
    for (const issue of profileResult.warnings) {
      issues.push({
        severity: "warning",
        code: "profile_validation_warning",
        path: `profiles[${profileIndex}].${issue.path}`,
        message: issue.message,
        profileIssue: issue
      });
    }
  });

  validateConnectorCoverage(company, profiles, issues);
  validateEvalCoverage(company, issues);

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");

  return {
    ready: errors.length === 0,
    companyId: company.companyId,
    companyName: company.companyName,
    profileCount: profiles.length,
    connectorCount: company.connectors?.length ?? 0,
    evalPackCount: company.evalPacks?.length ?? 0,
    issues,
    errors,
    warnings,
    profiles
  };
}

export function assertCompanyDeploymentReady(company: CompanyProfile): ValidatedCompanyDeployment {
  const report = validateCompanyDeployment(company);
  if (!report.ready) {
    const details = report.errors.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
    throw new Error(`Company RAG deployment "${company.companyId}" is not ready:\n${details}`);
  }

  return {
    ...report,
    ready: true,
    profiles: report.profiles.map((profile) => assertValidProfile(profile))
  };
}

function buildCompanyUseCaseProfile(
  company: CompanyProfile,
  useCase: CompanyUseCaseProfile
): RagProfile {
  const outputMode = useCase.outputMode ?? useCase.baseProfile.outputMode;
  const evals =
    useCase.evals ??
    company.evalPacks?.find((pack) => pack.useCaseId === useCase.id) ??
    useCase.baseProfile.evals;

  return {
    ...useCase.baseProfile,
    id: `${company.companyId}.${useCase.id}`,
    namespaceId: useCase.namespaceId,
    name: useCase.name,
    purpose: useCase.purpose,
    outputMode,
    corpusSources: useCase.corpusSources,
    retrieval: {
      ...useCase.baseProfile.retrieval,
      ...(useCase.overrides?.retrieval ?? {})
    },
    contextBudget: {
      ...useCase.baseProfile.contextBudget,
      ...(useCase.overrides?.contextBudget ?? {})
    },
    freshnessPolicy: {
      ...useCase.baseProfile.freshnessPolicy,
      ...(useCase.overrides?.freshnessPolicy ?? {})
    },
    trustPolicy: {
      ...useCase.baseProfile.trustPolicy,
      ...(useCase.overrides?.trustPolicy ?? {})
    },
    citationPolicy: {
      ...useCase.baseProfile.citationPolicy,
      ...(useCase.overrides?.citationPolicy ?? {})
    },
    refusalPolicy: {
      ...useCase.baseProfile.refusalPolicy,
      ...(useCase.overrides?.refusalPolicy ?? {})
    },
    redactionPolicy: {
      ...useCase.baseProfile.redactionPolicy,
      ...(useCase.overrides?.redactionPolicy ?? {})
    },
    outputContract: {
      ...useCase.baseProfile.outputContract,
      mode: outputMode,
      schemaName: `${pascalCase(company.companyId)}${pascalCase(useCase.id)}${pascalCase(outputMode)}`,
      ...(useCase.overrides?.outputContract ?? {})
    },
    actionPolicy: {
      ...useCase.baseProfile.actionPolicy,
      ...(useCase.overrides?.actionPolicy ?? {})
    },
    costLatencyBudget: {
      ...useCase.baseProfile.costLatencyBudget,
      ...(useCase.overrides?.costLatencyBudget ?? {})
    },
    securityPolicy: {
      ...useCase.baseProfile.securityPolicy,
      ...(useCase.overrides?.securityPolicy ?? {})
    },
    observabilityPolicy: {
      ...useCase.baseProfile.observabilityPolicy,
      ...(useCase.overrides?.observabilityPolicy ?? {})
    },
    memoryPolicy: {
      ...useCase.baseProfile.memoryPolicy,
      ...(useCase.overrides?.memoryPolicy ?? {})
    },
    escalationRules: useCase.escalationRules ?? useCase.baseProfile.escalationRules,
    evals: {
      goldenSetPath: evals.goldenSetPath,
      adversarialSetPath: evals.adversarialSetPath,
      requiredChecks: evals.requiredChecks
    }
  };
}

function validateCompanyShape(company: CompanyProfile, issues: CompanyDeploymentIssue[]): void {
  if (!company.companyId.trim() || !company.companyName.trim() || !company.defaultTenantId.trim()) {
    issues.push({
      severity: "error",
      code: "missing_company_identity",
      path: "company",
      message: "companyId, companyName, and defaultTenantId are required."
    });
  }

  if (company.useCases.length === 0) {
    issues.push({
      severity: "error",
      code: "missing_use_case",
      path: "useCases",
      message: "At least one company use case is required."
    });
  }

  const seenUseCases = new Set<string>();
  const seenNamespaces = new Set<string>();
  company.useCases.forEach((useCase, index) => {
    const path = `useCases[${index}]`;
    if (seenUseCases.has(useCase.id)) {
      issues.push({
        severity: "error",
        code: "duplicate_use_case",
        path: `${path}.id`,
        message: `Duplicate use case id "${useCase.id}".`
      });
    }
    seenUseCases.add(useCase.id);

    if (seenNamespaces.has(useCase.namespaceId)) {
      issues.push({
        severity: "error",
        code: "duplicate_namespace",
        path: `${path}.namespaceId`,
        message: `Duplicate namespaceId "${useCase.namespaceId}".`
      });
    }
    seenNamespaces.add(useCase.namespaceId);

    if (useCase.corpusSources.length === 0) {
      issues.push({
        severity: "error",
        code: "missing_corpus_source",
        path: `${path}.corpusSources`,
        message: "Each company use case must declare at least one corpus source."
      });
    }

    const seenSources = new Set<string>();
    useCase.corpusSources.forEach((source, sourceIndex) => {
      if (seenSources.has(source.id)) {
        issues.push({
          severity: "error",
          code: "duplicate_corpus_source",
          path: `${path}.corpusSources[${sourceIndex}].id`,
          message: `Duplicate corpus source id "${source.id}" in use case "${useCase.id}".`
        });
      }
      seenSources.add(source.id);
    });
  });
}

function validateConnectorCoverage(
  company: CompanyProfile,
  profiles: readonly RagProfile[],
  issues: CompanyDeploymentIssue[]
): void {
  const useCaseIds = new Set(company.useCases.map((useCase) => useCase.id));
  const profileByUseCaseId = new Map(
    company.useCases.map((useCase) => [
      useCase.id,
      profiles.find((profile) => profile.id === `${company.companyId}.${useCase.id}`)
    ])
  );

  company.connectors?.forEach((connector, index) => {
    const path = `connectors[${index}]`;
    const unknownUseCases = connector.useCaseIds.filter((useCaseId) => !useCaseIds.has(useCaseId));
    if (unknownUseCases.length > 0) {
      issues.push({
        severity: "error",
        code: "connector_without_use_case",
        path: `${path}.useCaseIds`,
        message: `Connector "${connector.id}" references unknown use cases: ${unknownUseCases.join(", ")}.`
      });
    }

    const knownUseCaseIds = connector.useCaseIds.filter((useCaseId) => useCaseIds.has(useCaseId));
    const hasDeclaredSourceInClaimedUseCases = knownUseCaseIds.some((useCaseId) =>
      profileByUseCaseId
        .get(useCaseId)
        ?.corpusSources.some((source) => source.adapter === connector.adapterId)
    );
    if (!hasDeclaredSourceInClaimedUseCases) {
      issues.push({
        severity: "error",
        code: "connector_source_not_declared",
        path: `${path}.adapterId`,
        message: `Connector adapter "${connector.adapterId}" is not declared by its configured use cases.`
      });
    }

    if (!connector.contractTestCommand?.trim()) {
      issues.push({
        severity: "warning",
        code: "missing_connector_contract_test",
        path: `${path}.contractTestCommand`,
        message: `Connector "${connector.id}" should declare the command that runs its contract tests.`
      });
    }
  });
}

function validateEvalCoverage(company: CompanyProfile, issues: CompanyDeploymentIssue[]): void {
  const useCaseIds = new Set(company.useCases.map((useCase) => useCase.id));
  const evalUseCaseIds = new Set<string>();

  company.evalPacks?.forEach((pack, index) => {
    if (!useCaseIds.has(pack.useCaseId)) {
      issues.push({
        severity: "error",
        code: "eval_pack_without_use_case",
        path: `evalPacks[${index}].useCaseId`,
        message: `Eval pack "${pack.id}" references unknown use case "${pack.useCaseId}".`
      });
    }

    if (evalUseCaseIds.has(pack.useCaseId)) {
      issues.push({
        severity: "error",
        code: "duplicate_eval_pack",
        path: `evalPacks[${index}].useCaseId`,
        message: `Duplicate eval pack for use case "${pack.useCaseId}".`
      });
    }
    evalUseCaseIds.add(pack.useCaseId);
  });

  company.useCases.forEach((useCase, index) => {
    if (!useCase.evals && !evalUseCaseIds.has(useCase.id)) {
      issues.push({
        severity: "warning",
        code: "missing_eval_pack",
        path: `useCases[${index}].evals`,
        message: `Use case "${useCase.id}" uses base profile evals; add a company eval pack before production rollout.`
      });
    }
  });
}

function pascalCase(value: string): string {
  return value
    .split(/[^a-z0-9]+/iu)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}
