(function(){
"use strict";

/* ============================================================
   0. environment
   ============================================================ */
const RM = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $  = (s, r) => (r||document).querySelector(s);
const $$ = (s, r) => Array.from((r||document).querySelectorAll(s));
const clamp = (v,a,b) => v<a?a:v>b?b:v;
const lerp  = (a,b,t) => a+(b-a)*t;
const rnd   = (a,b) => a+Math.random()*(b-a);

const store = {
  get(k, d){ try{ const v = localStorage.getItem(k); return v===null?d:JSON.parse(v); }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
};

const live = $("#live");
const say  = t => { live.textContent = ""; setTimeout(()=>{ live.textContent = t; }, 40); };

/* ============================================================
   1. film grain — generated once, used as a repeating tile
   ============================================================ */
(function grain(){
  const n = document.createElement("canvas");
  n.width = n.height = 128;
  const g = n.getContext("2d");
  const img = g.createImageData(128,128);
  for(let i=0;i<img.data.length;i+=4){
    const v = (Math.random()*255)|0;
    img.data[i]=img.data[i+1]=img.data[i+2]=v;
    img.data[i+3]=26;
  }
  g.putImageData(img,0,0);
  $("#grain").style.backgroundImage = "url("+n.toDataURL()+")";
})();

/* ============================================================
   2. synthesised sound — no samples, everything from oscillators
   ============================================================ */
const Sound = {
  ctx: null, master: null, muted: store.get("pv.muted", false),
  rumbleGain: null,

  boot(){
    if(this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(this.ctx.destination);
  },
  resume(){ if(this.ctx && this.ctx.state === "suspended") this.ctx.resume(); },
  setMuted(m){
    this.muted = m; store.set("pv.muted", m);
    if(this.master) this.master.gain.setTargetAtTime(m?0:0.9, this.ctx.currentTime, .05);
  },

  /* short filtered noise burst — the body of any breaking sound */
  noise(dur, type, freq, q, vol, curve){
    if(!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const len = Math.max(1, (this.ctx.sampleRate*dur)|0);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for(let i=0;i<len;i++){
      const p = i/len;
      d[i] = (Math.random()*2-1) * Math.pow(1-p, curve||2.2);
    }
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = type||"bandpass"; f.frequency.value = freq||1800; f.Q.value = q||1;
    const g = this.ctx.createGain(); g.gain.value = vol==null?0.3:vol;
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t); src.stop(t+dur+0.02);
  },

  /* glass: broadband crack + a scatter of high partials */
  shatter(power){
    if(!this.ctx || this.muted) return;
    const p = clamp(power==null?1:power, .3, 1.6);
    this.noise(0.09, "highpass", 900, 0.7, 0.34*p, 1.4);
    this.noise(0.42, "bandpass", 3400, 0.9, 0.16*p, 3.4);
    const t = this.ctx.currentTime;
    const n = 3 + ((Math.random()*3)|0);
    for(let i=0;i<n;i++){
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = "triangle";
      o.frequency.value = rnd(1500, 5200);
      const at = t + Math.random()*0.13;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.05*p, at+0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, at+rnd(0.14,0.4));
      o.connect(g); g.connect(this.master);
      o.start(at); o.stop(at+0.45);
    }
  },

  thud(){
    if(!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(34, t+0.28);
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t+0.4);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t+0.45);
  },

  tick(freq){
    if(!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = "square"; o.frequency.value = freq||880;
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t+0.06);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t+0.08);
  },

  /* pressure drone that tracks how hard you're pushing */
  rumbleOn(){
    if(!this.ctx || this.rumbleGain) return;
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain(); g.gain.value = 0;
    const f = this.ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 260;
    const o1 = this.ctx.createOscillator(); o1.type="sawtooth"; o1.frequency.value = 41;
    const o2 = this.ctx.createOscillator(); o2.type="sawtooth"; o2.frequency.value = 61.5;
    o1.connect(f); o2.connect(f); f.connect(g); g.connect(this.master);
    o1.start(t); o2.start(t);
    this.rumbleGain = g; this.rumbleNodes = [o1,o2]; this.rumbleFilter = f;
  },
  rumbleSet(v){
    if(!this.rumbleGain) return;
    const t = this.ctx.currentTime;
    this.rumbleGain.gain.setTargetAtTime(v*0.30, t, 0.06);
    this.rumbleFilter.frequency.setTargetAtTime(180 + v*1400, t, 0.08);
  },
  rumbleOff(){
    if(!this.rumbleGain) return;
    const t = this.ctx.currentTime;
    this.rumbleGain.gain.setTargetAtTime(0, t, .12);
    const nodes = this.rumbleNodes;
    setTimeout(()=>{ nodes.forEach(n=>{ try{ n.stop(); }catch(e){} }); }, 700);
    this.rumbleGain = null; this.rumbleNodes = null;
  },

  /* warm resolving tone for the breathing stage */
  breath(dir){
    if(!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = "sine";
    const a = dir === "in" ? 174.6 : 261.6;
    const b = dir === "in" ? 261.6 : 174.6;
    o.frequency.setValueAtTime(a, t);
    o.frequency.exponentialRampToValueAtTime(b, t + (dir==="in"?3.8:5.6));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.11, t+0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (dir==="in"?4:6));
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + (dir==="in"?4.2:6.2));
  },

  chime(){
    if(!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    [392, 587.3, 784].forEach((f,i)=>{
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type="sine"; o.frequency.value=f;
      const at = t + i*0.14;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.1, at+0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, at+2.2);
      o.connect(g); g.connect(this.master);
      o.start(at); o.stop(at+2.4);
    });
  }
};

