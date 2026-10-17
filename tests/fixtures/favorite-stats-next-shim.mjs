export { NextRequest, NextResponse } from "next/server.js";
import { state } from "./favorite-stats-shim.mjs";
export function after(callback) { state.afters.push(callback); }
