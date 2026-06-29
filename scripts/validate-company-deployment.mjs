#!/usr/bin/env node
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CompanyDeploymentRegistry,
  resolveCompanyDeploymentAdapterPacks,
  resolveCompanyDeploymentExport,
  runCompanyConnectorContractTests,
  runCompanyPackContractTests,
  validateCompanyDeployment
} from "../dist/index.js";

const options = parseArgs(process.argv.slice(2));

try {
  const moduleUrl = resolveModuleUrl(options.modulePath);
  const moduleExports = await import(moduleUrl.href);
  const deploymentInput = resolveCompanyDeploymentExport(moduleExports, {
    modulePath: options.modulePath,
    companyExportName: options.exportName,
    ...(options.adapterPackExportNames.length === 0
      ? {}
      : { adapterPackExportNames: options.adapterPackExportNames })
  });
  const company = deploymentInput.company;

  if (!company || typeof company !== "object") {
    throw new Error(
      `Export "${options.exportName}" from ${options.modulePath} is not a company profile or deployment object.`
    );
  }

  const report = validateCompanyDeployment(company);
  const summary = {
    status: report.ready ? "ready" : "failed",
    companyId: report.companyId,
    companyName: report.companyName,
    profileCount: report.profileCount,
    connectorCount: report.connectorCount,
    evalPackCount: report.evalPackCount,
    deploymentPackage: safeDeploymentPackageSummary(deploymentInput),
    manifestValidation: await validateDeploymentManifest(deploymentInput, options),
    errorCount: report.errors.length,
    warningCount: report.warnings.length,
    profiles: report.profiles.map((profile) => ({
      id: profile.id,
      namespaceId: profile.namespaceId,
      sourceIds: profile.corpusSources.map((source) => source.id),
      adapterIds: [...new Set(profile.corpusSources.map((source) => source.adapter))]
    })),
    issues: report.issues.map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      path: issue.path,
      message: safeText(issue.message)
    }))
  };

  if (summary.manifestValidation.status === "failed") {
    summary.status = "failed";
  }

  if (report.ready && deploymentShouldValidatePacks(deploymentInput, options)) {
    summary.adapterPackValidation = validateDeploymentAdapterPacks({
      moduleExports,
      deploymentInput,
      company,
      options
    });
    if (summary.adapterPackValidation.status === "failed") {
      summary.status = "failed";
    }
  }

  if (options.runPackContracts) {
    summary.packContracts = report.ready
      ? await runPackContractGate({
          moduleExports,
          company,
          deploymentInput,
          options
        })
      : {
          status: "skipped",
          reason: "Company deployment readiness failed; pack contracts were not run.",
          adapterPackExports: [],
          checkedAdapterCount: 0,
          checkedParserCount: 0,
          checkedConnectorCount: 0,
          checkedPermissionMapperCount: 0,
          checkedCaseCount: 0,
          errorCount: 0,
          warningCount: 0,
          adapterContracts: [],
          parserContracts: [],
          connectorContracts: undefined,
          permissionMapperContracts: [],
          issues: []
        };
    if (summary.packContracts.status === "failed") {
      summary.status = "failed";
    }
  } else if (options.runConnectorContracts) {
    summary.connectorContracts = report.ready
      ? await runConnectorContractGate({
          moduleExports,
          company,
          deploymentInput,
          options
        })
      : {
          status: "skipped",
          reason: "Company deployment readiness failed; connector contracts were not run.",
          adapterPackExports: [],
          checkedUseCaseCount: 0,
          checkedConnectorCount: 0,
          checkedSourceCount: 0,
          checkedCaseCount: 0,
          errorCount: 0,
          warningCount: 0,
          reports: [],
          issues: []
        };
    if (summary.connectorContracts.status === "failed") {
      summary.status = "failed";
    }
  }

  if (options.reportDir) {
    await writeJson(path.join(options.reportDir, "company-deployment.json"), summary);
    if (summary.connectorContracts) {
      await writeJson(
        path.join(options.reportDir, "company-connector-contracts.json"),
        summary.connectorContracts
      );
    }
    if (summary.packContracts) {
      await writeJson(
        path.join(options.reportDir, "company-pack-contracts.json"),
        summary.packContracts
      );
    }
  }

  console.log(JSON.stringify(summary, null, 2));

  if (summary.status !== "ready") {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: safeError(error)
    })
  );
  process.exitCode = 1;
}

