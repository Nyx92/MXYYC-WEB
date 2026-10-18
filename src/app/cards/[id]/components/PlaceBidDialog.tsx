"use client";
/**
 * PlaceBidDialog — buyer places a binding bid in an active auction.
 *
 * Mirrors PlaceOfferDialog's 2-step Stripe flow:
 *
 *   Step 1 (bid amount):
 *     Buyer enters their bid. Must be > currentBid (or >= startingBid if no bids yet).
 *     When opened via the "Buy Now" button, initialAmount is pre-filled to the buy-out price.
 *
 *   Step 2 (card details via Stripe CardElement):
 *     Buyer enters payment card. Funds are authorised (held) but NOT charged yet.
 *
 *   Submit:
 *     1. POST /api/auctions/[id]/bid/intent  → get clientSecret + paymentIntentId
 *     2. stripe.confirmCardPayment(clientSecret) → authorise funds
 *     3. POST /api/auctions/[id]/bid { paymentIntentId, amount } → place bid with version lock
 *
 *   On concurrent bid (409): show inline error so buyer can retry immediately.
 */

import { useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import {
  Elements,
  CardElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from "@mui/material";
import GavelIcon from "@mui/icons-material/Gavel";
import type { AuctionItem } from "@/types/auction";
import { dollarsToCents, centsToDollars } from "@/lib/money";

const stripePromise = loadStripe(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY as string
);

const CARD_ELEMENT_OPTIONS = {
  style: {
    base: {
      fontSize: "14px",
      color: "#111",
      fontFamily: "inherit",
      "::placeholder": { color: "#6b7280" },
    },
    invalid: { color: "#ef4444" },
  },
};

interface PlaceBidDialogProps {
  open:          boolean;
  auction:       AuctionItem;
  onClose:       () => void;
  // settled = true when the bid hit the buy-out price and the auction was closed immediately.
  onSuccess:     (settled: boolean) => void;
  // When provided (Buy Now flow), the bid amount field is pre-filled to this value.
  initialAmount?: number;
}

interface BidFormProps extends Omit<PlaceBidDialogProps, "open"> {
  open: boolean;
}

function BidForm({ auction, onClose, onSuccess, open, initialAmount }: BidFormProps) {
  const stripe   = useStripe();
  const elements = useElements();

  // Compared in integer cents — float dollars (0.14 + 0.01 = 0.15000000000000002)
  // would reject a bid of exactly the displayed minimum.
  const minBidCents = auction.currentBid !== null
    ? dollarsToCents(auction.currentBid) + 1
    : dollarsToCents(auction.startingBid);
  const minBid = centsToDollars(minBidCents);
  const buyOut = auction.buyOutPrice;

  const [amount,   setAmount]   = useState("");
  const [step,     setStep]     = useState<"amount" | "card">("amount");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [success,  setSuccess]  = useState(false);
  const [settled,  setSettled]  = useState(false);

  // Reset form each time the dialog opens or the auction changes.
  // Pre-fill the amount from the Buy Now flow when initialAmount is provided.
  //
  // Adjusted directly during render (React's documented pattern for
  // "resetting state when a prop changes") instead of in an effect: amount/
  // step/error/success/settled are genuinely user-editable in between resets
  // (not pure derived values), so the reset itself is real, but doing it
  // during render — guarded by comparing against the last (open, auction.id)
  // this ran for — avoids ever needing to synchronously pre-arm it from an
  // effect body.
  const resetKey = `${open}:${auction.id}`;
  const [lastResetKey, setLastResetKey] = useState<string | null>(null);
  if (open && resetKey !== lastResetKey) {
    setLastResetKey(resetKey);
    setAmount(initialAmount !== undefined ? String(initialAmount) : "");
    setStep("amount");
    setError(null);
    setSuccess(false);
    setSettled(false);
  }

  const handleClose = () => {
    if (loading) return;
    onClose();
  };

  const handleContinue = () => {
    const parsed = parseFloat(amount);
    if (!amount || isNaN(parsed) || dollarsToCents(parsed) < minBidCents) {
      setError(`Bid must be at least S$${minBid.toFixed(2)}.`);
      return;
    }
    setError(null);
    setStep("card");
  };

  const handleSubmit = async () => {
    if (!stripe || !elements) {
      setError("Stripe is not ready. Please try again.");
      return;
    }
    const cardElement = elements.getElement(CardElement);
    if (!cardElement) {
      setError("Card element not found. Please refresh.");
      return;
    }
    const parsed = parseFloat(amount);
    if (!amount || isNaN(parsed) || dollarsToCents(parsed) < minBidCents) {
      setError(`Bid must be at least S$${minBid.toFixed(2)}.`);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // ── 1. Create PI ──────────────────────────────────────────────────────
      const intentRes = await fetch(`/api/auctions/${auction.id}/bid/intent`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ amount: parsed }),
      });
      const intentData = await intentRes.json();
      if (!intentRes.ok) {
        setError(intentData.error ?? "Failed to initialise payment.");
        return;
      }

      // ── 2. Confirm card (authorise / hold funds) ──────────────────────────
      const { error: stripeError } = await stripe.confirmCardPayment(
        intentData.clientSecret,
        { payment_method: { card: cardElement } }
      );
      if (stripeError) {
        setError(stripeError.message ?? "Card authorisation failed.");
        return;
      }

      // ── 3. Place bid with version lock ────────────────────────────────────
      const bidRes = await fetch(`/api/auctions/${auction.id}/bid`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          paymentIntentId: intentData.paymentIntentId,
          amount:          parsed,
        }),
      });
      const bidData = await bidRes.json();

      if (!bidRes.ok) {
        setError(bidData.error ?? "Failed to place bid.");
        return;
      }

      const isSettled = bidData.settled ?? false;
      setSettled(isSettled);
      setSuccess(true);
      setTimeout(() => {
        onSuccess(isSettled);
        handleClose();
      }, 1200);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <DialogTitle sx={{ pb: 0.5 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <GavelIcon sx={{ color: "#0053ff" }} />
          <Typography sx={{ fontWeight: 700, fontSize: 18 }}>Place a Bid</Typography>
        </Box>
      </DialogTitle>

      <DialogContent>
        <Typography sx={{ fontSize: 13, color: "#6b7280", mb: 1.5 }}>
          {auction.card.title}
        </Typography>

        {/* Price reference row */}
        <Box sx={{ display: "flex", gap: 2, mb: 2 }}>
          {[
            { label: "Starting Bid", value: auction.startingBid },
            ...(auction.reservePrice !== null ? [{ label: "Reserve",     value: auction.reservePrice }] : []),
            ...(auction.buyOutPrice  !== null ? [{ label: "Buy-out",     value: auction.buyOutPrice  }] : []),
            ...(auction.currentBid   !== null ? [{ label: "Current Bid", value: auction.currentBid  }] : []),
          ].map(({ label, value }) => (
            <Box key={label} sx={{ textAlign: "center" }}>
              <Typography sx={{ fontSize: 10, color: "#6b7280" }}>{label}</Typography>
              <Typography sx={{ fontSize: 12, fontWeight: 700 }}>S${value.toFixed(2)}</Typography>
            </Box>
          ))}
        </Box>

        {success ? (
          <Alert severity="success">
            {settled
              ? "Buy-out price met! The auction has ended and you’ve won."
              : "Bid placed! Funds are authorised and you are the current highest bidder."}
          </Alert>
        ) : (
          <>
            {error && (
              <Alert severity="error" sx={{ mb: 1.5 }}>
                {error}
              </Alert>
            )}

            {/* Step 1: bid amount */}
            {step === "amount" && (
              <TextField
                label={`Your bid — min S$${minBid.toFixed(2)}`}
                type="number"
                slotProps={{ htmlInput: { min: minBid, step: 0.01 } }}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                fullWidth
                size="small"
                disabled={loading}
                helperText={
                  buyOut !== null
                    ? `Bid S$${buyOut.toFixed(2)} to win instantly (buy-out price)`
                    : undefined
                }
              />
            )}

            {/* Step 2: Stripe card input */}
            {step === "card" && (
              <>
                <Alert severity="info" sx={{ mb: 2, fontSize: 12 }}>
                  Your card will be authorised for{" "}
                  <strong>S${parseFloat(amount).toFixed(2)}</strong>. Funds are
                  only charged if your bid wins — otherwise the hold is released
                  automatically.
                </Alert>
                <Box
                  sx={{
                    border: "1px solid #d1d5db",
                    borderRadius: 1,
                    px: 1.5,
                    py: 1.5,
                    "&:focus-within": { borderColor: "#0053ff" },
                  }}
                >
                  <CardElement options={CARD_ELEMENT_OPTIONS} />
                </Box>
              </>
            )}
          </>
        )}
      </DialogContent>

      {!success && (
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={handleClose} disabled={loading} color="inherit">
            Cancel
          </Button>

          {step === "amount" && (
            <Button
              onClick={handleContinue}
              variant="contained"
              sx={{ backgroundColor: "#0053ff", "&:hover": { backgroundColor: "#0041cc" }, textTransform: "none" }}
            >
              Continue
            </Button>
          )}

          {step === "card" && (
            <Button
              onClick={handleSubmit}
              disabled={loading || !stripe}
              variant="contained"
              sx={{ backgroundColor: "#0053ff", "&:hover": { backgroundColor: "#0041cc" }, textTransform: "none" }}
              startIcon={loading ? <CircularProgress size={14} color="inherit" /> : undefined}
            >
              {loading ? "Placing bid…" : "Place Bid"}
            </Button>
          )}
        </DialogActions>
      )}
    </>
  );
}

export default function PlaceBidDialog({ open, auction, onClose, onSuccess, initialAmount }: PlaceBidDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <Elements stripe={stripePromise}>
        <BidForm
          auction={auction}
          onClose={onClose}
          onSuccess={onSuccess}
          open={open}
          initialAmount={initialAmount}
        />
      </Elements>
    </Dialog>
  );
}
