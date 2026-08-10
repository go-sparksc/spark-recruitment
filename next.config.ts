import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
