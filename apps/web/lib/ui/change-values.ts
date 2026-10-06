/** Helpers to pull display values out of change before/after payloads (shapes vary by type). */
import type { ChangeType } from "@seo-autopilot/core/schema";

export type Obj = Record<string, unknown>;

export function asObj(v: unknown): Obj | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

/** For string-valued types: before may be a string, {value}, null. */
export function textOf(v: unknown, key = "value"): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const o = asObj(v);
  if (o && key in o) return textOf(o[key]);
  return null;
}

export const STRING_TYPES = new Set<ChangeType>(["title", "meta_description", "h1", "canonical", "slug"]);
export const FILE_TYPES = new Set<ChangeType>(["robots_txt", "llms_txt"]);

/** Recommended length ranges used for the counters and the inline editor. */
export const LENGTH_RULES: Partial<Record<ChangeType, { min: number; max: number; hardMax: number; label: string }>> = {
  title: { min: 30, max: 60, hardMax: 120, label: "Aim for 30–60 characters so Google doesn't cut it off" },
  meta_description: { min: 120, max: 155, hardMax: 320, label: "Aim for 120–155 characters" },
  h1: { min: 10, max: 70, hardMax: 200, label: "Keep it short and specific" },
  image_alt: { min: 5, max: 125, hardMax: 250, label: "Describe the image in under 125 characters" },
};

export function lengthVerdict(type: ChangeType, len: number): "ok" | "short" | "long" | "over" | null {
  const r = LENGTH_RULES[type];
  if (!r) return null;
  if (len > r.hardMax) return "over";
  if (len > r.max) return "long";
  if (len < r.min) return "short";
  return "ok";
}

/** Which field the inline editor edits for a type, if editable as text. */
export function editableField(type: ChangeType): { key: string; multiline: boolean } | null {
  switch (type) {
    case "title":
    case "h1":
    case "slug":
    case "canonical":
      return { key: "value", multiline: false };
    case "meta_description":
      return { key: "value", multiline: true };
    case "image_alt":
      return { key: "alt", multiline: true };
    case "robots_txt":
    case "llms_txt":
      return { key: "content", multiline: true };
    default:
      return null;
  }
}

/** One-line summary of what a change does, for compact lists (dashboard, notifications). */
export function summarize(type: ChangeType, after: unknown): string {
  const a = asObj(after) ?? {};
  switch (type) {
    case "title":
    case "meta_description":
    case "h1":
    case "slug":
    case "canonical":
      return String(a.value ?? "");
    case "image_alt":
      return `alt="${String(a.alt ?? "")}"`;
    case "jsonld_add":
    case "jsonld_fix":
      return `${String(a.schema_type ?? "JSON-LD")} markup`;
    case "redirect":
      return `${String(a.from_path ?? "")} → ${String(a.to_url ?? "")}`;
    case "robots_meta":
      return `${a.index === false ? "noindex" : "index"}, ${a.follow === false ? "nofollow" : "follow"}`;
    case "og_tags":
      return String(a.title ?? a.description ?? "Open Graph tags");
    case "internal_link":
      return `“${String(a.anchor ?? "")}” → ${String(a.to_url ?? "")}`;
    case "content_edit":
    case "code_change":
      return String(a.instructions ?? "");
    case "hreflang":
      return `${Array.isArray(a.alternates) ? a.alternates.length : 0} language versions`;
    case "robots_txt":
    case "llms_txt":
      return `${String(a.content ?? "").split("\n").length} lines`;
    default:
      return "";
  }
}
