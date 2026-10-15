// Overiť v RPO (Code, Run Once for Each Item)
// Register právnických osôb – https://api.statistics.sk/rpo/v1 (zadarmo, bez kľúča, licencia CC BY 4.0)
// 1) IČO z webu → GET /search?identifier=<IČO> → GET /entity/<id> (právna forma, štatutári, predmet činnosti).
//    Ak sa názov v RPO nezhoduje s webom a na webe je viac IČO, overí sa ďalší kandidát.
// 2) IČO na webe nie je → GET /search?fullName=<názov z webu>. Firma sa prijme IBA ak:
//    a) presne sedí celý názov aj s právnou formou ("Profesia, spol. s r.o." ≠ "Profesia s. r. o."), aktuálny
//       alebo bývalý (firma sa premenovala, web uvádza starý názov), a takáto firma je jediná;
//    b) pri slabšom dôkaze (názov bez právnej formy, titulok webu) navyše sedí obec z adresy na webe.
//    Viac zhôd → multiple_matches + kandidáti, žiadna → rpo_not_found + podobné subjekty. Nič sa nevyberá náhodne.
// Timeout `rpo_timeout_ms` (90 s) + 1 opakovanie; celkový rozpočet ~250 s (limit task runnera je 300 s).
// Výstup: $json.rpo = { stav: ok | not_found | multiple | timeout | preskocene, nazov, ico, sidlo, … }

const cfg = $('Konfigurácia').first().json;
const H = typeof helpers !== 'undefined' ? helpers : this.helpers;
const API = 'https://api.statistics.sk/rpo/v1';
const T0 = Date.now();
const BUDGET = 250000;
const TIMEOUT = Number(cfg.rpo_timeout_ms) || 90000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const item = { ...$json, chyby: [...($json.chyby || [])] };
item.rpo = { stav: 'preskocene' };
if (!item.web?.ok) return { json: item };
const f = item.fakty || {};

// ---------- volanie API s timeoutom a opakovaním ----------
async function rpoGet(path, qs) {
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const left = BUDGET - (Date.now() - T0);
    if (left < 5000) { lastErr = lastErr || 'vyčerpaný časový limit'; break; }
    try {
      const res = await H.httpRequest({
        method: 'GET', url: API + path, qs, json: true, timeout: Math.min(TIMEOUT, left - 2000),
        returnFullResponse: true, ignoreHttpStatusErrors: true,
      });
      if (res.statusCode === 200) return typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
      if (res.statusCode === 404) return null;
      lastErr = `HTTP ${res.statusCode}`;
    } catch (e) {
      lastErr = String(e.message || e).slice(0, 200);
    }
    if (attempt < 2) await sleep(3000);
  }
  const err = new Error(lastErr);
  err.rpoTimeout = true;
  throw err;
}

// ---------- porovnávanie názvov ----------
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const LF_NORM = /\b(spol s r o|s r o|sro|a s|k s|v o s|j s a|n o|o z|s p|druzstvo|v likvidacii|organizacna zlozka)\b/g;
const full = s => norm(s).replace(/[^a-z0-9]/g, '');                                   // "GESAN, s. r. o." → "gesansro"
const core = s => norm(s).replace(/[^a-z0-9]+/g, ' ').replace(LF_NORM, ' ').replace(/\s+/g, ' ').trim(); // → "gesan"
function namesMatch(a, b) { // voľnejšie porovnanie (pre kontrolu IČO ↔ názov)
  const x = core(a), y = core(b);
  if (!x || !y) return false;
  if (x === y || x.replace(/ /g, '') === y.replace(/ /g, '')) return true;
  const [short, long] = x.length <= y.length ? [x.split(' '), y.split(' ')] : [y.split(' '), x.split(' ')];
  return short.join('').length >= 3 && short.every(t => long.includes(t)); // "COFFIX" ⊂ "Kontakt COFFIX"
}
const current = arr => (arr || []).filter(x => !x.validTo);
const last = arr => { const c = current(arr); return c.length ? c[c.length - 1] : (arr || [])[arr ? arr.length - 1 : 0]; };
const formerNames = r => (r.fullNames || []).filter(n => n.validTo);
const cityOk = r => (f.obce_web || []).some(o => norm(last(r.addresses)?.municipality?.value).startsWith(o));

