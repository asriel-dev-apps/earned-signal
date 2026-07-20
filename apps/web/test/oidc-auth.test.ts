import { describe, expect, it } from "vitest";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import {
  AuthenticationRequiredError,
  createJoseOidcTokenVerifier,
  createOidcBearerAuthenticator,
  type OidcTokenVerifier,
} from "../src/oidc-auth.js";

const config = {
  issuer: "https://identity.example.test/",
  audience: "vecta-api",
  jwksUrl: "https://identity.example.test/.well-known/jwks.json",
};

describe("OIDC bearer authentication", () => {
  it("rejects a request without a bearer access token", async () => {
    const verifier: OidcTokenVerifier = {
      verify: async () => {
        throw new Error("must not verify an absent token");
      },
    };
    const authenticator = createOidcBearerAuthenticator(verifier);

    await expect(
      authenticator.authenticate(new Request("https://api.example.test/commands"), config),
    ).rejects.toBeInstanceOf(AuthenticationRequiredError);
  });

  it("rejects a malformed bearer value before token verification", async () => {
    const verifier: OidcTokenVerifier = {
      verify: async () => ({
        issuer: config.issuer,
        subject: "should-not-authenticate",
        scopes: [],
      }),
    };
    const authenticator = createOidcBearerAuthenticator(verifier);

    await expect(
      authenticator.authenticate(
        new Request("https://api.example.test/commands", {
          headers: { authorization: "Bearer token with whitespace" },
        }),
        config,
      ),
    ).rejects.toBeInstanceOf(AuthenticationRequiredError);
  });

  it("verifies signature, issuer, audience, subject, expiry, and OAuth scopes", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    const publicJwk = await exportJWK(publicKey);
    const verifier = createJoseOidcTokenVerifier(() =>
      createLocalJWKSet({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256" }] }),
    );
    const authenticator = createOidcBearerAuthenticator(verifier);
    const token = await new SignJWT({ scope: "project:progress:write project:actuals:write" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "JWT" })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setSubject("agent-service")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      authenticator.authenticate(
        new Request("https://api.example.test/commands", {
          headers: { authorization: `Bearer ${token}` },
        }),
        config,
      ),
    ).resolves.toEqual({
      issuer: config.issuer,
      subject: "agent-service",
      scopes: ["project:progress:write", "project:actuals:write"],
    });
  });

  it("rejects a correctly signed token issued for another audience", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    const publicJwk = await exportJWK(publicKey);
    const authenticator = createOidcBearerAuthenticator(
      createJoseOidcTokenVerifier(() =>
        createLocalJWKSet({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256" }] }),
      ),
    );
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "JWT" })
      .setIssuer(config.issuer)
      .setAudience("another-api")
      .setSubject("human-editor")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      authenticator.authenticate(
        new Request("https://api.example.test/commands", {
          headers: { authorization: `Bearer ${token}` },
        }),
        config,
      ),
    ).rejects.toBeInstanceOf(AuthenticationRequiredError);
  });

  it("rejects a token shared with another audience", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    const publicJwk = await exportJWK(publicKey);
    const authenticator = createOidcBearerAuthenticator(
      createJoseOidcTokenVerifier(() =>
        createLocalJWKSet({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256" }] }),
      ),
    );
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "JWT" })
      .setIssuer(config.issuer)
      .setAudience([config.audience, "another-api"])
      .setSubject("human-editor")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      authenticator.authenticate(
        new Request("https://api.example.test/commands", {
          headers: { authorization: `Bearer ${token}` },
        }),
        config,
      ),
    ).rejects.toBeInstanceOf(AuthenticationRequiredError);
  });

  it("rejects tokens with a missing or expired expiry", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    const publicJwk = await exportJWK(publicKey);
    const authenticator = createOidcBearerAuthenticator(
      createJoseOidcTokenVerifier(() =>
        createLocalJWKSet({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256" }] }),
      ),
    );
    const baseToken = () =>
      new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "JWT" })
        .setIssuer(config.issuer)
        .setAudience(config.audience)
        .setSubject("human-editor")
        .setIssuedAt();
    const missingExpiry = await baseToken().sign(privateKey);
    const expired = await baseToken().setExpirationTime(1).sign(privateKey);

    for (const token of [missingExpiry, expired]) {
      await expect(
        authenticator.authenticate(
          new Request("https://api.example.test/commands", {
            headers: { authorization: `Bearer ${token}` },
          }),
          config,
        ),
      ).rejects.toBeInstanceOf(AuthenticationRequiredError);
    }
  });

  it("rejects tokens with an empty or non-string subject", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    const publicJwk = await exportJWK(publicKey);
    const authenticator = createOidcBearerAuthenticator(
      createJoseOidcTokenVerifier(() =>
        createLocalJWKSet({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256" }] }),
      ),
    );
    const sign = (claims: Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "JWT" })
        .setIssuer(config.issuer)
        .setAudience(config.audience)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);

    for (const token of [await sign({ sub: "" }), await sign({ sub: 42 })]) {
      await expect(
        authenticator.authenticate(
          new Request("https://api.example.test/commands", {
            headers: { authorization: `Bearer ${token}` },
          }),
          config,
        ),
      ).rejects.toBeInstanceOf(AuthenticationRequiredError);
    }
  });
});
