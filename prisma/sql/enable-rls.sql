-- Turns on Row-Level Security for every table in the public schema.
--
-- The app reads and writes the database only through Prisma, which connects
-- as the table owner (postgres) and so is not affected by RLS. No policies are
-- added on purpose: the Supabase Data API roles (anon, authenticated) get no
-- rows. The Supabase JS client in this repo only uses Storage with the service
-- role key, which also bypasses RLS.
--
-- `prisma db push` creates new tables with RLS off, so apply this file again
-- after each push (it is safe to run again):
--   pnpm exec prisma db execute --schema prisma/schema.prisma --file prisma/sql/enable-rls.sql
-- script/reset-db.sh and the integration test setup run it after db push.

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END;
$$;
