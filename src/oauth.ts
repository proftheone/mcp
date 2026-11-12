import express, { type Request, type Response, type NextFunction } from "express";
import { pkceS256, safeEqual, seal, tokenFingerprint, unseal } from "./crypto.js";
import { verifyApiToken } from "./eprpilotApi.js";

/**
 * OAuth 2.1 authorization server for the account MCP endpoint (variant A from the design doc):
 * the customer pastes their EPRPilot API token on our login page; we seal it into our own tokens.
 * Supports: RFC 8414 metadata, RFC 9728 protected resource metadata, RFC 7591 dynamic client
 * registration (public clients), authorization code + PKCE S256, refresh tokens.
 */

export const SCOPES = ["catalog:read", "orders:read", "reports:read"] as const; // write scopes arrive in stage 2b
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 24 * 3600;
const CODE_TTL = 300;
export const ACCOUNT_MCP_PATH = "/account/mcp";

export interface AccessClaims {
  t: string; // customer's EPRPilot API token
  scope: string;
  cid: string;
}

export function baseUrl(req: Request): string {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] ?? req.protocol;
  return `${proto}://${req.get("host")}`;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function isAllowedRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

function oauthError(res: Response, status: number, error: string, description: string) {
  res.status(status).json({ error, error_description: description });
}

function loginPage(params: Record<string, string>, clientName: string, error?: string) {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return `<!DOCTYPE html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Połącz konto EPRPilot</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f5f6f8;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;color:#1a1d23}
main{background:#fff;max-width:440px;width:100%;margin:24px;padding:32px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 8px}p{font-size:14px;line-height:1.5;color:#4a5160;margin:0 0 16px}
label{font-size:13px;font-weight:600;display:block;margin-bottom:6px}
input[type=password]{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cfd4dc;border-radius:8px;font-size:14px;font-family:ui-monospace,monospace}
button{margin-top:16px;width:100%;padding:11px;border:0;border-radius:8px;background:#1f6feb;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.err{background:#fdecea;color:#a3261b;padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:16px}
ul{font-size:13px;color:#4a5160;padding-left:18px;margin:0 0 16px}small{display:block;margin-top:16px;font-size:12px;color:#6b7280;line-height:1.5}
</style></head><body><main>
<h1>Połącz konto EPRPilot</h1>
<p><strong>${esc(clientName)}</strong> prosi o dostęp do Twojego konta EPRPilot:</p>
<ul><li>odczyt produktów i słowników</li><li>odczyt zamówień</li><li>lista i pobieranie raportów</li></ul>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<form method="post" action="/oauth/authorize">${hidden}
<label for="api_token">Token API EPRPilot</label>
<input type="password" id="api_token" name="api_token" required autocomplete="off" placeholder="np. 123|abc...">
<button type="submit">Połącz</button></form>
<small>Token wygenerujesz w aplikacji EPRPilot (ustawienia konta → API). Jest przechowywany wyłącznie w zaszyfrowanej postaci. Dostęp odbierzesz, unieważniając token w EPRPilot.</small>
</main></body></html>`;
}

