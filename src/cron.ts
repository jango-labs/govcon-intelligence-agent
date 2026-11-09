// Minimal cron: "m h dom mon dow" (lists, ranges, steps, *) evaluated in local time, plus "@every 30m|2h".
function field(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const [range, stepS] = part.split('/'); const step = stepS ? Number(stepS) : 1;
    let lo = min, hi = max;
    if (range !== '*') { const [a, b] = range.split('-'); lo = Number(a); hi = b !== undefined ? Number(b) : (stepS ? max : lo); }
    if (Number.isNaN(lo) || Number.isNaN(hi) || Number.isNaN(step) || step < 1) throw new Error(`bad cron field "${spec}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}
export function parseEvery(spec: string): number | null {
  const m = /^@every\s+(\d+)\s*(m|h)$/.exec(spec.trim());
  return m ? Number(m[1]) * (m[2] === 'h' ? 3600e3 : 60e3) : null;
}
export function matches(spec: string, d: Date): boolean {
  if (parseEvery(spec)) return true;
  const f = spec.trim().split(/\s+/); if (f.length !== 5) throw new Error(`cron needs 5 fields: "${spec}"`);
  const [mi, ho, dom, mon, dow] = [field(f[0], 0, 59), field(f[1], 0, 23), field(f[2], 1, 31), field(f[3], 1, 12), field(f[4], 0, 7)];
  const wd = d.getDay();
  const dowOk = dow.has(wd) || (wd === 0 && dow.has(7));
  const domStar = f[2] === '*', dowStar = f[4] === '*';
  const dayOk = domStar && dowStar ? true : domStar ? dowOk : dowStar ? dom.has(d.getDate()) : dom.has(d.getDate()) || dowOk;
  return mi.has(d.getMinutes()) && ho.has(d.getHours()) && mon.has(d.getMonth() + 1) && dayOk;
}
/** Has this schedule come due since lastRun (inclusive of the current minute)? Handles late wake-ups by scanning up to 36 h. */
export function isDue(spec: string, lastRun: Date | null, now: Date): boolean {
  const every = parseEvery(spec);
  if (every) return !lastRun || now.getTime() - lastRun.getTime() >= every;
  const from = new Date(Math.max(lastRun ? lastRun.getTime() + 60e3 : now.getTime() - 60e3, now.getTime() - 36 * 3600e3));
  from.setSeconds(0, 0);
  for (let t = from.getTime(); t <= now.getTime(); t += 60e3) if (matches(spec, new Date(t))) return true;
  return false;
}

/** Wall-clock view of an instant in an IANA time zone, expressed as a Date whose local getters read that wall time. */
export function wallClock(d: Date, tz: string): Date { return new Date(d.toLocaleString('en-US', { timeZone: tz })); }
/** Like isDue, but the cron fields are interpreted in `tz` (e.g. America/New_York) regardless of the machine's zone. */
export function isDueTz(spec: string, lastRun: Date | null, now: Date, tz: string): boolean {
  const every = parseEvery(spec); if (every) return isDue(spec, lastRun, now);
  const from = Math.max(lastRun ? lastRun.getTime() + 60e3 : now.getTime() - 60e3, now.getTime() - 36 * 3600e3);
  for (let t = Math.floor(from / 60e3) * 60e3; t <= now.getTime(); t += 60e3) if (matches(spec, wallClock(new Date(t), tz))) return true;
  return false;
}

/** The next `n` instants (UTC) at which `spec` fires in `tz`, found by scanning minute by minute (DST-safe because matching uses wall-clock time). */
export function nextRuns(spec: string, tz: string, from: Date, n = 3, horizonDays = 14): Date[] {
  const out: Date[] = []; const every = parseEvery(spec); if (every) return [new Date(from.getTime() + every)];
  for (let t = Math.floor(from.getTime() / 60e3) * 60e3 + 60e3; t <= from.getTime() + horizonDays * 864e5 && out.length < n; t += 60e3) if (matches(spec, wallClock(new Date(t), tz))) out.push(new Date(t));
  return out;
}
