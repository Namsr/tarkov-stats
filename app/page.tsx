import { connection } from "next/server";
import HomePage from "@/components/HomePage";
import { isCommunityHelperEnabled } from "@/lib/seasonal/config";

export default async function Home() {
  await connection();
  return <HomePage helperEnabled={isCommunityHelperEnabled()} />;
}
