import Link from "next/link";
import { ChevronDown } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type React from "react";

export type Tone = "default" | "primary" | "success" | "warning" | "error";

const toneClass: Record<Tone, string> = {
  default: "border-card bg-card text-text-secondary",
  primary: "border-primary/20 bg-primary/10 text-primary",
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  error: "border-error/30 bg-error/10 text-error"
};

export function StatusPill({ label, tone = "default" }: { label: string; tone?: Tone }) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-1 text-[11px] font-medium ${toneClass[tone]}`}
    >
      {label}
    </span>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  tone = "default"
}: {
  label: string;
  value: string | number;
  detail?: string;
  tone?: Tone;
}) {
  return (
    <div className={`min-w-0 rounded-lg border px-3 py-2 ${toneClass[tone]}`}>
      <div className="truncate text-sm font-semibold">{value}</div>
      <div className="truncate text-[11px] leading-tight text-current/75">{label}</div>
      {detail ? <div className="mt-1 truncate text-[11px] text-current/70">{detail}</div> : null}
    </div>
  );
}

export function PageHeader({
  title,
  eyebrow,
  description,
  actions
}: {
  title: string;
  eyebrow?: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="border-b border-card bg-surface">
      <div className="mx-auto flex max-w-6xl flex-col items-stretch gap-3 px-4 py-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          {eyebrow ? (
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="text-xl font-bold">{title}</h1>
          {description ? <p className="text-xs leading-5 text-text-muted">{description}</p> : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}

export function IconLink({
  href,
  icon: Icon,
  label
}: {
  href: string;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-card bg-surface px-3 py-2 text-sm text-text-secondary hover:border-primary/30 hover:text-text-primary"
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {label}
    </Link>
  );
}

export function RelatedPageLinks({
  title = "Related pages",
  description,
  links
}: {
  title?: string;
  description?: string;
  links: readonly {
    href: string;
    icon: LucideIcon;
    label: string;
    detail: string;
  }[];
}) {
  return (
    <SectionCard title={title} description={description}>
      <div className="divide-y divide-card overflow-hidden rounded-lg border border-card bg-background">
        {links.map((link) => {
          const Icon = link.icon;

          return (
            <Link
              key={link.href}
              href={link.href}
              className="flex min-w-0 items-start gap-3 p-3 text-sm hover:bg-card/50"
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block font-medium text-text-primary">{link.label}</span>
                <span className="mt-1 block break-words text-xs leading-5 text-text-muted">
                  {link.detail}
                </span>
              </span>
            </Link>
          );
        })}
      </div>
    </SectionCard>
  );
}

export function PrerequisiteChecklist({
  title = "Prerequisites",
  description,
  items
}: {
  title?: string;
  description?: string;
  items: readonly {
    label: string;
    status: "ready" | "warning" | "blocked";
    detail: string;
    actionHref?: string;
    actionLabel?: string;
  }[];
}) {
  const blockedCount = items.filter((item) => item.status === "blocked").length;
  const warningCount = items.filter((item) => item.status === "warning").length;
  const summaryLabel =
    blockedCount > 0
      ? `${blockedCount} blocked`
      : warningCount > 0
        ? `${warningCount} warning`
        : "ready";
  const summaryTone: Tone = blockedCount > 0 ? "error" : warningCount > 0 ? "warning" : "success";

  return (
    <SectionCard
      title={title}
      description={description}
      action={<StatusPill label={summaryLabel} tone={summaryTone} />}
    >
      <div className="divide-y divide-card overflow-hidden rounded-lg border border-card bg-background">
        {items.map((item) => (
          <div
            key={item.label}
            className="flex min-w-0 flex-col gap-3 p-3 sm:flex-row sm:items-start sm:justify-between"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-text-primary">{item.label}</span>
                <StatusPill label={item.status} tone={prerequisiteTone(item.status)} />
              </div>
              <div className="mt-1 break-words text-xs leading-5 text-text-muted">
                {item.detail}
              </div>
            </div>
            {item.actionHref && item.actionLabel ? (
              <Link
                href={item.actionHref}
                className="inline-flex min-h-9 shrink-0 items-center justify-center rounded-lg border border-card bg-surface px-3 py-2 text-xs font-medium text-text-secondary hover:border-primary/30 hover:text-text-primary"
              >
                {item.actionLabel}
              </Link>
            ) : null}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function prerequisiteTone(status: "ready" | "warning" | "blocked"): Tone {
  if (status === "ready") return "success";
  if (status === "blocked") return "error";
  return "warning";
}

export function SectionCard({
  title,
  description,
  children,
  action
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-xl border border-card bg-surface p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">{title}</h2>
          {description ? (
            <p className="mt-1 break-words text-xs leading-5 text-text-muted">{description}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function CollapsibleSection({
  title,
  description,
  children,
  action,
  defaultOpen = false
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details
      className="group min-w-0 rounded-xl border border-card bg-surface p-4"
      open={defaultOpen}
    >
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <h2 className="font-semibold">{title}</h2>
          {description ? (
            <p className="mt-1 break-words text-xs leading-5 text-text-muted">{description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {action}
          <ChevronDown
            className="mt-0.5 h-4 w-4 text-text-muted transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </div>
      </summary>
      <div className="mt-3 min-w-0 border-t border-card pt-3">{children}</div>
    </details>
  );
}

export function PageGuide({
  title,
  description,
  steps,
  tone = "primary"
}: {
  title: string;
  description: string;
  steps: readonly string[];
  tone?: Tone;
}) {
  return (
    <section className={`rounded-xl border p-4 ${toneClass[tone]}`}>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div>
          <div className="text-sm font-semibold">{title}</div>
          <p className="mt-1 text-sm leading-6 text-current/80">{description}</p>
        </div>
        <ol className="grid gap-2 sm:grid-cols-3">
          {steps.map((step, index) => (
            <li key={step} className="flex gap-2 text-sm leading-5 text-current/80">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/60 text-xs font-semibold text-text-primary">
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function EmptyState({
  title,
  detail,
  actionHref,
  actionLabel,
  action
}: {
  title: string;
  detail?: string;
  actionHref?: string;
  actionLabel?: string;
  action?: React.ReactNode;
}) {
  const builtAction =
    actionHref && actionLabel ? (
      <Link
        href={actionHref}
        className="inline-flex min-h-9 items-center rounded-lg border border-card bg-surface px-3 py-2 text-xs font-medium text-text-secondary hover:border-primary/30 hover:text-text-primary"
      >
        {actionLabel}
      </Link>
    ) : null;

  return (
    <div className="min-w-0 rounded-lg border border-dashed border-card bg-card/40 p-4 text-sm text-text-muted">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="font-medium text-text-secondary">{title}</div>
          {detail ? <div className="mt-1 break-words text-xs leading-5">{detail}</div> : null}
        </div>
        {(action ?? builtAction) ? <div className="shrink-0">{action ?? builtAction}</div> : null}
      </div>
    </div>
  );
}

export function NoticeBanner({
  title,
  message,
  tone = "warning"
}: {
  title: string;
  message: string;
  tone?: Exclude<Tone, "default">;
}) {
  return (
    <div className={`rounded-xl border p-3 text-sm ${toneClass[tone]}`}>
      <div className="font-medium">{title}</div>
      <div className="mt-1 text-xs leading-5 text-current/80">{message}</div>
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-error/20 bg-error/10 p-3 text-sm text-error">
      {message}
    </div>
  );
}
