import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/Job-Decision-Engine/**",
      // CI checks out the target branch here only to build the migration baseline.
      "**/migration-baseline/**"
    ]
  }
});
