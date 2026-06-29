import path from "node:path";
import { pathToFileURL } from "node:url";

import type { CompanyAdapterPack } from "./company-adapter-pack.js";
import type { CompanyProfile } from "./company-profile.js";

export interface CompanyDeploymentModuleLoadOptions {
  readonly modulePath: string;
  readonly companyExportName?: string;
  readonly adapterPackExportNames?: readonly string[];
  readonly cwd?: string;
}

export interface CompanyDeploymentEnvironmentManifest {
  readonly requiredEnv?: readonly string[];
  readonly optionalEnv?: readonly string[];
}

export interface CompanyDeploymentEvalManifest {
  readonly requiredPaths?: readonly string[];
  readonly goldenSetPaths?: readonly string[];
  readonly adversarialSetPaths?: readonly string[];
}

export interface CompanyDeploymentSmokeManifest {
  readonly validateCommand?: string;
  readonly packContractsCommand?: string;
  readonly smokeCommand?: string;
  readonly postgresSmokeCommand?: string;
}

export interface CompanyDeploymentManifest {
  readonly company: CompanyProfile;
  readonly adapterPacks?: readonly CompanyAdapterPack[];
  readonly environment?: CompanyDeploymentEnvironmentManifest;
  readonly evals?: CompanyDeploymentEvalManifest;
  readonly smoke?: CompanyDeploymentSmokeManifest;
}

export interface CompanyDeploymentExportResolutionOptions {
  readonly modulePath?: string;
  readonly companyExportName?: string;
  readonly adapterPackExportNames?: readonly string[];
  readonly discoverAdapterPacks?: boolean;
  readonly requireAdapterPacks?: boolean;
}

export interface CompanyDeploymentExportResolution {
  readonly company: CompanyProfile;
  readonly adapterPacks: readonly CompanyAdapterPack[];
  readonly adapterPackExportNames: readonly string[];
  readonly moduleExportName: string;
  readonly companyExportName: string;
  readonly companyExportPath: string;
  readonly deploymentExportName?: string;
  readonly deploymentManifest?: CompanyDeploymentManifest;
  readonly environment?: CompanyDeploymentEnvironmentManifest;
  readonly evals?: CompanyDeploymentEvalManifest;
  readonly smoke?: CompanyDeploymentSmokeManifest;
}

export interface LoadedCompanyDeploymentModule {
  readonly company: CompanyProfile;
  readonly adapterPacks: readonly CompanyAdapterPack[];
  readonly adapterPackExportNames: readonly string[];
  readonly moduleUrl: string;
  readonly moduleExportName: string;
  readonly companyExportName: string;
  readonly companyExportPath: string;
  readonly deploymentExportName?: string;
  readonly deploymentManifest?: CompanyDeploymentManifest;
  readonly environment?: CompanyDeploymentEnvironmentManifest;
  readonly evals?: CompanyDeploymentEvalManifest;
  readonly smoke?: CompanyDeploymentSmokeManifest;
}

export async function loadCompanyDeploymentModule(
  options: CompanyDeploymentModuleLoadOptions
): Promise<LoadedCompanyDeploymentModule> {
  const moduleUrl = resolveCompanyDeploymentModuleUrl(
    options.modulePath,
    options.cwd ?? process.cwd()
  );
  const moduleExports = (await import(moduleUrl.href)) as Readonly<Record<string, unknown>>;
  const resolved = resolveCompanyDeploymentExport(moduleExports, {
    modulePath: options.modulePath,
    ...(options.companyExportName === undefined
      ? {}
      : { companyExportName: options.companyExportName }),
    ...(options.adapterPackExportNames === undefined
      ? {}
      : { adapterPackExportNames: options.adapterPackExportNames }),
    discoverAdapterPacks: true,
    requireAdapterPacks: true
  });

  return {
    company: resolved.company,
    adapterPacks: resolved.adapterPacks,
    adapterPackExportNames: resolved.adapterPackExportNames,
    moduleUrl: moduleUrl.href,
    moduleExportName: resolved.moduleExportName,
    companyExportName: resolved.companyExportName,
    companyExportPath: resolved.companyExportPath,
    ...(resolved.deploymentExportName === undefined
      ? {}
      : { deploymentExportName: resolved.deploymentExportName }),
    ...(resolved.deploymentManifest === undefined
      ? {}
      : { deploymentManifest: resolved.deploymentManifest }),
    ...(resolved.environment === undefined ? {} : { environment: resolved.environment }),
    ...(resolved.evals === undefined ? {} : { evals: resolved.evals }),
    ...(resolved.smoke === undefined ? {} : { smoke: resolved.smoke })
  };
}

