import type { NextConfig } from "next";

/// Hosts allowed to request dev-only assets, for testing on a real phone.
///
/// BUILD_PLAN's Phase 3 gate is "open on your actual phone" — a resized browser
/// window does not count, and from Phase 3 on, every UI phase is verified that
/// way. But `next dev` serves its client chunks and its server actions only to
/// the origin it was started on, and a request carrying any other `Origin`
/// header gets a 403. The visible symptom is not an error: the bundle never
/// loads, nothing hydrates, and every button on the page silently does nothing.
///
/// Read from the environment rather than hardcoded, because the address is one
/// machine's LAN IP and the next maintainer's will differ. Set
/// `DEV_ALLOWED_ORIGINS` in `.env` to the host shown as "Network" in the
/// `next dev` banner. Development only — production is served from one origin
/// and never consults this.
const devAllowedOrigins = (process.env.DEV_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin !== "");

const nextConfig: NextConfig = {
  allowedDevOrigins: devAllowedOrigins,

  experimental: {
    serverActions: {
      // The CSV upload is the only large payload in the app. The default is 1MB,
      // and a real 150-applicant export with five essay responses each will
      // exceed that — the failure would land on the one action a cycle depends
      // on. Everything after the upload is small, because the parsed rows go
      // into the ImportRow staging table rather than back through the browser.
      bodySizeLimit: "8mb",
    },
  },
};

export default nextConfig;
