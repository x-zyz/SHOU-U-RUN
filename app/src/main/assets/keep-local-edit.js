'use strict';

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
    segment.push('<trkpt lat="' + lat + '" lon="' + lon + '">' + timestamp + '</trkpt>');
    previousTime = time;
  }
  finishSegment();
  return segments.length ? '<?xml version="1.0" encoding="UTF-8"?>' +
    '<gpx version="1.1" creator="SHOU U RUN" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>' +
    escape(title) + '</name><desc>Locally edited copy of an activity imported from Keep.</desc>' +
    segments.join('') + '</trk></gpx>' : null;
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
    <button type="button">保存本地 GPX 副本</button>`;
  panel.after(section);
  const status = section.querySelector('[role=status]');
  const find = name => section.querySelector('[data-' + name + ']');
  const filter = find('filter'), record = find('record'), title = find('title'), start = find('start');
  const save = section.querySelector('button');
  const labels = {file:'文件导入', external:'外部设备或平台', app:'Keep App', unknown:'来源未知'};
  let items = [];

  function select() {
    const run = record.value === '' ? null : items[Number(record.value)];
    const time = run?.activity.startTime;
    title.value = run ? 'Keep 户外跑步' : '';
    start.value = time == null ? '' : new Date(time - new Date(time).getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    start.disabled = time == null;
    title.disabled = save.disabled = !run;
  }

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
    const run = items[Number(record.value)];
    const time = start.value ? Date.parse(start.value) : null;
    if (time !== null && !Number.isFinite(time)) {
      status.textContent = '请选择有效的开始时间。';
      return;
    }
    const gpx = keepLocalGpx(run, title.value.trim() || 'Keep 户外跑步', time);
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
    receive(result) {
      section.hidden = false;
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
