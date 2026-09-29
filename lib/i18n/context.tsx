"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { dict, type Lang } from "./dictionary";

type Vars = Record<string, string | number>;

interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  toggle: () => void;
  /** Translate a key for the active language; falls back to en, then the key.
   *  Supports `{name}` placeholders via the optional `vars` map. */
  t: (key: string, vars?: Vars) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export function LanguageProvider({
  initialLang,
  children,
}: {
  initialLang: Lang;
  children: React.ReactNode;
}) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    // Persist for SSR (read in the root layout) and future visits.
    document.cookie = `lang=${l}; path=/; max-age=31536000; SameSite=Lax`;
    document.documentElement.lang = l;
    // The root layout renders these same two keys into <title> and the description
    // meta, and nothing else in the app sets either, so after a switch the head is
    // the last thing still showing the previous language. Written here rather than
    // via router.refresh(), which would re-fetch the whole RSC payload for a two-word
    // change — the refetch that #205 and #225 removed from every language switch.
    document.title = dict[l]["meta.title"];
    document.querySelector('meta[name="description"]')?.setAttribute("content", dict[l]["meta.description"]);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      lang,
      setLang,
      toggle: () => setLang(lang === "en" ? "ru" : "en"),
      t: (key, vars) => interpolate(dict[lang][key] ?? dict.en[key] ?? key, vars),
    }),
    [lang, setLang]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within <LanguageProvider>");
  return ctx;
}
