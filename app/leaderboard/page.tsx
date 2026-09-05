import { connection } from "next/server";
import LeaderboardPage from "@/components/LeaderboardPage";

export default async function LeaderboardRoute() {
  await connection();
  return <LeaderboardPage />;
}
