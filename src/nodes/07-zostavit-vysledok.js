// Zostaviť výsledok (Code, Run Once for Each Item)
// Prichádzajú sem 3 vetvy: bez AI (web nedostupný), AI bez opravy, AI po oprave („OpenAI — oprava“).
// Výstup: riadok pre Google Sheets (stĺpce = kľúče) + stĺpec `json` s plným výsledkom.
// Každý fakt má zdroj a príznak overenia: { value, source, verified }.

const cfg = $('Konfigurácia').first().json;
const MAX_WORDS = Number(cfg.max_slov_email) || 120;
const MIN_WORDS = Math.min(Number(cfg.min_slov_email) || 90, MAX_WORDS - 10);

// ---------- spoločné funkcie (rovnaké ako vo „Validovať AI výstup“) ----------
const countWords = s => (String(s || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’.\-–]*/gu) || []).length;
const ABBR = /(?<![\p{L}])(?:spol\.\s?s\s?r\.\s?o\.|s\.\s?r\.\s?o\.|a\.\s?s\.|k\.\s?s\.|v\.\s?o\.\s?s\.|napr\.|atď\.|tzv\.|resp\.|ul\.|tel\.|č\.|ing\.|mgr\.|mudr\.|bc\.|phdr\.|judr\.|rndr\.|dr\.|t\.\s?j\.|t\.\s?č\.|cca\.|min\.|max\.|hod\.|str\.)/giu;
const countSentences = s => String(s || '').replace(ABBR, m => m.replace(/\./g, '')).replace(/(\d)\.(\d)/g, '$1,$2')
  .split(/(?<=[.!?…])\s+/).filter(x => /\p{L}/u.test(x)).length;
const FLATTERY = /(?<![\p{L}])(?:skvel\p{L}*|výborn\p{L}*|výnimočn\p{L}*|úžasn\p{L}*|fantastick\p{L}*|perfektn\p{L}*|vynikajúc\p{L}*|veľmi zaujímav\p{L}*)/giu;
const SINGULAR = /(?<![\p{L}])(?:ďakujem|teším sa|rád by som|rada by som|zaznamenal som|zaznamenala som|všimol som|všimla som|navrhujem|ponúkam|mám)(?![\p{L}])/giu;
const GENERIC = /kontaktn\p{L}* (?:údaj|informáci)\p{L}*|(?:môžu|možnosť|možno) (?:ich |firmu )?kontaktovať|komunikáci\p{L}* so zákazníkmi je dôležit|na webe (?:sú|je) (?:uvedené |uvedený )?kontakt/iu;
const found = (re, s) => [...new Set((String(s || '').match(re) || []).map(x => x.toLowerCase()))].join('“, „');
function parseAi(resp) {
  if (!resp || !Array.isArray(resp.choices)) return { fatal: true };
  const msg = resp.choices[0]?.message || {};
  try { return { ai: msg.refusal ? null : JSON.parse(msg.content || '') }; } catch (e) { return { ai: null }; }
}
function validateAi(ai, maxWords, minWords) {
  const p = [];
  if (!ai || typeof ai !== 'object') return ['Odpoveď nie je platný JSON podľa schémy.'];
  const sentences = countSentences(ai.popis);
  if (!String(ai.popis || '').trim()) p.push('Chýba "popis".');
  else if (sentences < 2 || sentences > 3) p.push(`"popis" má ${sentences} viet namiesto 2–3.`);
  const opp = Array.isArray(ai.prilezitosti) ? ai.prilezitosti : [];
  if (opp.length < 3) p.push(`"prilezitosti" musí obsahovať presne 3 položky (teraz ${opp.length}).`);
  opp.slice(0, 3).forEach((o, i) => {
    for (const k of ['nazov', 'co_sa_automatizuje', 'uspora_casu', 'preco_prave_vy']) if (!String(o?.[k] || '').trim()) p.push(`Príležitosť ${i + 1}: chýba "${k}".`);
    if (!['nízka', 'stredná', 'vysoká'].includes(o?.narocnost)) p.push(`Príležitosť ${i + 1}: "narocnost" musí byť nízka, stredná alebo vysoká.`);
    if (GENERIC.test(o?.preco_prave_vy || '')) p.push(`Štýl: príležitosť ${i + 1} má všeobecné zdôvodnenie („${o.preco_prave_vy}“).`);
  });
  const words = countWords(ai.email);
  if (!words) p.push('Chýba "email".');
  else if (words > maxWords) p.push(`E-mail má ${words} slov, limit je ${maxWords}.`);
  else if (words < minWords) p.push(`E-mail má len ${words} slov, je príliš krátky.`);
  if (found(FLATTERY, ai.email)) p.push(`Štýl: e-mail obsahuje hodnotiace frázy („${found(FLATTERY, ai.email)}“).`);
  if (found(SINGULAR, ai.email)) p.push(`Štýl: e-mail mieša jednotné číslo („${found(SINGULAR, ai.email)}“).`);
  return p;
}
// váha problémov pri výbere medzi pôvodnou a opravenou verziou:
// e-mail nad limit slov (100) > iné porušenie zadania (50) > štýl (5) > krátky e-mail (1)
const weight = p => (p.includes('limit je') ? 100 : p.startsWith('Štýl:') ? 5 : p.includes('príliš krátky') ? 1 : 50);
const score = a => validateAi(a, MAX_WORDS, MIN_WORDS).reduce((s, p) => s + weight(p), 0);
// -------------------------------------------------------------------------

