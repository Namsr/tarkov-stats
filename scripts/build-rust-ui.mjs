// Build tooling only: the shipped page/server/client application is Rust.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--prebuilt")) {
  throw new Error("Usage: node scripts/build-rust-ui.mjs [--prebuilt DIRECTORY_WITH_ARENA_AND_PERSISTENT_OUTPUTS]");
}
const wasmRoot = args.length ? resolve(args[1]) : join(root, ".codex-local", "rust-ui-wasm");
const pages = [
  { name: "arena", feature: "hydrate", styles: ["app/globals.css"] },
  { name: "persistent", feature: "hydrate-persistent", styles: ["app/globals.css", "components/arena-profile.css"] },
];
async function run(executable, command) {
  const child = spawn(executable, command, { cwd: root, stdio: "inherit", windowsHide: true });
  await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? done() : reject(new Error(`${executable} failed (${signal ?? code})`)));
  });
}
for (const page of pages) {
  const wasmDir = join(wasmRoot, page.name);
  if (!args.length) {
    await run("cargo", ["build", "--locked", "--release", "--manifest-path", "rust/ui/Cargo.toml", "--target", "wasm32-unknown-unknown", "--features", page.feature]);
    await mkdir(wasmDir, { recursive: true });
    await run(process.env.WASM_BINDGEN_BIN || "wasm-bindgen", ["rust/ui/target/wasm32-unknown-unknown/release/tarkov_ui.wasm", "--target", "web", "--no-typescript", "--out-name", "tarkov_ui", "--out-dir", wasmDir]);
  }
  const styles = [];
  for (const path of page.styles) {
    const from = join(root, path);
    const processed = await postcss([tailwind({ base: root, optimize: { minify: true } })])
      .process(await readFile(from, "utf8"), { from, map: false });
    styles.push(processed.css);
  }
  const files = new Map([
    ["tarkov_ui.js", await readFile(join(wasmDir, "tarkov_ui.js"))],
    ["tarkov_ui_bg.wasm", await readFile(join(wasmDir, "tarkov_ui_bg.wasm"))],
    ["tarkov_ui.css", Buffer.from(styles.join("\n"))],
  ]);
  const roots = [...files.get("tarkov_ui.js").toString("utf8").matchAll(/export function (ArenaApp|PersistentApp)_[0-9]+\(/g)].map(match => match[1]);
  const expectedRoot = page.name === "arena" ? "ArenaApp" : "PersistentApp";
  if (roots.length !== 1 || roots[0] !== expectedRoot) throw new Error(`Invalid ${page.name} hydration roots: ${roots.join(",")}`);
  const wasm = files.get("tarkov_ui_bg.wasm");
  if (wasm.length <= 8 || !wasm.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) throw new Error(`Invalid ${page.name} UI WebAssembly output`);
  const digest = createHash("sha256");
  for (const [name, body] of files) digest.update(name).update("\0").update(String(body.length)).update("\0").update(body);
  const hash = digest.digest("hex");
  const assetRoot = join(root, "public/_rust", page.name);
  const output = join(assetRoot, hash);
  await mkdir(output, { recursive: true });
  const manifest = { version: 1, hash, files: {} };
  for (const [name, body] of files) {
    await writeFile(join(output, name), body);
    manifest.files[name] = { bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
  }
  // Fixed allowlist plus content hash lets Rust and a rollback Next image
  // serve these immutable assets without runtime compilation or source access.
  await writeFile(join(assetRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ event: "rust_ui_assets_built", page: page.name, ...manifest }));
}