function parseArgs(args) {
  const options = {
    modulePath: "dist/company/examples/acme-support.company.js",
    exportName: "acmeSupportDeployment",
    adapterPackExportNames: [],
    contractUseCaseIds: [],
    contractModes: [],
    runConnectorContracts: false,
    runPackContracts: false,
    requireFullComplete: true,
    requireSafeAccessBoundary: true,
    allowConnectorWarnings: true,
    requireManifestEnv: false,
    requireSmokeCommands: false,
    manifestRoot: process.cwd(),
    principalNamespaceIds: [],
    principalTeamIds: [],
    principalRoles: [],
    principalTags: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--module":
        options.modulePath = requiredValue(args, ++index, arg);
        break;
      case "--export":
        options.exportName = requiredValue(args, ++index, arg);
        break;
      case "--report-dir":
        options.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--run-connector-contracts":
        options.runConnectorContracts = true;
        break;
      case "--run-pack-contracts":
        options.runPackContracts = true;
        break;
      case "--adapter-pack-export":
        options.adapterPackExportNames.push(requiredValue(args, ++index, arg));
        break;
      case "--use-case":
        options.contractUseCaseIds.push(requiredValue(args, ++index, arg));
        break;
      case "--contract-mode":
        options.contractModes.push(sourceSyncMode(requiredValue(args, ++index, arg), arg));
        break;
      case "--contract-requested-at":
        options.contractRequestedAt = requiredValue(args, ++index, arg);
        break;
      case "--min-delta-returned-records":
        options.minDeltaReturnedRecords = nonNegativeInteger(
          requiredValue(args, ++index, arg),
          arg
        );
        break;
      case "--allow-incomplete-full":
        options.requireFullComplete = false;
        break;
      case "--allow-open-acl":
        options.requireSafeAccessBoundary = false;
        break;
      case "--disallow-connector-warnings":
        options.allowConnectorWarnings = false;
        break;
      case "--require-manifest-env":
        options.requireManifestEnv = true;
        break;
      case "--require-smoke-commands":
        options.requireSmokeCommands = true;
        break;
      case "--manifest-root":
        options.manifestRoot = requiredValue(args, ++index, arg);
        break;
      case "--principal-user-id":
        options.principalUserId = requiredValue(args, ++index, arg);
        break;
      case "--principal-tenant-id":
        options.principalTenantId = requiredValue(args, ++index, arg);
        break;
      case "--principal-namespace-id":
        options.principalNamespaceIds.push(requiredValue(args, ++index, arg));
        break;
      case "--principal-team-id":
        options.principalTeamIds.push(requiredValue(args, ++index, arg));
        break;
      case "--principal-role":
        options.principalRoles.push(requiredValue(args, ++index, arg));
        break;
      case "--principal-tag":
        options.principalTags.push(requiredValue(args, ++index, arg));
        break;
      default:
        throw new Error(`Unknown company deployment validation argument "${arg}".`);
    }
  }

  return options;
}

