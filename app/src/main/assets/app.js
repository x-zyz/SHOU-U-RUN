'use strict';
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const paceText = p => { const s = Math.round(p); return Math.floor(s / 60) + '′' + pad(s % 60) + '″'; };
const timeText = seconds => {
  const s = Math.round(seconds), minutes = Math.floor(s / 60);
  return minutes >= 60 ? Math.floor(minutes / 60) + ':' + pad(minutes % 60) + ':' + pad(s % 60) : minutes + ':' + pad(s % 60);
};
let noiseSeed = crypto.getRandomValues(new Uint32Array(1))[0];
let startPin = null, endPin = null, via = [], routeCoords = null, activity = null;
let picking = 'start', version = 0, markers = [], keepUploading = false;

const map = L.map('map', {zoomControl:false}).setView([30.88913,121.89635], 16);
L.control.zoom({position:'bottomright'}).addTo(map);
RunOffline.install(map);
const localRouter = RunLocalRouter.create(RunOfflineData);
const mobile = document.documentElement.classList.contains('mobile-workbench');
const line = L.polyline([], {color:mobile ? '#005fc7' : '#17664e', weight:6, opacity:.9}).addTo(map);
$('city').onclick = () => map.fitBounds([[30.72,120.85],[31.86,122.05]]);
$('downtown').onclick = () => map.setView([31.2304,121.4737], 15);
$('chongming').onclick = () => map.setView([31.623,121.397], 13);
$('campus').onclick = () => map.setView([30.88913,121.89635], 16);

function feedback(id, message, error = false) {
  const element = $(id);
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('error', error);
}

function status(message, error = false) { feedback('status', message, error); }

function routeStatus(message, error = false) {
  feedback($('routeStatus') ? 'routeStatus' : 'status', message, error);
}

function formatDate(ms) { return new Date(ms).toISOString().slice(0, 19); }

function parseDate(id) {
  const value = $(id).value;
  if (!value) throw Error('请选择完整的开始和结束日期与时间。');
  const time = Date.parse(value + 'Z') - Number($('zone').value) * 3600000;
  if (!Number.isFinite(time)) throw Error('日期无效，请重新选择。');
  return time;
}

$('start').value = formatDate(Date.now() + 8 * 3600000);
$('end').value = formatDate(Date.now() + 8 * 3600000 + 1200000);

function setPick(type) {
  picking = type;
  for (const name of ['Start', 'End', 'Via']) {
    const active = type === name.toLowerCase();
    const button = $('pick' + name);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  $('mapHint').textContent = {
    start:mobile ? '点击地图设置起点，或移动地图后选取中心点。' : '点击地图设置起点。',
    end:mobile ? '点击地图设置终点，或移动地图后选取中心点。' : '点击地图设置终点。',
    via:'点击地图添加途经点，最多 6 个。'
  }[type];
}

function clearRoute() {
  version++;
  routeCoords = null;
  line.setLatLngs([]);
  refresh();
}

function redraw() {
  markers.forEach(marker => marker.remove());
  markers = [];
  const pins = [[startPin,'起','start','起点'], ...via.map((point,i) => [point,String(i+1),'via','途经点 ' + (i+1)]), [endPin,'终','end','终点']];
  for (const [point, text, type, title] of pins) {
    if (!point) continue;
    const icon = L.divIcon({className:'', html:'<div class="pin ' + type + '"><span>' + text + '</span></div>', iconSize:[26,26], iconAnchor:[13,13]});
    markers.push(L.marker(point,{icon,title,alt:title}).addTo(map));
  }
  const position = p => p ? p.map(x => x.toFixed(5)).join(', ') : '未选';
  $('stops').textContent = '起点：' + position(startPin) + '　终点：' + position(endPin) + '　途经点 ' + via.length + ' 个';
  $('undo').disabled = !startPin && !endPin && !via.length;
  $('clear').disabled = $('undo').disabled;
  const ready = Boolean(startPin && endPin);
  $('route').disabled = !ready;
  if (mobile) {
    $('sample').classList.toggle('primary', !ready);
    $('route').classList.toggle('primary', ready);
  }
}

function pickPoint(coordinates) {
  if (picking === 'via' && via.length >= 6) {
    routeStatus('最多添加 6 个途经点。', true);
    return;
  }
  try {
    const snapped = localRouter.snap(coordinates);
    if (picking === 'start') { startPin = snapped.point; setPick('end'); }
    else if (picking === 'end') endPin = snapped.point;
    else via.push(snapped.point);
    clearRoute();
    redraw();
    routeStatus('已吸附到步行路网，移动 ' + Math.round(snapped.distance) + ' 米。选齐起终点后可规划路线。');
  } catch (error) {
    routeStatus(error.message + '。请调整选点。', true);
  }
}

map.on('click', e => pickPoint([e.latlng.lat,e.latlng.lng]));
$('pickCenter').onclick = () => {
  const center = map.getCenter();
  pickPoint([center.lat, center.lng]);
};
for (const name of ['Start','End','Via']) $('pick' + name).onclick = () => setPick(name.toLowerCase());
$('clear').onclick = () => {
  startPin = endPin = null;
  via = [];
  clearRoute();
  redraw();
  setPick('start');
  routeStatus('点位已清空，可以重新选点或加载校园示例。');
};
$('undo').onclick = () => {
  if (via.length) via.pop();
  else if (endPin) { endPin = null; setPick('end'); }
  else { startPin = null; setPick('start'); }
  clearRoute();
  redraw();
  routeStatus('已撤销一个点位，请重新规划步行路线。');
};

function acceptRoute(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2 ||
      coordinates.some(point => point.length < 2 || !point.every(Number.isFinite))) throw Error('路线服务返回了无效坐标');
  routeCoords = coordinates;
  line.setLatLngs(coordinates);
  map.fitBounds(line.getBounds(), {padding:[28,28]});
  refresh();
}

