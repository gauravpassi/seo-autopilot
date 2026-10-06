import { ExternalLink, SearchCheck } from "lucide-react";
import type { Finding } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { pathOf, timeAgo } from "@/lib/ui/format";
import { SEVERITY } from "@/lib/ui/labels";

const STATUS_LABEL: Record<string, { label: string; tone: "neutral" | "info" | "ok" | "never" }> = {
  open: { label: "Open", tone: "neutral" },
  fix_proposed: { label: "Fix proposed", tone: "info" },
  fixed: { label: "Fixed", tone: "ok" },
  ignored: { label: "Ignored", tone: "never" },
  manual: { label: "Needs a person", tone: "never" },
};

export function FindingsTab({ findings, auditAt }: { findings: Finding[]; auditAt: string | null }) {
  if (!findings.length)
    return (
      <Card>
        <EmptyState icon={SearchCheck} title={auditAt ? "No findings in the latest audit" : "No audit yet"}>
          {auditAt ? "The last audit found nothing to fix." : "Run a full audit from the Overview tab to see what needs attention."}
        </EmptyState>
      </Card>
    );

  const groups = new Map<string, Finding[]>();
  for (const f of findings) groups.set(f.category, [...(groups.get(f.category) ?? []), f]);
  const ordered = [...groups.entries()]
    .map(([cat, list]) => [cat, list.sort((a, b) => (SEVERITY[a.severity]?.rank ?? 9) - (SEVERITY[b.severity]?.rank ?? 9))] as const)
    .sort((a, b) => (SEVERITY[a[1][0].severity]?.rank ?? 9) - (SEVERITY[b[1][0].severity]?.rank ?? 9));
  const sevCount = (s: string) => findings.filter((f) => f.severity === s).length;

  return (
    <div className="space-y-6">
      <p className="flex flex-wrap items-center gap-2 text-[14px] text-muted">
        <span>
          <span className="num font-semibold text-ink">{findings.length}</span> findings from the audit {timeAgo(auditAt)}:
        </span>
        {["Critical", "High", "Medium", "Low"].map((s) =>
          sevCount(s) ? (
            <Badge key={s} tone={SEVERITY[s].tone}>
              {sevCount(s)} {s.toLowerCase()}
            </Badge>
          ) : null,
        )}
      </p>
      {ordered.map(([cat, list]) => (
        <section key={cat} id={`cat-${encodeURIComponent(cat)}`} aria-labelledby={`h-${encodeURIComponent(cat)}`} className="scroll-mt-20">
          <h2 id={`h-${encodeURIComponent(cat)}`} className="mb-2 text-[16px] font-semibold">
            {cat} <span className="num text-[13px] font-normal text-muted">{list.length}</span>
          </h2>
          <Card as="div">
            <ul className="divide-y divide-line">
              {list.map((f) => (
                <li key={f.id} className="px-5 py-3.5">
                  <details className="group">
                    <summary className="flex cursor-pointer list-none items-start gap-3 [&::-webkit-details-marker]:hidden">
                      <Badge tone={SEVERITY[f.severity]?.tone ?? "neutral"} className="mt-0.5 w-[4.5rem] justify-center">
                        {f.severity}
                      </Badge>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[14.5px] font-medium text-ink group-open:text-accent-ink">{f.title}</span>
                        {f.url && <span className="block truncate text-[12.5px] text-muted">{pathOf(f.url)}</span>}
                      </span>
                      <Badge tone={STATUS_LABEL[f.status]?.tone ?? "neutral"} className="hidden sm:inline-flex">
                        {STATUS_LABEL[f.status]?.label ?? f.status}
                      </Badge>
                    </summary>
                    <div className="mt-3 space-y-2 pl-0 text-[14px] leading-relaxed text-ink-2 sm:pl-[5.25rem]">
                      {f.description && <p>{f.description}</p>}
                      {f.recommendation && (
                        <p>
                          <span className="font-semibold text-ink">Recommendation: </span>
                          {f.recommendation}
                        </p>
                      )}
                      {f.url && (
                        <a href={f.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-[13px] text-accent-ink underline underline-offset-2">
                          Open page <ExternalLink size={12} aria-hidden />
                        </a>
                      )}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ))}
    </div>
  );
}