// odkiaľ položka prišla: z opravy (odpoveď OpenAI) alebo priamo (naše dáta s poľom `domena`)
let base, repair = null;
if ($json.domena !== undefined) base = $json;
else { base = $('Validovať AI výstup').item.json; repair = $json; }

const item = { ...base, chyby: [...(base.chyby || [])] };
const tok = { vstup: 0, vystup: 0, cache: 0, volania: 0, ...(item.tokeny || {}) };
let ai = item.ai || null;

if (repair) {
  if (repair.usage) {
    tok.vstup += repair.usage.prompt_tokens || 0;
    tok.vystup += repair.usage.completion_tokens || 0;
    tok.cache += repair.usage.prompt_tokens_details?.cached_tokens || 0;
    tok.volania += 1;
  }
  const fixed = parseAi(repair).ai;
  if (fixed && Array.isArray(fixed.prilezitosti)) fixed.prilezitosti = fixed.prilezitosti.slice(0, 3);
  // opravenú verziu berieme, len ak nie je horšia (napr. predĺžený e-mail nesmie prekročiť limit slov)
  if (fixed && (!ai || score(fixed) <= score(ai))) ai = fixed;
}

// zostávajúce problémy po (prípadnej) oprave
if (ai) {
  const problems = validateAi(ai, MAX_WORDS, MIN_WORDS);
  if (problems.some(p => p.startsWith('E-mail') && p.includes('limit'))) item.chyby.push({ kod: 'email_too_long', detail: `${countWords(ai.email)} slov` });
  if (problems.some(p => p.includes('príliš krátky'))) item.chyby.push({ kod: 'email_too_short', detail: `${countWords(ai.email)} slov` });
  const style = problems.filter(p => p.startsWith('Štýl:'));
  if (style.length) item.chyby.push({ kod: 'ai_style', detail: style.map(p => p.replace('Štýl: ', '')).join(' ') });
  const other = problems.filter(p => !p.startsWith('E-mail') && !p.startsWith('Štýl:'));
  if (other.length) item.chyby.push({ kod: 'ai_output_invalid', detail: other.join(' ') });
} else if (!item.preskocit_ai && !item.chyby.some(c => c.kod === 'ai_error')) {
  item.chyby.push({ kod: 'ai_error', detail: 'AI nevrátila použiteľný výstup ani po oprave.' });
}
if (item.web?.jina) item.chyby.push({ kod: 'jina_fallback' });
if (ai?.kvalita_podkladov === 'nedostatočné' && !item.chyby.some(c => c.kod === 'low_web_content')) item.chyby.push({ kod: 'low_web_content', detail: 'podľa AI' });