export function resolveCompanyDeploymentExport(
  moduleExports: Readonly<Record<string, unknown>>,
  options: CompanyDeploymentExportResolutionOptions = {}
): CompanyDeploymentExportResolution {
  const selected = selectCompanyDeploymentExport(moduleExports, options);
  const deploymentManifest = isCompanyDeploymentManifest(selected.value)
    ? selected.value
    : undefined;
  const company = deploymentManifest?.company ?? selected.value;

  if (!isObject(company)) {
    throw new Error(
      `Export "${selected.exportName}" from ${options.modulePath ?? "company deployment module"} is not a company profile or deployment manifest object.`
    );
  }

  const adapterPacks = resolveCompanyDeploymentAdapterPacks(moduleExports, {
    selectedExportName: selected.exportName,
    ...(deploymentManifest === undefined ? {} : { deploymentManifest }),
    ...(options.adapterPackExportNames === undefined
      ? {}
      : { adapterPackExportNames: options.adapterPackExportNames }),
    discoverAdapterPacks: options.discoverAdapterPacks ?? false,
    requireAdapterPacks: options.requireAdapterPacks ?? false
  });
  const resolution: CompanyDeploymentExportResolution = {
    company: company as unknown as CompanyProfile,
    adapterPacks: adapterPacks.adapterPacks,
    adapterPackExportNames: adapterPacks.exportNames,
    moduleExportName: selected.exportName,
    companyExportName: selected.exportName,
    companyExportPath:
      deploymentManifest === undefined ? selected.exportName : `${selected.exportName}.company`,
    ...(deploymentManifest === undefined ? {} : { deploymentExportName: selected.exportName }),
    ...(deploymentManifest === undefined ? {} : { deploymentManifest }),
    ...(deploymentManifest?.environment === undefined
      ? {}
      : { environment: deploymentManifest.environment }),
    ...(deploymentManifest?.evals === undefined ? {} : { evals: deploymentManifest.evals }),
    ...(deploymentManifest?.smoke === undefined ? {} : { smoke: deploymentManifest.smoke })
  };

  return resolution;
}

export function resolveCompanyDeploymentAdapterPacks(
  moduleExports: Readonly<Record<string, unknown>>,
  options: {
    readonly selectedExportName: string;
    readonly deploymentManifest?: CompanyDeploymentManifest;
    readonly adapterPackExportNames?: readonly string[];
    readonly discoverAdapterPacks?: boolean;
    readonly requireAdapterPacks?: boolean;
  }
): {
  readonly adapterPacks: readonly CompanyAdapterPack[];
  readonly exportNames: readonly string[];
} {
  const explicitExportNames = (options.adapterPackExportNames ?? []).length > 0;
  const requireAdapterPacks = options.requireAdapterPacks ?? false;

  if (explicitExportNames) {
    return adapterPacksFromModule(moduleExports, {
      companyExportName: options.selectedExportName,
      ...(options.adapterPackExportNames === undefined
        ? {}
        : { adapterPackExportNames: options.adapterPackExportNames })
    });
  }

  if (options.deploymentManifest?.adapterPacks !== undefined) {
    if (!Array.isArray(options.deploymentManifest.adapterPacks)) {
      throw new Error(
        `Deployment manifest "${options.selectedExportName}" adapterPacks field must be an array.`
      );
    }
    if (options.deploymentManifest.adapterPacks.length === 0 && requireAdapterPacks) {
      throw new Error(
        `Deployment manifest "${options.selectedExportName}" requires at least one adapter pack.`
      );
    }

    return {
      adapterPacks: options.deploymentManifest.adapterPacks,
      exportNames:
        options.deploymentManifest.adapterPacks.length === 0
          ? []
          : [`${options.selectedExportName}.adapterPacks`]
    };
  }

  if (options.discoverAdapterPacks === true) {
    return adapterPacksFromModule(moduleExports, {
      companyExportName: options.selectedExportName
    });
  }

  if (requireAdapterPacks) {
    throw new Error(
      `Company deployment export "${options.selectedExportName}" requires at least one adapter pack.`
    );
  }

  return {
    adapterPacks: [],
    exportNames: []
  };
}

