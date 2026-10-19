#!/bin/bash
set -euo pipefail

# Pulls new card data with tcg-index-sync, then imports it into the catalog
# tables of the database that DATABASE_URL in .env points to.
#
#   pnpm update-catalog              # Pokémon and Riftbound
#   pnpm update-catalog pokemon      # one game only
#   pnpm update-catalog riftbound
#
# tcg-index-sync is expected next to this repo; set TCG_INDEX_SYNC_DIR if not.

cd "$(dirname "${BASH_SOURCE[0]}")/.."
WEB_DIR=$(pwd)
SYNC_DIR=$(cd "${TCG_INDEX_SYNC_DIR:-$WEB_DIR/../tcg-index-sync}" && pwd)

case "${1:-all}" in
  all) GAMES=(pokemon riftbound) ;;
  pokemon | riftbound) GAMES=("$1") ;;
  *) echo "Usage: pnpm update-catalog [pokemon|riftbound]" >&2; exit 1 ;;
esac

# Each sync appends the delta files it writes to state/<game>-pending-deltas.txt
# before it moves its own state forward. Import every pending file, oldest
# first, and remove each one only after its import succeeds — so a failed,
# interrupted or skipped import is retried on the next run. Re-importing a
# file is safe: the importer upserts.
import_pending() {
  local game=$1 ledger="$SYNC_DIR/state/$1-pending-deltas.txt" rel pending
  [ -s "$ledger" ] || return 0
  mapfile -t pending < "$ledger"
  for rel in "${pending[@]}"; do
    [ -n "$rel" ] || continue
    echo "📥 [$game] Importing $rel ..."
    if ! pnpm import:catalog-delta "$SYNC_DIR/$rel"; then
      echo "" >&2
      echo "❌ [$game] Import failed. It stays pending — fix the error, then run" >&2
      echo "   pnpm update-catalog again." >&2
      exit 1
    fi
    { grep -vxF -- "$rel" "$ledger" || true; } > "$ledger.tmp"
    mv "$ledger.tmp" "$ledger"
  done
}

for game in "${GAMES[@]}"; do
  echo ""
  import_pending "$game"
  echo "🔄 [$game] Syncing in $SYNC_DIR ..."
  (cd "$SYNC_DIR" && pnpm "sync:$game")
  import_pending "$game"
done

echo ""
echo "✅ Catalog updated. The price cron jobs pick up new cards on their own."
