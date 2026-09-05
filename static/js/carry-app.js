/* Carry — view layer. All arithmetic lives in capacity.js / model.js. */
(function () {
'use strict';

const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ====================================================================
   Part 1 — the scroll narrative
   ==================================================================== */

const DAY_NAMES = Model.DAYS;

function startLenis(attempt) {
  const a = attempt || 0;
  if (REDUCED) return;                       // never smooth-scroll someone who asked us not to
  if (typeof window.Lenis !== 'function') {
    if (a < 40) setTimeout(() => startLenis(a + 1), 120);
    return;
  }
  const lenis = new window.Lenis({ lerp: 0.09, wheelMultiplier: 0.9 });
  const loop = t => { lenis.raf(t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);

  // Lenis owns the scroll position, so CSS smooth-scroll anchors stop working.
  $$('a[href^="#"]').forEach(a => a.addEventListener('click', e => {
    const target = document.getElementById(a.getAttribute('href').slice(1));
    if (!target) return;
    e.preventDefault();
    lenis.scrollTo(target, { offset: -56 });
  }));
}

function narrative() {
  const week = $('[data-week]');
  if (!week) return;

  // Motion-sensitive readers get the whole week as one readable column
  // instead of a pinned 800vh scroll-jack. Same words, no hijack.
  if (REDUCED) { document.body.classList.add('rm'); return; }

  const days      = $$('[data-day]');
  const rows      = $$('[data-lrow]');
  const field     = $('[data-field]');
  const tint      = $('[data-tint]');
  const statement = $('[data-statement]');
  const slines    = $$('.statement p');
  const total     = $('[data-ltotal]');
  const totalVal  = $('[data-total-val]');
  const ledgerCol = $('[data-ledger-col]');
  const ledgerHd  = $('[data-ledger-head]');
  const hud       = $('[data-hud]');
  const hudBar    = $('[data-hud-bar]');
  const hudLabel  = $('[data-hud-label]');
  const hudDay    = $('[data-hud-day]');

  const HOLD = 0.63;
  const clamp = v => v < 0 ? 0 : v > 1 ? 1 : v;
  const ease  = v => 1 - Math.pow(1 - clamp(v), 3);
  let inked = null;

  function tick() {
    requestAnimationFrame(tick);
    const r = week.getBoundingClientRect();
    const span = r.height - window.innerHeight;
    const t = span > 0 ? clamp(-r.top / span) : 0;
    const p = t * 8;

    for (let i = 0; i < days.length; i++) {
      const el = days[i];
      const l = p - i;
      let o, y;
      if (l < 0)          { const k = ease(clamp((l + 0.45) / 0.45)); o = k; y = 60 * (1 - k); }
      else if (l < HOLD)  { o = 1; y = 0; }
      else                { const k = ease(clamp((l - HOLD) / (1 - HOLD))); o = 1 - k; y = -80 * k; }
      el.style.opacity = String(o);
      el.style.transform = 'translate3d(0,' + y.toFixed(2) + 'px,0)';
      el.style.visibility = o < 0.01 ? 'hidden' : 'visible';

      const row = rows[i];
      if (row) {
        const rk = ease(clamp((l - HOLD) / 0.3));
        row.style.opacity = String(rk);
        row.style.transform = 'translate3d(' + (22 * (1 - rk)).toFixed(2) + 'px,0,0)';
      }
    }

    if (tint) tint.style.opacity = (0.05 + 0.3 * clamp(p / 7)).toFixed(3);

    const s = clamp(p - 7), se = ease(s);
    if (field) field.style.opacity = String(se);
    if (statement) {
      statement.style.opacity = String(se);
      statement.style.visibility = se < 0.01 ? 'hidden' : 'visible';
    }
    slines.forEach((el, j) => {
      const k = ease(clamp((s - j * 0.18) / 0.5));
      el.style.opacity = String(k);
      el.style.transform = 'translate3d(0,' + (26 * (1 - k)).toFixed(2) + 'px,0)';
    });
    if (total) total.style.opacity = String(ease(clamp((s - 0.25) / 0.4)));

    // The ledger sits on the ink field once it lands, so it has to invert.
    const ink = s > 0.45;
    if (ink !== inked) {
      inked = ink;
      const c    = ink ? 'var(--bg)' : 'var(--ink)';
      const dim  = ink ? 'color-mix(in srgb, var(--bg) 70%, transparent)' : 'var(--n700)';
      const rule = ink ? 'color-mix(in srgb, var(--bg) 45%, transparent)' : 'var(--rule)';
      rows.forEach(row => {
        row.style.color = c;
        row.style.borderTopColor = rule;
        row.style.borderBottomColor = rule;
        const v = $('.v', row);
        if (v) v.style.color = ink ? 'var(--bg)' : 'var(--accent-700)';
      });
      if (ledgerHd)  ledgerHd.style.color = dim;
      if (ledgerCol) ledgerCol.style.borderLeftColor = rule;
      if (total)     total.style.color = c;
    }

    if (hud) {
      hud.style.opacity = (t > 0.001 && t < 0.999) ? '1' : '0';
      const d = Math.min(7, Math.max(1, Math.floor(p) + 1));
      hudLabel.textContent = 'Day ' + d + ' / 7';
      hudDay.textContent   = s > 0.3 ? 'The week' : DAY_NAMES[d - 1];
      hudBar.style.width   = (Math.min(1, p / 7) * 100).toFixed(1) + '%';
    }
    if (totalVal) totalVal.textContent = Math.round(clamp(p / 7) * 134) + '%';
  }
  requestAnimationFrame(tick);
}

/* ====================================================================
   Part 2 — the app
   ==================================================================== */

const CATS = Capacity.CATEGORIES;
let state = Model.load();
let view = 'today';
let stack = [];
let pending = null;      // the candidate being costed
let valveCtx = null;     // what the Valve was entered about

const screen = $('[data-screen]');
const titleEl = $('[data-title]');
const backEl = $('[data-back]');

const now = () => Date.now();
const ctx = () => Model.contextFor(state.items, Object.assign({}, state.ctx, { releases: state.releases }), now());
const cap = (items) => Capacity.capacity(items || state.items, ctx());

function go(next, push) {
  if (push !== false && next !== view) stack.push(view);
  view = next;
  render();
}
function back() {
  if (!stack.length) return;
  view = stack.pop();
  render();
}
backEl.addEventListener('click', back);

const TITLES = { today: 'Today', yes: 'Cost of Yes', week: 'This week', valve: 'Valve', trend: 'Trend', rebalance: 'Rebalance' };

function render() {
  titleEl.textContent = TITLES[view] || 'Carry';
  backEl.disabled = !stack.length;
  screen.innerHTML = '';
  const el = ({ today: viewToday, yes: viewYes, week: viewWeek, valve: viewValve,
                trend: viewTrend, rebalance: viewRebalance })[view]();
  screen.appendChild(el);
  Model.save(state);
}

function h(tag, attrs, kids) {
  const el = document.createElement(tag);
  for (const k in (attrs || {})) {
    if (k === 'class') el.className = attrs[k];
    else if (k === 'html') el.innerHTML = attrs[k];
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), attrs[k]);
    else if (attrs[k] !== null && attrs[k] !== false) el.setAttribute(k, attrs[k]);
  }
  (kids || []).forEach(c => el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
  return el;
}

/* ---- the ring ---- */
const R = 94, C = 2 * Math.PI * R;
function ring(value) {
  const main = Math.min(value, 100) / 100;
  const over = Math.max(0, Math.min(value - 100, 100)) / 100;
  const wrap = h('div', { class: 'ring' });
  wrap.innerHTML =
    '<svg viewBox="0 0 220 220" role="img" aria-label="Capacity ' + value + ' percent">' +
      '<circle class="track" cx="110" cy="110" r="' + R + '"/>' +
      '<circle class="val"   cx="110" cy="110" r="' + R + '" stroke-dasharray="' + C.toFixed(1) +
        '" stroke-dashoffset="' + (C * (1 - main)).toFixed(1) + '"/>' +
      (over > 0 ? '<circle class="over" cx="110" cy="110" r="' + R + '" stroke-dasharray="' + C.toFixed(1) +
        '" stroke-dashoffset="' + (C * (1 - over)).toFixed(1) + '"/>' : '') +
    '</svg>';
  const mid = h('div', { class: 'ring-mid' });
  mid.innerHTML = '<div class="ring-num">' + value + '<sup>%</sup></div>';
  wrap.appendChild(mid);
  return wrap;
}

/* ---- category bars ---- */
function bars(load, tallest, ghostLoad) {
  const box = h('div', { class: 'bars' });
  CATS.forEach(c => {
    const pct = load[c] * 100;
    const row = h('div', { class: 'bar' + (c === tallest ? ' peak' : '') });
    row.innerHTML =
      '<span class="lab">' + c + '</span>' +
      '<span class="track">' +
        (ghostLoad ? '<span class="ghost" style="width:' + Math.min(100, ghostLoad[c] * 100).toFixed(1) + '%"></span>' : '') +
        '<span class="fill" style="width:' + Math.min(100, pct).toFixed(1) + '%"></span>' +
      '</span>' +
      '<span class="num">' + Math.round(pct) + '%</span>';
    box.appendChild(row);
  });
  return box;
}

/* ---- 1. TODAY ---- */
function viewToday() {
  const v = cap();
  const wrap = h('div', { class: 'view' });

  const rw = h('div', { class: 'ring-wrap' }, [ring(v.value)]);
  rw.appendChild(h('div', { class: 'ring-band' }, [v.band.label + ' · ' + v.tallest + ' is tallest']));
  rw.appendChild(h('div', { class: 'ring-line' }, [v.band.line]));
  wrap.appendChild(rw);

  wrap.appendChild(bars(v.load, v.tallest));

  if (v.notes.length) {
    const notes = h('div', {});
    v.notes.slice(0, 4).forEach(n => {
      notes.appendChild(h('div', { class: 'note' }, [
        h('span', { class: 'k' }, [n.key]),
        h('span', {}, [n.text, h('div', { class: 'd' }, [n.detail])])
      ]));
    });
    wrap.appendChild(notes);
  }

  const stackEl = h('div', { class: 'stack' }, [
    h('button', { class: 'btn btn-accent btn-lg', onclick: () => go('yes') },
      ['Something just came up →']),
    h('div', { class: 'row2' }, [
      h('button', { class: 'btn btn-ghost', onclick: () => go('week') }, ['This week']),
      h('button', { class: 'btn btn-ghost', onclick: () => go('trend') }, ['Trend'])
    ])
  ]);
  wrap.appendChild(stackEl);
  return wrap;
}

/* ---- 2. COST OF YES ---- */
function viewYes() {
  const wrap = h('div', { class: 'view' });
  const before = cap();

  const title = h('input', { type: 'text', placeholder: 'group project, due Friday', id: 'y-title' });
  const hours = h('input', { type: 'number', value: '4', min: '0.5', step: '0.5', id: 'y-hours' });
  const effort = h('input', { type: 'range', min: '1', max: '5', value: '4', id: 'y-effort' });
  const catSel = h('select', { id: 'y-cat' });
  CATS.forEach(c => catSel.appendChild(h('option', { value: c }, [c])));
  catSel.value = 'MENTAL';
  const due = h('select', { id: 'y-due' });
  Model.DAYS.forEach((d, i) => due.appendChild(h('option', { value: String(i) }, [d])));
  due.value = '4';

  wrap.appendChild(h('div', { class: 'field-row' }, [
    h('label', { for: 'y-title' }, ['What is it?']), title,
    h('span', { class: 'hint' }, ['Type it how you’d say it. Carry parses the rest.'])
  ]));
  wrap.appendChild(h('div', { class: 'row2' }, [
    h('div', { class: 'field-row' }, [h('label', { for: 'y-hours' }, ['Hours']), hours]),
    h('div', { class: 'field-row' }, [h('label', { for: 'y-cat' }, ['Kind']), catSel])
  ]));
  wrap.appendChild(h('div', { class: 'row2' }, [
    h('div', { class: 'field-row' }, [h('label', { for: 'y-effort' }, ['Effort']), effort]),
    h('div', { class: 'field-row' }, [h('label', { for: 'y-due' }, ['Due by']), due])
  ]));

  // Free text is the only thing standing between a student and a 5-field form,
  // so the regex parser fills the fields as you type. GROQ replaces this
  // function later; the fallback ships first on purpose.
  title.addEventListener('input', () => {
    const p = parseText(title.value);
    if (p.hours)  hours.value = p.hours;
    if (p.cat)    catSel.value = p.cat;
    if (p.effort) effort.value = p.effort;
    if (p.due !== null) due.value = String(p.due);
    update();
  });

  const barBox = h('div', {});
  const verdict = h('div', { class: 'verdict' });
  wrap.appendChild(barBox);
  wrap.appendChild(verdict);

  function candidate() {
    return Model.it('cand', title.value.trim() || 'The new thing', catSel.value,
      parseFloat(hours.value) || 0, parseInt(effort.value, 10), true, 6, parseInt(due.value, 10));
  }

  function update() {
    const r = Capacity.costOfYes(state.items, candidate(), ctx());
    barBox.innerHTML = '';
    barBox.appendChild(bars(r.after.load, r.after.tallest, r.before.load));
    verdict.innerHTML =
      '<div class="big">' + r.before.value + '% → ' + r.after.value + '%</div>' +
      '<div class="say">' + saySomething(r) + '</div>';
    pending = { candidate: candidate(), result: r };
  }

  [hours, effort, catSel, due].forEach(el => el.addEventListener('input', update));
  update();

  wrap.appendChild(h('div', { class: 'stack' }, [
    h('button', { class: 'btn btn-accent', onclick: accept }, ['Accept it']),
    h('div', { class: 'row2' }, [
      h('button', { class: 'btn btn-ghost', onclick: () => { accept(true); go('rebalance'); } }, ['Rebalance']),
      h('button', { class: 'btn btn-ghost', onclick: () => { pending = null; back(); } }, ['Decline'])
    ])
  ]));
  return wrap;

  function accept(silent) {
    const c = pending.candidate;
    c.id = 'c' + Date.now();
    c.day = Math.min(6, c.dueDay);
    state.items = state.items.concat([c]);
    state.trend = state.trend.concat([{ t: now(), value: cap().value }]);
    if (!silent) { pending = null; stack = []; go('today', false); }
  }
}

function saySomething(r) {
  const d = r.delta;
  if (r.after.value > 100 && r.before.value <= 100)
    return 'That is the yes that breaks the week. ' + r.after.tallest.toLowerCase() +
           ' goes over budget, and nothing after it fits.';
  if (d >= 12) return 'A ' + d + '-point jump, almost all of it on ' + r.after.tallest.toLowerCase() + '.';
  if (d <= 2)  return 'Barely moves the number. This one is genuinely cheap.';
  return 'Costs you ' + d + ' points, mostly on ' + r.after.tallest.toLowerCase() + '.';
}

/* Regex parse — the AI's job, done badly but reliably. */
function parseText(s) {
  const t = s.toLowerCase();
  const out = { hours: null, cat: null, effort: null, due: null };
  const hm = t.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)/);
  if (hm) out.hours = parseFloat(hm[1]);
  const DUE = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  DUE.forEach((d, i) => { if (t.includes(d)) out.due = i; });
  if (/shift|work|job|commute|travel/.test(t))                 { out.cat = 'TIME'; out.effort = 3; }
  if (/gym|run|training|sport|swim|climb/.test(t))             { out.cat = 'PHYSICAL'; out.effort = 2; }
  if (/dinner|party|drinks|night out|birthday|friend/.test(t)) { out.cat = 'SOCIAL'; out.effort = 1; }
  if (/bank|form|admin|laundry|shop|renew|email/.test(t))      { out.cat = 'ERRANDS'; out.effort = 2; }
  if (/essay|project|exam|revision|assignment|reading|lab/.test(t)) { out.cat = 'MENTAL'; out.effort = 4; }
  return out;
}

