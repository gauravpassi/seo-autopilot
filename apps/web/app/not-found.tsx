import Link from "next/link";
import { Logo } from "@/components/shell/logo";

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="text-center">
        <Logo onLight />
        <h1 className="mt-8 text-2xl font-semibold text-ink">Page not found</h1>
        <p className="mt-2 text-[15px] text-muted">It may have been archived, or the link is wrong.</p>
        <Link href="/" className="mt-6 inline-block font-medium text-accent-ink underline underline-offset-4">
          Go to the dashboard
        </Link>
      </div>
    </main>
  );
}
