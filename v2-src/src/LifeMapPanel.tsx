import { useState } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { Check, Pin, PinOff, Plus, Trash2, X } from "lucide-react";
import { db } from "./db";
import { createTask } from "./store";
import { syncNow } from "./sync";
import { DEFAULT_TIME_LEFT, ageOn, daysLived, getTimeLeft } from "./timeleft";
import { localDateKey } from "./meals";
import {
  AREA_KEYS,
  AREA_LABEL,
  MAX_PINNED,
  addAttempt,
  areaOf,
  canPin,
  createWish,
  pinnedWishes,
  removeAttempt,
  saveArea,
  updateWish,
  wishes,
} from "./wishes";
import type { AreaKey, Memo } from "./types";

const LIFE_YEARS = 80;
const STATUS_LABEL = { active: "やりたい", resting: "寝かせる", done: "できた" } as const;

/** Start a wish's next step as a 2-minute try: it becomes a task for today and counts as one try. */
async function tryWishNow(memo: Memo): Promise<void> {
  const step = memo.wish!.next.trim() || memo.title;
  const task = await createTask({ title: step, notes: `やりたいこと：${memo.title}`, scheduledDate: localDateKey(Date.now()), estimateMin: 15, durationMin: 15 });
  await addAttempt(memo, "2分だけやった");
  window.dispatchEvent(new CustomEvent("sasshy-start-task", { detail: { id: task.id, starter: true } }));
  syncNow().catch(() => undefined);
}

function WeeksGrid({ birthday, now }: { birthday: string; now: Date }) {
  const age = ageOn(birthday, now) ?? 0;
  const b = new Date(`${birthday}T00:00:00`);
  const lastBirthday = new Date(b.getFullYear() + age, b.getMonth(), b.getDate());
  const weeksInto = Math.min(52, Math.floor((now.getTime() - lastBirthday.getTime()) / (7 * 86_400_000)));
  const rows = Array.from({ length: LIFE_YEARS }, (_, year) => {
    if (year < age) return { past: 100, now: 0 };
    if (year === age) return { past: (weeksInto / 52) * 100, now: ((52 - weeksInto) / 52) * 100 };
    return { past: 0, now: 0 };
  });
  const lived = daysLived(birthday, now) ?? 0;
  return (
    <section className="lm-weeks" aria-label="人生を週で見る">
      <header>
        <h2>人生を週で見る</h2>
        <small>1マス＝1週・1行＝1年（{LIFE_YEARS}歳まで）</small>
      </header>
      <div className="lm-grid-wrap">
        <div className="lm-ages" aria-hidden="true">{[0, 20, 40, 60, 80].map((a) => <span key={a}>{a}</span>)}</div>
        <div className="lm-grid" role="img" aria-label={`過ごした週 ${Math.floor(lived / 7)}週、${age + 1}歳までの残り ${52 - weeksInto}週`}>
          {rows.map((r, i) => (
            <div key={i} className="lm-row">
              <i className="lm-past" style={{ width: `${r.past}%` }} />
              <i className="lm-now" style={{ width: `${r.now}%` }} />
            </div>
          ))}
        </div>
      </div>
      <div className="lm-legend">
        <span><b className="lm-past" />過ごした {Math.floor(lived / 7).toLocaleString("ja-JP")}週</span>
        <span><b className="lm-now" />{age + 1}歳までの {52 - weeksInto}週</span>
        <span><b />これから</span>
      </div>
    </section>
  );
}

function WishCard({ memo, onOpen }: { memo: Memo; onOpen: () => void }) {
  const w = memo.wish!;
  const tries = w.attempts.length;
  return (
    <div className="wish-card">
      <button type="button" className="wish-main" onClick={onOpen}>
        <strong>{memo.title}</strong>
        <span className="wish-count">{w.target ? `${Math.min(tries, w.target)}/${w.target}` : `試した ${tries}回`}</span>
      </button>
      {w.target ? (
        <div className="wish-dots" aria-hidden="true">
          {Array.from({ length: Math.min(w.target, 20) }, (_, i) => <i key={i} className={i < tries ? "on" : ""} />)}
        </div>
      ) : null}
      <div className="wish-next">
        <small>{w.next ? `次の一歩：${w.next}` : "次の一歩はまだ（タップして書く）"}</small>
        <button type="button" className="wish-try" onClick={() => tryWishNow(memo)}>2分だけ</button>
      </div>
    </div>
  );
}