/* ---- 3. WEEK ---- */
function viewWeek() {
  const wrap = h('div', { class: 'view' });
  const c = ctx();
  const vals = Model.DAYS.map((_, d) => Capacity.dayCapacity(state.items, d, c));
  const max = Math.max(120, ...vals.map(v => v.value));

  const grid = h('div', { class: 'weekgrid' });
  vals.forEach((v, i) => {
    const col = h('button', {
      class: 'wcol' + (v.value > 100 ? ' over' : v.value > 85 ? ' hot' : ''),
      onclick: () => { valveCtx = { day: i, category: v.tallest }; go('valve'); },
      'aria-label': Model.DAYS[i] + ', ' + v.value + ' percent. Open the valve.'
    });
    col.innerHTML = '<span class="cap">' + v.value + '</span>' +
      '<span class="stem" style="height:' + Math.max(2, (v.value / max) * 165).toFixed(0) + 'px"></span>' +
      '<span class="dl">' + Model.SHORT[i] + '</span>';
    grid.appendChild(col);
  });
  wrap.appendChild(grid);
  wrap.appendChild(h('p', { class: 'hint' }, ['Same formula, one-day window. Tap a red day to open the Valve.']));

  const list = h('div', { class: 'list' });
  state.items.slice().sort((a, b) => a.day - b.day).forEach(it => {
    list.appendChild(h('div', { class: 'litem' + (it._moved ? ' moved' : '') }, [
      h('div', {}, [
        h('div', { class: 'm' }, [it.title]),
        h('div', { class: 's' }, [Model.SHORT[it.day] + ' · ' + it.hours + 'h · ' + it.category])
      ]),
      h('span', { class: 'tag' + (it.movable ? ' mv' : '') }, [it.movable ? 'Movable' : 'Fixed'])
    ]));
  });
  wrap.appendChild(list);
  wrap.appendChild(h('div', { class: 'stack' }, [
    h('button', { class: 'btn btn-accent', onclick: () => go('rebalance') }, ['Rebalance the week'])
  ]));
  return wrap;
}

