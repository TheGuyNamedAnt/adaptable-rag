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

export interface LoadedCompanyDeploymentModule {
  readonly company: CompanyProfile;
  readonly adapterPacks: readonly CompanyAdapterPack[];
  readonly adapterPackExportNames: readonly string[];
  readonly moduleUrl: string;
  readonly companyExportName: string;
}

export async function loadCompanyDeploymentModule(
  options: CompanyDeploymentModuleLoadOptions
): Promise<LoadedCompanyDeploymentModule> {
  const moduleUrl = resolveCompanyDeploymentModuleUrl(
    options.modulePath,
    options.cwd ?? process.cwd()
  );
  const moduleExports = (await import(moduleUrl.href)) as Readonly<Record<string, unknown>>;
  const companyExportName = options.companyExportName ?? "companyProfile";
  const company = moduleExports[companyExportName];

  if (!company || typeof company !== "object") {
    throw new Error(
      `Export "${companyExportName}" from ${options.modulePath} is not a company profile object.`
    );
  }

  const { adapterPacks, exportNames } = adapterPacksFromModule(moduleExports, {
    companyExportName,
    adapterPackExportNames: options.adapterPackExportNames ?? []
  });

  return {
    company: company as CompanyProfile,
    adapterPacks,
    adapterPackExportNames: exportNames,
    moduleUrl: moduleUrl.href,
    companyExportName
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
    if (!Object.hasOwn(moduleExports, exportName)) {
      if (explicitExportNames) {
        throw new Error(`Adapter pack export "${exportName}" was not found.`);
      }
      continue;
    }

    const value = moduleExports[exportName];
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
      "Company deployment module requires at least one adapter pack export. Set RAG_COMPANY_ADAPTER_PACK_EXPORTS or export companyAdapterPack."
    );
  }

  return {
    adapterPacks,
    exportNames: foundExportNames
  };
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

function resolveCompanyDeploymentModuleUrl(modulePath: string, cwd: string): URL {
  if (/^file:/u.test(modulePath)) {
    return new URL(modulePath);
  }
  if (/^https?:/u.test(modulePath)) {
    throw new Error("Remote company deployment modules are not supported.");
  }

  return pathToFileURL(path.resolve(cwd, modulePath));
}
