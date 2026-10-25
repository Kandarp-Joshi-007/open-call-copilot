// "Sign in with ChatGPT" with ChatGPT plan usage, for open-source local apps:
// https://developers.openai.com/siwc/token-sharing-open-source
// First sign-in registers Mynah with client_id=dynamic_agent_client and gets
// back an issued client ID (oaiapp_...) that is reused from then on. No client
// secret or partner key is involved; PKCE protects the code exchange.
import { app, safeStorage, shell } from "electron";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
export const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const APP_NAME = "Mynah";
const CALLBACK_PATH = "/auth/callback";
const PREFERRED_PORT = 1455;
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
// Refresh a little before the one-hour access token runs out.
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

/** One ChatGPT account registration. Tokens are absent while signed out. */
interface Credentials {
  hostId: string;
  clientId?: string;
  subject?: string;
  email?: string;
  idToken?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  scope?: string;
}

export class SignInError extends Error {}

const b64url = (buf: Buffer) => buf.toString("base64url");
const credentialsFile = () => path.join(app.getPath("userData"), "chatgpt-auth.bin");

export class ChatGPTAuth {
  private creds: Credentials;
  private refreshing: Promise<string> | null = null;
  /** Ends the sign-in that is waiting for the browser, if any. */
  private cancelPending: (() => void) | null = null;

  constructor() {
    this.creds = this.load();
  }

  /** Email of the signed-in account, or null when signed out. */
  get account(): string | null {
    return this.creds.refreshToken ? (this.creds.email ?? "ChatGPT account") : null;
  }

  /** A valid access token, refreshed when close to expiry. */
  async accessToken(forceRefresh = false): Promise<string> {
    const c = this.creds;
    if (!c.accessToken || !c.refreshToken || !c.clientId) throw new SignInError("Sign in with ChatGPT in Settings first.");
    if (!forceRefresh && (c.expiresAt ?? 0) - REFRESH_MARGIN_MS > Date.now()) return c.accessToken;
    // Refresh tokens rotate, so never run two refreshes at once.
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  async signIn(): Promise<void> {
    // Starting again (e.g. the browser tab was closed) replaces the waiting attempt.
    this.cancelPending?.();
    const state = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(32));
    const verifier = b64url(randomBytes(64));
    const challenge = b64url(createHash("sha256").update(verifier).digest());

    const { server, redirectUri, callback } = await this.listen(state);
    try {
      const returning = this.creds.clientId;
      const params = new URLSearchParams({
        client_id: returning ?? "dynamic_agent_client",
        ext_agent_host_id: this.creds.hostId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: SCOPES,
        resource: RESOURCE,
        state,
        nonce,
        code_challenge_method: "S256",
        code_challenge: challenge,
      });
      if (returning) {
        if (this.creds.idToken) params.set("id_token_hint", this.creds.idToken);
        if (this.creds.email) params.set("login_hint", this.creds.email);
      } else {
        params.set("agent_name_hint", APP_NAME);
      }
      await shell.openExternal(`${AUTHORIZE_URL}?${params}`);

      const result = await callback;
      if (result.get("error") === "access_denied") {
        throw new SignInError("Sign-in was cancelled, or ChatGPT plan use was not allowed.");
      }
      if (result.get("error")) throw new SignInError(`Sign-in failed: ${result.get("error")}`);
      const code = result.get("code");
      if (!code) throw new SignInError("Sign-in did not return an authorization code.");

      const issued = result.get("client_id");
      if (returning && issued && issued !== returning) {
        throw new SignInError("ChatGPT returned a different app registration. Sign-in was rejected.");
      }
      const clientId = returning ?? issued;
      if (!clientId) throw new SignInError("Registration did not complete (no client ID returned). Try again.");

      const tokens = await this.tokenRequest({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: RESOURCE,
      });
      if (!tokens.id_token) throw new SignInError("Sign-in did not return an ID token.");

      const { payload } = await jwtVerify(tokens.id_token, JWKS, {
        issuer: ISSUER,
        audience: clientId,
        requiredClaims: ["sub", "exp", "iat"],
        clockTolerance: 5,
      });
      if (payload.nonce !== nonce) throw new SignInError("Sign-in could not be verified (nonce mismatch).");
      if (this.creds.subject && payload.sub !== this.creds.subject) {
        throw new SignInError("You signed in with a different ChatGPT account than the one saved. Sign out first to switch.");
      }

      const scopes = (tokens.scope ?? "").split(" ").filter(Boolean);
      if (!scopes.includes(PLAN_SCOPE)) {
        throw new SignInError("ChatGPT plan use was not granted. Allow it for Mynah at chatgpt.com/settings, then sign in again.");
      }

      this.creds = {
        ...this.creds,
        clientId,
        subject: payload.sub,
        email: typeof payload.email === "string" ? payload.email : this.creds.email,
        idToken: tokens.id_token,
        scopes,
        ...this.tokenFields(tokens),
      };
      this.save();
    } finally {
      server.close();
    }
  }

