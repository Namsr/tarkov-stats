export const state = globalThis[Symbol.for("test.favorite-stats")] ??= { favorites: [], snapshots: new Map(), stored: new Map(), arenas: new Map(), calls: [], captures: [], afters: [], levelsCalls: 0 };
export const getSession = async () => state.user === null ? null : ({ sub: "stats-owner" });
export const getFavoritesStore = async () => ({
  list: async (sub) => { state.listSub = sub; return state.favorites; },
  updateNickname: async (...args) => { state.nicknameUpdates.push(args); },
});
export const getProgressionStore = async (mode) => ({ latest: async (aid) => state.snapshots.get(`${mode}:${aid}`) ?? null });
export const getStore = async (mode = "regular") => ({ stored: async (aid) => state.stored.get(`${mode}:${aid}`) ?? null });
export const getArenaProfile = async (aid) => state.arenas.get(aid) ?? null;
export const persistArenaProfile = async (profile) => { state.arenas.set(profile.aid, profile.arena); };
export const getPlayerLevels = async () => { state.levelsCalls++; return state.levels ? state.levels() : []; };
export const getPublicProfile = async (aid, options) => { state.calls.push({ aid, options }); return state.fetch(aid, options); };
export const parseProfileStats = (profile) => profile.stats;
export const makePlayerSnapshot = (aid, stats, achievementIds, upstreamUpdatedAt) => {
  if (state.snapshotError) throw new Error("Missing upstream version");
  return { aid, stats, achievementIds, upstreamUpdatedAt };
};
export const persistRegularProfileSnapshot = async (snapshot, options) => { state.captures.push({ snapshot, options }); await state.persist?.(snapshot); };
