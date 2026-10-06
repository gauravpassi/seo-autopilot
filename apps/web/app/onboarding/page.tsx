import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getMembership, getUser } from "@/lib/auth";
import { Logo } from "@/components/shell/logo";
import { OnboardingForm } from "./onboarding-form";

export const metadata: Metadata = { title: "Set up your workspace" };

export default async function OnboardingPage() {
  const user = await getUser();
  if (!user) redirect("/login");
  if (await getMembership()) redirect("/");
  return (
    <main className="flex min-h-dvh flex-col px-5 py-8 sm:px-10">
      <Logo onLight />
      <div className="mx-auto my-auto w-full max-w-md py-10">
        <p className="text-[13px] font-medium text-accent-ink">Signed in as {user.email}</p>
        <h1 className="mt-2 text-[28px] leading-tight font-semibold text-ink">Name your workspace</h1>
        <p className="mt-2 text-[15px] text-muted">
          Sites, runners and approvers live inside a workspace. You&apos;ll be its owner and can invite your team next.
        </p>
        <OnboardingForm />
        <ol className="mt-10 space-y-3 border-t border-line pt-6 text-[14px] text-ink-2">
          <li className="flex gap-3">
            <span className="num grid size-6 shrink-0 place-items-center rounded-full bg-navy text-[12px] text-paper">1</span>
            Create the workspace
          </li>
          <li className="flex gap-3 text-muted">
            <span className="num grid size-6 shrink-0 place-items-center rounded-full bg-sunken text-[12px] ring-1 ring-line">2</span>
            Connect a runner on the computer that has Claude Code
          </li>
          <li className="flex gap-3 text-muted">
            <span className="num grid size-6 shrink-0 place-items-center rounded-full bg-sunken text-[12px] ring-1 ring-line">3</span>
            Add your first site and run an audit
          </li>
        </ol>
      </div>
    </main>
  );
}
