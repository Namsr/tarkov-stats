import AxisLeaguePage from "@/components/AxisLeaguePage";

export default async function AxisLeagueRoute({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  return <AxisLeaguePage initialView={view === "history" || view === "profiles" ? view : "standings"} />;
}
