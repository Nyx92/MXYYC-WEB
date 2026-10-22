"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Box, Button, CircularProgress, TextField, Typography } from "@mui/material";
import DescriptionBar, { DescriptionLabel } from "../../shared-components/DescriptionBar";
import { FULL_VIEWPORT_HEIGHT } from "@/app/utils/uiScale";

const descriptionBarLabels: DescriptionLabel[] = [
  { title: "", link: "" },
  { button: "Login", link: "/auth/login" },
];

const MIN_PASSWORD_LENGTH = 10; // mirrors the API route + signup form

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const uid = searchParams.get("uid");
  const token = searchParams.get("token");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const linkIsValid = Boolean(uid && token);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid, token, password }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Something went wrong");

      setSuccess(true);
      setTimeout(() => router.push("/auth/login"), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box sx={{ width: { xs: "100%", sm: "70%", md: "50%" }, maxWidth: "500px" }}>
      {!linkIsValid ? (
        <Typography sx={{ color: "#494949", textAlign: "center" }}>
          This reset link is missing required information. Please request a new one from the{" "}
          <a href="/auth/forgot-password">forgot password</a> page.
        </Typography>
      ) : success ? (
        <Typography sx={{ color: "#494949", textAlign: "center" }}>
          Password updated. Redirecting you to login…
        </Typography>
      ) : (
        <>
          <Typography variant="h5" sx={{ color: "#494949", mb: 3, textAlign: "center" }}>
            Choose a new password
          </Typography>

          <form onSubmit={handleSubmit}>
            <TextField
              fullWidth
              required
              type="password"
              label="New password"
              variant="outlined"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ mb: 2, "& .MuiOutlinedInput-root": { backgroundColor: "white" } }}
            />
            <TextField
              fullWidth
              required
              type="password"
              label="Confirm new password"
              variant="outlined"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              error={Boolean(error)}
              helperText={error}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ mb: 2, "& .MuiOutlinedInput-root": { backgroundColor: "white" } }}
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
                Reset password
              </Button>
            )}
          </form>
        </>
      )}
    </Box>
  );
}

export default function ResetPasswordPage() {
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
          {/* useSearchParams requires a Suspense boundary in the App Router */}
          <Suspense fallback={<CircularProgress />}>
            <ResetPasswordForm />
          </Suspense>
        </Box>
      </Box>
    </Box>
  );
}
