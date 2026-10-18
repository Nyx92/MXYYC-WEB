"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  Box,
  Typography,
  Button,
  Chip,
  Divider,
  CircularProgress,
  Alert,
  IconButton,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import GavelIcon from "@mui/icons-material/Gavel";
import CheckIcon from "@mui/icons-material/Check";
import CloseOutlinedIcon from "@mui/icons-material/CloseOutlined";
import OfferCountdown from "./OfferCountdown";

interface Offer {
  id: string;
  price: number | null;
  message: string | null;
  status: string;
  createdAt: string;
  expiresAt?: string | null; // ISO string — used for the countdown timer
  buyer: { id: string; username: string | null; email: string };
}

interface SellerOffersDialogProps {
  open: boolean;
  cardId: string;
  cardTitle: string;
  onClose: () => void;
  // Called instead of onClose when an offer is accepted and the card is sold.
  // The page uses this to reload card data (forSale=false, new owner) rather
  // than trying to re-fetch offers — which would 403 since we no longer own the card.
  onAccepted?: () => void;
}

const STATUS_COLORS: Record<string, "default" | "warning" | "success" | "error"> = {
  pending: "warning",
  accepted: "success",
  rejected: "error",
  paid: "success",
};

export default function SellerOffersDialog({
  open,
  cardId,
  cardTitle,
  onClose,
  onAccepted,
}: SellerOffersDialogProps) {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchOffers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/offers?cardId=${encodeURIComponent(cardId)}`);
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed to load offers."); return; }
      setOffers(data.offers ?? []);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [cardId]);

  useEffect(() => {
    if (!open) return;
    // fetchOffers sets loading/error synchronously as its first statements
    // (before its own internal await) — deferring the call itself into a
    // microtask means those sets happen inside a .then() callback rather
    // than directly, synchronously, in this effect's own body.
    Promise.resolve().then(fetchOffers);
  }, [open, fetchOffers]);

  const handleAction = async (offerId: string, action: "accept" | "reject") => {
    setActionLoading(offerId + action);
    try {
      const res = await fetch(`/api/offers/${offerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed to update offer."); return; }

      if (action === "accept") {
        // After accepting, the card is immediately transferred to the buyer
        // (PI captured + ownerId changed in one atomic step). The seller is
        // no longer the card owner, so re-fetching GET /api/offers?cardId=X
        // would return 403. Call onAccepted so the page can reload card data
        // (showing forSale=false) instead of re-fetching the offers list.
        onAccepted ? onAccepted() : onClose();
      } else {
        // After rejecting, the card is still ours. Re-fetch so the offer
        // moves from Pending → Resolved in the list.
        await fetchOffers();
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setActionLoading(null);
    }
  };

  const pendingOffers = offers.filter((o) => o.status === "pending");
  const otherOffers = offers.filter((o) => o.status !== "pending");

  const renderOffer = (offer: Offer, showActions: boolean) => (
    <Box
      key={offer.id}
      sx={{
        border: "1px solid #e5e7eb",
        borderRadius: 1.5,
        p: 1.5,
        mb: 1,
        backgroundColor: "#fafafa",
      }}
    >
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", mb: 0.5 }}>
        <Box>
          <Typography sx={{ fontWeight: 700, fontSize: 16, color: "#111" }}>
            {offer.price != null ? `S$${offer.price.toFixed(2)}` : "—"}
          </Typography>
          <Typography sx={{ fontSize: 12, color: "#6b7280" }}>
            {offer.buyer.username ?? "Buyer"} &middot;{" "}
            {new Date(offer.createdAt).toLocaleDateString()}
          </Typography>
          {offer.status === "pending" && offer.expiresAt && (
            <Box sx={{ mt: 0.3 }}>
              <OfferCountdown expiresAt={offer.expiresAt} />
            </Box>
          )}
        </Box>
        <Chip
          label={offer.status}
          size="small"
          color={STATUS_COLORS[offer.status] ?? "default"}
          sx={{ textTransform: "capitalize", fontWeight: 600 }}
        />
      </Box>

      {offer.message && (
        <Typography
          sx={{
            fontSize: 13,
            color: "#374151",
            fontStyle: "italic",
            mb: 0.5,
            backgroundColor: "#f3f4f6",
            borderRadius: 1,
            px: 1,
            py: 0.5,
          }}
        >
          &ldquo;{offer.message}&rdquo;
        </Typography>
      )}

      {showActions && (
        <Box sx={{ display: "flex", gap: 1, mt: 1 }}>
          <Button
            size="small"
            variant="contained"
            color="success"
            startIcon={
              actionLoading === offer.id + "accept" ? (
                <CircularProgress size={12} color="inherit" />
              ) : (
                <CheckIcon />
              )
            }
            disabled={actionLoading !== null}
            onClick={() => handleAction(offer.id, "accept")}
            sx={{ textTransform: "none", fontWeight: 600, borderRadius: 1.5 }}
          >
            Accept
          </Button>
          <Button
            size="small"
            variant="outlined"
            color="error"
            startIcon={
              actionLoading === offer.id + "reject" ? (
                <CircularProgress size={12} color="inherit" />
              ) : (
                <CloseOutlinedIcon />
              )
            }
            disabled={actionLoading !== null}
            onClick={() => handleAction(offer.id, "reject")}
            sx={{ textTransform: "none", fontWeight: 600, borderRadius: 1.5 }}
          >
            Decline
          </Button>
        </Box>
      )}
    </Box>
  );

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 0.5 }}>
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <GavelIcon sx={{ color: "#0053ff" }} />
            <Typography sx={{ fontWeight: 700, fontSize: 18 }}>Offers</Typography>
          </Box>
          <IconButton onClick={onClose} aria-label="Close" size="small"><CloseIcon fontSize="small" /></IconButton>
        </Box>
        <Typography sx={{ fontSize: 13, color: "#6b7280", mt: 0.3 }}>{cardTitle}</Typography>
      </DialogTitle>

      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setError(null)}>{error}</Alert>}

        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress />
          </Box>
        ) : offers.length === 0 ? (
          <Box sx={{ textAlign: "center", py: 4 }}>
            <Typography sx={{ color: "#6b7280", fontSize: 14 }}>No offers yet.</Typography>
          </Box>
        ) : (
          <>
            {pendingOffers.length > 0 && (
              <>
                <Typography sx={{ fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.5px", mb: 1 }}>
                  Pending ({pendingOffers.length})
                </Typography>
                {pendingOffers.map((o) => renderOffer(o, true))}
              </>
            )}

            {otherOffers.length > 0 && (
              <>
                {pendingOffers.length > 0 && <Divider sx={{ my: 1.5 }} />}
                <Typography sx={{ fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.5px", mb: 1 }}>
                  Resolved ({otherOffers.length})
                </Typography>
                {otherOffers.map((o) => renderOffer(o, false))}
              </>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
