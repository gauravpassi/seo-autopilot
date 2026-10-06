"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileText } from "lucide-react";
import type { Audit } from "@/lib/types";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { Tabs } from "@/components/ui/tabs";
import { dateTime } from "@/lib/ui/format";

/** react-markdown escapes raw HTML by default (no rehype-raw), so audit output can't inject markup. */
export function ReportTab({ audit }: { audit: Pick<Audit, "id" | "created_at" | "report_md" | "action_plan_md" | "health_score"> | null }) {
  const [which, setWhich] = useState<"plan" | "report">(audit?.action_plan_md ? "plan" : "report");
  if (!audit || (!audit.report_md && !audit.action_plan_md))
    return (
      <Card>
        <EmptyState icon={FileText} title="No report yet">
          Full audits produce a written report and an action plan. Run one from the Overview tab.
        </EmptyState>
      </Card>
    );
  const md = which === "plan" ? audit.action_plan_md : audit.report_md;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs
          label="Report"
          active={which}
          onChange={(v) => setWhich(v as "plan" | "report")}
          items={[
            ...(audit.action_plan_md ? [{ id: "plan", label: "Action plan" }] : []),
            ...(audit.report_md ? [{ id: "report", label: "Full report" }] : []),
          ]}
        />
        <span className="text-[13px] text-muted">Audit from {dateTime(audit.created_at)}</span>
      </div>
      <Card className="px-5 py-4 sm:px-8 sm:py-6">
        <article className="prose-report">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noreferrer noopener nofollow">
                  {children}
                </a>
              ),
              img: ({ alt }) => <span className="text-muted">[image: {alt}]</span>,
            }}
          >
            {md ?? ""}
          </ReactMarkdown>
        </article>
      </Card>
    </div>
  );
}
