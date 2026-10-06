"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mail } from "lucide-react";
import { createBrowserClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/misc";
import { Tabs } from "@/components/ui/tabs";

type Mode = "signin" | "signup" | "magic";

export function LoginForm({ next = "/" }: { next?: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const supabase = createBrowserClient();
      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(safeNext)}`;
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.replace(safeNext);
        router.refresh();
        return;
      }
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } });
        if (error) throw error;
        if (data.session) {
          router.replace("/onboarding");
          router.refresh();
          return;
        }
        setNotice(`We sent a confirmation link to ${email}. Open it on this device to finish creating your account.`);
      } else {
        const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
        if (error) throw error;
        setNotice(`Check ${email} for a sign-in link. It works once and expires in an hour.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Sign-in failed";
      setError(
        /invalid login/i.test(msg)
          ? "That email and password don't match an account. Check both, or use a magic link."
          : /email not confirmed/i.test(msg)
            ? "Confirm your email first: open the link we sent when you signed up."
            : msg,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Tabs
        label="Sign-in method"
        active={mode}
        onChange={(m) => {
          setMode(m as Mode);
          setError(null);
          setNotice(null);
        }}
        items={[
          { id: "signin", label: "Sign in" },
          { id: "signup", label: "Create account" },
          { id: "magic", label: "Magic link" },
        ]}
      />
      <form onSubmit={submit} className="mt-6 flex flex-col gap-4" noValidate={false}>
        <Field label="Work email" htmlFor="email">
          <input
            id="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
            placeholder="you@company.com"
          />
        </Field>
        {mode !== "magic" && (
          <Field
            label="Password"
            htmlFor="password"
            hint={mode === "signup" ? "At least 8 characters." : undefined}
          >
            <input
              id="password"
              type="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              required
              minLength={mode === "signup" ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </Field>
        )}
        {error && (
          <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-[13px] font-medium text-bad-ink">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="flex gap-2 rounded-lg bg-accent-soft px-3 py-2.5 text-[13px] text-accent-ink">
            <Mail size={16} aria-hidden className="mt-0.5 shrink-0" />
            {notice}
          </p>
        )}
        <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-1 w-full">
          {mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Email me a link"}
        </Button>
      </form>
    </div>
  );
}
