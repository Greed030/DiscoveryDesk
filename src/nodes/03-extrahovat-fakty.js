// Extrahovať fakty (Code, Run Once for Each Item) – IBA kódom, bez AI:
// - IČO: číslo pri označení „IČO“ / „IČ“ / „I.Č.O.“ / „Identifikačné číslo“ (6–8 číslic, aj s medzerami),
//   doplnené nulami na 8 číslic a overené kontrolným súčtom (mod 11). Nič sa nehádže, nič sa nedopĺňa.
// - názov firmy s právnou formou (s. r. o., a. s., …), adresa z webu (ulica, PSČ, obec), e-maily, telefóny
// - text pre AI: bez právnych stránok (VOP/GDPR), bez opakujúcich sa menu/pätičiek, s limitom znakov
// Výstup: $json.fakty, $json.kontext_ai

const cfg = $('Konfigurácia').first().json;
const item = { ...$json, chyby: [...($json.chyby || [])] };
item.fakty = { ico_kandidati: [], nazvy_web: [], adresa_web: null, obce_web: [], emaily: [], telefony: [] };
item.kontext_ai = '';
if (!item.web?.ok) return { json: item };

const pages = item.web.stranky;
// web odpovedá, ale bez obsahu (napr. "Connect failed: Connection refused" s kódom 200) → ďalej nemá zmysel pokračovať
const totalText = pages.reduce((s, p) => s + p.text.length, 0);
if (totalText < 200) {
  item.web.ok = false;
  item.chyby.push({ kod: 'web_unreachable', detail: `Web neobsahuje čitateľný text, vrátil: "${pages.map(p => p.text).join(' ').slice(0, 120)}"` });
  return { json: item };
}
const MAX_AI = Number(cfg.max_znakov_ai) || 24000;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const IMPORTANT = new Set(['kontakt', 'pravne', 'o_nas']); // stránky, kde sú firemné údaje

// ---------- IČO ----------
function icoChecksumOk(ico) {
  if (!/^\d{8}$/.test(ico)) return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(ico[i]) * (8 - i);
  return (11 - (sum % 11)) % 10 === Number(ico[7]);
}
// Označenie: IČO, ICO, I.Č.O., IČ (nie „IČ DPH“, nie „DIČ“), Identifikačné číslo (organizácie), Company ID
// Číslo: najprv presne 8 číslic, inak 6–8 číslic s medzerami ("36 123 456")
const ICO_RE = /(?<![\p{L}\d])(?:I\s?\.?\s?[ČCÈ]\s?\.?\s?O\.?|I\s?\.?\s?Č\.?(?!\s*(?:pre\s+)?DPH)|identifika[čc]n[ée]\s+[čc][íi]slo(?:\s+organiz[áa]cie)?|company\s+id|business\s+id)(?![\p{L}])\s*(?:[:.\-–/]|\bje\b)?\s*(\d{8}(?!\d)|(?:\d[  ]?){5,7}\d(?![  ]?\d))/giu;

const icoMap = new Map();
const invalid = new Set();
for (const p of pages) {
  for (const m of p.text.matchAll(ICO_RE)) {
    const ico = m[1].replace(/\D/g, '').padStart(8, '0');
    if (!icoChecksumOk(ico)) { invalid.add(ico); continue; }
    const c = icoMap.get(ico) || { ico, pocet: 0, urls: [], kontext: '', kontexty: [], dolezita_stranka: false };
    c.pocet++;
    if (!c.urls.includes(p.url)) c.urls.push(p.url);
    if (IMPORTANT.has(p.typ) || p.typ === 'home') c.dolezita_stranka = true;
    // text tesne pred IČO (tam býva názov firmy) – pre každý výskyt, max. 5
    const before = p.text.slice(Math.max(0, m.index - 120), m.index).replace(/\n/g, ' ');
    if (c.kontexty.length < 5) c.kontexty.push(before);
    if (!c.kontext) c.kontext = (before + p.text.slice(m.index, m.index + m[0].length + 40)).replace(/\n/g, ' ');
    icoMap.set(ico, c);
  }
}

