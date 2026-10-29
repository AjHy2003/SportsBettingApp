# PickLab (SportsBettingApp)

A free, installable web app for daily picks, parlays and research on player props, spreads and totals.

**Live site:** https://ajhy2003.github.io/SportsBettingApp/

## What it does

- **🔥 Today's picks**: every morning the app scores every DraftKings game line and player prop for today's NBA and college basketball games and this week's NFL and college football games, then posts the plays with real edge (graded A/B/C).
- **Ticket builder**: pick a budget ($5, $10, $25, $50, $100 or custom), a sport (all, basketball only, football only, or one league) and straight bets / parlay / mix. It sizes each bet by edge and shows the payout, hit chance and model expectation.
- **Parlays**: build your own (tap **+** on any pick), use the model's best 2-5 leg parlay, or build a **same-game parlay** for any NBA, NFL, college football or college basketball game.
- **Track record**: every posted pick is logged and graded automatically after the game (W-L, units, by grade).
- **Phone notifications** every day around 11:45am ET (see setup below).
- **Research pages** for player props (game logs, hit rates, splits, matchup, projection), game lines, NFL advanced stats (targets, separation, catches by depth, designed runs vs scrambles, defense vs pass/run), NBA advanced stats (usage, rebound %, missed-shot rebound outlook, pace, defense vs position), NHL (shots, hits, blocks), racing simulations (F1, NASCAR, IndyCar), golf, tennis, UFC and a custom calculator for any other sport.

The probabilities are estimates from past data blended with the sportsbook's price. No model guarantees a result; parlays compound both the edge and the error.

## One-time setup

1. **Turn on the site:** Settings → Pages → Build and deployment → **Source: GitHub Actions**. Then Actions → *Build data, daily picks and deploy* → **Run workflow**.
2. **Phone notifications (optional, free):**
   1. Install the **ntfy** app (iOS / Android).
   2. Make up a long private topic name, e.g. `picklab-` followed by random letters.
   3. In the app tap **+** and subscribe to that topic.
   4. In this repo: Settings → Secrets and variables → Actions → **New repository secret**, name `NTFY_TOPIC`, value = your topic name.
   You'll get a notification each day at ~11:45am ET. To test now: Actions → Run workflow → tick *Send the phone notification*.
3. On your phone, open the site and use **Add to Home Screen** to install it like an app.

## How it runs

- Static site (plain HTML/CSS/JS, no build step) that calls ESPN's public JSON from the browser for live scores, game logs and DraftKings lines.
- `.github/workflows/deploy.yml` runs at ~5:20am, ~11:45am and ~5:15pm ET (and on every push to `main`):
  - `pipeline/` (Python) builds advanced data: NFL from nflverse + Next Gen Stats, NBA/NHL from box scores, NASCAR history.
  - `tools/daily-picks.mjs` (Node) scores every line and prop with the same model the site uses, writes today's picks, grades past picks, and keeps the history on the `picks-data` branch.
  - `tools/notify.mjs` sends the phone notification.
  - The site plus data is published to GitHub Pages.

## Local development

```bash
python -m http.server 8000                                        # serve the site
python pipeline/build.py --out data --cache cache --only nfl      # optional: advanced data
node tools/daily-picks.mjs --site . --history /tmp/history.json   # optional: picks (needs ESPN access)
```

## Data sources

ESPN public APIs (scores, game logs, DraftKings lines), [nflverse](https://github.com/nflverse/nflverse-data), [Jolpica-F1](https://github.com/jolpica/jolpica-f1), NASCAR's public results feed.
