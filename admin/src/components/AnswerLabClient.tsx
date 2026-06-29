"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Send } from "lucide-react";
import { AnswerLabResultTabs } from "@/components/AnswerLabResultTabs";
import { EmptyState, ErrorBanner, MetricCard, SectionCard, StatusPill } from "@/components/ui";
import type {
  AdminAnswerRequest,
  AdminAnswerResponse,
  AdminAnswerError
} from "@/lib/rag-answer-types";
import { statusTone } from "@/lib/format";

interface OverviewShape {
  readonly status?: string;
  readonly errors?: readonly string[];
  readonly ready?: {
    readonly ready?: boolean;
    readonly status?: string;
  };
  readonly health?: {
    readonly namespaceId?: string;
    readonly profileId?: string;
    readonly status?: string;
    readonly index?: {
      readonly documentCount?: number;
      readonly chunkCount?: number;
    };
  };
}

interface SourceInventoryShape {
  readonly sources?: readonly SourceOption[];
}

interface SourceOption {
  readonly sourceId: string;
  readonly sourceKind?: string;
  readonly tenantId?: string;
  readonly namespaceId?: string;
}

export interface AnswerLabReadiness {
  readonly serviceReady: boolean;
  readonly hasKnowledge: boolean;
  readonly profileId?: string;
  readonly namespaceId?: string;
  readonly documentCount?: number;
  readonly chunkCount?: number;
  readonly error?: string;
}

