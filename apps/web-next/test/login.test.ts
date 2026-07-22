import { describe, expect, it } from "vitest";
import { runLogin } from "~/server/auth/flow.server";
import { readOidcTx } from "~/server/auth/oidc-tx.server";
import { cookiePair, fakeEnv, testOidcConfig, TEST_CLIENT_ID } from "./helpers";

const env = fakeEnv();
const config = testOidcConfig();

async function login(returnTo?: string): Promise<Response> {
  const url = new URL("https://app.example.invalid/login");
  if (returnTo !== undefined) {
    url.searchParams.set("returnTo", returnTo);
  }
  return runLogin({ env, config, request: new Request(url) });
}

describe("runLogin", () => {
  it("302s to the provider authorize URL with PKCE + state + nonce", async () => {
    const response = await login("/projects/42");
    expect(response.status).toBe(302);

    const location = response.headers.get("Location");
    expect(location).not.toBeNull();
    const params = new URL(location ?? "").searchParams;

    expect(params.get("response_type")).toBe("code");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect((params.get("code_challenge") ?? "").length).toBeGreaterThan(0);
    expect((params.get("state") ?? "").length).toBeGreaterThan(0);
    expect((params.get("nonce") ?? "").length).toBeGreaterThan(0);
    expect(params.get("client_id")).toBe(TEST_CLIENT_ID);
    expect(params.get("redirect_uri")).toBe(config.redirectUri);
    expect(params.get("scope")).toBe("openid email profile");
  });

  it("sets an oidc_tx Set-Cookie", async () => {
    const response = await login("/projects/42");
    const setCookie = response.headers.get("Set-Cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie ?? "").toContain("__Secure-oidc_tx=");
  });

  it("sanitizes a hostile returnTo (//evil.com) to / in the stored tx", async () => {
    const response = await login("//evil.com");
    const setCookie = response.headers.get("Set-Cookie") ?? "";
    const tx = await readOidcTx(
      env,
      new Request("https://app.example.invalid/auth/callback", {
        headers: { Cookie: cookiePair(setCookie) },
      }),
    );
    expect(tx?.returnTo).toBe("/");
  });
});
