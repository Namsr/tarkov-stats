import NotFoundPage from "@/components/NotFoundPage";
import { messagesFor } from "@/lib/i18n/dictionary";
import { resolveLang } from "@/lib/i18n/server";

export default async function NotFound() {
  const lang = await resolveLang();
  const messages = messagesFor(lang);
  return <NotFoundPage initialLang={lang} messages={{
    "notFound.title": messages["notFound.title"],
    "notFound.description": messages["notFound.description"],
    "common.back": messages["common.back"],
  }} />;
}
