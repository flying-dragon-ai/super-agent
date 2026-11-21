import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY_RECHECK_MS, DAY_TURN_MARGIN_MS, createLocalDay, localDayKey, msUntilNextLocalDay } from "../client/src/local-day.js";

// Instants are built from local calendar fields, so the cases hold in whatever
// zone the suite runs in. The daylight-saving cases name their zone explicitly.
const local = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0) => new Date(year, month - 1, day, hour, minute, second, ms).getTime();
const HOUR = 3_600_000;
const wakeSignals = [["document", "visibilitychange"], ["document", "resume"], ["window", "focus"], ["window", "pageshow"]] as const;

/** Runs `check` with the process in another IANA zone and proves the switch took effect. */
function inZone(zone: string, check: () => void) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
    check();
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
}

describe("local calendar day arithmetic", () => {
  it("names a day by its local date and measures the wait to the next local midnight", () => {
    expect(localDayKey(local(2026, 11, 17, 15, 30))).toBe(20261117);
    expect(localDayKey(local(2026, 11, 17, 23, 59, 59, 999))).toBe(20261117);
    expect(localDayKey(local(2026, 11, 18))).toBe(20261118);
    expect(msUntilNextLocalDay(local(2026, 11, 17, 23, 59, 59, 999))).toBe(1);
    expect(msUntilNextLocalDay(local(2026, 11, 17, 23, 59, 30))).toBe(30_000);
    // Month and year ends roll over through the date parts.
    expect(localDayKey(local(2026, 12, 31, 23, 59, 59, 999) + 1)).toBe(20270101);
    expect(msUntilNextLocalDay(local(2026, 12, 31, 23, 0))).toBe(HOUR);
    expect(localDayKey(local(2028, 2, 28, 23, 59, 59, 999) + 1)).toBe(20280229);
  });

  it("follows daylight-saving days that last 23 or 25 hours", () => inZone("America/New_York", () => {
    // 8 March 2026 skips 02:00-03:00; 1 November 2026 repeats 01:00-02:00.
    expect(msUntilNextLocalDay(local(2026, 3, 8))).toBe(23 * HOUR);
    expect(msUntilNextLocalDay(local(2026, 11, 1))).toBe(25 * HOUR);
    expect(msUntilNextLocalDay(local(2026, 3, 7))).toBe(24 * HOUR);
    for (const start of [local(2026, 3, 8), local(2026, 11, 1)]) {
      const wait = msUntilNextLocalDay(start);
      expect(localDayKey(start + wait - 1)).toBe(localDayKey(start));
      expect(localDayKey(start + wait)).not.toBe(localDayKey(start));
    }
    // Adding 24 hours instead would turn the day an hour late, or an hour early.
    expect(localDayKey(local(2026, 3, 8) + 24 * HOUR - 1)).toBe(20260309);
    expect(localDayKey(local(2026, 11, 1) + 24 * HOUR)).toBe(20261101);
  }));

  it("starts the day at the first instant that exists where the clocks change at midnight", () => inZone("America/Havana", () => {
    // 8 March 2026 has no 00:00-01:00 in Havana: 23:59:59 is followed by 01:00.
    const lateEvening = local(2026, 3, 7, 23, 0);
    expect(msUntilNextLocalDay(lateEvening)).toBe(HOUR);
    expect(localDayKey(lateEvening + HOUR - 1)).toBe(20260307);
    expect(localDayKey(lateEvening + HOUR)).toBe(20260308);
    expect(new Date(lateEvening + HOUR).getHours()).toBe(1);
  }));

  it("keeps waiting through an evening hour that the clocks repeat before midnight", () => inZone("America/Santiago", () => {
    // 4 April 2026 runs 23:00-24:00 twice in Santiago before 5 April begins.
    const firstPass = local(2026, 4, 4, 22, 30) + HOUR;
    expect(new Date(firstPass).getHours()).toBe(23);
    expect(msUntilNextLocalDay(firstPass)).toBe(HOUR + HOUR / 2);
    expect(localDayKey(firstPass + HOUR)).toBe(20260404);
    expect(localDayKey(firstPass + HOUR + HOUR / 2)).toBe(20260405);
  }));
});

