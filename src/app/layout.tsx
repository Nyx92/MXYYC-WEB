import type { Metadata } from "next"; // Next.js type for page metadata (SEO, title, description, etc.)
import localFont from "next/font/local";
import "./globals.css";
import NavBar from "./shared-components/navbar/Navbar";
import Footer from "./shared-components/footer/Footer";
import SessionProviderWrapper from "@/providers/SessionProviderWrapper";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v15-appRouter";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import ThemeRegistry from "@/providers/ThemeRegistry";
import { WatchlistAnimationProvider } from "@/app/context/WatchlistAnimationContext";
import { CartProvider } from "@/app/context/CartContext";
import { NotificationProvider } from "@/app/context/NotificationContext";
import { NAVBAR_HEIGHT } from "@/app/utils/navChrome";

// Self-hosted (not next/font/google) so the build has no dependency on
// reaching fonts.googleapis.com at build time — same font/weights/subset
// (Inter, variable weight 100-900, latin), sourced from @fontsource-variable
// under the SIL Open Font License (see src/app/fonts/LICENSE).
const inter = localFont({
  src: "./fonts/Inter-Variable.woff2",
  display: "swap",
  variable: "--font-inter",
  weight: "100 900",
});

// Default metadata for your app (SEO + browser tab info)
export const metadata: Metadata = {
  title: "Pokémon MVP",
  description: "Marketplace for buying and selling Pokémon cards",
};

// Root layout for the entire app (all pages share this structure)
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode; // Content of each page will be injected here
}>) {
  // Fetch session on the server before rendering
  const session = await getServerSession(authOptions);

  return (
    <html lang="en" className={inter.variable}>
      <body className={inter.className} style={{ backgroundColor: "#f4f4f4" }}>
        {/* Wrap with SessionProvider so NextAuth session is available throughout */}
        {/* Puts MUI's server-rendered styles in <head>. Without it they are
            inline <style> tags in the body, which Emotion moves at load
            time — when that races hydration, React throws away the server
            HTML (error #418) and renders the page again in the browser. */}
        <AppRouterCacheProvider>
        <SessionProviderWrapper session={session}>
          <ThemeRegistry>
            <CartProvider>
            <NotificationProvider>
            <WatchlistAnimationProvider>
              <div
                style={{
                  minHeight: "100vh",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                {/* Global navigation bar */}
                <NavBar />
                {/* Main content area with top padding to clear the fixed navbar */}
                <main style={{ flex: 1, paddingTop: `${NAVBAR_HEIGHT}px` }}>
                  <div
                    style={{
                      maxWidth: "1700px",
                      margin: "0 auto",
                      width: "100%",
                    }}
                  >
                    {children}
                  </div>
                </main>
                {/* Global footer */}
                <Footer />
              </div>
            </WatchlistAnimationProvider>
            </NotificationProvider>
            </CartProvider>
          </ThemeRegistry>
        </SessionProviderWrapper>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
