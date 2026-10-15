// Vytiahne výsledky posledného behu workflow z databázy n8n (iba čítanie) do priečinka results/.
// Použitie: node test/collect-results.mjs [--workflow MiniAiDiscovery1] [--execution 123] [--db C:/Users/<user>/.n8n/database.sqlite]
// Výstup: results/<domena>.json (plný JSON na firmu), results/README.md (čitateľná verzia), results/vysledky.csv (= Google Sheet)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };
const DB = arg('db', path.join(os.homedir(), '.n8n', 'database.sqlite'));
const WF = arg('workflow', 'MiniAiDiscovery1');
const EXEC = arg('execution', null);
const require = createRequire(import.meta.url);
const { parse } = require(path.join(process.env.N8N_DIR || 'D:/npm-global/node_modules/n8n', 'node_modules/flatted'));

const db = new DatabaseSync(DB, { readOnly: true });
const row = EXEC
  ? db.prepare('SELECT e.id, e.status, e.startedAt, d.data FROM execution_entity e JOIN execution_data d ON d.executionId = e.id WHERE e.id = ?').get(Number(EXEC))
  : db.prepare('SELECT e.id, e.status, e.startedAt, d.data FROM execution_entity e JOIN execution_data d ON d.executionId = e.id WHERE e.workflowId = ? ORDER BY e.id DESC LIMIT 1').get(WF);
if (!row) throw new Error(`Beh workflow ${WF} sa nenašiel`);
const run = parse(row.data).resultData.runData;

const results = (run['Výsledky (JSON)']?.at(-1)?.data?.main?.[0] || []).map(i => i.json);
const sheetRows = (run['Pre každú doménu']?.at(-1)?.data?.main?.[0] || []).map(i => i.json); // = riadky Google Sheets
const sheets = run['Zapísať do Google Sheets']?.at(-1)?.data?.main?.[0]?.[0]?.json;
const OUT = path.join(ROOT, 'results');
fs.mkdirSync(OUT, { recursive: true });
for (const r of results) fs.writeFileSync(path.join(OUT, `${r.domena}.json`), JSON.stringify(r, null, 2) + '\n');

// ---------- CSV (rovnaké stĺpce ako Google Sheet, bez plného JSON) ----------
if (sheetRows.length) {
  const cols = Object.keys(sheetRows[0]).filter(c => c !== 'json');
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.map(cell).join(','), ...sheetRows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n');
  fs.writeFileSync(path.join(OUT, 'vysledky.csv'), '\uFEFF' + csv + '\r\n');
}

