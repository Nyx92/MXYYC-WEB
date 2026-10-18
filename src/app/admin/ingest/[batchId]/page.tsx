import type { Metadata } from "next";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import IngestBatchReview from "./IngestBatchReview";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** /admin/ingest/[batchId] — review, correct, approve and publish one scan batch (staff only). */
export default async function AdminIngestBatchPage(props: { params: Promise<{ batchId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/auth/login");
  if (session.user.role !== "admin") redirect("/");
  const { batchId } = await props.params;
  return <IngestBatchReview batchId={batchId} />;
}
