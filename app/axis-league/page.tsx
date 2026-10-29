import AxisLeaguePage from "@/components/AxisLeaguePage";

export default async function AxisLeagueRoute({ searchParams }: { searchParams: Promise<{ view?: string; match?: string }> }) {
  const { view, match } = await searchParams;
  const initialMatch = match && /^[1-9]\d{0,8}$/.test(match) ? Number(match) : undefined;
  return <AxisLeaguePage key={initialMatch ?? "all"} initialMatch={initialMatch} initialView={initialMatch ? "history" : view === "history" || view === "profiles" || view === "statistics" ? view : "standings"} />;
}
