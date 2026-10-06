"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/ui/format";

export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked: user can still select the text */
        }
      }}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-ink-2 hover:bg-sunken hover:text-ink",
        className,
      )}
      aria-label={done ? "Copied" : `${label} to clipboard`}
    >
      {done ? <Check size={14} aria-hidden className="text-ok-ink" /> : <Copy size={14} aria-hidden />}
      {done ? "Copied" : label}
    </button>
  );
}

export function CodeBlock({
  code,
  className,
  copy = true,
  caption,
  wrap,
  maxHeight,
}: {
  code: string;
  className?: string;
  copy?: boolean;
  caption?: string;
  wrap?: boolean;
  maxHeight?: number;
}) {
  return (
    <div className={cn("overflow-hidden rounded-lg border border-line bg-sunken", className)}>
      {(caption || copy) && (
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1">
          <span className="truncate text-[12px] text-muted">{caption}</span>
          {copy && <CopyButton value={code} />}
        </div>
      )}
      <pre
        className={cn(
          "overflow-auto px-3.5 py-3 font-mono text-[12.5px] leading-relaxed text-ink",
          wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre",
        )}
        style={maxHeight ? { maxHeight } : undefined}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