// ---------- chyby a status ----------
const MSG = {
  internal_error: ['chyba', 'Interná chyba workflow (pozri detail).'],
  invalid_domain: ['chyba', 'Neplatná doména.'],
  web_unreachable: ['chyba', 'Web sa nepodarilo načítať.'],
  ai_error: ['chyba', 'AI analýza zlyhala.'],
  rpo_timeout: ['chyba', 'Register RPO neodpovedal (timeout alebo chyba) – údaje z registra chýbajú.'],
  multiple_matches: ['chyba', 'V RPO je viac firiem s rovnakým názvom – vyberte správnu ručne (pozri kandidátov v JSON).'],
  rpo_not_found: ['chyba', 'Firma sa v registri RPO nenašla.'],
  ico_not_found_on_web: ['upozornenie', 'IČO sa na webe nenašlo.'],
  ico_invalid_checksum: ['upozornenie', 'Na webe je číslo označené ako IČO s neplatným kontrolným súčtom – ignorované.'],
  multiple_ico_on_web: ['upozornenie', 'Na webe je viac rôznych IČO – použité to, ktoré sedí s názvom firmy.'],
  name_mismatch: ['upozornenie', 'Názov v RPO sa líši od názvu na webe (môže ísť o prevádzkovateľa značky) – overte.'],
  company_terminated: ['upozornenie', 'Firma podľa RPO zanikla.'],
  name_changed: ['info', 'Firma sa v RPO premenovala – web uvádza jej bývalý názov.'],
  rpo_entity_unavailable: ['upozornenie', 'Detail z RPO sa nepodarilo načítať – použité údaje z vyhľadávania.'],
  low_web_content: ['upozornenie', 'Na webe je málo informácií – výstupy AI berte s rezervou.'],
  email_too_long: ['upozornenie', `E-mail je aj po oprave dlhší ako ${MAX_WORDS} slov.`],
  email_too_short: ['info', `E-mail je kratší ako ${MIN_WORDS} slov (limit ${MAX_WORDS} je dodržaný).`],
  ai_output_invalid: ['upozornenie', 'Výstup AI nespĺňa všetky kontroly.'],
  ai_style: ['info', 'Text AI má štylistický nedostatok – pred odoslaním skontrolujte (pozri detail).'],
  jina_fallback: ['info', 'Web načítaný cez r.jina.ai (JavaScriptový web alebo blokovanie robotov).'],
};
const chyby = item.chyby.map(c => ({ kod: c.kod, zavaznost: MSG[c.kod]?.[0] || 'upozornenie', sprava: MSG[c.kod]?.[1] || c.kod, ...(c.detail ? { detail: c.detail } : {}) }));
const STATUS_PRIORITY = ['internal_error', 'invalid_domain', 'web_unreachable', 'ai_error', 'rpo_timeout', 'multiple_matches', 'rpo_not_found', 'ico_not_found_on_web'];
const status = STATUS_PRIORITY.find(k => chyby.some(c => c.kod === k)) || 'ok';

// ---------- fakty so zdrojom ----------
const r = item.rpo || {};
const f = item.fakty || {};
const rpoOk = r.stav === 'ok';
const webIco = f.ico_kandidati?.find(c => c.ico === r.ico) || f.ico_kandidati?.[0];
const webName = f.nazvy_web?.[0];
// verified = true IBA keď je firma z webu potvrdená v RPO cez IČO; zhoda podľa názvu je vždy na overenie
const byIco = rpoOk && r.metoda === 'ico';
const nameNote = r.metoda === 'byvaly_nazov' ? 'web uvádza bývalý názov firmy' : r.metoda === 'nazov+obec' ? 'zhoda názvu a obce' : 'presná zhoda názvu s právnou formou';
let ico;
if (byIco) ico = { value: r.ico, source: 'web+rpo', verified: true, url: webIco?.urls?.[0] };
else if (rpoOk) ico = { value: r.ico, source: 'rpo', verified: false, poznamka: `IČO na webe nie je; nájdené v RPO podľa názvu (${nameNote}) – overte.` };
else if (webIco) ico = { value: webIco.ico, source: 'web', verified: false, url: webIco.urls?.[0], poznamka: 'Platný kontrolný súčet, v RPO neoverené.' };
else ico = { value: null, source: null, verified: false };

