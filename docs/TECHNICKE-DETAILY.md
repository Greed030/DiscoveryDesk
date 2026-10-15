# DiscoveryDesk – technické detaily

## Nody workflow

| # | Noda | Typ | Úloha |
|---|---|---|---|
| 1 | Spustiť | Manual Trigger | spustenie |
| 2 | Konfigurácia | Set | všetky nastavenia na jednom mieste |
| 3 | Načítať spracované | Google Sheets (read) | už spracované firmy a ich status |
| 4 | Normalizovať domény | Code | `https://www.Firma.sk/kontakt` → `firma.sk`, duplicity, preskočenie hotových |
| 5 | Pre každú doménu | Loop Over Items | firmy po jednej – chyba jednej neovplyvní ostatné |
| 6 | Stiahnuť web | Code | https/http × www, presmerovania, kódovanie (UTF-8 / windows-1250), podstránky z odkazov, Jina pre JS weby |
| 7 | Extrahovať fakty | Code | IČO (regex + mod 11), názov, adresa, kontakty, text pre AI bez cookie líšt a menu |
| 8 | Overiť v RPO | Code | IČO → RPO; bez IČO presná zhoda názvu; právna forma, štatutári |
| 9 | Pripraviť AI požiadavku | Code | prompt + JSON schéma (strict) |
| 10 | Volať AI? | IF | bez textu webu sa AI nevolá |
| 11 | OpenAI — analýza | HTTP Request | Chat Completions so structured output, 3 pokusy |
| 12 | Validovať AI výstup | Code | kontrola tvaru a dĺžok, príprava opravy |
| 13 | Potrebná oprava? | IF | |
| 14 | OpenAI — oprava | HTTP Request | najviac jedna opravná požiadavka |
| 15 | Zostaviť výsledok | Code | `{value, source, verified}`, status, tokeny, cena, riadok tabuľky |
| 16 | Zapísať do Google Sheets | Google Sheets (append or update) | jeden riadok na doménu |
| 17 | Výsledky (JSON) | Code | plný JSON na firmu |

Každá Code noda je obalená do `try/catch` – neočakávaná chyba v kóde dá firme status `internal_error` a workflow pokračuje. OpenAI sa volá cez HTTP Request (nie cez OpenAI nodu), aby bol request nezávislý od verzie n8n: strict JSON schéma, presné `usage` na výpočet ceny, celá konverzácia pri oprave, parametre podľa modelu.

## Konfigurácia

| Pole | Predvolené | Význam |
|---|---|---|
| `domeny` | 3 testovacie domény | oddelené čiarkou alebo novým riadkom; akceptuje aj URL a e-mail |
| `model` | `gpt-4o-mini` | ľubovoľný chat model OpenAI; pre `o*` / `gpt-5*` sa automaticky použije `reasoning_effort` namiesto `temperature` |
| `cena_vstup_usd_1m`, `cena_vystup_usd_1m` | 0.15 / 0.60 | ceny tokenov na výpočet nákladov |
| `ai_api_url` | OpenAI Chat Completions | dá sa nahradiť kompatibilným API (Azure, proxy) |
| `google_sheet` | — | URL tabuľky (s `#gid=` pre konkrétny hárok) |
| `preskocit_spracovane` | true | firmy s konečným statusom v tabuľke sa preskočia |
| `opakovat_statusy` | web_unreachable, rpo_timeout, ai_error, internal_error | dočasné chyby – spracujú sa znova a riadok sa prepíše |
| `max_slov_email`, `min_slov_email` | 120 / 90 | limit e-mailu; kratší sa pošle na doplnenie, dlhší sa nikdy nepoužije |
| `odosielatel` | text | kto e-mail posiela – AI o odosielateľovi nič nevymýšľa |
| `max_podstranok`, `max_znakov_ai` | 8 / 24000 | koľko podstránok stiahnuť a koľko textu poslať do AI (~8k tokenov) |
| `web_timeout_ms`, `rpo_timeout_ms` | 20000 / 90000 | timeouty |
| `pouzit_jina` | true | záloha cez r.jina.ai |

