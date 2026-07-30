import { NextResponse } from "next/server";
import { getRegularProgressionAverage } from "@/lib/seasonal/progression-db";

export async function GET() {
  try {
    const result = await getRegularProgressionAverage();
    if (!result) {
      return NextResponse.json({ error: "PvP progression unavailable" }, { status: 503 });
    }
    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (error) {
    console.error("regular progression average failed", error);
    return NextResponse.json({ error: "Failed to query PvP progression" }, { status: 500 });
  }
}
