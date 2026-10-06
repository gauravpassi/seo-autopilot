import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";
import { Logo } from "@/components/shell/logo";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  return (
    <main className="grid min-h-dvh lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      {/* Left: what the product does, shown as the thing itself — an approval card */}
      <section
        aria-label="About SEO Autopilot"
        className="relative hidden overflow-hidden bg-[#0a1a33] px-12 py-12 text-white lg:flex lg:flex-col"
      >
        <Logo />
        <div className="my-auto max-w-[30rem]">
          <h1 className="font-[family-name:var(--font-space-grotesk)] text-[40px] leading-[1.08] font-semibold tracking-[-0.03em]">
            The agent does the SEO work. You decide what ships.
          </h1>
          <p className="mt-4 max-w-[42ch] text-[16px] leading-relaxed text-white/65">
            It audits every client site, proposes exact fixes, applies the safe ones and checks them on the live page.
            Anything risky waits for you.
          </p>

          <figure className="mt-10 rounded-2xl bg-white/[0.06] p-5 ring-1 ring-white/10" aria-label="Example approval">
            <div className="flex items-center justify-between gap-3">
              <p className="font-[family-name:var(--font-space-grotesk)] text-[15px] font-semibold">Page title</p>
              <span className="rounded-full bg-[#f5b740]/15 px-2 py-0.5 text-[12px] font-medium text-[#fcd48a] ring-1 ring-[#f5b740]/30">
                Needs approval
              </span>
            </div>
            <p className="mt-0.5 text-[13px] text-white/50">/collections/stoneware-dinner-sets</p>
            <div className="mt-4 space-y-2 text-[14px] leading-relaxed">
              <p className="rounded-lg bg-white/[0.04] px-3 py-2 text-white/60">
                <del className="rounded bg-[#f87171]/20 px-0.5 text-[#fca5a5]">Stoneware Dinner Sets – Kiran Ceramics – Buy Online – Best Price in India</del>
              </p>
              <p className="rounded-lg bg-white/[0.04] px-3 py-2 ring-1 ring-[#22d3ee]/40">
                <ins className="rounded bg-[#34d07a]/15 px-0.5 text-[#a6f0c4] no-underline">Handmade Stoneware Dinner Sets | Kiran Ceramics</ins>
              </p>
            </div>
            <figcaption className="mt-3 text-[12.5px] text-white/50">
              <span className="font-[family-name:var(--font-space-grotesk)] text-white/80 tabular-nums">72 → 49</span> characters ·
              no longer cut off in results
            </figcaption>
          </figure>
        </div>
        <p className="text-[12.5px] text-white/40">Upcore Technologies · internal tool</p>
        <div
          aria-hidden
          className="pointer-events-none absolute -right-40 -bottom-40 size-[28rem] rounded-full border border-[#22d3ee]/10"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -bottom-24 size-[20rem] rounded-full border border-[#22d3ee]/15"
        />
      </section>

      {/* Right: the form */}
      <section className="flex flex-col px-5 py-10 sm:px-10">
        <div className="lg:hidden">
          <Logo onLight />
        </div>
        <div className="mx-auto my-auto w-full max-w-sm pt-10 lg:pt-0">
          <h2 className="text-[26px] font-semibold text-ink">Sign in to the panel</h2>
          <p className="mt-1.5 mb-7 text-[14px] text-muted">Use your Upcore work email. New teammates get access once an admin invites them.</p>
          {error && (
            <p role="alert" className="mb-5 rounded-lg bg-bad-soft px-3 py-2 text-[13px] font-medium text-bad-ink">
              {error === "auth" ? "That sign-in link is invalid or has expired. Request a new one." : error}
            </p>
          )}
          <LoginForm next={next} />
        </div>
      </section>
    </main>
  );
}
