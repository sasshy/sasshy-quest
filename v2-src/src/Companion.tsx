import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import sit from "./assets/companion/cat-1.png?inline";
import happy from "./assets/companion/cat-2.png?inline";
import stretch from "./assets/companion/cat-3.png?inline";
import sleep from "./assets/companion/cat-4.png?inline";
import tilt from "./assets/companion/cat-5.png?inline";
import walk from "./assets/companion/cat-6.png?inline";
import { db } from "./db";
import { haptic } from "./feedback";

/**
 * 相棒のねこ. Sits next to today's progress. It only moves at moments:
 * starting (stretch), finishing (looks up and hops), level up (walks over).
 * While a timer runs it watches quietly; if SASSHY wasn't used for a while it
 * is just asleep — it never gets sad or weaker.
 */
type Pose = "sit" | "happy" | "stretch" | "sleep" | "tilt" | "walk";
const IMAGES: Record<Pose, string> = { sit, happy, stretch, sleep, tilt, walk };
const LINES: Partial<Record<Pose, string>> = {
  happy: "やったね",
  stretch: "いこう",
  walk: "レベルアップ！",
  sleep: "おかえり。2分だけやる？",
};

export function companionStart(): void {
  window.dispatchEvent(new CustomEvent("sasshy-companion", { detail: "stretch" }));
}

export function Companion() {
  const sessions = useLiveQuery(() => db.sessions.toArray(), [], []) || [];
  const [moment, setMoment] = useState<{ pose: Pose; key: number } | null>(null);
  const timer = useRef<number | null>(null);

  const show = (pose: Pose, ms: number) => {
    if (timer.current) window.clearTimeout(timer.current);
    setMoment({ pose, key: Date.now() });
    timer.current = window.setTimeout(() => setMoment(null), ms);
  };

  useEffect(() => {
    const onCelebrate = (e: Event) => {
      const levelUp = Boolean((e as CustomEvent<{ levelUp?: boolean }>).detail?.levelUp);
      show(levelUp ? "walk" : "happy", levelUp ? 4200 : 3200);
    };
    const onCompanion = (e: Event) => show(((e as CustomEvent<Pose>).detail || "happy"), 2600);
    window.addEventListener("sasshy-celebrate", onCelebrate);
    window.addEventListener("sasshy-companion", onCompanion);
    return () => {
      window.removeEventListener("sasshy-celebrate", onCelebrate);
      window.removeEventListener("sasshy-companion", onCompanion);
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const running = sessions.some((s) => !s.deletedAt && s.status === "running");
  const last = sessions.reduce((max, s) => Math.max(max, Date.parse(s.endedAt || s.startedAt) || 0), 0);
  const hour = new Date().getHours();
  const idlePose: Pose = running ? "tilt" : (last && Date.now() - last > 48 * 3_600_000) || (hour >= 2 && hour < 6) ? "sleep" : "sit";
  const pose = moment?.pose ?? idlePose;
  const line = moment ? LINES[moment.pose] : idlePose === "sleep" ? LINES.sleep : running ? "見てるよ" : null;

  return (
    <button
      type="button"
      className={`companion pose-${pose}${moment ? " moment" : ""}`}
      key={moment?.key ?? "idle"}
      aria-label="相棒のねこ"
      onClick={() => { haptic("tap"); show("happy", 1800); }}
    >
      {line && <span className="companion-say">{line}</span>}
      <img src={IMAGES[pose]} alt="" draggable={false} />
    </button>
  );
}