export function mountOAuth(app: express.Express) {
  const form = express.urlencoded({ extended: false });

  const protectedResource = (req: Request, res: Response) => {
    const base = baseUrl(req);
    res.json({
      resource: base + ACCOUNT_MCP_PATH,
      authorization_servers: [base],
      scopes_supported: SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "EPRPilot - konto",
      resource_documentation: "https://eprpilot.com",
    });
  };
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource" + ACCOUNT_MCP_PATH, protectedResource);

  app.get(["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"], (req, res) => {
    const base = baseUrl(req);
    res.json({
      issuer: base,
      authorization_endpoint: base + "/oauth/authorize",
      token_endpoint: base + "/oauth/token",
      registration_endpoint: base + "/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: SCOPES,
    });
  });

  // RFC 7591 - public clients only; the client_id itself carries the sealed registration.
  app.post("/oauth/register", express.json(), (req, res) => {
    const uris: unknown = req.body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string" && isAllowedRedirect(u))) {
      return oauthError(res, 400, "invalid_redirect_uri", "redirect_uris must be https (or http on localhost)");
    }
    const name = String(req.body?.client_name ?? "Asystent AI").slice(0, 80);
    const client_id = seal("client", { uris, name });
    res.status(201).json({
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  const readClient = (client_id?: string) => unseal<{ uris: string[]; name: string }>("client", client_id);

  const authParams = (src: Record<string, any>) => ({
    response_type: String(src.response_type ?? ""),
    client_id: String(src.client_id ?? ""),
    redirect_uri: String(src.redirect_uri ?? ""),
    state: String(src.state ?? ""),
    code_challenge: String(src.code_challenge ?? ""),
    code_challenge_method: String(src.code_challenge_method ?? ""),
    scope: String(src.scope ?? ""),
    resource: String(src.resource ?? ""),
  });

  function validateAuth(p: ReturnType<typeof authParams>) {
    const client = readClient(p.client_id);
    if (!client) return { fatal: "Nieznany klient OAuth (client_id). Dodaj konektor ponownie." };
    if (!client.uris.includes(p.redirect_uri)) return { fatal: "Niedozwolony adres powrotu (redirect_uri)." };
    if (p.response_type !== "code") return { client, redirectError: "unsupported_response_type" };
    if (!p.code_challenge || p.code_challenge_method !== "S256") return { client, redirectError: "invalid_request" };
    return { client };
  }

  function redirectWith(res: Response, redirectUri: string, params: Record<string, string>) {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    res.redirect(302, u.toString());
  }

  app.get("/oauth/authorize", (req, res) => {
    const p = authParams(req.query);
    const v = validateAuth(p);
    if (v.fatal) return res.status(400).type("text/plain").send(v.fatal);
    if (v.redirectError) return redirectWith(res, p.redirect_uri, { error: v.redirectError, state: p.state });
    res.set("Cache-Control", "no-store").type("html").send(loginPage(p, v.client!.name));
  });

  app.post("/oauth/authorize", form, async (req, res) => {
    const p = authParams(req.body);
    const v = validateAuth(p);
    if (v.fatal) return res.status(400).type("text/plain").send(v.fatal);
    if (v.redirectError) return redirectWith(res, p.redirect_uri, { error: v.redirectError, state: p.state });
    const apiToken = String(req.body.api_token ?? "").trim();
    if (!apiToken || apiToken.length > 500) {
      return res.status(400).type("html").send(loginPage(p, v.client!.name, "Wklej token API."));
    }
    const err = await verifyApiToken(apiToken);
    if (err) return res.status(400).type("html").send(loginPage(p, v.client!.name, err));

    const requested = p.scope.split(/\s+/).filter((s) => (SCOPES as readonly string[]).includes(s));
    const scope = (requested.length ? requested : SCOPES).join(" ");
    const code = seal("code", { t: apiToken, cid: p.client_id, ru: p.redirect_uri, cc: p.code_challenge, scope }, CODE_TTL);
    console.log(`[oauth] authorized account ${tokenFingerprint(apiToken)}`);
    redirectWith(res, p.redirect_uri, { code, state: p.state });
  });

  app.post("/oauth/token", form, express.json(), (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body ?? {};
    const issue = (claims: AccessClaims) =>
      res.json({
        access_token: seal("access", { ...claims }, ACCESS_TTL),
        token_type: "Bearer",
        expires_in: ACCESS_TTL,
        refresh_token: seal("refresh", { ...claims }, REFRESH_TTL),
        scope: claims.scope,
      });

    if (b.grant_type === "authorization_code") {
      const code = unseal<{ t: string; cid: string; ru: string; cc: string; scope: string }>("code", b.code);
      if (!code) return oauthError(res, 400, "invalid_grant", "Invalid or expired code");
      if (b.client_id && !safeEqual(String(b.client_id), code.cid)) return oauthError(res, 400, "invalid_grant", "client_id mismatch");
      if (b.redirect_uri && String(b.redirect_uri) !== code.ru) return oauthError(res, 400, "invalid_grant", "redirect_uri mismatch");
      if (!b.code_verifier || !safeEqual(pkceS256(String(b.code_verifier)), code.cc)) return oauthError(res, 400, "invalid_grant", "PKCE verification failed");
      return issue({ t: code.t, scope: code.scope, cid: code.cid });
    }
    if (b.grant_type === "refresh_token") {
      const r = unseal<AccessClaims>("refresh", b.refresh_token);
      if (!r) return oauthError(res, 400, "invalid_grant", "Invalid or expired refresh token");
      return issue({ t: r.t, scope: r.scope, cid: r.cid });
    }
    oauthError(res, 400, "unsupported_grant_type", "Use authorization_code or refresh_token");
  });
}

/** Express middleware protecting the account MCP endpoint. */
export function requireAccessToken(req: Request, res: Response, next: NextFunction) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  const claims = unseal<AccessClaims>("access", m?.[1]);
  if (!claims) {
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource${ACCOUNT_MCP_PATH}"`)
      .json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    return;
  }
  (req as any).claims = claims;
  next();
}
