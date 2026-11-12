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

## Etap 2 — dane klientów (po otrzymaniu dokumentacji API)

Planowane narzędzia (wymagają logowania OAuth do konta EPRPilot):
`list_products`, `classify_products`, `calculate_fees`, `get_deadlines`, `generate_report`, `list_documents`, `create_ppwr_declaration`, `request_registration`.

## Zastrzeżenie

Informacje mają charakter ogólny i nie stanowią porady prawnej.
