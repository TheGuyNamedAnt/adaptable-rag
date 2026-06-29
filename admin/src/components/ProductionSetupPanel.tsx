import { CheckCircle2, ChevronDown, CircleAlert, CircleDashed, Terminal } from "lucide-react";
import { MetricCard, SectionCard, StatusPill, type Tone } from "@/components/ui";
import { formatNumber, formatTime, statusTone } from "@/lib/format";
import type {
  ProductionSetupChecklist,
  ProductionSetupStatus,
  ProductionSetupStep
} from "@/lib/production-setup";

export function ProductionSetupPanel({
  checklist
}: {
  readonly checklist: ProductionSetupChecklist;
}) {
  const nextStep = checklist.steps.find((step) => step.status !== "passed");

  return (
    <SectionCard
      title="Production Readiness"
      description={`Generated ${formatTime(checklist.generatedAt)}${
        checklist.nextAction ? ` · Next: ${checklist.nextAction}` : ""
      }`}
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard
          label="Readiness"
          value={checklist.status}
          tone={setupStatusTone(checklist.status)}
        />
        <MetricCard
          label="Passed"
          value={formatNumber(checklist.summary.passedCount)}
          tone="success"
        />
        <MetricCard
          label="Warnings"
          value={formatNumber(checklist.summary.warningCount)}
          tone={checklist.summary.warningCount ? "warning" : "default"}
        />
        <MetricCard
          label="Failed"
          value={formatNumber(checklist.summary.failedCount)}
          tone={checklist.summary.failedCount ? "error" : "default"}
        />
        <MetricCard label="Pending" value={formatNumber(checklist.summary.pendingCount)} />
      </div>

      {nextStep ? (
        <div className="mt-4 rounded-lg border border-warning/30 bg-warning/10 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-warning">
                Next action
              </div>
              <div className="mt-1 font-semibold text-text-primary">{nextStep.title}</div>
              <p className="mt-1 text-sm leading-5 text-text-secondary">{nextStep.detail}</p>
            </div>
            <StatusPill label={nextStep.status} tone={setupStatusTone(nextStep.status)} />
          </div>
        </div>
      ) : null}

      <details className="group mt-4 rounded-lg border border-card bg-background">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium text-text-secondary [&::-webkit-details-marker]:hidden">
          <span>All readiness steps</span>
          <span className="flex shrink-0 items-center gap-2">
            <span className="text-xs font-normal text-text-muted">
              {formatNumber(checklist.summary.stepCount)} steps
            </span>
            <ChevronDown
              className="h-4 w-4 text-text-muted transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </span>
        </summary>
        <div className="grid gap-3 border-t border-card p-3 lg:grid-cols-2">
          {checklist.steps.map((step) => (
            <SetupStepCard key={step.id} step={step} isNext={step.id === nextStep?.id} />
          ))}
        </div>
      </details>
    </SectionCard>
  );
}

function SetupStepCard({
  step,
  isNext
}: {
  readonly step: ProductionSetupStep;
  readonly isNext: boolean;
}) {
  return (
    <div
      className={`min-w-0 rounded-lg border p-3 ${
        isNext ? "border-warning/30 bg-warning/5" : "border-card bg-background"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-2">
          <SetupIcon status={step.status} />
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-[0.08em] text-text-muted">
              {step.area}
            </div>
            <div className="font-medium">{step.title}</div>
          </div>
        </div>
        <StatusPill label={step.status} tone={setupStatusTone(step.status)} />
      </div>

      <p className="mt-2 text-sm leading-5 text-text-secondary">{step.detail}</p>

      <details className="group mt-3 rounded-lg border border-card bg-surface">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-text-secondary [&::-webkit-details-marker]:hidden">
          <span>Evidence and commands</span>
          <ChevronDown
            className="h-3.5 w-3.5 text-text-muted transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <div className="space-y-3 border-t border-card p-3">
          {step.evidence.length > 0 ? (
            <div className="space-y-2">
              {step.evidence.map((item) => (
                <div
                  key={item}
                  className="break-words rounded-md border border-card bg-card/40 px-2 py-1.5 text-xs leading-5 text-text-secondary"
                >
                  {item}
                </div>
              ))}
            </div>
          ) : null}

          {step.env.length > 0 ? <CommandBlock title="Env" lines={step.env} /> : null}

          {step.commands.length > 0 ? (
            <div className="space-y-2">
              {step.commands.map((command) => (
                <CommandBlock key={command} title="Command" lines={[command]} />
              ))}
            </div>
          ) : null}

          <a
            href={step.recheckPath}
            className="inline-flex min-h-9 items-center rounded-lg border border-card px-3 py-2 text-sm text-text-secondary hover:border-primary/30 hover:text-text-primary"
          >
            Recheck
          </a>
        </div>
      </details>
    </div>
  );
}

function CommandBlock({
  title,
  lines,
  className = ""
}: {
  readonly title: string;
  readonly lines: readonly string[];
  readonly className?: string;
}) {
  return (
    <div className={className}>
      <div className="mb-1 flex items-center gap-2 text-xs font-medium text-text-muted">
        <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
        {title}
      </div>
      <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-card/60 p-2 font-mono text-[11px] leading-5 text-text-secondary">
        {lines.join("\n")}
      </pre>
    </div>
  );
}

function SetupIcon({ status }: { readonly status: ProductionSetupStatus }) {
  if (status === "passed") {
    return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />;
  }
  if (status === "failed") {
    return <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-error" aria-hidden="true" />;
  }
  return <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />;
}

function setupStatusTone(status: ProductionSetupStatus): Tone {
  return status === "pending" ? "default" : statusTone(status);
}
