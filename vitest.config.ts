import { defineConfig } from "vitest/config";

// test/fixtures holds a synthetic repo whose files only look like tests.
export default defineConfig({ test: { include: ["test/*.test.ts"] } });