function WishSheet({ memo, memos, onClose }: { memo: Memo; memos: Memo[]; onClose: () => void }) {
  const w = memo.wish!;
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const save = async (form: FormData) => {
    const target = String(form.get("target") || "").replace(/[^0-9]/g, "");
    await updateWish(memo, {
      title: String(form.get("title") || ""),
      body: String(form.get("body") || ""),
      next: String(form.get("next") || "").trim().slice(0, 120),
      target: target ? Math.min(999, Number(target)) : null,
    });
    syncNow().catch(() => undefined);
    onClose();
  };
  const togglePin = async () => {
    if (!w.pinned && !canPin(memos, memo)) {
      setError(`上に出せるのは${MAX_PINNED}つまでです。どれかを外してください`);
      return;
    }
    await updateWish(memo, { pinned: !w.pinned });
    syncNow().catch(() => undefined);
  };
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="modal-sheet ms2 wish-sheet" role="dialog" aria-modal="true" aria-labelledby="wish-title">
        <header>
          <h2 id="wish-title">やりたいこと</h2>
          <button className="icon-button" type="button" aria-label="閉じる" onClick={onClose}><X size={20} /></button>
        </header>
        <form className="form-stack" onSubmit={(e) => { e.preventDefault(); save(new FormData(e.currentTarget)); }}>
          <input name="title" className="ms-item" defaultValue={memo.title} aria-label="やりたいこと" />
          <label className="re-field"><span>次の一歩（5〜15分でできる行動）</span><input name="next" defaultValue={w.next} placeholder="例：今週末の上映を1本えらぶ" /></label>
          <div className="re-two">
            <label className="re-field"><span>回数の目標（任意）</span><input name="target" inputMode="numeric" defaultValue={w.target ?? ""} placeholder="例：5" /></label>
            <div className="re-field"><span>上に出す</span>
              <button type="button" className={`wish-pin${w.pinned ? " on" : ""}`} onClick={togglePin}>
                {w.pinned ? <><Pin size={15} /> 出している</> : <><PinOff size={15} /> 出していない</>}
              </button>
            </div>
          </div>
          <label className="re-field"><span>メモ・理由・調べたこと</span><textarea name="body" defaultValue={memo.body} rows={3} /></label>
          <div className="ms-chips" role="group" aria-label="状態">
            {(Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[]).map((s) => (
              <button key={s} type="button" className={`ms-chip${w.status === s ? " picked" : ""}`} onClick={() => updateWish(memo, { status: s, ...(s !== "active" ? { pinned: false } : {}) })}>
                <span>{STATUS_LABEL[s]}</span>
              </button>
            ))}
          </div>
          {error && <p className="re-error" role="alert">{error}</p>}
          <button className="button primary re-save" type="submit">保存</button>
        </form>
        <div className="form-stack wish-log">
          <span className="meal-label">試した記録（{w.attempts.length}回）</span>
          <form className="wish-add" onSubmit={async (e) => {
            e.preventDefault();
            const typed = String(new FormData(e.currentTarget).get("note") || "");
            await addAttempt(memo, typed);
            setNote("");
            syncNow().catch(() => undefined);
          }}>
            <input name="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="何をした？（空でもOK）" />
            <button className="button secondary" type="submit"><Plus size={16} /> 1回</button>
          </form>
          <ul>
            {[...w.attempts].map((a, i) => ({ a, i })).reverse().map(({ a, i }) => (
              <li key={`${a.at}-${i}`}>
                <time>{new Date(a.at).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })}</time>
                <span>{a.note || "やった"}</span>
                <button type="button" aria-label="この記録を消す" onClick={() => removeAttempt(memo, i)}><Trash2 size={14} /></button>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function AreaSheet({ areaKey, memos, onClose }: { areaKey: AreaKey; memos: Memo[]; onClose: () => void }) {
  const current = areaOf(memos, areaKey)?.area;
  const [tone, setTone] = useState<"good" | "watch" | null>(current?.tone ?? null);
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="modal-sheet ms2" role="dialog" aria-modal="true" aria-labelledby="area-title">
        <header>
          <h2 id="area-title">{AREA_LABEL[areaKey]}</h2>
          <button className="icon-button" type="button" aria-label="閉じる" onClick={onClose}><X size={20} /></button>
        </header>
        <form className="form-stack" onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          await saveArea(memos, areaKey, { state: String(f.get("state") || ""), next: String(f.get("next") || ""), tone });
          syncNow().catch(() => undefined);
          onClose();
        }}>
          <label className="re-field"><span>いまの状態</span><input name="state" defaultValue={current?.state || ""} placeholder="例：赤字ぎみ・保険の書類待ち" /></label>
          <label className="re-field"><span>次の一歩</span><input name="next" defaultValue={current?.next || ""} placeholder="例：書類を土曜に記入する" /></label>
          <div className="ms-chips" role="group" aria-label="調子">
            <button type="button" className={`ms-chip${tone === "good" ? " picked" : ""}`} onClick={() => setTone("good")}><span>順調</span></button>
            <button type="button" className={`ms-chip${tone === "watch" ? " picked" : ""}`} onClick={() => setTone("watch")}><span>気になる</span></button>
            <button type="button" className={`ms-chip${tone === null ? " picked" : ""}`} onClick={() => setTone(null)}><span>どちらでもない</span></button>
          </div>
          <button className="button primary re-save" type="submit">保存</button>
        </form>
      </section>
    </div>,
    document.body,
  );
}

