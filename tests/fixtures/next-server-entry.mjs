// The standalone image traces these real Next.js classes but omits the public
// next/server.js export wrapper. Do not replace them with web API test doubles.
import request from "next/dist/server/web/spec-extension/request.js";
import response from "next/dist/server/web/spec-extension/response.js";

export const NextRequest = request.NextRequest;
export const NextResponse = response.NextResponse;
