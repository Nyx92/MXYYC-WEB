import type { Metadata } from "next";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import IngestBatchList from "./IngestBatchList";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** /admin/ingest — scanned-card batches waiting for review (staff only). */
export default async function AdminIngestPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/auth/login");
  if (session.user.role !== "admin") redirect("/");
  return <IngestBatchList />;
}
