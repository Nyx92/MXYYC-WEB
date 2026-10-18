"use client";
/**
 * Review one scan batch. For each scanned card the admin can:
 *  - pick the right card (from the identifier's candidates, or by TCGPlayer id),
 *  - set the condition and the price (pre-filled from the market price),
 *  - approve or reject it.
 * "Publish approved" turns approved cards that have a price into listings.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Alert, Box, Button, Chip, CircularProgress, Container, MenuItem, Paper, Tab, Tabs, TextField, Typography,
} from "@mui/material";
import { RAW_GRADES } from "@/constants/grades";

type Status = "PENDING" | "APPROVED" | "REJECTED" | "PUBLISHED";
interface CardRef { catalogId: string; label: string; score?: number | null; tcgPlayerId?: string | null }
interface Item {
  id: string;
  status: Status;
  confidence: string;
  method: string | null;
  sourceFile: string;
  imageUrls: string[];
  card: CardRef | null;
  candidates: CardRef[];
  ocr: Record<string, unknown> | null;
  condition: string;
  marketPrice: number | null;
  price: number | null;
  listingId: string | null;
}
interface Batch { id: string; name: string; game: "POKEMON" | "RIFTBOUND" }

const CONFIDENT = ["perfect", "high"];
const CONF_COLOR: Record<string, "success" | "info" | "warning" | "error" | "default"> = {
  perfect: "success", high: "info", medium: "warning", low: "error", none: "error",
};
const TABS: { key: Status | "ALL"; label: string }[] = [
  { key: "PENDING", label: "To review" },
  { key: "APPROVED", label: "Approved" },
  { key: "PUBLISHED", label: "Listed" },
  { key: "REJECTED", label: "Rejected" },
  { key: "ALL", label: "All" },
];

function ItemRow({ item, onChange }: { item: Item; onChange: (next: Item) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [price, setPrice] = useState(item.price?.toFixed(2) ?? "");
  const [tcgId, setTcgId] = useState("");
  const locked = item.status === "PUBLISHED";

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/ingest/items/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Update failed");
      onChange(data.item);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const options = [...(item.card ? [item.card] : []), ...item.candidates];
  const ocr = item.ocr ?? {};
  const read = ["name", "name_ja", "set_code", "card_number", "hp", "illustrator", "language", "set_id", "artist"]
    .filter((k) => ocr[k] != null && ocr[k] !== "")
    .map((k) => `${k}: ${String(ocr[k])}`)
    .join(" · ");

  return (
    <Paper variant="outlined" sx={{ p: 2, display: "flex", gap: 2, flexWrap: { xs: "wrap", md: "nowrap" }, opacity: busy ? 0.6 : 1 }}>
      <Box sx={{ display: "flex", gap: 1, flexShrink: 0 }}>
        {item.imageUrls.map((url, i) => (
          <a key={url} href={url} target="_blank" rel="noreferrer">
            {/* Plain img: admin-only thumbnails straight from storage, no optimizer needed. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={i === 0 ? "Front scan" : "Back scan"} width={i === 0 ? 110 : 70} style={{ borderRadius: 6, display: "block" }} />
          </a>
        ))}
      </Box>

      <Box sx={{ flex: 1, minWidth: 260, display: "grid", gap: 1 }}>
        <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
          <Chip size="small" color={CONF_COLOR[item.confidence] ?? "default"} label={item.confidence} />
          {item.method === "vision" && <Chip size="small" variant="outlined" label="vision" />}
          <Typography fontSize={12} color="text.secondary">{item.sourceFile}</Typography>
          {item.listingId && (
            <Button size="small" component={Link} href={`/cards/${item.listingId}`}>View listing</Button>
          )}
        </Box>
        <TextField
          select
          size="small"
          label="Card"
          value={item.card?.catalogId ?? ""}
          disabled={locked || busy}
          onChange={(e) => patch({ catalogId: e.target.value })}
          helperText={item.card ? undefined : "Not identified — choose a candidate or enter the TCGPlayer ID"}
          error={!item.card}
        >
          {options.length === 0 && <MenuItem value="" disabled>No candidates</MenuItem>}
          {options.map((o) => (
            <MenuItem key={o.catalogId} value={o.catalogId}>{o.label}</MenuItem>
          ))}
        </TextField>
        {!locked && (
          <Box sx={{ display: "flex", gap: 1 }}>
            <TextField size="small" label="TCGPlayer ID" value={tcgId} onChange={(e) => setTcgId(e.target.value)} sx={{ width: 160 }} />
            <Button size="small" disabled={!tcgId.trim() || busy} onClick={async () => (await patch({ tcgPlayerId: tcgId })) && setTcgId("")}>
              Use this card
            </Button>
          </Box>
        )}
        {read && <Typography fontSize={12} color="text.secondary">Read from scan: {read}</Typography>}
        {error && <Alert severity="error" sx={{ py: 0 }}>{error}</Alert>}
      </Box>

      <Box sx={{ width: { xs: "100%", md: 230 }, display: "grid", gap: 1, alignContent: "start" }}>
        <TextField select size="small" label="Condition" value={item.condition} disabled={locked || busy} onChange={(e) => patch({ condition: e.target.value })}>
          {RAW_GRADES.map((g) => <MenuItem key={g} value={g}>{g}</MenuItem>)}
        </TextField>
        <TextField
          size="small"
          label="Price (S$)"
          type="number"
          value={price}
          disabled={locked || busy}
          onChange={(e) => setPrice(e.target.value)}
          onBlur={() => price !== (item.price?.toFixed(2) ?? "") && patch({ price: price === "" ? null : Number(price) })}
          helperText={item.marketPrice != null ? `Market S$${item.marketPrice.toFixed(2)}` : "No market price — set one"}
          error={!item.price}
        />
        {!locked && (
          <Box sx={{ display: "flex", gap: 1 }}>
            {item.status !== "APPROVED" && (
              <Button variant="contained" size="small" disabled={busy || !item.card} onClick={() => patch({ status: "APPROVED" })}>Approve</Button>
            )}
            {item.status !== "REJECTED" && (
              <Button color="error" size="small" disabled={busy} onClick={() => patch({ status: "REJECTED" })}>Reject</Button>
            )}
            {item.status !== "PENDING" && (
              <Button size="small" disabled={busy} onClick={() => patch({ status: "PENDING" })}>Undo</Button>
            )}
          </Box>
        )}
      </Box>
    </Paper>
  );
}

export default function IngestBatchReview({ batchId }: { batchId: string }) {
  const [batch, setBatch] = useState<Batch | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [tab, setTab] = useState<Status | "ALL">("PENDING");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);

  const load = useCallback(
    () =>
      fetch(`/api/admin/ingest/batches/${batchId}`)
        .then(async (res) => ({ ok: res.ok, data: await res.json() }))
        .then(({ ok, data }) => {
          if (!ok) return setMessage({ type: "error", text: data.error || "Could not load the batch" });
          setBatch(data.batch);
          setItems(data.items);
        }),
    [batchId]
  );

  useEffect(() => {
    load();
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: items?.length ?? 0 };
    for (const i of items ?? []) c[i.status] = (c[i.status] ?? 0) + 1;
    return c;
  }, [items]);
  const confidentPending = items?.filter((i) => i.status === "PENDING" && CONFIDENT.includes(i.confidence) && i.card).length ?? 0;
  const readyToPublish = items?.filter((i) => i.status === "APPROVED" && i.price).length ?? 0;
  const approvedNoPrice = items?.filter((i) => i.status === "APPROVED" && !i.price).length ?? 0;

  const approveConfident = async () => {
    setBusy(true);
    const res = await fetch(`/api/admin/ingest/batches/${batchId}/approve-confident`, { method: "POST" });
    const data = await res.json();
    setMessage(res.ok ? { type: "success", text: `Approved ${data.approved} confident cards.` } : { type: "error", text: data.error });
    await load();
    setBusy(false);
  };

  const publish = async () => {
    setBusy(true);
    let total = 0;
    try {
      // The server publishes in chunks; keep calling until nothing remains.
      for (;;) {
        const res = await fetch(`/api/admin/ingest/batches/${batchId}/publish`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Publish failed");
        total += data.published;
        if (!data.remaining) {
          const skipped = data.skipped?.length ?? 0;
          setMessage({ type: "success", text: `Listed ${total} card${total === 1 ? "" : "s"} for sale.${skipped ? ` ${skipped} skipped (no price or no card).` : ""}` });
          break;
        }
      }
    } catch (e) {
      setMessage({ type: "error", text: `${e instanceof Error ? e.message : "Publish failed"} (${total} listed before the error).` });
    }
    await load();
    setBusy(false);
  };

  if (!items) {
    return (
      <Container sx={{ py: 4 }}>
        {message ? <Alert severity={message.type}>{message.text}</Alert> : <CircularProgress />}
      </Container>
    );
  }

  const shown = tab === "ALL" ? items : items.filter((i) => i.status === tab);

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Button component={Link} href="/admin/ingest" size="small" sx={{ mb: 1 }}>← All batches</Button>
      <Typography variant="h5" fontWeight={800}>{batch?.name}</Typography>
      <Typography color="text.secondary" fontSize={14} sx={{ mb: 2 }}>
        {batch?.game === "POKEMON" ? "Pokémon" : "Riftbound"} · {items.length} scanned cards. Prices are suggested from the latest market price
        (rounded up to S$0.50) — check them before publishing.
      </Typography>

      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mb: 2 }}>
        <Button variant="outlined" disabled={busy || confidentPending === 0} onClick={approveConfident}>
          Approve all confident ({confidentPending})
        </Button>
        <Button variant="contained" color="success" disabled={busy || readyToPublish === 0} onClick={publish}>
          Publish approved ({readyToPublish})
        </Button>
        {busy && <CircularProgress size={24} />}
      </Box>
      {approvedNoPrice > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {approvedNoPrice === 1 ? "1 approved card has" : `${approvedNoPrice} approved cards have`} no price and will not be published until you set one.
        </Alert>
      )}
      {message && <Alert severity={message.type} sx={{ mb: 2 }} onClose={() => setMessage(null)}>{message.text}</Alert>}

      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }} variant="scrollable">
        {TABS.map((t) => <Tab key={t.key} value={t.key} label={`${t.label} (${counts[t.key] ?? 0})`} />)}
      </Tabs>

      <Box sx={{ display: "grid", gap: 1.5 }}>
        {shown.length === 0 && <Typography color="text.secondary">Nothing here.</Typography>}
        {shown.map((item) => (
          // Keyed on the price too: a server-side price reset (new card chosen) remounts the row's price box.
          <ItemRow key={`${item.id}:${item.price}`} item={item} onChange={(next) => setItems((all) => all!.map((i) => (i.id === next.id ? next : i)))} />
        ))}
      </Box>
    </Container>
  );
}
