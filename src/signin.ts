// Which sign-in service proves who you are. Vault itself only needs three things from it: a page to
// send the browser to, a way to swap the returned code for a token, and the signed-in person's email.
//   - Google (the default): set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.
//   - Any OpenID Connect service (Microsoft, Auth0, Okta, Keycloak, Authentik, …): set OIDC_ISSUER,
//     OIDC_CLIENT_ID and OIDC_CLIENT_SECRET. Vault reads the service's addresses from its standard
//     discovery page (<issuer>/.well-known/openid-configuration).
// Either way only the one email in ALLOWED_EMAIL gets in.

export type SignInSettings = {
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	HOSTED_DOMAIN?: string;
	OIDC_ISSUER?: string;
	OIDC_CLIENT_ID?: string;
	OIDC_CLIENT_SECRET?: string;
	OIDC_SCOPE?: string;
};

export type SignInProvider = {
	label: string; // shown in messages: "Google", or the issuer's host name
	authorizeUrl: string;
	tokenUrl: string;
	userinfoUrl: string;
	clientId: string;
	clientSecret: string;
	scope: string;
	hostedDomain?: string;
	/** Google says when an email is unverified; other services must say it IS verified. */
	requireVerified: boolean;
};

const discovered = new Map<string, Promise<SignInProvider>>();

async function discover(issuer: string, s: SignInSettings, fetchImpl: typeof fetch): Promise<SignInProvider> {
	const base = issuer.replace(/\/+$/, "");
	const res = await fetchImpl(`${base}/.well-known/openid-configuration`);
	if (!res.ok) throw new Error(`Sign-in service discovery answered ${res.status}`);
	const d = (await res.json()) as { authorization_endpoint?: string; token_endpoint?: string; userinfo_endpoint?: string };
	if (!d.authorization_endpoint || !d.token_endpoint || !d.userinfo_endpoint) throw new Error("Sign-in service discovery is incomplete");
	// Only https addresses (http is fine for a service on this computer)
	for (const u of [d.authorization_endpoint, d.token_endpoint, d.userinfo_endpoint]) {
		const url = new URL(u);
		if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Sign-in service addresses must use https");
	}
	return {
		label: new URL(base).hostname,
		authorizeUrl: d.authorization_endpoint,
		tokenUrl: d.token_endpoint,
		userinfoUrl: d.userinfo_endpoint,
		clientId: s.OIDC_CLIENT_ID ?? "",
		clientSecret: s.OIDC_CLIENT_SECRET ?? "",
		scope: s.OIDC_SCOPE?.trim() || "openid email profile",
		requireVerified: true,
	};
}

/** The sign-in service for these settings. OIDC_ISSUER wins; otherwise Google. */
export function signInProvider(s: SignInSettings, fetchImpl: typeof fetch = fetch): Promise<SignInProvider> {
	const issuer = s.OIDC_ISSUER?.trim();
	if (issuer) {
		let found = discovered.get(issuer);
		if (!found) {
			found = discover(issuer, s, fetchImpl);
			discovered.set(issuer, found);
			found.catch(() => discovered.delete(issuer)); // a failed lookup is tried again next time
		}
		return found;
	}
	return Promise.resolve({
		label: "Google",
		authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenUrl: "https://accounts.google.com/o/oauth2/token",
		userinfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
		clientId: s.GOOGLE_CLIENT_ID ?? "",
		clientSecret: s.GOOGLE_CLIENT_SECRET ?? "",
		scope: "email profile",
		hostedDomain: s.HOSTED_DOMAIN,
		requireVerified: false,
	});
}

/** True when the settings name a sign-in service at all. */
export const hasSignIn = (s: SignInSettings) => !!(s.OIDC_ISSUER?.trim() ? s.OIDC_CLIENT_ID && s.OIDC_CLIENT_SECRET : s.GOOGLE_CLIENT_ID && s.GOOGLE_CLIENT_SECRET);

/** Forget discovered services (tests). */
export const resetSignIn = () => discovered.clear();