export function AnswerLabClient({
  initialReadiness
}: {
  readonly initialReadiness: AnswerLabReadiness;
}) {
  const [question, setQuestion] = useState("What does the policy say?");
  const [tenantId, setTenantId] = useState("tenant_1");
  const [namespaceId, setNamespaceId] = useState("generic-docs");
  const [userId, setUserId] = useState("admin_operator");
  const [namespaceIds, setNamespaceIds] = useState("generic-docs");
  const [roles, setRoles] = useState("reader");
  const [tags, setTags] = useState("");
  const [sourceIds, setSourceIds] = useState("");
  const [topK, setTopK] = useState("6");
  const [candidatePoolLimit, setCandidatePoolLimit] = useState("24");
  const [includeRejected, setIncludeRejected] = useState(true);
  const [sourceOptions, setSourceOptions] = useState<readonly SourceOption[]>([]);
  const [readiness, setReadiness] = useState<AnswerLabReadiness>(initialReadiness);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AdminAnswerResponse | null>(null);
  const answerBlock = answerBlockReason(readiness);

  useEffect(() => {
    let cancelled = false;
    async function loadDefaults() {
      try {
        const response = await fetch("/api/rag/overview", { cache: "no-store" });
        if (!response.ok) return;
        const overview = (await response.json()) as OverviewShape;
        const nextNamespace = overview.health?.namespaceId;
        const nextReadiness = answerReadinessFromOverview(overview);
        if (!cancelled && nextNamespace) {
          setNamespaceId(nextNamespace);
          setNamespaceIds(nextNamespace);
        }
        if (!cancelled) setReadiness(nextReadiness);
      } catch {
        // Server-rendered readiness remains the source of truth when refresh fails.
      }
    }
    void loadDefaults();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadSources() {
      try {
        const response = await fetch("/api/rag/source-inventory", { cache: "no-store" });
        if (!response.ok) return;
        const inventory = (await response.json()) as SourceInventoryShape;
        if (!cancelled) setSourceOptions(inventory.sources ?? []);
      } catch {
        // Raw source ID input remains available when inventory is offline.
      }
    }
    void loadSources();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submitAnswer() {
    setLoading(true);
    setError(null);
    try {
      const request = buildRequest({
        question,
        tenantId,
        namespaceId,
        userId,
        namespaceIds,
        roles,
        tags,
        sourceIds,
        topK,
        candidatePoolLimit,
        includeRejected
      });
      const response = await fetch("/api/rag/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request)
      });
      const json = (await response.json()) as AdminAnswerResponse | AdminAnswerError;
      if (!response.ok || "error" in json) {
        throw new Error("error" in json ? json.error.message : "Answer request failed.");
      }

      setResult(json);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Answer request failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
      <div className="space-y-4">
        <SectionCard
          title={answerBlock ? "Answer Testing Locked" : "Ask a Test Question"}
          description={
            answerBlock
              ? "Question controls appear after the live service has indexed knowledge to retrieve from."
              : "Start with the question. The RAG service scope is filled in for you unless you need to test permissions or retrieval tuning."
          }
        >
          <div className="space-y-3">
            {answerBlock ? (
              <EmptyState
                title={answerBlock.title}
                detail={answerBlock.detail}
                actionHref={answerBlock.actionHref}
                actionLabel={answerBlock.actionLabel}
              />
            ) : (
              <>
                <Field
                  label="Question"
                  hint="Use the same wording a user or support operator would ask."
                >
                  <textarea
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    className="min-h-28 w-full rounded-lg border border-card bg-background px-3 py-2 text-sm"
                  />
                </Field>

                <SourceFilterField
                  value={sourceIds}
                  options={sourceOptions}
                  onChange={(nextSourceIds, selectedSource) => {
                    setSourceIds(nextSourceIds);
                    if (selectedSource?.tenantId) setTenantId(selectedSource.tenantId);
                    if (selectedSource?.namespaceId) {
                      setNamespaceId(selectedSource.namespaceId);
                      setNamespaceIds(selectedSource.namespaceId);
                    }
                  }}
                />

                <div className="grid gap-2 sm:grid-cols-3">
                  <ScopeFact label="Tenant" value={tenantId} />
                  <ScopeFact label="Namespace" value={namespaceId} />
                  <ScopeFact label="Role" value={roles || "none"} />
                </div>

                <button
                  onClick={submitAnswer}
                  disabled={loading || !question.trim()}
                  title="Run the scoped answer request"
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-text-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {loading ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  Run Answer
                </button>

                <details className="rounded-lg border border-card bg-background p-3">
                  <summary className="cursor-pointer text-sm font-medium text-text-secondary">
                    Advanced scope and retrieval controls
                  </summary>
                  <div className="mt-3 space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Tenant">
                        <input
                          value={tenantId}
                          onChange={(event) => setTenantId(event.target.value)}
                          className="w-full rounded-lg border border-card bg-surface px-3 py-2 text-sm"
                        />
                      </Field>
                      <Field label="Namespace">
                        <input
                          value={namespaceId}
                          onChange={(event) => {
                            setNamespaceId(event.target.value);
                            setNamespaceIds(event.target.value);
                          }}
                          className="w-full rounded-lg border border-card bg-surface px-3 py-2 text-sm"
                        />
                      </Field>
                    </div>
                    <Field label="User">
                      <input
                        value={userId}
                        onChange={(event) => setUserId(event.target.value)}
                        className="w-full rounded-lg border border-card bg-surface px-3 py-2 text-sm"
                      />
                    </Field>
                    <Field label="Principal namespaces">
                      <input
                        value={namespaceIds}
                        onChange={(event) => setNamespaceIds(event.target.value)}
                        className="w-full rounded-lg border border-card bg-surface px-3 py-2 text-sm"
                      />
                    </Field>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Roles">
                        <input
                          value={roles}
                          onChange={(event) => setRoles(event.target.value)}
                          className="w-full rounded-lg border border-card bg-surface px-3 py-2 text-sm"
                        />
                      </Field>
                      <Field label="Tags">
                        <input
                          value={tags}
                          onChange={(event) => setTags(event.target.value)}
                          className="w-full rounded-lg border border-card bg-surface px-3 py-2 text-sm"
                        />
                      </Field>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Top K">
                        <input
                          value={topK}
                          onChange={(event) => setTopK(event.target.value)}
                          className="w-full rounded-lg border border-card bg-surface px-3 py-2 text-sm"
                        />
                      </Field>
                      <Field label="Candidate pool">
                        <input
                          value={candidatePoolLimit}
                          onChange={(event) => setCandidatePoolLimit(event.target.value)}
                          className="w-full rounded-lg border border-card bg-surface px-3 py-2 text-sm"
                        />
                      </Field>
                    </div>
                    <label className="flex items-center gap-2 rounded-lg border border-card bg-surface px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        checked={includeRejected}
                        onChange={(event) => setIncludeRejected(event.target.checked)}
                      />
                      Include rejected evidence in safe trace
                    </label>
                  </div>
                </details>
              </>
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="Current Answer Preconditions"
          description="A test answer should only run against a live service with indexed knowledge."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <MetricCard
              label="RAG service"
              value={readiness.serviceReady ? "ready" : "blocked"}
              tone={readiness.serviceReady ? "success" : "error"}
            />
            <MetricCard
              label="Knowledge"
              value={
                readiness.hasKnowledge ? `${formatCount(readiness.documentCount)} docs` : "empty"
              }
              detail={`${formatCount(readiness.chunkCount)} chunks`}
              tone={readiness.hasKnowledge ? "success" : "warning"}
            />
            <MetricCard label="Profile" value={readiness.profileId ?? "n/a"} />
            <MetricCard label="Namespace" value={readiness.namespaceId ?? namespaceId} />
          </div>
        </SectionCard>
      </div>

      <div className="space-y-4">
        {error ? <ErrorBanner message={error} /> : null}
        {result ? (
          <>
            <div className="rounded-xl border border-card bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill label={result.status} tone={statusTone(result.status)} />
                <span className="text-sm text-text-muted">
                  Saved to durable redacted trace history.
                </span>
              </div>
            </div>
            <AnswerLabResultTabs result={result} />
          </>
        ) : (
          <EmptyState
            title="No answer run yet"
            detail="Run a scoped answer request. The safe response will populate answer, retrieval trace, citation, and rejected evidence tabs."
          />
        )}
      </div>
    </div>
  );
}

function SourceFilterField({
  value,
  options,
  onChange
}: {
  value: string;
  options: readonly SourceOption[];
  onChange: (value: string, selectedSource: SourceOption | undefined) => void;
}) {
  if (options.length === 0) {
    return (
      <Field label="Source filters">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value, undefined)}
          placeholder="optional comma-separated source ids"
          className="w-full rounded-lg border border-card bg-background px-3 py-2 text-sm"
        />
      </Field>
    );
  }

  return (
    <Field label="Source">
      <select
        value={value.includes(",") ? "" : value}
        onChange={(event) => {
          const nextValue = event.target.value;
          onChange(
            nextValue,
            options.find((option) => option.sourceId === nextValue)
          );
        }}
        className="w-full rounded-lg border border-card bg-background px-3 py-2 text-sm"
      >
        <option value="">All sources</option>
        {options.map((option) => (
          <option key={option.sourceId} value={option.sourceId}>
            {option.sourceId}
            {option.sourceKind ? ` (${option.sourceKind})` : ""}
          </option>
        ))}
      </select>
    </Field>
  );
}

function ScopeFact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-lg border border-card bg-background px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted">
        {label}
      </div>
      <div className="mt-1 truncate text-sm text-text-secondary">{value}</div>
    </div>
  );
}

function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs leading-5 text-text-muted">{hint}</span> : null}
    </label>
  );
}