// ---------- formátovanie ----------
function fmtAddress(a) {
  if (!a) return null;
  const num = [a.regNumber ? a.regNumber : null, a.buildingNumber].filter(Boolean).join('/');
  const street = [a.street || (num ? a.municipality?.value : ''), num].filter(Boolean).join(' ');
  const psc = String((a.postalCodes || [])[0] || '').replace(/^(\d{3})(\d{2})$/, '$1 $2');
  const country = a.country?.value && a.country.code !== '703' ? ', ' + a.country.value : '';
  return [street, [psc, a.municipality?.value].filter(Boolean).join(' ')].filter(Boolean).join(', ') + country || null;
}
function summarize(e, metoda) {
  const addr = last(e.addresses);
  const activities = current(e.activities).map(a => String(a.economicActivityDescription || '').replace(/[,;\s]+$/, '')).filter(Boolean);
  return {
    stav: 'ok', metoda, id: e.id,
    nazov: last(e.fullNames)?.value || null,
    byvale_nazvy: formerNames(e).map(n => `${n.value} (do ${n.validTo})`).slice(-3),
    ico: last(e.identifiers)?.value || null,
    sidlo: fmtAddress(addr),
    obec: addr?.municipality?.value || null,
    pravna_forma: last(e.legalForms)?.value?.value || null,
    datum_vzniku: e.establishment || null,
    datum_zaniku: e.terminationDate || null,
    statutari: current(e.statutoryBodies).map(s => {
      const n = s.personName?.formatedName || [...(s.personName?.givenNames || []), ...(s.personName?.familyNames || [])].join(' ') || s.fullName;
      return n ? `${n}${s.stakeholderType?.value ? ' (' + s.stakeholderType.value.toLowerCase() + ')' : ''}` : null;
    }).filter(Boolean).slice(0, 5),
    predmet_cinnosti: activities.slice(0, 12),
    url: `${API}/entity/${e.id}`,
  };
}
const candidate = r => ({ nazov: last(r.fullNames)?.value || null, ico: last(r.identifiers)?.value || null, sidlo: fmtAddress(last(r.addresses)) });

const strongNames = (f.nazvy_web || []).filter(n => n.source === 'web');      // s právnou formou
const weakNames = (f.nazvy_web || []).filter(n => n.source !== 'web');        // titulok, og:site_name
const domainLabel = item.domena.split('.')[0].replace(/-/g, ' ');

