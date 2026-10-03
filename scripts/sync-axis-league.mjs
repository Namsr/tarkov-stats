import { AXIS_REFRESH_MS } from "../lib/axis-league.ts";
import { getAxisLeagueStore } from "../lib/admin/axis-league-db.ts";
import { refreshAxisLeague } from "../lib/axis-league-sync.ts";

async function sync() {
  try { await refreshAxisLeague(await getAxisLeagueStore()); }
  catch (error) { console.warn("AXIS League worker: " + error.message); }
}
await sync();
const timer = setInterval(() => void sync(), Math.min(30_000, AXIS_REFRESH_MS));
function stop() { clearInterval(timer); }
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