const buzz = ms => { if(navigator.vibrate) try{ navigator.vibrate(ms); }catch(e){} };

/* ============================================================
   3. shard physics — polygons split by random lines, then thrown
   ============================================================ */
const fx = $("#fx");
const ctx = fx.getContext("2d");
let DPR = 1, W = 0, H = 0;

function sizeCanvas(){
  DPR = Math.min(window.devicePixelRatio||1, 2);
  W = window.innerWidth; H = window.innerHeight;
  fx.width = (W*DPR)|0; fx.height = (H*DPR)|0;
  ctx.setTransform(DPR,0,0,DPR,0,0);
}
sizeCanvas();
addEventListener("resize", sizeCanvas);

/* Sutherland–Hodgman clip of a polygon against a half-plane */
function clipHalf(poly, px, py, nx, ny){
  const out = [];
  const side = p => (p[0]-px)*nx + (p[1]-py)*ny;
  for(let i=0;i<poly.length;i++){
    const a = poly[i], b = poly[(i+1)%poly.length];
    const sa = side(a), sb = side(b);
    if(sa >= 0) out.push(a);
    if((sa >= 0) !== (sb >= 0)){
      const t = sa/(sa-sb);
      out.push([ a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t ]);
    }
  }
  return out;
}

function centroid(poly){
  let x=0, y=0;
  for(const p of poly){ x+=p[0]; y+=p[1]; }
  return [x/poly.length, y/poly.length];
}

/* recursively split a polygon into ~2^depth glass pieces */
function fracture(poly, depth, acc){
  acc = acc || [];
  if(depth <= 0 || poly.length < 3){ if(poly.length>2) acc.push(poly); return acc; }
  const c = centroid(poly);
  const jx = c[0] + rnd(-1,1) * 14;
  const jy = c[1] + rnd(-1,1) * 14;
  const a = Math.random()*Math.PI;
  const nx = Math.cos(a), ny = Math.sin(a);
  const A = clipHalf(poly, jx, jy,  nx,  ny);
  const B = clipHalf(poly, jx, jy, -nx, -ny);
  if(A.length>2) fracture(A, depth-1, acc);
  if(B.length>2) fracture(B, depth-1, acc);
  return acc;
}

const shards = [];
const sparks = [];

function burst(rect, opts){
  opts = opts || {};
  const depth = RM ? 2 : (opts.depth || 4);
  const poly = [
    [rect.left, rect.top],
    [rect.left+rect.width, rect.top],
    [rect.left+rect.width, rect.top+rect.height],
    [rect.left, rect.top+rect.height]
  ];
  const pieces = fracture(poly, depth);
  const ox = opts.ox == null ? rect.left+rect.width/2 : opts.ox;
  const oy = opts.oy == null ? rect.top+rect.height/2 : opts.oy;
  const force = opts.force == null ? 1 : opts.force;

  for(const p of pieces){
    const c = centroid(p);
    let dx = c[0]-ox, dy = c[1]-oy;
    const d = Math.hypot(dx,dy) || 1;
    dx/=d; dy/=d;
    const speed = rnd(90, 340) * force + (240/(d+40)) * 60 * force;
    shards.push({
      pts: p.map(q => [q[0]-c[0], q[1]-c[1]]),
      x: c[0], y: c[1],
      vx: dx*speed + rnd(-70,70) + (opts.vx||0)*0.35,
      vy: dy*speed + rnd(-190,-40) + (opts.vy||0)*0.35,
      rot: 0, vr: rnd(-7,7),
      life: 1, decay: rnd(0.24, 0.42),
      fill: opts.fill || "#1B1C21",
      stroke: opts.stroke || "#3A3B42",
      settled: false
    });
  }
  if(!RM){
    const n = 14;
    for(let i=0;i<n;i++){
      const a = Math.random()*Math.PI*2;
      const s = rnd(120, 460)*force;
      sparks.push({
        x: ox, y: oy,
        vx: Math.cos(a)*s, vy: Math.sin(a)*s - 60,
        life: 1, decay: rnd(1.2, 2.6),
        col: Math.random() < .6 ? "#FF3B14" : "#FFB03A"
      });
    }
  }
  if(shards.length > 900) shards.splice(0, shards.length-900);
}

