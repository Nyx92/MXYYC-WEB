// Single gate for which database the integration suite may touch. Read only
// from TEST_DATABASE_URL — never DATABASE_URL/DIRECT_URL (those point at the
// shared Supabase database via .env) — and only a local or CI-service host.
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]);

export function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Point it at a disposable local Postgres, e.g. " +
        "TEST_DATABASE_URL=postgresql://test@127.0.0.1:54329/mxyyc_test pnpm test:integration"
    );
  }
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    throw new Error("TEST_DATABASE_URL is not a valid URL");
  }
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run integration tests against host "${host}": the suite wipes every table. ` +
        `TEST_DATABASE_URL must point at localhost, 127.0.0.1 or the CI service host "postgres".`
    );
  }
  return raw;
}