// ---------- názov firmy z webu ----------
const LF = String.raw`(?:spol\.?\s?s\s?r\.?\s?o\.?|s\.\s?r\.\s?o\.?|s\.r\.o\.?|sro|a\.\s?s\.|k\.\s?s\.|v\.\s?o\.\s?s\.|j\.\s?s\.\s?a\.|n\.\s?o\.|o\.\s?z\.|š\.\s?p\.|družstvo)`;
const TOKEN = String.raw`[\p{Lu}\d][\p{L}\d&+'’.\-]*`;
const CONN = String.raw`(?:a|u|i|v|z|na|pre|pri|pod|nad|and|of|&|-|–|\+)`;
const NAME_RE = new RegExp(String.raw`(${TOKEN}(?:[  ]+(?:${CONN}[  ]+)?${TOKEN}){0,5})[  ]*,?[  ]*(?<![\p{L}])(${LF})(?![\p{L}])`, 'gu');
const LF_LINE = new RegExp(String.raw`(?<![\p{L}])${LF}(?![\p{L}])`, 'u');
// slová, ktoré sa často „prilepia“ pred názov (menu, nadpisy, právne frázy)
const STOP = new Set(['kontakt', 'kontakty', 'odoslat', 'domov', 'uvod', 'menu', 'copyright', 'prevadzkovatel', 'predavajuci',
  'spolocnost', 'spolocnosti', 'firma', 'dodavatel', 'sidlo', 'nazov', 'obchodne', 'meno', 'adresa', 'fakturacne', 'udaje',
  'informacie', 'o', 'nas', 'vsetky', 'prava', 'vyhradene', 'powered', 'by', 'created', 'web', 'webstranka', 'design',
  'vytvoril', 'vytvorila', 'realizacia', 'tel', 'email', 'e-mail', 'mail', 'facebook', 'instagram', 'objednavatel', 'prijemca',
  'prevadzka', 'centrala', 'pobocka', 'novinky', 'aktuality', 'partner', 'partneri', 'vyrobca', 'predajca', 'kupujuci']);
const cleanName = s => {
  const t = s.replace(/\s+/g, ' ').trim().split(' ');
  while (t.length && (STOP.has(norm(t[0]).replace(/[^a-z0-9-]/g, '')) || /^(©|\(c\)|\d{4}|[-–&+|:]|\d{4}[-–]\d{4})$/i.test(t[0]))) t.shift();
  return t.join(' ').replace(/[,.\s]+$/, '');
};
// počítame celé (očistené) názvy; kratší názov, ktorý je „chvostom“ dlhšieho, preberie jeho výskyty
// ("Novinky COFFIX" + "COFFIX" → "COFFIX"). Rôzne firmy s rovnakým posledným slovom sa nezlúčia.
const nameCount = new Map();
for (const p of pages) {
  for (const line of p.text.split('\n')) {
    if (!LF_LINE.test(line)) continue;
    for (const m of line.matchAll(NAME_RE)) {
      const core = cleanName(m[1]);
      if (core.length < 2 || /^\d+$/.test(core)) continue;
      const e = nameCount.get(core) || { core, forma: m[2].replace(/\s+/g, ' '), pocet: 0, skore: 0, url: p.url, typy: [] };
      e.pocet++;
      // názov v pätičke / kontakte / VOP = prevádzkovateľ webu; na stránkach s ponukou bývajú iné firmy (partneri, inzerenti)
      e.skore += IMPORTANT.has(p.typ) ? 2 : p.typ === 'home' ? 1 : 0.25;
      if (!e.typy.includes(p.typ)) e.typy.push(p.typ);
      nameCount.set(core, e);
    }
  }
}
for (const e of [...nameCount.values()]) {
  const t = e.core.split(' ');
  for (let i = 1; i < t.length; i++) {
    const tail = nameCount.get(t.slice(i).join(' '));
    if (tail) { tail.pocet += e.pocet; tail.skore += e.skore; tail.typy = [...new Set([...tail.typy, ...e.typy])]; nameCount.delete(e.core); break; }
  }
}
const domainLabel = norm(item.domena.split('.')[0]).replace(/[^a-z0-9]/g, '');
const icoContexts = [...icoMap.values()].flatMap(c => c.kontexty.map(norm)).join(' | ');
const nazvy = [...nameCount.values()].map(e => {
  const n = norm(e.core), compact = n.replace(/[^a-z0-9]/g, '');
  const domainMatch = compact.length >= 3 && (compact.includes(domainLabel) || domainLabel.includes(compact));
  let skore = e.skore;
  if (icoContexts.includes(n)) skore += 5;  // stojí tesne pred IČO
  if (domainMatch) skore += 6;              // zhoda s doménou
  // názov len zo stránok s ponukou (napr. inzerent na portáli) a bez väzby na doménu/IČO nepoužijeme
  const relevant = domainMatch || icoContexts.includes(n) || e.typy.some(t => t === 'home' || IMPORTANT.has(t));
  return { value: `${e.core} ${e.forma}`.trim(), bez_formy: e.core, skore, url: e.url, source: 'web', relevant };
}).filter(n => n.relevant).sort((a, b) => b.skore - a.skore).slice(0, 3).map(({ relevant, ...n }) => n);