export function adapterPacksFromModule(
  moduleExports: Readonly<Record<string, unknown>>,
  options: {
    readonly companyExportName: string;
    readonly adapterPackExportNames?: readonly string[];
  }
): {
  readonly adapterPacks: readonly CompanyAdapterPack[];
  readonly exportNames: readonly string[];
} {
  const explicitExportNames = (options.adapterPackExportNames ?? []).length > 0;
  const exportNames = explicitExportNames
    ? (options.adapterPackExportNames ?? [])
    : defaultAdapterPackExportNames(options.companyExportName);
  const adapterPacks: CompanyAdapterPack[] = [];
  const foundExportNames: string[] = [];

  for (const exportName of exportNames) {
    const exportPath = moduleExportPath(moduleExports, exportName);
    if (!exportPath.found) {
      if (explicitExportNames) {
        throw new Error(`Adapter pack export "${exportName}" was not found.`);
      }
      continue;
    }

    const value = exportPath.value;
    if (value === undefined || value === null) {
      throw new Error(`Adapter pack export "${exportName}" is empty.`);
    }
    adapterPacks.push(
      ...(Array.isArray(value) ? value : [value]).map((pack) => pack as CompanyAdapterPack)
    );
    foundExportNames.push(exportName);
    if (!explicitExportNames) {
      break;
    }
  }

  if (adapterPacks.length === 0) {
    throw new Error(
      "Company deployment module requires at least one adapter pack. Export a CompanyDeploymentManifest with adapterPacks, or set RAG_COMPANY_ADAPTER_PACK_EXPORTS for a legacy profile export."
    );
  }

  return {
    adapterPacks,
    exportNames: foundExportNames
  };
}

export function defaultCompanyDeploymentExportNames(): readonly string[] {
  return ["companyDeployment", "deployment", "companyProfile", "default"];
}

export function defaultAdapterPackExportNames(companyExportName: string): readonly string[] {
  const companyPrefix = companyExportName.replace(/CompanyProfile$/u, "");
  const candidateNames = [
    "adapterPack",
    "adapterPacks",
    "companyAdapterPack",
    "companyAdapterPacks",
    `${companyPrefix}AdapterPack`,
    `${companyPrefix}AdapterPacks`,
    `${companyExportName}AdapterPack`,
    `${companyExportName}AdapterPacks`
  ];

  return [
    ...new Set(candidateNames.filter((name) => name !== "AdapterPack" && name !== "AdapterPacks"))
  ];
}

function selectCompanyDeploymentExport(
  moduleExports: Readonly<Record<string, unknown>>,
  options: CompanyDeploymentExportResolutionOptions
): {
  readonly exportName: string;
  readonly value: unknown;
} {
  if (options.companyExportName !== undefined) {
    const exportPath = moduleExportPath(moduleExports, options.companyExportName);
    if (!exportPath.found) {
      throw new Error(
        `Export "${options.companyExportName}" from ${options.modulePath ?? "company deployment module"} was not found.`
      );
    }

    return {
      exportName: options.companyExportName,
      value: exportPath.value
    };
  }

  for (const exportName of defaultCompanyDeploymentExportNames()) {
    const exportPath = moduleExportPath(moduleExports, exportName);
    if (exportPath.found) {
      return {
        exportName,
        value: exportPath.value
      };
    }
  }

  throw new Error(
    `Company deployment module ${options.modulePath ?? "unknown"} must export one of: ${defaultCompanyDeploymentExportNames().join(", ")}.`
  );
}

function isCompanyDeploymentManifest(value: unknown): value is CompanyDeploymentManifest {
  return isObject(value) && "company" in value && value.company !== undefined;
}

function moduleExportPath(
  moduleExports: Readonly<Record<string, unknown>>,
  exportName: string
): {
  readonly found: boolean;
  readonly value?: unknown;
} {
  const parts = exportName.split(".");
  if (parts.some((part) => part.trim().length === 0)) {
    return { found: false };
  }

  let current: unknown = moduleExports;
  for (const part of parts) {
    if (!isObject(current) || !Object.hasOwn(current, part)) {
      return { found: false };
    }
    current = current[part];
  }

  return {
    found: true,
    value: current
  };
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object";
}

function resolveCompanyDeploymentModuleUrl(modulePath: string, cwd: string): URL {
  if (/^file:/u.test(modulePath)) {
    return new URL(modulePath);
  }
  if (/^https?:/u.test(modulePath)) {
    throw new Error("Remote company deployment modules are not supported.");
  }

  return pathToFileURL(path.resolve(cwd, modulePath));
}
