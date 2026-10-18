import { execFileSync } from "node:child_process";
import { testDatabaseUrl } from "./testDatabaseUrl";

// Recreates the test schema from the current prisma/schema.prisma once per
// run. DATABASE_URL/DIRECT_URL are set for the prisma child process only.
export default function setup() {
  const url = testDatabaseUrl();
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--force-reset", "--skip-generate"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });
}
