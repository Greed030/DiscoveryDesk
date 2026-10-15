// Zostaví n8n workflow (JSON na import) z kódu v src/nodes a nastavení v src/config.json.
// Použitie: node src/build-workflow.mjs  →  discoverydesk.workflow.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SRC, '..');
const readNode = f => fs.readFileSync(path.join(SRC, 'nodes', f), 'utf8');
const config = JSON.parse(fs.readFileSync(path.join(SRC, 'config.json'), 'utf8'));

// credentials z lokálnej inštancie n8n (na inej inštancii ich n8n pri importe ponúkne vybrať)
const CRED_OPENAI = { openAiApi: { id: 'Ypsho48uqCllcMiX', name: 'OpenAi account' } };
const CRED_SHEETS = { googleSheetsOAuth2Api: { id: '1ZOjgN0L0CfCUcYR', name: 'Google Sheets account' } };

// Kód nody obalíme do try/catch: neočakávaná chyba v kóde nezhodí celý workflow,
// firma sa zapíše so statusom internal_error a ďalšie domény sa spracujú.
const CATCH = {
  default: name => `return { json: { ...$json, chyby: [...($json.chyby || []), { kod: 'internal_error', detail: '${name}: ' + e.message }] } };`,
  validate: name => `const b = $('Pripraviť AI požiadavku').item.json;
  return { json: { ...b, ai: null, potrebna_oprava: false, chyby: [...(b.chyby || []), { kod: 'internal_error', detail: '${name}: ' + e.message }] } };`,
  result: name => `const err = [{ kod: 'internal_error', zavaznost: 'chyba', sprava: 'Interná chyba workflow.', detail: '${name}: ' + e.message }];
  return { json: { domena: $json.domena || '', status: 'internal_error', chyby: err[0].detail, timestamp: new Date().toISOString(), json: JSON.stringify({ domena: $json.domena || null, status: 'internal_error', chyby: err }) } };`,
};
export function wrapCode(code, name, kind = 'default') {
  const lines = code.replace(/\r/g, '').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('//')) i++;
  const header = lines.slice(0, i).join('\n');
  const body = lines.slice(i).join('\n').trim();
  return `${header}
// (celý kód je v try/catch – pri neočakávanej chybe workflow nepadá, firma dostane status internal_error)
try {
${body}
} catch (e) {
  ${CATCH[kind](name)}
}
`;
}

