import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { isAllowedEmail, isAllowedRedirect, type Props, sourceFromClientName } from "./auth";
import { signInProvider } from "./signin";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl } from "./utils";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId } = oauthReqInfo;
	if (!clientId) {
		return c.text("Invalid request", 400);
	}
	// Also covers apps that skip /register (client metadata URLs)
	if (!isAllowedRedirect(oauthReqInfo.redirectUri)) {
		return c.text("This app is not allowed to sign in to Vault.", 400);
	}

	// Check if client is already approved
	if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
		// Skip approval dialog but still create secure state and bind to session
		const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
		return redirectToSignIn(c.req.raw, c.env, stateToken, {
			"Set-Cookie": sessionBindingCookie,
		});
	}

	// Generate CSRF protection for the approval form
	const { token: csrfToken, setCookie } = generateCSRFProtection();

	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: {
			description: "Vault is your personal memory, shared across your AI apps.",
			name: "Vault",
		},
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		// Read form data once
		const formData = await c.req.raw.formData();

		// Validate CSRF token
		validateCSRFToken(formData, c.req.raw);

		// Extract state from form data
		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") {
			return c.text("Missing state in form data", 400);
		}

		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch (_e) {
			return c.text("Invalid state data", 400);
		}

		if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
			return c.text("Invalid request", 400);
		}
		if (!isAllowedRedirect(state.oauthReqInfo.redirectUri)) {
			return c.text("This app is not allowed to sign in to Vault.", 400);
		}

		// Add client to approved list
		const approvedClientCookie = await addApprovedClient(
			c.req.raw,
			state.oauthReqInfo.clientId,
			c.env.COOKIE_ENCRYPTION_KEY,
		);

		// Create OAuth state and bind it to this user's session
		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

		// Set both cookies: approved client list + session binding
		const headers = new Headers();
		headers.append("Set-Cookie", approvedClientCookie);
		headers.append("Set-Cookie", sessionBindingCookie);

		return redirectToSignIn(c.req.raw, c.env, stateToken, Object.fromEntries(headers));
	} catch (error: any) {
		console.error("POST /authorize error:", error);
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		// Unexpected non-OAuth error: details go to the logs only
		return c.text("Internal server error", 500);
	}
});

async function redirectToSignIn(
	request: Request,
	env: Env,
	stateToken: string,
	headers: Record<string, string> = {},
) {
	// The sign-in service: Google by default, or any OpenID Connect service (see signin.ts)
	const provider = await signInProvider(env);
	return new Response(null, {
		headers: {
			...headers,
			location: getUpstreamAuthorizeUrl({
				clientId: provider.clientId,
				hostedDomain: provider.hostedDomain,
				redirectUri: new URL("/callback", request.url).href,
				scope: provider.scope,
				state: stateToken,
				upstreamUrl: provider.authorizeUrl,
			}),
		},
		status: 302,
	});
}

/**
 * OAuth Callback Endpoint
 *
 * This route handles the callback from the sign-in service (Google or another) after user authentication.
 * It exchanges the temporary code for an access token, then stores some
 * user metadata & the auth token as part of the 'props' on the token passed
 * down to the client. It ends by redirecting the client back to _its_ callback URL
 *
 * SECURITY: This endpoint validates that the state parameter from the sign-in service
 * matches both:
 * 1. A valid state token in KV (proves it was created by our server)
 * 2. The __Host-CONSENTED_STATE cookie (proves THIS browser consented to it)
 *
 * This prevents CSRF attacks where an attacker's state token is injected
 * into a victim's OAuth flow.
 */
app.get("/callback", async (c) => {
	// Validate OAuth state with session binding
	// This checks both KV storage AND the session cookie
	let oauthReqInfo: AuthRequest;
	let clearSessionCookie: string;

	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		oauthReqInfo = result.oauthReqInfo;
		clearSessionCookie = result.clearCookie;
	} catch (error: any) {
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		// Unexpected non-OAuth error
		return c.text("Internal server error", 500);
	}

	if (!oauthReqInfo.clientId) {
		return c.text("Invalid OAuth request data", 400);
	}

	// Exchange the code for an access token
	const code = c.req.query("code");
	if (!code) {
		return c.text("Missing code", 400);
	}

	const provider = await signInProvider(c.env);
	const [accessToken, upstreamErrResponse] = await fetchUpstreamAuthToken({
		clientId: provider.clientId,
		clientSecret: provider.clientSecret,
		code,
		grantType: "authorization_code",
		redirectUri: new URL("/callback", c.req.url).href,
		upstreamUrl: provider.tokenUrl,
	});
	if (upstreamErrResponse) {
		return upstreamErrResponse;
	}

	// Fetch the user info from the sign-in service
	const userResponse = await fetch(provider.userinfoUrl, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	});
	if (!userResponse.ok) {
		console.error(`${provider.label} userinfo failed:`, userResponse.status);
		return c.text(`Could not read your ${provider.label} account. Please try signing in again.`, 500);
	}

	// Google's own field names, or the standard OpenID Connect ones
	const user = (await userResponse.json()) as {
		id?: string;
		sub?: string;
		name?: string;
		email?: string;
		verified_email?: boolean;
		email_verified?: boolean;
	};
	const id = user.id ?? user.sub;
	const email = user.email;
	const name = user.name ?? email ?? "";
	const verified = user.verified_email ?? user.email_verified;

	// Vault is single-user: only the allowed email gets a token
	if (!id || !email || !isAllowedEmail(c.env, email, verified, provider.requireVerified)) {
		return c.text(`This ${provider.label} account is not allowed to use Vault.`, 403);
	}

	// The server decides which app is connecting, from the name it registered with
	const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
	const source = sourceFromClientName(client?.clientName);

	// Return back to the MCP client a new token
	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: {
			label: name,
			source,
		},
		props: {
			email,
			name,
			source,
		} satisfies Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: id,
	});

	// Clear the session binding cookie (one-time use) by creating response with headers
	const headers = new Headers({ Location: redirectTo });
	if (clearSessionCookie) {
		headers.set("Set-Cookie", clearSessionCookie);
	}

	return new Response(null, {
		status: 302,
		headers,
	});
});

export { app as GoogleHandler };