async function runPackContractGate(input) {
  try {
    const { adapterPacks, exportNames } = adapterPacksForContracts(
      input.moduleExports,
      input.deploymentInput,
      input.options
    );
    const registry = new CompanyDeploymentRegistry([
      {
        company: input.company,
        adapterPacks
      }
    ]);
    const useCaseIds =
      input.options.contractUseCaseIds.length > 0
        ? input.options.contractUseCaseIds
        : input.company.useCases.map((useCase) => useCase.id);
    const reports = [];

    for (const useCaseId of useCaseIds) {
      const useCase = input.company.useCases.find((candidate) => candidate.id === useCaseId);
      if (!useCase) {
        throw new Error(`Company use case "${useCaseId}" does not exist.`);
      }

      const report = await runCompanyPackContractTests({
        registry,
        company: {
          companyId: input.company.companyId,
          useCaseId
        },
        requestedBy: principalForUseCase(input.company, useCase, input.options),
        ...(input.options.contractModes.length === 0 ? {} : { modes: input.options.contractModes }),
        ...(input.options.contractRequestedAt === undefined
          ? {}
          : { requestedAt: input.options.contractRequestedAt }),
        expectations: {
          connector: {
            ...(input.options.minDeltaReturnedRecords === undefined
              ? {}
              : { minDeltaReturnedRecords: input.options.minDeltaReturnedRecords }),
            requireFullComplete: input.options.requireFullComplete,
            requireSafeAccessBoundary: input.options.requireSafeAccessBoundary,
            allowConnectorWarnings: input.options.allowConnectorWarnings
          }
        }
      });
      reports.push(safePackContractReport(report));
    }

    const issues = reports.flatMap((report) => report.issues);
    const errorCount = reports.reduce((sum, report) => sum + report.errorCount, 0);
    const warningCount = reports.reduce((sum, report) => sum + report.warningCount, 0);

    return {
      status: errorCount === 0 ? "passed" : "failed",
      adapterPackExports: exportNames,
      checkedUseCaseCount: reports.length,
      checkedAdapterCount: reports.reduce((sum, report) => sum + report.checkedAdapterCount, 0),
      checkedParserCount: reports.reduce((sum, report) => sum + report.checkedParserCount, 0),
      checkedConnectorCount: reports.reduce((sum, report) => sum + report.checkedConnectorCount, 0),
      checkedPermissionMapperCount: reports.reduce(
        (sum, report) => sum + report.checkedPermissionMapperCount,
        0
      ),
      checkedCaseCount: reports.reduce((sum, report) => sum + report.checkedCaseCount, 0),
      errorCount,
      warningCount,
      reports,
      issues
    };
  } catch (error) {
    return {
      status: "failed",
      adapterPackExports: [],
      checkedUseCaseCount: 0,
      checkedAdapterCount: 0,
      checkedParserCount: 0,
      checkedConnectorCount: 0,
      checkedPermissionMapperCount: 0,
      checkedCaseCount: 0,
      errorCount: 1,
      warningCount: 0,
      reports: [],
      issues: [],
      error: safeError(error)
    };
  }
}

async function runConnectorContractGate(input) {
  try {
    const { adapterPacks, exportNames } = adapterPacksForContracts(
      input.moduleExports,
      input.deploymentInput,
      input.options
    );
    const registry = new CompanyDeploymentRegistry([
      {
        company: input.company,
        adapterPacks
      }
    ]);
    const adapterPackValidation = safeAdapterPackValidationSummary(
      registry.getCompanyRequired(input.company.companyId)
    );
    const useCaseIds =
      input.options.contractUseCaseIds.length > 0
        ? input.options.contractUseCaseIds
        : input.company.useCases.map((useCase) => useCase.id);
    const reports = [];

    for (const useCaseId of useCaseIds) {
      const useCase = input.company.useCases.find((candidate) => candidate.id === useCaseId);
      if (!useCase) {
        throw new Error(`Company use case "${useCaseId}" does not exist.`);
      }

      const report = await runCompanyConnectorContractTests({
        registry,
        company: {
          companyId: input.company.companyId,
          useCaseId
        },
        requestedBy: principalForUseCase(input.company, useCase, input.options),
        ...(input.options.contractModes.length === 0 ? {} : { modes: input.options.contractModes }),
        ...(input.options.contractRequestedAt === undefined
          ? {}
          : { requestedAt: input.options.contractRequestedAt }),
        expectations: {
          ...(input.options.minDeltaReturnedRecords === undefined
            ? {}
            : { minDeltaReturnedRecords: input.options.minDeltaReturnedRecords }),
          requireFullComplete: input.options.requireFullComplete,
          requireSafeAccessBoundary: input.options.requireSafeAccessBoundary,
          allowConnectorWarnings: input.options.allowConnectorWarnings
        }
      });
      reports.push(safeConnectorContractReport(report));
    }

    const issues = reports.flatMap((report) => report.issues);
    const errorCount = reports.reduce((sum, report) => sum + report.errorCount, 0);
    const warningCount = reports.reduce((sum, report) => sum + report.warningCount, 0);

    return {
      status: errorCount + adapterPackValidation.errorCount === 0 ? "passed" : "failed",
      adapterPackExports: exportNames,
      adapterPackValidation,
      checkedUseCaseCount: reports.length,
      checkedConnectorCount: reports.reduce((sum, report) => sum + report.checkedConnectorCount, 0),
      checkedSourceCount: reports.reduce((sum, report) => sum + report.checkedSourceCount, 0),
      checkedCaseCount: reports.reduce((sum, report) => sum + report.checkedCaseCount, 0),
      errorCount: errorCount + adapterPackValidation.errorCount,
      warningCount: warningCount + adapterPackValidation.warningCount,
      reports,
      issues
    };
  } catch (error) {
    return {
      status: "failed",
      adapterPackExports: [],
      checkedUseCaseCount: 0,
      checkedConnectorCount: 0,
      checkedSourceCount: 0,
      checkedCaseCount: 0,
      errorCount: 1,
      warningCount: 0,
      reports: [],
      issues: [],
      error: safeError(error)
    };
  }
}

