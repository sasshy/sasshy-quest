import { useEffect, useState } from "react";
import { ACCENT_LABEL, ACCENT_UNLOCK, type Accent } from "./appearance";
import { haptic, playDone, playLevelUp } from "./feedback";
import type { Celebration } from "./progress";

const COLORS = ["var(--accent)", "#AFA9EC", "#EF9F27", "#5DCAA5"];

/** Full-screen burst when a task is completed; a bigger one on level up. */
export function Celebrate() {
  const [shot, setShot] = useState<(Celebration & { key: number }) | null>(null);
  useEffect(() => {
    const on = (event: Event) => {
      const detail = (event as CustomEvent<Celebration>).detail;
      if (!detail) return;
      setShot({ ...detail, key: Date.now() });
      if (detail.levelUp) {
        haptic("levelUp");
        playLevelUp();
      } else {
        haptic("success");
        playDone();
      }
    };
    window.addEventListener("sasshy-celebrate", on);
    return () => window.removeEventListener("sasshy-celebrate", on);
  }, []);
  useEffect(() => {
    if (!shot) return;
    const timer = window.setTimeout(() => setShot(null), shot.levelUp ? 2600 : 1300);
    return () => window.clearTimeout(timer);
  }, [shot]);
  if (!shot) return null;
  const unlocked = (Object.keys(ACCENT_UNLOCK) as Accent[]).find((a) => ACCENT_UNLOCK[a] === shot.level);
  return (
    <div className={`celebrate${shot.levelUp ? " level-up" : ""}`} key={shot.key} aria-live="polite">
      {Array.from({ length: shot.levelUp ? 28 : 16 }, (_, i) => {
        const angle = (Math.PI * 2 * i) / (shot.levelUp ? 28 : 16);
        const r = (shot.levelUp ? 150 : 100) + (i % 3) * 18;
        return (
          <i
            key={i}
            className="confetti"
            style={{
              background: COLORS[i % COLORS.length],
              ["--dx" as string]: `${Math.cos(angle) * r}px`,
              ["--dy" as string]: `${Math.sin(angle) * r}px`,
            }}
          />
        );
      })}
      {shot.levelUp ? (
        <div className="level-card">
          <small>LEVEL UP</small>
          <strong>Lv.{shot.level}</strong>
          {unlocked && <span>新しい色「{ACCENT_LABEL[unlocked]}」が使えるようになりました</span>}
        </div>
      ) : (
        <div className="check-pop">✓</div>
      )}
      <b className="xp-fly">+{shot.gainedXp} XP</b>
    </div>
  );
}
