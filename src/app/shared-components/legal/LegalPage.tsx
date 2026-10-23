"use client";

import { Box, Container, Typography } from "@mui/material";

// Shared layout for /terms, /privacy, /refund-policy, /about-us, /contact-us. Each page.tsx that
// renders this stays a server component (so its own `metadata` export
// works) and renders this as a client child — MUI's @mui/material barrel
// import breaks when pulled directly into a server component in this
// Next/MUI version combination (same pattern as CardDetailClient.tsx).
export default function LegalPage({
  title,
  lastUpdated,
  children,
}: {
  title: string;
  lastUpdated?: string;
  children: React.ReactNode;
}) {
  return (
    <Container maxWidth="md" sx={{ py: { xs: 4, md: 6 } }}>
      <Typography component="h1" sx={{ fontSize: { xs: 26, md: 32 }, fontWeight: 800, mb: 1 }}>
        {title}
      </Typography>
      {lastUpdated ? (
        <Typography sx={{ fontSize: 13, color: "#6b7280", mb: 4 }}>
          Last updated: {lastUpdated}
        </Typography>
      ) : (
        <Box sx={{ mb: 3 }} />
      )}
      <Box
        sx={{
          "& h2": { fontSize: { xs: 17, md: 19 }, fontWeight: 700, mt: 4, mb: 1.5 },
          "& p": { fontSize: 14, lineHeight: 1.7, color: "#374151", mb: 2 },
          "& ul": { pl: 3, mb: 2 },
          "& li": { fontSize: 14, lineHeight: 1.7, color: "#374151", mb: 0.5 },
          "& a": { color: "#0053ff" },
        }}
      >
        {children}
      </Box>
    </Container>
  );
}
