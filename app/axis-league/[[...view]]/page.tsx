import { notFound, redirect } from "next/navigation";
import AxisLeaguePage from "@/components/AxisLeaguePage";

export default async function AxisLeagueRoute({ params, searchParams }: {
  params: Promise<{ view?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { view } = await params;
  if (!view) {
    const query = await searchParams;
    const match = typeof query.match === "string" && /^[1-9]\d{0,8}$/.test(query.match);
    const tab = match ? "history" : query.view === "history" || query.view === "profiles" || query.view === "statistics" ? query.view : "leaderboard";
    const preserved = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (key === "view" || value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) preserved.append(key, item);
    }
    const search = preserved.size ? `?${preserved}` : "";
    redirect(`/axis-league/${tab}${search}`);
  }
  if (view.length !== 1 || !["leaderboard", "statistics", "history", "profiles"].includes(view[0])) notFound();
  return <AxisLeaguePage />;
}
