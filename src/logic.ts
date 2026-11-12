import { countries, countriesFile, knowledge, offer, resolveCountry, type Stream, type KnowledgeEntry } from "./data.js";

export type Role =
  | "manufacturer"
  | "brand_owner"
  | "importer"
  | "distributor"
  | "marketplace_seller"
  | "ecommerce_own_shop";

const STREAM_LABEL: Record<Stream, string> = {
  packaging: "opakowania",
  weee: "sprzęt elektryczny i elektroniczny (WEEE)",
  batteries: "baterie i akumulatory",
};

function consultationUrl(lang: string) {
  const c = offer.services.find((s) => s.id === "consultation")!;
  return lang === "en" ? c.url_en : lang === "de" ? c.url_de : c.url;
}

// ---------------------------------------------------------------------------
// 1. EPR obligations check
// ---------------------------------------------------------------------------

export interface ObligationInput {
  countries: string[];
  streams: Stream[];
  established_in?: string;
  role: Role;
  b2c?: boolean;
  uses_marketplace?: boolean;
  supplier_registered_locally?: boolean;
  lang?: string;
}

function authorisedRep(stream: Stream, eu: boolean, established: boolean) {
  if (established) return { status: "not_needed", basis: "Firma ma siedzibę w tym kraju." };
  if (!eu) return { status: "check", basis: "Kraj spoza UE - zasady wg prawa krajowego." };
  switch (stream) {
    case "weee":
      return { status: "required", basis: "Dyrektywa WEEE 2012/19/UE, art. 17 - sprzedaż na odległość bez siedziby w kraju." };
    case "batteries":
      return { status: "required", basis: "Rozporządzenie bateryjne (UE) 2023/1542, art. 55." };
    case "packaging":
      return { status: "required", basis: "PPWR (UE) 2025/40, art. 45 - od 12.08.2026, w każdym państwie bez siedziby." };
  }
}

export function checkObligations(input: ObligationInput) {
  const lang = input.lang ?? "pl";
  const established = input.established_in ? resolveCountry(input.established_in) : null;
  const b2c = input.b2c ?? true;
  const unknown: string[] = [];
  const results: unknown[] = [];
  let registrations = 0;

  for (const raw of input.countries) {
    const code = resolveCountry(raw);
    if (!code) {
      unknown.push(raw);
      continue;
    }
    const c = countries[code];
    const isHome = established === code;
    const streams = input.streams.map((stream) => {
      const info = c[stream];
      let obligation: "likely" | "depends" = "likely";
      const reasons: string[] = [];

      if (input.role === "distributor" && input.supplier_registered_locally) {
        obligation = "depends";
        reasons.push("Dostawca jest zarejestrowanym producentem w tym kraju - obowiązek może leżeć po jego stronie. Potwierdź to na piśmie (numer rejestrowy dostawcy).");
      } else if (input.role === "distributor") {
        reasons.push("Jeśli jako pierwszy wprowadzasz towar na rynek tego kraju, obowiązki producenta zwykle spoczywają na Tobie.");
      }
      if (input.role === "brand_owner") reasons.push("Firma, pod której marką produkt trafia na rynek, jest najczęściej traktowana jak producent.");
      if (input.role === "importer") reasons.push("Pierwsze wprowadzenie towaru spoza kraju/UE - obowiązek zwykle spoczywa na importerze.");
      if (b2c && !isHome) reasons.push("Liczy się kraj dostawy do konsumenta końcowego, a nie siedziba firmy.");
      if (stream === "packaging") reasons.push("Wliczają się też opakowania wysyłkowe: karton, wypełniacz, folia, taśma.");
      if (stream === "weee" && !input.streams.includes("batteries")) reasons.push("Jeśli urządzenia mają baterie (także wbudowane), dochodzi osobny strumień: baterie.");

      if (obligation === "likely") registrations++;
      return {
        stream,
        stream_label: STREAM_LABEL[stream],
        obligation,
        register: info.register,
        pros_examples: info.pros ?? [],
        authorised_representative: authorisedRep(stream, c.eu, isHome),
        notes: [info.notes, ...reasons].filter(Boolean),
      };
    });

    results.push({
      country: code,
      name: lang === "pl" ? c.name_pl : c.name_en,
      eu_member: c.eu,
      ppwr_applies: c.eu,
      other_epr_streams_in_country: c.other_streams ?? [],
      streams,
    });
  }

  const general: string[] = [
    "EPR działa krajowo: osobna rejestracja w każdym kraju i dla każdego strumienia.",
  ];
  if (input.uses_marketplace) {
    general.push("Marketplace zazwyczaj nie zdejmuje obowiązku - weryfikuje numer EPR sprzedawcy i może blokować oferty bez niego (np. Amazon, Zalando, TikTok Shop).");
  }
  if (input.streams.includes("packaging") && countries && results.some((r: any) => r.ppwr_applies)) {
    general.push("Na rynkach UE od 12.08.2026 dochodzą wymagania PPWR (deklaracje zgodności, dokumentacja techniczna) - użyj narzędzia ppwr_readiness_check.");
  }

  return {
    summary: {
      countries_checked: results.length,
      estimated_registrations: registrations,
      unknown_countries: unknown,
    },
    results,
    general_notes: general,
    next_steps: [
      "Zbierz dane: listę SKU, kraje dostawy, masy materiałów opakowań, sprzęt i baterie wg kategorii.",
      "Sprawdź, gdzie masz już numery rejestrowe i umowy z organizacjami odzysku.",
      `Umów konsultację EPR i PPWR (60 min, 89 €): ${consultationUrl(lang)}`,
      `Rejestracje w krajach realizuje agencja ${offer.partner_agency.name}: ${offer.partner_agency.url}`,
    ],
    data_status: countriesFile._meta.verification_status,
    disclaimer: lang === "pl" ? offer.disclaimer_pl : offer.disclaimer_en,
  };
}

