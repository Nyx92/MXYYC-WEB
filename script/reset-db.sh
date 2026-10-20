#!/bin/bash
set -euo pipefail

# prisma resolves prisma/schema.prisma relative to the CALLER's working
# directory, not this script's location — always run from the project root
# regardless of where this script was invoked from.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "🗑️  Resetting database..."
echo "   This project has no prisma/migrations history (schema is managed via"
echo "   'prisma db push'), so this pushes schema.prisma and reseeds mock"
echo "   data. PokemonCardCatalog, RiftboundCardCatalog, and PriceHistory are"
echo "   never touched (guarded below, and PriceHistory has a delete-blocking"
echo "   trigger) — everything else will be lost."
echo ""

# No --force-reset here on purpose: that flag drops and recreates the
# ENTIRE schema regardless of what actually changed, which would wipe the
# catalog and price history tables too. Plain `db push` only alters what
# schema.prisma says needs to change, so a table that isn't changing is
# never touched. No --accept-data-loss either: if the push would be
# destructive (e.g. dropping a column on a catalog/price table — which the
# row-count check below can't detect), Prisma prompts/aborts instead.
BEFORE=$(pnpm exec tsx prisma/countPreservedTables.ts)
pnpm exec prisma db push
# Re-apply the PriceHistory delete block (Prisma does not manage triggers).
pnpm exec prisma db execute --schema prisma/schema.prisma --file prisma/sql/protect-price-history.sql
# Block the Supabase Data API (new tables from db push start with RLS off).
pnpm exec prisma db execute --schema prisma/schema.prisma --file prisma/sql/enable-rls.sql
AFTER=$(pnpm exec tsx prisma/countPreservedTables.ts)

if [ "$BEFORE" != "$AFTER" ]; then
  echo ""
  echo "❌ PokemonCardCatalog/RiftboundCardCatalog/PriceHistory row counts"
  echo "   changed during db push (before: $BEFORE, after: $AFTER)."
  echo "   Stopping before reseeding — check schema.prisma for a change that"
  echo "   touches one of these tables destructively."
  exit 1
fi

echo ""
echo "🌱 Seeding database..."
pnpm run seed

echo ""
echo "🌱 Seeding Riftbound listings..."
echo "   Images already in Supabase Storage are reused, not re-uploaded."
pnpm run seed:riftbound-listings

echo ""
echo "✅ Database reset and reseeded."