// ---------- hľadanie ----------
let chosen = null;
try {
  if ((f.ico_kandidati || []).length) {
    // 1) podľa IČO z webu. Na webe môže byť viac IČO (partneri, spracovatelia údajov, dopravcovia…),
    //    preto overíme až 5 kandidátov a vyberieme ten, ktorého názov najlepšie sedí s hlavným názvom webu:
    //    3 = aktuálny názov = hlavný názov webu, 2 = aktuálny názov = iný názov z webu / doména,
    //    1 = bývalý názov = hlavný názov webu (firma sa premenovala), 0 = bez zhody
    const primary = (f.nazvy_web || [])[0]?.value;
    const evidence = [...(f.nazvy_web || []).map(n => n.value), domainLabel];
    const checked = [];
    for (const c of f.ico_kandidati.slice(0, 5)) {
      const res = await rpoGet('/search', { identifier: c.ico });
      const hit = (res?.results || []).find(r => (r.identifiers || []).some(i => i.value === c.ico));
      checked.push(c.ico);
      if (!hit) continue;
      const curName = last(hit.fullNames)?.value;
      const rank = primary && namesMatch(primary, curName) ? 3
        : evidence.some(n => namesMatch(n, curName)) ? 2
        : primary && formerNames(hit).some(h => namesMatch(primary, h.value)) ? 1 : 0;
      if (!chosen || rank > chosen.rank) chosen = { hit, metoda: 'ico', rank, match: rank > 0, renamed: rank === 1 };
      if (rank === 3) break;
    }
    if (!chosen) {
      item.rpo = { stav: 'not_found', hladane_ico: checked };
      item.chyby.push({ kod: 'rpo_not_found', detail: `IČO ${checked.join(', ')} sa v RPO nenašlo` });
    }
  } else {
    // 2) podľa názvu. RPO hľadá podreťazec v aktuálnych aj bývalých názvoch → presnú zhodu overujeme sami.
    const similar = [];
    // názvy s právnou formou majú prednosť; titulok webu / doménu skúšame, len keď iné nie sú
    const queries = (strongNames.length
      ? strongNames.slice(0, 2).map(n => ({ q: n.bez_formy, fullName: n.value, strong: true }))
      : [...weakNames.map(n => n.bez_formy), domainLabel].map(q => ({ q, strong: false }))
    ).filter((x, i, a) => core(x.q).length >= 3 && a.findIndex(y => core(y.q) === core(x.q)) === i).slice(0, 3);

    for (const { q, fullName, strong } of queries) {
      if (chosen || item.rpo.stav === 'multiple') break;
      const res = await rpoGet('/search', { fullName: q });
      const active = (res?.results || []).filter(r => !r.terminationDate && current(r.fullNames).length);
      if (strong) {
        const exact = active.filter(r => full(last(r.fullNames)?.value) === full(fullName));
        const former = active.filter(r => formerNames(r).some(n => full(n.value) === full(fullName)));
        if (exact.length === 1) chosen = { hit: exact[0], metoda: 'nazov', match: true };
        else if (exact.length > 1) {
          const byCity = exact.filter(cityOk);
          if (byCity.length === 1) chosen = { hit: byCity[0], metoda: 'nazov+obec', match: true };
          else {
            item.rpo = { stav: 'multiple', hladany_nazov: fullName, kandidati: exact.slice(0, 5).map(candidate) };
            item.chyby.push({ kod: 'multiple_matches', detail: `${exact.length} firiem s názvom „${fullName}“` });
          }
        } else if (former.length === 1) chosen = { hit: former[0], metoda: 'byvaly_nazov', match: true, renamed: true };
        else if (former.length > 1) {
          item.rpo = { stav: 'multiple', hladany_nazov: fullName, kandidati: former.slice(0, 5).map(candidate) };
          item.chyby.push({ kod: 'multiple_matches', detail: `${former.length} firiem s bývalým názvom „${fullName}“` });
        }
      }
      if (!chosen && item.rpo.stav !== 'multiple') {
        // slabší dôkaz: zhoda bez právnej formy + obec z webu
        const sameCore = active.filter(r => core(last(r.fullNames)?.value) === core(q));
        const confirmed = sameCore.filter(cityOk);
        if (confirmed.length === 1) chosen = { hit: confirmed[0], metoda: 'nazov+obec', match: true };
        else similar.push(...sameCore.map(candidate), ...active.filter(r => !sameCore.includes(r)).slice(0, 3).map(candidate));
      }
    }
    if (!chosen && item.rpo.stav !== 'multiple') {
      const uniq = similar.filter((c, i, a) => a.findIndex(x => x.ico === c.ico) === i).slice(0, 5);
      item.rpo = { stav: 'not_found', hladane_nazvy: queries.map(x => x.fullName || x.q), podobne: uniq };
      item.chyby.push({ kod: 'rpo_not_found', detail: queries.length ? `bez jednoznačnej zhody pre: ${queries.map(x => x.fullName || x.q).join(', ')}` : 'na webe sa nenašiel názov firmy' });
    }
  }
} catch (e) {
  item.rpo = { stav: 'timeout', detail: e.message };
  item.chyby.push({ kod: 'rpo_timeout', detail: e.message });
}

// ---------- detail subjektu ----------
if (chosen) {
  item.rpo = summarize(chosen.hit, chosen.metoda);
  try {
    const entity = await rpoGet(`/entity/${chosen.hit.id}`, { showHistoricalData: false });
    if (entity) item.rpo = summarize(entity, chosen.metoda);
  } catch (e) {
    item.chyby.push({ kod: 'rpo_entity_unavailable', detail: e.message }); // ostanú údaje z vyhľadávania
  }
  // nesúlad hlásime len keď web uvádza názov s právnou formou (titulok „Domov“ nie je dôkaz)
  if (chosen.metoda === 'ico' && !chosen.match && strongNames.length) {
    item.chyby.push({ kod: 'name_mismatch', detail: `RPO: ${item.rpo.nazov}; web: ${strongNames[0].value}` });
  }
  if (chosen.renamed) item.chyby.push({ kod: 'name_changed', detail: `web: ${(f.nazvy_web || [])[0]?.value}; RPO teraz: ${item.rpo.nazov}` });
  if (item.rpo.datum_zaniku) item.chyby.push({ kod: 'company_terminated', detail: item.rpo.datum_zaniku });
}
item.rpo.trvanie_ms = Date.now() - T0;
return { json: item };