describe("shared local-day source", () => {
  let win: EventTarget, doc: EventTarget;
  const target = (name: "window" | "document") => name === "window" ? win : doc;
  beforeEach(() => {
    vi.useFakeTimers();
    win = new EventTarget(); doc = new EventTarget();
    vi.stubGlobal("window", win); vi.stubGlobal("document", doc);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("tells every subscriber once, just after local midnight, from a single timer that re-arms itself", () => {
    vi.setSystemTime(local(2026, 11, 17, 23, 59, 30));
    const day = createLocalDay(), first = vi.fn(), second = vi.fn();
    expect(vi.getTimerCount()).toBe(0);
    day.subscribe(first); day.subscribe(second);
    expect(vi.getTimerCount()).toBe(1);
    expect(day.read()).toBe(20261117);
    vi.advanceTimersByTime(30_000 + DAY_TURN_MARGIN_MS - 1);
    // 00:00:00.999: the day has turned, the margin has not elapsed yet.
    expect(first).not.toHaveBeenCalled(); expect(day.read()).toBe(20261117);
    vi.advanceTimersByTime(1);
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
    expect(day.read()).toBe(20261118);
    expect(vi.getTimerCount()).toBe(1);
    // The rest of the day brings no further notification; the next midnight does.
    vi.advanceTimersByTime(msUntilNextLocalDay(Date.now()) - 1);
    expect(first).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1 + DAY_TURN_MARGIN_MS);
    expect(first).toHaveBeenCalledTimes(2); expect(second).toHaveBeenCalledTimes(2);
    expect(day.read()).toBe(20261119);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("waits again when the timer fires before the day has turned", () => {
    vi.setSystemTime(local(2026, 11, 17, 23, 59, 30));
    const day = createLocalDay(), listener = vi.fn();
    day.subscribe(listener);
    vi.advanceTimersByTime(30_500);
    // The clock is corrected two seconds back, so the pending timer now fires at 23:59:59.000.
    vi.setSystemTime(Date.now() - 2000);
    vi.advanceTimersByTime(500);
    expect(new Date().getDate()).toBe(17);
    expect(listener).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000 + DAY_TURN_MARGIN_MS - 1);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1); expect(day.read()).toBe(20261118);
  });

  it.each(wakeSignals)("compares the day when the App comes back (%s %s) instead of trusting the timer", (owner, signal) => {
    vi.setSystemTime(local(2026, 11, 17, 22, 0));
    const day = createLocalDay(), listener = vi.fn();
    day.subscribe(listener);
    // Asleep or suspended overnight: the clock moved on, the timer did not fire.
    vi.setSystemTime(local(2026, 11, 18, 7, 30));
    expect(listener).not.toHaveBeenCalled(); expect(day.read()).toBe(20261117);
    target(owner).dispatchEvent(new Event(signal));
    expect(listener).toHaveBeenCalledTimes(1); expect(day.read()).toBe(20261118);
    // Coming back again on the same day changes nothing.
    for (const [again, name] of wakeSignals) target(again).dispatchEvent(new Event(name));
    expect(listener).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(1);
    // The timer was re-armed from the new time: nothing more until the following midnight.
    vi.advanceTimersByTime(msUntilNextLocalDay(Date.now()) - 1);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1 + DAY_TURN_MARGIN_MS);
    expect(listener).toHaveBeenCalledTimes(2); expect(day.read()).toBe(20261119);
  });

  it("follows a clock or time zone that moves back to the previous day", () => {
    vi.setSystemTime(local(2026, 11, 18, 0, 30));
    const day = createLocalDay(), listener = vi.fn();
    day.subscribe(listener);
    vi.setSystemTime(local(2026, 11, 17, 23, 50));
    win.dispatchEvent(new Event("focus"));
    expect(listener).toHaveBeenCalledTimes(1); expect(day.read()).toBe(20261117);
    vi.advanceTimersByTime(10 * 60_000 + DAY_TURN_MARGIN_MS);
    expect(listener).toHaveBeenCalledTimes(2); expect(day.read()).toBe(20261118);
  });

  it("notices within a minute a day change that no event announced", () => {
    vi.setSystemTime(local(2026, 11, 17, 12, 0));
    const day = createLocalDay(), listener = vi.fn();
    day.subscribe(listener);
    // The whole afternoon passes without a notification or a second timer.
    vi.advanceTimersByTime(6 * HOUR);
    expect(listener).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1);
    // A sleep without a wake event, or a new time zone while the App stays in front.
    vi.setSystemTime(local(2026, 11, 18, 9, 0));
    vi.advanceTimersByTime(DAY_RECHECK_MS);
    expect(listener).toHaveBeenCalledTimes(1); expect(day.read()).toBe(20261118);
  });

  it("keeps the schedule when a subscriber throws", () => {
    vi.setSystemTime(local(2026, 11, 17, 23, 59, 59));
    const day = createLocalDay(), listener = vi.fn(() => { throw new Error("render failed"); });
    day.subscribe(listener);
    expect(() => vi.advanceTimersByTime(1000 + DAY_TURN_MARGIN_MS)).toThrow("render failed");
    expect(listener).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(1);
  });

  it("removes its timer and wake listeners when the last subscriber leaves, and starts fresh for the next", () => {
    vi.setSystemTime(local(2026, 11, 17, 23, 0));
    const added = [vi.spyOn(win, "addEventListener"), vi.spyOn(doc, "addEventListener")];
    const removed = [vi.spyOn(win, "removeEventListener"), vi.spyOn(doc, "removeEventListener")];
    const names = (spies: typeof added) => spies.flatMap(spy => spy.mock.calls.map(call => call[0])).sort();
    const day = createLocalDay(), first = vi.fn(), second = vi.fn();
    const leaveFirst = day.subscribe(first), leaveSecond = day.subscribe(second);
    // One registration per signal, however many components subscribe.
    expect(names(added)).toEqual(["focus", "pageshow", "resume", "visibilitychange"]);
    leaveFirst(); leaveFirst();
    expect(vi.getTimerCount()).toBe(1); expect(names(removed)).toEqual([]);
    leaveSecond();
    expect(vi.getTimerCount()).toBe(0);
    expect(names(removed)).toEqual(["focus", "pageshow", "resume", "visibilitychange"]);
    for (const [index, spy] of added.entries()) for (const call of spy.mock.calls) expect(removed[index]!.mock.calls).toContainEqual(call.slice(0, 2));
    // Unmounted components hear nothing, whatever happens next.
    vi.setSystemTime(local(2026, 11, 18, 8, 0));
    for (const [owner, signal] of wakeSignals) target(owner).dispatchEvent(new Event(signal));
    vi.advanceTimersByTime(48 * HOUR);
    expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
    // A component mounting later reads the real day, not the one the source last saw.
    expect(day.read()).toBe(localDayKey(Date.now()));
    const third = vi.fn(), leaveThird = day.subscribe(third);
    expect(third).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(msUntilNextLocalDay(Date.now()) + DAY_TURN_MARGIN_MS);
    expect(third).toHaveBeenCalledTimes(1);
    leaveThird();
    expect(vi.getTimerCount()).toBe(0);
  });
});
