'use strict';

/*
 * Radio page for the touch PC (VIS-2 iframe): room chips (multi-select = play together),
 * big station tiles, stop, one volume slider per selected room. Live status over /ws.
 * Options: ?rooms=kueche,terrasse (preselected rooms), ?cols=3.
 */

/** @param {{rooms: object[], stations: object[]}} initial */
function renderPage(initial) {
    const data = JSON.stringify(initial).replace(/</g, '\\u003c');
    return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Radio</title>
<style>
  :root { --bg: #111; --fg: #fff; --muted: #9aa; --card: #1d1f22; --accent: #1f9d55; --red: #d64545; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; }
  body { display: flex; flex-direction: column; overflow: hidden; user-select: none; -webkit-user-select: none; }
  #rooms { display: flex; gap: 10px; padding: 12px; flex-wrap: wrap; }
  .room { flex: 1 1 140px; background: var(--card); border: 3px solid transparent; border-radius: 14px; padding: 10px 14px;
          color: var(--fg); text-align: left; font-size: 20px; cursor: pointer; min-height: 64px; }
  .room small { display: block; font-size: 14px; color: var(--muted); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .room.sel { border-color: var(--accent); }
  .room.playing small { color: #7fe0a8; }
  .room.offline { opacity: .45; }
  #stations { flex: 1; display: grid; gap: 12px; padding: 0 12px 12px; overflow-y: auto; grid-auto-rows: minmax(90px, 1fr); min-height: 0; }
  .station { position: relative; border: 0; border-radius: 18px; color: #fff; font-size: clamp(18px, 3.2vw, 34px); font-weight: 600; cursor: pointer;
             padding: 10px; display: flex; align-items: center; justify-content: center; text-align: center;
             box-shadow: 0 2px 8px rgba(0,0,0,.5); background: #2b6cb0; overflow: hidden; }
  .station img { max-width: 80%; max-height: 70%; object-fit: contain; }
  .station:active { transform: scale(.97); }
  .station.on { outline: 5px solid #fff; outline-offset: -5px; }
  .station.on::after { content: '▶'; position: absolute; right: 12px; top: 8px; font-size: 22px; }
  .station.busy { opacity: .6; }
  #bar { background: #000; padding: 10px 12px 14px; display: flex; flex-direction: column; gap: 8px; }
  #now { display: flex; align-items: center; gap: 12px; }
  #nowText { flex: 1; font-size: 18px; min-width: 0; }
  #nowText b { display: block; font-size: 20px; }
  #nowText span { color: var(--muted); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #stop { background: var(--red); color: #fff; border: 0; border-radius: 40px; font-size: 20px; padding: 14px 28px; cursor: pointer; }
  .vol { display: flex; align-items: center; gap: 10px; font-size: 16px; }
  .vol label { width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vol button { width: 48px; height: 48px; border-radius: 24px; border: 0; background: #333; color: #fff; font-size: 24px; cursor: pointer; }
  .vol input { flex: 1; height: 36px; accent-color: var(--accent); }
  .vol output { width: 40px; text-align: right; }
  #msg { position: fixed; left: 50%; top: 12px; transform: translateX(-50%); background: #b7791f; color: #000; padding: 10px 16px;
         border-radius: 8px; display: none; z-index: 10; max-width: 90%; }
</style>
</head>
<body>
<div id="msg"></div>
<div id="rooms"></div>
<div id="stations"></div>
<div id="bar">
  <div id="now"><div id="nowText"></div><button id="stop" type="button">Stopp</button></div>
  <div id="vols"></div>
</div>
<script>
'use strict';
let data = ${data};
const params = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);
const store = {
  get() { try { return JSON.parse(localStorage.getItem('radioRooms') || 'null'); } catch (e) { return null; } },
  set(v) { try { localStorage.setItem('radioRooms', JSON.stringify(v)); } catch (e) {} },
};
let selected = (params.get('rooms') || '').split(',').filter(Boolean);
if (!selected.length) selected = store.get() || [];
let busy = '';
let ws = null, retry = 1000, wasConnected = false, msgTimer = null;

function show(text) {
  const m = $('msg');
  m.textContent = text;
  m.style.display = text ? 'block' : 'none';
  clearTimeout(msgTimer);
  if (text) msgTimer = setTimeout(() => show(''), 8000);
}

function send(msg) {
  if (!ws || ws.readyState !== 1) { show('Keine Verbindung zum Adapter, bitte kurz warten.'); return false; }
  ws.send(JSON.stringify(msg));
  return true;
}

function rooms() { return data.rooms.filter(r => selected.includes(r.id)); }

function render() {
  // Rooms that no longer exist drop out of the selection; with none selected take the first room.
  selected = selected.filter(id => data.rooms.some(r => r.id === id));
  if (!selected.length && data.rooms.length) selected = [data.rooms[0].id];
  const rb = $('rooms');
  rb.textContent = data.rooms.length ? '' : 'Suche Sonos-Lautsprecher …';
  for (const r of data.rooms) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'room' + (selected.includes(r.id) ? ' sel' : '') + (r.playing ? ' playing' : '') + (r.online ? '' : ' offline');
    b.textContent = r.name;
    const s = document.createElement('small');
    s.textContent = !r.online ? 'nicht erreichbar' : r.playing ? '♪ ' + (r.stationName || 'läuft') : 'aus';
    b.appendChild(s);
    b.onclick = () => {
      selected = selected.includes(r.id) ? selected.filter(x => x !== r.id) : selected.concat(r.id);
      store.set(selected);
      render();
    };
    rb.appendChild(b);
  }

  const sel = rooms();
  const lead = sel[0];
  const grid = $('stations');
  const cols = Number(params.get('cols')) || Math.min(4, Math.max(2, Math.ceil(Math.sqrt(data.stations.length))));
  grid.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
  grid.textContent = '';
  for (const st of data.stations) {
    const b = document.createElement('button');
    b.type = 'button';
    const on = sel.length && sel.every(r => r.playing && r.station === st.id);
    b.className = 'station' + (on ? ' on' : '') + (busy === st.id ? ' busy' : '');
    if (st.color) b.style.background = st.color;
    if (st.logo) {
      const img = document.createElement('img');
      img.src = st.logo; img.alt = st.name;
      img.onerror = () => { img.remove(); b.textContent = st.name; };
      b.appendChild(img);
    } else {
      b.textContent = st.name;
    }
    b.onclick = () => {
      if (!selected.length) { show('Bitte zuerst einen Raum antippen.'); return; }
      if (send({ type: 'play', station: st.id, rooms: selected })) { busy = st.id; render(); setTimeout(() => { busy = ''; render(); }, 4000); }
    };
    grid.appendChild(b);
  }

  const nt = $('nowText');
  nt.textContent = '';
  const head = document.createElement('b');
  const sub = document.createElement('span');
  if (lead && lead.playing) {
    head.textContent = lead.stationName || 'Läuft';
    sub.textContent = lead.title || (lead.group.length ? 'zusammen mit ' + lead.group.join(', ') : '');
  } else {
    head.textContent = sel.length ? 'Aus' : 'Kein Raum ausgewählt';
    sub.textContent = sel.map(r => r.name).join(', ');
  }
  nt.append(head, sub);
  $('stop').style.visibility = sel.some(r => r.playing) ? 'visible' : 'hidden';

  // Volume sliders: rebuilt only when the selection changes, so dragging is not interrupted.
  const vols = $('vols');
  const key = sel.map(r => r.id).join(',');
  if (vols.dataset.key !== key) {
    vols.dataset.key = key;
    vols.textContent = '';
    for (const r of sel) {
      const row = document.createElement('div');
      row.className = 'vol';
      row.innerHTML = '<label></label><button type="button">−</button><input type="range" min="0" max="100"><button type="button">+</button><output></output>';
      row.querySelector('label').textContent = r.name;
      const input = row.querySelector('input'), out = row.querySelector('output');
      const [minus, plus] = row.querySelectorAll('button');
      let timer = null;
      const set = v => {
        v = Math.max(0, Math.min(100, v));
        input.value = v; out.textContent = v;
        row.dataset.touched = Date.now();
        clearTimeout(timer);
        timer = setTimeout(() => send({ type: 'volume', room: r.id, volume: v }), 150);
      };
      input.oninput = () => set(Number(input.value));
      minus.onclick = () => set(Number(input.value) - 3);
      plus.onclick = () => set(Number(input.value) + 3);
      row.dataset.room = r.id;
      vols.appendChild(row);
    }
  }
  for (const row of vols.children) {
    const r = data.rooms.find(x => x.id === row.dataset.room);
    // Keep what the user just set until the speaker reports it back.
    if (r && !(Date.now() - Number(row.dataset.touched || 0) < 3000)) {
      row.querySelector('input').value = r.volume;
      row.querySelector('output').textContent = r.volume;
    }
  }
}

$('stop').onclick = () => send({ type: 'stop', rooms: selected });

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => {
    retry = 1000;
    // Adapter restarted (settings saved, update): reload so new stations show up.
    if (wasConnected) location.reload();
    wasConnected = true;
  };
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'status') {
      data = msg;
      if (busy && rooms().some(r => r.playing && r.station === busy)) busy = '';
      render();
    }
    else if (msg.type === 'error') { busy = ''; show('Fehler: ' + msg.message); render(); }
  };
  ws.onclose = () => { setTimeout(connect, retry); retry = Math.min(retry * 2, 15000); };
}
render();
connect();
</script>
</body>
</html>`;
}

module.exports = { renderPage };
