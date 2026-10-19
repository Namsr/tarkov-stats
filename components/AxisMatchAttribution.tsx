"use client";

import { useI18n } from "@/lib/i18n/context";
import type { AxisMatchEdit } from "@/lib/axis-history";

export default function AxisMatchAttribution({ edited }: { edited?: AxisMatchEdit | null }) {
  const { t, lang } = useI18n();
  if (!edited) return null;
  return <p className="axis-match-attribution">
    {t("axis.history.editedBy", { name: edited.name ?? t("axis.history.unknownEditor") })}{" · "}
    <time dateTime={new Date(edited.at).toISOString()}>{new Date(edited.at).toLocaleString(lang === "ru" ? "ru-RU" : "en-US")}</time>
  </p>;
}