/* ---- 4. REBALANCE ---- */
function viewRebalance() {
  const wrap = h('div', { class: 'view' });
  const beforeCap = cap();
  const res = Model.solve(state.items, Object.assign({}, state.ctx, { releases: state.releases }), now());
  const afterCap = Capacity.capacity(res.items, Model.contextFor(res.items, Object.assign({}, state.ctx, { releases: state.releases }), now()));

  // Rebalance is judged on the worst day, not the week. Moving an item between
  // days cannot change what the week weighs — the totals are identical — so
  // leading with the weekly number would be a lie the arithmetic exposes.
  const c0 = ctx();
  const c1 = Model.contextFor(res.items, Object.assign({}, state.ctx, { releases: state.releases }), now());
  const dayVals = d => Model.DAYS.map((_, i) => Capacity.dayCapacity(d.items, i, d.c).value);
  const peakBefore = Math.max(...dayVals({ items: state.items, c: c0 }));
  const peakAfter  = Math.max(...dayVals({ items: res.items, c: c1 }));

  wrap.appendChild(h('div', { class: 'verdict' }, [
    h('div', { class: 'big' }, ['Worst day  ' + peakBefore + '% → ' + peakAfter + '%']),
    h('div', { class: 'say' }, [Model.narrate(res, peakBefore, peakAfter)])
  ]));
  wrap.appendChild(h('p', { class: 'hint' }, [
    'Your week still weighs ' + beforeCap.value + '%' +
    (afterCap.value !== beforeCap.value ? ' (' + afterCap.value + '% with the recovery block)' : '') +
    '. Moving work changes when it lands, not how much there is — ' +
    'only saying no, or the Valve, changes the total. Carry will not pretend otherwise.'
  ]));

  const list = h('div', { class: 'list' });
  if (!res.moves.length) {
    list.appendChild(h('div', { class: 'litem' }, [h('div', { class: 'm' }, ['Nothing movable left.'])]));
  }
  res.moves.forEach(m => {
    list.appendChild(h('div', { class: 'litem moved' }, [
      h('div', {}, [
        h('div', { class: 'm' }, [m.title]),
        h('div', { class: 's' }, [Model.SHORT[m.from] + ' → ' + Model.SHORT[m.to] +
          ' · due ' + Model.SHORT[m.dueDay]])
      ]),
      h('span', { class: 'tag mv' }, [m.hours + 'h'])
    ]));
  });
  list.appendChild(h('div', { class: 'litem' }, [
    h('div', {}, [
      h('div', { class: 'm' }, ['Recovery block, 90 min']),
      h('div', { class: 's' }, [Model.SHORT[res.recoveryDay] + ' · your lightest day'])
    ]),
    h('span', { class: 'tag' }, ['New'])
  ]));
  wrap.appendChild(list);
  wrap.appendChild(h('p', { class: 'hint' }, [
    'The solver is deterministic and about eighty lines. It moves the biggest movable ' +
    'item off the worst day onto the least-bad legal day, and stops when that stops helping. ' +
    'The AI only writes the sentence above it.'
  ]));

  wrap.appendChild(h('div', { class: 'stack' }, [
    h('button', {
      class: 'btn btn-accent', onclick: () => {
        res.moves.forEach(m => { const it = res.items.find(i => i.id === m.id); if (it) it._moved = true; });
        state.items = res.items;
        state.trend = state.trend.concat([{ t: now(), value: afterCap.value }]);
        stack = []; go('today', false);
      }
    }, ['Accept this plan']),
    h('button', { class: 'btn btn-ghost', onclick: back }, ['Leave it as it is'])
  ]));
  return wrap;
}