/** 地図: life in weeks, the (up to 3) pinned wishes, the full wish list, and 6 life areas. */
export function LifeMapPanel() {
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const setting = useLiveQuery(async () => { await db.settings.get("timeLeft"); return getTimeLeft(); }, [], DEFAULT_TIME_LEFT) || DEFAULT_TIME_LEFT;
  const now = new Date();
  const age = ageOn(setting.birthday, now) ?? 0;
  const b = new Date(`${setting.birthday}T00:00:00`);
  let nextBirthday = new Date(now.getFullYear(), b.getMonth(), b.getDate());
  if (nextBirthday.getTime() <= new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) nextBirthday = new Date(now.getFullYear() + 1, b.getMonth(), b.getDate());
  const daysToBirthday = Math.floor((nextBirthday.getTime() - now.getTime()) / 86_400_000);
  const pinned = pinnedWishes(memos);
  const all = wishes(memos);
  const [openId, setOpenId] = useState<string | null>(null);
  const [areaKey, setAreaKey] = useState<AreaKey | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [draft, setDraft] = useState("");
  const open = all.find((m) => m.id === openId) || null;
  const groups = (["active", "resting", "done"] as const).map((s) => ({ s, list: all.filter((m) => m.wish!.status === s) }));

  return (
    <div className="page-content life-map">
      <div className="lm-head">
        <strong>{age}歳</strong>
        <span>{age + 1}歳まであと{daysToBirthday}日</span>
      </div>
      <WeeksGrid birthday={setting.birthday} now={now} />

      <section className="lm-card">
        <header>
          <h2>{age + 1}歳のうちにやる</h2>
          <small>数えるのは「試した回数」</small>
        </header>
        {pinned.length ? pinned.map((m) => <WishCard key={m.id} memo={m} onOpen={() => setOpenId(m.id)} />) : (
          <p className="lm-empty">下の「やりたいことリスト」から、{MAX_PINNED}つまで選んで上に出せます。</p>
        )}
      </section>

      <section className="lm-card">
        <header>
          <h2>やりたいことリスト</h2>
          <small>{all.length}件</small>
        </header>
        <form className="wish-add" onSubmit={async (e) => {
          e.preventDefault();
          const typed = String(new FormData(e.currentTarget).get("wish") || "");
          if (!typed.trim()) return;
          const created = await createWish(typed, pinned.length < MAX_PINNED && all.length < MAX_PINNED);
          setDraft("");
          setOpenId(created.id);
          syncNow().catch(() => undefined);
        }}>
          <input name="wish" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="やりたいこと（小さくても大きくても）" />
          <button className="button primary" type="submit" aria-label="追加"><Plus size={18} /></button>
        </form>
        {groups.map(({ s, list }) => list.length > 0 && (s === "active" || showAll) && (
          <div key={s} className="wish-group">
            <span className="meal-label">{STATUS_LABEL[s]}（{list.length}）</span>
            <ul className="wish-list">
              {list.map((m) => (
                <li key={m.id}>
                  <button type="button" onClick={() => setOpenId(m.id)}>
                    {m.wish!.pinned ? <Pin size={14} className="wish-pinned" aria-label="上に出している" /> : s === "done" ? <Check size={14} aria-hidden="true" /> : <span className="wish-bullet" aria-hidden="true" />}
                    <span>{m.title}</span>
                    <small>{m.wish!.attempts.length ? `${m.wish!.attempts.length}回` : ""}</small>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {(groups[1].list.length > 0 || groups[2].list.length > 0) && (
          <button type="button" className="ms-link" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "寝かせた・できたを隠す" : `寝かせた・できたも見る（${groups[1].list.length + groups[2].list.length}）`}
          </button>
        )}
      </section>

      <section className="lm-card">
        <header>
          <h2>6つの領域</h2>
          <small>タップして書く</small>
        </header>
        <div className="lm-areas">
          {AREA_KEYS.map((key) => {
            const a = areaOf(memos, key)?.area;
            return (
              <button key={key} type="button" className={`lm-area${a?.tone ? ` ${a.tone}` : ""}`} onClick={() => setAreaKey(key)}>
                <strong><i aria-hidden="true" />{AREA_LABEL[key]}</strong>
                <small>{a?.state || "まだ書いていない"}</small>
                {a?.next && <small className="lm-area-next">次：{a.next}</small>}
              </button>
            );
          })}
        </div>
      </section>

      {open && <WishSheet memo={open} memos={memos} onClose={() => setOpenId(null)} />}
      {areaKey && <AreaSheet areaKey={areaKey} memos={memos} onClose={() => setAreaKey(null)} />}
    </div>
  );
}

