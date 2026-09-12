import { NextResponse } from "next/server";
import { getShowcaseStore } from "@/lib/admin/showcase-db";

export const runtime = "nodejs";

export async function GET() {
  try {
    const store = await getShowcaseStore();
    if (!store) return NextResponse.json({ groupId: null, groupName: null, aids: [], items: [], updatedAt: null });
    const config = store.getActive();
    return NextResponse.json(config, {
      headers: { "Cache-Control": "public, max-age=30, s-maxage=60" },
    });
  } catch (error) {
    console.warn("home showcase read failed", error);
    return NextResponse.json({ groupId: null, groupName: null, aids: [], items: [], updatedAt: null });
  }
}