window.onRouteResult = (id, result, error) => {
  if (+id !== version) return;
  if (error) { routeStatus(error, true); return; }
  try {
    const data = JSON.parse(result);
    if (data.code !== 'Ok' || !data.routes?.length) throw Error('没有找到可用的步行路线，请调整选点');
    acceptRoute(data.routes[0].geometry.coordinates.map(point => [point[1], point[0]]));
  } catch (failure) { routeStatus(failure.message, true); }
};

$('route').onclick = () => {
  clearRoute();
  if (!startPin || !endPin) { routeStatus('请先选择起点和终点。', true); return; }
  try {
    acceptRoute(localRouter.route([startPin, ...via, endPin]));
    routeStatus('已沿标注的步行路网规划，可继续调整跑步参数。');
  } catch (error) { routeStatus('规划失败：' + error.message + '。', true); }
};

$('sample').onclick = async () => {
  clearRoute();
  const request = version;
  $('sample').disabled = true;
  try {
    const response = await fetch('sample.json');
    if (!response.ok) throw Error('无法读取校园示例。');
    const points = await response.json();
    if (version !== request) return;
    startPin = points[0];
    endPin = points.at(-1);
    via = [];
    setPick('via');
    redraw();
    acceptRoute(localRouter.route([startPin, endPin]));
    routeStatus('已加载龙光蓝鲸世界 → 上海海洋大学 1 号门。');
  } catch (error) {
    if (version === request) routeStatus('示例加载失败：' + error.message, true);
  } finally { $('sample').disabled = false; }
};