// záložné zdroje názvu (bez právnej formy – slabší dôkaz): og:site_name, <title>
const GENERIC_TITLE = /^(domov|úvod|uvod|home|homepage|hlavná stránka|titulná stránka|index|welcome|vitajte|just a moment|access denied|attention required|untitled|stránka nenájdená|404)\b/i;
const home = pages[0];
for (const v of [home.nazov_webu, (home.titulok || '').split(/\s[|–—\-:·•]\s|\s[|–—·•]|[|–—·•]\s/)[0]]) {
  const t = String(v || '').trim();
  if (t.length < 2 || t.length > 60 || GENERIC_TITLE.test(t) || nazvy.some(n => norm(n.bez_formy) === norm(t))) continue;
  nazvy.push({ value: t, bez_formy: t, skore: 0, url: home.url, source: 'web_titulok' });
}
item.fakty.nazvy_web = nazvy;

// IČO kandidáti: počet výskytov + dôležitá stránka + hlavný názov firmy tesne pred IČO
const topName = nazvy[0] ? norm(nazvy[0].bez_formy) : '';
item.fakty.ico_kandidati = [...icoMap.values()].map(({ kontexty, ...c }) => ({
  ...c, skore: c.pocet + (c.dolezita_stranka ? 3 : 0) + (topName && kontexty.some(k => norm(k).slice(-80).includes(topName)) ? 8 : 0),
})).sort((a, b) => b.skore - a.skore);

if (!icoMap.size) item.chyby.push({ kod: 'ico_not_found_on_web' });
if (invalid.size) item.chyby.push({ kod: 'ico_invalid_checksum', detail: [...invalid].join(', ') });
if (icoMap.size > 1) item.chyby.push({ kod: 'multiple_ico_on_web', detail: [...icoMap.keys()].join(', ') });

// ---------- adresa z webu (informatívne – môže to byť prevádzka, nie sídlo) ----------
const CITY = String.raw`\p{Lu}[\p{L}]+(?:[  \-–]+(?:nad|pod|pri|\p{Lu}[\p{L}]+|[IVX]{1,4}|\d{1,2}))*`;
const PSC_RE = new RegExp(String.raw`(?<!\d)([089]\d{2})[  ]?(\d{2})(?!\d)[  ,]+(${CITY})`, 'gu');
const STREET_RE = new RegExp(String.raw`(\p{Lu}[\p{L}.\- ]{1,40}?[  ]\d+[a-zA-Z]?(?:\/\d+[a-zA-Z]?)?)[  ,–-]*$`, 'u');
const addrCount = new Map();
for (const p of pages) {
  for (const m of p.text.matchAll(PSC_RE)) {
    // ulica býva na tom istom alebo predchádzajúcom riadku ("Zadunajská cesta 12\n85101 Bratislava")
    const lines = p.text.slice(Math.max(0, m.index - 120), m.index).split('\n');
    const sameLine = lines.pop();
    const street = (sameLine.match(STREET_RE) || [])[1] || (!sameLine.trim() ? (lines.pop() || '').match(STREET_RE)?.[1] : undefined);
    const value = `${street ? street.trim() + ', ' : ''}${m[1]} ${m[2]} ${m[3]}`.replace(/\s+/g, ' ');
    const e = addrCount.get(value) || { value, pocet: 0, url: p.url, obec: m[3], ulica: !!street };
    e.pocet += 1 + (p.typ === 'kontakt' ? 2 : 0) + (street ? 1 : 0);
    addrCount.set(value, e);
  }
}
const addrs = [...addrCount.values()].sort((a, b) => b.pocet - a.pocet);
if (addrs[0]) item.fakty.adresa_web = { value: addrs[0].value, source: 'web', url: addrs[0].url, verified: false };
// obec bez mestskej časti: "Bratislava - Petržalka" / "Bratislava 3" → "bratislava"; "Dolný Hričov" ostane celé
item.fakty.obce_web = [...new Set(addrs.map(a => norm(a.obec).split(/\s[-–]\s|\s\d|\s[ivx]+$/)[0].trim()))].slice(0, 5);

