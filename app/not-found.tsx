import NotFoundPage from "@/components/NotFoundPage";
import { resolveLang } from "@/lib/i18n/server";

export default async function NotFound() {
  return <NotFoundPage initialLang={await resolveLang()} />;
}
