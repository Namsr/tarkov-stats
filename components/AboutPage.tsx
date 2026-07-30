"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { PROJECT_LINKS } from "@/lib/support";

const CONTACTS = [
  { name: "GitHub", href: PROJECT_LINKS.github, detail: "about.contact.github" },
  { name: "Discord", href: PROJECT_LINKS.discord, detail: "about.contact.discord" },
  { name: "Twitch", href: PROJECT_LINKS.twitch, detail: "about.contact.twitch" },
  { name: "Email", href: PROJECT_LINKS.email, detail: "about.contact.email" },
] as const;

export default function AboutPage() {
  const { t } = useI18n();

  return (
    <main className="page-frame project-page">
      <header className="project-page__hero">
        <p className="page-kicker">{t("about.kicker")}</p>
        <h1 className="page-title">{t("about.title")}</h1>
        <p className="project-page__lead">{t("about.intro")}</p>
      </header>

      <section className="project-copy data-panel" aria-labelledby="about-project">
        <h2 id="about-project" className="section-heading">
          {t("about.projectTitle")}
        </h2>
        <p>{t("about.mission")}</p>
        <p>{t("about.source")}</p>
        <p>{t("about.openSource")}</p>
        <p>{t("about.independence")}</p>
      </section>

      <section aria-labelledby="about-contacts">
        <p className="section-kicker">{t("about.contactsKicker")}</p>
        <h2 id="about-contacts" className="section-heading project-section-title">
          {t("about.contactsTitle")}
        </h2>
        <div className="contact-grid">
          {CONTACTS.map((contact) => (
            <a
              key={contact.name}
              className="contact-card data-panel"
              href={contact.href}
              target={contact.href.startsWith("mailto:") ? undefined : "_blank"}
              rel={contact.href.startsWith("mailto:") ? undefined : "noopener noreferrer"}
            >
              <strong>{contact.name}</strong>
              <span>{t(contact.detail)}</span>
              <span aria-hidden>↗</span>
            </a>
          ))}
        </div>
      </section>

      <div className="project-cta data-panel">
        <div>
          <p className="section-kicker">{t("about.helpKicker")}</p>
          <h2 className="section-heading">{t("about.helpTitle")}</h2>
        </div>
        <div className="project-cta__actions">
          <Link className="tactical-button" href="/support">
            {t("about.supportCta")}
          </Link>
          <Link className="ghost-button" href="/community">
            {t("about.communityCta")}
          </Link>
        </div>
      </div>
    </main>
  );
}
