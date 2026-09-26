import type { NextRequest } from "next/server";
import { issueHelperSession } from "@/lib/seasonal/helper-api";

export const runtime = "nodejs";

export async function POST(request: NextRequest) { return issueHelperSession(request); }
