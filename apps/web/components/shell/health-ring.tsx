import { cn, healthTone } from "@/lib/ui/format";

/** Circular health score. Text always carries the number; colour is only reinforcement. */
export function HealthRing({ score, size = 56, className }: { score: number | null | undefined; size?: number; className?: string }) {
  const tone = healthTone(score);
  const stroke = { ok: "var(--ok)", approve: "var(--approve)", bad: "var(--bad)", neutral: "var(--line-strong)" }[tone];
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const pct = score === null || score === undefined ? 0 : Math.max(0, Math.min(100, score)) / 100;
  return (
    <div
      className={cn("relative grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={score === null || score === undefined ? "No health score yet" : `Health score ${score} out of 100`}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--sunken)" strokeWidth={5} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={stroke}
          strokeWidth={5}
          strokeLinecap="round"
          strokeDasharray={`${c * pct} ${c}`}
        />
      </svg>
      <span className="num absolute text-[15px] font-semibold text-ink" style={{ fontSize: size * 0.3 }} aria-hidden>
        {score ?? "–"}
      </span>
    </div>
  );
}

/** Tiny inline trend line for health over audits. */
export function Sparkline({ values, width = 220, height = 48 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 100);
  const x = (i: number) => (i / (values.length - 1)) * (width - 8) + 4;
  const y = (v: number) => height - 4 - ((v - min) / (max - min || 1)) * (height - 8);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="block" aria-hidden style={{ height }}>
      <path d={`${d} L${x(values.length - 1)},${height} L${x(0)},${height} Z`} fill="var(--accent)" opacity="0.08" />
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r="3" fill="var(--accent)" />
    </svg>
  );
}
