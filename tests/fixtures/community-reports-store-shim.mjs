export const calls = { getCommunityReportsStore: 0, candidates: [] };

export async function getCommunityReportsStore() {
  calls.getCommunityReportsStore += 1;
  return {
    // An omitted aid is answered with a sentinel account, so a route that
    // queries without one shows what leaked in the response.
    reviews: async (aid) => [{ aid: aid ?? 999, reportCount: 1, yesCount: 0, noCount: 0, lastReportedAt: 1 }],
    // The identity each claim was served under, so a test can tell a reused
    // helper id from a silently re-minted one.
    candidates: async (helperId) => {
      calls.candidates.push(helperId);
      return [{ aid: 100, reportCount: 2, lastReportedAt: 1 }];
    },
  };
}
