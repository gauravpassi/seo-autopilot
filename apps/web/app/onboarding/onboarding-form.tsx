"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { bootstrapOrg } from "@/app/actions/org";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/misc";

type State = { error: string | null };

export function OnboardingForm() {
  const router = useRouter();
  const [state, action, pending] = useActionState<State, FormData>(async (_prev, fd) => {
    const name = String(fd.get("name") ?? "").trim();
    if (name.length < 2) return { error: "Enter at least 2 characters." };
    const res = await bootstrapOrg(name);
    if (!res.ok) return { error: res.error };
    router.replace("/runners?welcome=1");
    router.refresh();
    return { error: null };
  }, { error: null });

  return (
    <form action={action} className="mt-8 flex flex-col gap-4">
      <Field label="Workspace name" htmlFor="name" error={state.error} hint="Usually your company name. You can change it later.">
        <input
          id="name"
          name="name"
          required
          minLength={2}
          maxLength={80}
          defaultValue="Upcore Technologies"
          className={inputClass}
          aria-invalid={!!state.error}
          autoFocus
        />
      </Field>
      <Button type="submit" variant="primary" size="lg" loading={pending}>
        Create workspace
      </Button>
    </form>
  );
}
