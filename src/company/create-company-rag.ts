import { createRag, type CreateRagOptions, type PlugAndPlayRag } from "../runtime/create-rag.js";
import type {
  ProductionIngestRuntimeOptions,
  ProductionCorpusAdapterExtension,
  ProductionDocumentParserExtension
} from "../runtime/production-ingestion.js";
import type { ProductionRagAppConfig } from "../runtime/production-app.js";
import {
  assembleCompanyRuntime,
  type CompanyRuntimeAssembly,
  type CompanyRuntimeAssemblyRequest
} from "./company-runtime-assembly.js";
import type { CompanyDeploymentRegistry } from "./company-deployment-registry.js";

export interface CreateCompanyRagOptions extends Omit<CreateRagOptions, "config" | "ingestion"> {
  readonly registry: CompanyDeploymentRegistry;
  readonly company: CompanyRuntimeAssemblyRequest;
  readonly config: Omit<ProductionRagAppConfig, "profile">;
  readonly ingestion?: Omit<
    ProductionIngestRuntimeOptions,
    "app" | "adapterExtensions" | "parserExtensions"
  > & {
    readonly adapterExtensions?: readonly ProductionCorpusAdapterExtension[];
    readonly parserExtensions?: readonly ProductionDocumentParserExtension[];
  };
}

export interface CompanyRag extends PlugAndPlayRag {
  readonly companyRuntime: CompanyRuntimeAssembly;
}

export function createCompanyRag(options: CreateCompanyRagOptions): CompanyRag {
  const companyRuntime = assembleCompanyRuntime(options.registry, options.company);
  const rag = createRag({
    ...options,
    config: {
      ...options.config,
      profile: companyRuntime.resolution.profile
    },
    ingestion: {
      ...(options.ingestion ?? {}),
      adapterExtensions: [
        ...companyRuntime.corpusAdapterExtensions,
        ...(options.ingestion?.adapterExtensions ?? [])
      ],
      parserExtensions: [
        ...companyRuntime.parserExtensions,
        ...(options.ingestion?.parserExtensions ?? [])
      ]
    }
  });

  return {
    ...rag,
    companyRuntime
  };
}
