"use client";

import Image from "next/image";
import Link from "next/link";
import CopyButton from "@/components/CopyButton";
import { useI18n } from "@/lib/i18n/context";
import {
  BANK_CARD,
  CRYPTO_METHODS,
  DONATION_LINKS,
  PROJECT_LINKS,
} from "@/lib/support";

export default function SupportPage() {
  const { t } = useI18n();

  return (
    <main className="page-frame project-page">
      <header className="project-page__hero">
        <p className="page-kicker">{t("support.kicker")}</p>
        <h1 className="page-title">{t("support.title")}</h1>
        <p className="project-page__lead">{t("support.intro")}</p>
      </header>

      <section aria-labelledby="support-fast">
        <p className="section-kicker">{t("support.quickKicker")}</p>
        <h2 id="support-fast" className="section-heading project-section-title">
          {t("support.quickTitle")}
        </h2>
        <p className="project-section-copy">{t("support.quickDescription")}</p>
        <div className="donation-links">
          {DONATION_LINKS.map((method) => (
            <a
              key={method.name}
              className="tactical-button"
              href={method.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {method.name}
              <span aria-hidden>↗</span>
            </a>
          ))}
        </div>
      </section>

      <section className="bank-card data-panel" aria-labelledby="support-bank">
        <div>
          <p className="section-kicker">{t("support.bankKicker")}</p>
          <h2 id="support-bank" className="section-heading">
            {t("support.bankTitle")}
          </h2>
          <p className="bank-card__details">{BANK_CARD.details}</p>
        </div>
        <code>{BANK_CARD.number}</code>
        <CopyButton value={BANK_CARD.number} />
      </section>

      <section aria-labelledby="support-crypto">
        <p className="section-kicker">{t("support.cryptoKicker")}</p>
        <h2 id="support-crypto" className="section-heading project-section-title">
          {t("support.cryptoTitle")}
        </h2>
        <p className="project-section-copy">{t("support.cryptoDescription")}</p>
        <div className="crypto-grid">
          {CRYPTO_METHODS.map((method) => (
            <article
              key={`${method.asset}-${method.network}`}
              className="crypto-card data-panel"
            >
              <div className="crypto-card__head">
                <div>
                  <span className="section-kicker">{t("support.asset")}</span>
                  <h3>{method.asset}</h3>
                </div>
                <div>
                  <span>{t("support.network")}</span>
                  <strong>{method.network}</strong>
                </div>
              </div>
              <div className="crypto-card__body">
                <div className="crypto-card__qr">
                  <Image
                    src={method.qrSrc}
                    alt={t("support.qrAlt", {
                      asset: method.asset,
                      network: method.network,
                    })}
                    width={160}
                    height={160}
                  />
                </div>
                <div className="crypto-card__address">
                  <span>{t("support.address")}</span>
                  <code>{method.address}</code>
                  <CopyButton value={method.address} />
                </div>
              </div>
              <p className="crypto-card__warning">{t("support.networkWarning")}</p>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="support-other">
        <p className="section-kicker">{t("support.otherKicker")}</p>
        <h2 id="support-other" className="section-heading project-section-title">
          {t("support.otherTitle")}
        </h2>
        <p className="project-section-copy">{t("support.otherDescription")}</p>
        <div className="help-grid">
          <a
            className="help-card data-panel"
            href={PROJECT_LINKS.github}
            target="_blank"
            rel="noopener noreferrer"
          >
            <strong>GitHub</strong>
            <span>{t("support.help.github")}</span>
          </a>
          <a
            className="help-card data-panel"
            href={PROJECT_LINKS.discord}
            target="_blank"
            rel="noopener noreferrer"
          >
            <strong>Discord</strong>
            <span>{t("support.help.discord")}</span>
          </a>
          <div className="help-card data-panel">
            <strong>{t("support.help.shareTitle")}</strong>
            <span>{t("support.help.share")}</span>
          </div>
          <Link className="help-card data-panel" href="/community">
            <strong>{t("nav.community")}</strong>
            <span>{t("support.help.community")}</span>
          </Link>
        </div>
      </section>
    </main>
  );
}