function adapterPacksForContracts(moduleExports, deploymentInput, options) {
  return resolveCompanyDeploymentAdapterPacks(moduleExports, {
    selectedExportName: deploymentInput.moduleExportName,
    ...(deploymentInput.deploymentManifest === undefined
      ? {}
      : { deploymentManifest: deploymentInput.deploymentManifest }),
    ...(options.adapterPackExportNames.length === 0
      ? {}
      : { adapterPackExportNames: options.adapterPackExportNames }),
    discoverAdapterPacks: true,
    requireAdapterPacks: true
  });
}

function deploymentShouldValidatePacks(deploymentInput, options) {
  return deploymentInput.adapterPacks.length > 0 || options.adapterPackExportNames.length > 0;
}

function safeDeploymentPackageSummary(deploymentInput) {
  return {
    exportName: deploymentInput.moduleExportName,
    companyExportPath: deploymentInput.companyExportPath,
    adapterPackExports: deploymentInput.adapterPackExportNames,
    adapterPackCount: deploymentInput.adapterPacks.length,
    ...(deploymentInput.environment === undefined
      ? {}
      : { environment: safeEnvironmentManifest(deploymentInput.environment) }),
    ...(deploymentInput.evals === undefined
      ? {}
      : { evals: safeEvalManifest(deploymentInput.evals) }),
    ...(deploymentInput.smoke === undefined
      ? {}
      : { smoke: safeSmokeManifest(deploymentInput.smoke) })
  };
}

function safeEnvironmentManifest(environment) {
  return {
    requiredEnv: safeStringArray(environment.requiredEnv),
    optionalEnv: safeStringArray(environment.optionalEnv)
  };
}

function safeEvalManifest(evals) {
  return {
    requiredPaths: safeStringArray(evals.requiredPaths),
    goldenSetPaths: safeStringArray(evals.goldenSetPaths),
    adversarialSetPaths: safeStringArray(evals.adversarialSetPaths)
  };
}

function safeSmokeManifest(smoke) {
  return {
    ...(smoke.validateCommand === undefined
      ? {}
      : { validateCommand: safeText(smoke.validateCommand) }),
    ...(smoke.packContractsCommand === undefined
      ? {}
      : { packContractsCommand: safeText(smoke.packContractsCommand) }),
    ...(smoke.smokeCommand === undefined ? {} : { smokeCommand: safeText(smoke.smokeCommand) }),
    ...(smoke.postgresSmokeCommand === undefined
      ? {}
      : { postgresSmokeCommand: safeText(smoke.postgresSmokeCommand) })
  };
}

function safeStringArray(values) {
  return (values ?? []).map((value) => safeText(value));
}

async function validateDeploymentManifest(deploymentInput, options) {
  if (deploymentInput.deploymentManifest === undefined) {
    return {
      status: "skipped",
      reason: "Export is a legacy CompanyProfile, not a CompanyDeploymentManifest.",
      errorCount: 0,
      warningCount: 0,
      checkedEnvCount: 0,
      checkedEvalPathCount: 0,
      checkedSmokeCommandCount: 0,
      issues: []
    };
  }

  const issues = [];
  validateEnvironmentManifest(deploymentInput.environment, options, issues);
  await validateEvalManifest(deploymentInput.evals, options, issues);
  validateSmokeManifest(deploymentInput.smoke, options, issues);

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  return {
    status: errorCount === 0 ? "passed" : "failed",
    errorCount,
    warningCount,
    checkedEnvCount: (deploymentInput.environment?.requiredEnv ?? []).length,
    checkedEvalPathCount: (deploymentInput.evals?.requiredPaths ?? []).length,
    checkedSmokeCommandCount: smokeCommands(deploymentInput.smoke).length,
    issues
  };
}

