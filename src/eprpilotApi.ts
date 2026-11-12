import { tokenFingerprint } from "./crypto.js";

export const API_BASE = process.env.EPRPILOT_API_BASE ?? "https://app.eprpilot.com/api/v1";

export class ApiError extends Error {
  constructor(public status: number, public body: unknown, message: string) {
    super(message);
  }
}

// --- Rate limiting: API allows 60 req/min per account; keep a margin (50/min) per customer token.
const LIMIT_PER_MIN = Number(process.env.EPRPILOT_RATE_LIMIT ?? 50);
const buckets = new Map<string, { tokens: number; updated: number }>();

async function takeToken(key: string) {
  for (;;) {
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: LIMIT_PER_MIN, updated: now };
    b.tokens = Math.min(LIMIT_PER_MIN, b.tokens + ((now - b.updated) / 60000) * LIMIT_PER_MIN);
    b.updated = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      buckets.set(key, b);
      return;
    }
    buckets.set(key, b);
    await new Promise((r) => setTimeout(r, Math.ceil(((1 - b.tokens) / LIMIT_PER_MIN) * 60000)));
  }
}

const FRIENDLY: Record<number, string> = {
  401: "Token API EPRPilot jest nieprawidłowy lub został unieważniony. Połącz konektor ponownie z nowym tokenem.",
  403: "Brak uprawnień do tej operacji na koncie EPRPilot.",
  404: "Nie znaleziono zasobu w EPRPilot.",
  422: "EPRPilot odrzucił dane (błąd walidacji).",
  429: "Przekroczono limit 60 zapytań na minutę w API EPRPilot. Spróbuj za chwilę.",
};

export class EprPilotClient {
  private key: string;
  constructor(private token: string) {
    this.key = tokenFingerprint(token);
  }

  async request<T = any>(method: string, path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<T> {
    const url = new URL(API_BASE.replace(/\/$/, "") + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));

    for (let attempt = 0; ; attempt++) {
      await takeToken(this.key);
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          "User-Agent": "eprpilot-mcp/0.2",
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429 && attempt < 3) {
        const wait = Number(res.headers.get("retry-after") ?? 2 ** attempt * 2);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      let body: any = text;
      try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      if (!res.ok) {
        const apiMsg = body && typeof body === "object" && body.message ? ` (${body.message})` : "";
        throw new ApiError(res.status, body, (FRIENDLY[res.status] ?? `Błąd API EPRPilot HTTP ${res.status}.`) + apiMsg);
      }
      return body as T;
    }
  }

  get = <T = any>(path: string, query?: Record<string, string | number | undefined>) => this.request<T>("GET", path, { query });
}

// --- Dictionary cache (24 h, shared: dictionaries are global reference data)
const dictCache = new Map<string, { at: number; data: unknown }>();
export const DICTIONARIES = [
  "countries", "sales-sources", "payment-methods", "shipping-methods",
  "waste-components", "waste-component-subtypes", "waste-packaging", "waste-packaging-subtypes",
  "waste-batteries", "waste-nonpackaging", "waste-nonpackaging-subtypes",
] as const;

export async function getDictionary(client: EprPilotClient, name: string) {
  const hit = dictCache.get(name);
  if (hit && Date.now() - hit.at < 24 * 3600 * 1000) return hit.data;
  const res = await client.get<{ data: unknown }>(`/dictionaries/${encodeURIComponent(name)}`);
  dictCache.set(name, { at: Date.now(), data: res.data });
  return res.data;
}

/** Verifies a customer token with a cheap call. Returns null when OK, or an error message. */
export async function verifyApiToken(token: string): Promise<string | null> {
  try {
    await new EprPilotClient(token).get("/dictionaries/countries");
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e.status === 401 ? "Token jest nieprawidłowy lub nieaktywny." : e.message;
    return "Nie udało się połączyć z EPRPilot. Spróbuj ponownie.";
  }
}
