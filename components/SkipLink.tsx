"use client";

import { useI18n } from "@/lib/i18n/context";

export default function SkipLink() {
  const { t } = useI18n();

  return (
    <a className="skip-link" href="#main-content">
      {t("nav.skip")}
    </a>
  );
}
