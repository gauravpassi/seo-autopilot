"use client";

import { ApprovalsQueue, type QueueActions } from "@/components/changes/approvals-queue";
import { PREVIEW_NOW, previewChanges, previewSites } from "../fixtures";

const fake: QueueActions = {
  decide: async (ids) => {
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true, decided: ids.length, skipped: 0 };
  },
  edit: async () => ({ ok: true }),
};

export function PreviewQueue() {
  return <ApprovalsQueue changes={previewChanges} sites={previewSites} actions={fake} initialNow={PREVIEW_NOW} />;
}
