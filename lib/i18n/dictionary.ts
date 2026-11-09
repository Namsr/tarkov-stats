// One language-neutral source is shared by the legacy UI and Rust SSR/WASM.
import messages from "./messages.json" with { type: "json" };

export type Lang = "en" | "ru";
export type Dict = Record<string, string>;
export const dict: Record<Lang, Dict> = messages;
const russian = { ...dict.en, ...dict.ru };

export function messagesFor(lang: Lang): Dict {
  return lang === "en" ? dict.en : russian;
}
