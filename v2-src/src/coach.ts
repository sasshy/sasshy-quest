import type { FocusSession, GoogleCalendarEvent, Task, VoiceConfig } from './types';
import type { NativeCoachPrompt } from './native-alarm';

type CoachPlanInput = {
  now: Date;
  tasks: Task[];
  activeSession?: FocusSession;
  googleEvents?: GoogleCalendarEvent[];
  voice: VoiceConfig;
};

type Anchor = {
  id: string;
  title: string;
  start: Date;
};

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function atMinute(dateKey: string, minute: number): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day, Math.floor(minute / 60), minute % 60, 0, 0);
}

function clock(date: Date): string {
  return `${date.getHours()}時${date.getMinutes() ? `${date.getMinutes()}分` : ''}`;
}

function isSpeakingHour(date: Date): boolean {
  const minute = date.getHours() * 60 + date.getMinutes();
  return minute >= 8 * 60 && minute <= 21 * 60;
}

export function inferPreparationMinutes(title: string, fallback = 20): number {
  if (/(空港|飛行機|新幹線|電車|列車|予約|乗車|出発)/i.test(title)) return 75;
  if (/(通院|病院|医院|クリニック|歯医者|診察|受診)/i.test(title)) return 60;
  if (/(買い物|外出|訪問|役所|銀行|美容院|待ち合わせ)/i.test(title)) return 45;
  if (/(zoom|meet|teams|オンライン|web会議|電話)/i.test(title)) return 10;
  if (/(家事|掃除|洗濯|片付け|料理)/i.test(title)) return 15;
  return Math.min(180, Math.max(5, Math.round(fallback)));
}

function taskAnchors(tasks: Task[], today: string): Anchor[] {
  return tasks.flatMap((task) => {
    if (
      task.deletedAt ||
      task.status === 'done' ||
      task.status === 'archived' ||
      task.scheduledDate !== today ||
      task.startMinute === null ||
      task.isFixed === false
    ) return [];
    return [{ id: `task-${task.id}`, title: task.title, start: atMinute(today, task.startMinute) }];
  });
}

function calendarAnchors(events: GoogleCalendarEvent[], today: string): Anchor[] {
  return events.flatMap((event) => {
    if (event.allDay || !event.start || event.start.slice(0, 10) !== today) return [];
    const start = new Date(event.start);
    if (Number.isNaN(start.getTime())) return [];
    return [{ id: `calendar-${event.id}`, title: event.title, start }];
  });
}

export function buildCoachPlan({
  now,
  tasks,
  activeSession,
  googleEvents = [],
  voice,
}: CoachPlanInput): NativeCoachPrompt[] {
  if (!voice.enabled || voice.coachEnabled === false) return [];
  const today = localDateKey(now);
  const remaining = tasks.filter((task) =>
    !task.deletedAt &&
    task.status !== 'done' &&
    task.status !== 'archived' &&
    task.scheduledDate === today,
  );
  const anchors = [...taskAnchors(tasks, today), ...calendarAnchors(googleEvents, today)]
    .filter((anchor) => anchor.start.getTime() > now.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const prompts: NativeCoachPrompt[] = [];

  for (const anchor of anchors.slice(0, 2)) {
    const prepMin = inferPreparationMinutes(
      anchor.title,
      voice.defaultPreparationMin ?? 20,
    );
    const fireAt = new Date(anchor.start.getTime() - prepMin * 60_000);
    if (fireAt.getTime() <= now.getTime() + 60_000 || !isSpeakingHour(fireAt)) continue;
    const spokenText = `${clock(anchor.start)}から${anchor.title}。あと${prepMin}分です。そろそろ今の作業を閉じて、準備を始めますか？`;
    prompts.push({
      id: `${today}-prepare-${anchor.id}-${anchor.start.getTime()}`,
      fireAt: fireAt.toISOString(),
      title: `次は ${anchor.title}`,
      body: `${clock(anchor.start)}開始・準備まであと${prepMin}分`,
      spokenText,
    });
  }

  if (!activeSession && remaining.length) {
    const checkSlots = [10 * 60 + 30, 14 * 60, 17 * 60 + 30, 19 * 60 + 30];
    const slot = checkSlots
      .map((minute) => atMinute(today, minute))
      .find((date) => date.getTime() > now.getTime() + 30 * 60_000);
    if (slot) {
      const next = remaining
        .filter((task) => task.startMinute === null || task.isFixed === false)
        .sort((a, b) => (a.flowOrder ?? 9999) - (b.flowOrder ?? 9999))[0];
      const nextPhrase = next ? `次は${next.title}を5分だけ始めますか？` : '次に何をしたいか、一度確認しますか？';
      prompts.push({
        id: `${today}-gentle-check-${slot.getHours()}${slot.getMinutes()}`,
        fireAt: slot.toISOString(),
        title: '今日の流れをひと呼吸だけ確認',
        body: `今日はあと${remaining.length}件です`,
        spokenText: `少しだけ確認です。今日はあと${remaining.length}件。${nextPhrase}`,
      });
    }
  }

  return prompts
    .sort((a, b) => a.fireAt.localeCompare(b.fireAt))
    .filter((prompt, index, all) => {
      if (index === 0) return true;
      return new Date(prompt.fireAt).getTime() - new Date(all[index - 1].fireAt).getTime() >= 20 * 60_000;
    })
    .slice(0, 3);
}

export function completionCoachText(
  tasks: Task[],
  completedTaskId: string,
  now = new Date(),
): string {
  const today = localDateKey(now);
  const remaining = tasks.filter((task) =>
    task.id !== completedTaskId &&
    !task.deletedAt &&
    task.status !== 'done' &&
    task.status !== 'archived' &&
    task.scheduledDate === today,
  );
  if (!remaining.length) {
    return 'おつかれさま。今日入っている予定はここまでです。ほかにやりたいことはありますか？';
  }
  const nowMinute = now.getHours() * 60 + now.getMinutes();
  const nextFixed = remaining
    .filter((task) => task.startMinute !== null && task.startMinute >= nowMinute && task.isFixed !== false)
    .sort((a, b) => (a.startMinute ?? 9999) - (b.startMinute ?? 9999))[0];
  const nextFlexible = remaining
    .filter((task) => task.startMinute === null || task.isFixed === false)
    .sort((a, b) => (a.flowOrder ?? 9999) - (b.flowOrder ?? 9999))[0];
  if (nextFixed) {
    return `おつかれさま。今日はあと${remaining.length}件。${clock(atMinute(today, nextFixed.startMinute!))}から${nextFixed.title}があります。その前に少し休みますか、それとも次を5分だけ進めますか？`;
  }
  if (nextFlexible) {
    return `おつかれさま。今日はあと${remaining.length}件。次は${nextFlexible.title}を5分だけ始めますか、それとも少し休みますか？`;
  }
  return `おつかれさま。今日はあと${remaining.length}件です。次の予定を一度確認しますか？`;
}