function validateEnvironmentManifest(environment, options, issues) {
  for (const [kind, envNames] of [
    ["requiredEnv", environment?.requiredEnv ?? []],
    ["optionalEnv", environment?.optionalEnv ?? []]
  ]) {
    envNames.forEach((envName, index) => {
      if (!isValidEnvName(envName)) {
        issues.push({
          severity: "error",
          code: "invalid_env_name",
          path: `environment.${kind}[${index}]`,
          message: `Manifest env name "${safeText(envName)}" is not a safe environment variable name.`
        });
      }
    });
  }

  if (options.requireManifestEnv) {
    (environment?.requiredEnv ?? []).forEach((envName, index) => {
      if (!process.env[envName]?.trim()) {
        issues.push({
          severity: "error",
          code: "required_env_missing",
          path: `environment.requiredEnv[${index}]`,
          message: `Required manifest env "${safeText(envName)}" is not set.`
        });
      }
    });
  }
}

async function validateEvalManifest(evals, options, issues) {
  for (const [index, filePath] of (evals?.requiredPaths ?? []).entries()) {
    if (!isSafeRelativePath(filePath)) {
      issues.push({
        severity: "error",
        code: "unsafe_eval_path",
        path: `evals.requiredPaths[${index}]`,
        message: `Required eval path "${safeText(filePath)}" must be a relative path inside the manifest root.`
      });
      continue;
    }

    const absolutePath = path.resolve(options.manifestRoot, filePath);
    try {
      await access(absolutePath);
    } catch {
      issues.push({
        severity: "error",
        code: "required_eval_path_missing",
        path: `evals.requiredPaths[${index}]`,
        message: `Required eval path "${safeText(filePath)}" was not found under manifest root.`
      });
    }
  }
}

function validateSmokeManifest(smoke, options, issues) {
  const commands = smokeCommands(smoke);
  for (const command of commands) {
    if (!command.value.trim()) {
      issues.push({
        severity: "error",
        code: "empty_smoke_command",
        path: `smoke.${command.key}`,
        message: `Smoke command "${command.key}" is empty.`
      });
    }
    if (/[\r\n]/u.test(command.value)) {
      issues.push({
        severity: "error",
        code: "unsafe_smoke_command",
        path: `smoke.${command.key}`,
        message: `Smoke command "${command.key}" must be a single line.`
      });
    }
  }

  if (options.requireSmokeCommands) {
    for (const key of ["validateCommand", "smokeCommand", "postgresSmokeCommand"]) {
      if (!smoke?.[key]?.trim()) {
        issues.push({
          severity: "error",
          code: "required_smoke_command_missing",
          path: `smoke.${key}`,
          message: `Required smoke command "${key}" is missing.`
        });
      }
    }
  }
}

function smokeCommands(smoke) {
  if (smoke === undefined) {
    return [];
  }
  return ["validateCommand", "packContractsCommand", "smokeCommand", "postgresSmokeCommand"]
    .filter((key) => smoke[key] !== undefined)
    .map((key) => ({
      key,
      value: String(smoke[key])
    }));
}

function isValidEnvName(value) {
  return /^[A-Z_][A-Z0-9_]*$/u.test(value);
}

function isSafeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]+/u).includes("..")
  );
}

function validateDeploymentAdapterPacks(input) {
  try {
    const { adapterPacks, exportNames } = adapterPacksForContracts(
      input.moduleExports,
      input.deploymentInput,
      input.options
    );
    const registry = new CompanyDeploymentRegistry([
      {
        company: input.company,
        adapterPacks
      }
    ]);

    return {
      ...safeAdapterPackValidationSummary(registry.getCompanyRequired(input.company.companyId)),
      adapterPackExports: exportNames
    };
  } catch (error) {
    return {
      status: "failed",
      adapterPackExports: [],
      adapterPackCount: 0,
      reportCount: 0,
      errorCount: 1,
      warningCount: 0,
      reports: [],
      issues: [],
      error: safeError(error)
    };
  }
}

