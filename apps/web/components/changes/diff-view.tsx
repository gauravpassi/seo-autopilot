import { ArrowRight, ImageOff } from "lucide-react";
import type { ChangeType } from "@seo-autopilot/core/schema";
import { cn } from "@/lib/ui/format";
import { changedJsonPaths, diffLines, diffWords, foldLines, sideOps, type DiffOp } from "@/lib/ui/diff";
import { LENGTH_RULES, asObj, lengthVerdict, textOf, type Obj } from "@/lib/ui/change-values";

/* ------------------------------------------------------------------ shared bits */

function Side({
  label,
  tone,
  children,
  meta,
}: {
  label: string;
  tone: "before" | "after";
  children: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className={cn("text-[12px] font-medium", tone === "before" ? "text-muted" : "text-ink")}>{label}</span>
        {meta}
      </div>
      <div
        className={cn(
          "rounded-lg border px-3 py-2.5 text-[14.5px] leading-relaxed break-words",
          tone === "before" ? "border-line bg-sunken/60 text-ink-2" : "border-accent/40 bg-surface text-ink",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function Empty({ children = "Nothing set today" }: { children?: React.ReactNode }) {
  return <span className="text-muted italic">{children}</span>;
}

export function LengthMeter({ type, text }: { type: ChangeType; text: string | null }) {
  const rule = LENGTH_RULES[type];
  if (!rule || text === null) return null;
  const len = [...text].length;
  const v = lengthVerdict(type, len);
  const tone = v === "ok" ? "text-ok-ink" : v === "over" ? "text-bad-ink" : "text-approve-ink";
  const word = v === "ok" ? "good length" : v === "short" ? "short" : v === "long" ? "may be cut off" : "too long";
  return (
    <span className={cn("num text-[12px] font-medium", tone)} title={rule.label}>
      {len} chars · {word}
    </span>
  );
}

function WordDiff({ ops, side }: { ops: DiffOp[]; side: "before" | "after" }) {
  return (
    <>
      {sideOps(ops, side).map((o, i) => {
        if (o.op === "eq") return <span key={i}>{o.text}</span>;
        if (o.op === "del" && side === "before")
          return (
            <del key={i} className="rounded-[3px] bg-del-bg px-0.5 text-del-ink decoration-del-ink/60">
              {o.text}
            </del>
          );
        if (o.op === "ins" && side === "after")
          return (
            <ins key={i} className="rounded-[3px] bg-ins-bg px-0.5 text-ins-ink no-underline">
              {o.text}
            </ins>
          );
        return null;
      })}
    </>
  );
}

/* ------------------------------------------------------------------ string diff */

export function StringDiff({ type, before, after }: { type: ChangeType; before: string | null; after: string | null }) {
  const ops = diffWords(before ?? "", after ?? "");
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-stretch">
      <Side label="Now" tone="before" meta={<LengthMeter type={type} text={before} />}>
        {before ? <WordDiff ops={ops} side="before" /> : <Empty />}
      </Side>
      <div className="hidden items-center pt-6 text-muted md:flex" aria-hidden>
        <ArrowRight size={16} />
      </div>
      <Side label="Proposed" tone="after" meta={<LengthMeter type={type} text={after} />}>
        {after ? <WordDiff ops={ops} side="after" /> : <Empty>Removed</Empty>}
      </Side>
    </div>
  );
}

/* ------------------------------------------------------------------ line diff (robots.txt, llms.txt) */

export function LineDiff({ before, after, maxHeight = 320 }: { before: string | null; after: string; maxHeight?: number }) {
  const ops = foldLines(diffLines(before ?? "", after), 3);
  const added = ops.filter((o) => o.op === "ins").length;
  const removed = ops.filter((o) => o.op === "del").length;
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex items-center gap-3 border-b border-line bg-sunken px-3 py-1.5 text-[12px]">
        <span className="num font-medium text-ins-ink">+{added}</span>
        <span className="num font-medium text-del-ink">−{removed}</span>
        {!before && <span className="text-muted">New file</span>}
      </div>
      <div className="overflow-auto bg-surface font-mono text-[12.5px] leading-[1.6]" style={{ maxHeight }}>
        <table className="w-full border-collapse">
          <tbody>
            {ops.map((o, i) =>
              o.op === "fold" ? (
                <tr key={i}>
                  <td colSpan={3} className="bg-sunken/70 px-3 py-0.5 text-[11.5px] text-muted">
                    {o.count} unchanged {o.count === 1 ? "line" : "lines"}
                  </td>
                </tr>
              ) : (
                <tr key={i} className={o.op === "del" ? "bg-del-bg/70" : o.op === "ins" ? "bg-ins-bg/70" : undefined}>
                  <td className="w-8 px-2 text-right align-top text-muted/70 select-none">{o.op === "ins" ? "" : o.a}</td>
                  <td
                    className={cn(
                      "w-5 text-center align-top select-none",
                      o.op === "del" ? "text-del-ink" : o.op === "ins" ? "text-ins-ink" : "text-muted/50",
                    )}
                    aria-label={o.op === "del" ? "removed" : o.op === "ins" ? "added" : undefined}
                  >
                    {o.op === "del" ? "−" : o.op === "ins" ? "+" : ""}
                  </td>
                  <td
                    className={cn(
                      "pr-3 break-all whitespace-pre-wrap",
                      o.op === "del" ? "text-del-ink" : o.op === "ins" ? "text-ins-ink" : "text-ink-2",
                    )}
                  >
                    {o.line || " "}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ JSON-LD */

function JsonNode({
  value,
  path,
  added,
  changed,
  indent,
  keyName,
  last,
}: {
  value: unknown;
  path: string;
  added: Set<string>;
  changed: Set<string>;
  indent: number;
  keyName?: string;
  last: boolean;
}) {
  const isAdded = added.has(path);
  const isChanged = changed.has(path);
  const pad = { paddingLeft: `${indent * 1.1 + 1}rem` };
  const keyEl =
    keyName !== undefined ? (
      <>
        <span className="text-accent-ink">&quot;{keyName}&quot;</span>
        <span className="text-muted">: </span>
      </>
    ) : null;
  const comma = last ? "" : ",";
  const mark = isAdded ? "bg-ins-bg/80" : isChanged ? "bg-approve-soft" : "";
  const gutter = isAdded ? "+" : isChanged ? "~" : "";

  if (value && typeof value === "object") {
    const isArr = Array.isArray(value);
    const entries: Array<[string | undefined, unknown, string]> = isArr
      ? (value as unknown[]).map((v, i) => [undefined, v, `${path}[${i}]`])
      : Object.entries(value as Obj).map(([k, v]) => [k, v, path ? `${path}.${k}` : k]);
    return (
      <>
        <div className={cn("relative", mark)} style={pad}>
          {gutter && <Gutter g={gutter} />}
          {keyEl}
          <span className="text-muted">{isArr ? "[" : "{"}</span>
        </div>
        {entries.map(([k, v, p], i) => (
          <JsonNode
            key={p}
            value={v}
            path={p}
            keyName={k}
            added={isAdded ? new Set([...added, p]) : added}
            changed={changed}
            indent={indent + 1}
            last={i === entries.length - 1}
          />
        ))}
        <div className={cn(mark)} style={pad}>
          <span className="text-muted">
            {isArr ? "]" : "}"}
            {comma}
          </span>
        </div>
      </>
    );
  }
  const lit =
    typeof value === "string" ? (
      <span className="text-ins-ink/90 dark:text-ink">&quot;{value}&quot;</span>
    ) : (
      <span className="text-approve-ink">{String(value)}</span>
    );
  return (
    <div className={cn("relative", mark)} style={pad}>
      {gutter && <Gutter g={gutter} />}
      {keyEl}
      {lit}
      <span className="text-muted">{comma}</span>
    </div>
  );
}

function Gutter({ g }: { g: string }) {
  return (
    <span
      className={cn("absolute left-0 w-3 text-center select-none", g === "+" ? "text-ins-ink" : "text-approve-ink")}
      aria-label={g === "+" ? "added" : "changed"}
    >
      {g}
    </span>
  );
}

export function JsonLdDiff({ before, after }: { before: unknown; after: unknown }) {
  const a = asObj(after) ?? {};
  const schema = a.schema ?? after;
  const b = asObj(before);
  const beforeSchema = b && "schema" in b ? b.schema : before;
  const { added, changed } = changedJsonPaths(beforeSchema, schema);
  const isNew = beforeSchema === null || beforeSchema === undefined || (asObj(beforeSchema) && Object.keys(asObj(beforeSchema)!).length === 0);
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-sunken px-3 py-1.5 text-[12px] text-muted">
        <span>
          <span className="font-medium text-ink">{String(a.schema_type ?? "JSON-LD")}</span>
          {typeof a.replaces_type === "string" && <> replaces {a.replaces_type}</>}
        </span>
        {isNew ? (
          <span>New block</span>
        ) : (
          <span className="num">
            <span className="text-ins-ink">+{added.size} added</span> · <span className="text-approve-ink">{changed.size} changed</span>
          </span>
        )}
      </div>
      <pre className="max-h-80 overflow-auto bg-surface py-2 pr-3 pl-1 font-mono text-[12.5px] leading-[1.6]">
        <JsonNode
          value={schema}
          path=""
          added={isNew ? new Set([""]) : added}
          changed={changed}
          indent={0}
          last
        />
      </pre>
    </div>
  );
}

/* ------------------------------------------------------------------ type-specific views */

function ImageAltDiff({ before, after }: { before: unknown; after: unknown }) {
  const a = asObj(after) ?? {};
  const src = String(a.src ?? "");
  const beforeAlt = textOf(before, "alt");
  const afterAlt = textOf(after, "alt");
  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <figure className="shrink-0 sm:w-36">
        {src ? (
          /* eslint-disable-next-line @next/next/no-img-element -- arbitrary client-site images */
          <img
            src={src}
            alt={afterAlt ?? ""}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="aspect-[4/3] w-full rounded-lg border border-line bg-sunken object-cover"
          />
        ) : (
          <div className="grid aspect-[4/3] w-full place-items-center rounded-lg border border-line bg-sunken text-muted">
            <ImageOff size={20} aria-hidden />
          </div>
        )}
        <figcaption className="mt-1 truncate font-mono text-[11px] text-muted" title={src}>
          {src.split("?")[0].split("/").pop()}
        </figcaption>
      </figure>
      <div className="min-w-0 flex-1">
        <StringDiff type="image_alt" before={beforeAlt} after={afterAlt} />
      </div>
    </div>
  );
}

function RedirectView({ after }: { after: unknown }) {
  const a = asObj(after) ?? {};
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3 sm:flex-row sm:items-center sm:gap-3">
      <code className="min-w-0 rounded bg-sunken px-2 py-1 font-mono text-[13px] break-all text-ink-2">{String(a.from_path ?? "")}</code>
      <span className="flex items-center gap-1.5 text-[12px] text-muted">
        <ArrowRight size={14} aria-hidden className="rotate-90 sm:rotate-0" />
        <span className="num font-medium text-ink">{String(a.code ?? 301)}</span>
        <span className="sr-only">redirects to</span>
      </span>
      <code className="min-w-0 rounded bg-accent-soft px-2 py-1 font-mono text-[13px] break-all text-accent-ink">{String(a.to_url ?? "")}</code>
    </div>
  );
}

function RobotsMetaView({ before, after }: { before: unknown; after: unknown }) {
  const fmt = (v: unknown) => {
    const o = asObj(v);
    if (!o) return typeof v === "string" ? v : null;
    return `${o.index === false ? "noindex" : "index"}, ${o.follow === false ? "nofollow" : "follow"}`;
  };
  const b = fmt(before);
  const a = fmt(after) ?? "";
  return (
    <div className="flex flex-col gap-3 md:flex-row">
      <Side label="Now" tone="before">
        {b ? <code className="font-mono text-[13px]">{b}</code> : <Empty>Not set (index, follow)</Empty>}
      </Side>
      <Side label="Proposed" tone="after">
        <code className={cn("font-mono text-[13px]", a.includes("noindex") && "font-semibold text-bad-ink")}>{a}</code>
      </Side>
    </div>
  );
}

function FieldsDiff({ type, before, after, fields }: { type: ChangeType; before: unknown; after: unknown; fields: string[] }) {
  const b = asObj(before) ?? {};
  const a = asObj(after) ?? {};
  return (
    <div className="flex flex-col gap-4">
      {fields
        .filter((f) => a[f] !== undefined || b[f] !== undefined)
        .map((f) => (
          <div key={f}>
            <div className="mb-1.5 text-[12px] font-semibold text-ink-2 capitalize">{f.replace(/_/g, " ")}</div>
            <StringDiff
              type={f === "title" ? "title" : f === "description" ? "meta_description" : type}
              before={b[f] === undefined ? null : String(b[f])}
              after={a[f] === undefined ? null : String(a[f])}
            />
          </div>
        ))}
    </div>
  );
}

function ProseView({ after }: { after: unknown }) {
  const a = asObj(after) ?? {};
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-accent/40 bg-surface px-3 py-2.5 text-[14.5px] leading-relaxed whitespace-pre-wrap text-ink">
        {String(a.instructions ?? "")}
      </div>
      {(typeof a.find === "string" || typeof a.replace === "string") && (
        <StringDiff type="content_edit" before={typeof a.find === "string" ? a.find : null} after={typeof a.replace === "string" ? a.replace : null} />
      )}
      {Array.isArray(a.files_hint) && a.files_hint.length > 0 && (
        <p className="text-[12.5px] text-muted">
          Likely files:{" "}
          {(a.files_hint as string[]).map((f) => (
            <code key={f} className="mr-1.5 rounded bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-2">
              {f}
            </code>
          ))}
        </p>
      )}
    </div>
  );
}

function InternalLinkView({ after }: { after: unknown }) {
  const a = asObj(after) ?? {};
  return (
    <div className="rounded-lg border border-line bg-surface p-3 text-[14px] leading-relaxed">
      {typeof a.near_text === "string" && <p className="mb-2 text-[13px] text-muted">Near: “{a.near_text}”</p>}
      <p>
        Link{" "}
        <ins className="rounded-[3px] bg-ins-bg px-1 text-ins-ink underline decoration-ins-ink/50 underline-offset-2">
          {String(a.anchor ?? "")}
        </ins>{" "}
        to <code className="font-mono text-[13px] break-all text-accent-ink">{String(a.to_url ?? "")}</code>
      </p>
    </div>
  );
}

function HreflangView({ before, after }: { before: unknown; after: unknown }) {
  const list = (v: unknown) => {
    const o = asObj(v);
    const arr = (o?.alternates ?? (Array.isArray(v) ? v : [])) as Array<{ lang?: string; url?: string; href?: string }>;
    return arr.map((x) => `${x.lang ?? ""}  ${x.url ?? x.href ?? ""}`).join("\n");
  };
  return <LineDiff before={list(before) || null} after={list(after)} />;
}

/* ------------------------------------------------------------------ entry */

export function DiffView({ type, before, after }: { type: ChangeType; before: unknown; after: unknown }) {
  switch (type) {
    case "title":
    case "meta_description":
    case "h1":
    case "canonical":
    case "slug":
      return <StringDiff type={type} before={textOf(before)} after={textOf(after)} />;
    case "image_alt":
      return <ImageAltDiff before={before} after={after} />;
    case "jsonld_add":
    case "jsonld_fix":
      return <JsonLdDiff before={before} after={after} />;
    case "robots_txt":
    case "llms_txt":
      return <LineDiff before={textOf(before, "content")} after={textOf(after, "content") ?? ""} />;
    case "redirect":
      return <RedirectView after={after} />;
    case "robots_meta":
      return <RobotsMetaView before={before} after={after} />;
    case "og_tags":
      return <FieldsDiff type={type} before={before} after={after} fields={["title", "description", "image"]} />;
    case "content_edit":
    case "code_change":
      return <ProseView after={after} />;
    case "internal_link":
      return <InternalLinkView after={after} />;
    case "hreflang":
      return <HreflangView before={before} after={after} />;
    default:
      return (
        <pre className="overflow-auto rounded-lg bg-sunken p-3 font-mono text-[12px]">{JSON.stringify({ before, after }, null, 2)}</pre>
      );
  }
}
