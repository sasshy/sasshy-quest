import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Annoyed, Frown, Laugh, Meh, NotebookPen, Smile, type LucideIcon } from "lucide-react";
import { db } from "./db";
import { MOOD_LABEL, diaryEntries, diaryOn, diaryPrompt, saveDiary } from "./diary";
import { localDateKey, shiftDateKey } from "./meals";
import { syncNow } from "./sync";
import type { Memo } from "./types";

export const MOOD_ICON: LucideIcon[] = [Meh, Frown, Annoyed, Meh, Smile, Laugh];

/** Ask the 記録 page to open on the diary tab (it reads this once when it mounts). */
let diaryRequested = false;
export function peekDiaryRequest(): boolean {
  return diaryRequested;
}
export function takeDiaryRequest(): boolean {
  const value = diaryRequested;
  diaryRequested = false;
  return value;
}
export function openDiaryList(): void {
  diaryRequested = true;
  window.dispatchEvent(new CustomEvent("sasshy-open-page", { detail: "records" }));
  window.dispatchEvent(new Event("sasshy-open-diary"));
}

/** Mood + one line for any day. Writing nothing is fine. */
export function DiaryEditor({ date, compact = false }: { date: string; compact?: boolean }) {
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const entry = diaryOn(memos, date);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!editing) setText(entry?.body || "");
  }, [entry?.body, editing]);
  // 別の日に切り替えたら、書きかけの文字は持ち越さない。
  useEffect(() => {
    setEditing(false);
    setSaved(false);
    setText(entry?.body || "");
  }, [date]);
  const mood = entry?.diary?.mood ?? null;
  const persist = async (changes: { text?: string; mood?: number | null }) => {
    await saveDiary(memos, date, changes);
    syncNow().catch(() => undefined);
  };
  const showEditor = editing || !entry?.body;
  return (
    <div className="diary-editor">
      <div className="diary-moods" role="group" aria-label="気分">
        {[1, 2, 3, 4, 5].map((value) => {
          const Icon = MOOD_ICON[value];
          return (
            <button
              key={value}
              type="button"
              className={mood === value ? "active" : ""}
              aria-pressed={mood === value}
              aria-label={MOOD_LABEL[value]}
              onClick={() => persist({ mood: mood === value ? null : value })}
            >
              <Icon size={compact ? 20 : 22} />
              <small>{MOOD_LABEL[value]}</small>
            </button>
          );
        })}
      </div>
      {showEditor ? (
        <form
          className="diary-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const typed = String(new FormData(event.currentTarget).get("diary") || "");
            await persist({ text: typed });
            setEditing(false);
            setSaved(true);
            window.dispatchEvent(new CustomEvent("sasshy-toast", { detail: `✓ ${Number(date.slice(5, 7))}/${Number(date.slice(8))}の日記を保存しました` }));
            window.setTimeout(() => setSaved(false), 3000);
          }}
        >
          <textarea
            name="diary"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onFocus={() => setEditing(true)}
            placeholder={diaryPrompt(date)}
            rows={editing ? 3 : 1}
            maxLength={2000}
          />
          {editing && <button className="button primary" type="submit">残す</button>}
        </form>
      ) : (
        <button type="button" className="diary-text" onClick={() => setEditing(true)}>
          {entry!.body}
        </button>
      )}
      {saved && <small className="diary-saved">✓ 保存しました</small>}
    </div>
  );
}

/** Today: a one-line diary with a mood tap, and the way back to past entries. */
export function DiaryCard() {
  const today = localDateKey(Date.now());
  return (
    <section className="diary-card" aria-label="ひとこと日記">
      <header>
        <NotebookPen size={15} />
        <h2>ひとこと日記</h2>
        <button type="button" className="diary-more" onClick={openDiaryList}>これまでの日記 ›</button>
      </header>
      <DiaryEditor date={today} />
    </section>
  );
}

/** 記録 › 日記: a month of moods; tap a day to read or write it. */
export function DiaryMonth() {
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const today = localDateKey(Date.now());
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const [selected, setSelected] = useState(today);
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(y, m, 0).getDate();
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`)];
  const shiftMonth = (n: number) => {
    const d = new Date(y, m - 1 + n, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };
  const monthEntries = diaryEntries(memos).filter((e) => e.diary!.date.startsWith(month));
  const sel = new Date(`${selected}T12:00:00`);
  return (
    <>
      <section className="rec-card diary-month">
        <div className="dm-nav">
          <button type="button" aria-label="前の月" onClick={() => shiftMonth(-1)}>‹</button>
          <strong>{y}年{m}月</strong>
          <button type="button" aria-label="次の月" disabled={month >= today.slice(0, 7)} onClick={() => shiftMonth(1)}>›</button>
        </div>
        <div className="dm-grid dm-head" aria-hidden="true">
          {["月", "火", "水", "木", "金", "土", "日"].map((d) => <span key={d}>{d}</span>)}
        </div>
        <div className="dm-grid">
          {cells.map((key, i) => {
            if (!key) return <span key={`e${i}`} />;
            const e = diaryOn(memos, key);
            const moodClass = e?.diary?.mood ? ` m${e.diary.mood}` : e ? " written" : "";
            return (
              <button
                key={key}
                type="button"
                className={`dm-day${moodClass}${key === selected ? " selected" : ""}`}
                disabled={key > today}
                onClick={() => setSelected(key)}
                aria-label={`${Number(key.slice(8))}日${e?.diary?.mood ? `・${MOOD_LABEL[e.diary.mood]}` : ""}`}
              >
                {Number(key.slice(8))}
              </button>
            );
          })}
        </div>
        <small className="dm-legend">{monthEntries.length}日分・色が濃いほど「いい日」。書いていない日があっても大丈夫</small>
      </section>
      <section className="rec-card diary-day">
        <header><h2>{sel.getMonth() + 1}/{sel.getDate()}（{sel.toLocaleDateString("ja-JP", { weekday: "short" })}）{selected === today ? "・今日" : ""}</h2></header>
        <DiaryEditor key={selected} date={selected} compact />
      </section>
      <DiaryList memos={memos} days={3650} onPick={setSelected} month={month} />
    </>
  );
}

/** Records: recent diary entries with their mood. */
export function DiaryList({ memos, days, onPick, month }: { memos: Memo[]; days: number; onPick?: (date: string) => void; month?: string }) {
  const today = localDateKey(Date.now());
  const entries = diaryEntries(memos, shiftDateKey(today, -(days - 1))).filter((e) => !month || e.diary!.date.startsWith(month));
  if (!entries.length) return null;
  return (
    <section className="rec-card diary-list">
      <header><h2>日記</h2><small>{entries.length}日分</small></header>
      <ul>
        {entries.map((m) => {
          const Icon = m.diary!.mood ? MOOD_ICON[m.diary!.mood] : null;
          const d = new Date(`${m.diary!.date}T12:00:00`);
          return (
            <li key={m.id} onClick={onPick ? () => onPick(m.diary!.date) : undefined} className={onPick ? "pickable" : ""}>
              <span className="diary-date">{d.getMonth() + 1}/{d.getDate()}<small>{d.toLocaleDateString("ja-JP", { weekday: "short" })}</small></span>
              <span className={`diary-mood m${m.diary!.mood || 0}`}>{Icon && <Icon size={18} />}</span>
              <p>{m.body || <small>{m.diary!.mood ? MOOD_LABEL[m.diary!.mood] : ""}</small>}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
