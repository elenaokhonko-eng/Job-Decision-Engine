import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The shipped Review fit floor is deliberately unset; tests run with a labelled fixture value.
    setupFiles: ["./src/tests/setup/reviewFitFloorFixture.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/Job-Decision-Engine/**",
      // CI checks out the target branch here only to build the migration baseline.
      "**/migration-baseline/**"
    ]
  }
});
