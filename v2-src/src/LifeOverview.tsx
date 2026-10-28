import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { useMemos } from "./live";
import { ArrowUp, Pencil, Plus, Trash2, X } from "lucide-react";
import { db } from "./db";
import { syncNow } from "./sync";
import { AREA_KEYS, AREA_LABEL, wishes } from "./wishes";
import { amountOf } from "./money";
import { localDateKey } from "./meals";
import { sessionActiveSeconds } from "./insights";
import { isDiaryMemo } from "./diary";
import {
  CHAPTER_COLORS,
  LIFE_YEARS,
  currentChapter,
  lifeEntries,
  removeLifeEntry,
  saveLifeEntry,
  saveScores,
  saveValues,
  scoreFor,
  timeByArea,
  valuesOf,
  weekIndex,
  weeksLived,
} from "./lifemap";
import type { AreaKey, LifeEntry, Memo } from "./types";

/**
 * 地図の上半分：人生を週のマスで俯瞰し、今いる章、6つの領域のバランス、
 * 大事にしたいことと実際の時間の行き先を並べる。
 */
const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const shiftMonth = (month: string, n: number) => {
  const [y, m] = month.split("-").map(Number);
  return ym(new Date(y, m - 1 + n, 1));
};
const KIND_LABEL: Record<LifeEntry["kind"], string> = { chapter: "章（期間）", event: "出来事", milestone: "これからの目印" };

