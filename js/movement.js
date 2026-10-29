// Line movement since the open: which way the market moved relative to a pick.
// Money on a side pushes its line (or price) the other way, so a move "toward" a pick
// means the market has come around to it; a big move "against" usually means news or
// sharp money the stats don't see. No DOM.
import { impliedProb, fmtOdds } from "./model.js";

const fmtLine = (x) => (x > 0 ? `+${x}` : `${x}`);
const result = (toward, size, strong, text) => (size > 0 ? { toward, against: !toward, size, strong, text } : null);

// Player prop: side OVER/UNDER; cur/open = { line, over, under } (DraftKings).
export function propMove(side, cur, open) {
  if (!cur || open?.line == null) return null;
  const over = side === "OVER";
  if (open.line !== cur.line) {
    const d = cur.line - open.line; // up = money on the over
    const size = Math.abs(d);
    return result(over ? d > 0 : d < 0, size, size >= Math.max(1, 0.08 * Math.abs(cur.line)), `opened ${open.line}, now ${cur.line}`);
  }
  const was = over ? open.over : open.under, now = over ? cur.over : cur.under;
  if (was == null || now == null) return null;
  const dp = impliedProb(now) - impliedProb(was); // shorter price = money on this side
  return result(dp > 0, Math.abs(dp) >= 0.005 ? Math.abs(dp) : 0, Math.abs(dp) >= 0.05, `price ${fmtOdds(was)} → ${fmtOdds(now)}`);
}

// Game line: kind spread|total|ml, side HOME|AWAY|OVER|UNDER; cur/open from pickcenterOdds().
export function gameMove(kind, side, cur, open) {
  if (!cur || !open) return null;
  if (kind === "spread" && cur.spreadHome != null && open.spreadHome != null) {
    const d = cur.spreadHome - open.spreadHome; // up = home less favored = money on the away side
    const size = Math.abs(d);
    return result(side === "HOME" ? d < 0 : d > 0, size, size >= 1.5, `home opened ${fmtLine(open.spreadHome)}, now ${fmtLine(cur.spreadHome)}`);
  }
  if (kind === "total" && cur.total != null && open.total != null) {
    const d = cur.total - open.total; // up = money on the over
    const size = Math.abs(d);
    return result(side === "OVER" ? d > 0 : d < 0, size, size >= Math.max(1.5, 0.02 * cur.total), `total opened ${open.total}, now ${cur.total}`);
  }
  if (kind === "ml") {
    const was = side === "HOME" ? open.mlHome : open.mlAway, now = side === "HOME" ? cur.mlHome : cur.mlAway;
    if (was == null || now == null) return null;
    const dp = impliedProb(now) - impliedProb(was);
    return result(dp > 0, Math.abs(dp) >= 0.01 ? Math.abs(dp) : 0, Math.abs(dp) >= 0.05, `opened ${fmtOdds(was)}, now ${fmtOdds(now)}`);
  }
  return null;
}

// Short label for a pick row.
export const moveText = (m) => (m ? `${m.toward ? "📈" : "📉"} ${m.text} · ${m.toward ? "market moving your way" : m.strong ? "market moving hard against this" : "moving against"}` : "");
