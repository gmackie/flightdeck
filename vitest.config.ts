import { globSync } from "node:fs";
import { defineConfig } from "vitest/config";

const projectGlobs = ["packages/*", "apps/*"];
// Vitest errors when `projects` matches nothing; omit it until the first package exists.
const hasProjects = projectGlobs.some((pattern) => globSync(pattern).length > 0);

export default defineConfig({
  test: {
    ...(hasProjects ? { projects: projectGlobs } : {}),
    passWithNoTests: true,
  },
});
