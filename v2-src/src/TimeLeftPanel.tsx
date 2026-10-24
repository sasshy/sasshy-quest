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
  type TimeLeftKey,
  type TimeLeftSetting,
} from "./timeleft";

function useNow(intervalMs = 30_000): Date {
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
  const age = ageOn(setting.birthday, now);
  const lived = daysLived(setting.birthday, now);
  return (
    <>
      <section className="time-left" aria-label="残り時間">
        <header>
          <h2>残り時間</h2>
          {age !== null && lived !== null && (
            <span className="tl-age">{age}歳・生まれて{lived.toLocaleString("ja-JP")}日目</span>
          )}
          <button type="button" className="tl-edit" aria-label="残り時間の表示を変える" onClick={() => setEditing(true)}>
            <SlidersHorizontal size={15} />
          </button>
        </header>
        <div className="tl-row">
          {items.map((it) => {
            const left = Math.round((1 - it.used) * 100);
            return (
              <div key={it.key} className={`tl-tile${it.low ? " low" : ""}`} title={`${it.note}（残り${left}%）`}>
                <span className="tl-label">{it.label}</span>
                <strong className="tl-num">
                  {it.value}
                  <small>{it.unit}</small>
                  {it.extra && <em>{it.extra}</em>}
                </strong>
                <i className="tl-bar" aria-hidden="true">
                  <b style={{ width: `${left}%` }} />
                </i>
                <small className="tl-note">{it.note}</small>
              </div>
            );
          })}
        </div>
      </section>
      {editing && createPortal(<TimeLeftEditor setting={setting} onClose={() => setEditing(false)} />, document.body)}
    </>
  );
}

const KEY_LABEL: Record<TimeLeftKey, string> = { day: "今日", week: "今週", month: "今月", year: "今年", birthday: "誕生日まで" };

function TimeLeftEditor({ setting, onClose }: { setting: TimeLeftSetting; onClose: () => void }) {
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
