// One language-neutral source is shared by the legacy UI and Rust SSR/WASM.
import messages from "./messages.json" with { type: "json" };

export type Lang = "en" | "ru";
export const LANGS: Lang[] = ["en", "ru"];
type Dict = Record<string, string>;
export const dict: Record<Lang, Dict> = messages;