let last = performance.now();
function frame(now){
  const dt = Math.min((now-last)/1000, 0.05);
  last = now;
  ctx.clearRect(0,0,W,H);

  const floor = H - 4;

  for(let i=shards.length-1;i>=0;i--){
    const s = shards[i];
    s.vy += 1500*dt;
    s.x += s.vx*dt; s.y += s.vy*dt;
    s.rot += s.vr*dt;
    s.vx *= (1 - 0.55*dt);
    s.vr *= (1 - 0.5*dt);

    if(s.y > floor){
      s.y = floor;
      s.vy *= -0.34;
      s.vx *= 0.68;
      s.vr *= 0.55;
      if(Math.abs(s.vy) < 42){ s.vy = 0; s.settled = true; }
    }
    if(s.settled) s.life -= s.decay*dt*1.5;
    else if(s.y > floor - 3) s.life -= s.decay*dt;

    if(s.life <= 0 || s.y > H + 240){ shards.splice(i,1); continue; }

    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.rot);
    ctx.globalAlpha = clamp(s.life, 0, 1);
    ctx.beginPath();
    ctx.moveTo(s.pts[0][0], s.pts[0][1]);
    for(let k=1;k<s.pts.length;k++) ctx.lineTo(s.pts[k][0], s.pts[k][1]);
    ctx.closePath();
    ctx.fillStyle = s.fill;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = s.stroke;
    ctx.stroke();
    ctx.restore();
  }

  for(let i=sparks.length-1;i>=0;i--){
    const p = sparks[i];
    p.vy += 900*dt;
    p.x += p.vx*dt; p.y += p.vy*dt;
    p.vx *= (1-1.6*dt);
    p.life -= p.decay*dt;
    if(p.life <= 0){ sparks.splice(i,1); continue; }
    ctx.globalAlpha = clamp(p.life,0,1);
    ctx.fillStyle = p.col;
    ctx.fillRect(p.x, p.y, 2.5, 2.5);
  }
  ctx.globalAlpha = 1;

  if(dial.active) dial.draw();

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ============================================================
   4. temperature — the palette IS the progress indicator
   ============================================================ */
const HOT = { ground:[11,11,13],   ground2:[19,19,22],  chalk:[232,230,225], steel:[122,126,134], hair:[35,36,42] };
const COOL= { ground:[239,234,225],ground2:[228,222,211],chalk:[26,28,27],   steel:[94,96,90],   hair:[209,203,192] };
const rgb = a => "rgb("+a[0]+","+a[1]+","+a[2]+")";
const mix = (a,b,t) => [Math.round(lerp(a[0],b[0],t)), Math.round(lerp(a[1],b[1],t)), Math.round(lerp(a[2],b[2],t))];

let warmth = 0;
function setWarmth(t){
  warmth = clamp(t,0,1);
  const r = document.documentElement.style;
  r.setProperty("--ground",   rgb(mix(HOT.ground,  COOL.ground,  warmth)));
  r.setProperty("--ground-2", rgb(mix(HOT.ground2, COOL.ground2, warmth)));
  r.setProperty("--chalk",    rgb(mix(HOT.chalk,   COOL.chalk,   warmth)));
  r.setProperty("--steel",    rgb(mix(HOT.steel,   COOL.steel,   warmth)));
  r.setProperty("--hairline", rgb(mix(HOT.hair,    COOL.hair,    warmth)));
}
setWarmth(0);

function setHeat(v){ $("#heat").style.setProperty("--heat", (v*0.34).toFixed(3)); }

/* ============================================================
   5. session state
   ============================================================ */
const S = {
  text: "",
  peak: 0,
  broken: 0,
  totalBlocks: 12,
  startedAt: 0,
  stage: "intro"
};

