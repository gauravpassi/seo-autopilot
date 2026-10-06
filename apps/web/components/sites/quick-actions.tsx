"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Play, Sparkles, Upload, ScanSearch, FileSearch } from "lucide-react";
import type { JobKind } from "@seo-autopilot/core/schema";
import { enqueueJob } from "@/app/actions/jobs";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, textareaClass } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";

export function QuickActions({ siteId, siteUrl, disabled }: { siteId: string; siteUrl: string; disabled?: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [which, setWhich] = useState<string | null>(null);
  const [pageOpen, setPageOpen] = useState(false);
  const [urls, setUrls] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);

  const run = (key: string, kind: JobKind, params: Record<string, unknown> = {}, label = "Job") =>
    start(async () => {
      setWhich(key);
      const res = await enqueueJob(siteId, kind, params);
      setWhich(null);
      if (!res.ok) {
        toast({ tone: "error", title: `Couldn't start ${label.toLowerCase()}`, detail: res.error });
        return;
      }
      toast({ tone: "success", title: `${label} queued`, detail: "The runner picks it up within a few seconds." });
      router.push(`/jobs/${res.id}`);
    });

  const actions: Array<{ key: string; label: string; icon: React.ReactNode; onClick: () => void; primary?: boolean; help: string }> = [
    { key: "audit", label: "Run full audit", icon: <ScanSearch size={16} aria-hidden />, onClick: () => run("audit", "audit", { depth: "full" }, "Audit"), primary: true, help: "Crawls the site with claude-seo. Takes 5–20 minutes." },
    { key: "page", label: "Audit specific pages", icon: <FileSearch size={16} aria-hidden />, onClick: () => setPageOpen(true), help: "Deep check of a few URLs." },
    { key: "propose", label: "Propose fixes", icon: <Sparkles size={16} aria-hidden />, onClick: () => run("propose", "propose", {}, "Propose fixes"), help: "Turns the latest audit into exact changes." },
    { key: "apply", label: "Apply approved", icon: <Upload size={16} aria-hidden />, onClick: () => run("apply", "apply", {}, "Apply"), help: "Writes every approved change and checks it live." },
    { key: "verify", label: "Verify live", icon: <Play size={16} aria-hidden />, onClick: () => run("verify", "verify", {}, "Verify"), help: "Re-checks applied changes (slow caches, merged PRs)." },
  ];

  return (
    <>
      <ul className="grid gap-2 sm:grid-cols-2">
        {actions.map((a) => (
          <li key={a.key}>
            <Button
              variant={a.primary ? "primary" : "secondary"}
              className="h-auto w-full flex-col items-start gap-0.5 py-2.5 text-left whitespace-normal"
              disabled={disabled || pending}
              loading={pending && which === a.key}
              onClick={a.onClick}
            >
              <span className="flex items-center gap-2">
                {!(pending && which === a.key) && a.icon}
                {a.label}
              </span>
              <span className={a.primary ? "text-[12px] font-normal text-paper/70" : "text-[12px] font-normal text-muted"}>{a.help}</span>
            </Button>
          </li>
        ))}
      </ul>
      <Dialog
        open={pageOpen}
        onClose={() => setPageOpen(false)}
        title="Audit specific pages"
        description="One URL per line, on this site."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPageOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={pending && which === "page"}
              onClick={() => {
                const host = new URL(siteUrl).host;
                const list = urls
                  .split(/\s+/)
                  .map((u) => u.trim())
                  .filter(Boolean)
                  .map((u) => (u.startsWith("/") ? new URL(u, siteUrl).toString() : u));
                const bad = list.find((u) => {
                  try {
                    return new URL(u).host !== host;
                  } catch {
                    return true;
                  }
                });
                if (!list.length) return setUrlError("Add at least one URL.");
                if (bad) return setUrlError(`${bad} isn't on ${host}.`);
                setUrlError(null);
                setPageOpen(false);
                run("page", "audit", { depth: "page", urls: list }, "Page audit");
              }}
            >
              Start audit
            </Button>
          </>
        }
      >
        <Field label="Pages" htmlFor="page-urls" error={urlError} hint="Paths like /pricing are fine.">
          <textarea
            id="page-urls"
            rows={5}
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            className={textareaClass + " font-mono text-[13px]"}
            placeholder={`${siteUrl.replace(/\/$/, "")}/pricing\n/blog/launch`}
          />
        </Field>
      </Dialog>
    </>
  );
}
