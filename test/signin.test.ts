// Choosing the sign-in service from settings. No network: discovery is answered by a pretend service.
import { afterEach, describe, expect, it } from "vitest";
import { isAllowedEmail } from "../src/auth";
import { hasSignIn, resetSignIn, signInProvider } from "../src/signin";

const discovery = (doc: unknown, status = 200) => {
	const asked: string[] = [];
	const fetchImpl = (async (url: any) => (asked.push(String(url)), new Response(JSON.stringify(doc), { status }))) as typeof fetch;
	return { asked, fetchImpl };
};
const DOC = {
	authorization_endpoint: "https://login.example/authorize",
	token_endpoint: "https://login.example/token",
	userinfo_endpoint: "https://login.example/userinfo",
};
const OIDC = { OIDC_ISSUER: "https://login.example/", OIDC_CLIENT_ID: "id", OIDC_CLIENT_SECRET: "secret" };

afterEach(resetSignIn);

describe("sign-in service", () => {
	it("is Google by default, exactly as before", async () => {
		const p = await signInProvider({ GOOGLE_CLIENT_ID: "g-id", GOOGLE_CLIENT_SECRET: "g-secret", HOSTED_DOMAIN: "example.com" });
		expect(p).toMatchObject({
			label: "Google",
			authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			tokenUrl: "https://accounts.google.com/o/oauth2/token",
			userinfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
			clientId: "g-id",
			scope: "email profile",
			hostedDomain: "example.com",
			requireVerified: false,
		});
	});

	it("reads another service's addresses from its discovery page, once", async () => {
		const { asked, fetchImpl } = discovery(DOC);
		const p = await signInProvider(OIDC, fetchImpl);
		await signInProvider(OIDC, fetchImpl);
		expect(asked).toEqual(["https://login.example/.well-known/openid-configuration"]);
		expect(p).toMatchObject({ label: "login.example", tokenUrl: DOC.token_endpoint, clientId: "id", scope: "openid email profile", requireVerified: true });
	});

	it("refuses a service with missing or non-https addresses, and tries again next time", async () => {
		await expect(signInProvider(OIDC, discovery({}, 500).fetchImpl)).rejects.toThrow("500");
		await expect(signInProvider(OIDC, discovery({ ...DOC, userinfo_endpoint: undefined }).fetchImpl)).rejects.toThrow("incomplete");
		await expect(signInProvider(OIDC, discovery({ ...DOC, token_endpoint: "http://login.example/token" }).fetchImpl)).rejects.toThrow("https");
		expect((await signInProvider(OIDC, discovery(DOC).fetchImpl)).label).toBe("login.example");
	});

	it("knows whether sign-in is set up at all", () => {
		expect(hasSignIn({})).toBe(false);
		expect(hasSignIn({ GOOGLE_CLIENT_ID: "id" })).toBe(false);
		expect(hasSignIn({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" })).toBe(true);
		expect(hasSignIn({ OIDC_ISSUER: "https://login.example", OIDC_CLIENT_ID: "id" })).toBe(false);
		expect(hasSignIn(OIDC)).toBe(true);
	});

	it("other services must state the email is verified; Google only must not deny it", () => {
		const env = { ALLOWED_EMAIL: "owner@example.com" };
		expect(isAllowedEmail(env, "owner@example.com", undefined)).toBe(true);
		expect(isAllowedEmail(env, "owner@example.com", undefined, true)).toBe(false);
		expect(isAllowedEmail(env, "owner@example.com", true, true)).toBe(true);
		expect(isAllowedEmail(env, "someone@example.com", true, true)).toBe(false);
	});
});
