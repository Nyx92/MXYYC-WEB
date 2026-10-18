import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { prisma } from "@/lib/prisma";
import { compressCardImage } from "@/lib/imageProcessing";
import { rateLimitResponse } from "@/lib/rateLimit";
import {
  isValidIngestToken,
  latestRawPriceCents,
  resolveCatalogRefs,
  suggestPriceCents,
  type IngestGame,
} from "@/lib/ingest";

/**
 * POST /api/admin/ingest/items — called by MXYYC-TCG-IDENTIFIER, one scanned
 * card per request. Auth: `Authorization: Bearer <INGEST_API_TOKEN>`.
 *
 * multipart/form-data:
 *   batch       scan run name (normally the scan folder) — same name, same open batch
 *   game        "POKEMON" | "RIFTBOUND"
 *   ingestKey   sha256 hex of the front scan — re-sending a scan creates nothing new
 *   sourceFile  scan file name, shown to the reviewer
 *   confidence  "perfect" | "high" | "medium" | "low" | "none"
 *   method      "ocr" | "vision" (optional)
 *   match       identifier card id ("me01-016" / "ogn-111-298"), or empty
 *   candidates  JSON [{ "id": "...", "score": 0.9 }] — other likely cards
 *   ocr         JSON of the fields the identifier read (optional)
 *   front       front scan image (required), back: back scan (optional)
 *
 * The card is stored as a PENDING IngestItem — nothing goes on sale until an
 * admin approves and publishes it on /admin/ingest.
 */

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const CONFIDENCES = new Set(["perfect", "high", "medium", "low", "none"]);

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

function parseJson<T>(raw: FormDataEntryValue | null, fallback: T): T {
  if (typeof raw !== "string" || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function uploadScan(file: File, path: string): Promise<string> {
  const { buffer, contentType } = await compressCardImage(Buffer.from(await file.arrayBuffer()));
  // upsert: a retried request for the same scan overwrites its own file.
  const { error } = await supabase.storage.from("card-images").upload(path, buffer, { contentType, upsert: true });
  if (error) throw error;
  return supabase.storage.from("card-images").getPublicUrl(path).data.publicUrl;
}

export async function POST(req: Request) {
  if (!isValidIngestToken(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // One identifier at a time sends ~1 card every few seconds; this only
  // stops a runaway loop from filling storage.
  const limited = rateLimitResponse("ingest:items", { limit: 240, windowMs: 60_000 });
  if (limited) return limited;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const game = form.get("game");
  const ingestKey = String(form.get("ingestKey") ?? "");
  const batchName = String(form.get("batch") ?? "").trim().slice(0, 200);
  const confidence = String(form.get("confidence") ?? "none");
  const front = form.get("front");
  const back = form.get("back");

  if (game !== "POKEMON" && game !== "RIFTBOUND") {
    return NextResponse.json({ error: 'game must be "POKEMON" or "RIFTBOUND"' }, { status: 400 });
  }
  if (!/^[a-f0-9]{64}$/.test(ingestKey)) {
    return NextResponse.json({ error: "ingestKey must be a sha256 hex string" }, { status: 400 });
  }
  if (!batchName || !CONFIDENCES.has(confidence) || !(front instanceof File)) {
    return NextResponse.json({ error: "batch, confidence and a front image are required" }, { status: 400 });
  }
  for (const f of [front, back]) {
    if (f instanceof File && f.size > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: "Each image must be 10MB or smaller." }, { status: 413 });
    }
  }

  // Re-running a batch: the scan is already here — leave the item (and any
  // reviewer edits) untouched.
  const existing = await prisma.ingestItem.findUnique({ where: { ingestKey }, select: { id: true, status: true } });
  if (existing) return NextResponse.json({ item: existing, duplicate: true });

  const g = game as IngestGame;
  const match = String(form.get("match") ?? "");
  const rawCandidates = parseJson<{ id?: string; score?: number }[]>(form.get("candidates"), []).slice(0, 8);
  const refs = await resolveCatalogRefs(g, [match, ...rawCandidates.map((c) => c.id ?? "")]);
  const matched = refs.get(match) ?? null;
  const candidates = rawCandidates
    .map((c) => (c.id && refs.get(c.id) ? { ...refs.get(c.id)!, score: c.score ?? null } : null))
    .filter((c): c is NonNullable<typeof c> => c !== null && c.catalogId !== matched?.catalogId);

  const market = matched ? await latestRawPriceCents(g, matched.catalogId) : null;

  let imageUrls: string[];
  try {
    imageUrls = [await uploadScan(front, `ingest/${ingestKey}-front.webp`)];
    if (back instanceof File && back.size > 0) imageUrls.push(await uploadScan(back, `ingest/${ingestKey}-back.webp`));
  } catch (err) {
    console.error("[ingest] image upload failed:", err);
    return NextResponse.json({ error: "Could not store the scan images." }, { status: 400 });
  }

  const batch =
    (await prisma.ingestBatch.findFirst({ where: { name: batchName, game: g, status: "OPEN" }, orderBy: { createdAt: "desc" } })) ??
    (await prisma.ingestBatch.create({ data: { name: batchName, game: g } }));

  try {
    const item = await prisma.ingestItem.create({
      data: {
        batchId: batch.id,
        ingestKey,
        game: g,
        sourceFile: String(form.get("sourceFile") ?? "").slice(0, 300),
        confidence,
        method: String(form.get("method") ?? "") || null,
        ...(matched ? (g === "POKEMON" ? { pokemonCardId: matched.catalogId } : { riftboundCardId: matched.catalogId }) : {}),
        candidates,
        ocr: parseJson<object | null>(form.get("ocr"), null) ?? undefined,
        imageUrls,
        marketPriceCents: market,
        priceCents: suggestPriceCents(market),
      },
      select: { id: true, status: true },
    });
    return NextResponse.json({ item, duplicate: false }, { status: 201 });
  } catch (err) {
    // Two requests for the same scan at once: the other one created it.
    if ((err as { code?: string }).code === "P2002") {
      const item = await prisma.ingestItem.findUnique({ where: { ingestKey }, select: { id: true, status: true } });
      return NextResponse.json({ item, duplicate: true });
    }
    console.error("[ingest] create failed:", err);
    return NextResponse.json({ error: "Could not save the item." }, { status: 500 });
  }
}
