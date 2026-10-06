"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Cpu,
  Globe,
  Inbox,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Settings,
  X,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/ui/format";
import { usePoll } from "@/lib/ui/use-now";
import { ROLE } from "@/lib/ui/labels";
import { createBrowserClient } from "@/lib/supabase/client";
import { Logo } from "./logo";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/approvals", label: "Approvals", icon: Inbox, badge: true },
  { href: "/sites", label: "Sites", icon: Globe },
  { href: "/jobs", label: "Jobs", icon: ListChecks },
  { href: "/runners", label: "Runners", icon: Cpu },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path === href || path.startsWith(href + "/");
}

export function AppShell({
  orgName,
  email,
  role,
  pendingCount: initialPending,
  children,
  preview,
}: {
  orgName: string;
  email: string;
  role: string;
  pendingCount: number;
  children: React.ReactNode;
  /** Dev preview: no polling, no Supabase calls. */
  preview?: boolean;
}) {
  const signOut = preview ? undefined : async () => {
    await createBrowserClient().auth.signOut();
  };
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const { data } = usePoll<{ pending_count?: number }>(preview ? null : "/api/ui/overview", 15_000);
  const pending = data?.pending_count ?? initialPending;

  useEffect(() => setOpen(false), [path]);

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-0.5 px-3">
      {NAV.map((n) => {
        const on = isActive(path, n.href);
        const Icon = n.icon;
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={on ? "page" : undefined}
            className={cn(
              "group flex h-10 items-center gap-3 rounded-lg px-3 text-[14px] font-medium transition-colors",
              on ? "bg-white/10 text-white" : "text-white/65 hover:bg-white/5 hover:text-white",
            )}
          >
            <Icon size={18} aria-hidden className={cn(on ? "text-[#22d3ee]" : "text-white/50 group-hover:text-white/80")} />
            <span className="flex-1">{n.label}</span>
            {"badge" in n && pending > 0 && (
              <span
                className="num min-w-6 rounded-full bg-[#f5b740] px-1.5 text-center text-[12px] leading-5 font-semibold text-[#2a1c00]"
                aria-label={`${pending} waiting`}
              >
                {pending > 99 ? "99+" : pending}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-dvh md:pl-64">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70] focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>

      {/* desktop sidebar: always navy, in both themes */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-[#0a1a33] md:flex dark:bg-[#071326] dark:shadow-[1px_0_0_#1c3150]">
        <div className="flex h-16 items-center px-6">
          <Link href="/" className="rounded-md" aria-label="SEO Autopilot home">
            <Logo />
          </Link>
        </div>
        <div className="mt-2 flex-1 overflow-y-auto">{nav}</div>
        <div className="px-6 py-5 text-[12px] leading-relaxed text-white/45">
          Built by Upcore Technologies
        </div>
      </aside>

      {/* mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button className="absolute inset-0 bg-[#06101e]/60" aria-label="Close menu" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-[#0a1a33] pt-[env(safe-area-inset-top)] shadow-pop">
            <div className="flex h-14 items-center justify-between pr-2 pl-5">
              <Logo />
              <button onClick={() => setOpen(false)} className="rounded-lg p-2 text-white/70 hover:text-white" aria-label="Close menu">
                <X size={20} aria-hidden />
              </button>
            </div>
            <div className="mt-2 flex-1 overflow-y-auto">{nav}</div>
          </div>
        </div>
      )}

      {/* top bar */}
      <header className="sticky top-0 z-20 border-b border-line bg-paper/85 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="flex h-14 items-center gap-3 px-4 sm:px-6 lg:px-8">
          <button
            className="-ml-1 rounded-lg p-2 text-ink-2 hover:bg-sunken md:hidden"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            aria-expanded={open}
          >
            <Menu size={20} aria-hidden />
          </button>
          <div className="md:hidden">
            <Logo compact />
          </div>
          <p className="hidden truncate text-[14px] font-medium text-ink md:block">{orgName}</p>
          <div className="ml-auto flex items-center gap-2">
            {pending > 0 && !isActive(path, "/approvals") && (
              <Link
                href="/approvals"
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-approve-soft px-3 text-[13px] font-medium text-approve-ink ring-1 ring-approve/30 ring-inset hover:brightness-[0.98]"
              >
                <Inbox size={14} aria-hidden />
                <span className="num">{pending}</span>
                <span className="hidden sm:inline">waiting</span>
                <span className="sr-only sm:hidden">changes waiting for approval</span>
              </Link>
            )}
            <UserMenu email={email} role={role} orgName={orgName} signOut={signOut} />
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-6xl px-4 pt-6 pb-16 sm:px-6 lg:px-8 lg:pt-8">
        {children}
      </main>
    </div>
  );
}

function UserMenu({ email, role, orgName, signOut }: { email: string; role: string; orgName: string; signOut?: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const initial = (email[0] ?? "?").toUpperCase();
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-9 items-center gap-2 rounded-full py-1 pr-2 pl-1 hover:bg-sunken"
      >
        <span className="grid size-7 place-items-center rounded-full bg-navy text-[13px] font-semibold text-paper" aria-hidden>
          {initial}
        </span>
        <span className="hidden max-w-40 truncate text-[13px] text-ink-2 sm:block">{email}</span>
        <ChevronDown size={14} aria-hidden className="text-muted" />
        <span className="sr-only">Account menu</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-2 w-64 rounded-xl border border-line bg-surface p-1.5 shadow-pop">
          <div className="px-3 py-2">
            <p className="truncate text-[14px] font-medium text-ink">{email}</p>
            <p className="text-[12px] text-muted">
              {ROLE[role] ?? role} in {orgName}
            </p>
          </div>
          <div className="my-1 h-px bg-line" />
          <Link role="menuitem" href="/settings" className="flex h-9 items-center gap-2 rounded-lg px-3 text-[14px] text-ink-2 hover:bg-sunken">
            <Settings size={16} aria-hidden /> Settings
          </Link>
          <button
            role="menuitem"
            disabled={leaving}
            onClick={async () => {
              setLeaving(true);
              try {
                await signOut?.();
              } finally {
                router.replace("/login");
                router.refresh();
              }
            }}
            className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-[14px] text-ink-2 hover:bg-sunken disabled:opacity-60"
          >
            <LogOut size={16} aria-hidden /> {leaving ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
