"use client";

import Link from "next/link";
import { Lock } from "lucide-react";
import type { Runner } from "@/lib/types";
import { Dot } from "@/components/ui/misc";
import { cn, isOnline, timeAgo } from "@/lib/ui/format";

export type RunnerLite = Pick<Runner, "id" | "name" | "public_key" | "last_seen_at" | "version">;

export function RunnerPicker({ runners, value, onChange }: { runners: RunnerLite[]; value: string; onChange: (id: string) => void }) {
  const usable = runners.filter((r) => !!r.public_key);
  const pendingSetup = runners.filter((r) => !r.public_key);
  return (
    <div>
      <p className="mb-4 flex max-w-[64ch] gap-2 text-[13.5px] leading-relaxed text-ink-2">
        <Lock size={16} aria-hidden className="mt-0.5 shrink-0 text-accent-ink" />
        <span>
          Credentials are encrypted in this browser with the runner&apos;s public key before they&apos;re sent. Only that runner can decrypt
          them — not this panel, not the database. Runners appear here once they&apos;ve finished registering.
        </span>
      </p>
      {usable.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong p-5 text-[14px] text-ink-2">
          <p className="font-medium text-ink">Connect a runner first</p>
          <p className="mt-1 text-muted">
            {pendingSetup.length
              ? `${pendingSetup.map((r) => r.name).join(", ")} hasn't finished registering yet. Run the register command on that computer.`
              : "There's no registered runner in this workspace."}{" "}
            <Link href="/runners" className="font-medium text-accent-ink underline underline-offset-2">
              Go to Runners
            </Link>
          </p>
        </div>
      ) : (
        <div role="radiogroup" aria-label="Runner" className="grid gap-2 sm:grid-cols-2">
          {usable.map((r) => {
            const on = isOnline(r.last_seen_at);
            const sel = value === r.id;
            return (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={sel}
                onClick={() => onChange(r.id)}
                className={cn(
                  "flex items-start gap-3 rounded-xl border p-4 text-left transition-colors",
                  sel ? "border-accent bg-accent-soft/50 ring-2 ring-accent/25" : "border-line bg-surface hover:border-line-strong",
                )}
              >
                <span className="mt-1.5">
                  <Dot tone={on ? "ok" : "bad"} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[14.5px] font-semibold text-ink">{r.name}</span>
                  <span className="block text-[12.5px] text-muted">
                    {on ? "Online" : `Offline · last seen ${timeAgo(r.last_seen_at)}`}
                    {r.version ? ` · v${r.version.replace(/^v/, "")}` : ""}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
