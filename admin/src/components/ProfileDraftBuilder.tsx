"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Copy,
  Database,
  Download,
  FileJson,
  FlaskConical,
  Gauge,
  LockKeyhole,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Workflow
} from "lucide-react";
import { EmptyState, MetricCard, SectionCard, StatusPill } from "@/components/ui";
import {
  ANSWER_TRUST_TIER_OPTIONS,
  PROFILE_EXAMPLES,
  SOURCE_KIND_OPTIONS,
  TRUST_TIER_OPTIONS,
  buildGeneratedProfile,
  defaultProfileDraft,
  normalizeProfileDraft,
  profileDraftForExample,
  profileDraftIssues,
  profileFilePath,
  profileJson,
  slugValue,
  type ActionMode,
  type OutputMode,
  type ProfileExampleId,
  type ProfileDraft,
  type RerankMode,
  type RetrievalMode,
  type SourceKind,
  type TrustTier
} from "@/lib/profile-draft";

const STORAGE_KEY = "adaptable-rag.profile-draft.v2";

const OUTPUT_MODE_LABELS: Readonly<Record<OutputMode, string>> = {
  sourced_answer: "Standard sourced answer",
  support_triage: "Support triage draft",
  diligence_finding: "Diligence finding",
  code_investigation: "Code investigation"
};

const RETRIEVAL_MODE_LABELS: Readonly<Record<RetrievalMode, string>> = {
  keyword: "Keyword search",
  vector: "Vector search",
  hybrid: "Hybrid search",
  visual: "Visual search"
};

const RERANK_MODE_LABELS: Readonly<Record<RerankMode, string>> = {
  none: "No rerank",
  lightweight: "Light rerank",
  model: "Model rerank"
};

const TRUST_TIER_LABELS: Readonly<Record<TrustTier, string>> = {
  trusted_internal: "Trusted internal",
  verified_partner: "Verified partner",
  user_provided: "User provided",
  external_untrusted: "External untrusted",
  generated_or_derived: "Generated or derived",
  unknown: "Unknown"
};

const ACTION_MODE_LABELS: Readonly<Record<ActionMode, string>> = {
  answer_only: "No actions",
  draft_only: "Draft actions only",
  human_approval_required: "Draft with approval"
};

const SOURCE_KIND_LABELS: Readonly<Record<SourceKind, string>> = {
  repo_file: "Repo files",
  local_file: "Local files",
  database_row: "Database rows",
  support_ticket: "Support tickets",
  uploaded_file: "Uploaded files",
  web_page: "Web pages",
  api_response: "API responses",
  derived_summary: "Derived summaries"
};

function identitySlugFromName(value: string): string {
  const withoutProductSuffix = value.replace(/\brag\b/giu, "").trim();
  return slugValue(withoutProductSuffix) || slugValue(value);
}

