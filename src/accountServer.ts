import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiError, DICTIONARIES, EprPilotClient, getDictionary } from "./eprpilotApi.js";
import type { AccessClaims } from "./oauth.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const MAX_CHARS = 60000;

function out(data: unknown) {
  let text = JSON.stringify(data, null, 1);
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + "\n…[obcięto - zawęź zapytanie lub użyj kolejnej strony]";
  return { content: [{ type: "text" as const, text }] };
}

function fail(e: unknown) {
  const message = e instanceof ApiError ? e.message : `Błąd: ${(e as Error).message}`;
  const details = e instanceof ApiError && e.status === 422 ? (e.body as any)?.errors : undefined;
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: message, details }, null, 1) }] };
}

function needScope(claims: AccessClaims, scope: string) {
  if (!claims.scope.split(" ").includes(scope)) throw new Error(`Brak uprawnienia ${scope}. Połącz konektor ponownie i zaakceptuj ten zakres.`);
}

type Page<T = any> = { data: T[]; pagination?: { current_page: number; last_page: number; per_page: number; total: number } };

/** Fetches up to maxPages pages of a list endpoint (rate-limited by the client). */
async function collect(client: EprPilotClient, path: string, maxPages: number, query: Record<string, string | number | undefined> = {}) {
  const items: any[] = [];
  let page = 1, last = 1, total: number | undefined;
  do {
    const res = await client.get<Page>(path, { ...query, page });
    items.push(...(res.data ?? []));
    last = res.pagination?.last_page ?? 1;
    total = res.pagination?.total;
    page++;
  } while (page <= last && page <= maxPages);
  return { items, scannedPages: page - 1, lastPage: last, total, complete: page > last };
}

const textOf = (o: any) => [o?.sku, o?.ean, o?.name, o?.brand, o?.external_id].filter(Boolean).join(" ").toLowerCase();
const nonEmpty = (v: unknown) => Array.isArray(v) && v.length > 0;

/** Heuristic until the API documents its Product resource: product has no EPR classification at all. */
function isUnclassified(p: any): string[] {
  const missing: string[] = [];
  const hasPackaging = nonEmpty(p?.waste_packaging_sales) || nonEmpty(p?.waste_packaging_transportation) || nonEmpty(p?.packaging);
  const hasOther = nonEmpty(p?.waste_batteries) || nonEmpty(p?.waste_nonpackaging) || p?.waste_component_id != null;
  if (!hasPackaging && !hasOther) missing.push("brak opakowań, baterii i komponentów");
  if (p?.weight == null || Number(p.weight) === 0) missing.push("brak wagi produktu");
  return missing;
}

