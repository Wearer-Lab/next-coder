import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // macOS writes an AppleDouble sidecar (`._name`) for every file it creates on a
    // non-native filesystem, and `*` matches that prefix — so on an external volume Vitest
    // collects 130 binary metadata files as test suites and the run fails with no code change.
    exclude: ["**/node_modules/**", "**/dist/**", "**/._*"],
  },
});
