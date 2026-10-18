import { vi } from "vitest";

export const getServerSession = vi.fn();

const sessionFor = (id: string) => ({ user: { id, email: `${id}@test.local`, username: id, firstName: "Test" } });

/** Every request in the test runs as this user. */
export function loginAs(userId: string) {
  getServerSession.mockResolvedValue(sessionFor(userId));
}

/**
 * The next N requests run as these users, in call order. Handlers read the
 * session synchronously on entry, so Promise.all([a(), b()]) consumes them
 * in argument order.
 */
export function loginQueue(...userIds: string[]) {
  for (const id of userIds) getServerSession.mockResolvedValueOnce(sessionFor(id));
}
