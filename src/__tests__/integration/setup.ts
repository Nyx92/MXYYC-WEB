// Per-worker setup: mocks every external service the route handlers touch
// (Stripe, NextAuth session, notifications/email, Discord, SMS). Prisma is
// the real client, pointed at TEST_DATABASE_URL by vitest.integration.config.ts.
import { vi, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetStripe } from "./helpers/stripe";
import { getServerSession } from "./helpers/session";

vi.mock("stripe", async () => {
  const { stripe } = await import("./helpers/stripe");
  return { default: vi.fn(() => stripe) };
});
vi.mock("next-auth", async () => {
  const session = await import("./helpers/session");
  return { getServerSession: session.getServerSession };
});
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/notifications", () => ({
  notifyAsync: vi.fn(),
  createNotification: vi.fn(async () => null),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendEmail: vi.fn(async () => ({ success: true })),
  sendEmailAsync: vi.fn(),
}));
vi.mock("@/lib/sms", () => ({ sendSms: vi.fn(async () => ({ success: true })) }));
vi.mock("@/lib/discord", () => ({
  escapeDiscordMarkdown: (s: string) => s,
  postCollectionRequest: vi.fn(async () => null),
  resolveCollectionNotification: vi.fn(async () => undefined),
  postErrorAlert: vi.fn(async () => undefined),
  postCronResult: vi.fn(async () => undefined),
}));

let tables: string | null = null;

async function truncateAll() {
  if (!tables) {
    const rows = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    tables = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  }
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables} CASCADE`);
}

beforeEach(async () => {
  await truncateAll();
  resetStripe();
  getServerSession.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(async () => {
  await prisma.$disconnect();
});
