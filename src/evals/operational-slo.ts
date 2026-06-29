import {
  evaluateSloRules,
  type SloEvaluationReport,
  type SloRule,
  type SloRunbook,
  type SloSignal,
  type SloSignalValue
} from "../observability/slo.js";
import type { ProductionHttpMetricsSnapshot } from "../runtime/production-http-server.js";
import type { ProviderSmokeReport } from "../runtime/provider-smoke.js";
import type { RagEvalBenchmarkSnapshot } from "./eval-report.js";
import type { EvalTraceReplayReport } from "./eval-replay.js";

export interface RagOperationalSloInput {
  readonly evalBenchmark?: RagEvalBenchmarkSnapshot;
  readonly traceReplay?: EvalTraceReplayReport;
  readonly providerSmoke?: ProviderSmokeReport;
  readonly httpMetrics?: ProductionHttpMetricsSnapshot;
  readonly generatedAt?: string;
}

export function buildRagOperationalSloReport(input: RagOperationalSloInput): SloEvaluationReport {
  return evaluateSloRules({
    signals: ragOperationalSloSignals(input),
    rules: ragOperationalSloRules(input),
    ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt })
  });
}

export function ragOperationalSloSignals(input: RagOperationalSloInput): readonly SloSignal[] {
  const signals: SloSignal[] = [];

  if (input.evalBenchmark) {
    const visualCaseCount = input.evalBenchmark.retrievalModeCounts["visual"] ?? 0;
    signals.push(
      signal("eval.passed", input.evalBenchmark.passed, undefined, { artifact: "eval_benchmark" }),
      signal("eval.caseCount", input.evalBenchmark.caseCount, "cases"),
      signal("eval.failedCaseCount", input.evalBenchmark.failedCaseCount, "cases"),
      signal("eval.passRate", input.evalBenchmark.passRate, "ratio"),
      signal("eval.visualCitationCount", input.evalBenchmark.visualCitationCount, "citations"),
      signal("eval.visualCaseCount", visualCaseCount, "cases")
    );
  }

  if (input.traceReplay) {
    signals.push(
      signal("traceReplay.passed", input.traceReplay.status === "passed", undefined, {
        artifact: "trace_replay"
      }),
      signal("traceReplay.caseCount", input.traceReplay.caseCount, "cases"),
      signal("traceReplay.mismatchedCount", input.traceReplay.mismatchedCount, "cases"),
      signal("traceReplay.notComparableCount", input.traceReplay.notComparableCount, "cases")
    );
  }

  if (input.providerSmoke) {
    signals.push(
      signal("providerSmoke.passed", input.providerSmoke.status === "passed", undefined, {
        profileId: input.providerSmoke.profileId,
        namespaceId: input.providerSmoke.namespaceId
      }),
      signal(
        "providerSmoke.failedRequiredProviderCount",
        input.providerSmoke.summary.failedRequiredProviderCount,
        "providers"
      ),
      signal(
        "providerSmoke.failedProviderProbeCheckCount",
        input.providerSmoke.summary.failedProviderProbeCheckCount,
        "checks"
      ),
      signal(
        "providerSmoke.skippedProviderProbeCheckCount",
        input.providerSmoke.summary.skippedProviderProbeCheckCount,
        "checks"
      )
    );
  }

  if (input.httpMetrics) {
    signals.push(
      signal("http.ready", input.httpMetrics.ready),
      signal("http.draining", input.httpMetrics.draining),
      signal("http.serverErrors", input.httpMetrics.serverErrors, "requests"),
      signal("http.requestErrors", input.httpMetrics.requestErrors, "requests"),
      signal("http.answerFailed", input.httpMetrics.answerFailed, "requests"),
      signal("http.rateLimited", input.httpMetrics.rateLimited, "requests"),
      signal("http.authDenied", input.httpMetrics.authDenied, "requests"),
      signal("http.activeRequests", input.httpMetrics.activeRequests, "requests"),
      signal("http.latencyMs.p95", input.httpMetrics.latencyMs.p95, "ms"),
      signal("http.latencyMs.p99", input.httpMetrics.latencyMs.p99, "ms"),
      signal("rag.answerCount", input.httpMetrics.rag.answerCount, "answers"),
      signal("rag.lowCitationAnswerCount", input.httpMetrics.rag.lowCitationAnswerCount, "answers"),
      signal("rag.noEvidenceAnswerCount", input.httpMetrics.rag.noEvidenceAnswerCount, "answers"),
      signal(
        "rag.humanReviewRequiredCount",
        input.httpMetrics.rag.humanReviewRequiredCount,
        "answers"
      ),
      signal("rag.modelLatencyMs.p95", input.httpMetrics.rag.modelLatencyMs.p95, "ms"),
      signal("rag.estimatedCostUsd", input.httpMetrics.rag.estimatedCostUsd, "USD")
    );
  }

  return signals;
}