function principalForUseCase(company, useCase, options) {
  return {
    userId: options.principalUserId ?? "company_connector_contract",
    tenantId: options.principalTenantId ?? company.defaultTenantId,
    namespaceIds:
      options.principalNamespaceIds.length > 0
        ? options.principalNamespaceIds
        : [useCase.namespaceId],
    teamIds: options.principalTeamIds,
    roles:
      options.principalRoles.length > 0 ? options.principalRoles : ["company_connector_contract"],
    tags: options.principalTags.length > 0 ? options.principalTags : ["contract-test"]
  };
}

function safeConnectorContractReport(report) {
  return {
    status: report.status,
    companyId: report.companyId,
    useCaseId: report.useCaseId,
    profileId: report.profileId,
    namespaceId: report.namespaceId,
    requestedAt: report.requestedAt,
    checkedConnectorCount: report.checkedConnectorCount,
    checkedSourceCount: report.checkedSourceCount,
    checkedCaseCount: report.checkedCaseCount,
    errorCount: report.errors.length,
    warningCount: report.warnings.length,
    cases: report.cases.map((contractCase) => ({
      status: contractCase.status,
      connectorId: contractCase.connectorId,
      sourceSystem: contractCase.sourceSystem,
      adapterId: contractCase.adapterId,
      sourceId: contractCase.sourceId,
      mode: contractCase.mode,
      runStatus: contractCase.run.status,
      complete: contractCase.run.complete,
      errorCount: contractCase.errors.length,
      warningCount: contractCase.warnings.length,
      metrics: contractCase.run.metrics,
      ledger: {
        status: contractCase.run.ledger.status,
        entryCount: contractCase.run.ledger.metrics.entryCount,
        activeCount: contractCase.run.ledger.metrics.activeCount,
        deletedCount: contractCase.run.ledger.metrics.deletedCount,
        failedCount: contractCase.run.ledger.metrics.failedCount
      },
      issues: contractCase.issues.map(safeConnectorContractIssue)
    })),
    issues: report.issues.map(safeConnectorContractIssue)
  };
}

function safePackContractReport(report) {
  return {
    status: report.status,
    companyId: report.companyId,
    useCaseId: report.useCaseId,
    profileId: report.profileId,
    namespaceId: report.namespaceId,
    requestedAt: report.requestedAt,
    checkedAdapterCount: report.checkedAdapterCount,
    checkedParserCount: report.checkedParserCount,
    checkedConnectorCount: report.checkedConnectorCount,
    checkedPermissionMapperCount: report.checkedPermissionMapperCount,
    checkedCaseCount: report.checkedCaseCount,
    errorCount: report.errors.length,
    warningCount: report.warnings.length,
    adapterContracts: report.adapterContracts.map((contract) => ({
      status: contract.status,
      adapterId: contract.adapterId,
      sourceId: contract.sourceId,
      loadedRecordCount: contract.loadedRecordCount,
      acceptedDocumentCount: contract.acceptedDocumentCount,
      rejectedRecordCount: contract.rejectedRecordCount,
      issueCount: contract.issueCount,
      errorCount: contract.errorCount,
      warningCount: contract.warningCount
    })),
    parserContracts: report.parserContracts.map((contract) => ({
      status: contract.status,
      parserId: contract.parserId,
      sourceId: contract.sourceId,
      bodyLength: contract.bodyLength,
      warningCount: contract.warningCount,
      layoutIssueCount: contract.layoutIssueCount,
      issueCount: contract.issueCount,
      errorCount: contract.errorCount
    })),
    connectorContracts: safeConnectorContractReport(report.connectorContracts),
    permissionMapperContracts: report.permissionMapperContracts.map((contract) => ({
      status: contract.status,
      mapperId: contract.mapperId,
      sourceSystem: contract.sourceSystem,
      connectorId: contract.connectorId,
      sourceId: contract.sourceId,
      scope: contract.scope
        ? {
            tenantId: contract.scope.tenantId,
            namespaceId: contract.scope.namespaceId,
            teamCount: contract.scope.teamIds?.length ?? 0,
            userCount: contract.scope.userIds?.length ?? 0,
            roleCount: contract.scope.roles?.length ?? 0,
            tagCount: contract.scope.tags?.length ?? 0
          }
        : undefined,
      errorCount: contract.issues.filter((issue) => issue.severity === "error").length,
      warningCount: contract.issues.filter((issue) => issue.severity === "warning").length
    })),
    issues: report.issues.map(safePackContractIssue)
  };
}

