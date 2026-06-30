#!/usr/bin/env node
// Auto-update the bracket's data block in ../index.html.
//   LATEST ratings  <- footballratings.org team pages (embedded JSON rating series)
//   ACTUAL results  <- ESPN hidden JSON API (one call covers the whole knockout stage)
//
// Fail-loud: any fetch/validation problem throws -> nothing is written and the
// process exits non-zero, so the deployed site keeps its last known-good data.
// ESPN's per-competitor `winner` flag resolves extra-time/penalty advancement
// directly, so a drawn knockout match still yields the correct advancing team.
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

// Round-of-32 pairings in official-bracket order — must stay in sync with index.html's r32 array.
const r32 = [['Germany','Paraguay'],['France','Sweden'],['South Africa','Canada'],['Netherlands','Morocco'],['Portugal','Croatia'],['Spain','Austria'],['USA','Bosnia'],['Belgium','Senegal'],['Brazil','Japan'],['Ivory Coast','Norway'],['Mexico','Ecuador'],['England','Congo DR'],['Argentina','Cape Verde'],['Australia','Egypt'],['Switzerland','Algeria'],['Colombia','Ghana']];
const TEAMS = [...new Set(r32.flat())];
const ROUND_KEYS = ['r32','r16','qf','sf','final'];

// bracket name -> footballratings.org URL slug (default: lowercase, spaces->hyphens)
const SLUG = { 'USA':'united-states', 'Congo DR':'dr-congo' };
const slug = n => SLUG[n] || n.toLowerCase().replace(/ /g, '-');
// ESPN scoreboard endpoint — one call returns every knockout match (R32 -> final).
const ESPN_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260628-20260719';
// ESPN display name -> bracket name (only the exceptions; all other names match exactly).
const ESPN2BR = { 'Bosnia-Herzegovina':'Bosnia', 'United States':'USA' };
const norm = n => ESPN2BR[n] || n;
const TEAMSET = new Set(TEAMS);

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

// Parse the ESPN scoreboard JSON into a flat list of completed knockout matches.
export function parseResults(json) {
  const events = json.events || [];
  if (events.length < 16) throw new Error(`ESPN returned only ${events.length} events — API or league slug changed?`);
  const out = [];
  for (const e of events) {
    const c = e.competitions && e.competitions[0];
    if (!c || !(c.status && c.status.type && c.status.type.completed)) continue;   // finished matches only
    const cs = c.competitors || [];
    const home = cs.find(x => x.homeAway === 'home'), away = cs.find(x => x.homeAway === 'away');
    if (!home || !away) continue;
    const H = norm(home.team.displayName), A = norm(away.team.displayName);
    const gh = parseInt(home.score, 10), ga = parseInt(away.score, 10);
    if (!Number.isInteger(gh) || !Number.isInteger(ga)) continue;
    if (!TEAMSET.has(H) || !TEAMSET.has(A)) throw new Error(`ESPN team not mapped to a bracket team: "${H}" / "${A}"`);
    const winner = home.winner ? H : (away.winner ? A : null);               // explicit; resolves ET/penalties
    let pen = null;
    if (home.shootoutScore != null && away.shootoutScore != null) pen = [+home.shootoutScore, +away.shootoutScore];
    out.push({ home: H, away: A, gh, ga, winner, pen });
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
      if (mt.winner) w = mt.winner;                        // ESPN explicit winner — resolves ET/penalties
      else if (ga > gb) w = a;
      else if (gb > ga) w = b;
      else if (pen) w = pen[0] > pen[1] ? a : b;
      else { warnings.push(`${a} v ${b}: drawn ${ga}-${gb} with no winner flag — left as prediction`); winners.push(null); return; }
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

  const espn = JSON.parse(await fetchText(ESPN_URL));
  const matches = parseResults(espn);
  const { ACTUAL, warnings, alive } = buildActual(matches);
  console.log(`Parsed ${matches.length} completed match(es) from ESPN; ${alive.length} team(s) still alive in the knockouts.`);

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

  const iso = new Date().toISOString();
  const stamp = `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;  // e.g. "2026-06-28 14:30 UTC"
  const block =
`// AUTO-DATA-START — regenerated by scripts/update.mjs; do not hand-edit below this line
const LATEST=${sig(LATEST)};
const ACTUAL=${sig(ACTUAL)};
const UPDATED="${stamp}";
// AUTO-DATA-END`;
  html = html.replace(/\/\/ AUTO-DATA-START[\s\S]*?\/\/ AUTO-DATA-END/, block);

  if (DRY) { console.log('\n--dry-run: would write:\n' + block); return; }
  await writeFile(HTML, html);
  console.log(`Wrote index.html (UPDATED=${stamp}).`);
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
}
