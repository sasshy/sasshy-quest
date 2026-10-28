import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Plus, SlidersHorizontal, Trash2, X } from "lucide-react";
import { db, makeId } from "./db";
import {
  DEFAULT_TIME_LEFT,
  ageOn,
  clockText,
  daysLived,
  getTimeLeft,
  minuteFromClock,
  setTimeLeft,
  timeLeftItems,
  type TimeLeftItem,
  type TimeLeftKey,
  type TimeLeftSetting,
} from "./timeleft";

export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Today: what is left of the day / week / month / year / until the birthday. */
export function TimeLeftStrip() {
  const setting = useLiveQuery(async () => {
    await db.settings.get("timeLeft");
    return getTimeLeft();
  }, [], DEFAULT_TIME_LEFT) || DEFAULT_TIME_LEFT;
  const now = useNow();
  const [editing, setEditing] = useState(false);
  if (!setting.enabled) return null;
  const items = timeLeftItems(setting, now);
  const day = items.find((it) => it.key === "day");
  const rest = items.filter((it) => it.key !== "day");
  const age = ageOn(setting.birthday, now);
  const lived = daysLived(setting.birthday, now);
  return (
    <>
      <section className="time-left" aria-label="残り時間">
        <header>
          <h2>残り時間</h2>
          {age !== null && lived !== null && (
            <span className="tl-age">生まれて{lived.toLocaleString("ja-JP")}日目</span>
          )}
          <button type="button" className="tl-edit" aria-label="残り時間の表示を変える" onClick={() => setEditing(true)}>
            <SlidersHorizontal size={15} />
          </button>
        </header>
        {day && <DayBlocks item={day} now={now.getTime()} />}
        {rest.length > 0 && (
          <ul className="tl-list">
            {rest.map((it) => {
              const left = Math.round((1 - it.used) * 100);
              return (
                <li key={it.key} className={it.low ? "low" : ""} title={it.note}>
                  <span className="tl-label">{it.label}</span>
                  <i className="tl-bar" aria-hidden="true"><b style={{ width: `${left}%` }} /></i>
                  <strong className="tl-num">{it.value}<small>{it.unit}</small>{it.extra && <em>{it.extra}</em>}</strong>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {editing && createPortal(<TimeLeftEditor setting={setting} onClose={() => setEditing(false)} />, document.body)}
    </>
  );
}

/**
 * 今日の残りを「起きている1時間＝1マス」で見せる。使ったマスは薄く、
 * 今のマスは減っていき、残りのマスが何個あるかで直感的にわかる。
 */
export function DayBlocks({ item, now }: { item: TimeLeftItem; now: number }) {
  const HOUR = 3_600_000;
  const start = item.start ?? now;
  const end = item.end ?? now;
  const count = Math.max(1, Math.round((end - start) / HOUR));
  const leftHours = Math.max(0, (end - now) / HOUR);
  return (
    <div className={`tl-day${item.low ? " low" : ""}`}>
      <div className="tl-day-head">
        <span>{item.note}</span>
        <strong className="tl-day-num">
          あと<b>{item.value}</b>{item.unit}{item.extra && <em>{item.extra}</em>}
        </strong>
      </div>
      <div className="tl-blocks" aria-label={`起きている時間の残り${Math.floor(leftHours)}時間`}>
        {Array.from({ length: count }, (_, i) => {
          const from = start + i * HOUR;
          // 1 = まるごと残っている, 0 = もう使った
          const remain = Math.min(1, Math.max(0, (from + HOUR - now) / HOUR));
          return (
            <i key={i} className={remain >= 1 ? "left" : remain <= 0 ? "used" : "now"}>
              {remain > 0 && remain < 1 && <b style={{ width: `${Math.round(remain * 100)}%` }} />}
            </i>
          );
        })}
      </div>
      <small className="tl-day-foot">残り{Math.ceil(leftHours)}マス（1マス＝1時間）</small>
    </div>
  );
}

const KEY_LABEL: Record<TimeLeftKey, string> = { day: "今日", week: "今週", month: "今月", year: "今年", birthday: "誕生日まで" };

export function TimeLeftEditor({ setting, onClose }: { setting: TimeLeftSetting; onClose: () => void }) {
  const [label, setLabel] = useState("");
  const [date, setDate] = useState("");
  const addCountdown = async (form: FormData) => {
    const typedLabel = String(form.get("label") || label).trim();
    const typedDate = String(form.get("date") || date);
    if (!typedLabel || !/^\d{4}-\d{2}-\d{2}$/.test(typedDate)) return;
    await setTimeLeft({ countdowns: [...setting.countdowns, { id: makeId("cd"), label: typedLabel.slice(0, 16), date: typedDate }] });
    setLabel("");
    setDate("");
  };
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal-sheet tl-sheet" role="dialog" aria-modal="true" aria-labelledby="tl-title">
        <header>
          <div>
            <span className="eyebrow">TIME LEFT</span>
            <h2 id="tl-title">残り時間の表示</h2>
          </div>
          <button className="icon-button" type="button" aria-label="閉じる" onClick={onClose}><X size={20} /></button>
        </header>
        <div className="form-stack">
          <label className="tl-switch">
            <input type="checkbox" checked={setting.enabled} onChange={(e) => setTimeLeft({ enabled: e.target.checked })} />
            <span>今日の画面に出す</span>
          </label>
          <div className="tl-toggles" role="group" aria-label="出す項目">
            {(Object.keys(KEY_LABEL) as TimeLeftKey[]).map((key) => (
              <button
                key={key}
                type="button"
                className={setting.show[key] ? "active" : ""}
                aria-pressed={setting.show[key]}
                onClick={() => setTimeLeft({ show: { ...setting.show, [key]: !setting.show[key] } })}
              >
                {KEY_LABEL[key]}
              </button>
            ))}
          </div>
          <div className="tl-fields">
            <label>
              <span>誕生日</span>
              <input type="date" value={setting.birthday} onChange={(e) => e.target.value && setTimeLeft({ birthday: e.target.value })} />
            </label>
            <label>
              <span>起きる</span>
              <input type="time" value={clockText(setting.wakeMinute)} onChange={(e) => {
                const m = minuteFromClock(e.target.value);
                if (m !== null) setTimeLeft({ wakeMinute: m });
              }} />
            </label>
            <label>
              <span>寝る</span>
              <input type="time" value={clockText(setting.bedMinute)} onChange={(e) => {
                const m = minuteFromClock(e.target.value, true);
                if (m !== null) setTimeLeft({ bedMinute: m });
              }} />
            </label>
          </div>
          <p className="settings-hint">「今日」は寝る時刻までの残り。日付が変わっても、寝る時刻まではその日の続きとして数えます。</p>

          <div className="tl-countdowns">
            <span className="meal-label">自分で決めた締め切り</span>
            {setting.countdowns.length === 0 && <small className="settings-hint">例：GPT終了 12/11、旅行、申込の期限</small>}
            <ul>
              {setting.countdowns.map((c) => (
                <li key={c.id}>
                  <span>{c.label}</span>
                  <small>{c.date.replace(/-/g, "/")}</small>
                  <button type="button" aria-label={`${c.label}を消す`} onClick={() => setTimeLeft({ countdowns: setting.countdowns.filter((x) => x.id !== c.id) })}>
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
            </ul>
            <form className="tl-add" onSubmit={(event) => { event.preventDefault(); addCountdown(new FormData(event.currentTarget)); }}>
              <input name="label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="名前" maxLength={16} />
              <input name="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              <button className="button secondary" type="submit" aria-label="追加"><Plus size={16} /></button>
            </form>
          </div>
        </div>
      </section>
    </div>
  );
}

/** Top bar: 「10/25(土)・36歳」 */
export function AgeLabel() {
  const setting = useLiveQuery(async () => { await db.settings.get("timeLeft"); return getTimeLeft(); }, [], DEFAULT_TIME_LEFT) || DEFAULT_TIME_LEFT;
  const age = ageOn(setting.birthday, new Date());
  return age === null ? null : <span className="topbar-age">・{age}歳</span>;
}
