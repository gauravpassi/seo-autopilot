import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/ui/format";

export function Spinner({ size = 16, className, label }: { size?: number; className?: string; label?: string }) {
  return (
    <LoaderCircle
      size={size}
      className={cn("animate-spin shrink-0", className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "status" : undefined}
    />
  );
}
