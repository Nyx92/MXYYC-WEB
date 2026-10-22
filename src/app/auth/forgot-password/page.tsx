"use client";

import { useState } from "react";
import { Box, Button, CircularProgress, TextField, Typography } from "@mui/material";
import DescriptionBar, { DescriptionLabel } from "../../shared-components/DescriptionBar";
import { FULL_VIEWPORT_HEIGHT } from "@/app/utils/uiScale";

const descriptionBarLabels: DescriptionLabel[] = [
  { title: "", link: "" },
  { button: "Login", link: "/auth/login" },
];

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  // Same message whether or not the email exists — the API deliberately
  // never reveals that, so the UI can't either (see the route's comment).
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } finally {
      // Show the generic confirmation even if the request itself failed —
      // there's nothing actionable a visitor could do with a network-error
      // message here, and it keeps the enumeration-proof behavior intact.
      setLoading(false);
      setSubmitted(true);
    }
  };

  return (
    <Box sx={{ backgroundColor: "#f5f5f7", display: "flex", flexDirection: "column", minHeight: FULL_VIEWPORT_HEIGHT }}>
      <DescriptionBar labels={descriptionBarLabels} />

      <Box sx={{ flexGrow: 1, width: "100%", maxWidth: "1200px", mx: "auto", py: 6, px: { xs: 2, sm: 0 } }}>
        <Typography
          variant="h3"
          component="h1"
          sx={{ color: "black", fontWeight: "bold", fontSize: { xs: "22px", md: "32px", lg: "40px" }, mb: 6 }}
        >
          Reset your password
        </Typography>

        <Box sx={{ display: "flex", justifyContent: "center", minHeight: "40vh", alignItems: "center" }}>
          <Box sx={{ width: { xs: "100%", sm: "70%", md: "50%" }, maxWidth: "500px" }}>
            {submitted ? (
              <Typography sx={{ color: "#494949", textAlign: "center" }}>
                If an account exists for <strong>{email}</strong>, we&apos;ve sent a link to reset your password.
                It expires in 1 hour.
              </Typography>
            ) : (
              <>
                <Typography variant="h5" sx={{ color: "#494949", mb: 3, textAlign: "center" }}>
                  Enter your email and we&apos;ll send you a reset link
                </Typography>

                <form onSubmit={handleSubmit}>
                  <TextField
                    fullWidth
                    required
                    type="email"
                    label="Email"
                    variant="outlined"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    slotProps={{ inputLabel: { shrink: true } }}
                    sx={{
                      mb: 2,
                      "& .MuiOutlinedInput-root": { backgroundColor: "white" },
                    }}
                  />

                  {loading ? (
                    <Box sx={{ display: "flex", justifyContent: "center", py: 2 }}>
                      <CircularProgress />
                    </Box>
                  ) : (
                    <Button
                      type="submit"
                      variant="contained"
                      fullWidth
                      sx={{
                        backgroundColor: "black",
                        color: "white",
                        borderRadius: "5px",
                        textTransform: "none",
                        "&:hover": { backgroundColor: "#222" },
                      }}
                    >
                      Send reset link
                    </Button>
                  )}
                </form>
              </>
            )}

            <Box sx={{ display: "flex", justifyContent: "center", mt: 3 }}>
              <Button
                variant="text"
                href="/auth/login"
                sx={{
                  textTransform: "none",
                  color: "black",
                  "&:hover": { textDecoration: "underline", backgroundColor: "transparent" },
                }}
              >
                Back to login
              </Button>
            </Box>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
