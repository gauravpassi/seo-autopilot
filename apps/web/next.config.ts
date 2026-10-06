import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The shared core package ships TypeScript sources; let Next compile them.
  transpilePackages: ["@seo-autopilot/core"],
  // nodemailer is only used in server code; keep it out of the bundle.
  serverExternalPackages: ["nodemailer"],
};

export default nextConfig;
