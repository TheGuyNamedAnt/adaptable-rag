"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity,
  BarChart3,
  Boxes,
  BrainCircuit,
  ChevronDown,
  ClipboardList,
  Database,
  FlaskConical,
  GitBranch,
  HardDrive,
  Network,
  RadioTower,
  Route,
  ScrollText,
  SearchCheck,
  Settings2,
  ShieldCheck
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ShellOverviewResult } from "@/lib/rag-admin-api";

type ShellOverview = ShellOverviewResult;

interface ShellApiOverview {
  status: "available" | "partial" | "unavailable";
  health?:
    | {
        status?: string;
        profileId?: string;
        namespaceId?: string;
        retrievalMode?: string;
      }
    | undefined;
  ready?:
    | {
        ready?: boolean;
        status?: string;
      }
    | undefined;
}

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  description: string;
  match: readonly string[];
  disabled?: boolean;
}

interface NavGroup {
  title: string;
  items: readonly NavItem[];
}

const NAV_GROUPS: readonly NavGroup[] = [
  {
    title: "Start",
    items: [
      {
        label: "Dashboard",
        href: "/",
        icon: Activity,
        description: "State, blockers, and next action",
        match: ["/"]
      }
    ]
  },
  {
    title: "Configure",
    items: [
      {
        label: "RAG Profile",
        href: "/profiles",
        icon: Route,
        description: "Behavior, trust, budgets, and eval policy",
        match: ["/profiles"]
      },
      {
        label: "Knowledge Sources",
        href: "/sources",
        icon: Boxes,
        description: "Where knowledge comes from",
        match: ["/sources"]
      },
      {
        label: "Connectors",
        href: "/connectors",
        icon: GitBranch,
        description: "Repeatable company source systems",
        match: ["/connectors"]
      },
      {
        label: "Storage",
        href: "/storage",
        icon: HardDrive,
        description: "Durable data and metadata stores",
        match: ["/storage"]
      },
      {
        label: "Diagnostics",
        href: "/admin-ops",
        icon: Settings2,
        description: "Setup checks and safe fixes",
        match: ["/admin-ops"]
      }
    ]
  },
  {
    title: "Run",
    items: [
      {
        label: "Add Knowledge",
        href: "/ingestion",
        icon: ClipboardList,
        description: "Upload, sync, and index content",
        match: ["/ingestion"]
      },
      {
        label: "Test Answer",
        href: "/answer-lab",
        icon: BrainCircuit,
        description: "Ask, inspect, and debug",
        match: ["/answer-lab"]
      },
      {
        label: "Review Work",
        href: "/review",
        icon: ShieldCheck,
        description: "Human decisions and handoff",
        match: ["/review"]
      }
    ]
  },
  {
    title: "Verify",
    items: [
      {
        label: "Regression Tests",
        href: "/evals",
        icon: FlaskConical,
        description: "Answer and citation checks",
        match: ["/evals"]
      },
      {
        label: "Reliability",
        href: "/slos",
        icon: BarChart3,
        description: "Health gates before promotion",
        match: ["/slos"]
      },
      {
        label: "Quality Artifacts",
        href: "/quality-ops",
        icon: BarChart3,
        description: "Benchmarks and generated reports",
        match: ["/quality-ops"]
      }
    ]
  },
  {
    title: "Inspect",
    items: [
      {
        label: "Evidence Explorer",
        href: "/traces",
        icon: SearchCheck,
        description: "Traces, citations, rejections",
        match: ["/traces", "/citations", "/rejected"]
      },
      {
        label: "Knowledge Graph",
        href: "/graph",
        icon: Network,
        description: "Entities and retrieval paths",
        match: ["/graph"]
      }
    ]
  }
];
const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

function activeFor(pathname: string, item: NavItem): boolean {
  return item.match.some(
    (match) => pathname === match || (match !== "/" && pathname.startsWith(`${match}/`))
  );
}

function modeTone(overview: ShellOverview | null): string {
  if (!overview) return "bg-card text-text-muted border-card";
  if (overview.ready?.ready) return "bg-success/10 text-success border-success/20";
  if (overview.status === "partial") return "bg-warning/10 text-warning border-warning/20";
  return "bg-error/10 text-error border-error/20";
}

function modeLabel(overview: ShellOverview | null): string {
  if (!overview) return "Loading";
  if (overview.ready?.ready) return "Ready";
  if (overview.ready?.status) return overview.ready.status;
  return overview.status;
}

function shellOverviewFromApi(input: ShellApiOverview): ShellOverview {
  return {
    status: input.status,
    health: input.health,
    ready: input.ready
  };
}

