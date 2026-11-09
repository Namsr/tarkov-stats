"use client";

import { createContext, useContext, useMemo } from "react";
import type { Dict, Lang } from "./dictionary";

type Vars = Record<string, string | number>;

interface I18nValue {
  lang: Lang;
  t: (key: string, vars?: Vars) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (_, key) => (key in vars ? String(vars[key]) : `{${key}}`));
}

export function LanguageProvider({ initialLang, messages, children }: {
  initialLang: Lang;
  messages: Dict;
  children: React.ReactNode;
}) {
  const value = useMemo<I18nValue>(() => ({
    lang: initialLang,
    t: (key, vars) => interpolate(messages[key] ?? key, vars),
  }), [initialLang, messages]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used within <LanguageProvider>");
  return context;
}

/** Next can render the root 404 without the layout's provider. Reuse it when present. */
export function LanguageBoundary({ initialLang, messages, children }: {
  initialLang: Lang;
  messages: Dict;
  children: React.ReactNode;
}) {
  const context = useContext(I18nContext);
  return context ? children : <LanguageProvider initialLang={initialLang} messages={messages}>{children}</LanguageProvider>;
}
