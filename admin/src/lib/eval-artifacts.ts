import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveRagRepoRoot } from "@/lib/repo-root";

export interface EvalDashboardArtifact {
  readonly schemaVersion?: number;
  readonly generatedAt?: string;
  readonly recallAtK?: number;
  readonly mrr?: number;
  readonly citationPrecision?: number;
  readonly citationRecall?: number;
  readonly refusalCorrectnessRate?: number;
  readonly accessBoundaryCorrectnessRate?: number;
  readonly staleSourceRefusalRate?: number;
  readonly parserQualityImpact?: number;
  readonly graphPathGrounding?: number;
  readonly latencyMsP50?: number;
  readonly estimatedCostUsdTotal?: number;
}

export interface EvalSummarySuite {
  readonly profileId: string;
  readonly namespaceId: string;
  readonly passed: boolean;
  readonly caseCount: number;
  readonly failureCount: number;
  readonly missingRequiredChecks: readonly string[];
}

export interface EvalSummaryArtifact {
  readonly passed: boolean;
  readonly suiteCount: number;
  readonly caseCount: number;
  readonly failureCount: number;
  readonly suites: readonly EvalSummarySuite[];
}

export interface EvalRegressionDelta {
  readonly metric: string;
  readonly baseline: number;
  readonly current: number;
  readonly change: number;
}

export interface EvalRegressionArtifact {
  readonly passed: boolean;
  readonly failureCount: number;
  readonly warningCount: number;
  readonly deltas: readonly EvalRegressionDelta[];
}

export interface EvalArtifacts {
  readonly generatedAt: string;
  readonly dashboard?: EvalDashboardArtifact;
  readonly summary?: EvalSummaryArtifact;
  readonly regression?: EvalRegressionArtifact;
}

interface RawEvalSummary {
  readonly passed?: boolean;
  readonly suiteCount?: number;
  readonly caseCount?: number;
  readonly failures?: readonly unknown[];
  readonly suites?: readonly RawEvalSuite[];
}

interface RawEvalSuite {
  readonly profileId?: string;
  readonly namespaceId?: string;
  readonly passed?: boolean;
  readonly caseCount?: number;
  readonly failures?: readonly unknown[];
  readonly missingRequiredChecks?: readonly string[];
}

interface RawRegression {
  readonly passed?: boolean;
  readonly failures?: readonly unknown[];
  readonly warnings?: readonly unknown[];
  readonly deltas?: readonly EvalRegressionDelta[];
}

export async function getEvalArtifacts(): Promise<EvalArtifacts> {
  const root = evalRoot();
  const [dashboard, rawSummary, rawRegression] = await Promise.all([
    readJson<EvalDashboardArtifact>(path.join(/*turbopackIgnore: true*/ root, "dashboard.json")),
    readJson<RawEvalSummary>(path.join(/*turbopackIgnore: true*/ root, "summary.json")),
    readJson<RawRegression>(path.join(/*turbopackIgnore: true*/ root, "regression.json"))
  ]);
  return {
    generatedAt: new Date().toISOString(),
    ...(dashboard === undefined ? {} : { dashboard }),
    ...(rawSummary === undefined ? {} : { summary: normalizeSummary(rawSummary) }),
    ...(rawRegression === undefined ? {} : { regression: normalizeRegression(rawRegression) })
  };
}

function normalizeSummary(summary: RawEvalSummary): EvalSummaryArtifact {
  return {
    passed: summary.passed === true,
    suiteCount: summary.suiteCount ?? summary.suites?.length ?? 0,
    caseCount: summary.caseCount ?? 0,
    failureCount: summary.failures?.length ?? 0,
    suites: (summary.suites ?? []).map((suite) => ({
      profileId: suite.profileId ?? "unknown-profile",
      namespaceId: suite.namespaceId ?? "unknown-namespace",
      passed: suite.passed === true,
      caseCount: suite.caseCount ?? 0,
      failureCount: suite.failures?.length ?? 0,
      missingRequiredChecks: suite.missingRequiredChecks ?? []
    }))
  };
}

function normalizeRegression(regression: RawRegression): EvalRegressionArtifact {
  return {
    passed: regression.passed === true,
    failureCount: regression.failures?.length ?? 0,
    warningCount: regression.warnings?.length ?? 0,
    deltas: regression.deltas ?? []
  };
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(/*turbopackIgnore: true*/ filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function evalRoot(): string {
  const configured = process.env.RAG_ADMIN_EVAL_RUN_DIR?.trim();
  if (configured) {
    return path.resolve(/*turbopackIgnore: true*/ configured);
  }
  return path.join(/*turbopackIgnore: true*/ resolveRagRepoRoot(), ".rag", "eval-runs", "latest");
}
