import { notFound } from "next/navigation";
import { connection } from "next/server";
import { PageHeader } from "@/components/ui/card";
import { AppShell } from "@/components/shell/app-shell";
import { PreviewQueue } from "./preview-queue";
import { previewChanges } from "../fixtures";

export const metadata = { title: "Approvals preview" };

/** Dev-only: the approvals UI with static fixtures, for screenshots and design review. */
export default async function PreviewApprovals() {
  await connection(); // decide at request time, not build time
  if (!(process.env.NODE_ENV !== "production" || process.env.ENABLE_PREVIEW === "1")) notFound();
  return (
    <AppShell orgName="Upcore Technologies" email="saswata@upcore.ai" role="admin" pendingCount={previewChanges.length} preview>
      <PageHeader
        title="Approvals"
        description="Each card shows exactly what will change on the live site, why, and what the risk check found. Nothing is applied until someone approves it."
      />
      <PreviewQueue />
    </AppShell>
  );
}
