// prisma/importCatalogDelta.ts
//
// Run with: pnpm exec tsx prisma/importCatalogDelta.ts <path-to-delta.json>

import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import { importCatalogDelta, type CatalogDelta } from "../src/lib/catalogDeltaImport";

const prisma = new PrismaClient();

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: pnpm exec tsx prisma/importCatalogDelta.ts <path-to-delta.json>");

  const delta: CatalogDelta = JSON.parse(readFileSync(path, "utf-8"));
  const { created, updated, failed, errors } = await importCatalogDelta(prisma, delta);
  console.log(
    `Imported ${delta.game} delta (${delta.cards.length} cards): ${created} created, ${updated} updated, ${failed} failed.`
  );
  if (errors.length > 0) {
    console.error("Failed cards:");
    for (const error of errors) console.error(`  ${error}`);
  }
  if (failed > 0) process.exitCode = 1;
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (e) => {
    console.error("Import failed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
