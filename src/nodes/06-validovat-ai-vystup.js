// Validovať AI výstup (Code, Run Once for Each Item)
// Skontroluje odpoveď OpenAI: platný JSON, presne 3 príležitosti, náročnosť z povoleného zoznamu, e-mail ≤ limit slov.
// Ak niečo nesedí, pripraví JEDNU opravnú požiadavku (pôvodná konverzácia + zoznam problémov) → node „OpenAI — oprava“.
// Chyba API (401, 429, timeout…) sa neopravuje, zapíše sa ako ai_error a workflow pokračuje.

const cfg = $('Konfigurácia').first().json;
const base = $('Pripraviť AI požiadavku').item.json;
const MAX_WORDS = Number(cfg.max_slov_email) || 120;
const MIN_WORDS = Math.min(Number(cfg.min_slov_email) || 90, MAX_WORDS - 10);

// ---------- spoločné funkcie (rovnaké aj v „Zostaviť výsledok“) ----------
const countWords = s => (String(s || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’.\-–]*/gu) || []).length;
// počet viet – skratky s bodkou (s. r. o., napr., Ing. …) sa najprv zbavia bodiek, aby sa nerátali ako koniec vety
const ABBR = /(?<![\p{L}])(?:spol\.\s?s\s?r\.\s?o\.|s\.\s?r\.\s?o\.|a\.\s?s\.|k\.\s?s\.|v\.\s?o\.\s?s\.|napr\.|atď\.|tzv\.|resp\.|ul\.|tel\.|č\.|ing\.|mgr\.|mudr\.|bc\.|phdr\.|judr\.|rndr\.|dr\.|t\.\s?j\.|t\.\s?č\.|cca\.|min\.|max\.|hod\.|str\.)/giu;
const countSentences = s => String(s || '').replace(ABBR, m => m.replace(/\./g, '')).replace(/(\d)\.(\d)/g, '$1,$2')
  .split(/(?<=[.!?…])\s+/).filter(x => /\p{L}/u.test(x)).length;
