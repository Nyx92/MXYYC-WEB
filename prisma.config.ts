import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// With a config file, the Prisma CLI no longer loads .env by itself. Load it
// here. Variables that are already set win over .env, so CI and the
// integration tests (which pass their own DATABASE_URL) are not affected.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
});