// ---------- čitateľná verzia (Markdown) ----------
const esc = s => String(s ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const STATUS = s => (s === 'ok' ? '✅ ok' : ['ico_not_found_on_web', 'multiple_matches', 'rpo_not_found'].includes(s) ? `⚠️ ${s}` : `❌ ${s}`);
const EFFORT = { nízka: '🟢 nízka', stredná: '🟡 stredná', vysoká: '🔴 vysoká' };
const usd = n => '$' + Number(n || 0).toFixed(5);
const date = new Date(row.startedAt.replace(' ', 'T') + 'Z').toLocaleString('sk-SK', { timeZone: 'Europe/Bratislava', dateStyle: 'medium', timeStyle: 'short' });
const tot = results.reduce((t, r) => ({ tok: t.tok + (r.tokeny?.spolu || 0), cena: t.cena + (r.tokeny?.cena_usd || 0) }), { tok: 0, cena: 0 });
const model = results.find(r => r.tokeny?.model)?.tokeny.model || '—';
const icoLabel = ico => (ico?.verified ? `✅ overené (${ico.source})` : ico?.value ? `⚠️ neoverené (${ico.source})` : '—');

const md = [
  '# Výsledky pre testovacie weby',
  '',
  `Beh n8n **#${row.id}** · ${date} · model \`${model}\` · Google Sheets: ${sheets?.error ? 'chyba – ' + sheets.error : 'zapísané'}`,
  '',
  'Rovnaké dáta: [`vysledky.csv`](vysledky.csv) (= riadky Google Sheet) a plný JSON pre každú firmu (`<domena>.json`).',
  '',
  '| Doména | Firma | Status | IČO | Sídlo (RPO) | Cena |',
  '|---|---|---|---|---|---|',
  ...results.map(r => `| ${r.domena} | ${esc(r.firma?.nazov?.value)} | ${STATUS(r.status)} | ${esc(r.firma?.ico?.value)} ${r.firma?.ico?.verified ? '✅' : ''} | ${esc(r.firma?.sidlo?.value)} | ${usd(r.tokeny?.cena_usd)} |`),
  '',
  `**Spolu:** ${results.length} firmy · ${tot.tok.toLocaleString('sk-SK')} tokenov · ${usd(tot.cena)} → priemer **${usd(tot.cena / Math.max(1, results.length))} na firmu**.`,
  '',
  ...results.flatMap(r => {
    const f = r.firma || {};
    return [
      '---',
      '',
      `## ${f.nazov?.value || r.domena} · ${r.domena}`,
      '',
      '| | |',
      '|---|---|',
      `| **IČO** | ${esc(f.ico?.value)} – ${icoLabel(f.ico)}${f.rpo_url ? ` · [RPO](${f.rpo_url})` : ''} |`,
      `| **Sídlo** | ${esc(f.sidlo?.value)} (${f.sidlo?.source || '—'}) |`,
      ...(f.adresa_na_webe?.value && f.adresa_na_webe.value !== f.sidlo?.value ? [`| **Adresa na webe** | ${esc(f.adresa_na_webe.value)} |`] : []),
      ...(f.pravna_forma?.value ? [`| **Právna forma** | ${esc(f.pravna_forma.value)} |`] : []),
      ...(f.statutari?.value?.length ? [`| **Štatutári** | ${esc(f.statutari.value.join(', '))} |`] : []),
      ...(f.kontakt_na_webe?.emaily?.length || f.kontakt_na_webe?.telefony?.length ? [`| **Kontakt na webe** | ${esc([...(f.kontakt_na_webe.emaily || []), ...(f.kontakt_na_webe.telefony || [])].join(', '))} |`] : []),
      ...(r.popis?.odvetvie ? [`| **Odvetvie** | ${esc(r.popis.odvetvie)} |`] : []),
      '',
      ...(r.popis?.value ? ['### Čo firma robí', '', r.popis.value, ''] : ['_AI výstup nie je k dispozícii._', '']),
      ...(r.zistenia?.value?.length ? ['### Zistenia z webu', '', ...r.zistenia.value.map(z => `- ${z}`), ''] : []),
      ...(r.prilezitosti?.length ? ['### 3 príležitosti na AI automatizáciu', '', ...r.prilezitosti.flatMap((o, i) => [
        `**${i + 1}. ${o.nazov}** · ${EFFORT[o.narocnost] || o.narocnost} · ${o.uspora_casu}`,
        `${o.co_sa_automatizuje}`,
        `<br>_Prečo práve Vy:_ ${o.preco_prave_vy}`,
        '',
      ])] : []),
      ...(r.email ? [`### Návrh e-mailu (${r.email.pocet_slov} slov)`, '', `**Predmet:** ${r.email.predmet}`, '', '> ' + r.email.text.trim().replace(/\n/g, '\n> '), ''] : []),
      '<details><summary>Kontrola a zdroje</summary>',
      '',
      `- Status: \`${r.status}\``,
      `- Chyby / upozornenia: ${r.chyby?.length ? r.chyby.map(c => `\`${c.kod}\` ${c.sprava}`).join('; ') : 'žiadne'}`,
      `- Tokeny: ${r.tokeny?.vstup ?? 0} vstup + ${r.tokeny?.vystup ?? 0} výstup (${r.tokeny?.volania ?? 0}× volanie) = ${usd(r.tokeny?.cena_usd)}`,
      `- Zdroje: ${(r.zdroje || []).map(z => z.replace(/ \(.*\)$/, '')).map(u => `<${u}>`).join(', ')}`,
      '',
      '</details>',
      '',
    ];
  }),
].join('\n');
fs.writeFileSync(path.join(OUT, 'README.md'), md);
console.log(`Beh #${row.id}: ${results.length} firiem → ${OUT}`);
for (const r of results) console.log(`  ${r.domena.padEnd(22)} ${r.status.padEnd(20)} ${r.firma?.ico?.value || '—'} | tokeny ${r.tokeny?.spolu ?? 0} | ${usd(r.tokeny?.cena_usd)}`);
