import { NextResponse } from "next/server";
import { getHomeFeatured } from "@/lib/homeFeatured";

// Public homepage feed. The data is cached for 60s inside getHomeFeatured
// (see src/lib/homeFeatured.ts); this keeps the route itself from being
// prerendered once at build time and frozen there.
export const revalidate = 60;

export async function GET() {
  try {
    return NextResponse.json(await getHomeFeatured());
  } catch (error) {
    console.error("❌ Error fetching featured cards:", error);
    return NextResponse.json(
      { error: "Failed to fetch featured cards" },
      { status: 500 }
    );
  }
}
