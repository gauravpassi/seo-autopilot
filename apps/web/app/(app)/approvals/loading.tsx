import { Skeleton } from "@/components/ui/misc";

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading approvals">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="mt-3 h-4 w-[28rem] max-w-full" />
      <div className="mt-8 flex flex-col gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-2xl border border-line bg-surface p-5">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="mt-2 h-3.5 w-64" />
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
            <Skeleton className="mt-4 h-10 w-full sm:w-72" />
          </div>
        ))}
      </div>
    </div>
  );
}