const ORDER = ["intro","name","scream","smash","breathe","done"];
const LABELS = { intro:"STANDBY", name:"01 NAME", scream:"02 VENT", smash:"03 BREAK", breathe:"04 COOL", done:"COMPLETE" };
const PRESSURE = { intro:100, name:100, scream:84, smash:52, breathe:14, done:0 };

const gaugeFill = $("#gaugeFill"), gaugeNum = $("#gaugeNum");
let pressureShown = 100;
function setPressure(v){
  pressureShown = clamp(v,0,100);
  gaugeFill.style.transform = "scaleX("+(pressureShown/100)+")";
  gaugeNum.textContent = Math.round(pressureShown)+"%";
  if(pressureShown < 20){
    gaugeFill.style.background = "repeating-linear-gradient(90deg, var(--sage) 0 2px, transparent 2px 5px)";
  }
}
setPressure(100);

function markStage(name){
  const idx = ORDER.indexOf(name) - 1;
  $$(".readout i").forEach((d,i)=>{
    d.classList.toggle("on", i === idx);
    d.classList.toggle("done", i < idx);
  });
  $("#stageName").textContent = LABELS[name] || "";
}

let stageEls = {};
$$(".stage").forEach(el => stageEls[el.dataset.stage] = el);

function go(name){
  const prev = S.stage;
  if(prev && stageEls[prev]){
    stageEls[prev].classList.remove("live","entering");
  }
  S.stage = name;
  const el = stageEls[name];
  el.classList.add("live");
  if(!RM){
    el.classList.add("entering");
    setTimeout(()=>el.classList.remove("entering"), 600);
  }
  markStage(name);
  setPressure(PRESSURE[name]);
  $("#skipBtn").hidden = (name === "intro" || name === "done");
  if(ENTER[name]) ENTER[name]();
}

/* ============================================================
   6. stage behaviour
   ============================================================ */
const ENTER = {};

/* ---------- intro ---------- */
const runs = store.get("pv.runs", 0);
if(runs > 0){
  $("#priorCount").textContent = runs === 1
    ? "You've vented here once before."
    : "You've vented here " + runs + " times before.";
}

$("#startBtn").addEventListener("click", () => {
  Sound.boot(); Sound.resume();
  S.startedAt = Date.now();
  Sound.tick(560);
  go("name");
});

/* ---------- 01 name ---------- */
const input = $("#grievance");
const charCount = $("#charCount");

ENTER.name = () => { setTimeout(()=>input.focus(), 320); };

input.addEventListener("input", () => {
  const v = input.value;
  charCount.textContent = v.length;
  /* the room gets hotter the more you name */
  setHeat(clamp(v.length/26, 0, 1) * 0.7);
  if(v.length && v.length % 4 === 0) Sound.tick(300 + v.length*22);
});

input.addEventListener("keydown", e => {
  if(e.key === "Enter"){ e.preventDefault(); commitName(); }
});

$$(".chip").forEach(chip => {
  chip.addEventListener("click", () => {
    input.value = chip.textContent.trim();
    charCount.textContent = input.value.length;
    setHeat(.5);
    Sound.tick(700);
    input.focus();
    setTimeout(commitName, 200);
  });
});

function commitName(){
  const v = input.value.trim();
  S.text = v || "ALL OF IT";
  Sound.thud();
  go("scream");
}

/* ---------- 02 scream ---------- */
const targetWord = $("#targetWord");
const micBtn = $("#micBtn"), silentBtn = $("#silentBtn"), screamCtl = $("#screamCtl");
const instr = $("#instr"), lvlOut = $("#lvlOut"), peakOut = $("#peakOut");
const chargeBar = $("#chargeBar"), chargeFill = $("#chargeFill"), screamHint = $("#screamHint");

let charge = 0, level = 0, mode = null, analyser = null, buf = null, micStream = null;
let mashDecay = 0, cracked = 0, screamRunning = false;

