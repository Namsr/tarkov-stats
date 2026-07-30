import { connection } from "next/server";
import CommunityPage from "@/components/CommunityPage";
import {
  isCommunityHelperEnabled,
  isCommunityReviewEnabled,
} from "@/lib/seasonal/config";

export default async function Page() {
  await connection();

  return (
    <CommunityPage
      helperEnabled={isCommunityHelperEnabled()}
      reviewEnabled={isCommunityReviewEnabled()}
    />
  );
}