export function countryProfile(country: string, lang = "pl") {
  const code = resolveCountry(country);
  if (!code) return { error: `Nieznany kraj: ${country}. Obsługiwane: ${Object.keys(countries).join(", ")}` };
  const c = countries[code];
  // Stem names so inflected forms match ("Czechy" -> "czec" matches "w Czechach").
  const stem = (n: string) => n.toLowerCase().slice(0, Math.max(4, n.length - 2));
  const needles = [stem(c.name_pl), stem(c.name_en)];
  const related = knowledge
    .filter((k) => k.lang === (lang === "de" ? "de" : lang === "en" ? "en" : "pl"))
    .filter((k) => needles.some((n) => new RegExp(`(^|[^a-ząćęłńóśźżäöüß])${n}`).test(k.title.toLowerCase())))
    .slice(0, 5)
    .map((k) => ({ title: k.title, url: k.url }));
  return {
    country: code,
    ...c,
    related_content: related,
    data_status: countriesFile._meta.verification_status,
    disclaimer: lang === "pl" ? offer.disclaimer_pl : offer.disclaimer_en,
  };
}

// ---------------------------------------------------------------------------
// 2. PPWR readiness
// ---------------------------------------------------------------------------

export interface PpwrInput {
  role: "packaging_manufacturer" | "product_manufacturer" | "brand_owner" | "importer" | "distributor" | "ecommerce";
  food_contact?: boolean;
  reusable?: boolean;
  has_technical_documentation?: boolean;
  has_declaration_of_conformity?: boolean;
  has_supplier_evidence?: boolean;
  has_heavy_metals_test_reports?: boolean;
  has_pfas_evidence?: boolean;
  packaging_sku_count?: number;
  lang?: string;
}

type Status = "ok" | "gap" | "check";