/* the radial level dial drawn behind the word */
const dial = {
  active: false, cx: 0, cy: 0, r: 0, bins: new Array(96).fill(0),
  /* hug the glyphs, not the layout box: .target is width:100%, so its
     rect would push the ring out to the edges of the screen. */
  measure(){
    let l = Infinity, t = Infinity, rt = -Infinity, b = -Infinity;
    targetWord.querySelectorAll(".ltr").forEach(el => {
      const q = el.getBoundingClientRect();
      if(!q.width && !q.height) return;
      if(q.left < l) l = q.left;
      if(q.top  < t) t = q.top;
      if(q.right  > rt) rt = q.right;
      if(q.bottom > b)  b  = q.bottom;
    });
    if(!isFinite(l)){
      const q = targetWord.getBoundingClientRect();
      l = q.left; t = q.top; rt = q.right; b = q.bottom;
    }
    this.cx = (l + rt) / 2;
    this.cy = (t + b) / 2;
    this.r  = Math.max(rt - l, b - t)/2 + 46;
    /* never let the ring run off screen on a narrow viewport */
    this.r  = Math.min(this.r, Math.min(W, H)/2 - 34);
  },
  draw(){
    const bars = this.bins.length;
    ctx.save();
    ctx.translate(this.cx, this.cy);
    for(let i=0;i<bars;i++){
      const a = (i/bars)*Math.PI*2 - Math.PI/2;
      const v = this.bins[i];
      const inner = this.r;
      const outer = this.r + 6 + v*80;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a)*inner, Math.sin(a)*inner);
      ctx.lineTo(Math.cos(a)*outer, Math.sin(a)*outer);
      ctx.lineWidth = 2;
      ctx.strokeStyle = v > .55 ? "#FF3B14" : (v > .28 ? "#FFB03A" : "#3A3B42");
      ctx.globalAlpha = 0.35 + v*0.65;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
};

function splitWord(){
  targetWord.textContent = "";
  targetWord.style.fontSize = "";
  const words = S.text.toUpperCase().split(/\s+/).filter(Boolean);
  words.forEach((w, wi) => {
    const wd = document.createElement("span");
    wd.className = "wd";
    for(const ch of w){
      const sp = document.createElement("span");
      sp.className = "ltr";
      sp.textContent = ch;
      wd.appendChild(sp);
    }
    targetWord.appendChild(wd);
    if(wi < words.length - 1) targetWord.appendChild(document.createTextNode(" "));
  });
  fitTarget();
}

/* shrink until even the longest single word fits the column */
function fitTarget(){
  let size = parseFloat(getComputedStyle(targetWord).fontSize);
  let guard = 30;
  while(targetWord.scrollWidth > targetWord.clientWidth + 1 && size > 16 && guard--){
    size *= 0.92;
    targetWord.style.fontSize = size.toFixed(2) + "px";
  }
}

ENTER.scream = () => {
  splitWord();
  charge = 0; level = 0; cracked = 0; mode = null; screamRunning = false;
  instr.hidden = true; chargeBar.hidden = true;
  screamCtl.hidden = false;
  chargeFill.style.transform = "scaleX(0)";

  /* getUserMedia only exists on a secure origin. Rather than offer a button
     that silently can't work, promote the keyboard route to primary. */
  const micOK = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  micBtn.hidden = !micOK;
  silentBtn.className = micOK ? "control ghost" : "control";
  silentBtn.textContent = micOK ? "Can't be loud — let me mash keys" : "Mash keys instead";
  screamHint.textContent = micOK
    ? "Give it everything you've got."
    : "Mic needs an https page — the keyboard works just as well.";
  screamHint.classList.remove("hot");
  targetWord.style.filter = "";
  targetWord.style.transform = "";
  setHeat(.12);
  setTimeout(()=>dial.measure(), 60);
};

micBtn.addEventListener("click", async () => {
  Sound.boot(); Sound.resume();
  micBtn.textContent = "Asking…";
  try{
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false }
    });
    const src = Sound.ctx.createMediaStreamSource(micStream);
    analyser = Sound.ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.55;
    buf = new Float32Array(analyser.fftSize);
    src.connect(analyser);              /* deliberately NOT connected to output */
    beginScream("mic");
  }catch(err){
    micBtn.textContent = "Turn on the mic";
    screamHint.textContent = (err && err.name === "NotAllowedError")
      ? "Mic blocked. You can still do this with the keyboard."
      : "Mic unavailable. You can still do this with the keyboard.";
    silentBtn.className = "control";
    silentBtn.textContent = "Mash keys instead";
    silentBtn.focus();
  }
});

silentBtn.addEventListener("click", () => {
  Sound.boot(); Sound.resume();
  beginScream("mash");
});

function beginScream(m){
  mode = m;
  screamRunning = true;
  screamCtl.hidden = true;
  instr.hidden = false;
  chargeBar.hidden = false;
  dial.active = true;
  dial.measure();
  Sound.rumbleOn();
  screamHint.textContent = m === "mic"
    ? "Louder. Hold it."
    : "Hammer any key. Faster is louder.";
  say(m === "mic" ? "Microphone live. Scream to build the release meter."
                  : "Keyboard mode. Press keys rapidly to build the release meter.");
  if(m === "mash") window.addEventListener("keydown", mash);
}

