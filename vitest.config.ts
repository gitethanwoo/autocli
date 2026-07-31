import { defineConfig } from "vitest/config";

// Only autocli's own tests live in src/. The eval/ directory vendors a full
// sample project whose *.test.ts files are standalone tsx scripts (not vitest
// suites) and must not be collected.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
