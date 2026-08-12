import type { ReactNode } from "react";

export default function ProfileHeader({
  kicker,
  title,
  meta,
  actions,
  children,
}: {
  kicker: string;
  title?: string;
  meta?: ReactNode;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id="overview" tabIndex={-1} className="profile-header surface profile-anchor-section">
      <div className="profile-header__top">
        <div className="profile-header__identity">
          <p className="page-kicker">{kicker}</p>
          {title ? <h1 className="page-title break-words">{title}</h1> : null}
          {meta}
        </div>
        <div className="profile-header__controls">
          <div className="profile-header__actions" aria-live="polite">
            {actions}
          </div>
        </div>
      </div>
      {children}
    </section>
  );
}
