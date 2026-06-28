# World Cup 2026 — interactive knockout bracket

A self-contained, interactive Round of 32 → Final bracket for the 2026 FIFA World Cup
knockout stage. A slider blends between two Elo snapshots to predict match winners; scores
update live as you drag. Matches decided by under 40 Elo points are flagged **tctc** (too
close to call).

**Live site:** https://messelink.github.io/world-cup-2026/

## How it works

- The slider blends two Elo snapshots: **0%** = pure pre-tournament prior (`PRE`),
  **100%** = current form (`LATEST`), intermediate values blend linearly. Default 40/60.
- **Played knockout matches show the real result** (score + `FT` badge) and lock that
  matchup; the real winner feeds the next round. **Unplayed matches are predicted** from
  the slider blend. Winners propagate automatically; the predicted champion updates live.

## Data sources

All Elo ratings are from [footballratings.org](https://footballratings.org), which mirrors
[eloratings.net](https://eloratings.net) nightly.

- **PRE** (static) — each team's Elo after their last match before the tournament kicked
  off on 11 June 2026.
- **LATEST** (auto-updated) — each team's current footballratings Elo, i.e. all real
  signal to date. As knockout rounds are played, the teams still alive are refreshed.

The Round of 32 pairings are the confirmed 2026 World Cup fixtures.

## Auto-update

`scripts/update.mjs` keeps the data current with no manual work:

- **Results** ← the [Wikipedia knockout page](https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_knockout_stage)
  (`footballbox` templates) — including penalty shootouts / advancement.
- **Ratings** ← footballratings.org team pages, fetched only for teams **still alive**
  in the knockouts (a team's Elo only moves when it plays).
- **Fail-loud:** any scrape/validation problem writes nothing and exits non-zero, so the
  site keeps its last known-good data. Unparseable penalty shootouts (rare) fall back to a
  prediction with a warning rather than recording a wrong winner.
- **Idempotent:** it commits (and re-deploys) only when ratings or results actually
  change — so the "Data updated `YYYY-MM-DD HH:MM UTC`" stamp marks the last real change,
  not the last check.

The workflow `.github/workflows/update-data.yml` runs **every 6 hours** (00:17 / 06:17 /
12:17 / 18:17 UTC) and on demand: scrape → commit if changed → deploy. Frequent runs are
free because they no-op when nothing changed; this catches results within hours of
full-time and picks up footballratings' ~1-day nightly lag without guessing its exact
timing. Run locally with `node scripts/update.mjs` (`--full` refreshes every team;
`--dry-run` prints without writing).

## Hosting

The bracket is a single self-contained `index.html` (no build step, no dependencies),
served via GitHub Pages and deployed by the GitHub Actions workflow in
`.github/workflows/deploy.yml`.
