/**
 * Live dashboard (dependency-free HTML + canvas). Polls
 * `/api/sessions/:id/series` and draws BLE/WiFi RSSI and ultrasonic SNR.
 * Open in any browser on the room's network.
 */
export function dashboardHtml(sessionId: string): string {
  const sid = encodeURIComponent(sessionId);
  const script = `
var SID = ${JSON.stringify(sessionId)};
var Y_MIN = -100, Y_MAX = -30;
var BLE = '#3ef2ff', WIFI = '#39ff8b', SNR = '#ffb000', MUTED = '#5a6278';

function fmt(v, unit) { return v == null ? '—' : Math.round(v) + unit; }

function setup(canvas) {
  var dpr = window.devicePixelRatio || 1;
  var w = canvas.clientWidth || 600;
  var h = canvas.clientHeight || 150;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
  return { ctx: ctx, w: w, h: h };
}

function drawRssi(canvas, points) {
  var s = setup(canvas), ctx = s.ctx, w = s.w, h = s.h;
  var padL = 34, padR = 8, padT = 8, padB = 16;
  var pw = w - padL - padR, ph = h - padT - padB;
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.fillStyle = MUTED;
  [-30, -50, -70, -90].forEach(function (v) {
    var y = padT + (1 - (v - Y_MIN) / (Y_MAX - Y_MIN)) * ph;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke();
    ctx.fillText(String(v), 2, y + 3);
  });
  if (!points.length) {
    ctx.fillStyle = MUTED;
    ctx.fillText('no samples yet — ENGAGE the receiver', padL + 6, padT + ph / 2);
    return;
  }
  var t0 = points[0].t, t1 = points[points.length - 1].t;
  var span = Math.max(1, t1 - t0);
  function x(t) { return padL + ((t - t0) / span) * pw; }
  function y(v) {
    var c = Math.max(Y_MIN, Math.min(Y_MAX, v));
    return padT + (1 - (c - Y_MIN) / (Y_MAX - Y_MIN)) * ph;
  }
  [['ble', BLE], ['wifi', WIFI]].forEach(function (pair) {
    var key = pair[0], color = pair[1];
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    var started = false;
    points.forEach(function (p) {
      var v = p[key];
      if (v == null) { started = false; return; }
      var xx = x(p.t), yy = y(v);
      if (!started) { ctx.moveTo(xx, yy); started = true; } else { ctx.lineTo(xx, yy); }
    });
    ctx.stroke();
  });
  ctx.fillStyle = MUTED;
  ctx.fillText('dBm · last ' + Math.round(span / 1000) + 's', padL + 4, h - 3);
}

function drawSnr(canvas, points) {
  var s = setup(canvas), ctx = s.ctx, w = s.w, h = s.h;
  var padL = 34, padR = 8, padT = 8, padB = 16;
  var pw = w - padL - padR, ph = h - padT - padB;
  var max = 60;
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.fillStyle = MUTED;
  [0, 20, 40, 60].forEach(function (v) {
    var y = padT + (1 - v / max) * ph;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke();
    ctx.fillText(String(v), 2, y + 3);
  });
  if (!points.length) return;
  var t0 = points[0].t, t1 = points[points.length - 1].t;
  var span = Math.max(1, t1 - t0);
  ctx.strokeStyle = SNR;
  ctx.lineWidth = 2;
  ctx.beginPath();
  var started = false;
  points.forEach(function (p) {
    if (p.snr == null) { started = false; return; }
    var xx = padL + ((p.t - t0) / span) * pw;
    var yy = padT + (1 - Math.max(0, Math.min(max, p.snr)) / max) * ph;
    if (!started) { ctx.moveTo(xx, yy); started = true; } else { ctx.lineTo(xx, yy); }
  });
  ctx.stroke();
  ctx.fillStyle = MUTED;
  ctx.fillText('ultrasonic SNR · spectrum pending', padL + 4, h - 3);
}

function render(data) {
  var root = document.getElementById('devices');
  var meta = document.getElementById('meta');
  meta.textContent = 'session ' + data.sessionId + ' · updated ' +
    new Date(data.generatedAt).toLocaleTimeString() + ' · ' +
    data.devices.length + ' device(s) · window ' + Math.round(data.windowMs / 60000) + ' min';
  if (!data.devices.length) {
    root.innerHTML = '<p class="empty">No reports yet — open the receiver app and ENGAGE.</p>';
    return;
  }
  root.innerHTML = '';
  data.devices.forEach(function (d) {
    var latest = d.points.length ? d.points[d.points.length - 1] : {};
    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<h2>' + d.deviceId + ' <span>' + d.mode + '</span></h2>' +
      '<div class="vals">' +
        '<span class="ble">BLE <b>' + fmt(latest.ble, ' dBm') + '</b></span>' +
        '<span class="wifi">WiFi <b>' + fmt(latest.wifi, ' dBm') + '</b></span>' +
        '<span class="snr">SNR <b>' + fmt(latest.snr, '') + '</b></span>' +
      '</div>' +
      '<canvas class="chart"></canvas>' +
      '<canvas class="chart snr-chart"></canvas>';
    root.appendChild(card);
    var canvases = card.querySelectorAll('canvas');
    drawRssi(canvases[0], d.points);
    drawSnr(canvases[1], d.points);
  });
}

function refresh() {
  fetch('/api/sessions/' + encodeURIComponent(SID) + '/series', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(render)
    .catch(function () {});
}
refresh();
setInterval(refresh, 2000);
`;

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shusseki signal dashboard · ${escapeHtml(sessionId)}</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.4 ui-monospace, Menlo, Consolas, monospace; background:#05070a; color:#e8f6ff; margin:0; padding:20px; }
  h1 { font-size:17px; letter-spacing:.16em; text-transform:uppercase; color:#3ef2ff; margin:0 0 4px; }
  .meta { color:#5a6278; margin:0 0 16px; }
  a { color:#39ff8b; }
  .card { border:1px solid #14303a; background:#070c12; padding:10px 12px 6px; margin-bottom:14px; max-width:900px; }
  h2 { font-size:13px; margin:0 0 6px; color:#a9c6d6; letter-spacing:.06em; }
  h2 span { color:#5a6278; font-weight:400; margin-left:8px; }
  .vals { margin:0 0 6px; display:flex; gap:18px; flex-wrap:wrap; font-size:12px; }
  .ble { color:#3ef2ff; } .wifi { color:#39ff8b; } .snr { color:#ffb000; }
  .chart { width:100%; height:150px; display:block; }
  .snr-chart { height:90px; margin-top:4px; }
  .empty { color:#5a6278; }
</style></head><body>
<h1>電波 · Signal dashboard</h1>
<div class="meta" id="meta">loading…</div>
<div id="devices"><p class="empty">loading…</p></div>
<script>
${script}
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;",
  );
}
