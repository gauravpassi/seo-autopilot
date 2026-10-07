/**
 * claude-seo blocks private and loopback addresses (SSRF protection). Its documented opt-in,
 * CLAUDE_SEO_LOCAL_TARGETS, allows specific `host[:port]` entries as the top-level URL only
 * (redirects and subresources are still checked, and cloud metadata stays blocked).
 *
 * The runner sets it for exactly one entry, the site's own origin, and only when that origin
 * is a local or private address (a dev server, a staging box on the LAN, a Tailscale host).
 * Public sites get nothing, so claude-seo's policy is unchanged for them.
 */
import { isIP } from "node:net";

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 127 ||                          // loopback
    a === 10 ||                           // RFC 1918
    (a === 172 && b >= 16 && b <= 31) ||  // RFC 1918
    (a === 192 && b === 168) ||           // RFC 1918
    (a === 100 && b >= 64 && b <= 127)    // RFC 6598 (Tailscale / CGNAT)
  );
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  return v === "::1" || v.startsWith("fc") || v.startsWith("fd");
}

/** The CLAUDE_SEO_LOCAL_TARGETS value for a site, or null for public sites. */
export function localTargetFor(siteUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(siteUrl);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const kind = isIP(host);
  const local =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    (kind === 4 && isPrivateIPv4(host)) ||
    (kind === 6 && isPrivateIPv6(host));
  if (!local) return null;
  // claude-seo never allows link-local / metadata ranges even if listed; don't try.
  if (kind === 4 && host.startsWith("169.254.")) return null;
  return u.port ? `${kind === 6 ? `[${host}]` : host}:${u.port}` : host;
}
