import { useState } from "react";
import { ageOn } from "./timeleft";
import { splitSpan } from "./timeleft";
import { localDateKey } from "./meals";

/**
 * 地図の上の「時間の見え方」: choose the span (人生 / 次の誕生日まで / 今年 /
 * 今月 / 今週) and the look (マス / 円 / 棒). Days you tried a wish are marked.
 */
export type Span = "life" | "birthday" | "year" | "month" | "week";
export type Look = "grid" | "ring" | "bar";

const DAY = 86_400_000;
const LIFE_YEARS = 80;

export interface PeriodInfo {
  span: Span;
  label: string;
  start: number;
  end: number;
  /** cells for the grid */
  unit: "week" | "day";
  cells: number;
  usedCells: number;
  left: { value: string; unit: string; extra: string };
  leftNote: string;
}

const atMidnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export function periodInfo(span: Span, birthday: string, now = new Date()): PeriodInfo {
  const t = now.getTime();
  const today = atMidnight(now);
  const b = new Date(`${birthday}T00:00:00`);
  const age = ageOn(birthday, now) ?? 0;
  let start: number;
  let end: number;
  let label: string;
  let unit: PeriodInfo["unit"] = "day";
  if (span === "life") {
    start = b.getTime();
    end = new Date(b.getFullYear() + LIFE_YEARS, b.getMonth(), b.getDate()).getTime();
    label = `人生（${LIFE_YEARS}歳まで）`;
    unit = "week";
  } else if (span === "birthday") {
    let next = new Date(now.getFullYear(), b.getMonth(), b.getDate());
    if (next.getTime() <= today.getTime()) next = new Date(now.getFullYear() + 1, b.getMonth(), b.getDate());
    start = new Date(next.getFullYear() - 1, b.getMonth(), b.getDate()).getTime();
    end = next.getTime();
    label = `${age + 1}歳まで`;
  } else if (span === "year") {
    start = new Date(now.getFullYear(), 0, 1).getTime();
    end = new Date(now.getFullYear() + 1, 0, 1).getTime();
    label = `${now.getFullYear()}年`;
  } else if (span === "month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    label = `${now.getMonth() + 1}月`;
  } else {
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    start = monday.getTime();
    end = start + 7 * DAY;
    label = "今週";
  }
  const unitMs = unit === "week" ? 7 * DAY : DAY;
  const cells = Math.round((end - start) / unitMs);
  const usedCells = Math.min(cells, Math.floor((t - start) / unitMs));
  const left = span === "life"
    ? { value: Math.max(0, Math.floor((end - t) / (7 * DAY))).toLocaleString("ja-JP"), unit: "週", extra: "" }
    : splitSpan(end - t);
  const leftNote = span === "life" ? `過ごした ${Math.floor((t - start) / (7 * DAY)).toLocaleString("ja-JP")}週` : `${Math.round(((t - start) / (end - start)) * 100)}% 過ぎた`;
  return { span, label, start, end, unit, cells, usedCells, left, leftNote };
}

const SPANS: { key: Span; label: string }[] = [
  { key: "life", label: "人生" },
  { key: "birthday", label: "次の年齢まで" },
  { key: "year", label: "今年" },
  { key: "month", label: "今月" },
  { key: "week", label: "今週" },
];
const LOOKS: { key: Look; label: string }[] = [
  { key: "grid", label: "マス" },
  { key: "ring", label: "円" },
  { key: "bar", label: "棒" },
];

const load = <T extends string>(key: string, fallback: T, allowed: T[]): T => {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* 保存できなくても表示はできる */ }
};

