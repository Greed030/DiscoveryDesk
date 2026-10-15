// Stiahnuť web (Code, Run Once for Each Item)
// - hlavná stránka: skúša https/http, s aj bez www, sleduje presmerovania (aj <meta refresh>)
// - podstránky: hľadá ich v odkazoch z hlavnej stránky (kontakt, o nás, VOP, GDPR, služby…)
//   a doplní typické cesty (/kontakt, /o-nas, /obchodne-podmienky, /gdpr…), max. `max_podstranok`
// - správne dekóduje kódovanie (UTF-8, windows-1250, ISO-8859-2), čistí HTML na text
// - JS weby alebo weby, ktoré blokujú roboty: fallback cez https://r.jina.ai/<url>
// Výstup: $json.web = { ok, zaklad, stranky: [{ url, typ, titulok, popis_meta, nazov_webu, text, zdroj }], pokusy, jina }

const cfg = $('Konfigurácia').first().json;
const H = typeof helpers !== 'undefined' ? helpers : this.helpers; // task runner (n8n 2.x) aj starší režim

const item = { ...$json, chyby: [...($json.chyby || [])] };
item.web = { ok: false, zaklad: null, stranky: [], pokusy: [], jina: false };
if (item.chyby.some(c => c.kod === 'invalid_domain')) return { json: item };

