import { LeaderboardLoading } from "@/components/LeaderboardPage";

export default function Loading() {
  return (
    <main className="page-frame leaderboard-page">
      <div className="h-5 w-20 skeleton rounded" />
      <div className="mt-8 h-12 w-72 skeleton rounded" />
      <div className="mt-7"><LeaderboardLoading /></div>
    </main>
  );
}