export function PeriodView({ birthday, triedDays }: { birthday: string; triedDays: Set<string> }) {
  const [span, setSpan] = useState<Span>(() => load("sasshy-map-span", "birthday", SPANS.map((s) => s.key)));
  const [look, setLook] = useState<Look>(() => load("sasshy-map-look", "grid", LOOKS.map((l) => l.key)));
  const now = new Date();
  const info = periodInfo(span, birthday, now);
  const pct = Math.min(1, Math.max(0, (now.getTime() - info.start) / (info.end - info.start)));

  return (
    <section className="pv">
      <div className="pv-tabs" role="tablist" aria-label="期間">
        {SPANS.map((s) => (
          <button key={s.key} type="button" role="tab" aria-selected={span === s.key} className={span === s.key ? "active" : ""} onClick={() => { setSpan(s.key); save("sasshy-map-span", s.key); }}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="pv-head">
        <div>
          <span>{info.label}・のこり</span>
          <strong>{info.left.value}<small>{info.left.unit}</small>{info.left.extra && <em>{info.left.extra}</em>}</strong>
        </div>
        <div className="pv-looks" role="group" aria-label="表示の形">
          {LOOKS.map((l) => (
            <button key={l.key} type="button" aria-pressed={look === l.key} className={look === l.key ? "active" : ""} onClick={() => { setLook(l.key); save("sasshy-map-look", l.key); }}>
              {l.label}
            </button>
          ))}
        </div>
      </div>

      {look === "grid" && <GridLook info={info} triedDays={triedDays} />}
      {look === "ring" && (
        <div className="pv-ring">
          <svg viewBox="0 0 120 120" role="img" aria-label={`${info.label}の${Math.round(pct * 100)}%が過ぎた`}>
            <circle cx="60" cy="60" r="50" className="pv-ring-left" />
            <circle cx="60" cy="60" r="50" className="pv-ring-used" style={{ strokeDasharray: 314.16, strokeDashoffset: 314.16 * (1 - pct) }} />
          </svg>
          <div>
            <strong>{Math.round((1 - pct) * 100)}<small>%</small></strong>
            <span>のこり</span>
          </div>
        </div>
      )}
      {look === "bar" && (
        <div className="pv-bar">
          <div className="pv-bar-track">
            <i style={{ width: `${pct * 100}%` }} />
            <b style={{ left: `${pct * 100}%` }} aria-hidden="true" />
          </div>
          <div className="pv-bar-labels">
            <span>{new Date(info.start).toLocaleDateString("ja-JP", { year: info.span === "life" ? "numeric" : undefined, month: "numeric", day: "numeric" })}</span>
            <span>いま</span>
            <span>{new Date(info.end).toLocaleDateString("ja-JP", { year: info.span === "life" ? "numeric" : undefined, month: "numeric", day: "numeric" })}</span>
          </div>
        </div>
      )}
      <div className="pv-foot">
        <span>{info.leftNote}</span>
        {info.unit === "day" && <span><b className="pv-key tried" />やりたいことを試した日</span>}
      </div>
    </section>
  );
}

function GridLook({ info, triedDays }: { info: PeriodInfo; triedDays: Set<string> }) {
  if (info.unit === "week") {
    // 1行＝1年・1マス＝1週
    const years = Math.round(info.cells / 52);
    const rows = Array.from({ length: years }, (_, y) => {
      const used = Math.min(52, Math.max(0, info.usedCells - y * 52));
      return used;
    });
    return (
      <div className="pv-life" role="img" aria-label={`人生を週で：${info.leftNote}`}>
        {rows.map((used, y) => (
          <div key={y} className="pv-life-row">
            <i className="used" style={{ width: `${(used / 52) * 100}%` }} />
            {used > 0 && used < 52 && <i className="now" style={{ width: `${((52 - used) / 52) * 100}%` }} />}
          </div>
        ))}
      </div>
    );
  }
  const today = localDateKey(Date.now());
  const cols = info.cells <= 31 ? 7 : 26;
  return (
    <div className={`pv-grid${info.cells <= 7 ? " big" : info.cells > 100 ? " tiny" : ""}`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {Array.from({ length: info.cells }, (_, i) => {
        const day = new Date(info.start + i * DAY + 12 * 3_600_000);
        const key = localDateKey(day);
        const cls = key === today ? "now" : i < info.usedCells ? "used" : "";
        return (
          <span key={i} className={`${cls}${triedDays.has(key) ? " tried" : ""}`} title={key}>
            {info.cells <= 31 ? day.getDate() : ""}
          </span>
        );
      })}
    </div>
  );
}
