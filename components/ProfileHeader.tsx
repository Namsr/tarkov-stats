import type { ReactNode } from "react";
import ProfileCompareButton from "@/components/ProfileCompareButton";
import LeaderboardRankLink from "@/components/LeaderboardRankLink";
import ProfileModeSwitch from "@/components/ProfileModeSwitch";
import ProfilePortrait from "@/components/ProfilePortrait";
import ProfilePrestige from "@/components/ProfilePrestige";
import type { ArenaModeKey, ArenaStoredMode } from "@/types/arena";
import type { GameMode } from "@/types/seasonal";

export default function ProfileHeader({
  aid,
  mode,
  seasonalCycleId,
  kicker,
  title,
  prestige,
  leaderboardArenaMode,
  comparisonArenaMode,
  leaderboardRevision,
  meta,
  actions,
  activity,
  children,
  portrait,
  hideLeaderboardRank = false,
}: {
  aid: number;
  mode: GameMode;
  seasonalCycleId?: string;
  kicker: string;
  title?: string;
  prestige?: number | null;
  leaderboardArenaMode?: ArenaModeKey;
  comparisonArenaMode?: ArenaStoredMode;
  leaderboardRevision?: string | number | null;
  meta?: ReactNode;
  actions: ReactNode;
  activity?: ReactNode;
  children: ReactNode;
  portrait?: ReactNode;
  hideLeaderboardRank?: boolean;
}) {
  const leaderboardMode = mode === "seasonal" ? "pvp-season" : mode;
  return (
    <section id="overview" tabIndex={-1} className="profile-header surface profile-anchor-section">
      <div className="profile-header__top">
        <div className="profile-header__person">
          {portrait ?? (title && (
            <ProfilePortrait
              key={`${mode}:${seasonalCycleId}:${aid}`}
              aid={aid}
              mode={mode}
              cycleId={seasonalCycleId}
              nickname={title}
            />
          ))}
          <div className="profile-header__identity">
            <p className="page-kicker">{kicker}</p>
            {title ? (
              <div className="profile-header__title-row">
                <div className="profile-header__name">
                  <h1 className="page-title break-words">{title}</h1>
                  <ProfilePrestige level={prestige} />
                </div>
                {!hideLeaderboardRank && <LeaderboardRankLink
                  aid={aid}
                  mode={leaderboardMode}
                  arenaMode={leaderboardArenaMode}
                  cycleId={seasonalCycleId}
                  revision={leaderboardRevision}
                />}
              </div>
            ) : null}
            {meta}
          </div>
        </div>
        <div className="profile-header__controls">
          <div className="profile-header__actions profile-actions flex-wrap" aria-live="polite">
            {actions}
            <ProfileCompareButton aid={aid} mode={mode} cycleId={seasonalCycleId} arenaMode={comparisonArenaMode} />
          </div>
        </div>
      </div>
      <div className="profile-header__bar">
        <div className="profile-header__mode">
          <ProfileModeSwitch current={mode} page="player" aid={aid} seasonalCycleId={seasonalCycleId} />
        </div>
        {activity}
      </div>
      {children}
    </section>
  );
}
