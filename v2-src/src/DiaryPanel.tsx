import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Annoyed, Frown, Laugh, Meh, NotebookPen, Smile, type LucideIcon } from "lucide-react";
import { db } from "./db";
import { MOOD_LABEL, diaryEntries, diaryOn, diaryPrompt, saveDiary } from "./diary";
import { localDateKey, shiftDateKey } from "./meals";
import { syncNow } from "./sync";
import type { Memo } from "./types";

export const MOOD_ICON: LucideIcon[] = [Meh, Frown, Annoyed, Meh, Smile, Laugh];

/** Today: a one-line diary with a mood tap. Writing nothing is fine. */
export function DiaryCard() {
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const today = localDateKey(Date.now());
  const entry = diaryOn(memos, today);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!editing) setText(entry?.body || "");
  }, [entry?.body, editing]);
  const mood = entry?.diary?.mood ?? null;
  const persist = async (changes: { text?: string; mood?: number | null }) => {
    await saveDiary(memos, today, changes);
    syncNow().catch(() => undefined);
  };
  const showEditor = editing || !entry?.body;
  return (
    <section className="diary-card" aria-label="ひとこと日記">
      <header>
        <NotebookPen size={15} />
        <h2>ひとこと日記</h2>
        {saved && <small className="diary-saved">保存しました</small>}
      </header>
      <div className="diary-moods" role="group" aria-label="今日の気分">
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
              <Icon size={22} />
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
            window.setTimeout(() => setSaved(false), 2000);
          }}
        >
          <textarea
            name="diary"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onFocus={() => setEditing(true)}
            placeholder={diaryPrompt(today)}
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
    </section>
  );
}

/** Records: recent diary entries with their mood. */
export function DiaryList({ memos, days }: { memos: Memo[]; days: number }) {
  const today = localDateKey(Date.now());
  const entries = diaryEntries(memos, shiftDateKey(today, -(days - 1)));
  if (!entries.length) return null;
  return (
    <section className="rec-card diary-list">
      <header><h2>日記</h2><small>{entries.length}日分</small></header>
      <ul>
        {entries.map((m) => {
          const Icon = m.diary!.mood ? MOOD_ICON[m.diary!.mood] : null;
          const d = new Date(`${m.diary!.date}T12:00:00`);
          return (
            <li key={m.id}>
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
