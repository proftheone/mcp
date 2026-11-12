import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? join(here, "..", "data");

function load<T>(file: string): T {
  return JSON.parse(readFileSync(join(DATA_DIR, file), "utf-8")) as T;
}

export type Stream = "packaging" | "weee" | "batteries";

export interface StreamInfo {
  register: string | null;
  pros?: string[];
  notes: string | null;
}

export interface Country {
  name_pl: string;
  name_en: string;
  eu: boolean;
  packaging: StreamInfo;
  weee: StreamInfo;
  batteries: StreamInfo;
  other_streams?: string[];
}

export interface CountriesFile {
  _meta: { verification_status: string; last_reviewed: string | null };
  countries: Record<string, Country>;
}

export interface KnowledgeEntry {
  id: string;
  type: "faq" | "article";
  lang: "pl" | "en" | "de";
  title: string;
  summary?: string;
  text: string;
  url: string;
}

export interface Offer {
  brand: string;
  partner_agency: { name: string; url: string; role: string };
  contact: { email: string; phone: string; app_login: string };
  plans: { id: string; name: string; price: string; notes: string }[];
  services: { id: string; name: string; price: string; url?: string; url_en?: string; url_de?: string; duration?: string; notes?: string }[];
  regulations: { id: string; name: string; status: string; summary: string }[];
  disclaimer_pl: string;
  disclaimer_en: string;
}

export const countriesFile = load<CountriesFile>("countries.json");
export const countries = countriesFile.countries;
export const knowledge = load<KnowledgeEntry[]>("knowledge.json");
export const offer = load<Offer>("offer.json");

/** Accepts ISO codes (PL, DE, UK/GB) and Polish/English names. */
export function resolveCountry(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const code = s.toUpperCase() === "UK" ? "GB" : s.toUpperCase();
  if (countries[code]) return code;
  for (const [c, info] of Object.entries(countries)) {
    if (info.name_pl.toLowerCase() === s || info.name_en.toLowerCase() === s) return c;
  }
  return null;
}
