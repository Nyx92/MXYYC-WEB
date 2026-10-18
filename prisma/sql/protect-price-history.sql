-- Blocks DELETE and TRUNCATE on "PriceHistory". The rows come from paid
-- JustTCG calls and cannot be fetched again for past days.
--
-- Prisma does not manage triggers, so this file is applied separately (it is
-- safe to run again):
--   pnpm exec prisma db execute --schema prisma/schema.prisma --file prisma/sql/protect-price-history.sql
-- script/reset-db.sh and the integration test setup run it after db push.
--
-- To delete rows on purpose, turn the block off for one transaction:
--   BEGIN;
--   SET LOCAL mxyyc.allow_price_history_delete = 'on';
--   DELETE FROM "PriceHistory" WHERE ...;
--   COMMIT;
--
-- It does not stop DROP TABLE / DROP SCHEMA (for example
-- `prisma db push --force-reset`). Take a backup before any schema push.

CREATE OR REPLACE FUNCTION protect_price_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('mxyyc.allow_price_history_delete', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'PriceHistory rows cannot be deleted (% blocked). See prisma/sql/protect-price-history.sql.', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS price_history_no_delete ON "PriceHistory";
CREATE TRIGGER price_history_no_delete
  BEFORE DELETE ON "PriceHistory"
  FOR EACH STATEMENT EXECUTE FUNCTION protect_price_history();

DROP TRIGGER IF EXISTS price_history_no_truncate ON "PriceHistory";
CREATE TRIGGER price_history_no_truncate
  BEFORE TRUNCATE ON "PriceHistory"
  FOR EACH STATEMENT EXECUTE FUNCTION protect_price_history();