function chart(record) {
  const canvas = $('chart');
  const summary = $('zoneSummary');
  summary.replaceChildren();
  if (!record) {
    canvas.hidden = true;
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '规划路线并设置有效参数后查看配速曲线。';
    summary.append(empty);
    return;
  }
  canvas.hidden = false;
  const paces = record.points.map(point => 1000 / point.speed);
  const seconds = Array(6).fill(0);
  for (let i=1; i<paces.length; i++) {
    const zone = RunZones.classify(paces[i]);
    if (zone >= 0) seconds[zone] += (record.points[i].time - record.points[i-1].time) / 1000;
  }
  const title = document.createElement('h3');
  title.textContent = '配速区间 · 实际时间占比';
  summary.append(title);
  RunZones.zones.forEach(([name, lower, upper, color], i) => {
    const row = document.createElement('div');
    row.className = 'zone-stat';
    const label = document.createElement('span');
    label.textContent = name;
    if (mobile) {
      const range = document.createElement('small');
      range.textContent = i === 0 ? '< ' + paceText(upper) : i === 5 ? '≥ ' + paceText(lower) : paceText(lower) + '–' + paceText(upper);
      label.append(range);
    }
    const meter = document.createElement('meter');
    const percentage = seconds[i] / record.duration * 100;
    meter.max = 100;
    meter.value = percentage;
    meter.style.accentColor = color;
    meter.setAttribute('aria-label', name + '占比');
    const value = document.createElement('span');
    value.textContent = timeText(seconds[i]) + ' · ' + percentage.toFixed(1) + '%';
    row.append(label, meter, value);
    summary.append(row);
  });

  const width = canvas.clientWidth;
  if (width < 80) return;
  const height = 152, scale = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.style.height = height + 'px';
  const context = canvas.getContext('2d');
  context.scale(scale, scale);
  const fastest = Math.max(0, Math.floor((Math.min(...paces) - 8) / 15) * 15);
  const slowest = Math.max(fastest + 30, Math.ceil((Math.max(...paces) + 8) / 15) * 15);
  const left = 45, right = width - 12, top = 16, bottom = height - 23;
  const x = point => left + (point.time - record.points[0].time) / 1000 / record.duration * (right - left);
  const y = p => top + (p - fastest) / (slowest - fastest) * (bottom - top);
  const colors = getComputedStyle(canvas);
  const muted = colors.getPropertyValue('--muted').trim() || '#545b67';
  const border = colors.getPropertyValue('--line').trim() || '#dce0e9';
  context.font = '10px system-ui';
  for (const value of [fastest, (fastest + slowest) / 2, slowest]) {
    context.strokeStyle = border;
    context.beginPath();
    context.moveTo(left, y(value));
    context.lineTo(right, y(value));
    context.stroke();
    context.fillStyle = muted;
    context.fillText(paceText(value), 5, y(value) + 3);
  }
  context.lineWidth = 2.5;
  context.lineJoin = 'round';
  for (let i=1; i<paces.length; i++) {
    context.strokeStyle = RunZones.zones[RunZones.classify(paces[i])]?.[3] || '#005fc7';
    context.beginPath();
    context.moveTo(x(record.points[i-1]), y(paces[i-1]));
    context.lineTo(x(record.points[i]), y(paces[i]));
    context.stroke();
  }
  context.fillStyle = muted;
  context.fillText('0:00', left, height - 6);
  context.textAlign = 'right';
  context.fillText(timeText(record.duration), right, height - 6);
  canvas.setAttribute('aria-label', '模拟配速曲线，平均每公里 ' + paceText(record.pace) + '。区间时长见下方列表。');
}

let refreshFrame = null;
function scheduleRefresh() {
  if (refreshFrame === null) refreshFrame = requestAnimationFrame(refresh);
}

