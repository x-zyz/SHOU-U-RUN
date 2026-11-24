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
    <details data-summary><summary>编辑整次运动数据</summary><p class="muted">这些数值单独保存在 GPX 扩展字段中，轨迹点仍可逐个编辑。</p></details>
    <details data-point><summary>编辑 GPS 采样点</summary>
      <label>采样点序号 <input data-index type="number" min="1" step="1" value="1"></label>
      <label><input data-pause type="checkbox"> 标记为暂停</label>
      <div data-point-fields></div>
      <button data-apply type="button">应用到此采样点</button>
    </details>
    <button data-save type="button">保存本地 GPX 副本</button>`;
  panel.after(section);
  const status = section.querySelector('[role=status]');
  const find = name => section.querySelector('[data-' + name + ']');
  const filter = find('filter'), record = find('record'), title = find('title'), start = find('start');
  const save = find('save'), index = find('index'), pause = find('pause');
  const summary = find('summary'), pointPanel = find('point');

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

  function select() {
    const run = record.value === '' ? null : items[Number(record.value)];
    const time = run?.activity.startTime;
    title.value = run ? 'Keep 户外跑步' : '';
    start.value = time == null ? '' : new Date(time - new Date(time).getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    start.disabled = time == null;
    title.disabled = save.disabled = !run;
    summary.hidden = pointPanel.hidden = !run;
    edited = run ? { ...run, activity: {...run.activity}, points: run.points.slice() } : null;
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
