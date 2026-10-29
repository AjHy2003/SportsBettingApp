# PickLab (SportsBettingApp)

A free, installable web app for daily picks, parlays and research on player props, spreads and totals.

**Live site:** https://ajhy2003.github.io/SportsBettingApp/

## What it does

- **🔥 Today's picks**: every morning the app scores every DraftKings game line and player prop for today's NBA, college basketball and NHL games and this week's NFL and college football games, then posts the plays with real edge (graded A/B/C).
- **Ticket builder**: pick a budget ($5, $10, $25, $50, $100 or custom), a sport (all, basketball only, football only, or one league) and straight bets / parlay / mix. It sizes each bet by edge and shows the payout, hit chance and model expectation.
- **Parlays**: build your own (tap **+** on any pick), use the model's best 2-5 leg parlay, or build a **same-game parlay** for any NBA, NFL, college football or college basketball game.
- **Game-day context**: prop projections adjust for the Vegas game environment (each team's implied points from the spread and total, NFL game script, NBA blowout minutes) and for tonight's injury report. When a teammate is out, the model checks how the player produced in past games without that teammate.
- **Injury-aware picks**: players listed out are dropped; questionable players are capped at grade C and kept off auto-built tickets. An hourly check sends a phone alert if a posted pick's player is ruled out.
- **Place it at your book**: every pick, ticket, parlay and moonshot has buttons for DraftKings, FanDuel, BetMGM, Caesars, Fanatics, BetRivers and bet365 (choose yours and your state under ⚙ My books). DraftKings game-line buttons (＋) open DraftKings with that exact bet in your slip; props open the game on DraftKings. With `ODDS_API_KEY` set, other books' game lines get bet-slip links too. 📋 Copy / Share gives you the whole slip as text. You place the bet in the book's own app; PickLab never touches your account.
- **🚀 Moonshot**: pick a bet ($1–$20) and a payout ($1k–$50k) and it builds the long-shot parlay with the best chance of getting there, from the model's best legs, underdogs and DraftKings alt lines (30+ points at +300 and so on). It shows the real odds: an honest estimate (each leg's model edge is cut in half, because big edges are usually overstated) next to the book's price. A daily $10 → $10,000 moonshot is in the notification. It's a lottery ticket: almost always a loss.
- **📡 Live bet tracker** (★ My bets): save a ticket from Today (★ Save all / ★ Save parlay) or any pick, and during the games every leg updates every 30 seconds: score and clock, the stat so far, what it still needs and the pace, plus parlay status ("2 of 3 won, 1 live"). Finished legs and tickets settle themselves, and a red dot on ★ My bets shows when a game you're on is live.
- **🪜 Alt-line ladder**: every player page shows the model's chance and fair odds at each alt line (15+, 20+, 25+ …) next to DraftKings' milestone prices, with ✓ where the model beats the price. Tap a row to analyze that line.
- **🌬️ Weather for football**: the kickoff forecast for every outdoor NFL and college game (wind, gusts, rain, snow, cold) lowers projected scoring and passing and nudges rushing up, on game lines and player props.
- **Track record**: every posted pick is logged and graded automatically after the game (W-L, units, by grade), plus **closing line value** (did the line move toward the pick before the game?) and a **calibration** table (do 60% picks win about 60% of the time?).
- **Line shopping (optional)**: with a free The Odds API key, game lines are checked against every major US sportsbook. The model blends with the all-book consensus and each pick shows a better price when one exists.
- **📰 News & highlights**: game highlight packages for every finished game from last night and today (this week and last week for football), playable right in the app with a ▶ Play all reel; top stories, video analysis and recaps for NBA, NFL, college football and basketball, NHL, MLB and soccer. Game pages show that game's highlights and recap/preview, player pages show the player's latest news, and each pick on the Today page links the latest story about that player or team.
- **Phone notifications** every day around 11:45am ET (see setup below), with the day's moonshot, top NBA and NFL headlines, and on Mondays last week's report card.
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
   The same topic gets injury alerts (hourly, noon to 11pm ET) when a posted pick's player is ruled out.
3. **Line shopping (optional, free):** sign up at [the-odds-api.com](https://the-odds-api.com) (free plan, 500 requests/month), then add a repository secret named `ODDS_API_KEY` with your key. The app pulls all-book prices once a day (about 12 requests), well inside the free plan.
4. On your phone, open the site and use **Add to Home Screen** to install it like an app.

## How it runs

- Static site (plain HTML/CSS/JS, no build step) that calls ESPN's public JSON from the browser for live scores, game logs and DraftKings lines.
- `.github/workflows/deploy.yml` runs at ~5:20am, ~11:45am and ~5:15pm ET (and on every push to `main`):
  - `pipeline/` (Python) builds advanced data: NFL from nflverse + Next Gen Stats, NBA/NHL from box scores, NASCAR history.
  - `tools/daily-picks.mjs` (Node) scores every line and prop with the same model the site uses, writes today's picks, grades past picks, and keeps the history on the `picks-data` branch.
  - `tools/notify.mjs` sends the phone notification.
  - `tools/books.mjs` pulls all-book prices when `ODDS_API_KEY` is set.
  - The site plus data is published to GitHub Pages.
- `.github/workflows/watch.yml` runs hourly in the afternoon and evening: `tools/watch.mjs` checks injury reports for pending picks and sends alerts.

## Local development

```bash
python -m http.server 8000                                        # serve the site
python pipeline/build.py --out data --cache cache --only nfl      # optional: advanced data
node tools/daily-picks.mjs --site . --history /tmp/history.json   # optional: picks (needs ESPN access)
```

## Data sources

ESPN public APIs (scores, live box scores, game logs, injuries, news, highlight video, DraftKings lines), [Open-Meteo](https://open-meteo.com) (weather), [The Odds API](https://the-odds-api.com) (optional), [nflverse](https://github.com/nflverse/nflverse-data), [Jolpica-F1](https://github.com/jolpica/jolpica-f1), NASCAR's public results feed.
