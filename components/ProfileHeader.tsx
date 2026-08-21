import type { ReactNode } from "react";
import ProfileModeSwitch from "@/components/ProfileModeSwitch";
import type { GameMode } from "@/types/seasonal";

export default function ProfileHeader({
  aid,
  mode,
  seasonalCycleId,
  kicker,
  title,
  meta,
  actions,
  children,
}: {
  aid: number;
  mode: GameMode;
  seasonalCycleId?: string;
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
          <div className="profile-header__mode">
            <ProfileModeSwitch current={mode} page="player" aid={aid} seasonalCycleId={seasonalCycleId} />
          </div>
        </div>
      </div>
      {children}
    </section>
  );
}
