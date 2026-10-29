import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // The agent tests start runner CLIs through PATH: setup.ts replaces the owner's PATH before every file.
        test: {
          name: "agent",
          include: ["packages/agent/test/**/*.test.ts"],
          setupFiles: ["packages/agent/test/setup.ts"],
        },
      },
      {
        test: {
          name: "packages",
          include: ["packages/*/test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "packages/agent/**"],
        },
      },
    ],
  },
});
