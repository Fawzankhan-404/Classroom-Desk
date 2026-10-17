import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep discovery anchored to the checked-out source tree. Archived snapshots
    // and generated bundles are evidence/output, not executable test suites.
    include: [
      "src/**/*.test.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/**/*.spec.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
    ],
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "**/artifacts/**",
      "**/.wrangler*/**",
      "**/dist/**",
      "**/dist-worker/**",
      "**/coverage/**",
      "**/build/**",
    ],
  },
});
