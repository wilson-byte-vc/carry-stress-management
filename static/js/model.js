/* Carry — seed week, the solver, and localStorage.
 * Depends on capacity.js. Still no DOM.
 */

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SHORT = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

/* One believable week. Tuned so Today opens at 78% with MENTAL tallest —
 * not because 78 is a nice number, but because this is what this week costs. */
function seedItems() {
  return [
    it('lec1', 'Lectures & seminars',   'MENTAL',   2.5, 3, false, 0, 0),
    it('lec2', 'Lectures & seminars',   'MENTAL',   2.5, 3, false, 1, 1),
    it('lec3', 'Lectures & seminars',   'MENTAL',   2.5, 3, false, 2, 2),
    it('lec4', 'Lectures & seminars',   'MENTAL',   2.5, 3, false, 3, 3),
    it('rev',  'Project lit review',    'MENTAL',   2,   4, true,  6, 6),
    it('read', 'Set reading',           'MENTAL',   2,   3, true,  6, 6),
    it('essay','Essay draft',           'MENTAL',   2,   4, true,  6, 6),
    it('sh1',  'Café shift',            'TIME',     3,   3, false, 3, 3),
    it('sh2',  'Café shift',            'TIME',     3,   3, false, 5, 5),
    it('gym',  'Gym',                   'PHYSICAL', 2,   2, true,  1, 4),
    it('com',  'Commute',               'PHYSICAL', 2.5, 2, false, 0, 0),
    it('out',  'Night out',             'SOCIAL',   3.5, 1, false, 4, 4),
    it('din',  'Dinner with housemates','SOCIAL',   1.5, 1, true,  2, 6),
    it('laun', 'Laundry & food shop',   'ERRANDS',  1.5, 2, true,  5, 6),
    it('bank', 'Bank form',             'ERRANDS',  0.5, 3, true,  3, 1)
  ];
}

function it(id, title, category, hours, effort, movable, day, dueDay) {
  return { id, title, category, hours, effort, movable, day, dueDay, recovery: false };
}

function seedContext() {
  return {
    avgSleep: 6.4,
    strain: 4,
    overdueErrands: [{ id: 'bank', daysOverdue: 3 }],
    releases: []
  };
}

/* Trend seed — eleven days of history so the line has something to say
 * before the demo has generated any. */
function seedTrend(now) {
  const base = [64, 61, 68, 72, 70, 77, 83, 88, 81, 76, 78];
  return base.map((v, i) => ({
    t: now - (base.length - 1 - i) * Capacity.DAY_MS,
    value: v
  }));
}

/* Context is derived, never stored twice. Recovery events are counted from
 * the items themselves so the solver's recovery block actually clears the
 * isolation modifier — otherwise the suggestion would be cosmetic. */
function contextFor(items, ctx, now) {
  const recovery = items.filter(i => i.recovery || (i.category === 'SOCIAL' && i.effort <= 2)).length;
  return Object.assign({}, ctx, { now, socialRecoveryEvents: recovery });
}

/* ---- The solver -------------------------------------------------------
 * Deterministic, and short enough to read out loud. No search, no scoring
 * heuristic anybody has to trust. It moves the biggest movable thing off the
 * worst day onto the least-bad legal day, and it stops when that stops helping.
 */
const MAX_MOVES = 6;

function solve(items, ctx, now) {
  let work = items.map(i => Object.assign({}, i));
  const moves = [];

  const weeklyPeak = list => Math.max(...DAYS.map((_, d) =>
    Capacity.dayCapacity(list, d, contextFor(list, ctx, now)).exact));

  let peak = weeklyPeak(work);

  for (let n = 0; n < MAX_MOVES; n++) {
    // Heaviest day.
    let worst = 0, worstVal = -1;
    for (let d = 0; d < 7; d++) {
      const v = Capacity.dayCapacity(work, d, contextFor(work, ctx, now)).exact;
      if (v > worstVal) { worstVal = v; worst = d; }
    }

    // Largest movable item on it, by cost — biggest lever first.
    const movable = work
      .filter(i => i.day === worst && i.movable)
      .sort((a, b) => Capacity.itemCost(b) - Capacity.itemCost(a));
    if (!movable.length) break;

    let best = null;
    for (const item of movable) {
      for (let d = 0; d < 7; d++) {
        if (d === worst) continue;
        if (d > item.dueDay) continue;                  // never move past a deadline
        const trial = work.map(i => i.id === item.id ? Object.assign({}, i, { day: d }) : i);
        const p = weeklyPeak(trial);
        if (p < peak - 0.01 && (!best || p < best.peak)) {
          best = { item, to: d, peak: p, trial };
        }
      }
      if (best) break;   // biggest lever that helps at all, not exhaustive search
    }

    if (!best) break;
    work = best.trial;
    peak = best.peak;
    moves.push({
      id: best.item.id,
      title: best.item.title,
      from: best.item.day,
      to: best.to,
      hours: best.item.hours,
      dueDay: best.item.dueDay
    });
  }

  // One 90-minute recovery block on the lightest day. Not a reward — it
  // occupies capacity like anything else, and it is defended as such.
  let light = 0, lightVal = Infinity;
  for (let d = 0; d < 7; d++) {
    const v = Capacity.dayCapacity(work, d, contextFor(work, ctx, now)).exact;
    if (v < lightVal) { lightVal = v; light = d; }
  }
  const block = it('rec-' + Date.now(), 'Recovery block', 'SOCIAL', 1.5, 1, true, light, light);
  block.recovery = true;
  work.push(block);

  return { items: work, moves, recoveryDay: light, block };
}

/* Two human sentences about what the solver did. The AI's NARRATE job has
 * this as its fallback, and the fallback ships first. */
function narrate(result, peakBefore, peakAfter) {
  if (!result.moves.length) {
    return `Nothing movable was left to move — every remaining item is fixed or due where it sits. ` +
           `A 90-minute recovery block goes on ${DAYS[result.recoveryDay]}, your lightest day.`;
  }
  const m = result.moves[0];
  const rest = result.moves.length - 1;
  const first = `Moved ${m.hours}h of ${m.title.toLowerCase()} off ${DAYS[m.from]} onto ${DAYS[m.to]}` +
                (m.dueDay < 6 ? `, still inside its ${DAYS[m.dueDay]} deadline` : '') + '.' +
                (rest > 0 ? ` ${rest} smaller move${rest > 1 ? 's' : ''} followed.` : '');
  const second = `Your worst day drops from ${Math.round(peakBefore)}% to ${Math.round(peakAfter)}%. ` +
                 `The shift and the Friday night were never touched — only hours you marked movable.`;
  return first + ' ' + second;
}

/* ---- Storage ---------------------------------------------------------- */
const KEY = 'carry.v1';

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && Array.isArray(s.items)) return s;
    }
  } catch (e) { /* private mode, cleared storage — fall through to seed */ }
  return fresh();
}

function fresh() {
  const now = Date.now();
  return { items: seedItems(), ctx: seedContext(), trend: seedTrend(now), releases: [] };
}

function save(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
}

const Model = { DAYS, SHORT, seedItems, seedContext, seedTrend, contextFor, solve, narrate, load, save, fresh, it };
if (typeof window !== 'undefined') window.Model = Model;