**Domény zo zdrojovej tabuľky:** pred *Konfigurácia* vložte Google Sheets „Get row(s)“ so stĺpcom `domena`, v *Konfigurácia* zapnite *Settings → Execute Once* a pole `domeny` nastavte výrazom `{{ $input.all().map(i => i.json.domena).join(', ') }}`.

## Presnosť údajov

- **IČO** – číslo pri označení `IČO` / `IČ` / `I.Č.O.` / `Identifikačné číslo` (nie `DIČ`, nie `IČ DPH`), 6–8 číslic aj s medzerami, doplnené nulami na 8 číslic a overené **kontrolným súčtom mod 11**. Neplatné sa zahodia (`ico_invalid_checksum`).
- **Podstránky** sa hľadajú v odkazoch z hlavnej stránky (kontakt, o nás, VOP, GDPR, reklamácie, služby), typické cesty (`/kontakt`, `/o-nas`, `/obchodne-podmienky`, `/gdpr`, `/reklamacny-poriadok`) sa doplnia, ak chýbajú. Duplicitné stránky („soft 404“) a stránky ochrany proti robotom sa zahodia.
- **Viac IČO na webe** (partneri, spracovatelia údajov): overí sa až 5 kandidátov, vyberie sa ten, ktorého názov v RPO sedí s hlavným názvom webu.
- **Názov firmy z webu** – len názvy s právnou formou zo stránok, kde býva prevádzkovateľ (hlavná, kontakt, VOP, GDPR); mená iných firm zo stránok s ponukou (inzerenti, partneri) sa ignorujú.
- **Bez IČO na webe** – hľadanie v RPO podľa názvu, prijme sa iba: presná zhoda celého názvu aj s právnou formou (aktuálneho alebo bývalého), alebo zhoda názvu a obce z webu. Viac zhôd → `multiple_matches`, nič → `rpo_not_found` s podobnými subjektmi.
- **Sídlo vždy z RPO.** Adresa na webe je často prevádzka – zapisuje sa zvlášť (`adresa_web`).
- **`verified: true`** iba keď je firma z webu potvrdená v RPO cez IČO; zhoda podľa názvu je vždy `verified: false` s poznámkou „overte“.

## AI výstup

Jedno volanie, structured output so strict JSON schémou. Poradie polí určuje, v akom poradí model píše: najprv `zistenia` (4–6 faktov z webu, aj čo firma už má online), potom `popis`, `odvetvie`, `kvalita_podkladov`, `prilezitosti`, `email_predmet`, `email`.

Pravidlá v prompte: len fakty z podkladov, IČO nespomínať, nenavrhovať čo firma už má, žiadne všeobecné zdôvodnenia („na webe sú kontakty“), chatbot len pri reálne opakovaných otázkach, každá príležitosť = spúšťač → čo robí AI → výsledok. E-mail: vykanie, prvá osoba množného čísla, štruktúra predstavenie → konkrétne pozorovanie → jeden nápad s úsporou času → nezáväzné pozvanie na 15-minútový hovor → poďakovanie.

Validácia kódom: platný JSON, popis 2–3 vety (skratky ako „s. r. o.“ sa nerátajú ako koniec vety), presne 3 príležitosti so všetkými poľami, náročnosť ∈ {nízka, stredná, vysoká}, e-mail 90–120 slov. Pri probléme jedna opravná požiadavka; opravená verzia sa použije, len ak nie je horšia (e-mail nad 120 slov je tvrdé porušenie, kratší ako 90 len informácia).

## Statusy a upozornenia

Status je najvážnejší problém v poradí `internal_error` › `invalid_domain` › `web_unreachable` › `ai_error` › `rpo_timeout` › `multiple_matches` › `rpo_not_found` › `ico_not_found_on_web` › `ok`. Všetky problémy sú v `chyby[]` s kódom, závažnosťou, slovenskou správou a detailom.

Upozornenia (status ostáva): `multiple_ico_on_web`, `ico_invalid_checksum`, `name_mismatch`, `name_changed`, `company_terminated`, `low_web_content`, `email_too_long`, `email_too_short`, `ai_output_invalid`, `jina_fallback`, `rpo_entity_unavailable`.

