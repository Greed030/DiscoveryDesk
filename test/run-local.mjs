// Lokálny test kódu z Code nód – bez spustenia n8n.
// Kód beží v rovnakom VM sandboxe ako v task runneri n8n 2.x (bez triedy URL, zmrazené vstavané objekty)
// a HTTP volania idú cez skutočnú funkciu httpRequest z n8n-core (rovnaké správanie ako v n8n).
//
// Použitie:
//   node test/run-local.mjs gesan.sk bellesa.sk            # web + RPO, AI sa simuluje (mock)
//   OPENAI_API_KEY=sk-... node test/run-local.mjs gesan.sk  # aj so skutočným volaním OpenAI
// Výstupy: test/out/<domena>.debug.json, .prompt.txt, .result.json

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test', 'out');
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(import.meta.url);
const N8N = process.env.N8N_DIR || 'D:/npm-global/node_modules/n8n';
const { httpRequest } = require(path.join(N8N, 'node_modules/n8n-core/dist/execution-engine/node-execution-context/utils/request-helper-functions.js'));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'config.json'), 'utf8'));
if (process.env.CFG) Object.assign(config, JSON.parse(process.env.CFG)); // napr. CFG='{"rpo_timeout_ms":1}'

// RPC z task runnera: výsledok ide cez JSON (vnorené Buffery prídu ako {type:'Buffer', data:[…]})
const helpers = {
  httpRequest: async opts => {
    const res = await httpRequest(structuredClone(opts));
    if (Buffer.isBuffer(res)) return res;
    return JSON.parse(JSON.stringify(res));
  },
};

const PRELUDE = [
  'globalThis.global = globalThis', 'var module = { exports: {} }',
  'Object.getPrototypeOf = () => ({})', 'Reflect.getPrototypeOf = () => ({})',
  'Object.setPrototypeOf = () => false', 'Reflect.setPrototypeOf = () => false',
  'Object.defineProperty = () => ({})', 'Object.defineProperties = () => ({})',
  '[Object, Function, Array, String, Number, Boolean, RegExp, Error, TypeError, RangeError, SyntaxError, ReferenceError, Promise, Symbol, Map, Set, WeakMap, WeakSet, Date, JSON, Math, Reflect, ArrayBuffer, DataView, Int8Array, Uint8Array, Float32Array, Float64Array].forEach((c) => { try { Object.freeze(c); } catch {} })',
].join('; ');

// rovnaký kód ako vo workflow (per-item nody obalené do try/catch cez wrapCode z build skriptu)
const { wrapCode } = await import(pathToFileURL(path.join(ROOT, 'src', 'build-workflow.mjs')).href);
const WRAP = { '02': ['Stiahnuť web'], '03': ['Extrahovať fakty'], '04': ['Overiť v RPO'], '05': ['Pripraviť AI požiadavku'], '06': ['Validovať AI výstup', 'validate'], '07': ['Zostaviť výsledok', 'result'] };
const code = Object.fromEntries(fs.readdirSync(path.join(ROOT, 'src', 'nodes')).map(f => {
  const key = f.slice(0, 2), src = fs.readFileSync(path.join(ROOT, 'src', 'nodes', f), 'utf8');
  return [key, WRAP[key] ? wrapCode(src, ...WRAP[key]) : src];
}));
const outputs = {}; // názov nody → posledný výstup (pre $('Node').item / .first())

function run(key, inputItems) {
  const items = inputItems.map(j => ({ json: structuredClone(j) }));
  const $ = name => {
    const arr = outputs[name];
    if (!arr) throw new Error(`Node '${name}' hasn't been executed`);
    return { first: () => ({ json: arr[0] }), all: () => arr.map(json => ({ json })), item: { json: arr[0] } };
  };
  const context = vm.createContext({
    __isExecutionContext: true, console, Buffer, setTimeout, setInterval, setImmediate, clearTimeout, clearInterval,
    clearImmediate, btoa, atob, TextDecoder, TextEncoder, FormData, helpers, $,
    $input: { all: () => items, first: () => items[0], item: items[0] }, $json: items[0]?.json, items,
  });
  return vm.runInContext(`${PRELUDE}; module.exports = async function VmCodeWrapper() {${code[key]}\n}()`, context);
}
const each = async (key, json) => (await run(key, [json])).json;

