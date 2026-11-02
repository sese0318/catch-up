import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Node environment by default. A UI test opts into the DOM with a first-line
// comment `// @vitest-environment jsdom`.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "eval/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "desktop/**", "eval/results/**", ".next/**"],
  },
});
