import { useLiveQuery } from "dexie-react-hooks";
import { Lock } from "lucide-react";
import { db } from "./db";
import {
  ACCENT_LABEL,
  ACCENT_UNLOCK,
  DEFAULT_APPEARANCE,
  FONT_LABEL,
  getAppearance,
  setAppearance,
  type Accent,
  type FontChoice,
} from "./appearance";
import { computeProgress, levelFrom, xpFrom } from "./progress";
import { playDone } from "./feedback";

const nativeBridge = () =>
  (window as unknown as { webkit?: { messageHandlers?: { sasshyAlarm?: { postMessage: (m: unknown) => void } } } })
    .webkit?.messageHandlers?.sasshyAlarm;

/** Settings: font, sound, accent color (unlocked by level), daily goal. */
export function AppearancePanel() {
  const a = useLiveQuery(async () => {
    await db.settings.get("appearance");
    return getAppearance();
  }, [], DEFAULT_APPEARANCE) || DEFAULT_APPEARANCE;
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []) || [];
  const sessions = useLiveQuery(() => db.sessions.toArray(), [], []) || [];
  const { level } = levelFrom(xpFrom(computeProgress(tasks, sessions)));
  return (
    <section className="settings-section appearance-panel">
      <h2>見た目と音</h2>
      <div className="ap-group">
        <span className="ap-label">フォント</span>
        <div className="ap-options">
          {([1, 2, 3] as FontChoice[]).map((font) => (
            <button key={font} type="button" className={`ap-font f${font}${a.font === font ? " active" : ""}`} onClick={() => setAppearance({ font })}>
              <strong>04:47</strong>
              <small>{FONT_LABEL[font]}</small>
            </button>
          ))}
        </div>
      </div>
      <div className="ap-group">
        <span className="ap-label">アクセントの色（レベルで増えます・今 Lv.{level}）</span>
        <div className="ap-accents">
          {(Object.keys(ACCENT_UNLOCK) as Accent[]).map((accent) => {
            const locked = level < ACCENT_UNLOCK[accent];
            return (
              <button
                key={accent}
                type="button"
                data-swatch={accent}
                className={`ap-accent${a.accent === accent ? " active" : ""}`}
                disabled={locked}
                aria-label={locked ? `${ACCENT_LABEL[accent]}（Lv.${ACCENT_UNLOCK[accent]}で解放）` : ACCENT_LABEL[accent]}
                onClick={() => setAppearance({ accent })}
              >
                <i />
                <small>{locked ? <><Lock size={11} /> Lv.{ACCENT_UNLOCK[accent]}</> : ACCENT_LABEL[accent]}</small>
              </button>
            );
          })}
        </div>
      </div>
      {nativeBridge() && (
        <div className="ap-group ap-row">
          <span className="ap-label">Siri・声で仕事を追加（設定と履歴）</span>
          <button type="button" className="button secondary" onClick={() => nativeBridge()?.postMessage({ action: "openVoicePanel" })}>
            開く
          </button>
        </div>
      )}
      <div className="ap-group ap-row">
        <span className="ap-label">完了したときの効果音</span>
        <button type="button" className="button secondary" onClick={() => { setAppearance({ sound: !a.sound }); if (!a.sound) playDone(true); }}>
          {a.sound ? "ON" : "OFF"}
        </button>
      </div>
      <div className="ap-group ap-row">
        <span className="ap-label">相棒のねこ（今日の画面）</span>
        <button type="button" className="button secondary" onClick={() => setAppearance({ companion: a.companion === false })}>
          {a.companion === false ? "OFF" : "ON"}
        </button>
      </div>
      <div className="ap-group ap-row">
        <span className="ap-label">今日の円の目標（作業時間）</span>
        <select value={a.dailyGoalMin} onChange={(e) => setAppearance({ dailyGoalMin: Number(e.currentTarget.value) })}>
          {[30, 45, 60, 90, 120, 180].map((m) => <option key={m} value={m}>{m >= 60 ? `${m / 60}時間${m % 60 ? "半" : ""}` : `${m}分`}</option>)}
        </select>
      </div>
    </section>
  );
}
