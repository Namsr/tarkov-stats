import { connection } from "next/server";
import HomePage from "@/components/HomePage";
import { isCommunityHelperEnabled, isCommunityReviewEnabled } from "@/lib/seasonal/config";

export default async function Home() {
  await connection();
  const seasonalHelperEnabled = isCommunityHelperEnabled();
  const reviewEnabled = isCommunityReviewEnabled();
  return <HomePage seasonalHelperEnabled={seasonalHelperEnabled} reviewEnabled={reviewEnabled} />;
}
