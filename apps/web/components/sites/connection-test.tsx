"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { CircleAlert, CircleCheck, Clock } from "lucide-react";
import type { Job, JobLog } from "@/lib/types";
import { Spinner } from "@/components/ui/spinner";
import { usePoll } from "@/lib/ui/use-now";
import { asObj } from "@/lib/ui/change-values";

/** Polls a test_connection job and shows a plain-language result. */
export function ConnectionTest({ jobId, onDone }: { jobId: string; onDone?: (ok: boolean) => void }) {
  const { data, error } = usePoll<{ job: Job; logs: JobLog[] }>(`/api/ui/jobs/${jobId}`, 2500, true);
  const job = data?.job;
  const finished = job && ["succeeded", "failed", "cancelled"].includes(job.status);
  const result = asObj(job?.result);
  const ok = job?.status === "succeeded" && result?.ok !== false;
  const warnings = Array.isArray(result?.warnings) ? (result!.warnings as string[]) : [];
  const lastLog = data?.logs?.[data.logs.length - 1];

  // Once the test finishes: tell the parent once, and re-render server data (e.g. the sites list status).
  const router = useRouter();
  const reported = useRef(false);
  useEffect(() => {
    if (!finished || reported.current) return;
    reported.current = true;
    onDone?.(ok);
    router.refresh();
  }, [finished, ok, onDone, router]);

  return (
    <div className="rounded-xl border border-line bg-raised p-4" aria-live="polite">
      {!job || job.status === "queued" ? (
        <div className="flex items-start gap-3">
          <Clock size={18} aria-hidden className="mt-0.5 text-muted" />
          <div>
            <p className="text-[14px] font-medium text-ink">Waiting for the runner to pick up the test</p>
            <p className="mt-0.5 text-[13px] text-muted">
              The runner checks for work every few seconds. If this doesn&apos;t move, make sure it&apos;s running:{" "}
              <code className="font-mono text-[12px]">seo-autopilot-runner start</code>
            </p>
            {error && <p className="mt-1 text-[12px] text-bad-ink">Couldn&apos;t read status ({error}). Retrying.</p>}
          </div>
        </div>
      ) : job.status === "running" ? (
        <div className="flex items-start gap-3">
          <Spinner size={18} className="mt-0.5 text-accent" />
          <div className="min-w-0">
            <p className="text-[14px] font-medium text-ink">Testing the connection…</p>
            <p className="mt-0.5 truncate text-[13px] text-muted">{lastLog?.message ?? "Decrypting credentials on the runner and calling the site's API."}</p>
          </div>
        </div>
      ) : ok ? (
        <div className="flex items-start gap-3">
          <CircleCheck size={18} aria-hidden className="mt-0.5 text-ok" />
          <div>
            <p className="text-[14px] font-medium text-ok-ink">Connected</p>
            <p className="mt-0.5 text-[13px] text-muted">The runner signed in and can read the site.</p>
            {warnings.length > 0 && (
              <ul className="mt-2 space-y-1 text-[13px] text-approve-ink">
                {warnings.map((w, i) => (
                  <li key={i}>– {w}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <CircleAlert size={18} aria-hidden className="mt-0.5 text-bad" />
          <div>
            <p className="text-[14px] font-medium text-bad-ink">Connection failed</p>
            <p className="mt-0.5 text-[13px] break-words text-ink-2">{job.error ?? (typeof result?.error === "string" ? result.error : "The runner couldn't sign in with these credentials.")}</p>
            <Link href={`/jobs/${job.id}`} className="mt-1.5 inline-block text-[13px] font-medium text-accent-ink underline underline-offset-2">
              See the full log
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