const D = item.domena;
const TIMEOUT = Number(cfg.web_timeout_ms) || 20000;
const MAX_PAGES = Number(cfg.max_podstranok) || 8;
const USE_JINA = cfg.pouzit_jina !== false;
const MAX_TEXT = 60000;                 // max. znakov textu z jednej stránky
const DEADLINE = Date.now() + 200000;   // rezerva pod limitom task runnera (300 s)
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'sk-SK,sk;q=0.9,cs;q=0.8,en;q=0.7',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const timeLeft = () => DEADLINE - Date.now();
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// ---------- URL pomôcky (v sandboxe nie je trieda URL) ----------
function parseUrl(u) {
  const m = String(u).match(/^(https?):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i);
  return m ? { proto: m[1].toLowerCase(), host: m[2].toLowerCase(), path: m[3] || '/', query: m[4] || '' } : null;
}
function resolveUrl(href, base) {
  href = String(href || '').trim().replace(/&amp;/g, '&');
  if (!href || href.startsWith('#') || /^(mailto|tel|javascript|data|sms|whatsapp|viber|skype|callto):/i.test(href)) return null;
  href = href.split('#')[0];
  if (/^https?:\/\//i.test(href)) return href;
  const b = parseUrl(base);
  if (!b) return null;
  if (href.startsWith('//')) return `${b.proto}:${href}`;
  if (href.startsWith('?')) return `${b.proto}://${b.host}${b.path}${href}`;
  const [p, q] = (href.startsWith('/') ? href : b.path.replace(/[^/]*$/, '') + href).split('?');
  const parts = [];
  for (const seg of p.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
  const path = ('/' + parts.join('/')).replace(/^\/+/, '/');
  return `${b.proto}://${b.host}${path}${q !== undefined ? '?' + q : ''}`;
}
const bareHost = h => String(h || '').replace(/^www\d*\./, '').replace(/:\d+$/, '');
const ownHosts = new Set([D]);
const isOwn = u => { const p = parseUrl(u); if (!p) return false; const b = bareHost(p.host); return [...ownHosts].some(h => b === h || b.endsWith('.' + h)); };
const urlKey = u => String(u).replace(/^https?:\/\/(www\d*\.)?/i, '').replace(/\/+(\?|$)/, '$1').toLowerCase();

// ---------- dekódovanie odpovede ----------
function toBuffer(b) {
  if (b == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(b)) return b;
  if (b.type === 'Buffer' && Array.isArray(b.data)) return Buffer.from(b.data); // Buffer prenesený cez task runner
  if (Object.prototype.toString.call(b) === '[object ArrayBuffer]') return Buffer.from(new Uint8Array(b));
  if (ArrayBuffer.isView(b)) return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (typeof b === 'string') return Buffer.from(b, 'utf8');
  return Buffer.from(JSON.stringify(b), 'utf8');
}
function decodeBody(buf, contentType) {
  const head = buf.subarray(0, 4096).toString('latin1');
  let cs = (String(contentType || '').match(/charset=["']?([\w-]+)/i) || [])[1]
        || (head.match(/<meta[^>]+charset=["']?\s*([\w-]+)/i) || [])[1] || 'utf-8';
  cs = cs.toLowerCase();
  if (/1250/.test(cs)) cs = 'windows-1250';
  else if (/8859-2|latin-?2/.test(cs)) cs = 'iso-8859-2';
  else if (/utf-?8/.test(cs)) cs = 'utf-8';
  let text;
  try { text = new TextDecoder(cs).decode(buf); } catch (e) { cs = 'utf-8'; text = new TextDecoder('utf-8').decode(buf); }
  // deklarované UTF-8 nesedí (veľa náhradných znakov) → staré slovenské weby bývajú vo windows-1250
  if (cs === 'utf-8' && (text.match(/�/g) || []).length > 20) {
    try { text = new TextDecoder('windows-1250').decode(buf); } catch (e) { /* ponecháme UTF-8 */ }
  }
  return text;
}

// ---------- HTML → text ----------
const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
  bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', sbquo: '‚', copy: '©', reg: '®', trade: '™', euro: '€', deg: '°',
  middot: '·', bull: '•', times: '×', shy: '', zwnj: '', zwj: '' };
const MARKS = { caron: '̌', acute: '́', circ: '̂', uml: '̈', ring: '̊', grave: '̀', tilde: '̃' };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch (err) { return ' '; }
    }
    if (e in ENT) return ENT[e];
    const mm = e.match(/^([a-zA-Z])(caron|acute|circ|uml|ring|grave|tilde)$/); // &Ccaron; → Č, &aacute; → á
    return mm ? (mm[1] + MARKS[mm[2]]).normalize('NFC') : m;
  });
}
function cleanLines(s) {
  const lines = [];
  let prev = '';
  for (let l of String(s).split('\n')) {
    l = l.replace(/[ \t\r\f\v ​  ]+/g, ' ').trim();
    if (l && l !== prev) lines.push(l);
    if (l) prev = l;
  }
  return lines.join('\n').slice(0, MAX_TEXT);
}
function htmlToText(html) {
  const h = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|object|canvas|select)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<head\b[\s\S]*?<\/head\s*>/i, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|ul|ol|h[1-6]|tr|table|thead|tbody|section|article|header|footer|nav|aside|main|form|address|blockquote|dd|dt|dl|figure|figcaption|label|button|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return cleanLines(decodeEntities(h));
}
function markdownToText(md) {
  return cleanLines(String(md)
    .replace(/^(URL Source|Published Time|Markdown Content|Warning):.*$/gim, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')         // obrázky
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')       // odkazy → text
    .replace(/^[#>*\-\s|]+/gm, '')                 // markdown značky na začiatku riadku
    .replace(/[*_`]{1,3}/g, ''));
}
function metaInfo(html) {
  const meta = name => {
    const tag = (html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, 'i')) || [])[0] || '';
    return decodeEntities(((tag.match(/content=["']([^"']*)["']/i) || [])[1] || '').trim());
  };
  const title = decodeEntities(((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim());
  return { titulok: title.slice(0, 200), popis_meta: meta('description').slice(0, 400), nazov_webu: meta('og:site_name').slice(0, 120) };
}
// stránka ochrany proti robotom (Cloudflare a pod.) – nie je to obsah webu
const isBotWall = p => p.text.length < 1500 && (
  /^(just a moment|attention required|access denied|please wait|ddos-guard|security check)/i.test(p.titulok || '')
  || /checking your browser|verify you are human|enable javascript and cookies to continue|cf-browser-verification|cf-chl-|ddos-guard/i.test(p.text.slice(0, 1500)));
const looksLikeJsApp = (html, text) => text.length < 300
  || (text.length < 1200 && /id=["'](root|app|__next|__nuxt)["']|__NEXT_DATA__|ng-version|data-reactroot/i.test(html));

// ---------- HTTP ----------
async function fetchUrl(url, tries = 2) {
  let current = url, insecure = false, lastErr = null;
  for (let hop = 0; hop < 7; hop++) {
    let res = null;
    for (let attempt = 1; attempt <= tries && !res && timeLeft() > 3000; attempt++) {
      try {
        res = await H.httpRequest({
          method: 'GET', url: current, headers: HEADERS, timeout: Math.min(TIMEOUT, timeLeft()),
          encoding: 'arraybuffer', returnFullResponse: true, ignoreHttpStatusErrors: true,
          disableFollowRedirect: true, skipSslCertificateValidation: insecure,
        });
        if ([429, 500, 502, 503, 504].includes(res.statusCode) && attempt < tries) { res = null; await sleep(1500 * attempt); }
      } catch (e) {
        lastErr = String(e.message || e).slice(0, 200);
        // neplatný/expirovaný SSL certifikát → ešte raz bez overenia (čítame len verejný obsah)
        if (!insecure && /cert|ssl|tls|self.signed|unable to verify/i.test(lastErr)) { insecure = true; attempt--; continue; }
        if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(lastErr)) break; // doména neexistuje – neopakujeme
        if (attempt < tries) await sleep(1000 * attempt);
      }
    }
    if (!res) return { ok: false, url: current, status: 0, error: lastErr || 'request failed' };
    const status = res.statusCode;
    const headers = res.headers || {};
    if (status >= 300 && status < 400 && headers.location) {
      const next = resolveUrl(headers.location, current);
      if (!next) return { ok: false, url: current, status, error: 'neplatné presmerovanie' };
      current = next;
      continue;
    }
    const ctype = String(headers['content-type'] || '');
    if (ctype && !/html|xml|text\/plain/i.test(ctype)) return { ok: false, url: current, status, error: `nie je HTML (${ctype})` };
    const html = decodeBody(toBuffer(res.body), ctype);
    const refresh = status === 200 && html.length < 10000
      && html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']?\s*\d+\s*;\s*url=['"]?([^"'>\s]+)/i);
    if (refresh) {
      const next = resolveUrl(refresh[1], current);
      if (next && next !== current) { current = next; continue; }
    }
    return { ok: status >= 200 && status < 300, url: current, status, html };
  }
  return { ok: false, url: current, status: 0, error: 'príliš veľa presmerovaní' };
}
async function fetchJina(url) {
  if (!USE_JINA || timeLeft() < 10000) return null;
  try {
    const res = await H.httpRequest({
      method: 'GET', url: 'https://r.jina.ai/' + url, timeout: Math.min(45000, timeLeft()),
      headers: { 'Accept': 'text/plain', 'X-Return-Format': 'markdown' },
      encoding: 'arraybuffer', returnFullResponse: true, ignoreHttpStatusErrors: true,
    });
    const md = decodeBody(toBuffer(res.body), 'charset=utf-8');
    item.web.pokusy.push({ url: 'r.jina.ai/' + url, status: res.statusCode });
    return res.statusCode === 200 && md.length > 100 ? md : null;
  } catch (e) {
    item.web.pokusy.push({ url: 'r.jina.ai/' + url, status: 0, error: String(e.message || e).slice(0, 120) });
    return null;
  }
}

// ---------- výber podstránok ----------
const RULES = [ // [typ, regex na URL+text odkazu (bez diakritiky, pomlčky), váha]
  ['kontakt', /kontakt|contact|spojte-sa|napiste-nam/, 10],
  ['pravne', /obchodne-podmienky|obchodnych-podmienok|vseobecne-obchodne|\bvop\b|podmienky|terms|impressum|imprint|prevadzkovatel|fakturacne-udaje|firemne-udaje/, 8],
  ['o_nas', /o-nas|o-firme|o-spolocnosti|o-mne|about|kto-sme|nasa-firma|nas-tim|historia|preco-my/, 7],
  ['pravne', /gdpr|ochrana-osobnych|osobne-udaje|osobnych-udajov|privacy|sukromi|reklamac/, 6],
  ['obsah', /sluzb|ponuk|produkt|sortiment|riesen|cennik|servis|referenc|portfolio|co-robime|katalog|program|osetren|liecb|realizac|projekt|kurz|menu/, 4],
];
const QUOTA = { kontakt: 2, pravne: 3, o_nas: 1, obsah: 3, ine: 0 };
const SKIP = /\.(pdf|jpe?g|png|gif|webp|svg|zip|rar|docx?|xlsx?|pptx?|mp[34]|avi|mov|css|js|xml|json|ico|woff2?)(\?|$)|\/(wp-json|wp-admin|wp-login|feed|cart|kosik|checkout|pokladna|login|prihlas\w*|registr\w*|ucet|account|my-account|tag|author|search|hladat)(\/|$|\?)|[?&](add-to-cart|replytocom|s|q|sort|orderby|filter)=/i;
const LANG = /^\/(en|de|hu|cz|cs|pl|ru|uk|ua|fr|it|es)(\/|$)/i;
const DEFAULT_PATHS = [['kontakt', '/kontakt'], ['kontakt', '/kontakty'], ['o_nas', '/o-nas'],
  ['pravne', '/obchodne-podmienky'], ['pravne', '/gdpr'], ['pravne', '/reklamacny-poriadok']];

function extractLinks(src, baseUrl, isMarkdown) {
  const raw = [];
  if (isMarkdown) {
    for (const m of src.matchAll(/\[([^\]]{0,150})\]\((https?:\/\/[^)\s]+)\)/g)) raw.push([m[2], m[1]]);
  } else {
    for (const m of src.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]{0,2000}?)<\/a\s*>/gi)) {
      raw.push([m[1] ?? m[2] ?? m[3], decodeEntities(m[4].replace(/<[^>]+>/g, ' '))]);
    }
  }
  const links = new Map();
  for (const [href, text] of raw) {
    // šablóny a JS odkazy ("https&…", "{{url}}", "${…}") nie sú skutočné adresy
    if (!href || /[{}$<>\s]|^[a-z]+&|^&/i.test(href.trim())) continue;
    const url = resolveUrl(href, baseUrl);
    if (!url || !isOwn(url) || SKIP.test(url)) continue;
    const p = parseUrl(url);
    if (!p || p.path === '/' && !p.query) continue;
    const key = norm(decodeURIComponentSafe(p.path + ' ' + text)).replace(/[^a-z0-9]+/g, '-');
    let best = null;
    for (const [typ, re, w] of RULES) if (re.test(key) && (!best || w > best.w)) best = { typ, w };
    const score = (best ? best.w : 0) - (LANG.test(p.path) ? 6 : 0) - (p.path.split('/').filter(Boolean).length - 1) * 0.5;
    const k = urlKey(url);
    if (!links.has(k) || links.get(k).score < score) links.set(k, { url, typ: best ? best.typ : 'ine', score });
  }
  return [...links.values()];
}
function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

function pickSubpages(links, homeUrl) {
  const chosen = [], count = { kontakt: 0, pravne: 0, o_nas: 0, obsah: 0, ine: 0 };
  const homeKey = urlKey(homeUrl);
  for (const l of links.sort((a, b) => b.score - a.score)) {
    if (chosen.length >= MAX_PAGES) break;
    if (l.score <= 0 || count[l.typ] >= QUOTA[l.typ] || urlKey(l.url) === homeKey) continue;
    if (chosen.some(c => urlKey(c.url) === urlKey(l.url))) continue;
    count[l.typ]++;
    chosen.push(l);
  }
  // typické cesty doplníme len pre typy, ktoré sa v odkazoch nenašli
  const b = parseUrl(homeUrl);
  for (const [typ, path] of DEFAULT_PATHS) {
    if (chosen.length >= MAX_PAGES) break;
    if (count[typ] > 0) continue;
    const url = `${b.proto}://${b.host}${path}`;
    if (!chosen.some(c => urlKey(c.url) === urlKey(url))) chosen.push({ url, typ, score: 0, predvolena: true });
  }
  return chosen;
}

function makePage(url, typ, body, zdroj) {
  if (zdroj === 'jina') {
    const title = (body.match(/^Title:\s*(.+)$/m) || [])[1] || '';
    return { url, typ, titulok: title.trim().slice(0, 200), popis_meta: '', nazov_webu: '', text: markdownToText(body.replace(/^Title:.*$/m, '')), zdroj };
  }
  return { url, typ, ...metaInfo(body), text: htmlToText(body), zdroj };
}

// ---------- 1) hlavná stránka ----------
let homeRaw = null;   // priama odpoveď (HTML)
let homeMd = null;    // odpoveď cez r.jina.ai (markdown)
for (const candidate of [`https://${D}/`, `https://www.${D}/`, `http://${D}/`, `http://www.${D}/`]) {
  if (timeLeft() < 5000) break;
  const r = await fetchUrl(candidate, candidate === `https://${D}/` ? 2 : 1);
  item.web.pokusy.push({ url: candidate, status: r.status, ...(r.error ? { error: r.error } : {}), ...(r.url !== candidate ? { finalna_url: r.url } : {}) });
  if (r.ok && r.html) { homeRaw = r; break; }
  // doména ani www nemajú DNS záznam → http varianty nemajú zmysel
  if (candidate === `https://www.${D}/` && item.web.pokusy.every(p => /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(p.error || ''))) break;
}

let home = null;
if (homeRaw) {
  ownHosts.add(bareHost(parseUrl(homeRaw.url).host)); // presmerovanie na inú doménu (napr. firma.eu)
  home = makePage(homeRaw.url, 'home', homeRaw.html, 'priamo');
  if (isBotWall(home) || looksLikeJsApp(homeRaw.html, home.text)) { // blokované alebo obsah kreslí až JavaScript
    const direct = home;
    homeMd = await fetchJina(homeRaw.url);
    home = homeMd ? { ...makePage(homeRaw.url, 'home', homeMd, 'jina'), titulok: direct.titulok, nazov_webu: direct.nazov_webu, popis_meta: direct.popis_meta } : direct;
  }
} else {
  homeMd = await fetchJina(`https://${D}/`);           // web nedostupný alebo blokuje roboty
  if (homeMd) home = makePage(`https://${D}/`, 'home', homeMd, 'jina');
}
if (home && isBotWall(home)) {
  item.web.pokusy.push({ url: home.url, status: 0, error: 'stránka ochrany proti robotom (napr. Cloudflare)' });
  home = null;
}
if (!home) {
  item.chyby.push({ kod: 'web_unreachable', detail: item.web.pokusy.map(p => `${p.url} → ${p.status || p.error}`).join('; ') });
  return { json: item };
}
const viaJina = home.zdroj === 'jina';
item.web.zaklad = home.url;
item.web.jina = viaJina;

// ---------- 2) podstránky ----------
const links = [
  ...(homeRaw ? extractLinks(homeRaw.html, home.url, false) : []),
  ...(homeMd ? extractLinks(homeMd, home.url, true) : []),
];
// takmer prázdna stránka bez odkazov (napr. chybová hláška servera) → typické cesty neskúšame, nemá to zmysel
// pri Jina (pomalšie, limit požiadaviek) načítame menej podstránok
const subpages = !links.length && home.text.length < 100 ? []
  : pickSubpages(links, home.url).slice(0, viaJina ? Math.min(4, MAX_PAGES) : MAX_PAGES);
const results = await Promise.all(subpages.map(async sp => {
  if (viaJina) {
    const md = await fetchJina(sp.url);
    return md ? makePage(sp.url, sp.typ, md, 'jina') : null;
  }
  const r = await fetchUrl(sp.url, 2);
  if (!sp.predvolena || r.ok) item.web.pokusy.push({ url: sp.url, status: r.status, ...(r.error ? { error: r.error } : {}) });
  return r.ok && r.html ? makePage(r.url, sp.typ, r.html, 'priamo') : null;
}));

// duplicity („soft 404“: neexistujúca stránka vráti hlavnú s kódom 200) a prázdne stránky vyhodíme
const signature = p => p.text.length + ':' + p.text.slice(0, 1500);
const seenSig = new Set([signature(home)]);
const seenUrl = new Set([urlKey(home.url)]);
const pages = [home];
for (const p of results) {
  if (!p || p.text.length < 50 || isBotWall(p)) continue;
  const sig = signature(p), k = urlKey(p.url);
  if (seenSig.has(sig) || seenUrl.has(k)) continue;
  seenSig.add(sig);
  seenUrl.add(k);
  pages.push(p);
}
item.web.stranky = pages;
item.web.ok = true;
return { json: item };
