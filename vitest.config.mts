import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig maps "@/*" to the repo root. Vitest does not read tsconfig paths,
  // so app code under lib/ would fail to resolve its own imports under test.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "generated/**", ".next/**"],
  },
});
