#!/usr/bin/env node
// Auto-update the bracket's data block in ../index.html.
//   LATEST ratings  <- footballratings.org team pages (embedded JSON rating series)
//   ACTUAL results  <- Wikipedia 2026 WC knockout page (footballbox templates)
//
// Fail-loud: any scrape/validation problem throws -> nothing is written and the
// process exits non-zero, so the deployed site keeps its last known-good data.
// Penalty shootouts that can't be parsed are left as predictions with a loud
// warning (rather than recording a wrong winner or blocking all other updates).
//
// Flags:  --full      refresh every team's rating (initial sync / periodic reconcile)
//         --dry-run   compute and print, but don't write index.html
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first'); // some hosts have no IPv6 route; avoid ENETUNREACH

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = join(ROOT, 'index.html');
const UA = 'Mozilla/5.0 (wc2026-bracket auto-update; +https://github.com/messelink/world-cup-2026)';
const FULL = process.argv.includes('--full');
const DRY = process.argv.includes('--dry-run');

// Round-of-32 pairings — must stay in sync with index.html's r32 array.
const r32 = [['South Africa','Canada'],['Brazil','Japan'],['Germany','Paraguay'],['Netherlands','Morocco'],['Ivory Coast','Norway'],['France','Sweden'],['Mexico','Ecuador'],['England','Congo DR'],['Belgium','Senegal'],['USA','Bosnia'],['Spain','Austria'],['Portugal','Croatia'],['Switzerland','Algeria'],['Australia','Egypt'],['Argentina','Cape Verde'],['Colombia','Ghana']];
const TEAMS = [...new Set(r32.flat())];
const ROUND_KEYS = ['r32','r16','qf','sf','final'];

// bracket name -> footballratings.org URL slug (default: lowercase, spaces->hyphens)
const SLUG = { 'USA':'united-states', 'Congo DR':'dr-congo' };
const slug = n => SLUG[n] || n.toLowerCase().replace(/ /g, '-');
// Wikipedia display name -> bracket name (only the exceptions)
const WIKI2BR = { 'DR Congo':'Congo DR', 'United States':'USA', 'Bosnia and Herzegovina':'Bosnia' };
const norm = n => WIKI2BR[n] || n;

const decode = s => s.replace(/&#160;/g,' ').replace(/&amp;/g,'&').replace(/&#58;/g,':').replace(/&#39;/g,"'").trim();

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
  return r.text();
}

// Latest Elo rating for a team from its footballratings.org page.
async function fetchRating(name) {
  const html = await fetchText(`https://footballratings.org/team/${slug(name)}`);
  const re = /\{\\?"date\\?":\\?"(\d{4}-\d{2}-\d{2})\\?",\\?"rating\\?":(\d{3,4})/g;
  let m, last = null;
  while ((m = re.exec(html)) !== null) if (!last || m[1] >= last.date) last = { date: m[1], rating: +m[2] };
  if (!last) throw new Error(`no rating series for ${name} (slug "${slug(name)}") — page structure changed or 404`);
  if (last.rating < 1300 || last.rating > 2300) throw new Error(`implausible rating ${last.rating} for ${name}`);
  return last.rating;
}

// Parse the Wikipedia knockout page into a flat list of completed matches.
export function parseResults(html) {
  const h = html.replace(/\s+/g, ' ');
  const boxCount = (h.match(/<th class="fhome"/g) || []).length;
  if (boxCount < 16) throw new Error(`only ${boxCount} footballbox cells found — Wikipedia structure changed?`);
  const teamName = cell => { const a = cell.match(/<a [^>]*>([^<]+)<\/a>/); return a ? decode(a[1]) : null; };
  const re = /<th class="fhome"[^>]*>(.*?)<\/th>\s*<th class="fscore">(.*?)<\/th>\s*<th class="faway"[^>]*>(.*?)<\/th>/g;
  const out = [];
  let m;
  while ((m = re.exec(h)) !== null) {
    const home = teamName(m[1]), away = teamName(m[3]);
    if (!home || !away) continue;
    const g = m[2].match(/(\d+)\s*[–—-]\s*(\d+)/);   // numeric score => played
    if (!g) continue;                                          // e.g. "Match 73" => not played
    let pen = null;
    const pm = m[2].match(/\((\d+)\s*[–—-]\s*(\d+)\s*p\)/i) || m[2].match(/pen[^)]*?(\d+)\s*[–—-]\s*(\d+)/i);
    if (pm) pen = [+pm[1], +pm[2]];
    out.push({ home: norm(home), away: norm(away), gh: +g[1], ga: +g[2], pen });
  }
  return out;
}

