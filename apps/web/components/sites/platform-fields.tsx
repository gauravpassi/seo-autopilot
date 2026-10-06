"use client";

import { Download, ExternalLink, KeyRound } from "lucide-react";
import type { Platform } from "@seo-autopilot/core/schema";
import { Field, inputClass, selectClass } from "@/components/ui/misc";
import { buttonClass } from "@/components/ui/button";

export type Creds = Record<string, string>;

export const SHOPIFY_SCOPES = [
  "read_products, write_products",
  "read_content, write_content",
  "read_online_store_pages, write_online_store_pages",
  "read_themes, write_themes",
  "read_online_store_navigation, write_online_store_navigation",
  "read_files, write_files",
];

/** Turn the form into the SiteSecrets JSON (encrypted) and the non-secret SiteConfig (stored). */
export function splitCreds(platform: Platform, c: Creds): { secrets: Record<string, unknown>; config: Record<string, unknown>; hint: string } {
  switch (platform) {
    case "wordpress":
      return {
        secrets: { platform, username: c.username?.trim(), app_password: c.app_password?.replace(/\s+/g, " ").trim() },
        config: {},
        hint: `Application password for ${c.username?.trim()}`,
      };
    case "shopify": {
      const shop = (c.shop ?? "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      const secrets: Record<string, unknown> = { platform, shop };
      if (c.auth === "client") {
        secrets.client_id = c.client_id?.trim();
        secrets.client_secret = c.client_secret?.trim();
      } else secrets.access_token = c.access_token?.trim();
      return { secrets, config: {}, hint: c.auth === "client" ? `Client credentials for ${shop}` : `Admin API token for ${shop}` };
    }
    case "repo": {
      const secrets: Record<string, unknown> = { platform, github_token: c.github_token?.trim() };
      if (c.vercel_bypass_secret?.trim()) secrets.vercel_bypass_secret = c.vercel_bypass_secret.trim();
      return {
        secrets,
        config: {
          repo: c.repo?.trim(),
          branch: c.branch?.trim() || "main",
          build_command: c.build_command?.trim() || undefined,
          framework: c.framework || undefined,
        },
        hint: `GitHub token for ${c.repo?.trim()}`,
      };
    }
    default:
      return { secrets: { platform: "other" }, config: {}, hint: "No credentials" };
  }
}

export function validateCreds(platform: Platform, c: Creds): Record<string, string> {
  const e: Record<string, string> = {};
  if (platform === "wordpress") {
    if (!c.username?.trim()) e.username = "Enter the WordPress username.";
    if (!c.app_password?.trim()) e.app_password = "Paste the application password.";
    else if (c.app_password.replace(/\s/g, "").length < 20) e.app_password = "Application passwords are 24 characters (spaces are fine).";
  }
  if (platform === "shopify") {
    if (!/^[a-z0-9-]+\.myshopify\.com$/i.test((c.shop ?? "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "")))
      e.shop = "Use the store's myshopify.com domain, e.g. kiran-ceramics.myshopify.com.";
    if (c.auth === "client") {
      if (!c.client_id?.trim()) e.client_id = "Enter the client ID.";
      if (!c.client_secret?.trim()) e.client_secret = "Enter the client secret.";
    } else if (!c.access_token?.trim()) e.access_token = "Paste the Admin API access token (starts with shpat_).";
  }
  if (platform === "repo") {
    if (!/^[\w.-]+\/[\w.-]+$/.test(c.repo?.trim() ?? "")) e.repo = "Use owner/name, e.g. upcore/marketing-site.";
    if (!c.github_token?.trim()) e.github_token = "Paste a fine-grained GitHub token.";
  }
  return e;
}

function Steps({ children }: { children: React.ReactNode }) {
  return <ol className="list-decimal space-y-1.5 pl-5 text-[13.5px] leading-relaxed text-ink-2 marker:text-muted">{children}</ol>;
}

function Help({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <aside className="rounded-xl border border-line bg-raised p-4">
      <h3 className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-ink">
        <KeyRound size={15} aria-hidden className="text-accent-ink" />
        {title}
      </h3>
      {children}
    </aside>
  );
}

export function PlatformFields({
  platform,
  creds,
  set,
  errors,
  siteUrl,
}: {
  platform: Platform;
  creds: Creds;
  set: (k: string, v: string) => void;
  errors: Record<string, string>;
  siteUrl: string;
}) {
  const input = (k: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input
      id={`cred-${k}`}
      value={creds[k] ?? ""}
      onChange={(e) => set(k, e.target.value)}
      aria-invalid={!!errors[k]}
      className={inputClass}
      autoComplete="off"
      spellCheck={false}
      {...props}
    />
  );
  const origin = siteUrl.replace(/\/$/, "");

  if (platform === "wordpress")
    return (
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col gap-4">
          <Field label="WordPress username" htmlFor="cred-username" error={errors.username} hint="Best practice: a dedicated user such as seo-agent with the Editor role.">
            {input("username", { placeholder: "seo-agent" })}
          </Field>
          <Field label="Application password" htmlFor="cred-app_password" error={errors.app_password} hint="Not the user's login password. You can revoke it any time from the user's profile.">
            {input("app_password", { type: "password", placeholder: "abcd efgh ijkl mnop qrst uvwx" })}
          </Field>
        </div>
        <Help title="Create an application password">
          <Steps>
            <li>
              In WordPress, go to <strong>Users → Add New</strong> and create a user named <code className="font-mono text-[12.5px]">seo-agent</code> with the
              Editor role.
            </li>
            <li>
              Open that user&apos;s profile, scroll to <strong>Application Passwords</strong>, name it “SEO Autopilot” and click <strong>Add</strong>.
            </li>
            <li>Copy the 24-character password shown once, and paste it here.</li>
            <li>
              Install the bridge plugin so the agent can edit titles, descriptions and schema the same way on every SEO plugin (Yoast, Rank Math, SEOPress):
              upload it to <code className="font-mono text-[12.5px]">wp-content/mu-plugins/</code>.
            </li>
          </Steps>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href="/integrations/seo-agent-bridge.php" download className={buttonClass("secondary", "sm")}>
              <Download size={14} aria-hidden /> Download bridge plugin
            </a>
            {origin && (
              <a href={`${origin}/wp-admin/profile.php`} target="_blank" rel="noreferrer noopener" className={buttonClass("ghost", "sm")}>
                <ExternalLink size={14} aria-hidden /> Open WordPress profile
              </a>
            )}
          </div>
        </Help>
      </div>
    );

  if (platform === "shopify")
    return (
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col gap-4">
          <Field label="Store domain" htmlFor="cred-shop" error={errors.shop}>
            {input("shop", { placeholder: "your-store.myshopify.com", inputMode: "url" })}
          </Field>
          <Field label="How the app signs in" htmlFor="cred-auth">
            <select id="cred-auth" value={creds.auth ?? "token"} onChange={(e) => set("auth", e.target.value)} className={selectClass}>
              <option value="token">Admin API access token (custom app)</option>
              <option value="client">Client ID and secret (Dev Dashboard app)</option>
            </select>
          </Field>
          {creds.auth === "client" ? (
            <>
              <Field label="Client ID" htmlFor="cred-client_id" error={errors.client_id}>
                {input("client_id")}
              </Field>
              <Field label="Client secret" htmlFor="cred-client_secret" error={errors.client_secret}>
                {input("client_secret", { type: "password" })}
              </Field>
            </>
          ) : (
            <Field label="Admin API access token" htmlFor="cred-access_token" error={errors.access_token} hint="Starts with shpat_. Shopify shows it only once.">
              {input("access_token", { type: "password", placeholder: "shpat_…" })}
            </Field>
          )}
        </div>
        <Help title="Create a custom app">
          <Steps>
            <li>
              In Shopify admin, open <strong>Settings → Apps and sales channels → Develop apps</strong> and create an app called “SEO Autopilot”.
            </li>
            <li>Under Admin API scopes, enable:</li>
          </Steps>
          <ul className="mt-2 mb-3 space-y-1 pl-5">
            {SHOPIFY_SCOPES.map((s) => (
              <li key={s}>
                <code className="font-mono text-[12px] text-ink-2">{s}</code>
              </li>
            ))}
          </ul>
          <Steps>
            <li value={3}>Install the app, then reveal and copy the Admin API access token.</li>
            <li value={4}>
              For structured data, add the one-time theme snippet and render it in <code className="font-mono text-[12.5px]">theme.liquid</code>.
            </li>
          </Steps>
          <a href="/integrations/seo-agent-jsonld.liquid" download className={buttonClass("secondary", "sm", "mt-3")}>
            <Download size={14} aria-hidden /> Download theme snippet
          </a>
        </Help>
      </div>
    );

  if (platform === "repo")
    return (
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col gap-4">
          <Field label="GitHub repository" htmlFor="cred-repo" error={errors.repo}>
            {input("repo", { placeholder: "owner/name" })}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Base branch" htmlFor="cred-branch">
              {input("branch", { placeholder: "main" })}
            </Field>
            <Field label="Framework" htmlFor="cred-framework">
              <select id="cred-framework" value={creds.framework ?? ""} onChange={(e) => set("framework", e.target.value)} className={selectClass}>
                <option value="">Detect automatically</option>
                <option value="nextjs-app">Next.js (App Router)</option>
                <option value="nextjs-pages">Next.js (Pages Router)</option>
                <option value="astro">Astro</option>
                <option value="static">Static HTML</option>
              </select>
            </Field>
          </div>
          <Field label="Build command" htmlFor="cred-build_command" optional hint="Run before a pull request is opened, so broken builds never reach review.">
            {input("build_command", { placeholder: "npm run build" })}
          </Field>
          <Field label="GitHub token" htmlFor="cred-github_token" error={errors.github_token}>
            {input("github_token", { type: "password", placeholder: "github_pat_…" })}
          </Field>
          <Field label="Vercel protection bypass secret" htmlFor="cred-vercel_bypass_secret" optional hint="Lets the runner check preview deployments that are password-protected.">
            {input("vercel_bypass_secret", { type: "password" })}
          </Field>
        </div>
        <Help title="Create a fine-grained token">
          <Steps>
            <li>
              On GitHub, open <strong>Settings → Developer settings → Fine-grained tokens</strong> and generate a token.
            </li>
            <li>Limit it to this one repository.</li>
            <li>
              Repository permissions: <strong>Contents</strong> read and write, <strong>Pull requests</strong> read and write, <strong>Deployments</strong> read.
            </li>
            <li>Every change arrives as one pull request per batch. Nothing is merged unless the site policy allows it.</li>
          </Steps>
          <a
            href="https://github.com/settings/personal-access-tokens/new"
            target="_blank"
            rel="noreferrer noopener"
            className={buttonClass("secondary", "sm", "mt-3")}
          >
            <ExternalLink size={14} aria-hidden /> Create token on GitHub
          </a>
        </Help>
      </div>
    );

  return (
    <p className="rounded-xl bg-sunken p-4 text-[14px] text-ink-2">
      No credentials needed. The agent audits the public site and turns every fix into advice for your team to apply by hand.
    </p>
  );
}
