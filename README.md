# EPRPilot MCP

Serwer MCP, który daje Claude'owi (i innym asystentom AI) wiedzę EPRPilot o EPR i PPWR.
Etap 1: wiedza i reguły, bez danych klientów. Etap 2: połączenie z API aplikacji EPRPilot.

## Narzędzia

| Narzędzie | Co robi |
|---|---|
| `check_epr_obligations` | Kraje + strumienie + rola firmy → gdzie prawdopodobnie trzeba się rejestrować, rejestry, organizacje odzysku, upoważniony przedstawiciel, liczba rejestracji, kolejne kroki |
| `get_country_epr_profile` | Profil kraju (rejestry, PRO, uwagi) + powiązane artykuły EPRPilot |
| `list_supported_countries` | 29 krajów (UE-27, UK, TR) |
| `ppwr_readiness_check` | Lista luk PPWR: dokumentacja, deklaracja zgodności, dowody od dostawców, metale ciężkie, PFAS, archiwizacja |
| `search_knowledge` | Wyszukiwanie w FAQ i blogu eprpilot.com (PL/EN/DE), z linkami do źródeł |
| `list_regulations` | Regulacje środowiskowe i status w EPRPilot |
| `get_eprpilot_offer` | Cennik, konsultacja, kontakt, rejestracje przez Otoneso |

Każda odpowiedź prowadzi do konsultacji (89 €) / modułu PPWR / rejestracji przez Otoneso.

## Dane (edycja bez programowania)

Wszystko w folderze `data/`. Zmiana pliku + ponowne wdrożenie = nowe odpowiedzi.

- `data/countries.json` — profile 29 krajów. **SZKIC — przed publicznym startem zweryfikuj z zespołem Otoneso**, potem uzupełnij `_meta.last_reviewed` i `reviewed_by`.
- `data/offer.json` — cennik, usługi, regulacje, zastrzeżenie prawne.
- `data/knowledge.json` — generowany ze strony: `python3 scripts/build_knowledge.py /ścieżka/do/repo/eprpilot` (wymaga `beautifulsoup4`). Uruchom po każdym nowym wpisie na blogu lub zmianie FAQ.

## Uruchomienie lokalne

```bash
npm install
npm run build
npm start                 # HTTP: http://localhost:3000/mcp
npm run start:stdio       # tryb stdio (Claude Desktop)
```

## Wdrożenie na Railway

1. Wrzuć ten folder do repozytorium GitHub (np. `proftheone/eprpilot-mcp`).
2. Railway → New Project → Deploy from GitHub repo. Railway wykryje `Dockerfile`.
3. Settings → Networking → Generate Domain (np. własna domena `mcp.eprpilot.com`).
4. Sprawdź: `https://<domena>/health` → `ok`.

Adres serwera MCP: `https://<domena>/mcp`

## Podłączenie w Claude

Claude (web/desktop) → Ustawienia → Konektory → Dodaj własny konektor → wklej `https://<domena>/mcp`.
Potem np.: „Sprzedaję kosmetyki pod własną marką z Polski do Niemiec, Francji i Czech przez Amazon. Jakie mam obowiązki EPR i PPWR?”

## Etap 2a — konto klienta (`/account/mcp`, OAuth)

Drugi endpoint, chroniony OAuth 2.1 (rejestracja dynamiczna, PKCE). Klient przy podłączaniu konektora wkleja swój token API EPRPilot;
serwer szyfruje go (AES-256-GCM) w wydawanych tokenach — **bez bazy danych**. Unieważnienie tokenu w EPRPilot odcina dostęp.

Narzędzia (tylko odczyt): `account_whoami`, `get_dictionary`, `list_products` (z wyszukiwaniem po SKU/EAN/nazwie), `get_product`,
`find_unclassified_products`, `list_orders`, `get_order`, `list_reports`, `get_report`, `download_report`.

Zmienne środowiskowe:

| Zmienna | Wymagana | Opis |
|---|---|---|
| `ENCRYPTION_KEY` | tak (dla `/account/mcp`) | 32 bajty base64: `openssl rand -base64 32`. Bez niej działa tylko publiczny `/mcp`. Zmiana klucza wylogowuje wszystkich. |
| `PUBLIC_BASE_URL` | nie | Np. `https://mcp-r0um.onrender.com`; domyślnie wyliczany z nagłówków. |
| `EPRPILOT_API_BASE` | nie | Domyślnie `https://app.eprpilot.com/api/v1`. |
| `EPRPILOT_RATE_LIMIT` | nie | Zapytań/min na konto, domyślnie 50 (API pozwala na 60). |

Podłączenie: Claude → Ustawienia → Konektory → Dodaj własny konektor → `https://<domena>/account/mcp` → zaloguj się tokenem API.

Projekt kolejnych etapów (zapis produktów, import zamówień, raporty): dokument „EPRPilot MCP – projekt fazy API”.

## Zastrzeżenie

Informacje mają charakter ogólny i nie stanowią porady prawnej.
