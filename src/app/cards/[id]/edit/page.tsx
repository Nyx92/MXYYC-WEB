"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Box, CircularProgress, Typography } from "@mui/material";
import { useAuth } from "@/app/hooks/useAuth";
import UploadCard from "@/app/upload/UploadCard";
import type { CardItem } from "@/types/card";

export default function EditCardPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { isAdmin, status } = useAuth();
  const authLoading = status === "loading";
  const [card, setCard] = useState<CardItem | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authLoading && !isAdmin) {
      router.replace("/");
    }
  }, [isAdmin, authLoading, router]);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/cards/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.card) setCard(data.card);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  if (authLoading || loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", mt: 10 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!isAdmin) return null;

  if (!card) {
    return (
      <Box sx={{ textAlign: "center", mt: 10 }}>
        <Typography color="text.secondary">Card not found.</Typography>
      </Box>
    );
  }

  return (
    <UploadCard
      initialData={{
        id: card.id,
        game: card.game,
        title: card.title,
        setName: card.setName ?? "",
        price: card.price,
        condition: card.condition,
        tcgPlayerId: card.tcgPlayerId ?? "",
        description: card.description ?? "",
        ownerId: card.owner?.id ?? "",
        forSale: card.forSale,
        imageUrls: card.imageUrls ?? [],
      }}
    />
  );
}
