import type { MetadataRoute } from "next";
import { SITE_NAME } from "@/lib/site";

// Icons generated from public/collateral/logo.png via sharp (resize + contain
// on a transparent square canvas) into public/icons/ — see pre-launch
// hardening plan, Task 1.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: "MXYYC",
    description: "Marketplace for buying and selling Pokémon and Riftbound cards",
    start_url: "/",
    display: "standalone",
    background_color: "#f4f4f4",
    theme_color: "#0053ff",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
