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
import { uiScaleScript, FULL_VIEWPORT_HEIGHT } from "@/app/utils/uiScale";
import { SITE_NAME, SITE_URL } from "@/lib/site";

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
// Pages set a short title ("Marketplace"); the template adds the brand.
// metadataBase lets every page use relative canonical/OG URLs.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} | Pokémon & Riftbound Cards Singapore`,
    template: `%s | ${SITE_NAME}`,
  },
  description:
    "Buy, sell and bid on Pokémon and Riftbound trading cards in Singapore. Japanese and English singles, live auctions, and secure checkout.",
  applicationName: SITE_NAME,
  openGraph: {
    siteName: SITE_NAME,
    type: "website",
    locale: "en_SG",
    images: [{ url: "/collateral/collateral.jpeg", width: 1500, height: 600 }],
  },
  twitter: { card: "summary_large_image" },
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
    // suppressHydrationWarning: uiScaleScript sets <html>'s style before
    // React hydrates, so it never matches the server-rendered attribute.
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: uiScaleScript }} />
      </head>
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
                  minHeight: FULL_VIEWPORT_HEIGHT,
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