/* ---- 5. VALVE ---- */
function viewValve() {
  const wrap = h('div', { class: 'view' });
  const box = h('div', { class: 'valve' });
  const target = (valveCtx && valveCtx.category) || cap().tallest;

  let phase = 'name', name = '', hits = 0, started = 0, felt = null, timerId = null;

  function draw() {
    box.innerHTML = '';
    if (phase === 'name') {
      const inp = h('input', { type: 'text', placeholder: 'the thing', id: 'v-name' });
      box.appendChild(h('div', { class: 'valve-target' }, ['What is actually on you right now?']));
      box.appendChild(h('div', { class: 'field-row', style: 'width:100%' }, [
        h('label', { for: 'v-name' }, ['Name it — 90 seconds']), inp
      ]));
      box.appendChild(h('button', {
        class: 'btn btn-accent btn-lg',
        onclick: () => { name = inp.value.trim() || 'this week'; phase = 'smash'; started = now(); draw(); tickTimer(); }
      }, ['Start →']));
      box.appendChild(h('p', { class: 'hint' }, ['Never leaves this tab. Carry stores four numbers, not your words.']));
      setTimeout(() => inp.focus(), 30);
      return;
    }
    if (phase === 'smash') {
      box.appendChild(h('div', { class: 'valve-target' }, [name]));
      const btn = h('button', { class: 'smash', 'aria-label': 'Hit it. ' + hits + ' of 12.' });
      for (let i = 0; i < hits; i++) {
        const f = document.createElement('span');
        f.className = 'frac';
        const w = 4 + Math.random() * 10;
        f.style.cssText = 'left:' + (Math.random() * 100) + '%;top:' + (Math.random() * 100) +
          '%;width:' + w + 'px;height:' + (30 + Math.random() * 90) + 'px;transform:rotate(' +
          (Math.random() * 180) + 'deg)';
        btn.appendChild(f);
      }
      btn.addEventListener('click', () => {
        hits++;
        if (hits >= 12) { phase = 'felt'; clearInterval(timerId); }
        draw();
      });
      box.appendChild(btn);
      box.appendChild(h('div', { class: 'timer', 'data-timer': '1' }, ['90']));
      box.appendChild(h('p', { class: 'hint' }, ['Hit it until it goes. ' + (12 - hits) + ' left.']));
      return;
    }
    if (phase === 'felt') {
      box.appendChild(h('div', { class: 'valve-target' }, ['How does it sit now?']));
      const row = h('div', { class: 'feltrow' });
      [1, 2, 3, 4, 5].forEach(n => {
        row.appendChild(h('button', {
          'aria-pressed': String(felt === n),
          onclick: () => { felt = n; commit(); }
        }, [String(n)]));
      });
      box.appendChild(row);
      box.appendChild(h('p', { class: 'hint' }, ['1 = same as before. 5 = it let go.']));
      return;
    }
    // done
    const rel = state.releases[state.releases.length - 1];
    const expires = new Date(rel.timestamp + 48 * 3600000);
    box.appendChild(h('div', { class: 'valve-target' }, ['−' + Math.round(0.12 * 100) + '% on ' + rel.category_tag.toLowerCase()]));
    box.appendChild(h('p', { class: 'hint' }, [
      'Credit expires ' + Model.DAYS[(expires.getDay() + 6) % 7] + '. ' +
      'Smashing it did not fix your week — it bought you two days, and Carry says so.'
    ]));
    box.appendChild(h('button', {
      class: 'btn btn-accent btn-lg',
      onclick: () => { stack = []; go('rebalance', false); }
    }, ['Now rebalance ' + rel.category_tag.toLowerCase() + ' →']));
  }

  function tickTimer() {
    timerId = setInterval(() => {
      const left = Math.max(0, 90 - Math.floor((now() - started) / 1000));
      const el = $('[data-timer]', box);
      if (el) el.textContent = String(left);
      if (left === 0) { clearInterval(timerId); phase = 'felt'; draw(); }
    }, 250);
  }

  function commit() {
    // Exactly four fields. Nothing you typed, nothing you said.
    state.releases.push({
      timestamp: now(),
      duration_s: Math.round((now() - started) / 1000),
      felt_after: felt,
      category_tag: target
    });
    state.trend = state.trend.concat([{ t: now(), value: cap().value, release: true }]);
    phase = 'done';
    draw();
  }

  draw();
  wrap.appendChild(box);
  return wrap;
}

