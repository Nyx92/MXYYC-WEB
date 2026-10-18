"use client";
/** Scanned-card batches, newest first, with how many cards wait for review. */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Container, Typography, Card, CardActionArea, CardContent, Chip, Box, CircularProgress, Alert } from "@mui/material";

interface Batch {
  id: string;
  name: string;
  game: "POKEMON" | "RIFTBOUND";
  status: string;
  createdAt: string;
  counts: Partial<Record<"PENDING" | "APPROVED" | "REJECTED" | "PUBLISHED", number>>;
}

export default function IngestBatchList() {
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/ingest/batches")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Could not load batches"))))
      .then((d) => setBatches(d.batches))
      .catch((e) => setError(e.message));
  }, []);

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Typography variant="h5" fontWeight={800}>Card Intake</Typography>
      <Typography color="text.secondary" sx={{ mb: 3, fontSize: 14 }}>
        Cards scanned with the identifier. Review each batch, then publish the approved cards for sale.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {!batches && !error && <CircularProgress />}
      {batches?.length === 0 && <Alert severity="info">No scan batches yet. Run the identifier with --publish to send one.</Alert>}
      <Box sx={{ display: "grid", gap: 1.5 }}>
        {batches?.map((b) => (
          <Card key={b.id} variant="outlined">
            <CardActionArea component={Link} href={`/admin/ingest/${b.id}`}>
              <CardContent sx={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
                <Box sx={{ flex: 1, minWidth: 200 }}>
                  <Typography fontWeight={700}>{b.name}</Typography>
                  <Typography fontSize={13} color="text.secondary">
                    {b.game === "POKEMON" ? "Pokémon" : "Riftbound"} · {new Date(b.createdAt).toLocaleString("en-SG")}
                  </Typography>
                </Box>
                {(b.counts.PENDING ?? 0) > 0 && <Chip color="warning" label={`${b.counts.PENDING} to review`} />}
                {(b.counts.APPROVED ?? 0) > 0 && <Chip color="info" label={`${b.counts.APPROVED} approved`} />}
                {(b.counts.PUBLISHED ?? 0) > 0 && <Chip color="success" label={`${b.counts.PUBLISHED} listed`} />}
                {(b.counts.REJECTED ?? 0) > 0 && <Chip label={`${b.counts.REJECTED} rejected`} />}
              </CardContent>
            </CardActionArea>
          </Card>
        ))}
      </Box>
    </Container>
  );
}