// ---------- kontakty ----------
const allText = pages.map(p => p.text).join('\n');
const emails = [...new Set((allText.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map(e => e.toLowerCase()))]
  .filter(e => !/\.(png|jpe?g|gif|webp|svg)$/.test(e) && !/sentry|wixpress|example\.|domain\.|email\.com$|\.gov\.sk$|dataprotection|uoou/.test(e));
// e-maily na vlastnej doméne majú prednosť (v GDPR textoch bývajú adresy úradov, správcov webu…)
const own = emails.filter(e => e.split('@')[1].replace(/^www\./, '').endsWith(item.domena));
item.fakty.emaily = (own.length ? own : emails).slice(0, 3);
const noIban = allText.replace(/[A-Z]{2}\d{2}(?:[ ]?\d{4}){4,6}/g, ' '); // IBAN by sa tváril ako telefón
const phones = (noIban.match(/(?:\+|00)421[  \/-]?\d{1,3}(?:[  \/-]?\d{2,3}){2,3}|(?<![\d+])0\d{2,3}[  \/-]?\d{2,3}(?:[  \/-]?\d{2,3}){1,2}(?!\d)/g) || [])
  .map(t => t.replace(/[^\d+]/g, '')).filter(t => t.replace(/\D/g, '').length >= 9 && t.replace(/\D/g, '').length <= 12);
item.fakty.telefony = [...new Set(phones)].slice(0, 2);

// ---------- text pre AI ----------
// riadky, ktoré sa opakujú na viacerých stránkach (menu, pätička), necháme len raz
const lineFreq = new Map();
for (const p of pages) for (const l of new Set(p.text.split('\n'))) lineFreq.set(l, (lineFreq.get(l) || 0) + 1);
const ORDER = { home: 0, o_nas: 1, obsah: 2, kontakt: 3, ine: 4, pravne: 5 };
// šum bez obchodnej hodnoty: cookie lišty, tlačidlá súhlasu, copyright
const NOISE = /\bcookies?\b|^(povoliť|odmietnuť|súhlasím|prijať|nastavenia|zobraziť viac|accept|reject|allow)\b.{0,40}$|©|všetky práva vyhradené|powered by|created by|vytvorené (na|v|by)\b/i;
const emitted = new Set();
const blocks = [];
let total = 0;
const content = [...pages].sort((a, b) => ORDER[a.typ] - ORDER[b.typ]);
const nonLegalChars = content.filter(p => p.typ !== 'pravne').reduce((s, p) => s + p.text.length, 0);
for (const p of content) {
  // právne stránky (VOP, GDPR) sú dlhé a šablónovité – do AI idú len keď inak nie je dosť textu
  if (p.typ === 'pravne' && nonLegalChars > 3000) continue;
  const limit = p.typ === 'home' ? 8000 : p.typ === 'pravne' ? 1500 : 4000;
  const lines = [];
  let len = 0;
  for (const l of p.text.split('\n')) {
    if (NOISE.test(l)) continue;
    if (lineFreq.get(l) > 1) { if (emitted.has(l)) continue; emitted.add(l); }
    if (len + l.length > limit) break;
    lines.push(l);
    len += l.length + 1;
  }
  if (!lines.length) continue;
  const header = `### ${p.url}${p.titulok ? ' — ' + p.titulok : ''}${p.typ === 'home' && p.popis_meta ? '\n(meta popis: ' + p.popis_meta + ')' : ''}`;
  const block = `${header}\n${lines.join('\n')}`;
  if (total + block.length > MAX_AI) { blocks.push(block.slice(0, Math.max(0, MAX_AI - total))); break; }
  blocks.push(block);
  total += block.length + 2;
}
item.kontext_ai = blocks.join('\n\n').trim();
if (item.kontext_ai.length < 200) {
  item.chyby.push({ kod: 'web_unreachable', detail: 'Web neobsahuje čitateľný text (prázdna alebo len grafická stránka).' });
  item.kontext_ai = '';
} else if (item.kontext_ai.length < 1000) {
  item.chyby.push({ kod: 'low_web_content', detail: `${item.kontext_ai.length} znakov` });
}
return { json: item };
