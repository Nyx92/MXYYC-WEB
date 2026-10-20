import { execFileSync } from "node:child_process";
import { testDatabaseUrl } from "./testDatabaseUrl";

// Recreates the test schema from the current prisma/schema.prisma once per
// run, plus the PriceHistory delete block that production has. DATABASE_URL/
// DIRECT_URL are set for the prisma child processes only.
export default function setup() {
  const url = testDatabaseUrl();
  const env = { ...process.env, DATABASE_URL: url, DIRECT_URL: url };
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--force-reset", "--skip-generate"], { stdio: "inherit", env });
  execFileSync("pnpm", ["exec", "prisma", "db", "execute", "--schema", "prisma/schema.prisma", "--file", "prisma/sql/protect-price-history.sql"], { stdio: "inherit", env });
  execFileSync("pnpm", ["exec", "prisma", "db", "execute", "--schema", "prisma/schema.prisma", "--file", "prisma/sql/enable-rls.sql"], { stdio: "inherit", env });
}
