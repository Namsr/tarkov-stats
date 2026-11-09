import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { NextRequest } from "next/server.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const clientModules = ["/lib/i18n/context.tsx", "/components/NotFoundPage.tsx", "/components/LanguageToggle.tsx"];
const requestModule = "data:text/javascript,let state;export const setRequest=(value)=>{state=value};export const headers=async()=>state.headers;export const cookies=async()=>new Map([['lang',{value:state.lang}]])";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/link" && context.parentURL?.endsWith("/components/NotFoundPage.tsx")) {
      return { shortCircuit: true, url: "data:text/javascript,import {createElement} from 'react'; export default function Link(props){return createElement('a',props)}" };
    }
    if (specifier === "next/navigation" && context.parentURL?.endsWith("/components/LanguageToggle.tsx")) {
      return { shortCircuit: true, url: "data:text/javascript,export const usePathname=()=>'/compare';export const useSearchParams=()=>new URLSearchParams('a=42')" };
    }
    if (specifier === "@/lib/i18n/context") {
      return { shortCircuit: true, url: pathToFileURL(realpathSync(resolve("lib/i18n/context.tsx"))).href };
    }
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier === "next/headers" && context.parentURL?.endsWith("/lib/i18n/server.ts")) {
      return { shortCircuit: true, url: requestModule };
    }
    if (specifier === "react" && context.parentURL?.startsWith("data:")) return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (clientModules.some((name) => url.endsWith(name))) {
      const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      }).outputText;
      return { shortCircuit: true, format: "module", source };
    }
    return nextLoad(url, context);
  },
});

test("404 uses the requested language without a layout and inherits an existing provider", async () => {
  const { default: NotFoundPage } = await import("../components/NotFoundPage.tsx");
  const { LanguageProvider, useI18n } = await import("../lib/i18n/context.tsx");
  const { dict, messagesFor } = await import("../lib/i18n/dictionary.ts");
  for (const lang of ["ru", "en"]) {
    const html = renderToStaticMarkup(createElement(NotFoundPage, { initialLang: lang, messages: messagesFor(lang) }));
    assert.ok(html.includes(dict[lang]["notFound.title"]));
    assert.ok(html.includes(dict[lang]["notFound.description"]));
    assert.ok(html.includes('href="/"'));
  }
  const html = renderToStaticMarkup(createElement(LanguageProvider, { initialLang: "ru", messages: messagesFor("ru") },
    createElement(NotFoundPage, { initialLang: "en", messages: messagesFor("en") })));
  assert.ok(html.includes(dict.ru["notFound.title"]));
  assert.throws(() => renderToStaticMarkup(createElement(function MissingProvider() { useI18n(); return null; })), /LanguageProvider/);
});

test("both language options are document links and only the current locale supplies the messages", async () => {
  const { default: LanguageToggle } = await import("../components/LanguageToggle.tsx");
  const { LanguageProvider } = await import("../lib/i18n/context.tsx");
  const { dict, messagesFor } = await import("../lib/i18n/dictionary.ts");
  for (const lang of ["en", "ru"]) {
    const messages = messagesFor(lang);
    const other = lang === "en" ? "ru" : "en";
    assert.equal(messages["meta.title"], dict[lang]["meta.title"]);
    assert.equal(messages["meta.description"], dict[lang]["meta.description"]);
    assert.ok(!JSON.stringify(messages).includes(dict[other]["meta.title"]));
    const html = renderToStaticMarkup(createElement(LanguageProvider, { initialLang: lang, messages }, createElement(LanguageToggle)));
    assert.ok(html.includes('href="/api/language?lang=en&amp;returnTo=%2Fcompare%3Fa%3D42"'));
    assert.ok(html.includes('href="/api/language?lang=ru&amp;returnTo=%2Fcompare%3Fa%3D42"'));
    assert.match(html, new RegExp(`hrefLang="${lang}" aria-current="true"`, "i"));
  }
});

test("language link persists the locale and redirects only to a local document", async () => {
  const { GET } = await import("../app/api/language/route.ts");
  const host = "tarkov.example";
  const target = "/population/arena?mode=teamfight#arena-filters";
  function request(query, referer) {
    return new NextRequest(`https://${host}/api/language?${new URLSearchParams(query)}`, {
      headers: { host, ...(referer ? { referer } : {}) },
    });
  }

  const result = GET(request({ lang: "ru", returnTo: target }));
  assert.equal(result.status, 303);
  assert.equal(result.headers.get("location"), target);
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.match(result.headers.get("set-cookie"), /^lang=ru; Path=\/;.*SameSite=lax/i);
  assert.equal(GET(request({ lang: "en" }, `https://${host}/compare?a=123`)).headers.get("location"), "/compare?a=123");
  for (const returnTo of ["//evil.example", "/\\evil.example", "/a/..//evil.example", "https://evil.example", "/api/language?lang=en"]) {
    assert.equal(GET(request({ lang: "en", returnTo }, "https://evil.example/path")).headers.get("location"), "/");
  }
  assert.equal(GET(request({ lang: "invalid" })).status, 400);
});

test("public domains supply their language default until the visitor picks a language", async () => {
  const { setRequest } = await import(requestModule);
  const { resolveLang } = await import("../lib/i18n/server.ts");
  for (const [host, accept, lang, expected] of [
    ["tarkovstats.online", "ru-RU", undefined, "en"],
    ["WWW.TARKOVSTATS.RU:443", "en-US", undefined, "ru"],
    ["tarkovstats.online", "en-US", "ru", "ru"],
    ["tarkovstats.ru", "ru-RU", "en", "en"],
    ["localhost", "ru-RU", undefined, "ru"],
  ]) {
    setRequest({ headers: new Headers({ host, "accept-language": accept }), lang });
    assert.equal(await resolveLang(), expected, host);
  }
});