export function RagAdminShell({
  children,
  initialOverview
}: {
  children: React.ReactNode;
  initialOverview: ShellOverviewResult;
}) {
  const pathname = usePathname();
  const [overview, setOverview] = useState<ShellOverview>(initialOverview);

  useEffect(() => {
    let cancelled = false;

    async function loadOverview() {
      try {
        const response = await fetch("/api/rag/overview", { cache: "no-store" });
        if (!response.ok) return;
        const nextOverview = shellOverviewFromApi((await response.json()) as ShellApiOverview);
        if (!cancelled) setOverview(nextOverview);
      } catch {
        if (!cancelled) {
          setOverview({ status: "unavailable", health: undefined, ready: undefined });
        }
      }
    }

    void loadOverview();
    const interval = window.setInterval(loadOverview, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const activeProfile = overview.health?.profileId ?? "No profile";
  const activeNamespace = overview.health?.namespaceId ?? "No namespace";
  const activeItem = NAV_ITEMS.find((item) => activeFor(pathname, item)) ?? NAV_ITEMS[0];
  const activeGroup =
    NAV_GROUPS.find((group) => group.items.some((item) => activeFor(pathname, item)))?.title ??
    "Pages";
  const ActiveIcon = activeItem.icon;

  return (
    <div className="min-h-screen bg-background text-text-primary">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 flex-col border-r border-card bg-surface lg:flex">
        <div className="border-b border-card px-5 py-5">
          <Link href="/" className="group flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-text-primary text-white">
              <ScrollText className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold leading-5">Adaptable RAG</span>
              <span className="block truncate text-xs text-text-muted">Deployment console</span>
            </span>
          </Link>
        </div>

        <div className="border-b border-card px-5 py-4">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
                Active deployment
              </p>
              <p className="mt-1 truncate text-sm font-semibold">{activeProfile}</p>
              <p className="truncate text-xs text-text-muted">{activeNamespace}</p>
            </div>
            <span
              className={`shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium ${modeTone(overview)}`}
            >
              {modeLabel(overview)}
            </span>
          </div>
          <p className="mt-3 truncate text-[11px] text-text-muted">
            Retrieval: {overview.health?.retrievalMode ?? "unknown"}
          </p>
          <Link
            href="/profiles"
            className="mt-2 inline-flex text-xs font-medium text-primary hover:text-text-primary"
          >
            Configure profile
          </Link>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          {NAV_GROUPS.map((group) => (
            <div key={group.title} className="mb-5">
              <p className="px-2 text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
                {group.title}
              </p>
              <div className="mt-2 space-y-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeFor(pathname, item);
                  const disabled = item.disabled === true;
                  const className = `group flex items-start gap-3 rounded-lg border px-3 py-2 text-sm transition-colors ${
                    isActive
                      ? "border-text-primary bg-text-primary text-white"
                      : disabled
                        ? "border-transparent text-text-muted opacity-60"
                        : "border-transparent text-text-secondary hover:border-card hover:bg-card hover:text-text-primary"
                  }`;
                  const content = (
                    <>
                      <Icon
                        className={`mt-0.5 h-4 w-4 shrink-0 ${
                          isActive ? "text-white" : "text-text-muted group-hover:text-text-primary"
                        }`}
                        aria-hidden="true"
                      />
                      <span className="min-w-0">
                        <span className="block font-medium leading-5">{item.label}</span>
                        {isActive ? (
                          <span className="block text-xs leading-4 text-white/70">
                            {item.description}
                          </span>
                        ) : null}
                      </span>
                    </>
                  );
                  return disabled ? (
                    <span
                      key={`${group.title}-${item.label}`}
                      className={className}
                      title="Planned"
                    >
                      {content}
                    </span>
                  ) : (
                    <Link
                      key={`${group.title}-${item.label}`}
                      href={item.href}
                      className={className}
                    >
                      {content}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-card px-5 py-4">
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <RadioTower className="h-4 w-4" aria-hidden="true" />
            <span className="truncate">Redacted admin inspection</span>
          </div>
        </div>
      </aside>

      <div className="lg:pl-72">
        <div className="border-b border-card bg-surface px-4 py-3 lg:hidden">
          <div className="flex items-center justify-between gap-3">
            <Link href="/" className="flex min-h-11 min-w-0 items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-text-primary text-white">
                <Database className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">Adaptable RAG</span>
                <span className="block truncate text-xs text-text-muted">{activeProfile}</span>
              </span>
            </Link>
            <span
              className={`shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium ${modeTone(overview)}`}
            >
              {modeLabel(overview)}
            </span>
          </div>
          <details className="group mt-3 rounded-xl border border-card bg-background">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 [&::-webkit-details-marker]:hidden">
              <span className="flex min-w-0 items-center gap-2">
                <ActiveIcon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{activeItem.label}</span>
                  <span className="block truncate text-xs text-text-muted">{activeGroup}</span>
                </span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-card bg-surface px-2.5 py-1.5 text-xs font-medium text-text-secondary">
                Pages
                <ChevronDown
                  className="h-3.5 w-3.5 transition-transform group-open:rotate-180"
                  aria-hidden="true"
                />
              </span>
            </summary>
            <nav className="border-t border-card p-3" aria-label="RAG admin">
              <div className="space-y-4">
                {NAV_GROUPS.map((group) => (
                  <div key={group.title}>
                    <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
                      {group.title}
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {group.items
                        .filter((item) => !item.disabled)
                        .map((item) => {
                          const Icon = item.icon;
                          const isActive = activeFor(pathname, item);
                          return (
                            <Link
                              key={item.label}
                              href={item.href}
                              className={`flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                                isActive
                                  ? "border-text-primary bg-text-primary text-white"
                                  : "border-card bg-surface text-text-secondary hover:border-primary/30 hover:text-text-primary"
                              }`}
                            >
                              <Icon
                                className={`h-3.5 w-3.5 shrink-0 ${
                                  isActive ? "text-white" : "text-text-muted"
                                }`}
                                aria-hidden="true"
                              />
                              <span className="min-w-0 truncate">{item.label}</span>
                            </Link>
                          );
                        })}
                    </div>
                  </div>
                ))}
              </div>
            </nav>
          </details>
        </div>

        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