async function callOpenAI(body) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify(body),
  });
  return res.json();
}
// simulovaná odpoveď AI (overenie validácie a skladania výsledku bez API kľúča)
function mockOpenAI(body) {
  // MOCK_FAIL=1 → odpoveď ako z HTTP Request nody pri chybe API (On Error: Continue)
  if (process.env.MOCK_FAIL) return { error: { message: 'Authorization failed - please check your credentials', description: 'Incorrect API key provided' } };
  const ai = {
    popis: 'Testovací popis firmy (mock). Druhá veta popisu.', odvetvie: 'test', kvalita_podkladov: 'dostatočné',
    prilezitosti: [1, 2, 3].map(i => ({ nazov: `Príležitosť ${i}`, co_sa_automatizuje: 'Test.', uspora_casu: 'odhad 1–2 h týždenne', narocnost: 'nízka', preco_prave_vy: 'Test.' })),
    // dĺžka e-mailu v 1. odpovedi a po oprave: MOCK_WORDS="130,100" (predvolené)
    email_predmet: 'Test', email: 'Dobrý deň, ' + 'slovo '.repeat(Number((process.env.MOCK_WORDS || '130,100').split(',')[body.messages.length > 2 ? 1 : 0])) + 'S pozdravom',
  };
  return { model: body.model + '-mock', choices: [{ message: { content: JSON.stringify(ai) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 300 } };
}
const ai = body => (process.env.OPENAI_API_KEY ? callOpenAI(body) : mockOpenAI(body));

// ---------- pipeline (rovnaké poradie ako vo workflow) ----------
const domains = process.argv.slice(2);
config.domeny = domains.length ? domains.join('\n') : config.domeny;
outputs['Konfigurácia'] = [config];
// riadky výstupnej tabuľky (node „Načítať spracované“); prázdna tabuľka = 1 prázdna položka (alwaysOutputData)
// napr. SHEET_ROWS='[{"domena":"gesan.sk","status":"ok"},{"domena":"bellesa.sk","status":"rpo_timeout"}]'
const sheetRows = process.env.SHEET_ROWS ? JSON.parse(process.env.SHEET_ROWS) : [{}];
const normalized = (await run('01', sheetRows)).map(i => i.json);
console.log(`Na spracovanie: ${normalized.map(d => d.domena + (d.predchadzajuci_status ? ` (znova po ${d.predchadzajuci_status})` : '')).join(', ') || '— nič —'}`);

for (const d of normalized) {
  const t0 = Date.now();
  const timing = {};
  const step = async (key, name, input) => { const s = Date.now(); const o = await each(key, input); outputs[name] = [o]; timing[name] = Date.now() - s; return o; };
  try {
    const web = await step('02', 'Stiahnuť web', d);
    const facts = await step('03', 'Extrahovať fakty', web);
    const rpo = await step('04', 'Overiť v RPO', facts);
    const prep = await step('05', 'Pripraviť AI požiadavku', rpo);
    let final;
    if (prep.preskocit_ai) final = await step('07', 'Zostaviť výsledok', prep);
    else {
      fs.writeFileSync(path.join(OUT, `${d.domena}.prompt.txt`), prep.ai_poziadavka.messages.map(m => `=== ${m.role} ===\n${m.content}`).join('\n\n'));
      const s = Date.now(); const resp = await ai(prep.ai_poziadavka); timing['OpenAI — analýza'] = Date.now() - s;
      const valid = await step('06', 'Validovať AI výstup', resp);
      if (valid.potrebna_oprava) {
        const s2 = Date.now(); const resp2 = await ai(valid.oprava_poziadavka); timing['OpenAI — oprava'] = Date.now() - s2;
        final = await step('07', 'Zostaviť výsledok', resp2);
      } else final = await step('07', 'Zostaviť výsledok', valid);
    }
    const debug = {
      web: { ...facts.web, stranky: facts.web.stranky.map(p => ({ url: p.url, typ: p.typ, zdroj: p.zdroj, titulok: p.titulok, znakov: p.text.length })) },
      fakty: facts.fakty, rpo: rpo.rpo, kontext_ai_znakov: facts.kontext_ai.length, chyby: prep.chyby, timing,
    };
    fs.writeFileSync(path.join(OUT, `${d.domena}.debug.json`), JSON.stringify(debug, null, 2));
    fs.writeFileSync(path.join(OUT, `${d.domena}.result.json`), final.json);
    const res = JSON.parse(final.json);
    console.log(`${d.domena.padEnd(28)} ${res.status.padEnd(22)} ico=${String(res.firma.ico.value).padEnd(9)} ${res.firma.ico.source || '-'} | ${res.firma.nazov.value || '-'} | ${res.firma.sidlo.value || '-'} | stránky=${debug.web.stranky.length} | ${Date.now() - t0} ms | ${res.chyby.map(c => c.kod).join(',')}`);
  } catch (e) {
    console.log(`${d.domena.padEnd(28)} CRASH: ${e.stack}`);
  }
}
