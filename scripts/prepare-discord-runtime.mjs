import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import nft from "next/dist/compiled/@vercel/nft/index.js";

/** Include the separate worker's runtime dependencies in Next's shared image. */
export async function prepareDiscordRuntime(target = ".next/standalone") {
  const root = process.cwd();
  const require = createRequire(import.meta.url);
  const { fileList } = await nft.nodeFileTrace([require.resolve("discord.js")], { base: root });
  for (const file of fileList) {
    const source = resolve(root, file);
    const fromRoot = relative(root, source);
    if (isAbsolute(fromRoot) || fromRoot.startsWith("..") || !file.replaceAll("\\", "/").startsWith("node_modules/")) {
      throw new Error("Discord runtime trace escaped node_modules");
    }
    const destination = resolve(target, fromRoot);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  return fileList.size;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await prepareDiscordRuntime();
}