function safePackContractIssue(issue) {
  return {
    severity: issue.severity,
    code: issue.code,
    area: issue.area,
    subjectId: issue.subjectId,
    path: issue.path,
    message: safeText(issue.message),
    ...(issue.upstreamCode === undefined ? {} : { upstreamCode: issue.upstreamCode })
  };
}

function safeAdapterPackValidationSummary(entry) {
  const reports = [
    ...entry.adapterPackReports.map((report) => safeAdapterPackReport(report, "pack")),
    ...(entry.adapterPackCoverageReport === undefined
      ? []
      : [safeAdapterPackReport(entry.adapterPackCoverageReport, "coverage")])
  ];
  const issues = reports.flatMap((report) => report.issues);
  const errorCount = reports.reduce((sum, report) => sum + report.errorCount, 0);
  const warningCount = reports.reduce((sum, report) => sum + report.warningCount, 0);

  return {
    status: errorCount === 0 ? "passed" : "failed",
    adapterPackCount: entry.adapterPacks.length,
    reportCount: reports.length,
    errorCount,
    warningCount,
    reports,
    issues
  };
}

function safeAdapterPackReport(report, scope) {
  return {
    scope,
    status: report.valid ? "passed" : "failed",
    companyId: report.companyId,
    packId: report.packId,
    adapterCount: report.adapterCount,
    parserCount: report.parserCount,
    sourceConnectorCount: report.sourceConnectorCount,
    permissionMapperCount: report.permissionMapperCount,
    connectorTestCount: report.connectorTestCount,
    corpusAdapterTestCount: report.corpusAdapterTestCount,
    parserTestCount: report.parserTestCount,
    errorCount: report.errors.length,
    warningCount: report.warnings.length,
    issues: report.issues.map(safeAdapterPackIssue)
  };
}

function safeAdapterPackIssue(issue) {
  return {
    severity: issue.severity,
    code: issue.code,
    path: issue.path,
    message: safeText(issue.message)
  };
}

function safeConnectorContractIssue(issue) {
  return {
    severity: issue.severity,
    code: issue.code,
    connectorId: issue.connectorId,
    sourceId: issue.sourceId,
    mode: issue.mode,
    path: issue.path,
    message: safeText(issue.message)
  };
}

function resolveModuleUrl(modulePath) {
  if (/^file:/u.test(modulePath)) {
    return new globalThis.URL(modulePath);
  }
  if (/^https?:/u.test(modulePath)) {
    throw new Error("Remote company deployment modules are not supported.");
  }

  return pathToFileURL(path.resolve(process.cwd(), modulePath));
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(`${filePath}.tmp`, filePath);
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function sourceSyncMode(value, flag) {
  if (value !== "delta" && value !== "full") {
    throw new Error(`${flag} must be "delta" or "full".`);
  }
  return value;
}

function nonNegativeInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return parsed;
}

function safeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: safeText(
      error instanceof Error ? error.message : "Company deployment validation failed."
    )
  };
}

function safeText(value) {
  return String(value)
    .replace(/bearer\s+[a-z0-9._-]+/giu, "bearer [redacted]")
    .replace(/api[_-]?key\s*[:=]\s*[^,\s]+/giu, "api_key=[redacted]")
    .replace(/password\s*[:=]\s*[^,\s]+/giu, "password=[redacted]")
    .replace(/secret\s*[:=]\s*[^,\s]+/giu, "secret=[redacted]")
    .replace(/token\s*[:=]\s*[^,\s]+/giu, "token=[redacted]");
}
