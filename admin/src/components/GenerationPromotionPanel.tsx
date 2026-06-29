"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Play, Save, Search, ShieldCheck } from "lucide-react";
import type React from "react";
import { EmptyState, MetricCard, StatusPill } from "@/components/ui";
import { formatNumber, formatTime, statusTone, truncateMiddle } from "@/lib/format";
import type {
  AdminGenerationPromotionPlanResult,
  AdminGenerationPromotionRecord,
  AdminIndexGenerationListResult,
  AdminIndexGenerationManifest,
  Availability
} from "@/lib/rag-admin-api";

type PromotionAction = "dry_run" | "save_plan" | "record_eval" | "inspect" | "promote";

interface PromotionActionResponse<T> {
  readonly status?: string;
  readonly data?: T;
  readonly error?: string | { readonly name?: string; readonly message?: string };
  readonly command?: readonly string[];
}

export function GenerationPromotionPanel({
  generationsResult
}: {
  readonly generationsResult: Availability<AdminIndexGenerationListResult>;
}) {
  const router = useRouter();
  const generations = useMemo(
    () => generationsResult.data?.manifests ?? [],
    [generationsResult.data?.manifests]
  );
  const candidates = generations.filter((generation) => generation.status === "candidate");
  const activeCount = generations.filter((generation) => generation.status === "active").length;
  const selectedInitialId = candidates[0]?.generationId ?? generations[0]?.generationId ?? "";
  const [selectedGenerationId, setSelectedGenerationId] = useState(selectedInitialId);
  const selectedGeneration = generations.find(
    (generation) => generation.generationId === selectedGenerationId
  );
  const activeGeneration = selectedGeneration
    ? activeGenerationFor(generations, selectedGeneration)
    : undefined;
  const suggestedPromotionId = selectedGeneration
    ? suggestedPromotionIdFor(selectedGeneration)
    : "";
  const [promotionId, setPromotionId] = useState(suggestedPromotionId);
  const [requiredEvalIds, setRequiredEvalIds] = useState("retrieval_regression,citation_gate");
  const [archivePrevious, setArchivePrevious] = useState(true);
  const [replace, setReplace] = useState(false);
  const [evalId, setEvalId] = useState("retrieval_regression");
  const [evalStatus, setEvalStatus] = useState<"passed" | "failed">("passed");
  const [reportUri, setReportUri] = useState("");
  const [summary, setSummary] = useState("");
  const [busyAction, setBusyAction] = useState<PromotionAction | undefined>();
  const [message, setMessage] = useState<{
    readonly tone: "success" | "error";
    readonly text: string;
  }>();
  const [lastResult, setLastResult] = useState<unknown>();
  const loadedPromotion = promotionRecordFromResult(lastResult);
  const promoteBlock = promotionBlockReason(promotionId, loadedPromotion);

  useEffect(() => {
    setSelectedGenerationId(selectedInitialId);
  }, [selectedInitialId]);

  useEffect(() => {
    setPromotionId(suggestedPromotionId);
  }, [suggestedPromotionId]);

  async function runPlan(dryRun: boolean) {
    if (!selectedGeneration) {
      setMessage({ tone: "error", text: "Select a candidate generation first." });
      return;
    }
    if (selectedGeneration.status !== "candidate") {
      setMessage({
        tone: "error",
        text: "Only candidate generations can be planned for promotion."
      });
      return;
    }

    setBusyAction(dryRun ? "dry_run" : "save_plan");
    setMessage(undefined);
    setLastResult(undefined);
    try {
      const result = await postPromotionAction<AdminGenerationPromotionPlanResult>({
        action: "plan",
        promotionId,
        tenantId: selectedGeneration.tenantId,
        namespaceId: selectedGeneration.namespaceId,
        profileId: selectedGeneration.profileId,
        generationId: selectedGeneration.generationId,
        ...(activeGeneration === undefined
          ? {}
          : { activeGenerationId: activeGeneration.generationId }),
        embeddingProvider: selectedGeneration.embeddingProvider,
        embeddingModel: selectedGeneration.embeddingModel,
        embeddingDimensions: selectedGeneration.embeddingDimensions,
        embeddingConfigHash: selectedGeneration.embeddingConfigHash,
        embeddingIndexConfigHash: selectedGeneration.embeddingIndexConfigHash,
        chunkingPolicyId: selectedGeneration.chunkingPolicyId,
        chunkingPolicyVersion: selectedGeneration.chunkingPolicyVersion,
        ...(selectedGeneration.chunkerVersion === undefined
          ? {}
          : { chunkerVersion: selectedGeneration.chunkerVersion }),
        requiredEvalIds: commaList(requiredEvalIds),
        archivePrevious,
        dryRun,
        replace,
        ...(reportUri.trim() ? { evalReportUri: reportUri.trim() } : {})
      });
      setLastResult(result.data ?? result);
      setMessage({
        tone: "success",
        text: dryRun
          ? "Promotion plan dry-run completed."
          : `Promotion plan saved for ${promotionId}.`
      });
      if (!dryRun) router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error, "Generation promotion plan failed.") });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function recordEval() {
    setBusyAction("record_eval");
    setMessage(undefined);
    setLastResult(undefined);
    try {
      const result = await postPromotionAction<AdminGenerationPromotionRecord>({
        action: "record_eval",
        promotionId,
        evalId,
        evalStatus,
        ...(reportUri.trim() ? { reportUri: reportUri.trim() } : {}),
        ...(summary.trim() ? { summary: summary.trim() } : {})
      });
      setLastResult(result.data ?? result);
      setMessage({ tone: "success", text: `Recorded ${evalStatus} for ${evalId}.` });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error, "Eval result update failed.") });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function inspectPromotion() {
    setBusyAction("inspect");
    setMessage(undefined);
    setLastResult(undefined);
    try {
      const response = await fetch(
        `/api/rag/generation-promotions/${encodeURIComponent(promotionId)}`,
        { method: "GET" }
      );
      const result = (await response
        .json()
        .catch(() => ({}))) as PromotionActionResponse<AdminGenerationPromotionRecord>;
      if (!response.ok) throw new Error(responseError(result) ?? "Promotion inspect failed.");
      setLastResult(result.data ?? result);
      setMessage({ tone: "success", text: `Loaded promotion ${promotionId}.` });
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error, "Promotion inspect failed.") });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function promote() {
    const confirmed = window.confirm(
      `Promote generation using promotion ${promotionId}? This switches the active generation for its tenant and namespace.`
    );
    if (!confirmed) return;

    setBusyAction("promote");
    setMessage(undefined);
    setLastResult(undefined);
    try {
      const result = await postPromotionAction<AdminGenerationPromotionRecord>({
        action: "promote",
        promotionId
      });
      setLastResult(result.data ?? result);
      setMessage({ tone: "success", text: `Promoted generation for ${promotionId}.` });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error, "Generation promotion failed.") });
    } finally {
      setBusyAction(undefined);
    }
  }

  if (generationsResult.status === "unavailable") {
    return (
      <EmptyState
        title="Index generation metadata is unavailable"
        detail={
          generationsResult.error ??
          "Configure the durable index generation store before promotion controls appear."
        }
        actionHref="/storage"
        actionLabel="Open Storage"
      />
    );
  }

  if (generations.length === 0) {
    return (
      <EmptyState
        title="No index generations found"
        detail="Run a reindex plan or generation-aware ingestion job, then candidate and active generations will appear here."
        actionHref="/ingestion"
        actionLabel="Open Add Knowledge"
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard label="Generations" value={formatNumber(generations.length)} tone="primary" />
        <MetricCard label="Candidates" value={formatNumber(candidates.length)} />
        <MetricCard label="Active" value={formatNumber(activeCount)} tone="success" />
        <MetricCard label="Scope" value={selectedGeneration?.tenantId ?? "n/a"} />
        <MetricCard label="Namespace" value={selectedGeneration?.namespaceId ?? "n/a"} />
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead className="border-b border-card text-xs uppercase tracking-[0.08em] text-text-muted">
              <tr>
                <th className="px-2 py-2 font-medium">Generation</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2 font-medium">Scope</th>
                <th className="px-2 py-2 font-medium">Embedding</th>
                <th className="px-2 py-2 font-medium">Chunking</th>
                <th className="px-2 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-card">
              {generations.map((generation) => {
                const selected = generation.generationId === selectedGenerationId;
                return (
                  <tr
                    key={generation.generationId}
                    className={selected ? "bg-primary/5" : "hover:bg-card/50"}
                  >
                    <td className="px-2 py-3">
                      <button
                        type="button"
                        onClick={() => setSelectedGenerationId(generation.generationId)}
                        className="text-left font-medium text-text-primary hover:text-primary"
                      >
                        {truncateMiddle(generation.generationId, 44)}
                      </button>
                      <div className="text-xs text-text-muted">
                        {truncateMiddle(generation.embeddingConfigHash, 56)}
                      </div>
                    </td>
                    <td className="px-2 py-3">
                      <StatusPill label={generation.status} tone={statusTone(generation.status)} />
                    </td>
                    <td className="px-2 py-3">
                      <div className="text-text-secondary">{generation.tenantId}</div>
                      <div className="text-xs text-text-muted">{generation.namespaceId}</div>
                    </td>
                    <td className="px-2 py-3 text-text-secondary">
                      <div>{generation.embeddingProvider}</div>
                      <div className="text-xs text-text-muted">
                        {generation.embeddingModel} · {generation.embeddingDimensions}
                      </div>
                    </td>
                    <td className="px-2 py-3 text-text-secondary">
                      <div>{generation.chunkingPolicyId}</div>
                      <div className="text-xs text-text-muted">
                        v{generation.chunkingPolicyVersion}
                        {generation.chunkerVersion ? ` · ${generation.chunkerVersion}` : ""}
                      </div>
                    </td>
                    <td className="px-2 py-3 text-text-muted">
                      {formatTime(generation.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted">
              Candidate
            </span>
            <select
              value={selectedGenerationId}
              onChange={(event) => setSelectedGenerationId(event.target.value)}
              className="h-10 w-full rounded-lg border border-card bg-background px-2 text-sm text-text-primary outline-none focus:border-primary/50"
            >
              {generations.map((generation) => (
                <option key={generation.generationId} value={generation.generationId}>
                  {generation.status} · {generation.generationId}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted">
              Promotion ID
            </span>
            <input
              value={promotionId}
              onChange={(event) => setPromotionId(event.target.value)}
              className="h-10 w-full rounded-lg border border-card bg-background px-2 text-sm text-text-primary outline-none focus:border-primary/50"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted">
              Required eval IDs
            </span>
            <input
              value={requiredEvalIds}
              onChange={(event) => setRequiredEvalIds(event.target.value)}
              className="h-10 w-full rounded-lg border border-card bg-background px-2 text-sm text-text-primary outline-none focus:border-primary/50"
              placeholder="retrieval_regression,citation_gate"
            />
          </label>

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex min-h-10 items-center gap-2 rounded-lg border border-card bg-background px-2 text-xs text-text-secondary">
              <input
                type="checkbox"
                checked={archivePrevious}
                onChange={(event) => setArchivePrevious(event.target.checked)}
              />
              Archive previous
            </label>
            <label className="flex min-h-10 items-center gap-2 rounded-lg border border-card bg-background px-2 text-xs text-text-secondary">
              <input
                type="checkbox"
                checked={replace}
                onChange={(event) => setReplace(event.target.checked)}
              />
              Replace plan
            </label>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted">
                Eval ID
              </span>
              <input
                value={evalId}
                onChange={(event) => setEvalId(event.target.value)}
                className="h-10 w-full rounded-lg border border-card bg-background px-2 text-sm text-text-primary outline-none focus:border-primary/50"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted">
                Eval status
              </span>
              <select
                value={evalStatus}
                onChange={(event) =>
                  setEvalStatus(event.target.value === "failed" ? "failed" : "passed")
                }
                className="h-10 w-full rounded-lg border border-card bg-background px-2 text-sm text-text-primary outline-none focus:border-primary/50"
              >
                <option value="passed">passed</option>
                <option value="failed">failed</option>
              </select>
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted">
              Report URI
            </span>
            <input
              value={reportUri}
              onChange={(event) => setReportUri(event.target.value)}
              className="h-10 w-full rounded-lg border border-card bg-background px-2 text-sm text-text-primary outline-none focus:border-primary/50"
              placeholder=".rag/eval-runs/latest/summary.json"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted">
              Eval summary
            </span>
            <textarea
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              rows={2}
              className="w-full resize-y rounded-lg border border-card bg-background px-2 py-1.5 text-sm text-text-primary outline-none focus:border-primary/50"
              placeholder="Gate result, ticket, or release note"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <ActionButton
              action="dry_run"
              label="Dry Run"
              title="Preview the promotion plan"
              busyAction={busyAction}
              disabled={!selectedGeneration || selectedGeneration.status !== "candidate"}
              onClick={() => void runPlan(true)}
              icon={<Play className="h-3.5 w-3.5" aria-hidden="true" />}
            />
            <ActionButton
              action="save_plan"
              label="Save Plan"
              title="Persist the promotion plan"
              busyAction={busyAction}
              disabled={!selectedGeneration || selectedGeneration.status !== "candidate"}
              onClick={() => void runPlan(false)}
              icon={<Save className="h-3.5 w-3.5" aria-hidden="true" />}
            />
            <ActionButton
              action="record_eval"
              label="Record Eval"
              title="Attach an eval gate result"
              busyAction={busyAction}
              disabled={!promotionId.trim() || !evalId.trim()}
              onClick={() => void recordEval()}
              icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
            />
            <ActionButton
              action="inspect"
              label="Inspect"
              title="Load a saved promotion"
              busyAction={busyAction}
              disabled={!promotionId.trim()}
              onClick={() => void inspectPromotion()}
              icon={<Search className="h-3.5 w-3.5" aria-hidden="true" />}
            />
            <ActionButton
              action="promote"
              label="Promote"
              title={promoteBlock ?? "Switch the active generation after required evals pass"}
              busyAction={busyAction}
              disabled={promoteBlock !== undefined}
              onClick={() => void promote()}
              icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />}
              danger
            />
          </div>

          {promoteBlock ? (
            <div className="rounded-lg border border-warning/20 bg-warning/10 p-2 text-xs leading-5 text-warning">
              {promoteBlock}
            </div>
          ) : null}

          {activeGeneration ? (
            <div className="text-xs leading-5 text-text-muted">
              Active baseline: {truncateMiddle(activeGeneration.generationId, 44)}
            </div>
          ) : null}
          {message ? (
            <div
              className={message.tone === "success" ? "text-xs text-success" : "text-xs text-error"}
            >
              {message.text}
            </div>
          ) : null}
        </div>
      </div>

      {lastResult ? (
        <pre className="max-h-72 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg border border-card bg-card/40 p-3 text-xs leading-5 text-text-secondary">
          {JSON.stringify(lastResult, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

function ActionButton({
  action,
  label,
  title,
  busyAction,
  disabled,
  icon,
  danger = false,
  onClick
}: {
  readonly action: PromotionAction;
  readonly label: string;
  readonly title: string;
  readonly busyAction: PromotionAction | undefined;
  readonly disabled: boolean;
  readonly icon: React.ReactNode;
  readonly danger?: boolean;
  readonly onClick: () => void;
}) {
  const busy = busyAction === action;
  return (
    <button
      type="button"
      title={title}
      disabled={disabled || busyAction !== undefined}
      onClick={onClick}
      className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        danger
          ? "border-error/20 text-error hover:border-error/40 hover:bg-error/10"
          : "border-card text-text-secondary hover:border-primary/30 hover:text-text-primary"
      }`}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : icon}
      {label}
    </button>
  );
}

async function postPromotionAction<T>(
  body: Readonly<Record<string, unknown>>
): Promise<PromotionActionResponse<T>> {
  const response = await fetch("/api/rag/generation-promotions/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = (await response.json().catch(() => ({}))) as PromotionActionResponse<T>;
  if (!response.ok) {
    throw new Error(
      responseError(result) ?? `Generation promotion action failed with ${response.status}.`
    );
  }
  return result;
}

function responseError(response: PromotionActionResponse<unknown>): string | undefined {
  if (typeof response.error === "string") return response.error;
  if (response.error?.message) {
    return response.error.name
      ? `${response.error.name}: ${response.error.message}`
      : response.error.message;
  }
  return undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function commaList(value: string): readonly string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function promotionRecordFromResult(value: unknown): AdminGenerationPromotionRecord | undefined {
  if (isPromotionRecord(value)) return value;
  if (typeof value !== "object" || value === null || !("promotion" in value)) return undefined;
  const promotion = (value as { readonly promotion?: unknown }).promotion;
  return isPromotionRecord(promotion) ? promotion : undefined;
}

function isPromotionRecord(value: unknown): value is AdminGenerationPromotionRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AdminGenerationPromotionRecord>;
  return (
    typeof candidate.promotionId === "string" &&
    typeof candidate.status === "string" &&
    Array.isArray(candidate.requiredEvalIds) &&
    Array.isArray(candidate.evalResults)
  );
}

function promotionBlockReason(
  promotionId: string,
  promotion: AdminGenerationPromotionRecord | undefined
): string | undefined {
  const trimmedPromotionId = promotionId.trim();
  if (!trimmedPromotionId) return "Enter a promotion ID before promotion.";
  if (!promotion || promotion.promotionId !== trimmedPromotionId) {
    return "Inspect the saved promotion or record eval results before promoting.";
  }
  if (promotion.status === "ready") return undefined;

  const resultById = new Map(promotion.evalResults.map((result) => [result.evalId, result]));
  const failed = promotion.requiredEvalIds.filter(
    (evalId) => resultById.get(evalId)?.status === "failed"
  );
  if (failed.length > 0) {
    return `Promotion is blocked by failed evals: ${failed.join(", ")}.`;
  }

  const missing = promotion.requiredEvalIds.filter(
    (evalId) => resultById.get(evalId)?.status !== "passed"
  );
  if (missing.length > 0) {
    return `Promotion is blocked until required evals pass: ${missing.join(", ")}.`;
  }

  return `Promotion status is ${promotion.status}; inspect the saved plan before promoting.`;
}

function activeGenerationFor(
  generations: readonly AdminIndexGenerationManifest[],
  selected: AdminIndexGenerationManifest
): AdminIndexGenerationManifest | undefined {
  return generations.find(
    (generation) =>
      generation.status === "active" &&
      generation.tenantId === selected.tenantId &&
      generation.namespaceId === selected.namespaceId
  );
}

function suggestedPromotionIdFor(generation: AdminIndexGenerationManifest): string {
  return [
    "promotion",
    safeIdPart(generation.tenantId),
    safeIdPart(generation.namespaceId),
    safeIdPart(generation.generationId).slice(0, 24)
  ]
    .filter(Boolean)
    .join("-");
}

function safeIdPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
