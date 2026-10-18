"use client";
/**
 * AuctionDialog — seller sets up and launches an auction on their card.
 *
 * Fields:
 *   - Duration (1–MAX_AUCTION_DAYS days, required)
 *   - Starting Bid (required, > $0)
 *   - Reserve Price (optional, >= startingBid)
 *   - Buy-out Price (optional, > reservePrice if both set)
 *
 * On submit: POST /api/auctions
 * On success: calls onSuccess() so the parent can refresh card state.
 *
 * ⚠️ Auction cannot be cancelled once launched — we show a clear warning.
 */

import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputAdornment,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from "@mui/material";
import { MAX_AUCTION_DAYS } from "@/constants/auctions";
import GavelIcon from "@mui/icons-material/Gavel";

interface AuctionDialogProps {
  open:      boolean;
  cardId:    string;
  cardTitle: string;
  onClose:   () => void;
  onSuccess: () => void;
}

export default function AuctionDialog({
  open,
  cardId,
  cardTitle,
  onClose,
  onSuccess,
}: AuctionDialogProps) {
  const [durationDays,  setDurationDays]  = useState("3");
  const [startingBid,   setStartingBid]   = useState("");
  const [reservePrice,  setReservePrice]  = useState("");
  const [buyOutPrice,   setBuyOutPrice]   = useState("");
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState<string | null>(null);

  const handleClose = () => {
    if (loading) return;
    setError(null);
    onClose();
  };

  const handleSubmit = async () => {
    setError(null);

    // ── Client-side validation ──────────────────────────────────────────────
    const sb = parseFloat(startingBid);
    if (!startingBid || isNaN(sb) || sb <= 0) {
      setError("Starting bid must be greater than $0.");
      return;
    }

    const rp = reservePrice ? parseFloat(reservePrice) : null;
    const bo = buyOutPrice  ? parseFloat(buyOutPrice)  : null;

    if (rp !== null && rp < sb) {
      setError("Reserve price must be at least the starting bid.");
      return;
    }
    if (bo !== null && rp !== null && bo <= rp) {
      setError("Buy-out price must be higher than the reserve price.");
      return;
    }
    if (bo !== null && bo <= sb) {
      setError("Buy-out price must be higher than the starting bid.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auctions", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          cardId,
          startingBid:  sb,
          reservePrice: rp,
          buyOutPrice:  bo,
          durationDays: Number(durationDays),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to start auction.");
        return;
      }

      onSuccess();
      handleClose();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ pb: 0.5 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <GavelIcon sx={{ color: "#0053ff" }} />
          <Typography sx={{ fontWeight: 700, fontSize: 18 }}>Start Auction</Typography>
        </Box>
      </DialogTitle>

      <DialogContent>
        <Typography sx={{ fontSize: 13, color: "#6b7280", mb: 2 }}>
          {cardTitle}
        </Typography>

        {/* Irreversible warning */}
        <Alert severity="warning" sx={{ mb: 2, fontSize: 12 }}>
          Auctions <strong>cannot be cancelled</strong> once started. Make sure
          your settings are correct before proceeding.
        </Alert>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* Duration */}
        <FormControl fullWidth size="small" sx={{ mb: 2 }}>
          <InputLabel>Duration</InputLabel>
          <Select
            value={durationDays}
            label="Duration"
            onChange={(e) => setDurationDays(e.target.value)}
            disabled={loading}
          >
            {Array.from({ length: MAX_AUCTION_DAYS }, (_, i) => i + 1).map((d) => (
              <MenuItem key={d} value={String(d)}>
                {d} {d === 1 ? "day" : "days"}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        {/* Starting bid */}
        <TextField
          label="Starting Bid"
          type="number"
          size="small"
          fullWidth
          required
          value={startingBid}
          onChange={(e) => setStartingBid(e.target.value)}
          disabled={loading}
          slotProps={{
            input: { startAdornment: <InputAdornment position="start">S$</InputAdornment> },
            htmlInput: { min: 0.01, step: 0.01 },
          }}
          sx={{ mb: 2 }}
        />

        {/* Reserve price */}
        <TextField
          label="Reserve Price (optional)"
          type="number"
          size="small"
          fullWidth
          value={reservePrice}
          onChange={(e) => setReservePrice(e.target.value)}
          disabled={loading}
          helperText="If the highest bid reaches this price, the card is sold automatically."
          slotProps={{
            input: { startAdornment: <InputAdornment position="start">S$</InputAdornment> },
            htmlInput: { min: 0.01, step: 0.01 },
          }}
          sx={{ mb: 2 }}
        />

        {/* Buy-out price */}
        <TextField
          label="Buy-out Price (optional)"
          type="number"
          size="small"
          fullWidth
          value={buyOutPrice}
          onChange={(e) => setBuyOutPrice(e.target.value)}
          disabled={loading}
          helperText="Any bidder who meets this price wins the auction immediately."
          slotProps={{
            input: { startAdornment: <InputAdornment position="start">S$</InputAdornment> },
            htmlInput: { min: 0.01, step: 0.01 },
          }}
        />
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={handleClose} disabled={loading} color="inherit">
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          disabled={loading}
          variant="contained"
          sx={{
            backgroundColor: "#0053ff",
            "&:hover": { backgroundColor: "#0041cc" },
            textTransform: "none",
          }}
          startIcon={loading ? <CircularProgress size={14} color="inherit" /> : undefined}
        >
          {loading ? "Starting…" : "Start Auction"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
