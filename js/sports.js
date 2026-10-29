// League + market configuration. `espn` is the ESPN sport/league path,
// `kind` picks the analyzer: team | race | golf | tennis | fight | custom.

export const LEAGUES = [
  { id: "nba", name: "NBA", group: "Basketball", espn: "basketball/nba", kind: "team", markets: "basketball", deep: "nba", icon: "🏀" },
  { id: "wnba", name: "WNBA", group: "Basketball", espn: "basketball/wnba", kind: "team", markets: "basketball", icon: "🏀" },
  { id: "ncaab", name: "College Basketball", group: "Basketball", espn: "basketball/mens-college-basketball", kind: "team", markets: "basketball", icon: "🏀" },
  { id: "ncaaw", name: "Women's College BB", group: "Basketball", espn: "basketball/womens-college-basketball", kind: "team", markets: "basketball", icon: "🏀" },
  { id: "nfl", name: "NFL", group: "Football", espn: "football/nfl", kind: "team", markets: "football", deep: "nfl", icon: "🏈" },
  { id: "ncaaf", name: "College Football", group: "Football", espn: "football/college-football", kind: "team", markets: "football", icon: "🏈" },
  { id: "mlb", name: "MLB", group: "Baseball", espn: "baseball/mlb", kind: "team", markets: "baseball", icon: "⚾" },
  { id: "nhl", name: "NHL", group: "Hockey", espn: "hockey/nhl", kind: "team", markets: "hockey", deep: "nhl", icon: "🏒" },
  { id: "epl", name: "Premier League", group: "Soccer", espn: "soccer/eng.1", kind: "team", markets: "soccer", icon: "⚽" },
  { id: "laliga", name: "La Liga", group: "Soccer", espn: "soccer/esp.1", kind: "team", markets: "soccer", icon: "⚽" },
  { id: "seriea", name: "Serie A", group: "Soccer", espn: "soccer/ita.1", kind: "team", markets: "soccer", icon: "⚽" },
  { id: "bundesliga", name: "Bundesliga", group: "Soccer", espn: "soccer/ger.1", kind: "team", markets: "soccer", icon: "⚽" },
  { id: "ligue1", name: "Ligue 1", group: "Soccer", espn: "soccer/fra.1", kind: "team", markets: "soccer", icon: "⚽" },
  { id: "ucl", name: "Champions League", group: "Soccer", espn: "soccer/uefa.champions", kind: "team", markets: "soccer", icon: "⚽" },
  { id: "mls", name: "MLS", group: "Soccer", espn: "soccer/usa.1", kind: "team", markets: "soccer", icon: "⚽" },
  { id: "ligamx", name: "Liga MX", group: "Soccer", espn: "soccer/mex.1", kind: "team", markets: "soccer", icon: "⚽" },
  { id: "f1", name: "Formula 1", group: "Racing", espn: "racing/f1", kind: "race", deep: "f1", icon: "🏎️" },
  { id: "nascar", name: "NASCAR Cup", group: "Racing", espn: "racing/nascar-premier", kind: "race", deep: "nascar", icon: "🏁" },
  { id: "indycar", name: "IndyCar", group: "Racing", espn: "racing/irl", kind: "race", icon: "🏁" },
  { id: "pga", name: "PGA Tour", group: "Golf", espn: "golf/pga", kind: "golf", icon: "⛳" },
  { id: "lpga", name: "LPGA", group: "Golf", espn: "golf/lpga", kind: "golf", icon: "⛳" },
  { id: "atp", name: "ATP Tennis", group: "Tennis", espn: "tennis/atp", kind: "tennis", icon: "🎾" },
  { id: "wta", name: "WTA Tennis", group: "Tennis", espn: "tennis/wta", kind: "tennis", icon: "🎾" },
  { id: "ufc", name: "UFC", group: "Combat", espn: "mma/ufc", kind: "fight", icon: "🥊" },
  { id: "custom", name: "Any sport (custom)", group: "Other", kind: "custom", icon: "🧮", blurb: "Boxing, cricket, swimming, darts, esports — type in recent results and get the same analysis." },
];

export const leagueById = (id) => LEAGUES.find((l) => l.id === id);

// dist: negbin for overdispersed counts, poisson for rare events, normal for
// yardage/points. perMinute scales by expected minutes.
const c = (key, label, stats, dist = "negbin", extra = {}) => ({ key, label, stats, dist, ...extra });

