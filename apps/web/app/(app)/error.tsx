"use client";

import { useEffect } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="mx-auto mt-10 max-w-lg rounded-2xl border border-line bg-surface p-8 text-center shadow-card">
      <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-bad-soft text-bad">
        <CircleAlert size={22} aria-hidden />
      </div>
      <h1 className="text-xl font-semibold text-ink">This page didn&apos;t load</h1>
      <p className="mt-2 text-[14px] text-muted">
        The panel couldn&apos;t read data from the server. Check your connection and try again. If it keeps happening, share
        this reference with whoever runs the panel.
      </p>
      {error.digest && <p className="mt-3 font-mono text-[12px] text-muted">Reference {error.digest}</p>}
      <Button variant="primary" className="mt-6" onClick={() => retry()} icon={<RefreshCw size={16} aria-hidden />}>
        Try again
      </Button>
    </div>
  );
}
