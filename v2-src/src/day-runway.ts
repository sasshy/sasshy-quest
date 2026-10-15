export type RunwayKind = "task" | "calendar";

export interface RunwayInput {
  id: string;
  title: string;
  durationMin: number;
  fixed: boolean;
  startMinute: number | null;
  kind: RunwayKind;
}

export interface RunwayEntry extends RunwayInput {
  startMinute: number;
  endMinute: number;
  conflict: boolean;
}

export interface RunwayPlan {
  entries: RunwayEntry[];
  nextAnchor: RunwayEntry | null;
  usableBeforeNext: number;
  totalFlexibleMin: number;
  bufferedFlexibleMin: number;
  finishMinute: number;
  overflowMin: number;
}

export interface RunwayOptions {
  nowMinute: number;
  dayEndMinute?: number;
  preparationMin?: number;
}

function transitionMin(durationMin: number): number {
  return Math.min(5, Math.max(2, Math.ceil(durationMin * 0.2)));
}

/**
 * Places flexible work around fixed anchors. Anchors are never pushed; a task
 * that cannot safely finish before the next anchor is placed after it.
 */
export function buildDayRunway(
  inputs: RunwayInput[],
  options: RunwayOptions,
): RunwayPlan {
  const dayEndMinute = options.dayEndMinute ?? 22 * 60;
  const preparationMin = options.preparationMin ?? 10;
  const nowMinute = Math.max(0, Math.floor(options.nowMinute));
  const anchors = inputs
    .filter((input) => input.fixed && input.startMinute !== null)
    .map((input) => ({
      ...input,
      startMinute: input.startMinute as number,
      endMinute: (input.startMinute as number) + Math.max(1, input.durationMin),
      conflict: false,
    }))
    .sort((a, b) => a.startMinute - b.startMinute || a.id.localeCompare(b.id));
  const flexible = inputs.filter((input) => !input.fixed || input.startMinute === null);
  const nextAnchor = anchors.find((anchor) => anchor.startMinute >= nowMinute) || null;
  const usableBeforeNext = Math.max(
    0,
    (nextAnchor?.startMinute ?? dayEndMinute) - nowMinute - (nextAnchor ? preparationMin : 0),
  );
  const totalFlexibleMin = flexible.reduce(
    (sum, input) => sum + Math.max(1, input.durationMin),
    0,
  );
  const bufferedFlexibleMin = flexible.reduce(
    (sum, input) => sum + Math.max(1, input.durationMin) + transitionMin(input.durationMin),
    0,
  );

  let cursor = Math.ceil(nowMinute / 5) * 5;
  let anchorIndex = 0;
  const entries: RunwayEntry[] = [];
  const addElapsedAnchors = () => {
    while (anchorIndex < anchors.length && anchors[anchorIndex].endMinute <= cursor) {
      const anchor = anchors[anchorIndex];
      entries.push({ ...anchor, conflict: anchor.startMinute < nowMinute });
      cursor = Math.max(cursor, anchor.endMinute + preparationMin);
      anchorIndex += 1;
    }
  };

  addElapsedAnchors();
  for (const input of flexible) {
    const durationMin = Math.max(1, input.durationMin);
    const transition = transitionMin(durationMin);
    while (anchorIndex < anchors.length) {
      const anchor = anchors[anchorIndex];
      if (cursor >= anchor.endMinute) {
        entries.push({ ...anchor, conflict: cursor > anchor.startMinute });
        cursor = Math.max(cursor, anchor.endMinute + preparationMin);
        anchorIndex += 1;
        continue;
      }
      if (cursor + durationMin <= anchor.startMinute - preparationMin) break;
      entries.push({ ...anchor, conflict: cursor > anchor.startMinute });
      cursor = Math.max(cursor, anchor.endMinute + preparationMin);
      anchorIndex += 1;
    }
    entries.push({
      ...input,
      startMinute: cursor,
      endMinute: cursor + durationMin,
      conflict: false,
    });
    cursor += durationMin + transition;
  }

  while (anchorIndex < anchors.length) {
    const anchor = anchors[anchorIndex];
    entries.push({ ...anchor, conflict: cursor > anchor.startMinute });
    cursor = Math.max(cursor, anchor.endMinute + preparationMin);
    anchorIndex += 1;
  }
  entries.sort((a, b) => a.startMinute - b.startMinute || Number(b.fixed) - Number(a.fixed));
  const finishMinute = entries.length
    ? Math.max(...entries.map((entry) => entry.endMinute))
    : nowMinute;

  return {
    entries,
    nextAnchor,
    usableBeforeNext,
    totalFlexibleMin,
    bufferedFlexibleMin,
    finishMinute,
    overflowMin: Math.max(0, finishMinute - dayEndMinute),
  };
}