export const MARKETS = {
  basketball: [
    c("pts", "Points", ["pts"], "normal", { perMinute: true, oppEl: 1 }),
    c("reb", "Rebounds", ["reb"], "negbin", { perMinute: true }),
    c("ast", "Assists", ["ast"], "negbin", { perMinute: true, oppEl: 0.5 }),
    c("fg3m", "3-Pointers Made", ["fg3m"], "negbin", { perMinute: true, oppEl: 0.9 }),
    c("pra", "Pts + Reb + Ast", ["pts", "reb", "ast"], "normal", { perMinute: true, oppEl: 0.7 }),
    c("pr", "Pts + Reb", ["pts", "reb"], "normal", { perMinute: true, oppEl: 0.8 }),
    c("pa", "Pts + Ast", ["pts", "ast"], "normal", { perMinute: true, oppEl: 0.9 }),
    c("ra", "Reb + Ast", ["reb", "ast"], "negbin", { perMinute: true }),
    c("stl", "Steals", ["stl"], "poisson", { perMinute: true }),
    c("blk", "Blocks", ["blk"], "poisson", { perMinute: true }),
    c("sb", "Steals + Blocks", ["stl", "blk"], "negbin", { perMinute: true }),
    c("tov", "Turnovers", ["tov"], "negbin", { perMinute: true }),
    c("fgm", "Field Goals Made", ["fgm"], "negbin", { perMinute: true, oppEl: 0.9 }),
    c("fga", "Field Goal Attempts", ["fga"], "negbin", { perMinute: true, oppEl: 0.6 }),
    c("ftm", "Free Throws Made", ["ftm"], "negbin", { perMinute: true, oppEl: 0.8 }),
    c("fg3a", "3-Point Attempts", ["fg3a"], "negbin", { perMinute: true, oppEl: 0.5 }),
    c("min", "Minutes", ["min"], "normal"),
  ],
  football: [
    c("pass_yds", "Passing Yards", ["pass_yds"], "normal"),
    c("pass_att", "Pass Attempts", ["pass_att"], "normal"),
    c("pass_cmp", "Completions", ["pass_cmp"], "normal"),
    c("pass_td", "Passing TDs", ["pass_td"], "poisson"),
    c("pass_int", "Interceptions", ["pass_int"], "poisson"),
    c("rush_yds", "Rushing Yards", ["rush_yds"], "normal"),
    c("rush_att", "Rush Attempts", ["rush_att"], "negbin"),
    c("rec", "Receptions", ["rec"], "negbin"),
    c("rec_yds", "Receiving Yards", ["rec_yds"], "normal"),
    c("tgt", "Targets", ["tgt"], "negbin"),
    c("long_rec", "Longest Reception", ["long_rec"], "normal"),
    c("long_rush", "Longest Rush", ["long_rush"], "normal"),
    c("rush_rec_yds", "Rush + Rec Yards", ["rush_yds", "rec_yds"], "normal"),
    c("pass_rush_yds", "Pass + Rush Yards", ["pass_yds", "rush_yds"], "normal"),
    c("any_td", "Total TDs (rush + rec)", ["rush_td", "rec_td"], "poisson"),
    c("tackles", "Tackles + Assists", ["tackles"], "negbin"),
    c("sacks", "Sacks (defender)", ["def_sacks"], "poisson"),
  ],
  baseball: [
    c("h", "Hits", ["h"], "poisson", { oppEl: 0.5 }),
    c("tb", "Total Bases", ["tb"], "negbin", { oppEl: 0.6 }),
    c("hrr", "Hits + Runs + RBIs", ["h", "r", "rbi"], "negbin", { oppEl: 0.7 }),
    c("hr", "Home Runs", ["hr"], "poisson", { oppEl: 0.6 }),
    c("rbi", "RBIs", ["rbi"], "negbin", { oppEl: 0.7 }),
    c("r", "Runs", ["r"], "poisson", { oppEl: 0.7 }),
    c("bb", "Walks (batter)", ["bb"], "poisson"),
    c("so", "Strikeouts (batter)", ["so"], "poisson"),
    c("sb", "Stolen Bases", ["sb"], "poisson"),
    c("k", "Pitcher Strikeouts", ["k"], "negbin", { pitcher: true }),
    c("outs", "Pitcher Outs Recorded", ["outs"], "normal", { pitcher: true }),
    c("p_h", "Hits Allowed", ["p_h"], "negbin", { oppEl: 0.6, oppSide: "off", pitcher: true }),
    c("er", "Earned Runs Allowed", ["er"], "negbin", { oppEl: 0.9, oppSide: "off", pitcher: true }),
    c("p_bb", "Walks Allowed", ["p_bb"], "poisson", { oppEl: 0.3, oppSide: "off", pitcher: true }),
    c("pitches", "Pitch Count", ["pitches"], "normal", { pitcher: true }),
  ],
  hockey: [
    c("sog", "Shots on Goal", ["sog"], "negbin", { perMinute: true }),
    c("pts", "Points", ["pts"], "poisson", { perMinute: true, oppEl: 0.9 }),
    c("g", "Goals", ["g"], "poisson", { perMinute: true, oppEl: 0.9 }),
    c("a", "Assists", ["a"], "poisson", { perMinute: true, oppEl: 0.8 }),
    c("blk", "Blocked Shots", ["blk"], "negbin", { perMinute: true }),
    c("hits", "Hits", ["hits"], "negbin", { perMinute: true }),
    c("saves", "Goalie Saves", ["saves"], "normal", { goalie: true }),
    c("ga", "Goals Against (goalie)", ["ga"], "poisson", { goalie: true }),
    c("toi", "Time on Ice (min)", ["min"], "normal"),
  ],
  soccer: [
    c("shots", "Shots", ["shots"], "negbin", { oppEl: 0.4 }),
    c("sot", "Shots on Target", ["sot"], "poisson", { oppEl: 0.6 }),
    c("g", "Goals", ["g"], "poisson", { oppEl: 0.9 }),
    c("a", "Assists", ["a"], "poisson", { oppEl: 0.8 }),
    c("ga", "Goals + Assists", ["g", "a"], "poisson", { oppEl: 0.9 }),
    c("fouls", "Fouls Committed", ["fouls"], "poisson"),
    c("saves", "Goalie Saves", ["saves"], "negbin", { goalie: true }),
  ],
};

// Team-level stats the game analyzer compares, per market family.
export const GAME_STAT_LABEL = {
  basketball: "points", football: "points", baseball: "runs", hockey: "goals", soccer: "goals",
};

export const SEASON_HINT = {
  basketball: "Basketball", football: "Football",
};