function mash(e){
  if(!screamRunning || e.repeat) return;
  if(e.key === "Tab" || e.key === "Escape") return;
  e.preventDefault();
  mashDecay = Math.min(mashDecay + 0.20, 1.25);
  Sound.tick(rnd(220, 560));
}

window.addEventListener("keydown", e => {
  if(S.stage === "scream" && !screamRunning && e.code === "Space"){
    e.preventDefault();
    silentBtn.click();
  }
});


(function levelLoop(){
  requestAnimationFrame(levelLoop);
  if(!screamRunning) return;

  if(mode === "mic" && analyser){
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for(let i=0;i<buf.length;i++) sum += buf[i]*buf[i];
    const rms = Math.sqrt(sum/buf.length);
    /* map rms to a friendly 0..1 with a floor that ignores room noise */
    const v = clamp((Math.log10(rms + 1e-7) + 2.5) / 2.0, 0, 1);
    level = lerp(level, v, 0.35);
  } else {
    mashDecay = Math.max(0, mashDecay - 0.028);
    level = lerp(level, clamp(mashDecay, 0, 1), 0.3);
  }

  /* dial ring */
  for(let i=0;i<dial.bins.length;i++){
    const wobble = 0.55 + 0.45*Math.sin(i*1.7 + performance.now()/140);
    dial.bins[i] = lerp(dial.bins[i], level*wobble, 0.28);
  }

  const shown = Math.round(level*100);
  lvlOut.textContent = String(shown).padStart(2,"0");
  if(shown > S.peak){
    S.peak = shown;
    peakOut.textContent = String(shown).padStart(2,"0");
  }

  Sound.rumbleSet(level);
  setHeat(level);

  /* charge builds while you're above the line, bleeds off when you stop */
  const dt = 1/60;
  if(level > 0.40){
    charge = clamp(charge + dt * (0.20 + level*0.55), 0, 1);
    screamHint.textContent = charge > .7 ? "Don't stop." : "That's it.";
    screamHint.classList.add("hot");
  } else {
    charge = clamp(charge - dt*0.13, 0, 1);
    screamHint.classList.remove("hot");
    if(charge > 0.02) screamHint.textContent = mode === "mic" ? "Louder." : "Faster.";
  }
  chargeFill.style.transform = "scaleX("+charge+")";

  /* the word visibly cracks as the meter fills */
  const stage = Math.floor(charge*3);
  if(stage > cracked){
    cracked = stage;
    crackWord(stage);
  }
  if(!RM && level > .3){
    const j = level*4;
    targetWord.style.transform = "translate("+rnd(-j,j).toFixed(1)+"px,"+rnd(-j,j).toFixed(1)+"px)";
  }

  if(charge >= 1) detonate();
})();

function crackWord(n){
  Sound.noise(0.16, "bandpass", 2200+n*700, 1.4, 0.2, 2.6);
  buzz(30);
  const letters = $$(".ltr", targetWord);
  const pick = letters.filter(() => Math.random() < 0.45);
  pick.forEach(l => {
    l.style.transition = "transform .4s cubic-bezier(.16,1,.3,1), color .4s";
    l.style.transform = "translate("+rnd(-6,6).toFixed(1)+"px,"+rnd(-8,8).toFixed(1)+"px) rotate("+rnd(-7,7).toFixed(1)+"deg)";
    if(n >= 2) l.style.color = "var(--signal)";
  });
}

function detonate(){
  if(!screamRunning) return;
  screamRunning = false;
  dial.active = false;
  Sound.rumbleOff();
  Sound.shatter(1.5);
  Sound.thud();
  buzz([40,30,90]);
  if(mode === "mash") window.removeEventListener("keydown", mash);
  stopMic();

  const chalk = getComputedStyle(document.documentElement).getPropertyValue("--chalk").trim() || "#E8E6E1";
  $$(".ltr", targetWord).forEach(l => {
    const r = l.getBoundingClientRect();
    if(r.width < 1) return;
    burst(r, { fill: chalk, stroke: "#FF3B14", depth: RM?1:3, force: 1.25 });
    l.style.visibility = "hidden";
  });

  if(!RM) document.body.classList.add("shake");
  setTimeout(()=>document.body.classList.remove("shake"), 300);

  screamHint.textContent = "";
  setHeat(.9);
  setTimeout(()=>setHeat(.2), 500);
  say("Released.");
  setTimeout(()=>go("smash"), 1150);
}