export function ppwrReadiness(input: PpwrInput) {
  const lang = input.lang ?? "pl";
  const items: { area: string; status: Status; detail: string; basis?: string }[] = [];
  const yes = (v?: boolean): Status => (v === true ? "ok" : v === false ? "gap" : "check");

  const issuesDoc = ["packaging_manufacturer", "product_manufacturer", "brand_owner", "importer"].includes(input.role);

  if (issuesDoc) {
    items.push({
      area: "Dokumentacja techniczna",
      status: yes(input.has_technical_documentation),
      detail: "Dla każdego opakowania: materiały i wagi komponentów, substancje, dane projektowe do oceny recyklingowalności.",
      basis: "PPWR art. 15, art. 38, załącznik VII",
    });
    items.push({
      area: "Deklaracja zgodności UE",
      status: yes(input.has_declaration_of_conformity),
      detail: "Jedna deklaracja = jedno opakowanie (nie cała firma ani cała kategoria). Wzór wg załącznika VIII.",
      basis: "PPWR art. 39, załącznik VIII",
    });
  }
  if (input.role === "importer") {
    items.push({
      area: "Obowiązki importera",
      status: "check",
      detail: "Gdy producent jest spoza UE, organ nadzoru kontaktuje się z importerem. Sprawdź, czy producent przeprowadził ocenę zgodności i masz dostęp do dokumentacji.",
    });
  }
  if (input.role === "brand_owner") {
    items.push({
      area: "Marka własna = producent",
      status: "check",
      detail: "Zapis w umowie, że dostawca gwarantuje zgodność, nie przenosi obowiązków ustawowych. To Twoja firma podpisuje deklarację.",
    });
  }
  if (input.role === "distributor") {
    items.push({
      area: "Weryfikacja dostawców",
      status: yes(input.has_supplier_evidence),
      detail: "Przed dalszą sprzedażą sprawdź, czy opakowania mają deklaracje zgodności i oznakowanie.",
    });
  }
  items.push({
    area: "Dowody od dostawców",
    status: yes(input.has_supplier_evidence),
    detail: "Ogólne „deklaracje PPWR” dla całego asortymentu zwykle nie wystarczą - potrzebne są dokumenty przypisane do konkretnego opakowania/indeksu.",
  });
  items.push({
    area: "Metale ciężkie (Pb, Cd, Hg, Cr VI)",
    status: yes(input.has_heavy_metals_test_reports),
    detail: "Limit 100 mg/kg to SUMA czterech metali, nie limit dla każdego osobno. Jednostronicowe oświadczenie „poniżej 100 ppm” często nie obroni dokumentacji.",
    basis: "PPWR art. 5",
  });
  if (input.food_contact) {
    items.push({
      area: "PFAS w opakowaniach do żywności",
      status: yes(input.has_pfas_evidence),
      detail: "Zakaz celowo dodanych PFAS w opakowaniach mających kontakt z żywnością.",
      basis: "PPWR art. 5",
    });
  }
  items.push({
    area: "Archiwizacja",
    status: "check",
    detail: input.reusable
      ? "Opakowania wielokrotnego użytku: dokumentację przechowuj 10 lat."
      : "Opakowania jednorazowe: dokumentację przechowuj 5 lat (wielokrotnego użytku: 10 lat).",
  });
  items.push({
    area: "Rejestracje EPR",
    status: "check",
    detail: "PPWR nie zastępuje krajowych rejestracji EPR (w Polsce BDO) - to osobny obowiązek w każdym kraju sprzedaży.",
  });
  items.push({
    area: "Tempo odpowiedzi klientom",
    status: "check",
    detail: "Sieci handlowe i odbiorcy B2B dopisują do umów klauzule o przekazaniu deklaracji w krótkim terminie (często 10 dni).",
  });

  const gaps = items.filter((i) => i.status === "gap").length;
  const unknown = items.filter((i) => i.status === "check").length;
  const many = (input.packaging_sku_count ?? 0) > 50;

  return {
    applies_from: "2026-08-12",
    regulation: "Rozporządzenie (UE) 2025/40 (PPWR)",
    readiness: gaps === 0 && unknown <= 3 ? "dobra" : gaps <= 2 ? "częściowa" : "niska",
    gaps,
    to_verify: unknown,
    checklist: items,
    recommendation: many
      ? "Przy dużej liczbie opakowań/SKU potrzebna jest jedna baza danych opakowań i dostawców - inaczej deklaracje się rozjeżdżają. Moduł PPWR w EPRPilot (9,90 €/mies.) generuje deklaracje z tej bazy."
      : "Zacznij od listy opakowań i dowodów od dostawców dla każdego z nich. Moduł PPWR w EPRPilot (9,90 €/mies.) prowadzi przez deklarację krok po kroku.",
    next_steps: [
      "Bezpłatny 30-min przegląd dokumentów od dostawców (zespół EPRPilot/Otoneso).",
      `Konsultacja EPR i PPWR: ${consultationUrl(lang)}`,
      "Demo modułu PPWR: https://eprpilot.com/ppwr",
    ],
    disclaimer: lang === "pl" ? offer.disclaimer_pl : offer.disclaimer_en,
  };
}

// ---------------------------------------------------------------------------
// 3. Knowledge search (simple BM25 over FAQ + blog of eprpilot.com)
// ---------------------------------------------------------------------------

const STOP = new Set("i w z na do o od się czy to jak jest są dla nie co a the of and to in for is are on a an with by be or der die das und ist im mit von zu".split(" "));

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 5 ? t.slice(0, t.length - 2) : t)); // crude stemming for PL/EN/DE inflection
}

interface Doc { entry: KnowledgeEntry; tf: Map<string, number>; len: number }
const docs: Doc[] = knowledge.map((entry) => {
  const toks = [...tokenize(entry.title), ...tokenize(entry.title), ...tokenize(entry.summary ?? ""), ...tokenize(entry.text)];
  const tf = new Map<string, number>();
  for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
  return { entry, tf, len: toks.length };
});
const avgLen = docs.reduce((a, d) => a + d.len, 0) / Math.max(docs.length, 1);
const df = new Map<string, number>();
for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);

function snippet(text: string, terms: string[], size = 600): string {
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.slice(0, Math.max(4, t.length)));
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  const start = Math.max(0, pos - 150);
  const s = text.slice(start, start + size);
  return (start > 0 ? "…" : "") + s + (start + size < text.length ? "…" : "");
}

export function searchKnowledge(query: string, lang?: string, limit = 5) {
  const q = tokenize(query);
  const k1 = 1.4, b = 0.75, N = docs.length;
  const scored = docs
    .filter((d) => !lang || d.entry.lang === lang)
    .map((d) => {
      let score = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgLen)));
      }
      return { d, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    query,
    results: scored.map(({ d, score }) => ({
      type: d.entry.type,
      lang: d.entry.lang,
      title: d.entry.title,
      url: d.entry.url,
      score: Math.round(score * 100) / 100,
      content: d.entry.type === "faq" ? d.entry.text : snippet(d.entry.text, query.toLowerCase().split(/\s+/)),
    })),
    note: scored.length
      ? "Treści pochodzą z bazy wiedzy i bloga eprpilot.com. Cytuj źródło (url)."
      : "Brak trafień w bazie wiedzy EPRPilot. Nie zgaduj - zaproponuj konsultację.",
  };
}