  /** Revokes the refresh token, then forgets the tokens. The registration is kept for the next sign-in. */
  async signOut(): Promise<boolean> {
    const { refreshToken, clientId } = this.creds;
    let revoked = !refreshToken;
    if (refreshToken && clientId) {
      try {
        const discovery = (await (await fetch(DISCOVERY_URL)).json()) as { revocation_endpoint?: string };
        if (discovery.revocation_endpoint) {
          const res = await fetch(discovery.revocation_endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token", client_id: clientId }),
          });
          revoked = res.ok;
        }
      } catch {
        // Offline: sign out locally anyway and report that revocation was not confirmed.
      }
    }
    this.creds = { hostId: this.creds.hostId, clientId, subject: this.creds.subject, email: this.creds.email };
    this.save();
    return revoked;
  }

  private async refresh(): Promise<string> {
    const { clientId, refreshToken } = this.creds;
    try {
      const tokens = await this.tokenRequest({
        grant_type: "refresh_token",
        client_id: clientId!,
        refresh_token: refreshToken!,
        resource: RESOURCE,
      });
      this.creds = { ...this.creds, ...this.tokenFields(tokens) };
      this.save();
      return this.creds.accessToken!;
    } catch (err) {
      if (err instanceof SignInError) {
        // Refresh token expired or revoked: the user has to sign in again.
        this.creds = { hostId: this.creds.hostId, clientId, subject: this.creds.subject, email: this.creds.email, idToken: this.creds.idToken };
        this.save();
        throw new SignInError("Your ChatGPT sign-in expired. Sign in again in Settings.");
      }
      throw err;
    }
  }

  private tokenFields(tokens: TokenResponse): Partial<Credentials> {
    return {
      accessToken: tokens.access_token,
      // Rotating refresh token: always keep the newest one.
      refreshToken: tokens.refresh_token ?? this.creds.refreshToken,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    };
  }

  private async tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });
    if (res.ok) return (await res.json()) as TokenResponse;
    const body = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
    if (res.status === 400 || res.status === 401) {
      throw new SignInError(`ChatGPT sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
    }
    throw new Error(`ChatGPT token request failed (HTTP ${res.status}).`);
  }

  /** Loopback listener for the OAuth redirect. Only the port may vary between sign-ins. */
  private listen(state: string): Promise<{ server: Server; redirectUri: string; callback: Promise<URLSearchParams> }> {
    let resolveCallback!: (p: URLSearchParams) => void;
    let rejectCallback!: (e: Error) => void;
    const callback = new Promise<URLSearchParams>((res, rej) => {
      resolveCallback = res;
      rejectCallback = rej;
    });
    const timer = setTimeout(() => rejectCallback(new SignInError("Sign-in timed out. Try again.")), SIGN_IN_TIMEOUT_MS);
    const cancel = () => rejectCallback(new SignInError("Replaced by a new sign-in."));
    this.cancelPending = cancel;
    callback.catch(() => {}).finally(() => {
      if (this.cancelPending === cancel) this.cancelPending = null;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const ok = url.searchParams.get("state") === state;
      res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
      res.end(
        ok
          ? "<p style='font:16px system-ui;margin:3em'>Signed in. You can close this tab and go back to Mynah.</p>"
          : "<p style='font:16px system-ui;margin:3em'>This sign-in link is not valid any more. Start again from Mynah.</p>",
      );
      // A callback with the wrong state is ignored; keep waiting for the real one.
      if (ok) {
        clearTimeout(timer);
        resolveCallback(url.searchParams);
      }
    });

    const start = (port: number) =>
      new Promise<number>((res, rej) => {
        server.once("error", rej);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", rej);
          res((server.address() as AddressInfo).port);
        });
      });

    return start(PREFERRED_PORT)
      .catch(() => start(0))
      .then((port) => {
        server.on("close", () => clearTimeout(timer));
        return { server, redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`, callback };
      });
  }

  private load(): Credentials {
    try {
      if (existsSync(credentialsFile()) && safeStorage.isEncryptionAvailable()) {
        return JSON.parse(safeStorage.decryptString(readFileSync(credentialsFile()))) as Credentials;
      }
    } catch {
      // Unreadable (e.g. another Windows user): start fresh.
    }
    // Stable, opaque per-installation host ID, created before the first sign-in.
    const fresh: Credentials = { hostId: `urn:uuid:${randomUUID()}` };
    this.creds = fresh;
    this.save();
    return fresh;
  }

  private save(): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows encryption is not available, so the ChatGPT sign-in cannot be stored safely.");
    // Encrypted with DPAPI; written atomically so a crash cannot leave half a file.
    const tmp = `${credentialsFile()}.tmp`;
    writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(this.creds)));
    renameSync(tmp, credentialsFile());
  }
}
