import { cn } from "@/lib/ui/format";

export function Table({ children, className, label }: { children: React.ReactNode; className?: string; label?: string }) {
  return (
    <div className={cn("overflow-x-auto", className)} role="region" aria-label={label} tabIndex={label ? 0 : undefined}>
      <table className="w-full border-collapse text-left text-[14px]">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="border-b border-line text-[12px] font-medium text-muted">
      <tr>{children}</tr>
    </thead>
  );
}

export function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th scope="col" className={cn("px-4 py-2.5 font-medium whitespace-nowrap first:pl-5 last:pr-5", className)}>
      {children}
    </th>
  );
}

export function Tr({ children, className }: { children: React.ReactNode; className?: string }) {
  return <tr className={cn("border-b border-line last:border-0 hover:bg-raised", className)}>{children}</tr>;
}

export function Td({ children, className, colSpan }: { children?: React.ReactNode; className?: string; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={cn("px-4 py-3 align-middle first:pl-5 last:pr-5", className)}>
      {children}
    </td>
  );
}