// štýl, ktorý model napriek promptu občas poruší – kontrolujeme kódom
const FLATTERY = /(?<![\p{L}])(?:skvel\p{L}*|výborn\p{L}*|výnimočn\p{L}*|úžasn\p{L}*|fantastick\p{L}*|perfektn\p{L}*|vynikajúc\p{L}*|veľmi zaujímav\p{L}*)/giu;
const SINGULAR = /(?<![\p{L}])(?:ďakujem|teším sa|rád by som|rada by som|zaznamenal som|zaznamenala som|všimol som|všimla som|navrhujem|ponúkam|mám)(?![\p{L}])/giu;
const GENERIC = /kontaktn\p{L}* (?:údaj|informáci)\p{L}*|(?:môžu|možnosť|možno) (?:ich |firmu )?kontaktovať|komunikáci\p{L}* so zákazníkmi je dôležit|na webe (?:sú|je) (?:uvedené |uvedený )?kontakt/iu;
const found = (re, s) => [...new Set((String(s || '').match(re) || []).map(x => x.toLowerCase()))].join('“, „');
function apiError(resp) {
  const e = resp?.error;
  if (!e) return 'neočakávaná odpoveď API';
  if (typeof e === 'string') return e.slice(0, 300);
  return [e.message, e.description].filter(Boolean).join(' – ').slice(0, 300) || JSON.stringify(e).slice(0, 300);
}
function parseAi(resp) {
  if (!resp || !Array.isArray(resp.choices)) return { fatal: apiError(resp) };
  const msg = resp.choices[0]?.message || {};
  if (msg.refusal) return { fatal: 'model odmietol: ' + msg.refusal };
  const raw = typeof msg.content === 'string' ? msg.content : '';
  try { return { ai: JSON.parse(raw), raw, finish: resp.choices[0].finish_reason }; } catch (e) { return { ai: null, raw, finish: resp.choices[0]?.finish_reason }; }
}
function validateAi(ai, maxWords, minWords) {
  const p = [];
  if (!ai || typeof ai !== 'object') return ['Odpoveď nie je platný JSON podľa schémy.'];
  const sentences = countSentences(ai.popis);
  if (!String(ai.popis || '').trim()) p.push('Chýba "popis".');
  else if (sentences < 2 || sentences > 3) p.push(`"popis" musí mať 2 až 3 vety (teraz ${sentences}). Uprav ho na 2–3 celé vety.`);
  const opp = Array.isArray(ai.prilezitosti) ? ai.prilezitosti : [];
  if (opp.length < 3) p.push(`"prilezitosti" musí obsahovať presne 3 položky (teraz ${opp.length}).`);
  opp.slice(0, 3).forEach((o, i) => {
    for (const k of ['nazov', 'co_sa_automatizuje', 'uspora_casu', 'preco_prave_vy']) if (!String(o?.[k] || '').trim()) p.push(`Príležitosť ${i + 1}: chýba "${k}".`);
    if (!['nízka', 'stredná', 'vysoká'].includes(o?.narocnost)) p.push(`Príležitosť ${i + 1}: "narocnost" musí byť nízka, stredná alebo vysoká.`);
    if (GENERIC.test(o?.preco_prave_vy || '')) p.push(`Príležitosť ${i + 1}: "preco_prave_vy" je všeobecné („${o.preco_prave_vy}“) – oprieť ho o konkrétnu službu, formulár alebo stránku z webu, prípadne navrhni inú príležitosť.`);
  });
  const words = countWords(ai.email);
  if (!words) p.push('Chýba "email".');
  else if (words > maxWords) p.push(`E-mail má ${words} slov, limit je ${maxWords}. Skráť ho na ${minWords}–${maxWords - 5} slov; zachovaj vykanie, zdvorilý tón, oslovenie a záver.`);
  else if (words < minWords) p.push(`E-mail má len ${words} slov, je príliš krátky. Rozšír ho na ${minWords}–${maxWords - 5} slov: zdvorilo predstav odosielateľa, konkrétnejšie opíš, ako by navrhnutá automatizácia u nich fungovala a koľko času ušetrí, a pridaj poďakovanie za čas. Zachovaj vykanie, tón a štruktúru.`);
  if (found(FLATTERY, ai.email)) p.push(`"email" obsahuje hodnotiace frázy („${found(FLATTERY, ai.email)}“) – nahraď ich vecným pozorovaním.`);
  if (found(SINGULAR, ai.email)) p.push(`"email" mieša jednotné číslo („${found(SINGULAR, ai.email)}“) – píš dôsledne v množnom čísle (my, radi by sme, ďakujeme, tešíme sa).`);
  return p;
}
function addUsage(t, usage) {
  if (!usage) return;
  t.vstup += usage.prompt_tokens || 0;
  t.vystup += usage.completion_tokens || 0;
  t.cache += usage.prompt_tokens_details?.cached_tokens || 0;
  t.volania += 1;
}
// -------------------------------------------------------------------------

const item = { ...base, chyby: [...(base.chyby || [])] };
item.tokeny = { vstup: 0, vystup: 0, cache: 0, volania: 0 };
item.ai_model = $json.model || base.ai_poziadavka?.model;
addUsage(item.tokeny, $json.usage);

const parsed = parseAi($json);
item.ai = null;
item.potrebna_oprava = false;
if (parsed.fatal) {
  item.chyby.push({ kod: 'ai_error', detail: parsed.fatal });
} else {
  if (Array.isArray(parsed.ai?.prilezitosti) && parsed.ai.prilezitosti.length > 3) parsed.ai.prilezitosti = parsed.ai.prilezitosti.slice(0, 3);
  const problems = parsed.ai ? validateAi(parsed.ai, MAX_WORDS, MIN_WORDS)
    : [`Odpoveď nie je platný JSON${parsed.finish === 'length' ? ' (bola odrezaná – skráť texty)' : ''}.`];
  item.ai = parsed.ai;
  item.ai_problemy = problems;
  if (problems.length) {
    item.potrebna_oprava = true;
    item.oprava_poziadavka = {
      ...base.ai_poziadavka,
      messages: [
        ...base.ai_poziadavka.messages,
        { role: 'assistant', content: parsed.raw || '' },
        { role: 'user', content: `Oprav svoju odpoveď. Problémy:\n- ${problems.join('\n- ')}\nVráť kompletný opravený JSON v rovnakej schéme. Časti bez problémov ponechaj bez zmeny.` },
      ],
    };
  }
}
delete item.ai_poziadavka; // veľký objekt (celý prompt) – už nie je potrebný
return { json: item };