export function LifeOverview({ birthday }: { birthday: string }) {
  const memos = useMemos() || [];
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []) || [];
  const sessions = useLiveQuery(() => db.sessions.toArray(), [], []) || [];
  const [yearOpen, setYearOpen] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [scoring, setScoring] = useState(false);
  const now = new Date();
  const entries = lifeEntries(memos);
  const lived = weeksLived(birthday, now);
  const total = LIFE_YEARS * 52;
  const age = Math.floor(lived / 52.1775);
  const chapter = currentChapter(memos, now);

  // マスの色：章の色（過ぎた週）、出来事は橙、これからの目印は緑の枠、今週は赤。
  const cells = useMemo(() => {
    const fill: string[] = new Array(total).fill("");
    const chapters = entries.filter((e) => e.life!.kind === "chapter");
    chapters.forEach((c, i) => {
      const from = weekIndex(birthday, c.life!.from);
      const to = c.life!.to ? weekIndex(birthday, shiftMonth(c.life!.to, 1)) : lived + 1;
      const color = c.life!.color || CHAPTER_COLORS[i % CHAPTER_COLORS.length];
      for (let w = from; w < Math.min(total, to); w += 1) fill[w] = color;
    });
    return fill;
  }, [entries, birthday, lived, total]);
  const eventWeeks = new Set(entries.filter((e) => e.life!.kind === "event").map((e) => weekIndex(birthday, e.life!.from)));
  const markWeeks = new Set(entries.filter((e) => e.life!.kind === "milestone").map((e) => weekIndex(birthday, e.life!.from)));
  const W = 52;
  const cw = 7;
  const ch = 4.6;

  // ---- バランス ----
  const month = ym(now);
  const score = scoreFor(memos, month)?.areaScore?.scores || {};
  const past = scoreFor(memos, shiftMonth(month, -3))?.areaScore?.scores || scoreFor(memos, shiftMonth(month, -1))?.areaScore?.scores || {};
  const hasScore = Object.keys(score).length > 0;
  const minutes = timeByArea(tasks, sessions, month);
  const lastMonthMinutes = timeByArea(tasks, sessions, shiftMonth(month, -1));
  const spentMonth = memos.filter((m) => !m.deletedAt && (m.meal || m.expense) && localDateKey((m.meal?.at || m.expense!.at)).startsWith(month)).reduce((s, m) => s + amountOf(m), 0);
  const h = (m: number) => (m >= 60 ? `${Math.round(m / 6) / 10}時間` : `${m}分`);
  const facts: Record<AreaKey, string> = {
    health: `健康の時間 ${h(minutes.health)}`,
    money: `今月使った ¥${spentMonth.toLocaleString("ja-JP")}`,
    work: `作業 ${h(minutes.work)}（先月 ${h(lastMonthMinutes.work)}）`,
    family: `家族の時間 ${h(minutes.family)}`,
    people: `人との時間 ${h(minutes.people)}`,
    fun: `楽しみ ${h(minutes.fun)}・やりたい ${wishes(memos).filter((w) => w.wish!.attempts.some((a) => a.at.startsWith(month))).length}件試した`,
  };

  // ---- 大事にしたい順 と 実際の時間 ----
  const { order } = valuesOf(memos);
  const totalMin = Math.max(1, Object.values(minutes).reduce((a, b) => a + b, 0));
  const share = (k: AreaKey) => Math.round((minutes[k] / totalMin) * 100);
  const gap = order.slice(0, 3).map((k, i) => ({ k, i, s: share(k) })).sort((a, b) => a.s - b.s)[0];

  return (
    <div className="lo">
      <section className="lo-weeks">
        <header>
          <div>
            <strong>人生の地図</strong>
            <small>1マス＝1週間・1行＝1年（{LIFE_YEARS}歳まで）</small>
          </div>
          <button type="button" className="lo-edit" onClick={() => setEditing(true)}><Pencil size={14} /> 章・出来事</button>
        </header>
        <div className="lo-stats">
          <div><span>人生の</span><b>{Math.round((lived / total) * 100)}%</b></div>
          <div><span>過ぎた週</span><b>{lived.toLocaleString("ja-JP")}</b></div>
          <div><span>残り</span><b>{Math.max(0, total - lived).toLocaleString("ja-JP")}週</b></div>
        </div>
        <svg
          viewBox={`0 0 ${W * cw + 18} ${LIFE_YEARS * ch}`}
          width="100%"
          role="img"
          aria-label="人生を週のマスで並べた図。行を押すとその年が開く"
          onClick={(e) => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const row = Math.floor(((e.clientY - r.top) / r.height) * LIFE_YEARS);
            setYearOpen(Math.min(LIFE_YEARS - 1, Math.max(0, row)));
          }}
        >
          {Array.from({ length: total }, (_, i) => {
            const x = 18 + (i % W) * cw;
            const y = Math.floor(i / W) * ch;
            const isNow = i === lived;
            const passed = i < lived;
            const ev = eventWeeks.has(i);
            const mk = markWeeks.has(i);
            const fill = isNow ? "#F0997B" : ev && passed ? "#EF9F27" : passed ? cells[i] || "#888780" : mk ? "none" : cells[i] ? `${cells[i]}55` : "var(--lo-empty)";
            return <rect key={i} x={x + 0.5} y={y + 0.5} width={cw - 1.2} height={ch - 1} rx={0.8} fill={fill} stroke={isNow ? "#D85A30" : mk && !passed ? "#1D9E75" : "none"} strokeWidth={isNow ? 1.4 : mk && !passed ? 1.1 : 0} />;
          })}
          {[0, 10, 20, 30, 40, 50, 60, 70].map((a) => <text key={a} x={0} y={a * ch + ch} className="lo-age">{a}</text>)}
          <text x={18 + W * cw - 1} y={Math.floor(lived / W) * ch - 1.5} textAnchor="end" className="lo-now">今 ▼</text>
        </svg>
        <div className="lo-legend">
          {entries.filter((e) => e.life!.kind === "chapter").map((c, i) => (
            <span key={c.id}><i style={{ background: c.life!.color || CHAPTER_COLORS[i % CHAPTER_COLORS.length] }} />{c.life!.title}</span>
          ))}
          <span><i style={{ background: "#EF9F27" }} />出来事</span>
          <span><i className="ring" />これからの目印</span>
        </div>
        {entries.length === 0 && <p className="lo-hint">「章・出来事」から、学生・前の仕事・今の仕事などの章と、引っ越しや転職などの出来事を入れると、マスに色が付きます。ChatGPTに経歴をまとめてもらって入れるのも手です。</p>}
      </section>

      <section className="lo-card">
        <header><strong>{chapter ? `今いる章：「${chapter.life!.title}」` : "今いる章"}</strong></header>
        {chapter ? (
          <>
            <div className="lo-mini">
              <div><span>この章の長さ</span><b>{(() => { const w = lived - weekIndex(birthday, chapter.life!.from); return `${Math.floor(w / 52)}年${Math.floor((w % 52) / 4.35)}か月`; })()}</b></div>
              <div><span>今年の作業</span><b>{h(sessions.filter((s) => !s.deletedAt && s.endedAt && s.startedAt.startsWith(String(now.getFullYear()))).reduce((a, s) => a + Math.round((sessionActiveSeconds(s) || 0) / 60), 0))}</b></div>
              <div><span>今年試した</span><b>やりたい {wishes(memos).filter((w) => w.wish!.attempts.some((a) => a.at.startsWith(String(now.getFullYear())))).length}件</b></div>
            </div>
            <p className="lo-q">この章をどう終わらせたい？ <em>{chapter.life!.note || "（章を押して一行書く）"}</em></p>
          </>
        ) : (
          <p className="lo-hint">今の章（終わりのない章）を入れると、ここに出ます。</p>
        )}
      </section>

      <section className="lo-card">
        <header>
          <strong>6つの領域のバランス</strong>
          <button type="button" className="lo-edit" onClick={() => setScoring(true)}>{hasScore ? "今月の点を直す" : "今月の点をつける"}</button>
        </header>
        <div className="lo-balance">
          <Hexagon now={score} past={past} />
          <ul>
            {AREA_KEYS.map((k) => (
              <li key={k}>
                <b>{AREA_LABEL[k]} {score[k] ?? "–"}{score[k] && past[k] ? (score[k]! > past[k]! ? " ↑" : score[k]! < past[k]! ? " ↓" : "") : ""}</b>
                <small>{facts[k]}</small>
              </li>
            ))}
          </ul>
        </div>
        {!hasScore && <p className="lo-hint">月に1回、6つに1〜5点をつけるだけです。点は自分の感覚で大丈夫。横の数字はアプリの記録から自動で出ます。</p>}
      </section>

      <section className="lo-card">
        <header><strong>大事にしたい順 と 今月の時間の行き先</strong></header>
        <ul className="lo-values">
          {order.map((k, i) => (
            <li key={k}>
              <span>{i + 1}. {AREA_LABEL[k]}</span>
              <i><b style={{ width: `${share(k)}%` }} /></i>
              <small>{share(k)}%</small>
              {i > 0 && (
                <button type="button" aria-label={`${AREA_LABEL[k]}を上へ`} onClick={async () => {
                  const next = [...order];
                  [next[i - 1], next[i]] = [next[i], next[i - 1]];
                  await saveValues(memos, next);
                  syncNow().catch(() => undefined);
                }}><ArrowUp size={13} /></button>
              )}
            </li>
          ))}
        </ul>
        {totalMin > 1 && gap && <p className="lo-gap">{gap.i + 1}位の「{AREA_LABEL[gap.k]}」に使った時間は今月{gap.s}%。{gap.s < 10 ? "いちばん大きいズレです" : "まあまあ使えています"}</p>}
        <p className="lo-hint">時間はタイマーで計った作業から、タスクの名前で領域を推して数えています（仕事以外の言葉がなければ仕事）。</p>
      </section>

      {yearOpen !== null && <YearSheet year={yearOpen} birthday={birthday} memos={memos} onClose={() => setYearOpen(null)} />}
      {editing && <EntriesSheet memos={memos} onClose={() => setEditing(false)} />}
      {scoring && <ScoreSheet memos={memos} month={month} initial={score} onClose={() => setScoring(false)} />}
    </div>
  );
}

