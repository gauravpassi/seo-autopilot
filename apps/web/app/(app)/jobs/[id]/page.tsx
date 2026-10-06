import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireMember } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Job, JobLog } from "@/lib/types";
import { JobDetail } from "@/components/jobs/job-detail";

export const metadata: Metadata = { title: "Job" };

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = await requireMember();
  const supabase = await createClient();
  const { data: job } = await supabase.from("jobs").select("*").eq("id", id).eq("org_id", m.orgId).maybeSingle();
  if (!job) notFound();
  const [{ data: logs }, { data: site }] = await Promise.all([
    supabase.from("job_logs").select("*").eq("job_id", id).order("id", { ascending: true }).limit(2000),
    (job as Job).site_id ? supabase.from("sites").select("id, name").eq("id", (job as Job).site_id!).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  return (
    <>
      <Link href="/jobs" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink">
        <ChevronLeft size={15} aria-hidden /> All jobs
      </Link>
      <JobDetail
        initialJob={job as Job}
        initialLogs={(logs ?? []) as JobLog[]}
        site={site as { id: string; name: string } | null}
        canEdit={m.role !== "viewer"}
      />
    </>
  );
}