function refresh() {
  if (refreshFrame !== null) cancelAnimationFrame(refreshFrame);
  refreshFrame = null;
  activity = null;
  $('gpx').disabled = $('fit').disabled = $('keepUpload').disabled = true;
  const paceMode = $('mode').value === 'pace';
  const manualStride = $('strideMode').value === 'set';
  $('pace').disabled = !paceMode;
  $('end').readOnly = paceMode;
  $('stride').disabled = !manualStride;
  $('cadence').disabled = manualStride;
  if ($('timeModeHint')) $('timeModeHint').textContent = paceMode ? '结束时间由路线距离和平均配速计算。' : '平均配速由路线距离和起止时间计算。';

  let pace = Number($('pace').value);
  const distance = routeCoords ? RunCore.lengths(routeCoords).at(-1) : 0;
  $('distance').textContent = distance ? (distance / 1000).toFixed(2) : '—';
  $('duration').textContent = '—';
  $('paceSummary').textContent = '—';
  if ($('toParameters')) $('toParameters').hidden = !distance;
  if ($('parameterStatus')) $('parameterStatus').hidden = true;
  try {
    let start = 0, duration = 0;
    if (distance) {
      start = parseDate('start');
      if (paceMode) {
        duration = Math.min(Math.floor(distance * 900 / 1000),
          Math.max(Math.ceil(distance * 180 / 1000), Math.round(distance * pace / 1000)));
        $('end').value = formatDate(start + duration * 1000 + Number($('zone').value) * 3600000);
      } else {
        duration = (parseDate('end') - start) / 1000;
        if (duration <= 0) throw Error('结束时间须晚于开始时间。跨天时请选择次日日期。');
        pace = duration * 1000 / distance;
        if (pace < 180 || pace > 900) throw Error('当前时间对应的配速超出 3–15 分钟/公里，请调整起止时间。');
        $('pace').value = Math.round(pace);
      }
    }
    if (manualStride) {
      const target = Math.round(60000 / (pace * Number($('stride').value)));
      if (target < 80 || target > 220) throw Error('当前步幅需要 ' + target + ' 步/分，超出 80–220 范围，请调整。');
      $('cadence').value = target;
    } else $('stride').value = (60000 / (pace * Number($('cadence').value))).toFixed(2);

    $('paceValue').textContent = paceText(pace) + ' /km';
    $('cadenceValue').textContent = $('cadence').value + ' 步/分';
    $('strideValue').textContent = (60000 / (pace * Number($('cadence').value))).toFixed(2) + ' 米';
    $('hrValue').textContent = $('hr').value + ' bpm';
    $('variationValue').textContent = $('variation').value + '%';
    $('gpsNoiseValue').textContent = $('gpsNoise').value + ' 米';
    $('dropoutValue').textContent = $('dropout').value + '%';
    $('altitudeValue').textContent = $('altitude').value + ' 米';

    const paceState = window.Android?.fitRunPace ? RunPaceProfile.get() : null;
    const paceProfile = paceState?.enabled ? paceState.profile : null;
    $('paceModelStatus').hidden = !paceState?.profile;
    $('paceModelStatus').textContent = paceProfile
      ? '个人配速模型已启用。速度噪声设为 4% 时使用拟合强度，其他数值按比例调整。'
      : '当前使用默认配速模型。可在「真实跑步」切换。';

    if (distance) {
      activity = RunCore.build(routeCoords, {start, duration, cadence:Number($('cadence').value),
        paceProfile, hr:Number($('hr').value), variation:Number($('variation').value), altitude:Number($('altitude').value),
        title:$('title').value, offset:Number($('zone').value), seed:noiseSeed, jitter:Number($('gpsNoise').value),
        dropout:Number($('dropout').value)/100, stops:$('noiseStops').checked, surges:$('surges').checked, finishSlow:$('finishSlow').checked});
      $('gpx').disabled = $('fit').disabled = false;
      $('duration').textContent = timeText(activity.duration);
      $('paceSummary').textContent = paceText(activity.pace);
      status('路线与参数已就绪，可导出或上传。');
      feedback('exportSummary', $('start').value.replace('T',' ') + ' → ' + $('end').value.replace('T',' '));
    } else {
      status('先完成路线规划，即可导出。');
      feedback('exportSummary', '完成路线后，导出本地文件或上传到 Keep。');
    }
  } catch (error) {
    activity = null;
    status(error.message, true);
    if ($('parameterStatus')) {
      $('parameterStatus').hidden = false;
      feedback('parameterStatus', error.message, true);
    }
    feedback('exportSummary', '请在参数页调整配速与时间。');
  }
  updateKeepControls();
  chart(activity);
}

document.addEventListener('personalpacechange', refresh);

