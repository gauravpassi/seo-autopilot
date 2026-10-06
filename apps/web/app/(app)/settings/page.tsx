import type { Metadata } from "next";
import { requireMember } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getChannelsForEdit } from "@/app/actions/settings";
import type { ChannelsView, OrgMember } from "@/lib/types";
import { PageHeader } from "@/components/ui/card";
import { ChannelsForm } from "@/components/settings/channels-form";
import { TeamMembers } from "@/components/settings/team-members";
import { appUrl } from "@/lib/ui/app-url";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const m = await requireMember();
  const supabase = await createClient();
  const [channelsRes, { data: members }, url] = await Promise.all([
    getChannelsForEdit(),
    supabase.from("org_members").select("*").eq("org_id", m.orgId).order("created_at"),
    appUrl(),
  ]);
  const isAdmin = m.role === "owner" || m.role === "admin";

  return (
    <>
      <PageHeader title="Settings" description="Where approval requests go, who may approve them, and who's on the team." />
      {channelsRes.ok ? (
        <ChannelsForm initial={channelsRes.channels as ChannelsView} appUrl={url} canEdit={isAdmin} />
      ) : (
        <p role="alert" className="rounded-lg bg-bad-soft px-4 py-3 text-[14px] text-bad-ink">
          Couldn&apos;t load notification settings: {channelsRes.error}
        </p>
      )}
      <div className="mt-10">
        <TeamMembers members={(members ?? []) as OrgMember[]} currentUserId={m.user.id} canEdit={isAdmin} />
      </div>
    </>
  );
}
