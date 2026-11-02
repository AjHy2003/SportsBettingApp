// Temporary: copy the deployed picks file for local testing.
import fs from "node:fs";
const t = await (await fetch("https://ajhy2003.github.io/SportsBettingApp/data/picks/today.json", { cache: "no-store" })).text();
fs.mkdirSync("probe-out", { recursive: true });
fs.writeFileSync("probe-out/today.json", t);
console.log("bytes", t.length);
