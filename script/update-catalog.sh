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

for game in "${GAMES[@]}"; do
  echo ""
  echo "🔄 [$game] Syncing in $SYNC_DIR ..."
  before=$(ls -t "$SYNC_DIR"/output/"$game"-delta-*.json 2>/dev/null | head -1 || true)
  (cd "$SYNC_DIR" && pnpm "sync:$game")
  delta=$(ls -t "$SYNC_DIR"/output/"$game"-delta-*.json 2>/dev/null | head -1 || true)

  if [ -z "$delta" ] || [ "$delta" = "$before" ]; then
    echo "ℹ️  [$game] The sync wrote no new delta file — nothing to import."
    continue
  fi

  echo "📥 [$game] Importing $delta ..."
  if ! pnpm import:catalog-delta "$delta"; then
    # The sync has already moved its state forward, so the next sync will not
    # produce these cards again — retry this exact file instead.
    echo "" >&2
    echo "❌ [$game] Import failed. Fix the error, then retry with:" >&2
    echo "   pnpm import:catalog-delta $delta" >&2
    exit 1
  fi
done

echo ""
echo "✅ Catalog updated. The price cron jobs pick up new cards on their own."