## Výstup

**Google Sheets** – jeden riadok na doménu (zápis „append or update“ podľa `domena`):
`domena, status, nazov, ico, ico_verified, sidlo, popis, prilezitost_1..3, email, zdroje, chyby, timestamp, pravna_forma, statutari, adresa_web, kontakt_web, kvalita_podkladov, zistenia, tokeny, cena_usd, model, json`.

**JSON na firmu** (skrátene):

```json
{
  "domena": "gesan.sk",
  "status": "ok",
  "firma": {
    "nazov": { "value": "GESAN s. r. o.", "source": "rpo", "verified": true },
    "ico":   { "value": "44753152", "source": "web+rpo", "verified": true, "url": "https://www.gesan.sk/kontakt/" },
    "sidlo": { "value": "Výtvarná 19, 821 06 Bratislava", "source": "rpo", "verified": true },
    "pravna_forma": { "value": "Spoločnosť s ručením obmedzeným", "source": "rpo", "verified": true },
    "statutari": { "value": ["Ing. Tibor Šallay (konateľ)", "Igor Šallay (konateľ)"], "source": "rpo", "verified": true },
    "adresa_na_webe": { "value": "Dvojkrížna 28, 821 06 Bratislava", "source": "web", "verified": false },
    "rpo_url": "https://api.statistics.sk/rpo/v1/entity/719708"
  },
  "popis": { "value": "…", "source": "ai (text webu + RPO)", "kvalita_podkladov": "dostatočné" },
  "zistenia": { "value": ["…"], "source": "ai (fakty z textu webu)" },
  "prilezitosti": [{ "nazov": "…", "co_sa_automatizuje": "…", "uspora_casu": "odhad …", "narocnost": "nízka", "preco_prave_vy": "…" }],
  "email": { "predmet": "…", "text": "Dobrý deň, …", "pocet_slov": 96 },
  "chyby": [],
  "zdroje": ["https://www.gesan.sk/", "https://www.gesan.sk/kontakt/", "https://www.gesan.sk/produkty/", "https://api.statistics.sk/rpo/v1/entity/719708"],
  "tokeny": { "vstup": 3462, "vystup": 766, "volania": 1, "spolu": 4228, "model": "gpt-4o-mini-2024-07-18", "cena_usd": 0.000979 }
}
```

## Vývoj a testy

```
node src/build-workflow.mjs                    # zostaví discoverydesk.workflow.json zo src/
node test/run-local.mjs gesan.sk dalsia.sk     # web + RPO lokálne, AI simulované (alebo OPENAI_API_KEY=… skutočné)
node test/collect-results.mjs                  # výsledky posledného behu z DB n8n → results/
```

Lokálny test spúšťa kód nód v rovnakom VM sandboxe ako task runner n8n 2.x (bez triedy `URL`, zmrazené vstavané objekty) a HTTP volania idú cez skutočnú funkciu `httpRequest` z n8n-core. Prepínače: `CFG='{"rpo_timeout_ms":1}'` (simulácia timeoutu), `MOCK_FAIL=1` (chyba OpenAI), `MOCK_WORDS=50,100` (dĺžka e-mailu), `SHEET_ROWS='[…]'` (už spracované firmy).

## Obmedzenia

- IČO len v obrázku alebo v PDF sa nenájde → hľadanie podľa názvu (alebo `rpo_not_found`).
- RPO obsahuje slovenské subjekty; zahraničná firma bez slovenskej organizačnej zložky skončí `rpo_not_found`.
- Odhady úspory času sú orientačné (AI ich označuje ako odhad) – slúžia na otvorenie rozhovoru.
- `gpt-4o-mini` občas spraví gramatickú chybu v slovenčine; lepší jazyk dá `gpt-4.1-mini` (zmena jedného poľa).
- Jina bez kľúča má limit ~20 požiadaviek za minútu.
- Code noda má v task runneri limit 300 s; workflow má vlastný časový rozpočet (RPO ~250 s), takže limit neprekročí.
