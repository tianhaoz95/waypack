import { defineConfig } from "vitest/config";
// Unit tests only; Playwright specs (*.spec.ts) run via `playwright test`.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