export function ragOperationalSloRules(input: RagOperationalSloInput): readonly SloRule[] {
  const rules: SloRule[] = [];

  if (input.evalBenchmark) {
    rules.push(
      {
        id: "eval_passed",
        name: "Eval benchmark passed",
        category: "eval_quality",
        severity: "critical",
        signalName: "eval.passed",
        comparator: "eq",
        threshold: true,
        description: "Golden and adversarial eval suites must pass before release.",
        runbook: runbook(
          "Triage eval failure",
          "The RAG quality gate failed on the current benchmark artifact.",
          [
            "Open .rag/eval-runs/latest/report.html and identify failing cases.",
            "Inspect the linked trace for retrieval, grounding, refusal, or citation regressions.",
            "Update code or fixtures only after confirming the expected behavior."
          ],
          "Escalate to the owning project team when a profile-specific policy decision is needed."
        )
      },
      {
        id: "eval_failed_case_count",
        name: "No failed eval cases",
        category: "eval_quality",
        severity: "critical",
        signalName: "eval.failedCaseCount",
        comparator: "lte",
        threshold: 0,
        description: "No benchmark case may fail silently.",
        runbook: runbook(
          "Resolve failed eval cases",
          "At least one benchmark case failed.",
          [
            "Review failures in .rag/eval-runs/latest/summary.json.",
            "Replay the failing trace and compare retrieved source IDs.",
            "Add a regression case if the failure exposed an uncovered boundary."
          ],
          "Escalate if the failure changes the expected answer contract."
        )
      },
      {
        id: "eval_pass_rate",
        name: "Eval pass rate is complete",
        category: "eval_quality",
        severity: "high",
        signalName: "eval.passRate",
        comparator: "gte",
        threshold: 1,
        description: "The portable skeleton keeps a zero-known-regression quality bar.",
        runbook: runbook(
          "Restore eval pass rate",
          "The aggregate pass rate dropped below 100%.",
          [
            "Sort failures by profile and check kind.",
            "Compare current benchmark.json to profiles/eval-baseline.json.",
            "Patch the responsible retrieval, context, generation, or policy layer."
          ],
          "Escalate when baseline expectations are stale rather than code behavior."
        )
      },
      {
        id: "eval_case_count",
        name: "Eval benchmark has cases",
        category: "eval_quality",
        severity: "high",
        signalName: "eval.caseCount",
        comparator: "gte",
        threshold: 1,
        description: "An empty benchmark is a false green release gate.",
        runbook: runbook(
          "Restore eval coverage",
          "The benchmark artifact has no cases.",
          [
            "Confirm profile eval JSONL files exist.",
            "Run npm run evals and inspect loader errors.",
            "Block release until at least one golden or adversarial case is executed."
          ],
          "Escalate if a project profile intentionally has no eval fixtures yet."
        )
      }
    );
  }

  if (input.traceReplay) {
    rules.push(
      {
        id: "trace_replay_passed",
        name: "Trace replay passed",
        category: "trace_replay",
        severity: "critical",
        signalName: "traceReplay.passed",
        comparator: "eq",
        threshold: true,
        description: "A current answer run must replay against the benchmark trace shape.",
        runbook: runbook(
          "Triage trace replay drift",
          "Trace replay detected a behavioral or traceability mismatch.",
          [
            "Open .rag/trace-replay/latest/report.html.",
            "Compare baseline/current trace summaries for the first mismatch.",
            "Fix the changed layer or update the baseline only after review."
          ],
          "Escalate when the trace contract changed intentionally."
        )
      },
      {
        id: "trace_replay_mismatches",
        name: "No trace replay mismatches",
        category: "trace_replay",
        severity: "critical",
        signalName: "traceReplay.mismatchedCount",
        comparator: "lte",
        threshold: 0,
        description: "Replay mismatch means answer behavior or trace linkage changed.",
        runbook: runbook(
          "Resolve replay mismatch",
          "One or more eval cases no longer match the baseline run trace.",
          [
            "Inspect mismatched cases in replay.json.",
            "Check retrievedDocumentIds, contextStatus, citation counts, and trace events.",
            "Add a targeted unit test around the changed contract."
          ],
          "Escalate if the baseline trace is stale or incomplete."
        )
      },
      {
        id: "trace_replay_not_comparable",
        name: "Trace replay is comparable",
        category: "trace_replay",
        severity: "high",
        signalName: "traceReplay.notComparableCount",
        comparator: "lte",
        threshold: 0,
        description: "A non-comparable replay means trace artifacts are missing or malformed.",
        runbook: runbook(
          "Restore replay comparability",
          "Trace replay could not compare at least one case.",
          [
            "Confirm each answer() path emits exactly one linked trace.",
            "Check eval summary artifacts for traceId and trace body.",
            "Fix missing trace construction before debugging answer quality."
          ],
          "Escalate if the project disables trace capture for this profile."
        )
      }
    );
  }

  if (input.providerSmoke) {
    rules.push(
      {
        id: "provider_smoke_passed",
        name: "Provider smoke passed",
        category: "provider_health",
        severity: "critical",
        signalName: "providerSmoke.passed",
        comparator: "eq",
        threshold: true,
        description: "Required external providers must pass startup probes.",
        runbook: runbook(
          "Triage provider smoke failure",
          "At least one required provider probe failed.",
          [
            "Open .rag/provider-smoke/latest/report.html.",
            "Check provider IDs, model names, and missing secret env references.",
            "Do not paste secrets into reports or traces."
          ],
          "Escalate to the infrastructure owner if credentials or provider health are involved."
        )
      },
      {
        id: "provider_required_failures",
        name: "No required provider failures",
        category: "provider_health",
        severity: "critical",
        signalName: "providerSmoke.failedRequiredProviderCount",
        comparator: "lte",
        threshold: 0,
        description: "Required provider coverage must not fail.",
        runbook: runbook(
          "Restore required provider coverage",
          "A required model, embedding, rerank, or grounding provider did not pass.",
          [
            "Verify required provider modes in the runtime config.",
            "Check provider-specific probe messages in smoke.json.",
            "Rollback provider config changes if probes started failing after deployment."
          ],
          "Escalate if the vendor outage is outside project control."
        )
      },
      {
        id: "provider_probe_failures",
        name: "No provider probe check failures",
        category: "provider_health",
        severity: "high",
        signalName: "providerSmoke.failedProviderProbeCheckCount",
        comparator: "lte",
        threshold: 0,
        description:
          "Provider probe checks should not fail even when optional providers are configured.",
        runbook: runbook(
          "Resolve provider probe failures",
          "One or more provider probe checks failed.",
          [
            "Inspect failed check IDs in provider-smoke/latest/smoke.json.",
            "Confirm optional provider modes are intentionally optional.",
            "Add a deployment note if an optional provider is intentionally skipped."
          ],
          "Escalate if optional provider failures affect a project feature path."
        )
      }
    );
  }

  if (input.httpMetrics) {
    rules.push(
      {
        id: "http_ready",
        name: "HTTP service is ready",
        category: "readiness",
        severity: "high",
        signalName: "http.ready",
        comparator: "eq",
        threshold: true,
        description: "The production HTTP service must be ready before accepting traffic.",
        runbook: runbook(
          "Restore HTTP readiness",
          "The HTTP runtime reported not-ready.",
          [
            "Check /ready and lifecycle logs for draining state.",
            "Inspect recent startup self-test and provider smoke artifacts.",
            "Keep the instance out of rotation until readiness is restored."
          ],
          "Escalate to the service owner if readiness flaps across restarts."
        )
      },
      {
        id: "http_not_draining",
        name: "HTTP service is not draining",
        category: "readiness",
        severity: "warning",
        signalName: "http.draining",
        comparator: "eq",
        threshold: false,
        description: "Draining is visible as a warning because planned rollouts can trigger it.",
        runbook: runbook(
          "Review draining runtime",
          "The HTTP runtime is draining.",
          [
            "Confirm this is an intentional rollout or shutdown.",
            "Check activeRequests before terminating the instance.",
            "Investigate if the service remains draining after rollout completion."
          ],
          "Escalate only if draining is unexpected or persistent."
        )
      },
      {
        id: "http_server_errors",
        name: "No HTTP server errors",
        category: "http_edge",
        severity: "critical",
        signalName: "http.serverErrors",
        comparator: "lte",
        threshold: 0,
        description: "5xx responses are release-blocking for the production edge.",
        runbook: runbook(
          "Triage HTTP server errors",
          "The HTTP runtime returned at least one server error.",
          [
            "Check structured HTTP logs by requestId.",
            "Follow the linked runId or traceId when the error came from answer().",
            "Rollback the latest runtime/config change if errors are new."
          ],
          "Escalate to on-call for repeated 5xx errors."
        )
      },
      {
        id: "http_answer_failures",
        name: "No answer failures",
        category: "http_edge",
        severity: "high",
        signalName: "http.answerFailed",
        comparator: "lte",
        threshold: 0,
        description: "answer() failures at the edge indicate runtime or dependency breakage.",
        runbook: runbook(
          "Resolve answer failures",
          "The production answer endpoint failed at least once.",
          [
            "Find failed answer outcomes in /metrics and HTTP logs.",
            "Open the linked trace if one was emitted.",
            "Run evals and provider smoke locally against the same profile config."
          ],
          "Escalate when failures depend on external provider availability."
        )
      },
      {
        id: "http_request_errors",
        name: "No malformed request errors",
        category: "http_edge",
        severity: "warning",
        signalName: "http.requestErrors",
        comparator: "lte",
        threshold: 0,
        description: "Malformed requests are non-blocking but useful for client integration drift.",
        runbook: runbook(
          "Review request errors",
          "The edge rejected at least one malformed request.",
          [
            "Check client payload shape and content-type.",
            "Confirm errors are not caused by a released SDK change.",
            "Add request validation examples to project integration docs if repeated."
          ],
          "Escalate only when trusted clients are affected."
        )
      },
      {
        id: "http_rate_limited",
        name: "No rate-limited requests",
        category: "http_edge",
        severity: "warning",
        signalName: "http.rateLimited",
        comparator: "lte",
        threshold: 0,
        description: "Rate limiting is non-blocking but can reveal abuse or quota pressure.",
        runbook: runbook(
          "Review rate limiting",
          "The edge rate-limited at least one request.",
          [
            "Confirm the client identity and request volume.",
            "Check whether rate limit thresholds fit the profile traffic pattern.",
            "Preserve rate limit logs for abuse investigation if needed."
          ],
          "Escalate if trusted production traffic is being throttled."
        )
      },
      {
        id: "http_latency_p95",
        name: "HTTP p95 latency stays below budget",
        category: "http_edge",
        severity: "warning",
        signalName: "http.latencyMs.p95",
        comparator: "lte",
        threshold: 30000,
        description:
          "Sustained high edge latency can hide provider, retrieval, or storage pressure.",
        runbook: runbook(
          "Review HTTP latency",
          "The HTTP p95 latency exceeded the operational budget.",
          [
            "Compare /metrics route latency summaries for answer versus health/readiness.",
            "Check provider smoke and storage readiness for slow dependencies.",
            "Inspect recent answer traces for retrieval and generation stage duration changes."
          ],
          "Escalate when latency affects production users or coincides with provider errors."
        )
      },
      {
        id: "rag_low_citation_answers",
        name: "No low-citation answers",
        category: "rag_quality",
        severity: "high",
        signalName: "rag.lowCitationAnswerCount",
        comparator: "lte",
        threshold: 0,
        description: "Answers without citations indicate grounding or response-shaping drift.",
        runbook: runbook(
          "Review low-citation answers",
          "At least one answer completed without final citations.",
          [
            "Inspect linked answer traces for context evidence and generation status.",
            "Check whether retrieval returned chunks but citation resolution failed.",
            "Add a regression case for the profile if this was not an expected refusal."
          ],
          "Escalate when citation loss affects customer-visible answers."
        )
      },
      {
        id: "rag_no_evidence_answers",
        name: "No no-evidence answer attempts",
        category: "rag_quality",
        severity: "warning",
        signalName: "rag.noEvidenceAnswerCount",
        comparator: "lte",
        threshold: 0,
        description:
          "No-evidence answers show retrieval coverage, source freshness, or query routing gaps.",
        runbook: runbook(
          "Review no-evidence answers",
          "The context builder reported no evidence for at least one answer request.",
          [
            "Check retrieval returned count and rejected retrieval count in /metrics.",
            "Inspect source sync freshness and index coverage for the affected profile.",
            "Decide whether to improve ingestion, retrieval, or refusal copy."
          ],
          "Escalate if no-evidence answers spike for a production workflow."
        )
      },
      {
        id: "rag_human_review_required",
        name: "No human-review spike",
        category: "rag_quality",
        severity: "warning",
        signalName: "rag.humanReviewRequiredCount",
        comparator: "lte",
        threshold: 0,
        description: "Human-review volume is expected in some workflows but should be visible.",
        runbook: runbook(
          "Review human-review volume",
          "At least one answer required human review.",
          [
            "Check review queue artifacts for routing and profile escalation metadata.",
            "Inspect whether warnings came from evidence, model, grounding judge, or budgets.",
            "Tune profile policy only after confirming the risk boundary."
          ],
          "Escalate to the owning workflow team when review volume affects operations."
        )
      },
      {
        id: "rag_model_latency_p95",
        name: "Model p95 latency stays below budget",
        category: "provider_health",
        severity: "warning",
        signalName: "rag.modelLatencyMs.p95",
        comparator: "lte",
        threshold: 30000,
        description:
          "High model latency usually points to provider, network, or prompt-size pressure.",
        runbook: runbook(
          "Review model latency",
          "The model p95 latency exceeded the operational budget.",
          [
            "Compare model latency to overall HTTP latency to isolate provider time.",
            "Check provider smoke and provider status.",
            "Inspect prompt/context token counts and retrieval candidate volumes."
          ],
          "Escalate when model latency causes user-visible timeouts."
        )
      }
    );
  }

  return rules;
}

function signal(
  name: string,
  value: SloSignalValue,
  unit?: string,
  labels?: Readonly<Record<string, string>>
): SloSignal {
  return {
    name,
    value,
    ...(unit === undefined ? {} : { unit }),
    ...(labels === undefined ? {} : { labels })
  };
}

function runbook(
  title: string,
  summary: string,
  immediateActions: readonly string[],
  escalation: string
): SloRunbook {
  return {
    title,
    summary,
    immediateActions,
    escalation
  };
}
