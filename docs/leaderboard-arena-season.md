# Arena ARP season change

Change an ARP season only after the user identifies the new season and the
upstream reset has been observed. The season ID changes the BlastGang ARP
scope. `LEADERBOARD_ARENA_ACTIVITY_CUTOFF_MS` changes eligibility for every
Arena mode. Arena counters remain cumulative, and PvP/PvE are unchanged.

1. Back up `players.db` and `leaderboards.db` with the existing database backup
   procedure.
2. Choose a new stable ID such as `2026-s2`. Set it in the runtime environment,
   keep confirmation false, and set the Arena cutoff to the expected reset time
   in Unix milliseconds:

   ```dotenv
   LEADERBOARD_ARP_SEASON_ID=2026-s2
   LEADERBOARD_ARP_SEASON_CONFIRMED=false
   LEADERBOARD_ARENA_ACTIVITY_CUTOFF_MS=<reset-time-unix-ms>
   ```

3. Recreate `web` so both routes and jobs read the new environment, then publish:

   ```bash
   docker compose -p tarkovstats -f docker-compose.vps.yml up -d --force-recreate web
   sudo systemctl start tarkovstats-leaderboard-materialize.service
   ```

   The new season ID selects a new SQLite scope. With confirmation false,
   BlastGang profiles have `season_unverified` status and cannot receive an ARP
   rank, so the old season cannot appear under the new ID.

4. Inspect fresh upstream profiles after the real reset. The payload exposes
   `BestArp` but no season identifier or reliable gameplay timestamp. A recent
   fetch alone does not prove that ARP reset. Confirm the value change itself.
5. After the reset is verified, move
   `LEADERBOARD_ARENA_ACTIVITY_CUTOFF_MS` forward to the verification time. Run
   the existing Arena profile sync so eligible profiles are fetched after that
   cutoff. This prevents snapshots captured before verification from carrying
   old BEST ARP into the new board.
6. Set `LEADERBOARD_ARP_SEASON_CONFIRMED=true`, recreate `web`, publish, and
   check the BlastGang endpoint before announcing the season:

   ```bash
   docker compose -p tarkovstats -f docker-compose.vps.yml up -d --force-recreate web
   sudo systemctl start tarkovstats-leaderboard-materialize.service
   docker compose -p tarkovstats -f docker-compose.vps.yml exec -T web node -e \
     'fetch("http://127.0.0.1:3000/api/leaderboard?mode=arena&arenaMode=blastGang&sort=primary").then(async r=>{if(!r.ok)throw new Error(await r.text());console.log(await r.text())})'
   ```

Do not delete or zero `arena_mode_stats`: K/D, kills per match, matches, and
overall Arena hours are cumulative by product decision. Old leaderboard
generations remain isolated under the prior season scope and are not selected
by routes configured for the new ID.