export function ProfileDraftBuilder() {
  const [draft, setDraft] = useState<ProfileDraft>(() => defaultProfileDraft());
  const [message, setMessage] = useState<{
    readonly tone: "success" | "error";
    readonly text: string;
  }>();

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) setDraft(normalizeProfileDraft(JSON.parse(saved) as ProfileDraft));
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  }, [draft]);

  const profile = useMemo(() => buildGeneratedProfile(draft), [draft]);
  const issues = useMemo(() => profileDraftIssues(draft), [draft]);
  const json = useMemo(() => profileJson(profile), [profile]);
  const filePath = profileFilePath(profile.id);
  const errors = issues.filter((issue) => issue.tone === "error").length;
  const warnings = issues.filter((issue) => issue.tone === "warning").length;
  const identitySlug = identitySlugFromName(draft.name);
  const identityMode =
    draft.id === identitySlug && draft.namespaceId === identitySlug ? "auto" : "custom";

  function update<K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setMessage(undefined);
  }

  function updateMaxChunks(value: number) {
    const nextMaxChunks = boundedInteger(value, 1, 30);
    setDraft((current) => ({
      ...current,
      maxChunks: nextMaxChunks,
      maxContextChunks: Math.min(current.maxContextChunks, nextMaxChunks)
    }));
    setMessage(undefined);
  }

  function updateMaxContextChunks(value: number) {
    setDraft((current) => ({
      ...current,
      maxContextChunks: Math.min(boundedInteger(value, 1, 30), current.maxChunks)
    }));
    setMessage(undefined);
  }

  function updateMinimumCitedEvidence(value: number) {
    const nextMinimum = boundedInteger(value, 1, 10);
    setDraft((current) => ({
      ...current,
      minimumCitationsForAnswer: nextMinimum,
      minimumTrustedCitations: Math.min(current.minimumTrustedCitations, nextMinimum)
    }));
    setMessage(undefined);
  }

  function updateMinimumTrustedEvidence(value: number) {
    setDraft((current) => ({
      ...current,
      minimumTrustedCitations: Math.min(
        boundedInteger(value, 1, 10),
        current.minimumCitationsForAnswer
      )
    }));
    setMessage(undefined);
  }

  function updateName(value: string) {
    setDraft((current) => {
      const currentNameSlug = identitySlugFromName(current.name);
      const nextSlug = identitySlugFromName(value);
      const shouldSyncIdentity =
        !current.id ||
        !current.namespaceId ||
        (current.id === currentNameSlug && current.namespaceId === currentNameSlug);

      return {
        ...current,
        name: value,
        ...(shouldSyncIdentity && nextSlug
          ? {
              id: nextSlug,
              namespaceId: nextSlug
            }
          : {})
      };
    });
    setMessage(undefined);
  }

  function resetProfile() {
    setDraft(defaultProfileDraft());
    setMessage({ tone: "success", text: "Portable profile reset." });
  }

  function loadExample(exampleId: ProfileExampleId) {
    setDraft(profileDraftForExample(exampleId));
    setMessage({ tone: "success", text: "Example values loaded into the profile." });
  }

  async function copyJson() {
    try {
      await window.navigator.clipboard.writeText(json);
      setMessage({ tone: "success", text: "Profile JSON copied." });
    } catch {
      setMessage({ tone: "error", text: "Clipboard is unavailable in this browser." });
    }
  }

  function downloadJson() {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${profile.id}.profile.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage({ tone: "success", text: "Profile JSON downloaded." });
  }

  return (
    <SectionCard
      title="Configure RAG Profile"
      description="Configure one portable profile, check readiness, and export JSON for the RAG service."
      action={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <StatusPill
            label={errors ? "needs fixes" : warnings ? "review warnings" : "exportable"}
            tone={errors ? "error" : warnings ? "warning" : "success"}
          />
          <button
            type="button"
            onClick={resetProfile}
            aria-label="Reset to the portable RAG profile default"
            className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-card px-3 py-2 text-xs text-text-secondary hover:border-primary/30 hover:text-text-primary"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Reset profile
          </button>
        </div>
      }
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0 space-y-4">
          <ExampleLoader onSelect={loadExample} />

          <ProfileSection
            icon={FileJson}
            title="Profile Intent"
            detail="The identity and answer shape people should recognize."
          >
            <div className="grid gap-3 md:grid-cols-2">
              <DraftField label="Name" value={draft.name} onChange={updateName} />
              <SelectField
                label="Answer shape"
                value={draft.outputMode}
                options={[
                  "sourced_answer",
                  "support_triage",
                  "diligence_finding",
                  "code_investigation"
                ]}
                optionLabels={OUTPUT_MODE_LABELS}
                hint="Changes the generated output contract, not the profile type."
                onChange={(value) => update("outputMode", value as OutputMode)}
              />
              <TextAreaField
                label="Purpose"
                value={draft.purpose}
                hint="One sentence describing what this profile should answer from evidence."
                onChange={(value) => update("purpose", value)}
                className="md:col-span-2"
              />
            </div>

            <AdvancedIdentity
              profileId={draft.id}
              namespaceId={draft.namespaceId}
              mode={identityMode}
              onProfileIdChange={(value) => update("id", slugValue(value))}
              onNamespaceIdChange={(value) => update("namespaceId", slugValue(value))}
            />
          </ProfileSection>

          <ProfileSection
            icon={Database}
            title="Knowledge Scope"
            detail="The source identity, source trust, freshness window, and citable evidence types."
          >
            <div className="grid gap-3 md:grid-cols-3">
              <DraftField
                label="Knowledge source key"
                value={draft.sourceId}
                hint="Internal key assigned to evidence from this source."
                onChange={(value) => update("sourceId", slugValue(value))}
              />
              <SelectField
                label="Source trust floor"
                value={draft.sourceTrustTier}
                options={TRUST_TIER_OPTIONS}
                optionLabels={TRUST_TIER_LABELS}
                hint="Downgrades every record from this source when needed; it never upgrades weaker record trust."
                onChange={(value) => update("sourceTrustTier", value as TrustTier)}
              />
              <NumberField
                label="Freshness window"
                value={draft.maxSourceAgeDays}
                min={1}
                max={3650}
                hint="Maximum source age in days before freshness policy can block it."
                onChange={(value) => update("maxSourceAgeDays", boundedInteger(value, 1, 3650))}
              />
            </div>

            <details className="group rounded-lg border border-card bg-background">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium text-text-secondary [&::-webkit-details-marker]:hidden">
                <span>Source metadata</span>
                <ChevronDown
                  className="h-4 w-4 text-text-muted transition-transform group-open:rotate-180"
                  aria-hidden="true"
                />
              </summary>
              <div className="grid gap-3 border-t border-card p-3 md:grid-cols-2">
                <DraftField
                  label="Adapter ID"
                  value={draft.sourceAdapter}
                  hint="Runtime connector or corpus adapter id."
                  onChange={(value) => update("sourceAdapter", value)}
                />
                <DraftField
                  label="Source tags"
                  value={draft.sourceTags}
                  hint="Comma-separated tags used for retrieval preference."
                  onChange={(value) => update("sourceTags", value)}
                />
                <TextAreaField
                  label="Source description"
                  value={draft.sourceDescription}
                  onChange={(value) => update("sourceDescription", value)}
                  className="md:col-span-2"
                />
              </div>
            </details>

            <SourceKindPicker
              selected={draft.allowedSourceKinds}
              onChange={(selected) => update("allowedSourceKinds", selected)}
            />
          </ProfileSection>

          <ProfileSection
            icon={Search}
            title="Search Behavior"
            detail="How the profile finds and prepares evidence before generation."
          >
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <SelectField
                label="Search method"
                value={draft.retrievalMode}
                options={["keyword", "vector", "hybrid", "visual"]}
                optionLabels={RETRIEVAL_MODE_LABELS}
                onChange={(value) => update("retrievalMode", value as RetrievalMode)}
              />
              <SelectField
                label="Result ordering"
                value={draft.rerankMode}
                options={["none", "lightweight", "model"]}
                optionLabels={RERANK_MODE_LABELS}
                onChange={(value) => update("rerankMode", value as RerankMode)}
              />
              <NumberField
                label="Chunks to fetch"
                value={draft.maxChunks}
                min={1}
                max={30}
                hint="Retrieved candidates before context trimming."
                onChange={updateMaxChunks}
              />
              <NumberField
                label="Chunks to send"
                value={draft.maxContextChunks}
                min={1}
                max={draft.maxChunks}
                hint="Evidence chunks allowed into the final context."
                onChange={updateMaxContextChunks}
              />
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <ToggleField
                label="Rewrite query"
                detail="Allow the planner to normalize or expand user questions."
                checked={draft.allowQueryRewrite}
                onChange={(checked) => update("allowQueryRewrite", checked)}
              />
              <ToggleField
                label="Search in parallel"
                detail="Allow multiple search lanes when the question has distinct parts."
                checked={draft.allowParallelQueries}
                onChange={(checked) => update("allowParallelQueries", checked)}
              />
            </div>
          </ProfileSection>

          <ProfileSection
            icon={ShieldCheck}
            title="Grounding And Refusal"
            detail="The minimum evidence floor and the behavior when evidence is missing."
          >
            <GroundingPolicyPanel
              minimumCitations={draft.minimumCitationsForAnswer}
              minimumTrustedCitations={draft.minimumTrustedCitations}
            />

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <NumberField
                label="Minimum cited evidence"
                value={draft.minimumCitationsForAnswer}
                min={1}
                max={10}
                hint="Baseline floor before any answer is allowed."
                onChange={updateMinimumCitedEvidence}
              />
              <NumberField
                label="Minimum trusted evidence"
                value={draft.minimumTrustedCitations}
                min={1}
                max={draft.minimumCitationsForAnswer}
                hint="Trusted cited chunks required inside that floor."
                onChange={updateMinimumTrustedEvidence}
              />
              <SelectField
                label="Answer evidence floor"
                value={draft.minimumAnswerTrustTier}
                options={ANSWER_TRUST_TIER_OPTIONS}
                optionLabels={TRUST_TIER_LABELS}
                hint="Evidence below this tier may be retrieved, but it will not satisfy trusted evidence."
                onChange={(value) => update("minimumAnswerTrustTier", value as TrustTier)}
              />
              <TextAreaField
                label="Refusal message"
                value={draft.refusalMessage}
                hint="Returned when the profile does not have enough supported evidence."
                onChange={(value) => update("refusalMessage", value)}
              />
            </div>
          </ProfileSection>

          <ProfileSection
            icon={SlidersHorizontal}
            title="Advanced Guardrails"
            detail="Action drafting, runtime budgets, and release checks."
          >
            <AdvancedConfigGroup icon={Workflow} title="Action Drafting">
              <div className="grid gap-3 md:grid-cols-2">
                <SelectField
                  label="Can draft actions"
                  value={draft.actionMode}
                  options={["answer_only", "draft_only", "human_approval_required"]}
                  optionLabels={ACTION_MODE_LABELS}
                  onChange={(value) => update("actionMode", value as ActionMode)}
                />
                {draft.actionMode === "answer_only" ? (
                  <EmptyState
                    title="No action drafting"
                    detail="This profile answers only. Action IDs stay empty in the generated policy."
                  />
                ) : (
                  <>
                    <TextAreaField
                      label="Allowed action IDs"
                      value={draft.allowedActions}
                      hint="Comma-separated action ids the profile may draft."
                      onChange={(value) => update("allowedActions", value)}
                    />
                    <TextAreaField
                      label="Approval-required action IDs"
                      value={draft.approvalActions}
                      hint="Comma-separated action ids that need operator approval."
                      onChange={(value) => update("approvalActions", value)}
                      className="md:col-span-2"
                    />
                  </>
                )}
              </div>
            </AdvancedConfigGroup>

            <AdvancedConfigGroup icon={Gauge} title="Runtime Budget">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <NumberField
                  label="Retrieval call cap"
                  value={draft.maxRetrievalCalls}
                  min={1}
                  max={50}
                  hint="Hard limit on retrieval calls in one answer run."
                  onChange={(value) => update("maxRetrievalCalls", boundedInteger(value, 1, 50))}
                />
                <NumberField
                  label="Model call cap"
                  value={draft.maxModelCalls}
                  min={1}
                  max={30}
                  hint="Hard limit on planner, generator, rerank, and judge model calls."
                  onChange={(value) => update("maxModelCalls", boundedInteger(value, 1, 30))}
                />
                <NumberField
                  label="Model latency cap (ms)"
                  value={draft.maxRuntimeMs}
                  min={1000}
                  max={600000}
                  step={1000}
                  hint="Budget meter blocks a model result when that call exceeds this latency."
                  onChange={(value) => update("maxRuntimeMs", boundedInteger(value, 1000, 600000))}
                />
                <NumberField
                  label="Cost cap (USD)"
                  value={draft.maxEstimatedCostUsd}
                  min={0.01}
                  max={50}
                  step={0.01}
                  hint="Estimated model cost accumulated across one answer run."
                  onChange={(value) =>
                    update("maxEstimatedCostUsd", boundedNumber(value, 0.01, 50))
                  }
                />
                <NumberField
                  label="Context token cap"
                  value={draft.maxContextTokens}
                  min={1000}
                  max={120000}
                  step={1000}
                  hint="Maximum evidence text budget before generation."
                  onChange={(value) =>
                    update("maxContextTokens", boundedInteger(value, 1000, 120000))
                  }
                />
                <NumberField
                  label="Answer token reserve"
                  value={draft.reserveOutputTokens}
                  min={256}
                  max={16000}
                  step={128}
                  hint="Output space reserved so evidence does not crowd out the answer."
                  onChange={(value) =>
                    update("reserveOutputTokens", boundedInteger(value, 256, 16000))
                  }
                />
              </div>
            </AdvancedConfigGroup>

            <AdvancedConfigGroup icon={FlaskConical} title="Release Checks">
              <div className="grid gap-3 md:grid-cols-2">
                <TextAreaField
                  label="Required checks"
                  value={draft.requiredChecks}
                  hint="Citation and grounding checks are added even if removed here."
                  onChange={(value) => update("requiredChecks", value)}
                  className="md:col-span-2"
                />
                <TextAreaField
                  label="Golden eval path"
                  value={draft.goldenSetPath}
                  hint="Happy-path eval cases that should keep passing for this profile."
                  onChange={(value) => update("goldenSetPath", value)}
                />
                <TextAreaField
                  label="Adversarial eval path"
                  value={draft.adversarialSetPath}
                  hint="Failure-mode eval cases for unsupported, unsafe, or confusing questions."
                  onChange={(value) => update("adversarialSetPath", value)}
                />
              </div>
            </AdvancedConfigGroup>
          </ProfileSection>
        </div>

        <aside className="min-w-0 space-y-4">
          <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-1">
            <MetricCard
              label="Profile ID"
              value={profile.id || "missing"}
              tone={errors ? "error" : "primary"}
            />
            <MetricCard label="Namespace" value={profile.namespaceId || "missing"} />
            <MetricCard
              label="Retrieval"
              value={RETRIEVAL_MODE_LABELS[draft.retrievalMode]}
              tone={draft.retrievalMode === "keyword" ? "success" : "warning"}
            />
          </div>

          <div className="rounded-lg border border-card bg-background p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-sm font-medium">Readiness</div>
              <StatusPill label={`${issues.length} checks`} tone="primary" />
            </div>
            <div className="space-y-2">
              {issues.map((issue) => (
                <div
                  key={`${issue.label}:${issue.detail}`}
                  className="rounded-lg border border-card bg-card/40 p-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{issue.label}</div>
                      <div className="mt-1 text-xs leading-5 text-text-muted">{issue.detail}</div>
                    </div>
                    <StatusPill label={issue.tone} tone={issue.tone} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-card bg-background p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <FileJson className="h-4 w-4 text-primary" aria-hidden="true" />
              Use This Draft
            </div>
            <div className="space-y-2 text-xs leading-5 text-text-secondary">
              <CodeLine label="Save as" value={filePath} />
              <CodeLine
                label="Run service"
                value={`RAG_APP_PROFILE_PATH=${filePath} npm run serve`}
              />
              <CodeLine
                label="Run tests"
                value={`RAG_APP_PROFILE_PATH=${filePath} npm run evals`}
              />
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <ActionButton icon={Copy} label="Copy profile JSON" onClick={copyJson} />
              <ActionButton icon={Download} label="Download profile file" onClick={downloadJson} />
            </div>
            {message ? (
              <div
                className={`mt-3 rounded-lg border p-2 text-xs ${
                  message.tone === "success"
                    ? "border-success/30 bg-success/10 text-success"
                    : "border-error/30 bg-error/10 text-error"
                }`}
              >
                {message.text}
              </div>
            ) : null}
          </div>

          <details className="group rounded-lg border border-card bg-background">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium text-text-secondary [&::-webkit-details-marker]:hidden">
              <span>Preview generated JSON</span>
              <ChevronDown
                className="h-4 w-4 text-text-muted transition-transform group-open:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <div className="max-h-[520px] overflow-auto border-t border-card bg-[#111111] p-3 text-xs leading-5 text-white">
              <pre className="whitespace-pre-wrap break-words">{json}</pre>
            </div>
          </details>
        </aside>
      </div>
    </SectionCard>
  );
}

function ProfileSection({
  icon: Icon,
  title,
  detail,
  children
}: {
  readonly icon: typeof FileJson;
  readonly title: string;
  readonly detail: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="border-t border-card pt-4 first:border-t-0 first:pt-0">
      <div className="mb-3 flex items-start gap-2">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-card text-primary">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
          <p className="mt-1 text-xs leading-5 text-text-muted">{detail}</p>
        </div>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function AdvancedConfigGroup({
  icon: Icon,
  title,
  children
}: {
  readonly icon: typeof FileJson;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <details className="group rounded-lg border border-card bg-background">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium text-text-secondary [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
          {title}
        </span>
        <ChevronDown
          className="h-4 w-4 text-text-muted transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="border-t border-card p-3">{children}</div>
    </details>
  );
}

function ExampleLoader({ onSelect }: { readonly onSelect: (exampleId: ProfileExampleId) => void }) {
  return (
    <details className="group rounded-lg border border-card bg-background">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium text-text-secondary [&::-webkit-details-marker]:hidden">
        <span>Optional starting points</span>
        <ChevronDown
          className="h-4 w-4 text-text-muted transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="border-t border-card p-3">
        <div className="mb-3 text-xs leading-5 text-text-muted">
          These only fill the same portable profile form. Loading one does not create a separate
          profile type.
        </div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          {PROFILE_EXAMPLES.map((example) => (
            <button
              key={example.id}
              type="button"
              onClick={() => onSelect(example.id)}
              aria-label={`Load ${example.label} example values`}
              className="min-h-20 rounded-lg border border-card bg-card/40 p-3 text-left text-sm text-text-secondary hover:border-primary/30 hover:text-text-primary"
            >
              <span className="font-medium">Load {example.label} example</span>
              <span className="mt-2 block text-xs leading-5 text-current/75">{example.detail}</span>
            </button>
          ))}
        </div>
      </div>
    </details>
  );
}

function AdvancedIdentity({
  profileId,
  namespaceId,
  mode,
  onProfileIdChange,
  onNamespaceIdChange
}: {
  readonly profileId: string;
  readonly namespaceId: string;
  readonly mode: "auto" | "custom";
  readonly onProfileIdChange: (value: string) => void;
  readonly onNamespaceIdChange: (value: string) => void;
}) {
  return (
    <details className="group border-t border-card pt-3">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-text-secondary [&::-webkit-details-marker]:hidden">
        <span>Advanced identity</span>
        <div className="flex items-center gap-2">
          <StatusPill
            label={mode === "auto" ? "auto" : "custom"}
            tone={mode === "auto" ? "success" : "warning"}
          />
          <ChevronDown
            className="h-4 w-4 text-text-muted transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </div>
      </summary>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <DraftField
          label="Profile ID"
          value={profileId}
          hint="Runtime profile id and export filename. Usually auto-generated from the name."
          onChange={onProfileIdChange}
        />
        <DraftField
          label="Namespace"
          value={namespaceId}
          hint="Retrieval namespace; chunks must match this to be usable. Usually the same as profile ID."
          onChange={onNamespaceIdChange}
        />
      </div>
    </details>
  );
}

function GroundingPolicyPanel({
  minimumCitations,
  minimumTrustedCitations
}: {
  readonly minimumCitations: number;
  readonly minimumTrustedCitations: number;
}) {
  return (
    <div className="rounded-lg border border-card bg-background p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
          Grounding Policy
        </div>
        <StatusPill label="locked" tone="success" />
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <PolicyFact
          icon={LockKeyhole}
          label="Citation policy"
          value="Always required"
          detail="Generated profiles keep source citations and exact chunk citations on."
        />
        <PolicyFact
          icon={CheckCircle2}
          label="Evidence floor"
          value={`${minimumCitations} cited / ${minimumTrustedCitations} trusted`}
          detail="This is the minimum, not the total coverage needed for complex questions."
        />
        <PolicyFact
          icon={ShieldCheck}
          label="Claim coverage"
          value="Every material claim"
          detail="Multi-part answers need cited support for each factual part."
        />
        <PolicyFact
          icon={LockKeyhole}
          label="Unsupported parts"
          value="Refuse"
          detail="If one part has no evidence, that part should not be filled by the model."
        />
      </div>
    </div>
  );
}

function PolicyFact({
  icon: Icon,
  label,
  value,
  detail
}: {
  readonly icon: typeof ShieldCheck;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-card bg-card/40 p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-text-muted">
        <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 text-sm font-medium text-text-primary">{value}</div>
      <div className="mt-1 text-xs leading-5 text-text-muted">{detail}</div>
    </div>
  );
}

function DraftField({
  label,
  value,
  hint,
  onChange
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-xs font-medium text-text-muted">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-10 w-full min-w-0 rounded-lg border border-card bg-background px-3 py-2 text-sm text-text-primary"
      />
      {hint ? <FieldHint>{hint}</FieldHint> : null}
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  hint,
  className
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: string;
  readonly className?: string;
}) {
  return (
    <label className={`grid gap-1 text-xs font-medium text-text-muted ${className ?? ""}`}>
      {label}
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-20 w-full min-w-0 rounded-lg border border-card bg-background px-3 py-2 text-sm leading-5 text-text-primary"
      />
      {hint ? <FieldHint>{hint}</FieldHint> : null}
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  optionLabels,
  hint,
  onChange
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly string[];
  readonly optionLabels?: Readonly<Partial<Record<string, string>>>;
  readonly hint?: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-xs font-medium text-text-muted">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-10 w-full min-w-0 rounded-lg border border-card bg-background px-3 py-2 text-sm text-text-primary"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabels?.[option] ?? option}
          </option>
        ))}
      </select>
      {hint ? <FieldHint>{hint}</FieldHint> : null}
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  hint,
  onChange
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly hint?: string;
  readonly onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-1 text-xs font-medium text-text-muted">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="min-h-10 w-full min-w-0 rounded-lg border border-card bg-background px-3 py-2 text-sm text-text-primary"
      />
      {hint ? <FieldHint>{hint}</FieldHint> : null}
    </label>
  );
}

function ToggleField({
  label,
  detail,
  checked,
  onChange
}: {
  readonly label: string;
  readonly detail?: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-12 items-center justify-between gap-3 rounded-lg border border-card bg-background px-3 py-2 text-sm">
      <span className="min-w-0">
        <span className="block font-medium text-text-secondary">{label}</span>
        {detail ? (
          <span className="mt-1 block text-xs leading-4 text-text-muted">{detail}</span>
        ) : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-5 w-5 accent-primary"
      />
    </label>
  );
}

function FieldHint({ children }: { readonly children: ReactNode }) {
  return <span className="text-[11px] font-normal leading-4 text-text-muted">{children}</span>;
}

function SourceKindPicker({
  selected,
  onChange
}: {
  readonly selected: readonly SourceKind[];
  readonly onChange: (selected: readonly SourceKind[]) => void;
}) {
  return (
    <div className="rounded-lg border border-card bg-background p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <SlidersHorizontal className="h-4 w-4 text-primary" aria-hidden="true" />
        Citable Source Types
      </div>
      <div className="mb-3 text-xs leading-5 text-text-muted">
        Only selected source kinds can become final citation evidence.
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {SOURCE_KIND_OPTIONS.map((sourceKind) => {
          const checked = selected.includes(sourceKind);
          const label = SOURCE_KIND_LABELS[sourceKind];
          return (
            <label
              key={sourceKind}
              className="flex min-h-10 items-center gap-2 rounded-lg border border-card bg-card/40 px-3 py-2 text-xs text-text-secondary"
            >
              <input
                type="checkbox"
                aria-label={`Allow ${label} as citations`}
                checked={checked}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, sourceKind]
                      : selected.filter((entry) => entry !== sourceKind)
                  )
                }
                className="h-4 w-4 accent-primary"
              />
              <span>{label}</span>
            </label>
          );
        })}
      </div>
      {selected.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            title="No citation source kinds selected"
            detail="At least one source kind should be citable."
          />
        </div>
      ) : null}
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  onClick
}: {
  readonly icon: typeof Copy;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-card px-3 py-2 text-sm text-text-secondary hover:border-primary/30 hover:text-text-primary"
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {label}
    </button>
  );
}

function CodeLine({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-card bg-card/40 px-2 py-1.5">
      <div className="mb-1 font-sans text-[11px] font-medium text-text-muted">{label}</div>
      <div className="break-all font-mono text-[11px] text-text-secondary">{value}</div>
    </div>
  );
}

function boundedInteger(value: number, min: number, max: number): number {
  const parsed = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.min(max, Math.max(min, parsed));
}

function boundedNumber(value: number, min: number, max: number): number {
  const parsed = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, parsed));
}
