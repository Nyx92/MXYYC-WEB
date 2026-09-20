// src/lib/discord.ts
//
// Staff-facing alerts for the in-person collection workflow, posted to a
// Discord channel via an incoming webhook. Fires only when
// DISCORD_WEBHOOK_URL is set — its absence is a silent no-op, so this
// never breaks the collection-request flow in an environment that hasn't
// configured Discord.

const ADMIN_COLLECTION_URL = `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"}/admin/collection-requests`;

async function postToDiscord(payload: object): Promise<string | null> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return null;

  try {
    // ?wait=true makes Discord return the created message (needed for its
    // id, so a later "packed" update can edit this same message).
    const res = await fetch(`${url}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error("[discord] post failed:", res.status, await res.text());
      return null;
    }
    const data = (await res.json()) as { id: string };
    return data.id;
  } catch (err) {
    console.error("[discord] post failed:", err);
    return null;
  }
}

async function editDiscordMessage(messageId: string, payload: object): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;

  try {
    const res = await fetch(`${url}/messages/${messageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error("[discord] edit failed:", messageId, res.status, await res.text());
  } catch (err) {
    // Called via Promise.all over multiple message ids (a request topped up
    // more than once) — include which message failed, since the batch keeps
    // going and a bare error here wouldn't say which one.
    console.error("[discord] edit failed:", messageId, err);
  }
}

// Posts an alert when a customer requests (or tops up) an in-person pickup.
// Returns the Discord message id so it can be stored on the
// CollectionRequest row and later edited once staff pack it.
export async function postCollectionRequest({
  requestRef,
  customerEmail,
  customerName,
  itemCount,
  isTopUp,
}: {
  requestRef: string;
  customerEmail: string;
  customerName: string | null | undefined;
  // Count of cards added in *this* call only, not the request's running
  // total — isTopUp picks the wording so staff reading a top-up alert don't
  // mistake itemCount for the whole request's size.
  itemCount: number;
  isTopUp: boolean;
}): Promise<string | null> {
  const displayName = customerName ?? customerEmail;
  const action = isTopUp
    ? `added **${itemCount}** more card${itemCount !== 1 ? "s" : ""} to their pickup request`
    : `wants to collect **${itemCount}** card${itemCount !== 1 ? "s" : ""} in person`;

  return postToDiscord({
    embeds: [
      {
        title: `📦 Pickup Request — ${requestRef}`,
        description: `**${displayName}** ${action}.\n\n[View in Admin Panel](${ADMIN_COLLECTION_URL})`,
        color: 0xf59e0b, // amber — pending action
        fields: [
          { name: "Customer", value: displayName, inline: true },
          { name: "Cards", value: String(itemCount), inline: true },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

// Edits every alert message for a request (a customer may have topped it
// up more than once, each producing its own message) to show it's been
// packed, once staff mark it so.
export async function resolveCollectionNotification({
  messageIds,
  requestRef,
  adminName,
}: {
  messageIds: string[];
  requestRef: string;
  adminName: string;
}): Promise<void> {
  const payload = {
    embeds: [
      {
        title: `✅ Packed — ${requestRef}`,
        description: `Marked as packed by **${adminName}**.`,
        color: 0x22c55e, // green — resolved
        timestamp: new Date().toISOString(),
      },
    ],
  };
  await Promise.all(messageIds.map((id) => editDiscordMessage(id, payload)));
}

// Posts every Sentry-captured error (caught or uncaught, any runtime) to
// DISCORD_ALERTS_WEBHOOK_URL — called from each Sentry `beforeSend` hook
// (see sentry.server.config.ts, sentry.edge.config.ts,
// instrumentation-client.ts). Shares the same webhook as postCronResult
// below, kept separate from the collection-request one (DISCORD_WEBHOOK_URL).
export async function postErrorAlert({
  message,
  runtime,
  environment,
  url,
}: {
  message: string;
  runtime: "server" | "edge" | "browser";
  environment: string;
  url?: string;
}): Promise<void> {
  const webhookUrl = process.env.DISCORD_ALERTS_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: `🚨 Error — ${runtime}`,
            description: message.slice(0, 4000),
            color: 0xef4444,
            fields: [
              { name: "Environment", value: environment, inline: true },
              ...(url ? [{ name: "URL", value: url.slice(0, 1000), inline: true }] : []),
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    if (!res.ok) console.error("[discord] error alert post failed:", res.status, await res.text());
  } catch (err) {
    console.error("[discord] error alert post failed:", err);
  }
}

// Alerts for cron job results (refresh-prices, backfill-prices,
// report-performance), posted to DISCORD_ALERTS_WEBHOOK_URL — the same
// webhook postErrorAlert above uses, separate from the collection-request one
// (DISCORD_WEBHOOK_URL). Fires on every run, success or failure: a run can
// return HTTP 200 with some cards failed (e.g. a JustTCG outage mid-run),
// which cron-job.org's own status-code check can't see. `ok` should reflect
// that per-card failure count, not just "did the route return without
// throwing".
export async function postCronResult({
  job,
  ok,
  summary,
  errors,
}: {
  job: string;
  ok: boolean;
  summary: string;
  errors?: string[];
}): Promise<void> {
  const url = process.env.DISCORD_ALERTS_WEBHOOK_URL;
  if (!url) return;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: ok ? `✅ ${job}` : `❌ ${job}`,
            description: summary,
            color: ok ? 0x22c55e : 0xef4444, // green success / red failure
            ...(errors && errors.length > 0
              ? { fields: [{ name: "Errors (first 10)", value: errors.slice(0, 10).join("\n").slice(0, 1000) }] }
              : {}),
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    if (!res.ok) console.error("[discord] cron alert post failed:", res.status, await res.text());
  } catch (err) {
    console.error("[discord] cron alert post failed:", err);
  }
}