function buildRequest(input: {
  question: string;
  tenantId: string;
  namespaceId: string;
  userId: string;
  namespaceIds: string;
  roles: string;
  tags: string;
  sourceIds: string;
  topK: string;
  candidatePoolLimit: string;
  includeRejected: boolean;
}): AdminAnswerRequest {
  const namespaceIds = parseList(input.namespaceIds);
  const sourceIds = parseList(input.sourceIds);
  const topK = positiveInteger(input.topK);
  const candidatePoolLimit = positiveInteger(input.candidatePoolLimit);

  return {
    question: input.question.trim(),
    tenantId: input.tenantId.trim(),
    namespaceId: input.namespaceId.trim(),
    principal: {
      userId: input.userId.trim(),
      tenantId: input.tenantId.trim(),
      namespaceIds: namespaceIds.length > 0 ? namespaceIds : [input.namespaceId.trim()],
      teamIds: [],
      roles: parseList(input.roles),
      tags: parseList(input.tags)
    },
    ...(sourceIds.length === 0 ? {} : { filters: { sourceIds } }),
    ...(topK === undefined ? {} : { topK }),
    ...(candidatePoolLimit === undefined ? {} : { candidatePoolLimit }),
    includeRejected: input.includeRejected
  };
}

function answerReadinessFromOverview(overview: OverviewShape): AnswerLabReadiness {
  const serviceReady = overview.ready?.ready === true || overview.health?.status === "ready";
  const documentCount = overview.health?.index?.documentCount ?? 0;
  const chunkCount = overview.health?.index?.chunkCount ?? 0;
  return {
    serviceReady,
    hasKnowledge: serviceReady && documentCount > 0 && chunkCount > 0,
    profileId: overview.health?.profileId,
    namespaceId: overview.health?.namespaceId,
    documentCount,
    chunkCount,
    error: overview.errors?.find((entry) => entry.trim())
  };
}

function answerBlockReason(readiness: AnswerLabReadiness):
  | {
      title: string;
      detail: string;
      actionHref: string;
      actionLabel: string;
    }
  | undefined {
  if (!readiness.serviceReady) {
    return {
      title: "Start the RAG service before running answers",
      detail:
        readiness.error ??
        "The answer path depends on the live RAG HTTP service. Saved artifacts can still be inspected while the service is offline.",
      actionHref: "/storage",
      actionLabel: "Open Storage"
    };
  }
  if (!readiness.hasKnowledge) {
    return {
      title: "Load knowledge before testing answers",
      detail:
        "The RAG service is online, but the index has no documents or chunks. Add files or sync a connector before judging answer quality.",
      actionHref: "/ingestion",
      actionLabel: "Add Knowledge"
    };
  }
  return undefined;
}

function formatCount(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "n/a";
}

function parseList(value: string): readonly string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveInteger(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