const parameterFields = ['pace','cadence','stride','hr','variation','altitude','mode','strideMode','start','end','zone','title','gpsNoise','dropout','noiseStops','surges','finishSlow'];
for (const id of parameterFields) $(id).addEventListener('input', scheduleRefresh);
document.addEventListener('workspacechange', e => {
  if (e.detail === 'route') map.invalidateSize({pan:false});
  if (e.detail === 'parameters') chart(activity);
});
window.addEventListener('resize', () => {
  if (!$('map').closest('[hidden]')) map.invalidateSize({pan:false});
  if (!$('chart').closest('[hidden]')) chart(activity);
});
function exportFile(ext){try{refresh();if(!activity)throw Error('请先完成有效的路线和时间设置');const bytes=ext==='gpx'?new TextEncoder().encode(RunCore.gpx(activity)):RunCore.fit(activity),name='RunLab_'+$('start').value.replace(/[^0-9]/g,'')+'.'+ext;let bin='';for(let i=0;i<bytes.length;i+=8192)bin+=String.fromCharCode(...bytes.subarray(i,i+8192));if(window.Android)Android.saveFile(name,btoa(bin),ext==='gpx'?'application/gpx+xml':'application/octet-stream');else{const u=URL.createObjectURL(new Blob([bytes])),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}status('已准备文件，请选择保存位置。');}catch(e){status('导出失败：'+e.message,true);}}
$('rerollNoise').onclick=()=>{noiseSeed=crypto.getRandomValues(new Uint32Array(1))[0];refresh();};
const keepBridge = window.Android;
let keepAccount = keepBridge?.keepAuthState?.() || '';
const canRestoreKeep = Boolean(keepBridge?.reportKeepSession);
let keepAuthBusy = canRestoreKeep;
let keepBatchBusy = false;
let keepBatchMatches = 0;
let keepSmsPhone = '';
let keepSmsRetryAt = 0;

function updateKeepControls() {
  const loggedIn = Boolean(keepAccount);
  const phone = $('keepPhone').value.trim();
  const seconds = Math.max(0, Math.ceil((keepSmsRetryAt - Date.now()) / 1000));
  $('keepSession').textContent = loggedIn ? '已登录 Keep · ' + keepAccount : '尚未登录 Keep';
  $('keepLoginFields').hidden = loggedIn;
  $('keepLogoutRow').hidden = !loggedIn;
  $('keepFallback').hidden = loggedIn;
  $('keepRememberToken').hidden = !keepBridge?.saveKeepToken;
  $('keepRememberToken').disabled = keepAuthBusy || keepUploading || !$('keepToken').value.trim();
  $('keepSendSms').textContent = seconds ? seconds + ' 秒后重发' : '发送验证码';
  $('keepSendSms').disabled = !keepBridge?.sendKeepSms || keepAuthBusy || seconds > 0 || !/^1[3-9][0-9]{9}$/.test(phone);
  $('keepLogin').disabled = !keepBridge?.verifyKeepSms || keepAuthBusy || !keepSmsPhone || phone !== keepSmsPhone ||
    !/^[0-9]{4,8}$/.test($('keepCode').value.trim());
  $('keepLogout').disabled = keepAuthBusy || keepUploading || keepBatchBusy;
  $('keepScanFiles').disabled = !loggedIn || keepAuthBusy || keepUploading || keepBatchBusy;
  $('keepConvertFiles').disabled = $('keepScanFiles').disabled || !keepBatchMatches;
  $('keepUpload').disabled = !keepBridge?.uploadKeep || !activity || keepUploading || keepAuthBusy || keepBatchBusy ||
    (!loggedIn && !$('keepToken').value.trim());
}

function keepMessage(id, message, error = false) {
  $(id).textContent = message;
  $(id).classList.toggle('error', error);
}

for (const id of ['keepPhone', 'keepCode', 'keepToken']) {
  $(id).addEventListener('input', updateKeepControls);
}
$('keepSendSms').onclick = () => {
  if ($('keepSendSms').disabled) return;
  keepAuthBusy = true;
  keepSmsPhone = $('keepPhone').value.trim();
  keepSmsRetryAt = Date.now() + 60000;
  $('keepCode').value = '';
  keepMessage('keepAuthStatus', '正在向 Keep 请求验证码…');
  updateKeepControls();
  const timer = setInterval(() => {
    updateKeepControls();
    if (Date.now() >= keepSmsRetryAt) clearInterval(timer);
  }, 1000);
  keepBridge.sendKeepSms(keepSmsPhone);
};
$('keepLogin').onclick = () => {
  if ($('keepLogin').disabled) return;
  const code = $('keepCode').value.trim();
  $('keepCode').value = '';
  keepAuthBusy = true;
  keepMessage('keepAuthStatus', '正在登录 Keep…');
  updateKeepControls();
  keepBridge.verifyKeepSms(keepSmsPhone, code);
};
$('keepRememberToken').onclick = () => {
  if ($('keepRememberToken').disabled || !keepBridge?.saveKeepToken) return;
  const token = $('keepToken').value.trim();
  keepAuthBusy = true;
  keepMessage('keepAuthStatus', '正在加密保存凭证…');
  updateKeepControls();
  keepBridge.saveKeepToken(token);
};
$('keepLogout').onclick = () => {
  keepAuthBusy = true;
  updateKeepControls();
  keepBridge.logoutKeep();
};
window.onKeepAuthResult = (phase, ok, message) => {
  keepAuthBusy = false;
  keepAccount = keepBridge.keepAuthState();
  if (phase === 'sms' && !ok) keepSmsPhone = '';
  if (((phase === 'login' || phase === 'manual') && ok) || phase === 'logout' || phase === 'expired') {
    keepSmsPhone = '';
    keepBatchMatches = 0;
    $('keepPhone').value = '';
    $('keepCode').value = '';
    $('keepToken').value = '';
  }
  keepMessage('keepAuthStatus', message, !ok);
  updateKeepControls();
};

