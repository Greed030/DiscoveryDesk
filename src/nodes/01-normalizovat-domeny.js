// Normalizovať domény (Code, Run Once for All Items)
// Vstup: zoznam domén z nody „Konfigurácia“ (pole `domeny`, oddelené čiarkou, medzerou alebo novým riadkom)
//        + na vstupe riadky výstupnej tabuľky z nody „Načítať spracované“ (už spracované firmy a ich status).
// Domény, ktoré už v tabuľke sú s konečným statusom (ok, rpo_not_found…), sa preskočia – nemíňajú sa tokeny
// a nevznikajú duplicity. Domény s dočasnou chybou (`opakovat_statusy`: web nedostupný, RPO timeout, chyba AI)
// sa spracujú znova a ich riadok v tabuľke sa prepíše. `preskocit_spracovane = false` → spracuje sa všetko.
// Výstup: jedna položka na doménu na spracovanie: { domena, vstup, chyby[], predchadzajuci_status? }

const cfg = $('Konfigurácia').first().json;
const raw = String(cfg.domeny ?? '').split(/[\s,;]+/);

// "https://www.Firma.sk/kontakt?x=1" → "firma.sk"; "info@firma.sk" → "firma.sk"
function normalizeDomain(input) {
  let s = String(input).trim().toLowerCase();
  if (s.includes('@') && !s.includes('/')) s = s.split('@').pop();
  return s
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // protokol
    .replace(/^\/\//, '')                   // //firma.sk
    .split(/[/?#\\]/)[0]                    // cesta, query, hash
    .replace(/:\d+$/, '')                   // port
    .replace(/\.+$/, '')                    // bodka na konci
    .replace(/^www\d*\./, '');              // www., www2.
}

// Aspoň „nieco.tld“; povolené písmená (aj IDN), číslice a pomlčky
const DOMAIN_RE = /^(?=.{3,253}$)(?:[\p{L}\d](?:[\p{L}\d-]{0,61}[\p{L}\d])?\.)+\p{L}{2,63}$/u;

// už spracované domény (riadky tabuľky; pri prázdnej/nedostupnej tabuľke prídu prázdne alebo chybové položky)
const processed = new Map();
for (const row of $input.all()) {
  const d = normalizeDomain(row.json.domena || '');
  if (d && row.json.status) processed.set(d, { status: String(row.json.status), timestamp: row.json.timestamp || '' });
}
const RETRY = new Set(String(cfg.opakovat_statusy || '').split(/[\s,;]+/).filter(Boolean));
const skipProcessed = cfg.preskocit_spracovane !== false;

const seen = new Set();
const out = [];
const skipped = [];
for (const value of raw) {
  if (!String(value).trim()) continue;
  const domena = normalizeDomain(value);
  if (seen.has(domena)) continue; // duplicity v zozname preskočíme
  seen.add(domena);
  const prev = processed.get(domena);
  if (skipProcessed && prev && !RETRY.has(prev.status)) { skipped.push(`${domena} (${prev.status})`); continue; }
  const item = { domena, vstup: String(value).trim(), chyby: [] };
  if (prev) item.predchadzajuci_status = prev.status; // spracúva sa znova po dočasnej chybe
  if (!DOMAIN_RE.test(domena)) item.chyby.push({ kod: 'invalid_domain', detail: item.vstup });
  out.push({ json: item });
}
// keď je všetko spracované, workflow tu skončí (výstup tejto nody je prázdny) – v logu je zoznam preskočených
if (skipped.length) console.log(`Preskočené (už v tabuľke): ${skipped.join(', ')}`);
return out;