function stopMic(){
  if(micStream){ micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  analyser = null;
}

/* ---------- 03 smash ---------- */
const yard = $("#yard"), smashCount = $("#smashCount"), smashHint = $("#smashHint");

ENTER.smash = () => {
  yard.innerHTML = "";
  S.broken = 0;
  setHeat(.18);

  /* the blocks are literally the thing you named, over and over */
  let words = S.text.toUpperCase().split(/\s+/).filter(Boolean);
  if(!words.length) words = ["IT"];
  const N = S.totalBlocks;
  for(let i=0;i<N;i++){
    const b = document.createElement("button");
    b.type = "button";
    b.className = "block";
    b.textContent = words[i % words.length];
    b.setAttribute("aria-label", "Break: " + b.textContent);
    yard.appendChild(b);
  }
  smashCount.textContent = "0/" + N;
  smashHint.textContent = "Swipe across them. Or click. Or tab and hit enter.";
  say("Twelve blocks. Break them all.");
};

function breakBlock(el, vx, vy){
  if(!el || el.classList.contains("hit")) return;
  const r = el.getBoundingClientRect();
  el.classList.add("hit");
  S.broken++;
  smashCount.textContent = S.broken + "/" + S.totalBlocks;

  const speed = Math.hypot(vx||0, vy||0);
  const force = clamp(0.85 + speed/1400, .85, 2.1);
  burst(r, { fill:"#1B1C21", stroke:"#4A4B54", vx:vx||0, vy:vy||0, force:force, depth: RM?2:4 });
  Sound.shatter(force);
  buzz(22);
  setHeat(.32);
  setTimeout(()=>setHeat(.16), 180);
  setPressure(lerp(PRESSURE.smash, PRESSURE.breathe, S.broken/S.totalBlocks));

  if(!RM && S.broken % 4 === 0){
    document.body.classList.add("shake");
    setTimeout(()=>document.body.classList.remove("shake"), 280);
  }

  if(S.broken === S.totalBlocks) finishSmash();
  else if(S.broken === Math.floor(S.totalBlocks/2)) smashHint.textContent = "Halfway. Keep going.";
}

function finishSmash(){
  Sound.thud();
  smashHint.textContent = "That's all of it.";
  say("All twelve broken.");
  setTimeout(()=>go("breathe"), 1500);
}

/* pointer: fast drag destroys, slow click destroys, both feel right */
let px = 0, py = 0, pt = 0, dragging = false;
function pointerHit(e){
  const now = performance.now();
  const dt = Math.max(now - pt, 1);
  const vx = (e.clientX - px)/dt*1000;
  const vy = (e.clientY - py)/dt*1000;
  px = e.clientX; py = e.clientY; pt = now;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if(el && el.classList && el.classList.contains("block")) breakBlock(el, vx, vy);
}
yard.addEventListener("pointerdown", e => {
  if(S.stage !== "smash") return;
  dragging = true;
  px = e.clientX; py = e.clientY; pt = performance.now();
  pointerHit(e);
});
window.addEventListener("pointermove", e => {
  if(!dragging || S.stage !== "smash") return;
  e.preventDefault();
  pointerHit(e);
}, { passive:false });
window.addEventListener("pointerup", () => { dragging = false; });
window.addEventListener("pointercancel", () => { dragging = false; });
/* pointerdown alone misses assistive tech and synthetic activation,
   which fire click only. breakBlock() is idempotent, so overlap is safe. */
yard.addEventListener("click", e => {
  if(S.stage !== "smash") return;
  const el = e.target.closest ? e.target.closest(".block") : null;
  if(el) breakBlock(el, 0, 0);
});
yard.addEventListener("keydown", e => {
  if((e.key === "Enter" || e.key === " ") && e.target.classList.contains("block")){
    e.preventDefault();
    breakBlock(e.target, 0, 0);
  }
});

/* ---------- 04 breathe ---------- */
const orb = $("#orb"), orbWord = $("#orbWord"), orbCount = $("#orbCount"), breatheDone = $("#breatheDone");
const PHASES = [
  { word:"BREATHE IN", sec:4, scale:1.0,  dir:"in"  },
  { word:"HOLD",       sec:4, scale:1.0,  dir:null  },
  { word:"BREATHE OUT",sec:6, scale:.62, dir:"out" }
];
let breatheTimer = null, cycle = 0, phase = 0;

ENTER.breathe = () => {
  setHeat(0);
  cycle = 0; phase = 0;
  breatheDone.hidden = true;
  orb.style.transform = "scale(.62)";
  Sound.chime();
  runPhase();
};

function runPhase(){
  const p = PHASES[phase];
  orbWord.textContent = p.word;
  orbCount.textContent = "CYCLE " + (cycle+1) + " OF 3";
  orb.style.transition = "transform " + p.sec + "s cubic-bezier(.37,0,.63,1)";
  orb.style.transform = "scale(" + p.scale + ")";
  if(p.dir) Sound.breath(p.dir);
  else Sound.tick(392);

  /* the room warms continuously across the whole exercise */
  const total = 3*3;
  const done  = cycle*3 + phase;
  const from = done/total, to = (done+1)/total;
  animateWarmth(from, to, p.sec*1000);
  setPressure(lerp(PRESSURE.breathe, 0, to));

  breatheTimer = setTimeout(() => {
    phase++;
    if(phase >= PHASES.length){
      phase = 0; cycle++;
      if(cycle >= 1) breatheDone.hidden = false;
      if(cycle >= 3){ finishBreathe(); return; }
    }
    runPhase();
  }, p.sec*1000);
}

let warmRAF = null;
function animateWarmth(from, to, ms){
  if(warmRAF) cancelAnimationFrame(warmRAF);
  if(RM){ setWarmth(to); return; }
  const t0 = performance.now();
  (function step(now){
    const k = clamp((now-t0)/ms, 0, 1);
    setWarmth(lerp(from, to, k));
    if(k < 1) warmRAF = requestAnimationFrame(step);
  })(performance.now());
}

/* stop any in-flight warmth animation before pinning a value, or the
   running RAF loop overwrites it and the room never actually warms up. */
function lockWarmth(v){
  if(warmRAF) cancelAnimationFrame(warmRAF);
  warmRAF = null;
  setWarmth(v);
}

function finishBreathe(){
  clearTimeout(breatheTimer);
  lockWarmth(1);
  Sound.chime();
  go("done");
}
breatheDone.addEventListener("click", finishBreathe);

/* ---------- outro ---------- */
ENTER.done = () => {
  lockWarmth(1);
  setHeat(0);
  const mins = Math.max(1, Math.round((Date.now()-S.startedAt)/60000));
  $("#tPeak").textContent  = S.peak || "—";
  $("#tBroke").textContent = S.broken;
  $("#tTime").textContent  = mins;
  const n = store.get("pv.runs", 0) + 1;
  store.set("pv.runs", n);
  $("#tRuns").textContent  = n;
  $("#doneNote").textContent = S.text
    ? "“" + S.text.toUpperCase() + "” is in pieces on the floor. Go get a glass of water — that's the part people skip."
    : "Go get a glass of water. Seriously — that's the part people skip.";
  say("Pressure released.");
};

$("#againBtn").addEventListener("click", () => {
  clearTimeout(breatheTimer);
  shards.length = 0; sparks.length = 0;
  S.peak = 0; S.broken = 0; S.text = "";
  input.value = ""; charCount.textContent = "0";
  lockWarmth(0); setHeat(0);
  S.startedAt = Date.now();
  $("#priorCount").textContent = "";
  go("name");
});

/* ---------- skip ---------- */
$("#skipBtn").addEventListener("click", () => {
  const i = ORDER.indexOf(S.stage);
  if(S.stage === "scream"){ screamRunning = false; dial.active = false; Sound.rumbleOff(); stopMic(); window.removeEventListener("keydown", mash); }
  if(S.stage === "breathe"){ clearTimeout(breatheTimer); lockWarmth(1); }
  if(S.stage === "name") S.text = input.value.trim() || "ALL OF IT";
  go(ORDER[Math.min(i+1, ORDER.length-1)]);
});

/* ---------- sound toggle ---------- */
const soundBtn = $("#soundBtn");
function paintSound(){
  soundBtn.setAttribute("aria-pressed", String(!Sound.muted));
  soundBtn.innerHTML = Sound.muted ? "Sound&nbsp;Off" : "Sound&nbsp;On";
}
paintSound();
soundBtn.addEventListener("click", () => {
  Sound.boot(); Sound.resume();
  Sound.setMuted(!Sound.muted);
  paintSound();
  if(!Sound.muted) Sound.tick(660);
});

/* ---------- housekeeping ---------- */
addEventListener("resize", () => { if(dial.active) dial.measure(); });
addEventListener("visibilitychange", () => {
  if(document.hidden && Sound.rumbleGain) Sound.rumbleSet(0);
});

/* boot */
go("intro");
})();
