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
/**
 * Videos made with ChatGPT (plain #F2F2EF background, same framing). Idle poses
 * loop; moment poses play once and then go back to the idle loop. Poses
 * without a video use the still image.
 */
const VIDEOS: Partial<Record<Pose, string>> = {
  sit: "companion/cat-idle.mp4",
  // 作業中の見守り：ちらっと見上げてまた戻る（ループ）
  tilt: "companion/cat-watch.mp4",
  // 完了：目を細めて見上げる（1回流して元に戻る）
  happy: "companion/cat-happy.mp4",
  // 開始：前足を伸ばして伸び（1回流して元に戻る）
  stretch: "companion/cat-stretch.mp4",
};
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
      show(levelUp ? "walk" : "happy", levelUp ? 4200 : 5000);
    };
    const onCompanion = (e: Event) => {
      const pose = (e as CustomEvent<Pose>).detail || "happy";
      show(pose, VIDEOS[pose] ? 5000 : 2600);
    };
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
      className={`companion pose-${pose}${moment && !VIDEOS[moment.pose] ? " moment" : ""}${Object.keys(VIDEOS).length ? " tile" : ""}`}
      data-moment={moment?.key ?? 0}
      aria-label="相棒のねこ"
      onClick={() => { haptic("tap"); show("happy", VIDEOS.happy ? 5000 : 1800); }}
    >
      {line && <span className="companion-say">{line}</span>}
      <span className="companion-frame">
      {VIDEOS[idlePose] && (
        <video
          className={`companion-video${!moment || VIDEOS[moment.pose] ? " on" : ""}`}
          src={VIDEOS[idlePose]}
          autoPlay
          loop
          muted
          playsInline
          disablePictureInPicture
          aria-hidden="true"
        />
      )}
      {moment && VIDEOS[moment.pose] && (
        <video
          key={moment.key}
          className="companion-video on"
          src={VIDEOS[moment.pose]}
          autoPlay
          muted
          playsInline
          disablePictureInPicture
          aria-hidden="true"
          onEnded={() => { if (timer.current) window.clearTimeout(timer.current); setMoment(null); }}
        />
      )}
      {/* 動画がないポーズは静止画。重ねておき、切り替えはふわっと入れ替える。 */}
      {(Object.keys(IMAGES) as Pose[]).map((p) => (
        <img key={p === pose && moment ? `${p}-${moment.key}` : p} src={IMAGES[p]} alt="" draggable={false} className={p === pose && !VIDEOS[p] ? "on" : ""} />
      ))}
      </span>
    </button>
  );
}