function Hexagon({ now, past }: { now: Partial<Record<AreaKey, number>>; past: Partial<Record<AreaKey, number>> }) {
  const R = 52;
  const pt = (i: number, v: number) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    return `${(Math.cos(a) * R * v) / 5},${(Math.sin(a) * R * v) / 5}`;
  };
  const poly = (s: Partial<Record<AreaKey, number>>) => AREA_KEYS.map((k, i) => pt(i, s[k] ?? 0)).join(" ");
  return (
    <svg viewBox="-75 -70 150 140" className="lo-hex" role="img" aria-label="6つの領域の点">
      {[5, 3, 1].map((v) => <polygon key={v} points={AREA_KEYS.map((_, i) => pt(i, v)).join(" ")} className="lo-hex-grid" />)}
      {Object.keys(past).length > 0 && <polygon points={poly(past)} className="lo-hex-past" />}
      {Object.keys(now).length > 0 && <polygon points={poly(now)} className="lo-hex-now" />}
      {AREA_KEYS.map((k, i) => {
        const a = -Math.PI / 2 + (i * Math.PI) / 3;
        return <text key={k} x={Math.cos(a) * 64} y={Math.sin(a) * 64 + 3} textAnchor="middle" className="lo-hex-label">{AREA_LABEL[k]}</text>;
      })}
    </svg>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="modal-sheet ms2" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2 className="qr-title">{title}</h2>
          <button className="icon-button" type="button" aria-label="閉じる" onClick={onClose}><X size={20} /></button>
        </header>
        <div className="form-stack">{children}</div>
      </section>
    </div>,
    document.body,
  );
}

