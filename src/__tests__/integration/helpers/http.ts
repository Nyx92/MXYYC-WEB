import { NextRequest } from "next/server";

export function req(path: string, body?: unknown, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: init.method ?? (body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", ...init.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

/** Statuses from a Promise.all of handler responses, sorted for order-free asserts. */
export const statuses = (responses: Response[]) => responses.map((r) => r.status).sort();
