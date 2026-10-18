#!/bin/bash
set -euo pipefail

echo "📦 Installing dependencies..."
pnpm install

echo "🔧 Pushing Prisma schema to Supabase..."
pnpm exec prisma db push

echo "🌱 Seeding database..."
pnpm seed

echo "✅ Setup complete!"
echo "👉 You can now view and edit data via the Supabase Dashboard (Table Editor)."
