# World Cup 2026 — interactive knockout bracket

A self-contained, interactive Round of 32 → Final bracket for the 2026 FIFA World Cup
knockout stage. A slider blends between two Elo snapshots to predict match winners; scores
update live as you drag. Matches decided by under 40 Elo points are flagged **tctc** (too
close to call).

**Live site:** https://messelink.github.io/world-cup-2026/

## How it works

- The slider blends two Elo rating snapshots: **0%** = pure pre-tournament prior,
  **100%** = pure group-stage signal, intermediate values blend linearly. Default is
  40% pre / 60% post.
- Winners propagate automatically through each round; the predicted champion updates live.

## Data sources

All Elo ratings are from [footballratings.org](https://footballratings.org), which mirrors
[eloratings.net](https://eloratings.net) nightly. Two snapshots:

- **PRE** — each team's Elo after their last match before the tournament kicked off on
  11 June 2026 (read from individual team pages).
- **POST** — each team's Elo after all three group-stage matches, computed by applying the
  standard eloratings.net formula (K=60 for World Cup matches, goal-difference factor,
  no home advantage on neutral venues) to the actual group results, starting from PRE.

The Round of 32 pairings are the confirmed 2026 World Cup fixtures.

## Hosting

The bracket is a single self-contained `index.html` (no build step, no dependencies),
served via GitHub Pages and deployed by the GitHub Actions workflow in
`.github/workflows/deploy.yml`.