export function createAccountServer(claims: AccessClaims) {
  const client = new EprPilotClient(claims.t);
  const server = new McpServer(
    { name: "eprpilot-account", version: "0.2.0", title: "EPRPilot - Twoje konto" },
    {
      instructions:
        "Dostęp do konta klienta w aplikacji EPRPilot: produkty, zamówienia, raporty EPR i słowniki. " +
        "Na tym etapie wszystkie narzędzia tylko czytają dane. Nie pokazuj w czacie danych osobowych odbiorców zamówień (e-mail, imię, adres), " +
        "chyba że użytkownik wprost o nie prosi. Do pytań o przepisy EPR używaj publicznego konektora EPRPilot.",
    },
  );

  server.registerTool(
    "account_whoami",
    {
      title: "Sprawdź połączenie z kontem",
      description: "Sprawdza, czy konto EPRPilot jest połączone, i zwraca krótkie podsumowanie: liczbę produktów, zamówień i raportów.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const [p, o, r] = await Promise.all([
          client.get<Page>("/products"), client.get<Page>("/orders"), client.get<Page>("/reports"),
        ]);
        return out({
          connected: true,
          scopes: claims.scope.split(" "),
          products_total: p.pagination?.total ?? p.data?.length,
          orders_total: o.pagination?.total ?? o.data?.length,
          reports_total: r.pagination?.total ?? r.data?.length,
          note: "Etap 2a: dostęp tylko do odczytu.",
        });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "get_dictionary",
    {
      title: "Słownik EPRPilot",
      description: "Zwraca słownik referencyjny EPRPilot, np. rodzaje opakowań, baterii, komponentów, kraje, źródła sprzedaży. Potrzebny do klasyfikacji produktów (identyfikatory materiałów).",
      inputSchema: { dictionary: z.enum(DICTIONARIES).describe("Nazwa słownika.") },
      annotations: READ_ONLY,
    },
    async ({ dictionary }) => {
      try { needScope(claims, "catalog:read"); return out({ dictionary, data: await getDictionary(client, dictionary) }); }
      catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "list_products",
    {
      title: "Produkty",
      description: "Lista produktów z konta EPRPilot. Bez `search` zwraca jedną stronę. Z `search` (SKU, EAN, nazwa, marka) przeszukuje do `max_pages` stron.",
      inputSchema: {
        page: z.number().int().min(1).optional().describe("Numer strony (gdy bez search)."),
        search: z.string().min(1).optional().describe("Fragment SKU, EAN, nazwy lub marki."),
        max_pages: z.number().int().min(1).max(20).optional().describe("Ile stron przeszukać przy search (domyślnie 5)."),
      },
      annotations: READ_ONLY,
    },
    async ({ page, search, max_pages }) => {
      try {
        needScope(claims, "catalog:read");
        if (!search) return out(await client.get<Page>("/products", { page }));
        const r = await collect(client, "/products", max_pages ?? 5);
        const q = search.toLowerCase();
        const hits = r.items.filter((p) => textOf(p).includes(q));
        return out({ search, matches: hits.length, data: hits.slice(0, 50), scanned_pages: r.scannedPages, last_page: r.lastPage, complete: r.complete });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "get_product",
    {
      title: "Produkt",
      description: "Szczegóły produktu: opakowania sprzedażowe i transportowe, baterie, komponenty, wagi.",
      inputSchema: { product_id: z.union([z.string(), z.number()]).describe("ID produktu w EPRPilot.") },
      annotations: READ_ONLY,
    },
    async ({ product_id }) => {
      try { needScope(claims, "catalog:read"); return out(await client.get(`/products/${encodeURIComponent(String(product_id))}`)); }
      catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "find_unclassified_products",
    {
      title: "Produkty bez klasyfikacji EPR",
      description: "Znajduje produkty, które nie mają przypisanych opakowań, baterii ani komponentów albo nie mają wagi. Takie produkty zaniżają raporty EPR.",
      inputSchema: { max_pages: z.number().int().min(1).max(20).optional().describe("Ile stron przeszukać (domyślnie 10).") },
      annotations: READ_ONLY,
    },
    async ({ max_pages }) => {
      try {
        needScope(claims, "catalog:read");
        const r = await collect(client, "/products", max_pages ?? 10);
        const found = r.items
          .map((p) => ({ id: p.id, sku: p.sku, ean: p.ean, name: p.name, country: p.country, missing: isUnclassified(p) }))
          .filter((p) => p.missing.length);
        return out({ checked: r.items.length, total: r.total, unclassified: found.length, data: found.slice(0, 100), complete: r.complete });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "list_orders",
    {
      title: "Zamówienia",
      description: "Lista zamówień z konta EPRPilot (jedna strona). Dane odbiorców nie powinny być pokazywane w czacie bez potrzeby.",
      inputSchema: { page: z.number().int().min(1).optional() },
      annotations: READ_ONLY,
    },
    async ({ page }) => {
      try { needScope(claims, "orders:read"); return out(await client.get<Page>("/orders", { page })); }
      catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "get_order",
    {
      title: "Zamówienie",
      description: "Szczegóły zamówienia: pozycje (SKU/EAN, ilości), kraj odbiorcy, źródło sprzedaży.",
      inputSchema: { order_id: z.union([z.string(), z.number()]) },
      annotations: READ_ONLY,
    },
    async ({ order_id }) => {
      try { needScope(claims, "orders:read"); return out(await client.get(`/orders/${encodeURIComponent(String(order_id))}`)); }
      catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "list_reports",
    {
      title: "Raporty EPR",
      description: "Lista raportów EPR wygenerowanych w EPRPilot, opcjonalnie dla jednego kraju.",
      inputSchema: {
        country: z.string().length(2).optional().describe("Kod kraju ISO, np. PL, DE."),
        page: z.number().int().min(1).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ country, page }) => {
      try { needScope(claims, "reports:read"); return out(await client.get<Page>("/reports", { country: country?.toUpperCase(), page })); }
      catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "get_report",
    {
      title: "Raport EPR",
      description: "Szczegóły raportu EPR.",
      inputSchema: { report_id: z.union([z.string(), z.number()]) },
      annotations: READ_ONLY,
    },
    async ({ report_id }) => {
      try { needScope(claims, "reports:read"); return out(await client.get(`/reports/${encodeURIComponent(String(report_id))}`)); }
      catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "download_report",
    {
      title: "Pobierz raport EPR",
      description: "Pobiera zawartość raportu EPR (dane raportu lub link do pliku).",
      inputSchema: { report_id: z.union([z.string(), z.number()]) },
      annotations: READ_ONLY,
    },
    async ({ report_id }) => {
      try { needScope(claims, "reports:read"); return out(await client.get(`/reports/${encodeURIComponent(String(report_id))}/download`)); }
      catch (e) { return fail(e); }
    },
  );

  return server;
}
