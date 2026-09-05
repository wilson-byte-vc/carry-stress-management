/* Carry — the capacity model.
 *
 * This file is pure. No DOM, no storage, no clock reads except the ones
 * handed in as arguments. That is deliberate: Cost of Yes is not a second
 * engine, it is capacity() called twice with one extra item in the array.
 * Nothing here can fail on stage.
 */

const CATEGORIES = ['TIME', 'MENTAL', 'PHYSICAL', 'SOCIAL', 'ERRANDS'];

const BUDGET = {
  TIME:     40,
  MENTAL:   25,
  PHYSICAL: 20,
  SOCIAL:   18,
  ERRANDS:  10
};

const PEAK_WEIGHT = 0.6;   // the whole argument, in one constant
const MEAN_WEIGHT = 0.4;

const DAY_MS = 86400000;

/* An hour of something you dread costs more than an hour of something you
 * don't. effort runs 1..5, so the multiplier runs 0.8x .. 1.6x. */
function itemCost(item) {
  const effort = clamp(item.effort ?? 3, 1, 5);
  return item.hours * (0.6 + 0.2 * effort);
}

/* Category pressure, before modifiers.
 *
 * Every item charges its own category the effort-weighted cost AND charges
 * TIME the raw hours, because an hour is an hour no matter how easy it felt.
 * That double-charge is why "it's just one coffee" still moves the number —
 * social load barely registers, but the hour is gone either way.
 * Items already filed under TIME are charged once, not twice. */
function categoryLoad(items) {
  const raw = { TIME: 0, MENTAL: 0, PHYSICAL: 0, SOCIAL: 0, ERRANDS: 0 };

  for (const item of items) {
    const cat = CATEGORIES.includes(item.category) ? item.category : 'TIME';
    raw[cat] += itemCost(item);
    if (cat !== 'TIME') raw.TIME += item.hours;
  }

  const load = {};
  for (const c of CATEGORIES) load[c] = raw[c] / BUDGET[c];
  return load;
}

/* The four modifiers that make this a wellbeing model rather than a calendar
 * with a percent sign on it. Each returns a flat addition to a category's
 * normalised load, and each is separately defensible out loud. */
function applyModifiers(load, ctx) {
  const notes = [];
  const out = Object.assign({}, load);

  // 1. Sleep debt. Capped at 3h because past that the model is guessing.
  const avgSleep = ctx.avgSleep ?? 7.5;
  const debt = clamp(7.5 - avgSleep, 0, 3);
  if (debt > 0) {
    out.PHYSICAL += 0.10 * debt;
    out.MENTAL   += 0.06 * debt;
    notes.push({
      key: 'sleep',
      text: `${debt.toFixed(1)}h of sleep debt`,
      detail: 'Short sleep raises what the same week costs you.'
    });
  }

  // 2. Self-reported mental strain, 1..5, neutral at 3.
  const strain = clamp(ctx.strain ?? 3, 1, 5);
  if (strain !== 3) {
    out.MENTAL += (strain - 3) * 0.08;
    notes.push({
      key: 'strain',
      text: strain > 3 ? 'You said this week feels heavy' : 'You said this week feels light',
      detail: 'Your own read on the week, weighted in.'
    });
  }

  // 3. Isolation is load, not relief. A week with no recovery-shaped social
  //    contact is a more expensive week, so SOCIAL goes UP when it is empty.
  //    This is the modifier people argue with, and it is the one worth keeping.
  const recovery = ctx.socialRecoveryEvents ?? 0;
  if (recovery === 0) {
    out.SOCIAL += 0.15;
    notes.push({
      key: 'isolation',
      text: 'No recovery contact in 7 days',
      detail: 'Isolation is load. An empty social week costs more, not less.'
    });
  }

  // 4. Procrastination, modelled literally. The brief describes putting off
  //    what feels less urgent; here that visibly costs you, and the cost grows.
  let overdue = 0;
  for (const e of ctx.overdueErrands ?? []) {
    overdue += Math.min(0.20, 0.04 * Math.max(0, e.daysOverdue));
  }
  if (overdue > 0) {
    out.ERRANDS += overdue;
    notes.push({
      key: 'overdue',
      text: `${(ctx.overdueErrands || []).length} thing(s) you keep pushing back`,
      detail: 'Deferring costs 4% a day, capped at 20% each.'
    });
  }

  // 5. Valve credit. Smashing something did not fix your week — it bought you
  //    two days, and the app says so rather than pretending otherwise.
  for (const r of ctx.releases ?? []) {
    const hoursAgo = (ctx.now - r.timestamp) / 3600000;
    if (hoursAgo < 0 || hoursAgo >= 48) continue;
    const decay = 1 - hoursAgo / 48;
    const cat = CATEGORIES.includes(r.category_tag) ? r.category_tag : 'MENTAL';
    out[cat] = Math.max(0, out[cat] - 0.12 * decay);
    notes.push({
      key: 'release',
      text: `Release credit on ${cat.toLowerCase()}`,
      detail: `Expires in ${Math.ceil(48 - hoursAgo)}h.`,
      expiresInH: 48 - hoursAgo
    });
  }

  for (const c of CATEGORIES) out[c] = Math.max(0, out[c]);
  return { load: out, notes };
}

/* THE function. Everything in Carry is a call to this. */
function capacity(items, ctx) {
  const context = Object.assign({ now: Date.now() }, ctx);
  const base = categoryLoad(items);
  const { load, notes } = applyModifiers(base, context);

  const values = CATEGORIES.map(c => load[c]);
  const peak = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const value = 100 * (PEAK_WEIGHT * peak + MEAN_WEIGHT * mean);

  let tallest = CATEGORIES[0];
  for (const c of CATEGORIES) if (load[c] > load[tallest]) tallest = c;

  return {
    value: Math.round(value),
    exact: value,
    load,
    peak,
    mean,
    tallest,
    band: band(value),
    notes
  };
}

function band(v) {
  if (v < 60)  return { key: 'room',  label: 'Room',        line: 'You have slack. Spend it on purpose.' };
  if (v < 85)  return { key: 'tight', label: 'Tight',       line: 'It fits, but nothing else does.' };
  if (v <= 100) return { key: 'line', label: 'At the line', line: 'One more yes and the week breaks.' };
  return { key: 'over', label: 'Over', line: 'This week does not fit. Something moves or something drops.' };
}

/* Cost of Yes. Two calls, one difference. */
function costOfYes(items, candidate, ctx) {
  const before = capacity(items, ctx);
  const after  = capacity(items.concat([candidate]), ctx);
  const deltas = {};
  for (const c of CATEGORIES) deltas[c] = after.load[c] - before.load[c];
  return { before, after, deltas, delta: after.value - before.value };
}

/* A single day, run through the same function on a 1/7th budget. */
function dayCapacity(items, dayIndex, ctx) {
  const dayItems = items.filter(i => i.day === dayIndex);
  const scaled = Object.assign({}, ctx, {
    socialRecoveryEvents: 1,     // the isolation rule is a weekly rule
    overdueErrands: []           // and so is the deferral rule
  });
  const scaledItems = dayItems.map(i => Object.assign({}, i, { hours: i.hours * 7 }));
  return capacity(scaledItems, scaled);
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

const Capacity = {
  CATEGORIES, BUDGET, DAY_MS,
  capacity, costOfYes, dayCapacity, categoryLoad, itemCost, band, clamp
};

if (typeof window !== 'undefined') window.Capacity = Capacity;
if (typeof module !== 'undefined') module.exports = Capacity;
