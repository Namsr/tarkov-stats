import type { NextRequest } from "next/server";
import { verifyTask } from "@/lib/seasonal/helper-api";

export const runtime = "nodejs";

export async function POST(request: NextRequest) { return verifyTask(request); }
