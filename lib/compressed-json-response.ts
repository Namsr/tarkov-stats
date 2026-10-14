import { brotliCompress, constants } from "node:zlib";

function prefersBrotli(header: string | null): boolean {
  if (!header) return false;
  const qualities = new Map<string, number>();
  for (const entry of header.split(",")) {
    const [coding, ...parameters] = entry.trim().toLowerCase().split(";");
    const q = parameters.find((parameter) => parameter.trim().startsWith("q="))?.trim().slice(2);
    const quality = q === undefined ? 1 : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q) ? Number(q) : 0;
    qualities.set(coding.trim(), quality);
  }
  const br = qualities.get("br") ?? qualities.get("*") ?? 0;
  const gzip = qualities.get("gzip") ?? qualities.get("*") ?? 0;
  return br > 0 && br >= gzip && br >= (qualities.get("identity") ?? 0);
}

/** Keep the JSON contract; gzip/identity clients retain proxy compression. */
export async function compressedJsonResponse(
  request: Request,
  value: unknown,
  responseHeaders: HeadersInit,
): Promise<Response> {
  const headers = new Headers(responseHeaders);
  headers.set("Content-Type", "application/json");
  const vary = headers.get("Vary")?.toLowerCase().split(",").map((value) => value.trim()) ?? [];
  if (!vary.includes("accept-encoding") && !vary.includes("*")) headers.append("Vary", "Accept-Encoding");
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) >= 8192 && prefersBrotli(request.headers.get("Accept-Encoding"))) {
    try {
      const input = Buffer.from(text);
      const compressed = await new Promise<Buffer>((resolve, reject) => brotliCompress(input, {
        params: {
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
          [constants.BROTLI_PARAM_QUALITY]: 4,
          [constants.BROTLI_PARAM_SIZE_HINT]: input.length,
        },
      }, (error, output) => error ? reject(error) : resolve(output)));
      headers.set("Content-Encoding", "br");
      headers.delete("Content-Length");
      return new Response(new Uint8Array(compressed), { headers });
    } catch {
      // A compressor failure must not discard a usable timeline response.
    }
  }
  return new Response(text, { headers });
}
