export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
  const target = new URL(`../${specifier.slice(2)}`, import.meta.url);
  for (const suffix of [".ts", ".tsx", "/index.ts"]) {
    try {
      return await nextResolve(`${target.href}${suffix}`, context);
    } catch {
      // Try the next source extension.
    }
  }
  return nextResolve(target.href, context);
}
