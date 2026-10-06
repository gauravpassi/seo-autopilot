"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2, UserPlus } from "lucide-react";
import type { OrgMember, Role } from "@/lib/types";
import { inviteMember, removeMember, updateMemberRole } from "@/app/actions/org";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, inputClass, selectClass } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { cn, timeAgo } from "@/lib/ui/format";
import { ROLE } from "@/lib/ui/labels";

const ROLE_HELP: Record<string, string> = {
  admin: "Manages sites, runners, settings and the team",
  member: "Approves changes and runs jobs",
  viewer: "Sees everything, changes nothing",
};

export function TeamMembers({ members, currentUserId, canEdit }: { members: OrgMember[]; currentUserId: string; canEdit: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member" | "viewer">("member");
  const [err, setErr] = useState<string | null>(null);
  const [remove, setRemove] = useState<OrgMember | null>(null);

  return (
    <section aria-labelledby="team-title">
      <h2 id="team-title" className="mb-3 text-[20px] font-semibold">
        Team
      </h2>
      <Card>
        <CardHeader title={`${members.length} ${members.length === 1 ? "member" : "members"}`} description="Members and above can approve changes from the panel. Chat approvals also need the person in that channel's approver list." />
        <ul className="divide-y divide-line border-t border-line">
          {members.map((mb) => {
            const me = mb.user_id === currentUserId;
            return (
              <li key={mb.user_id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-sunken text-[13px] font-semibold text-ink-2" aria-hidden>
                  {(mb.email ?? "?")[0]?.toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14.5px] font-medium">
                    {mb.email ?? mb.user_id}
                    {me && <span className="ml-2 text-[12.5px] font-normal text-muted">you</span>}
                  </p>
                  <p className="text-[12.5px] text-muted">Joined {timeAgo(mb.created_at)}</p>
                </div>
                {canEdit && !me && mb.role !== "owner" ? (
                  <>
                    <select
                      aria-label={`Role for ${mb.email}`}
                      value={mb.role}
                      disabled={pending}
                      onChange={(e) =>
                        start(async () => {
                          const res = await updateMemberRole(mb.user_id, e.target.value as Role);
                          if (!res.ok) toast({ tone: "error", title: "Couldn't change the role", detail: res.error });
                          else toast({ tone: "success", title: `${mb.email} is now ${ROLE[e.target.value]?.toLowerCase()}` });
                          router.refresh();
                        })
                      }
                      className={cn(selectClass, "h-9 w-48")}
                    >
                      <option value="admin">{ROLE.admin}</option>
                      <option value="member">{ROLE.member}</option>
                      <option value="viewer">{ROLE.viewer}</option>
                    </select>
                    <Button size="sm" variant="ghost" aria-label={`Remove ${mb.email}`} icon={<Trash2 size={15} aria-hidden />} onClick={() => setRemove(mb)} />
                  </>
                ) : (
                  <span className="text-[13px] text-ink-2">{ROLE[mb.role] ?? mb.role}</span>
                )}
              </li>
            );
          })}
        </ul>
        {canEdit && (
          <CardBody className="border-t border-line pt-4">
            <form
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErr("Enter a valid email address");
                setErr(null);
                start(async () => {
                  const res = await inviteMember(email.trim(), role);
                  if (!res.ok) return toast({ tone: "error", title: "Couldn't send the invite", detail: res.error });
                  toast({ tone: "success", title: `Invite sent to ${email.trim()}`, detail: "They join the workspace when they accept it." });
                  setEmail("");
                  router.refresh();
                });
              }}
            >
              <Field label="Invite by email" htmlFor="inv-email" error={err} className="flex-1">
                <input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} placeholder="colleague@upcore.ai" aria-invalid={!!err} />
              </Field>
              <Field label="Role" htmlFor="inv-role" className="sm:w-56">
                <select id="inv-role" value={role} onChange={(e) => setRole(e.target.value as typeof role)} className={selectClass}>
                  {(["admin", "member", "viewer"] as const).map((r) => (
                    <option key={r} value={r}>
                      {ROLE[r]}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="submit" variant="primary" icon={<UserPlus size={16} aria-hidden />} loading={pending}>
                Send invite
              </Button>
            </form>
            <p className="mt-2 text-[12.5px] text-muted">{ROLE_HELP[role]}.</p>
          </CardBody>
        )}
      </Card>
      <Dialog
        open={!!remove}
        onClose={() => setRemove(null)}
        title={`Remove ${remove?.email ?? "member"}?`}
        description="They lose access to this workspace immediately. Their past decisions stay in the activity log."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemove(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={pending}
              onClick={() =>
                start(async () => {
                  if (!remove) return;
                  const res = await removeMember(remove.user_id);
                  if (!res.ok) toast({ tone: "error", title: "Couldn't remove", detail: res.error });
                  else toast({ tone: "success", title: `${remove.email} removed` });
                  setRemove(null);
                  router.refresh();
                })
              }
            >
              Remove
            </Button>
          </>
        }
      />
    </section>
  );
}