/* ---- 6. TREND ---- */
function viewTrend() {
  const wrap = h('div', { class: 'view' });
  const pts = state.trend.slice(-24);
  const W = 320, H = 170, PAD = 8;
  const max = Math.max(110, ...pts.map(p => p.value));
  const x = i => PAD + (i / Math.max(1, pts.length - 1)) * (W - PAD * 2);
  const y = v => H - PAD - (v / max) * (H - PAD * 2);

  let d = '';
  pts.forEach((p, i) => { d += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.value).toFixed(1) + ' '; });

  let marks = '', dots = '';
  pts.forEach((p, i) => {
    dots += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(p.value).toFixed(1) + '" r="2.5" fill="#14120F"/>';
    if (p.release) marks += '<line x1="' + x(i).toFixed(1) + '" y1="' + PAD + '" x2="' + x(i).toFixed(1) +
      '" y2="' + (H - PAD) + '" stroke="#D8412F" stroke-width="2" stroke-dasharray="3 3"/>';
  });

  const box = h('div', { class: 'trend' });
  box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Capacity over the last ' +
    pts.length + ' entries, currently ' + pts[pts.length - 1].value + ' percent">' +
    '<line x1="' + PAD + '" y1="' + y(100).toFixed(1) + '" x2="' + (W - PAD) + '" y2="' + y(100).toFixed(1) +
      '" stroke="#D6D0C4" stroke-width="2" stroke-dasharray="2 4"/>' +
    marks +
    '<path d="' + d + '" fill="none" stroke="#14120F" stroke-width="2.5"/>' + dots +
    '</svg>';
  wrap.appendChild(box);
  wrap.appendChild(h('p', { class: 'hint' }, [
    'Dashed red lines are releases. The dotted horizontal is 100% — the line above it is the week not fitting.'
  ]));

  const v = cap();
  wrap.appendChild(bars(v.load, v.tallest));
  wrap.appendChild(h('div', { class: 'stack' }, [
    h('button', { class: 'btn btn-ghost', onclick: () => { stack = []; go('today', false); } }, ['Back to today'])
  ]));
  return wrap;
}

/* ---- boot ---- */
$('[data-reset]').addEventListener('click', () => {
  state = Model.fresh(); stack = []; go('today', false);
});

startLenis();
narrative();
render();

})();