function YearSheet({ year, birthday, memos, onClose }: { year: number; birthday: string; memos: Memo[]; onClose: () => void }) {
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []) || [];
  const sessions = useLiveQuery(() => db.sessions.toArray(), [], []) || [];
  const b = new Date(`${birthday}T00:00:00`);
  const from = new Date(b.getFullYear() + year, b.getMonth(), b.getDate());
  const to = new Date(b.getFullYear() + year + 1, b.getMonth(), b.getDate());
  const fromYm = ym(from);
  const toYm = ym(to);
  const items = lifeEntries(memos).filter((m) => (m.life!.from >= fromYm && m.life!.from < toYm) || (m.life!.kind === "chapter" && m.life!.from < toYm && (!m.life!.to || m.life!.to >= fromYm)));
  const inRange = (iso: string) => { const t = Date.parse(iso); return t >= from.getTime() && t < to.getTime(); };
  const done = tasks.filter((t) => !t.deletedAt && t.status === "done" && t.completedAt && inRange(t.completedAt)).length;
  const workMin = sessions.filter((s) => !s.deletedAt && s.endedAt && inRange(s.startedAt)).reduce((a, s) => a + Math.round((sessionActiveSeconds(s) || 0) / 60), 0);
  const diaries = memos.filter((m) => !m.deletedAt && isDiaryMemo(m) && m.diary?.date && inRange(`${m.diary.date}T12:00:00`)).length;
  const spent = memos.filter((m) => !m.deletedAt && (m.meal || m.expense) && inRange(m.meal?.at || m.expense!.at)).reduce((s, m) => s + amountOf(m), 0);
  const hasData = done + workMin + diaries + spent > 0;
  return (
    <Sheet title={`${year}歳の1年（${from.getFullYear()}年${from.getMonth() + 1}月〜）`} onClose={onClose}>
      {items.length ? (
        <ul className="lo-list">
          {items.map((m) => <li key={m.id}><b>{m.life!.from.replace("-", "/")}</b><span>{KIND_LABEL[m.life!.kind].replace(/（.*）/, "")}：{m.life!.title}</span>{m.life!.note && <small>{m.life!.note}</small>}</li>)}
        </ul>
      ) : <p className="lo-hint">この年の章や出来事はまだありません。</p>}
      {hasData && (
        <div className="lo-mini">
          <div><span>終えたタスク</span><b>{done}件</b></div>
          <div><span>作業</span><b>{Math.round(workMin / 60)}時間</b></div>
          <div><span>日記</span><b>{diaries}日</b></div>
          <div><span>使ったお金</span><b>¥{spent.toLocaleString("ja-JP")}</b></div>
        </div>
      )}
    </Sheet>
  );
}