const firma = {
  nazov: rpoOk ? { value: r.nazov, source: 'rpo', verified: byIco }
    : webName ? { value: webName.value, source: 'web', verified: false, url: webName.url } : { value: null, source: null, verified: false },
  ico,
  sidlo: rpoOk ? { value: r.sidlo, source: 'rpo', verified: byIco }
    : f.adresa_web ? { value: f.adresa_web.value, source: 'web', verified: false, url: f.adresa_web.url, poznamka: 'Adresa z webu – nemusí byť sídlo.' }
    : { value: null, source: null, verified: false },
  pravna_forma: rpoOk && r.pravna_forma ? { value: r.pravna_forma, source: 'rpo', verified: byIco } : null,
  datum_vzniku: rpoOk && r.datum_vzniku ? { value: r.datum_vzniku, source: 'rpo', verified: byIco } : null,
  statutari: rpoOk && r.statutari?.length ? { value: r.statutari, source: 'rpo', verified: byIco } : null,
  byvale_nazvy: rpoOk && r.byvale_nazvy?.length ? { value: r.byvale_nazvy, source: 'rpo' } : null,
  nazov_na_webe: webName ? { value: webName.value, source: webName.source, url: webName.url } : null,
  adresa_na_webe: f.adresa_web || null,
  kontakt_na_webe: { emaily: f.emaily || [], telefony: f.telefony || [], source: 'web' },
  rpo_url: r.url || null,
  ...(r.kandidati ? { rpo_kandidati: r.kandidati } : {}),
  ...(r.podobne?.length ? { rpo_podobne_subjekty: r.podobne } : {}),
};

const pin = Number(cfg.cena_vstup_usd_1m) || 0, pout = Number(cfg.cena_vystup_usd_1m) || 0;
tok.spolu = tok.vstup + tok.vystup;
tok.model = item.ai_model || null;
tok.cena_usd = Number(((tok.vstup * pin + tok.vystup * pout) / 1e6).toFixed(6));

const zdroje = [
  ...(item.web?.stranky || []).map(p => p.url + (p.zdroj === 'jina' ? ' (cez r.jina.ai)' : '')),
  ...(r.url ? [r.url] : []),
];
const timestamp = new Date().toISOString();

const result = {
  domena: item.domena,
  status,
  firma,
  popis: ai ? { value: ai.popis, source: 'ai (text webu + RPO)', kvalita_podkladov: ai.kvalita_podkladov, odvetvie: ai.odvetvie } : null,
  zistenia: ai?.zistenia?.length ? { value: ai.zistenia, source: 'ai (fakty z textu webu)' } : null,
  prilezitosti: ai ? (ai.prilezitosti || []).slice(0, 3) : [],
  email: ai ? { predmet: ai.email_predmet, text: ai.email, pocet_slov: countWords(ai.email), source: 'ai' } : null,
  chyby,
  zdroje,
  tokeny: tok,
  timestamp,
};

// ---------- riadok do Google Sheets (poradie kľúčov = poradie stĺpcov) ----------
const opp = i => {
  const o = result.prilezitosti[i];
  return o ? `${o.nazov}\n${o.co_sa_automatizuje}\nÚspora: ${o.uspora_casu} | Náročnosť: ${o.narocnost}\nPrečo práve Vy: ${o.preco_prave_vy}` : '';
};
return {
  json: {
    domena: result.domena,
    status,
    nazov: firma.nazov.value || '',
    ico: ico.value || '',
    ico_verified: ico.verified,
    sidlo: firma.sidlo.value || '',
    popis: result.popis?.value || '',
    prilezitost_1: opp(0),
    prilezitost_2: opp(1),
    prilezitost_3: opp(2),
    email: result.email ? `Predmet: ${result.email.predmet}\n\n${result.email.text}` : '',
    zdroje: zdroje.join('\n'),
    chyby: chyby.map(c => `[${c.kod}] ${c.sprava}${c.detail ? ' (' + c.detail + ')' : ''}`).join('\n'),
    timestamp,
    pravna_forma: firma.pravna_forma?.value || '',
    statutari: (firma.statutari?.value || []).join(', '),
    adresa_web: firma.adresa_na_webe?.value || '',
    kontakt_web: [...firma.kontakt_na_webe.emaily, ...firma.kontakt_na_webe.telefony].join(', '),
    kvalita_podkladov: result.popis?.kvalita_podkladov || '',
    zistenia: (result.zistenia?.value || []).map(z => '• ' + z).join('\n'),
    tokeny: tok.spolu,
    cena_usd: tok.cena_usd,
    model: tok.model || '',
    json: JSON.stringify(result), // kompaktne v 1 riadku – inak by bunka roztiahla riadok v tabuľke na stovky riadkov
  },
};
