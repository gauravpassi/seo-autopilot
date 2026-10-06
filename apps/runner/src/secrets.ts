import { SiteSecrets, unseal, type SealedEnvelope } from "@seo-autopilot/core";

/**
 * Decrypt a site's secret envelope with the runner's private key and validate it.
 * Sites on platform "other" have no secrets; a missing envelope yields { platform: "other" }
 * for them and an error for everything else.
 */
export function unsealSecrets(env: SealedEnvelope | null | undefined, privateKeyPem: string, platform: string): SiteSecrets {
  if (!env) {
    if (platform === "other") return { platform: "other" };
    throw new Error(`No credentials saved for this ${platform} site. Add them in the control panel.`);
  }
  let plaintext: string;
  try {
    plaintext = unseal(env, privateKeyPem);
  } catch (e) {
    throw new Error(
      `Could not decrypt site credentials (${(e as Error).message}). They were probably encrypted for another runner; re-enter them in the panel.`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(plaintext);
  } catch {
    throw new Error("Decrypted site credentials are not valid JSON");
  }
  const parsed = SiteSecrets.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Site credentials are incomplete: ${issues}`);
  }
  if (parsed.data.platform !== platform) {
    throw new Error(`Credentials are for ${parsed.data.platform} but the site platform is ${platform}`);
  }
  return parsed.data;
}
