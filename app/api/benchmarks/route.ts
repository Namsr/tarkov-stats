import { NextResponse } from "next/server";
import benchmarks from "@/data/benchmarks.json";

export async function GET() {
  return NextResponse.json(benchmarks, {
    headers: {
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