const uuid = name => {
  const h = crypto.createHash('md5').update('mini-ai-discovery/' + name).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const node = (name, type, typeVersion, position, parameters, extra = {}) => ({ parameters, type, typeVersion, position, id: uuid(name), name, ...extra });
const code = (name, file, position, { perItem = true, kind = 'default' } = {}) => node(name, 'n8n-nodes-base.code', 2, position, {
  ...(perItem ? { mode: 'runOnceForEachItem' } : {}),
  jsCode: perItem ? wrapCode(readNode(file), name, kind) : readNode(file),
});
const ifNode = (name, position, leftValue, operation) => node(name, 'n8n-nodes-base.if', 2.3, position, {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
    conditions: [{ id: uuid(name + '/cond'), leftValue, rightValue: '', operator: { type: 'boolean', operation, singleValue: true } }],
    combinator: 'and',
  },
  options: {},
});
const openAi = (name, position, bodyField) => node(name, 'n8n-nodes-base.httpRequest', 4.4, position, {
  method: 'POST',
  url: "={{ $('Konfigurácia').first().json.ai_api_url }}",
  authentication: 'predefinedCredentialType',
  nodeCredentialType: 'openAiApi',
  sendBody: true,
  specifyBody: 'json',
  jsonBody: `={{ JSON.stringify($json.${bodyField}) }}`,
  options: { timeout: 120000 },
}, { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueRegularOutput', credentials: CRED_OPENAI });

const typeOf = v => (typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string');
const CFG = "$('Konfigurácia').first().json";
// tabuľka a hárok z Konfigurácie (URL; hárok podľa #gid=, inak prvý)
const SHEET = {
  documentId: { __rl: true, mode: 'url', value: `={{ ${CFG}.google_sheet }}` },
  sheetName: { __rl: true, mode: 'id', value: `={{ (String(${CFG}.google_sheet).match(/gid=(\\d+)/) || [0, '0'])[1] }}` },
};

const nodes = [
  node('Spustiť', 'n8n-nodes-base.manualTrigger', 1, [0, 300], {}),
  node('Konfigurácia', 'n8n-nodes-base.set', 3.4, [220, 300], {
    assignments: { assignments: Object.entries(config).map(([k, v]) => ({ id: uuid('cfg/' + k), name: k, value: v, type: typeOf(v) })) },
    options: {},
  }),
  // už spracované firmy (riadky výstupnej tabuľky) – prázdna alebo nedostupná tabuľka nevadí
  node('Načítať spracované', 'n8n-nodes-base.googleSheets', 4.7, [440, 300], { operation: 'read', ...SHEET, filtersUI: {}, options: {} },
    { alwaysOutputData: true, onError: 'continueRegularOutput', credentials: CRED_SHEETS }),
  code('Normalizovať domény', '01-normalizovat-domeny.js', [660, 300], { perItem: false }),
  node('Pre každú doménu', 'n8n-nodes-base.splitInBatches', 3, [880, 300], { batchSize: 1, options: {} }),
  code('Stiahnuť web', '02-stiahnut-web.js', [1120, 420]),
  code('Extrahovať fakty', '03-extrahovat-fakty.js', [1340, 420]),
  code('Overiť v RPO', '04-overit-v-rpo.js', [1560, 420]),
  code('Pripraviť AI požiadavku', '05-pripravit-ai-poziadavku.js', [1780, 420]),
  ifNode('Volať AI?', [2000, 420], '={{ $json.preskocit_ai }}', 'false'),
  openAi('OpenAI — analýza', [2220, 340], 'ai_poziadavka'),
  code('Validovať AI výstup', '06-validovat-ai-vystup.js', [2440, 340], { kind: 'validate' }),
  ifNode('Potrebná oprava?', [2660, 340], '={{ $json.potrebna_oprava }}', 'true'),
  openAi('OpenAI — oprava', [2880, 240], 'oprava_poziadavka'),
  code('Zostaviť výsledok', '07-zostavit-vysledok.js', [3120, 440], { kind: 'result' }),
  // jeden riadok na doménu: existujúci riadok sa prepíše (podľa stĺpca domena), nový sa pridá
  node('Zapísať do Google Sheets', 'n8n-nodes-base.googleSheets', 4.7, [1120, 120], {
    operation: 'appendOrUpdate',
    ...SHEET,
    columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['domena'], schema: [], attemptToConvertTypes: false, convertFieldsToString: false },
    options: {},
  }, { onError: 'continueRegularOutput', credentials: CRED_SHEETS }),
  code('Výsledky (JSON)', '08-vysledky-json.js', [1120, -60], { perItem: false }),
  node('Poznámka', 'n8n-nodes-base.stickyNote', 1, [-60, -440], {
    width: 900, height: 460, color: 4,
    content: `## DiscoveryDesk – Mini AI Discovery
Pre každú doménu: web → IČO (len kódom, mod 11) → overenie v RPO → 1× OpenAI (JSON schema) → validácia → Google Sheets + JSON.

**Nastavenie:** všetko v node **Konfigurácia** – \`domeny\` (oddelené čiarkou, napr. \`firma.sk, druha.sk\`), \`model\`, \`google_sheet\` (URL tabuľky, prázdny hárok – hlavičky sa vytvoria samé), ceny tokenov, limity.

**Opakované spustenie:** domény, ktoré už sú v tabuľke s konečným statusom, sa preskočia; s dočasnou chybou (\`opakovat_statusy\`) sa spracujú znova a ich riadok sa prepíše. Všetko znova: \`preskocit_spracovane = false\`.

**Statusy:** ok · web_unreachable · ico_not_found_on_web · rpo_not_found · rpo_timeout · multiple_matches · ai_error · invalid_domain · internal_error. Workflow pri chybe nepadá – firma sa zapíše so statusom a zoznamom chýb.

**Výstup:** riadok v Google Sheets (stĺpec \`json\` = plný výsledok) + node **Výsledky (JSON)**.`,
  }),
  node('Poznámka AI', 'n8n-nodes-base.stickyNote', 1, [1960, 140], {
    width: 1120, height: 180, color: 7,
    content: `### AI časť
AI dostane iba overené údaje z RPO + text webu, nikdy negeneruje IČO. Odpoveď musí spĺňať JSON schému (strict). Ak chýba niečo povinné alebo je e-mail dlhší ako limit, nasleduje **jedna** opravná požiadavka. Tokeny a cena sa logujú pri každej firme (stĺpce \`tokeny\`, \`cena_usd\`).`,
  }),
];

const link = (...targets) => targets.map(t => ({ node: t, type: 'main', index: 0 }));
const connections = {
  'Spustiť': { main: [link('Konfigurácia')] },
  'Konfigurácia': { main: [link('Načítať spracované')] },
  'Načítať spracované': { main: [link('Normalizovať domény')] },
  'Normalizovať domény': { main: [link('Pre každú doménu')] },
  'Pre každú doménu': { main: [link('Zapísať do Google Sheets', 'Výsledky (JSON)'), link('Stiahnuť web')] },
  'Stiahnuť web': { main: [link('Extrahovať fakty')] },
  'Extrahovať fakty': { main: [link('Overiť v RPO')] },
  'Overiť v RPO': { main: [link('Pripraviť AI požiadavku')] },
  'Pripraviť AI požiadavku': { main: [link('Volať AI?')] },
  'Volať AI?': { main: [link('OpenAI — analýza'), link('Zostaviť výsledok')] },
  'OpenAI — analýza': { main: [link('Validovať AI výstup')] },
  'Validovať AI výstup': { main: [link('Potrebná oprava?')] },
  'Potrebná oprava?': { main: [link('OpenAI — oprava'), link('Zostaviť výsledok')] },
  'OpenAI — oprava': { main: [link('Zostaviť výsledok')] },
  'Zostaviť výsledok': { main: [link('Pre každú doménu')] },
};

const workflow = {
  name: 'DiscoveryDesk – Mini AI Discovery',
  nodes,
  connections,
  pinData: {},
  active: false,
  settings: { executionOrder: 'v1', timezone: 'Europe/Bratislava', saveManualExecutions: true },
  meta: { templateCredsSetupCompleted: false },
  tags: [],
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.join(ROOT, 'discoverydesk.workflow.json');
  fs.writeFileSync(out, JSON.stringify(workflow, null, 2) + '\n');
  console.log(`OK: ${out} (${nodes.length} nód vrátane 2 poznámok)`);
}
