'use strict';

const keepSummaryFields = [
  ['distanceM', '总距离（米）', 0], ['durationS', '运动时长（秒）', 0],
  ['averagePace', '平均配速（秒/公里）', 0],
  ['calories', '热量（千卡）', 0], ['steps', '总步数', 0],
  ['averageCadence', '平均步频（步/分钟）', 0], ['elevationGain', '累计爬升（米）', 0]
];
const keepPointFields = [
  ['latitude', '纬度', -90, 90], ['longitude', '经度', -180, 180],
  ['offsetSeconds', '时间（距原开始时间的秒数）', -86400, 604800],
  ['altitude', '海拔（米）'], ['measuredSpeedMps', '速度（米/秒）', 0],
  ['heartRate', '心率（次/分钟）', 0], ['cadence', '步频（步/分钟）', 0],
  ['accuracyM', 'GPS 精度（米）', 0], ['distanceM', '累计距离（米）', 0]
];

function keepMetricXml(value, key, prefix = 'shou') {
  return Number.isFinite(value) ? '<' + prefix + ':' + key + '>' + value + '</' + prefix + ':' + key + '>' : '';
}

function keepLocalGpx(normalized, title, startTime) {
  const escape = value => String(value).replace(/[&<>]/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;'}[char]));
  const original = normalized.activity.startTime;
  const offset = startTime === null || original === null ? 0 : startTime - original;
  const segments = [];
  let segment = [];
  let previousTime = null;
  function finishSegment() {
    if (segment.length) segments.push('<trkseg>' + segment.join('') + '</trkseg>');
    segment = [];
    previousTime = null;
  }
  for (const point of normalized.points) {
    if (!point.coordinates || point.paused) {
      finishSegment();
      continue;
    }
    const [lat, lon] = point.coordinates;
    const time = point.timeMs;
    if (time !== null && previousTime !== null &&
        (time <= previousTime || time - previousTime > normalized.gapLimitSeconds * 1000)) finishSegment();
    const timestamp = time === null ? '' : '<time>' + new Date(time + offset).toISOString() + '</time>';
    const ele = Number.isFinite(point.altitude) ? '<ele>' + point.altitude + '</ele>' : '';
    const garmin = keepMetricXml(point.heartRate, 'hr', 'gpxtpx') + keepMetricXml(point.cadence, 'cad', 'gpxtpx');
    const extra = keepMetricXml(point.measuredSpeedMps, 'speedMps') +
      keepMetricXml(point.accuracyM, 'accuracyM') + keepMetricXml(point.distanceM, 'distanceM') +
      (garmin ? '<gpxtpx:TrackPointExtension>' + garmin + '</gpxtpx:TrackPointExtension>' : '');
    const extensions = extra ? '<extensions>' + extra + '</extensions>' : '';
    segment.push('<trkpt lat="' + lat + '" lon="' + lon + '">' + ele + timestamp + extensions + '</trkpt>');
    previousTime = time;
  }
  finishSegment();
  const summary = keepSummaryFields.map(([key]) => keepMetricXml(normalized.activity[key], key)).join('');
  return segments.length ? '<?xml version="1.0" encoding="UTF-8"?>' +
    '<gpx version="1.1" creator="SHOU U RUN" xmlns="http://www.topografix.com/GPX/1/1"' +
    ' xmlns:shou="https://github.com/x-zyz/SHOU-U-RUN/gpx/local-edit/1"' +
    ' xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><trk><name>' +
    escape(title) + '</name><desc>Locally edited copy of an activity imported from Keep.</desc>' +
    (summary ? '<extensions>' + summary + '</extensions>' : '') + segments.join('') + '</trk></gpx>' : null;
}

function keepLocalUploadPayload(normalized, startTime) {
  const original = normalized.activity.startTime;
  const offset = startTime === null || original === null ? 0 : startTime - original;
  const rawPoints = [];
  for (const point of normalized.points) {
    if (!point.coordinates || point.timeMs === null) continue;
    rawPoints.push({
      time: Math.round(point.timeMs + offset),
      lat: point.coordinates[0],
      lon: point.coordinates[1],
      speed: point.measuredSpeedMps,
      cadence: point.cadence,
      hr: point.heartRate,
      altitude: point.altitude,
      distance: point.distanceM,
      accuracy: point.accuracyM,
      paused: Boolean(point.paused)
    });
  }
  if (rawPoints.length < 2) return {error: '至少需要 2 个带时间和坐标的采样点才能上传。'};
  for (let i = 1; i < rawPoints.length; i++) {
    if (rawPoints[i].time < rawPoints[i - 1].time) return {error: '采样点时间不能倒退，请检查修改后的时间偏移。'};
  }
  const firstTime = rawPoints[0].time;
  const lastTime = rawPoints[rawPoints.length - 1].time;
  if (lastTime <= firstTime) return {error: '轨迹起止时间无效，结束时间必须晚于开始时间。'};
  const haversine = (a, b) => {
    const lat1 = a.lat * Math.PI / 180, lat2 = b.lat * Math.PI / 180;
    const dLat = lat2 - lat1, dLon = (b.lon - a.lon) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  let cumulativeDistance = 0;
  for (let i = 0; i < rawPoints.length; i++) {
    if (i > 0) cumulativeDistance += haversine(rawPoints[i - 1], rawPoints[i]);
    if (!Number.isFinite(rawPoints[i].distance)) rawPoints[i].distance = cumulativeDistance;
  }
  const duration = Number.isFinite(normalized.activity.durationS) && normalized.activity.durationS > 0
    ? normalized.activity.durationS : (lastTime - firstTime) / 1000;
  const distance = Number.isFinite(normalized.activity.distanceM) && normalized.activity.distanceM > 0
    ? normalized.activity.distanceM : (rawPoints[rawPoints.length - 1].distance || cumulativeDistance);
  if (!(distance > 0 && distance < 200000 && duration > 0 && duration < 86400)) {
    return {error: '运动距离或时长超出有效范围。'};
  }
  const fallbackSpeed = distance / duration;
  const fallbackCadence = Number.isFinite(normalized.activity.averageCadence) && normalized.activity.averageCadence > 0
    ? normalized.activity.averageCadence : 160;
  const points = rawPoints.map(point => ({
    time: point.time,
    lat: point.lat,
    lon: point.lon,
    speed: Number.isFinite(point.speed) ? point.speed : fallbackSpeed,
    cadence: Number.isFinite(point.cadence) ? point.cadence : fallbackCadence,
    hr: Number.isFinite(point.hr) ? Math.round(point.hr) : 140,
    altitude: Number.isFinite(point.altitude) ? point.altitude : 0,
    distance: point.distance,
    accuracy: Number.isFinite(point.accuracy) && point.accuracy >= 0 ? point.accuracy : 0,
    paused: point.paused
  }));
  const payload = {gcj02: true, distance, duration, points};
  if (Number.isFinite(normalized.activity.calories) && normalized.activity.calories > 0) payload.calories = normalized.activity.calories;
  if (Number.isFinite(normalized.activity.steps) && normalized.activity.steps > 0) payload.steps = normalized.activity.steps;
  if (Number.isFinite(normalized.activity.averageCadence) && normalized.activity.averageCadence > 0) payload.averageCadence = normalized.activity.averageCadence;
  if (Number.isFinite(normalized.activity.elevationGain) && normalized.activity.elevationGain >= 0) payload.elevationGain = normalized.activity.elevationGain;
  if (normalized.activity.timezone) payload.timezone = normalized.activity.timezone;
  return {payload};
}

function mountKeepLocalEditor(panel, native) {
  const section = document.createElement('section');
  section.className = 'work-card';
  section.hidden = true;
  section.innerHTML = `
    <h3>自选 Keep 活动</h3>
    <p role="status"></p>
    <label>来源<select data-filter>
      <option value="all">全部来源</option>
      <option value="nonApp">已识别的非 Keep App 来源</option>
      <option value="file">文件导入</option>
      <option value="external">外部设备或平台</option>
      <option value="app">Keep App</option>
      <option value="unknown">来源未知</option>
    </select></label>
    <label>选择记录<select data-record></select></label>
    <label>副本标题<input data-title maxlength="80"></label>
    <label>副本开始时间（本机时区）<input data-start type="datetime-local" step="1"></label>
    <details data-summary><summary>编辑整次运动数据</summary><p class="muted">这些数值单独保存在 GPX 扩展字段中，上传到 Keep 时也会一并提交；轨迹点仍可逐个编辑。</p></details>
    <details data-point><summary>编辑 GPS 采样点</summary>
      <label>采样点序号 <input data-index type="number" min="1" step="1" value="1"></label>
      <label><input data-pause type="checkbox"> 标记为暂停</label>
      <div data-point-fields></div>
      <button data-apply type="button">应用到此采样点</button>
    </details>
    <div class="row">
      <button data-upload type="button" class="primary">直接上传到 Keep</button>
      <button data-save type="button">保存本地 GPX 副本</button>
    </div>`;
  panel.after(section);
  const status = section.querySelector('[role=status]');
  const find = name => section.querySelector('[data-' + name + ']');
  const filter = find('filter'), record = find('record'), title = find('title'), start = find('start');
  const upload = find('upload'), save = find('save'), index = find('index'), pause = find('pause');
  const summary = find('summary'), pointPanel = find('point');
  upload.hidden = !native?.uploadKeep;

  function metricInputs(container, fields) {
    return fields.map(([key, text, min, max]) => {
      const label = document.createElement('label');
      label.textContent = text;
      const input = document.createElement('input');
      input.type = 'number';
      input.step = 'any';
      input.name = key;
      input.placeholder = '无数据';
      if (min !== undefined) input.min = min;
      if (max !== undefined) input.max = max;
      label.append(input);
      container.append(label);
      return [key, input];
    });
  }
  const summaryInputs = metricInputs(summary, keepSummaryFields);
  const pointInputs = metricInputs(find('point-fields'), keepPointFields);
  const fill = (inputs, values) => inputs.forEach(([key, input]) => { input.value = values[key] ?? ''; });
  const read = inputs => Object.fromEntries(inputs.map(([key, input]) =>
    [key, Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : null]));
  const labels = {file:'文件导入', external:'外部设备或平台', app:'Keep App', unknown:'来源未知'};
  let items = [];
  let edited;
  let pointIndex = 0;
  let shownResult = null;
  let uploading = false;

  function syncButtons() {
    title.disabled = save.disabled = !edited;
    upload.disabled = !edited || uploading || !native?.uploadKeep;
  }

  function select() {
    const run = record.value === '' ? null : items[Number(record.value)];
    const time = run?.activity.startTime;
    title.value = run ? 'Keep 户外跑步' : '';
    start.value = time == null ? '' : new Date(time - new Date(time).getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    start.disabled = time == null;
    summary.hidden = pointPanel.hidden = !run;
    edited = run ? { ...run, activity: {...run.activity}, points: run.points.slice() } : null;
    syncButtons();
    if (!edited) return;
    const {distanceM, durationS} = edited.activity;
    edited.activity.averagePace = distanceM > 0 && durationS > 0 ? durationS * 1000 / distanceM : null;
    fill(summaryInputs, edited.activity);
    index.max = edited.points.length;
    pointIndex = 0;
    showPoint();
  }

  function showPoint() {
    index.value = pointIndex + 1;
    const point = edited.points[pointIndex];
    const original = edited.activity.startTime;
    fill(pointInputs, {
      ...point, latitude:point.coordinates?.[0], longitude:point.coordinates?.[1],
      offsetSeconds: point.timeMs === null || original === null ? null : (point.timeMs - original) / 1000
    });
    pause.checked = point.paused;
  }

  index.onchange = () => {
    pointIndex = Math.max(0, Math.min(edited.points.length - 1, Math.floor(index.valueAsNumber || 1) - 1));
    showPoint();
  };

  find('apply').onclick = () => {
    if (!pointInputs.every(([, input]) => input.reportValidity())) return;
    const {latitude, longitude, offsetSeconds, ...metrics} = read(pointInputs);
    if ((latitude === null) !== (longitude === null)) {
      status.textContent = '纬度和经度需同时填写。';
      return;
    }
    if (offsetSeconds !== null && edited.activity.startTime === null) {
      status.textContent = '原记录缺少开始时间，无法编辑采样点的相对时间。';
      return;
    }
    const original = edited.points[pointIndex];
    edited.points[pointIndex] = {
      ...original, ...metrics,
      coordinates: latitude === null ? null : [latitude, longitude],
      timeMs: offsetSeconds === null ? (edited.activity.startTime === null ? original.timeMs : null) :
        edited.activity.startTime + offsetSeconds * 1000,
      paused: pause.checked
    };
    status.textContent = '已更新第 ' + (pointIndex + 1) + ' 个采样点。';
  };

  function render() {
    record.replaceChildren(new Option('请选择一条记录', ''));
    items.forEach((run, index) => {
      if (filter.value !== 'all' && filter.value !== run.origin &&
          !(filter.value === 'nonApp' && ['file','external'].includes(run.origin))) return;
      const {startTime, distanceM} = run.activity;
      const date = startTime === null ? '日期未知' : new Date(startTime).toLocaleString();
      const distance = distanceM === null ? '' : ' · ' + (distanceM / 1000).toFixed(2) + ' km';
      record.add(new Option(date + distance + ' · ' + labels[run.origin], index));
    });
    record.disabled = record.options.length < 2;
    select();
  }

  filter.onchange = render;
  record.onchange = select;
  upload.onclick = () => {
    if (!edited || uploading || !native?.uploadKeep || !summaryInputs.every(([, input]) => input.reportValidity())) return;
    const tokenInput = document.getElementById('keepToken');
    const loggedIn = Boolean(native.keepAuthState?.());
    const token = loggedIn ? '' : (tokenInput?.value.trim() || '');
    if (!loggedIn && !token) {
      status.textContent = '请先在上方登录 Keep 或输入 token，再上传。';
      return;
    }
    Object.assign(edited.activity, read(summaryInputs));
    const time = start.value ? Date.parse(start.value) : null;
    if (time !== null && !Number.isFinite(time)) {
      status.textContent = '请选择有效的开始时间。';
      return;
    }
    const built = keepLocalUploadPayload(edited, time);
    if (built.error) {
      status.textContent = built.error;
      return;
    }
    uploading = true;
    syncButtons();
    status.textContent = '正在上传编辑后的记录到 Keep…';
    native.uploadKeep(JSON.stringify(built.payload), token);
  };

  document.addEventListener('keep-upload-result', event => {
    if (!uploading) return;
    uploading = false;
    syncButtons();
    status.textContent = event.detail?.message || '上传请求已结束。';
  });

  save.onclick = () => {
    if (!edited || !summaryInputs.every(([, input]) => input.reportValidity())) return;
    Object.assign(edited.activity, read(summaryInputs));
    const time = start.value ? Date.parse(start.value) : null;
    if (time !== null && !Number.isFinite(time)) {
      status.textContent = '请选择有效的开始时间。';
      return;
    }
    const gpx = keepLocalGpx(edited, title.value.trim() || 'Keep 户外跑步', time);
    if (!gpx) {
      status.textContent = '这条记录没有可导出的 GPS 坐标。';
      return;
    }
    const bytes = new TextEncoder().encode(gpx);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    native.saveFile('keep-local-copy.gpx', btoa(binary), 'application/gpx+xml');
    status.textContent = '请在系统文件选择器中保存副本。';
  };

  return {
    reset() {
      shownResult = null;
      uploading = false;
      items = [];
      render();
      section.hidden = true;
    },
    receive(result) {
      section.hidden = false;
      if (shownResult === result) return;
      shownResult = result;
      items = result.phase === 'done' ? result.activities.map(activity => ({
        ...KeepRunImport.normalize(activity),
        origin: Object.hasOwn(labels, activity.origin) ? activity.origin : 'unknown'
      })) : [];
      render();
      status.textContent = result.phase === 'progress' ? '正在读取历史记录 · 已检查 ' + result.count + ' 条' :
        result.phase === 'done' ? '已读取 ' + items.length + ' 条 · 最多显示最近 20 条可用记录' :
        result.message || '读取 Keep 历史失败。';
    }
  };
}
