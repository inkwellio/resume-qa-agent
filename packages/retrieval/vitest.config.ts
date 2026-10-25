import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    server: {
      deps: {
        external: [/^pg$/, /@node-rs/, /node-pg-migrate/],
      },
    },
  },
});
