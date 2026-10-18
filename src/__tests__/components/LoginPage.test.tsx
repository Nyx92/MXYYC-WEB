import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const signIn = vi.fn();
vi.mock("next-auth/react", () => ({ signIn: (...args: unknown[]) => signIn(...args) }));
vi.mock("@/app/shared-components/DescriptionBar", () => ({ default: () => null }));

import LoginPage from "@/app/auth/login/page";

function setSearch(search: string) {
  window.history.replaceState(null, "", `/auth/login${search}`);
}

beforeEach(() => {
  signIn.mockReset();
  signIn.mockResolvedValue({ error: "CredentialsSignin" });
});

describe("LoginPage callbackUrl", () => {
  it.each([
    ["", "/"],
    ["?callbackUrl=%2Fcards%2Fabc%3Ftab%3D1", "/cards/abc?tab=1"],
    ["?callbackUrl=%2F%2Fevil.com", "/"],
    ["?callbackUrl=%2F%5Cevil.com", "/"],
    ["?callbackUrl=https%3A%2F%2Fevil.com", "/"],
    ["?callbackUrl=javascript%3Aalert(1)", "/"],
  ])("search %j → Google signIn callbackUrl %j", (search, expected) => {
    setSearch(search);
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /Continue with Google/ }));
    expect(signIn).toHaveBeenCalledWith("google", { callbackUrl: expected });
  });

  it("passes the sanitised callbackUrl to credentials signIn", async () => {
    setSearch("?callbackUrl=%2F%2Fevil.com");
    const { container } = render(<LoginPage />);
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(signIn).toHaveBeenCalled());
    expect(signIn.mock.calls[0][0]).toBe("credentials");
    expect(signIn.mock.calls[0][1]).toMatchObject({ redirect: false, callbackUrl: "/" });
    await screen.findByText("Invalid email or password");
  });
});
