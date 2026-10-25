import { useEffect, useState } from "react";
import { haptic, playDone, playLevelUp } from "./feedback";
import type { Celebration } from "./progress";

const COLORS = ["var(--accent)", "#AFA9EC", "#EF9F27", "#5DCAA5"];

/** Full-screen burst when a task is completed; a bigger one when this week beats every past week. */
export function Celebrate() {
  const [shot, setShot] = useState<(Celebration & { key: number }) | null>(null);
  useEffect(() => {
    const on = (event: Event) => {
      const detail = (event as CustomEvent<Celebration>).detail;
      if (!detail) return;
      setShot({ ...detail, key: Date.now() });
      if (detail.record) {
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
    const timer = window.setTimeout(() => setShot(null), shot.record ? 2600 : 1300);
    return () => window.clearTimeout(timer);
  }, [shot]);
  if (!shot) return null;
  return (
    <div className={`celebrate${shot.record ? " level-up" : ""}`} key={shot.key} aria-live="polite">
      {Array.from({ length: shot.record ? 28 : 16 }, (_, i) => {
        const angle = (Math.PI * 2 * i) / (shot.record ? 28 : 16);
        const r = (shot.record ? 150 : 100) + (i % 3) * 18;
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
      {shot.record ? (
        <div className="level-card">
          <small>自己ベスト</small>
          <strong>{shot.marbles}個</strong>
          <span>今週のビンが、今までで一番いっぱい</span>
        </div>
      ) : (
        <div className="check-pop">✓</div>
      )}
      <b className="xp-fly"><i className="marble-fly" />今週{shot.marbles}個目</b>
    </div>
  );
}
