import { Skeleton } from "@/components/ui/misc";

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading site">
      <div className="flex items-center gap-4">
        <Skeleton className="size-[60px] rounded-full" />
        <div>
          <Skeleton className="h-7 w-56" />
          <Skeleton className="mt-2 h-4 w-72" />
        </div>
      </div>
      <Skeleton className="mt-6 h-10 w-full" />
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <Skeleton className="h-36 md:col-span-2" />
        <Skeleton className="h-36" />
      </div>
      <Skeleton className="mt-4 h-56" />
    </div>
  );
}
