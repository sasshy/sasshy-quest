import { describe, expect, it } from "vitest";
import { buildDayRunway, type RunwayInput } from "./day-runway";

const task = (overrides: Partial<RunwayInput>): RunwayInput => ({
  id: "task",
  title: "task",
  durationMin: 20,
  fixed: false,
  startMinute: null,
  kind: "task",
  ...overrides,
});

describe("buildDayRunway", () => {
  it("never moves a fixed anchor", () => {
    const plan = buildDayRunway([
      task({ id: "work", durationMin: 20 }),
      task({ id: "meeting", fixed: true, startMinute: 10 * 60, durationMin: 30 }),
    ], { nowMinute: 9 * 60 });
    expect(plan.entries.find((entry) => entry.id === "meeting")?.startMinute).toBe(600);
  });

  it("moves work after an anchor when it does not fit safely", () => {
    const plan = buildDayRunway([
      task({ id: "work", durationMin: 20 }),
      task({ id: "meeting", fixed: true, startMinute: 10 * 60, durationMin: 30 }),
    ], { nowMinute: 9 * 60 + 40, preparationMin: 10 });
    expect(plan.entries.find((entry) => entry.id === "work")?.startMinute).toBe(640);
  });

  it("reports usable time before the next anchor", () => {
    const plan = buildDayRunway([
      task({ id: "meeting", fixed: true, startMinute: 11 * 60, durationMin: 30 }),
    ], { nowMinute: 10 * 60, preparationMin: 10 });
    expect(plan.usableBeforeNext).toBe(50);
  });

  it("fits small work before the next anchor", () => {
    const plan = buildDayRunway([
      task({ id: "small", durationMin: 15 }),
      task({ id: "meeting", fixed: true, startMinute: 10 * 60, durationMin: 30 }),
    ], { nowMinute: 9 * 60 + 30, preparationMin: 10 });
    expect(plan.entries.find((entry) => entry.id === "small")?.startMinute).toBe(570);
  });
});
