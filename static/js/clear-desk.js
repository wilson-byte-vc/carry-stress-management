(() => {
  'use strict';
  const canvas = document.getElementById('desk');
  const ctx = canvas.getContext('2d');
  const finish = document.getElementById('finish');
  const again = document.getElementById('again');
  const soundButton = document.getElementById('sound');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const types = {
    paper: { w: 76, h: 99, mass: .55, drag: 1.5, bounce: .18 },
    assignment: { w: 80, h: 105, mass: .6, drag: 1.6, bounce: .18 },
    note: { w: 44, h: 44, mass: .3, drag: 2.1, bounce: .2 },
    book: { w: 70, h: 94, mass: 3.8, drag: 3.2, bounce: .12 },
    pencil: { w: 94, h: 8, mass: .45, drag: 1.1, bounce: .4 },
    cup: { w: 43, h: 43, mass: 2.1, drag: 2.2, bounce: .3 },
    cable: { w: 86, h: 45, mass: .8, drag: 2.4, bounce: .1 }
  };
  let width = 0, height = 0, bodies = [], particles = [], trail = [];
  let pointer = null, brush = null, complete = false, accumulator = 0, last = 0;
  let grabbed = null;
  let clickCarry = false;
  let audio = null, noise = null, sound = true, lastSound = 0;
  const keys = new Set();
  let wood;

  function initAudio() {
    if (!sound) return;
    try {
      if (!audio) {
        audio = new (window.AudioContext || window.webkitAudioContext)();
        noise = audio.createBuffer(1, audio.sampleRate * .25, audio.sampleRate);
        const data = noise.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      }
      if (audio.state === 'suspended') audio.resume().catch(() => {});
    } catch (_) { audio = null; }
  }
  function impact(body, speed, clearing = false) {
    if (!sound || !audio || audio.state !== 'running' || speed < 35) return;
    const now = audio.currentTime;
    if (now - lastSound < .035) return;
    lastSound = now;
    const paper = ['paper', 'assignment', 'note', 'cable'].includes(body.kind);
    const gain = audio.createGain();
    const filter = audio.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = paper ? 1500 : 1100;
    const source = paper ? audio.createBufferSource() : audio.createOscillator();
    if (paper) source.buffer = noise;
    else {
      source.type = 'sine';
      source.frequency.setValueAtTime(body.kind === 'cup' ? 680 : body.kind === 'pencil' ? 360 : 115, now);
      source.frequency.exponentialRampToValueAtTime(body.kind === 'cup' ? 330 : 65, now + .12);
    }
    const duration = paper ? .16 : .14;
    gain.gain.setValueAtTime(.001, now);
    gain.gain.exponentialRampToValueAtTime(clamp(speed / 7000, .015, .075) * (clearing ? .7 : 1), now + .008);
    gain.gain.exponentialRampToValueAtTime(.001, now + duration);
    source.connect(filter).connect(gain).connect(audio.destination);
    source.start(now); source.stop(now + duration);
    source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
  }

  function rounded(c, x, y, w, h, r, fill) {
    c.fillStyle = fill; c.beginPath(); c.roundRect(x, y, w, h, r); c.fill();
  }
  function texture(body) {
    const surface = document.createElement('canvas');
    surface.width = (body.w + 24) * 2; surface.height = (body.h + 24) * 2;
    const c = surface.getContext('2d'); c.scale(2, 2); c.translate(12, 12);
    const w = body.w, h = body.h;
    const ink = '#6f7978';
    if (body.kind === 'paper' || body.kind === 'assignment') {
      rounded(c, 0, 0, w, h, 1, '#fffdf2');
      c.fillStyle = '#d8e2e1';
      for (let y = 30; y < h - 9; y += 9) c.fillRect(10, y, w - 20, .7);
      c.fillStyle = ink; c.font = 'bold 6px sans-serif';
      c.fillText(body.kind === 'assignment' ? 'ASSIGNMENT' : 'lecture notes', 10, 17, w - 20);
      c.fillStyle = '#85938d';
      for (let y = 27; y < h - 15; y += 18) c.fillRect(11, y, rand(w * .3, w * .65), 1.3);
      c.fillStyle = '#e8e4d7'; c.beginPath(); c.moveTo(w - 12, h); c.lineTo(w - 2, h - 12); c.lineTo(w, h); c.fill();
      if (body.kind === 'assignment') { c.strokeStyle = '#b8745c'; c.lineWidth = 1; c.strokeRect(w - 25, 9, 14, 12); }
    } else if (body.kind === 'book') {
      rounded(c, 2, 4, w - 1, h - 2, 3, '#d5ccae');
      for (let y = h - 7; y < h; y += 2) { c.fillStyle = '#aea68f'; c.fillRect(5, y, w - 7, .5); }
      rounded(c, 0, 0, w, h - 5, 3, body.color);
      c.fillStyle = '#00000018'; c.fillRect(5, 0, 5, h - 5);
      c.strokeStyle = '#ffffff45'; c.strokeRect(16, 13, w - 26, h - 37);
      c.fillStyle = '#f5edd9'; c.font = '6px serif'; c.fillText(body.label, 18, 28, w - 26);
      c.font = '4px sans-serif'; c.fillText('STUDENT EDITION', 14, h - 18, w - 20);
    } else if (body.kind === 'note') {
      rounded(c, 0, 0, w, h, 1, body.color);
      c.fillStyle = '#00000008'; c.fillRect(0, 0, w, 8);
      c.strokeStyle = '#72695490'; c.lineWidth = 1.3;
      for (let y = 17; y < h - 7; y += 7) { c.beginPath(); c.moveTo(8, y); c.bezierCurveTo(16, y - 3, 20, y + 3, w - 9, y); c.stroke(); }
    } else if (body.kind === 'pencil') {
      rounded(c, 10, 0, w - 16, h, 1, body.color);
      c.fillStyle = '#ffffff60'; c.fillRect(12, 1, w - 20, 2);
      c.fillStyle = '#c9b893'; c.beginPath(); c.moveTo(10, 0); c.lineTo(0, h / 2); c.lineTo(10, h); c.fill();
      c.fillStyle = '#3c3d37'; c.beginPath(); c.moveTo(4, h / 2 - 1.5); c.lineTo(0, h / 2); c.lineTo(4, h / 2 + 1.5); c.fill();
      rounded(c, w - 7, 0, 7, h, 2, '#cc9688'); c.fillStyle = '#bcc0b7'; c.fillRect(w - 12, 0, 5, h);
    } else if (body.kind === 'cup') {
      c.strokeStyle = '#e9e8db'; c.lineWidth = 6; c.beginPath(); c.ellipse(w - 1, h / 2, 8, 9, 0, 0, Math.PI * 2); c.stroke();
      c.fillStyle = '#faf8ea'; c.beginPath(); c.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#bbb6a4'; c.beginPath(); c.arc(w / 2, h / 2, w / 2 - 5, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#604637'; c.beginPath(); c.arc(w / 2, h / 2 + 1, w / 2 - 7, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#bd936270'; c.lineWidth = 2; c.beginPath(); c.arc(w / 2, h / 2, w / 2 - 10, .3, 2.2); c.stroke();
    } else {
      c.strokeStyle = '#424b47'; c.lineWidth = 4; c.lineCap = 'round';
      c.beginPath(); c.moveTo(4, 20); c.bezierCurveTo(13, -10, 53, 1, 50, 22); c.bezierCurveTo(42, 53, 12, 32, 35, 20); c.bezierCurveTo(59, 4, 65, 44, 80, 29); c.stroke();
      c.strokeStyle = '#ffffff28'; c.lineWidth = 1; c.stroke();
      rounded(c, 0, 17, 11, 8, 2, '#828d86'); rounded(c, 77, 23, 9, 12, 2, '#828d86');
    }
    return surface;
  }
  function makeWood() {
    wood = document.createElement('canvas'); wood.width = width * 2; wood.height = height * 2;
    const c = wood.getContext('2d'); c.scale(2, 2);
    const g = c.createLinearGradient(0, 0, width, height); g.addColorStop(0, '#ddc7a1'); g.addColorStop(.5, '#d5bb91'); g.addColorStop(1, '#c7ab80'); c.fillStyle = g; c.fillRect(0, 0, width, height);
    for (let i = 0; i < height * 2; i++) {
      const y = rand(0, height); c.strokeStyle = `rgba(110,77,39,${rand(.018,.055)})`; c.lineWidth = rand(.3, 1);
      c.beginPath(); c.moveTo(0, y); c.bezierCurveTo(width * .3, y + rand(-9, 9), width * .7, y + rand(-9, 9), width, y + rand(-3, 3)); c.stroke();
    }
    c.strokeStyle = '#8c673423'; c.lineWidth = 1;
    for (let y = height / 3; y < height; y += height / 3) { c.beginPath(); c.moveTo(0, y); c.lineTo(width, y); c.stroke(); }
    c.strokeStyle = '#ffffff30'; c.strokeRect(2, 2, width - 4, height - 4);
  }
  function resize() {
    const rect = canvas.getBoundingClientRect(), oldW = width, oldH = height;
    width = rect.width; height = rect.height;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (oldW) bodies.forEach(b => { b.x *= width / oldW; b.y *= height / oldH; });
    stop(); makeWood();
  }
  function reset(focusDesk = false) {
    stop(); complete = false; finish.hidden = true; bodies = []; particles = []; trail = [];
    const scale = clamp(width / 660, .62, 1.12);
    const kinds = ['book','paper','assignment','pencil','note','cup','paper','cable','note','pencil','assignment','book','paper','note','pencil','cup','assignment','cable','note','pencil','paper','book','note','pencil','assignment','paper'];
    kinds.forEach((kind, i) => {
      const t = types[kind];
      const b = { ...t, kind, w: t.w * scale, h: t.h * scale,
        x: width * (.16 + (i % 5) * .165) + rand(-12,12),
        y: height * (.14 + Math.floor(i / 5) * .14) + rand(-12,12),
        angle: rand(-.75,.75), vx: 0, vy: 0, spin: 0, fall: 0, phase: rand(0,6.28),
        color: kind === 'book' ? ['#627a72','#aa755b','#5d6e80'][i % 3] : kind === 'note' ? ['#e8cd72','#c5cf9a','#dba69b'][i % 3] : ['#d6a255','#688d84'][i % 2],
        label: ['FIELD NOTES','LITERATURE','DESIGN'][i % 3] };
      b.invMass = 1 / b.mass; b.inertia = b.mass * (b.w*b.w + b.h*b.h) / 12;
      b.sprite = texture(b); bodies.push(b);
    });
    if (focusDesk) canvas.focus({ preventScroll: true });
  }

  // Oriented-box contacts give long pencils and heavy books their own leverage.
  function axes(b) { const c = Math.cos(b.angle), s = Math.sin(b.angle); return [{x:c,y:s},{x:-s,y:c}]; }
  function collision(a, b) {
    const aa = axes(a), ba = axes(b), dx = b.x-a.x, dy = b.y-a.y;
    let overlap = Infinity, normal;
    for (const n of [...aa, ...ba]) {
      const ra = a.w/2*Math.abs(n.x*aa[0].x+n.y*aa[0].y) + a.h/2*Math.abs(n.x*aa[1].x+n.y*aa[1].y);
      const rb = b.w/2*Math.abs(n.x*ba[0].x+n.y*ba[0].y) + b.h/2*Math.abs(n.x*ba[1].x+n.y*ba[1].y);
      const d = dx*n.x+dy*n.y, penetration = ra+rb-Math.abs(d);
      if (penetration <= 0) return;
      if (penetration < overlap) { overlap = penetration; normal = {x:n.x*(d<0?-1:1),y:n.y*(d<0?-1:1)}; }
    }
    const n = normal, inv = a.invMass+b.invMass;
    const correction = Math.max(0, overlap-.4)*.65/inv;
    a.x -= n.x*correction*a.invMass; a.y -= n.y*correction*a.invMass;
    b.x += n.x*correction*b.invMass; b.y += n.y*correction*b.invMass;
    const velocity = (b.vx-a.vx)*n.x+(b.vy-a.vy)*n.y;
    if (velocity >= 0) return;
    const impulse = -(1+Math.min(a.bounce,b.bounce))*velocity/inv;
    a.vx -= impulse*n.x*a.invMass; a.vy -= impulse*n.y*a.invMass;
    b.vx += impulse*n.x*b.invMass; b.vy += impulse*n.y*b.invMass;
    const tangent = (b.vx-a.vx)*-n.y+(b.vy-a.vy)*n.x;
    const friction = clamp(-tangent/inv,-impulse*.2,impulse*.2);
    a.vx += friction*n.y*a.invMass; a.vy -= friction*n.x*a.invMass;
    b.vx -= friction*n.y*b.invMass; b.vy += friction*n.x*b.invMass;
    a.spin = clamp(a.spin-friction*Math.min(a.w,a.h)/a.inertia,-18,18);
    b.spin = clamp(b.spin-friction*Math.min(b.w,b.h)/b.inertia,-18,18);
    if (-velocity > 90) { impact(a, -velocity); dust((a.x+b.x)/2,(a.y+b.y)/2,-velocity); }
  }
  function dust(x,y,speed) {
    if (reduced || particles.length > 70) return;
    for(let i=0;i<3;i++) particles.push({x,y,vx:rand(-1,1)*Math.min(speed,200)*.2,vy:rand(-1,1)*40,life:.3,max:.3});
  }
  function sweep(from, to, seconds) {
    if (complete) return;
    const dx = to.x-from.x, dy = to.y-from.y, distance = Math.hypot(dx,dy);
    if (distance < .2) return;
    const speed = clamp(distance/Math.max(seconds,.008),30,2200);
    const nx = dx/distance, ny = dy/distance, radius = width < 600 ? 26 : 30;
    for (const b of bodies) {
      if (b.fall) continue;
      // Sample the entire stroke so even a fast swipe cannot skip a pencil.
      const steps = Math.ceil(distance/8), c = Math.cos(b.angle), s = Math.sin(b.angle);
      for (let i=0;i<=steps;i++) {
        const px=from.x+dx*i/steps, py=from.y+dy*i/steps;
        if(px<0||py<0||px>width||py>height) continue;
        const lx=(px-b.x)*c+(py-b.y)*s, ly=-(px-b.x)*s+(py-b.y)*c;
        const qx=clamp(lx,-b.w/2,b.w/2), qy=clamp(ly,-b.h/2,b.h/2);
        if(Math.hypot(lx-qx,ly-qy)>radius) continue;
        const along=b.vx*nx+b.vy*ny;
        const target=clamp(speed*1.12+100,140,2300);
        const impulse=Math.max(0,target-along)*(.85/(1+b.mass*.3));
        b.vx+=nx*impulse; b.vy+=ny*impulse;
        const rx=qx*c-qy*s, ry=qx*s+qy*c;
        b.spin=clamp(b.spin+(rx*ny-ry*nx)*impulse*b.mass/b.inertia*.35,-20,20);
        impact(b,speed); break;
      }
    }
    if(!reduced) { trail.push({x:to.x,y:to.y,life:.18}); if(trail.length>24) trail.shift(); }
  }
  function physics(dt) {
    if (keys.size && brush && !complete) {
      const prev={...brush};
      brush.x=clamp(brush.x+((keys.has('ArrowRight')?1:0)-(keys.has('ArrowLeft')?1:0))*500*dt,0,width);
      brush.y=clamp(brush.y+((keys.has('ArrowDown')?1:0)-(keys.has('ArrowUp')?1:0))*500*dt,0,height);
      if(keys.has('Space')) sweep(prev,brush,dt);
    }
    for(const b of bodies) {
      if (grabbed && grabbed.body === b && brush) {
        const stiffness = 240 / (1 + b.mass * .15);
        const damping = 2 * Math.sqrt(stiffness);
        b.vx += ((brush.x - grabbed.offsetX - b.x) * stiffness - b.vx * damping) * dt;
        b.vy += ((brush.y - grabbed.offsetY - b.y) * stiffness - b.vy * damping) * dt;
      }
      b.x+=b.vx*dt; b.y+=b.vy*dt; b.angle+=b.spin*dt;
      if(b.fall) { b.fall+=dt; continue; }
      const damping=Math.exp(-b.drag*dt);
      b.vx*=damping; b.vy*=damping; b.spin*=Math.exp(-1.6*dt);
      // The centre of mass crossing an edge tips the whole object off the desk.
      if((!grabbed || grabbed.body !== b) && (b.x<0||b.x>width||b.y<0||b.y>height)) { b.fall=dt; impact(b,Math.hypot(b.vx,b.vy),true); }
    }
    for(let pass=0;pass<2;pass++) for(let i=0;i<bodies.length;i++) for(let j=i+1;j<bodies.length;j++) {
      const a=bodies[i],b=bodies[j];
      if(a.fall||b.fall||Math.abs(a.x-b.x)>(a.w+a.h+b.w+b.h)/2||Math.abs(a.y-b.y)>(a.w+a.h+b.w+b.h)/2) continue;
      collision(a,b);
    }
    bodies=bodies.filter(b=>b.fall<.36);
    for(const p of particles) { p.x+=p.vx*dt;p.y+=p.vy*dt;p.life-=dt; }
    particles=particles.filter(p=>p.life>0);
    for(const p of trail) p.life-=dt;
    trail=trail.filter(p=>p.life>0);
    if(!bodies.length&&!complete) {
      complete=true;stop();finish.hidden=false;again.focus({preventScroll:true});
    }
  }
  function draw(time) {
    ctx.clearRect(0,0,width,height);ctx.drawImage(wood,0,0,width,height);
    for(const b of bodies) {
      const speed=Math.hypot(b.vx,b.vy);
      const paper=['paper','assignment','note'].includes(b.kind);
      const flutter=paper&&!reduced?Math.sin(time*.017+b.phase)*Math.min(speed/1800,.09):0;
      const fall=b.fall/.36;
      ctx.save();ctx.translate(b.x,b.y);ctx.rotate(b.angle);
      ctx.globalAlpha=1-fall;ctx.scale(1-fall*.3,1-fall*.3+flutter);
      ctx.shadowColor='#35271e35';ctx.shadowBlur=b.kind==='book'?5:3+Math.abs(flutter)*70;ctx.shadowOffsetX=2;ctx.shadowOffsetY=b.kind==='book'?5:3+Math.abs(flutter)*35;
      ctx.drawImage(b.sprite,-b.w/2-12,-b.h/2-12,b.w+24,b.h+24);ctx.restore();
    }
    for(const p of particles) {ctx.globalAlpha=p.life/p.max*.3;ctx.fillStyle='#fffae2';ctx.beginPath();ctx.arc(p.x,p.y,1.5,0,Math.PI*2);ctx.fill();}
    ctx.globalAlpha=1;
    if(trail.length>1) {ctx.lineCap='round';ctx.lineWidth=18;for(let i=1;i<trail.length;i++){ctx.strokeStyle=`rgba(255,250,231,${trail[i].life*.65})`;ctx.beginPath();ctx.moveTo(trail[i-1].x,trail[i-1].y);ctx.lineTo(trail[i].x,trail[i].y);ctx.stroke();}}
    if(brush&&!complete) {ctx.strokeStyle=pointer!==null||keys.has('Space')?'#fffbedaa':'#fffbed60';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(brush.x,brush.y,width<600?26:30,0,Math.PI*2);ctx.stroke();}
  }
  function frame(time) {
    accumulator+=Math.min((time-(last||time))/1000,.05);last=time;
    while(accumulator>=1/120) {physics(1/120);accumulator-=1/120;}
    draw(time);requestAnimationFrame(frame);
  }
  function position(e) {const r=canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top,time:e.timeStamp};}
  function stop(cancelGrab = true) {
    if (grabbed && cancelGrab) {
      grabbed.body.vx = 0; grabbed.body.vy = 0; grabbed.body.spin = 0;
    }
    grabbed = null;
    clickCarry = false;
    const id=pointer;pointer=null;brush=null;keys.clear();trail=[];canvas.classList.remove('sweeping');
    if(id!==null&&canvas.hasPointerCapture(id))canvas.releasePointerCapture(id);
  }
  canvas.addEventListener('pointerdown',e=>{
    if(complete||pointer!==null||!e.isPrimary||e.button!==0)return;
    if (clickCarry) { e.preventDefault(); stop(false); return; }
    e.preventDefault();initAudio();canvas.focus({preventScroll:true});pointer=e.pointerId;brush=position(e);canvas.setPointerCapture(pointer);canvas.classList.add('sweeping');
    for (let i = bodies.length - 1; i >= 0; i--) {
      const b = bodies[i];
      if (b.fall) continue;
      const c = Math.cos(b.angle), s = Math.sin(b.angle);
      const dx = brush.x - b.x, dy = brush.y - b.y;
      const padding = e.pointerType === 'touch' ? 8 : 3;
      if (Math.abs(dx*c + dy*s) > b.w/2 + padding || Math.abs(-dx*s + dy*c) > b.h/2 + padding) continue;
      grabbed = { body: b, offsetX: dx, offsetY: dy };
      b.vx = 0; b.vy = 0; b.spin = 0;
      bodies.splice(i, 1); bodies.push(b);
      break;
    }
  });
  canvas.addEventListener('pointermove',e=>{
    if(e.pointerId!==pointer)return;
    if(e.pointerType==='mouse'&&!(e.buttons&1)){stop();return;}
    const samples=e.getCoalescedEvents?e.getCoalescedEvents():[];
    for(const sample of samples.length?samples:[e]){const next=position(sample);if(!grabbed)sweep(brush,next,(next.time-brush.time)/1000);brush=next;}
  });
  canvas.addEventListener('pointerup', e => {
    if (e.pointerId !== pointer) return;
    if (grabbed && e.pointerType === 'mouse') {
      clickCarry = true;
      const id = pointer; pointer = null;
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    } else stop(false);
  });
  ['pointercancel','lostpointercapture'].forEach(name=>canvas.addEventListener(name,e=>{if(e.pointerId===pointer)stop();}));
  window.addEventListener('pointermove', e => {
    if (clickCarry && e.pointerType === 'mouse' && e.isPrimary) brush = position(e);
  });
  window.addEventListener('pointerdown', e => {
    if (clickCarry && e.button === 0 && e.target !== canvas) stop(false);
  });
  canvas.addEventListener('keydown', e => {
    if (e.code === 'Escape' && grabbed) { e.preventDefault(); stop(); }
  });
  canvas.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Space'].includes(e.code)||complete)return;e.preventDefault();initAudio();if(!brush)brush={x:width/2,y:height/2};keys.add(e.code);});
  window.addEventListener('keyup',e=>keys.delete(e.code));
  canvas.addEventListener('blur',stop);window.addEventListener('blur',stop);
  document.addEventListener('visibilitychange',()=>{stop();last=0;accumulator=0;});
  soundButton.addEventListener('click',()=>{sound=!sound;soundButton.textContent=sound?'SOUND ON':'SOUND OFF';soundButton.setAttribute('aria-pressed',String(sound));soundButton.setAttribute('aria-label',sound?'Sound enabled. Toggle sound':'Sound disabled. Toggle sound');if(sound)initAudio();});
  again.addEventListener('click',()=>{initAudio();reset(true);});
  new ResizeObserver(resize).observe(canvas);
  resize();reset();requestAnimationFrame(frame);
})();