$('keepUpload').onclick = () => {
  refresh();
  if ($('keepUpload').disabled) return;
  const token = keepAccount ? '' : $('keepToken').value.trim();
  keepUploading = true;
  $('keepToken').value = '';
  keepMessage('keepUploadStatus', '正在提交到 Keep…');
  updateKeepControls();
  keepBridge.uploadKeep(JSON.stringify(activity), token);
};
window.onKeepUploadResult = (ok, message) => {
  keepUploading = false;
  keepMessage('keepUploadStatus', message, !ok);
  updateKeepControls();
};
$('keepBatch').hidden = !keepBridge?.scanKeepFiles;
$('keepScanFiles').onclick = () => {
  if ($('keepScanFiles').disabled) return;
  keepBatchBusy = true;
  keepBatchMatches = 0;
  keepMessage('keepBatchStatus', '正在扫描 Keep 跑步历史…');
  updateKeepControls();
  keepBridge.scanKeepFiles();
};
$('keepConvertFiles').onclick = () => {
  if ($('keepConvertFiles').disabled) return;
  if (!window.confirm('将处理最多 ' + keepBatchMatches + ' 条已匹配记录，每条时间提前 15 秒并在 Keep 新建一条记录。原记录会保留。继续吗？')) return;
  keepBatchMatches = 0;
  keepBatchBusy = true;
  keepMessage('keepBatchStatus', '正在逐条转换并提交…');
  updateKeepControls();
  keepBridge.convertKeepFiles();
};
function keepBatchProgress(result) {
  return '已上传 ' + result.Completed + ' 条，跳过 ' + result.Skipped + ' 条，曾提交或需核对 ' + result.Held +
    ' 条，共 ' + result.Total + ' 条。';
}
window.onKeepBatchResult = result => {
  if (result.phase === 'convertProgress') {
    keepMessage('keepBatchStatus', keepBatchProgress(result.result));
    return;
  }
  if (result.phase === 'scanProgress') {
    keepMessage('keepBatchStatus', '已检查 ' + result.count + ' 条跑步记录…');
    return;
  }
  keepBatchBusy = false;
  if (result.phase === 'scanDone') {
    keepBatchMatches = result.matched;
    const message = '已检查 ' + result.scanned + ' 条，匹配 ' + result.matched + ' 条。' +
      (result.unavailable ? ' 另有 ' + result.unavailable + ' 条详情不可读。' : '');
    keepMessage('keepBatchStatus', message);
  } else if (result.phase === 'convertDone') {
    keepMessage('keepBatchStatus', keepBatchProgress(result.result) + (result.result.Failure ? ' · ' + result.result.Failure : ''), Boolean(result.result.Failure));
  } else {
    keepMessage('keepBatchStatus', result.message, true);
  }
  updateKeepControls();
};

updateKeepControls();
if (canRestoreKeep) {
  keepMessage('keepAuthStatus', '正在检查本机 Keep 登录…');
  keepBridge.reportKeepSession();
}
$('gpx').onclick=()=>exportFile('gpx');$('fit').onclick=()=>exportFile('fit');window.onSaveResult=(ok,msg)=>status(msg,!ok);refresh();redraw();setPick('start');
