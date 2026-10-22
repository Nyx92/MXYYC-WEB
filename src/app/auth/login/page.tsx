"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import {
  Box,
  Button,
  CircularProgress,
  Divider,
  TextField,
  Typography,
} from "@mui/material";
import DescriptionBar, {
  DescriptionLabel,
} from "../../shared-components/DescriptionBar";
import { FULL_VIEWPORT_HEIGHT } from "@/app/utils/uiScale";

const descriptionBarLabels: DescriptionLabel[] = [
  { title: "", link: "" },
  { button: "Create Your Account", link: "/auth/signup" },
];

// Google "G" logo — inline SVG so no extra icon package is needed.
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

// Where to land after login — the ?callbackUrl= set by requireLogin-style
// redirects. Only same-origin paths are honoured: "//evil.com" and "/\\evil.com"
// are protocol-relative to browsers, so they'd be an open redirect.
// Read from window.location at click time rather than useSearchParams, which
// would force a Suspense boundary and client-render the whole page.
function getCallbackUrl(): string {
  const url = new URLSearchParams(window.location.search).get("callbackUrl");
  if (!url || !url.startsWith("/") || url.startsWith("//") || url.startsWith("/\\")) return "/";
  return url;
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [isFailedLogin, setIsFailedLogin] = useState(false);

  const handleGoogleSignIn = () => signIn("google", { callbackUrl: getCallbackUrl() });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsFailedLogin(false);
    setLoading(true);
    // 🔐 Call NextAuth's built-in signIn() client helper to authenticate the user
    // This sends a POST request to /api/auth/callback/credentials
    // → triggers the CredentialsProvider.authorize() in auth.ts (server-side)
    // If authorize() returns a user, NextAuth creates a JWT session and returns a response
    // Setting `redirect: false` ensures we handle success/failure manually in this component

    try {
      const res = await signIn("credentials", {
        email,
        password,
        redirect: false, // prevent automatic redirect; we’ll redirect manually after success
        callbackUrl: getCallbackUrl(), // where to go after successful login
      });
      if (res?.error) {
        setIsFailedLogin(true);
        return;
      }
      window.location.href = res?.url ?? "/";
    } catch (err) {
      console.error(err);
      setIsFailedLogin(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box
      sx={{
        backgroundColor: "#f5f5f7",
        display: "flex",
        flexDirection: "column",
        minHeight: FULL_VIEWPORT_HEIGHT,
      }}
    >
      <DescriptionBar labels={descriptionBarLabels} />

      {/* Main section */}

      <Box
        sx={{
          flexGrow: 1,
          width: "100%",
          maxWidth: "1200px",
          mx: "auto",
          py: 6,
          // Side gutter so the heading/form don't sit flush against the
          // screen edge on mobile (maxWidth already handles large screens).
          px: { xs: 2, sm: 4 },
        }}
      >
        {/* Top Heading */}
        <Typography
          variant="h3"
          component="h1"
          sx={{
            color: "black",
            fontWeight: "bold",
            fontSize: { xs: "22px", md: "32px", lg: "40px" },
            mb: 6,
            textAlign: "left",
          }}
        >
          Sign in to view your profile
        </Typography>

        {/* Centered Form Section */}
        <Box
          sx={{
            display: "flex",
            justifyContent: "center",
            minHeight: "50vh",
            alignItems: "center", // ✅ horizontal center
          }}
        >
          <Box
            sx={{
              width: { xs: "90%", sm: "70%", md: "50%" },
              maxWidth: "500px",
            }}
          >
            <Typography
              variant="h5"
              sx={{ color: "#494949", mb: 3, textAlign: "center" }}
            >
              Sign in to MXYYC
            </Typography>

            {/* Google sign-in */}
            <Button
              fullWidth
              variant="outlined"
              onClick={handleGoogleSignIn}
              startIcon={<GoogleIcon />}
              sx={{
                textTransform: "none",
                fontWeight: 500,
                fontSize: 15,
                borderColor: "#dadce0",
                color: "#3c4043",
                py: 1.2,
                "&:hover": {
                  borderColor: "#d2e3fc",
                  backgroundColor: "rgba(66,133,244,0.04)",
                },
              }}
            >
              Continue with Google
            </Button>

            <Divider sx={{ my: 2.5 }}>
              <Typography sx={{ color: "#6b7280", fontSize: 13, px: 1 }}>
                or
              </Typography>
            </Divider>

            {/* Credentials form */}
            <form onSubmit={handleSubmit}>
              <TextField
                fullWidth
                label="Email"
                variant="outlined"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                helperText={isFailedLogin ? "Invalid email or password" : ""}
                slotProps={{ inputLabel: { shrink: true } }}
                sx={{
                  mb: 1.5,
                  // Background belongs on the OutlinedInput root (which owns
                  // the rounded corners), not the raw <input> — the input has
                  // square corners, so a background painted directly on it
                  // pokes out past the root's rounded border.
                  "& .MuiOutlinedInput-root": { backgroundColor: "white" },
                  "& .MuiOutlinedInput-root .fieldset": {
                    borderColor: isFailedLogin ? "red" : "grey.300",
                  },
                  "& .MuiFormHelperText-root": { color: "red !important" },
                }}
              />

              <TextField
                fullWidth
                label="Password"
                type="password"
                variant="outlined"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
                sx={{
                  "& .MuiOutlinedInput-root": { backgroundColor: "white" },
                  "& .MuiOutlinedInput-root .fieldset": {
                    borderColor: isFailedLogin ? "red" : "grey.300",
                  },
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
                    mt: 2,
                    backgroundColor: "black",
                    color: "white",
                    borderRadius: "5px",
                    textTransform: "none",
                    "&:hover": { backgroundColor: "#222" },
                  }}
                >
                  Log in
                </Button>
              )}
            </form>

            <Box
              sx={{ display: "flex", justifyContent: "space-between", mt: 2 }}
            >
              <Button
                variant="text"
                href="/auth/forgot-password"
                sx={{
                  textTransform: "none",
                  color: "black",
                  "&:hover": { textDecoration: "underline", backgroundColor: "transparent" },
                }}
              >
                Forgotten password?
              </Button>
              <Button
                variant="text"
                href="/auth/signup"
                sx={{
                  textTransform: "none",
                  color: "black",
                  "&:hover": { textDecoration: "underline", backgroundColor: "transparent" },
                }}
              >
                Create yours now.
              </Button>
            </Box>

            <Divider sx={{ width: "100%", mt: 3 }} />
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