const findMatch = (ms, a, b) => ms.find(x => (x.home===a && x.away===b) || (x.home===b && x.away===a));

// Walk the bracket; for each pairing fill an ACTUAL entry if that match has been played.
export function buildActual(matches) {
  const ACTUAL = { r32:[], r16:[], qf:[], sf:[], final:[] };
  const warnings = [], played = new Set(), eliminated = new Set();
  let pairs = r32.map(p => p.slice());
  for (const key of ROUND_KEYS) {
    const winners = [];
    pairs.forEach((pr, i) => {
      if (!pr) { winners.push(null); return; }
      const [a, b] = pr;
      const mt = findMatch(matches, a, b);
      if (!mt) { winners.push(null); return; }
      const aHome = mt.home === a;
      const ga = aHome ? mt.gh : mt.ga, gb = aHome ? mt.ga : mt.gh;
      const pen = mt.pen ? (aHome ? [mt.pen[0], mt.pen[1]] : [mt.pen[1], mt.pen[0]]) : null;
      let w;
      if (ga > gb) w = a;
      else if (gb > ga) w = b;
      else if (pen) w = pen[0] > pen[1] ? a : b;
      else { warnings.push(`${a} v ${b}: drawn ${ga}-${gb}, penalties not parsed — left as prediction (add ACTUAL.${key}[${i}] manually if needed)`); winners.push(null); return; }
      const entry = { w, g: [ga, gb] };
      if (pen) entry.pen = pen;
      ACTUAL[key][i] = entry;
      winners.push(w);
      played.add(a); played.add(b);
      eliminated.add(w === a ? b : a);
    });
    const np = [];
    for (let i = 0; i < winners.length; i += 2) np.push((winners[i] && winners[i+1]) ? [winners[i], winners[i+1]] : null);
    pairs = np;
  }
  const alive = [...played].filter(t => !eliminated.has(t));
  return { ACTUAL, warnings, alive };
}

function extract(html, name) {
  const m = html.match(new RegExp(`const ${name}=(\\{.*?\\});`));
  if (!m) throw new Error(`${name} block not found in index.html`);
  return JSON.parse(m[1].replace(/'/g, '"'));
}

async function main() {
  let html = await readFile(HTML, 'utf8');
  if (!/\/\/ AUTO-DATA-START[\s\S]*?\/\/ AUTO-DATA-END/.test(html)) throw new Error('AUTO-DATA markers not found in index.html');
  const oldLatest = extract(html, 'LATEST');
  const oldActual = extract(html, 'ACTUAL');

  const wiki = await fetchText('https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_knockout_stage');
  const matches = parseResults(wiki);
  const { ACTUAL, warnings, alive } = buildActual(matches);
  console.log(`Parsed ${matches.length} completed match(es) from Wikipedia; ${alive.length} team(s) still alive in the knockouts.`);

  const LATEST = { ...oldLatest };
  const refresh = FULL ? TEAMS : alive;          // only fetch teams whose rating can have moved
  for (const name of refresh) {
    const rating = await fetchRating(name);
    if (rating !== LATEST[name]) console.log(`  ${name}: ${LATEST[name] ?? '?'} -> ${rating}`);
    LATEST[name] = rating;
  }
  if (!refresh.length) console.log('No teams need a rating refresh.');

  for (const w of warnings) console.warn('WARNING: ' + w);

  // Only write/commit if the actual data changed (avoids a daily no-op commit bumping the date).
  const sig = o => JSON.stringify(o);
  if (sig(LATEST) === sig(oldLatest) && sig(ACTUAL) === sig(oldActual)) {
    console.log('No data changes. index.html left untouched.');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const block =
`// AUTO-DATA-START — regenerated by scripts/update.mjs; do not hand-edit below this line
const LATEST=${sig(LATEST)};
const ACTUAL=${sig(ACTUAL)};
const UPDATED="${today}";
// AUTO-DATA-END`;
  html = html.replace(/\/\/ AUTO-DATA-START[\s\S]*?\/\/ AUTO-DATA-END/, block);

  if (DRY) { console.log('\n--dry-run: would write:\n' + block); return; }
  await writeFile(HTML, html);
  console.log(`Wrote index.html (UPDATED=${today}).`);
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
}