function EntriesSheet({ memos, onClose }: { memos: Memo[]; onClose: () => void }) {
  const list = lifeEntries(memos);
  const [edit, setEdit] = useState<Memo | null>(null);
  const [kind, setKind] = useState<LifeEntry["kind"]>("chapter");
  const [title, setTitle] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const load = (m: Memo | null) => {
    setEdit(m);
    setKind(m?.life?.kind || "chapter");
    setTitle(m?.life?.title || "");
    setFrom(m?.life?.from || "");
    setTo(m?.life?.to || "");
    setNote(m?.life?.note || "");
    setError("");
  };
  const save = async () => {
    try {
      await saveLifeEntry({ kind, title, from, to: kind === "chapter" ? to || null : null, note, color: edit?.life?.color }, edit || undefined);
      syncNow().catch(() => undefined);
      load(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Sheet title="章・出来事・これからの目印" onClose={onClose}>
      <div className="ms-kinds" role="group" aria-label="種類">
        {(Object.keys(KIND_LABEL) as LifeEntry["kind"][]).map((k) => (
          <button key={k} type="button" className={kind === k ? "active" : ""} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>
        ))}
      </div>
      <label><span>名前</span><input value={title} onChange={(e) => setTitle(e.currentTarget.value)} placeholder={kind === "chapter" ? "例：大学・前の会社・今の仕事" : kind === "event" ? "例：ADHDの診断・引っ越し" : "例：40歳・独立"} maxLength={40} /></label>
      <div className="form-grid">
        <label><span>{kind === "chapter" ? "始まり" : "いつ"}</span><input type="month" value={from} onChange={(e) => setFrom(e.currentTarget.value)} /></label>
        {kind === "chapter" && <label><span>終わり（今の章は空）</span><input type="month" value={to} onChange={(e) => setTo(e.currentTarget.value)} /></label>}
      </div>
      <label><span>{kind === "chapter" ? "この章をどう終わらせたい？／ひとこと" : "ひとこと"}</span><textarea rows={2} value={note} onChange={(e) => setNote(e.currentTarget.value)} maxLength={300} /></label>
      {error && <p className="ml-note">{error}</p>}
      <button type="button" className="button primary" onClick={save}><Plus size={16} /> {edit ? "直す" : "足す"}</button>
      {edit && <button type="button" className="button secondary" onClick={() => load(null)}>やめる（新しく足す）</button>}
      <ul className="lo-list">
        {list.map((m) => (
          <li key={m.id}>
            <b>{m.life!.from.replace("-", "/")}{m.life!.kind === "chapter" ? `〜${m.life!.to ? m.life!.to.replace("-", "/") : "今"}` : ""}</b>
            <span>{KIND_LABEL[m.life!.kind].replace(/（.*）/, "")}：{m.life!.title}</span>
            <span className="lo-row-actions">
              <button type="button" aria-label="直す" onClick={() => load(m)}><Pencil size={14} /></button>
              <button type="button" aria-label="消す" onClick={async () => { await removeLifeEntry(m); syncNow().catch(() => undefined); }}><Trash2 size={14} /></button>
            </span>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

function ScoreSheet({ memos, month, initial, onClose }: { memos: Memo[]; month: string; initial: Partial<Record<AreaKey, number>>; onClose: () => void }) {
  const [scores, setScores] = useState<Partial<Record<AreaKey, number>>>(initial);
  return (
    <Sheet title={`${Number(month.slice(5))}月の点（1〜5）`} onClose={onClose}>
      <p className="lo-hint">今の感覚で。5＝満足、1＝かなり困っている。</p>
      {AREA_KEYS.map((k) => (
        <div key={k} className="lo-score-row">
          <span>{AREA_LABEL[k]}</span>
          <div>
            {[1, 2, 3, 4, 5].map((v) => (
              <button key={v} type="button" className={scores[k] === v ? "active" : ""} onClick={() => setScores({ ...scores, [k]: v })}>{v}</button>
            ))}
          </div>
        </div>
      ))}
      <button type="button" className="button primary" onClick={async () => { await saveScores(memos, month, scores); syncNow().catch(() => undefined); onClose(); }}>保存</button>
    </Sheet>
  );
}
