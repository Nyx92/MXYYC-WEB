// Public site identity, shared by metadata, robots.txt, sitemap.xml and
// JSON-LD. Production sets NEXT_PUBLIC_SITE_URL to the real domain
// (https://www.mxyyc.community); the fallback is only for local dev.
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
export const SITE_NAME = "MXYYC Online TCG Store";
