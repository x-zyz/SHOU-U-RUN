(() => {
  'use strict';
  const desktop = window.Android?.desktopWorkbench === true;
  if (!desktop && !window.Android?.recordRun) return;

  const byId = id => document.getElementById(id);
  const route = document.querySelector('.map-panel');
  const parameters = document.querySelector('.controls');
  const real = document.querySelector('.real-recorder');
  const output = document.querySelector('.timing');
  const main = document.querySelector('main');
  const stats = document.querySelector('.stats');
  const header = document.querySelector('header');

  document.documentElement.classList.add('mobile-workbench');
  if (desktop) document.documentElement.classList.add('desktop-workbench');
  const pages = {route, parameters, real, output};
  for (const [name, panel] of Object.entries(pages)) {
    panel.id = 'workspace-' + name;
    panel.classList.add('workspace');
  }
  main.append(real);

  const sections = [
    ['route','路线','<path d="m4 5 5-2 6 3 5-2v15l-5 2-6-3-5 2V5Zm5-2v15m6-12v15"/>'],
    ['parameters','参数','<path d="M4 6h5m4 0h7M4 12h10m4 0h2M4 18h2m4 0h10"/><circle cx="11" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>'],
    ['real','真实跑步','<circle cx="15" cy="4" r="2"/><path d="m7 11 3-3 3 1 2 4h4M13 9l-2 6 4 2v4M11 15l-3 4H4"/>'],
    ['output','导出与登录','<path d="M12 15V3m-4 4 4-4 4 4M6 12H4v9h16v-9h-2"/>']
  ];
  const nav = document.createElement('nav');
  nav.className = 'workbench-nav';
  nav.setAttribute('aria-label','工作区');
  for (const [name, label, icon] of sections) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.workspace = name;
    button.setAttribute('aria-controls', pages[name].id);
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">' + icon + '</svg><span>' + label + '</span>';
    nav.append(button);
  }
  if (!desktop) document.body.append(nav);

  const schedule = document.createElement('div');
  schedule.className = 'work-card schedule-card';
  const scheduleTitle = document.createElement('h3');
  scheduleTitle.textContent = '配速与时间';
  schedule.append(scheduleTitle);
  const modeLabel = byId('mode').closest('label');
  modeLabel.before(schedule);
  schedule.append(modeLabel, byId('zone').closest('label'), document.querySelector('.dates'), byId('pace').closest('.slider'));
  const timeHint = document.createElement('p');
  timeHint.id = 'timeModeHint';
  timeHint.className = 'muted';
  schedule.append(timeHint);

  const basic = document.createElement('div');
  basic.className = 'work-card basic-card';
  const basicTitle = document.createElement('h3');
  basicTitle.textContent = '步频、步幅与心率';
  const cadence = byId('cadence').closest('.slider');
  cadence.before(basic);
  basic.append(basicTitle, cadence, byId('strideMode').closest('label'), byId('stride').closest('.slider'), byId('hr').closest('.slider'));

  const advanced = document.createElement('details');
  advanced.className = 'work-card advanced-card';
  const disclosure = document.createElement('summary');
  disclosure.textContent = '高级参数';
  advanced.append(disclosure);
  const variation = byId('variation').closest('.slider');
  const altitude = byId('altitude').closest('.slider');
  variation.before(advanced);
  for (let element = advanced.nextElementSibling; element; ) {
    const next = element.nextElementSibling;
    advanced.append(element);
    if (element === altitude) break;
    element = next;
  }

  const preview = document.createElement('div');
  preview.className = 'work-card preview-card';
  const previewTitle = document.createElement('h3');
  previewTitle.textContent = '配速曲线';
  const canvas = byId('chart');
  byId('zoneSummary').before(preview);
  preview.append(previewTitle, canvas, byId('zoneSummary'));
  const validation = document.createElement('p');
  validation.id = 'parameterStatus';
  validation.setAttribute('role','status');
  validation.className = 'workspace-feedback';
  validation.hidden = true;
  schedule.before(validation);

  const keep = document.createElement('div');
  keep.className = 'work-card keep-card';
  const keepTitle = [...output.children].find(el => el.tagName === 'H3');
  keepTitle.before(keep);
  for (let el = keep.nextElementSibling; el; ) {
    const next = el.nextElementSibling;
    keep.append(el);
    el = next;
  }

  const exportSummary = document.createElement('p');
  exportSummary.id = 'exportSummary';
  exportSummary.className = 'muted export-summary';
  exportSummary.textContent = '完成路线后，导出本地文件或上传到 Keep。';
  output.querySelector('h2').after(exportSummary);
  const returnToRoute = document.createElement('button');
  returnToRoute.type = 'button';
  returnToRoute.className = 'quiet go-route';
  returnToRoute.textContent = '返回路线规划';
  byId('status').after(returnToRoute);

  const routeStatus = document.createElement('p');
  routeStatus.id = 'routeStatus';
  routeStatus.className = 'workspace-feedback';
  routeStatus.setAttribute('role','status');
  routeStatus.textContent = '从校园示例开始，或在地图上设置起点和终点。';
  byId('route').parentElement.before(routeStatus);

  const toParameters = document.createElement('button');
  toParameters.type = 'button';
  toParameters.id = 'toParameters';
  toParameters.className = 'quiet next-workspace';
  toParameters.textContent = '调整跑步参数 →';
  toParameters.hidden = true;
  const routeActions = byId('route').parentElement;
  routeActions.classList.add('route-actions');
  routeActions.prepend(byId('sample'));
  route.querySelector('.map-frame').after(routeActions, routeStatus, toParameters);
  byId('stops').after(route.querySelector('.map-source'), byId('mapStatus'), route.querySelector('.map-jumps'));
  route.querySelector('h2').textContent = '规划路线';

  const recording = document.createElement('div');
  recording.className = 'work-card recording-card';
  const state = byId('realState');
  state.before(recording);
  const historyLabel = byId('realHistory').previousElementSibling;
  while (recording.nextElementSibling !== historyLabel) recording.append(recording.nextElementSibling);
  const history = document.createElement('div');
  history.className = 'work-card recording-history';
  const historyTitle = document.createElement('h3');
  historyTitle.textContent = '本机记录';
  history.append(historyTitle);
  historyLabel.before(history);
  while (history.nextElementSibling && history.nextElementSibling.id !== 'personalPace') history.append(history.nextElementSibling);

  if (desktop) {
    const inspector = document.createElement('aside');
    inspector.className = 'work-card map-inspector';
    inspector.setAttribute('aria-label', '路线设置');
    const frame = route.querySelector('.map-frame');
    while (frame.nextElementSibling) inspector.append(frame.nextElementSibling);
    frame.after(inspector);
    recording.hidden = true;
    history.hidden = true;
    for (const paragraph of real.querySelectorAll(':scope > p')) paragraph.hidden = true;
    real.querySelector('h2').textContent = '真实跑步数据';
    output.querySelector('h2').textContent = '导出与登录';
    byId('fitPersonalPace').textContent = '导入 JSONL 并拟合';
    byId('personalPaceHeading').nextElementSibling.textContent =
      '选择安卓版导出的真实跑步 JSONL。桌面端会在本机拟合配速，保存模型参数。';
  }

  const centerPick = byId('pickCenter');
  centerPick.hidden = false;
  const badge = header.querySelector('.badge');
  let current = '';
  const scrollOffsets = {};

  function show(name) {
    if (!pages[name] || name === current) return;
    if (current) scrollOffsets[current] = window.scrollY;
    current = name;
    if (desktop) window.Android.setWorkspace(name);
    for (const [key, panel] of Object.entries(pages)) panel.hidden = key !== name;
    for (const button of nav.children) {
      if (button.dataset.workspace === name) button.setAttribute('aria-current','page');
      else button.removeAttribute('aria-current');
    }
    badge.textContent = name === 'real' ? '真实 GPS' : '模拟活动';
    badge.classList.toggle('real-badge',name === 'real');
    if (name === 'route') document.querySelector('.map-frame').after(stats);
    if (name === 'parameters') parameters.querySelector('h2').after(stats);
    if (name === 'output') exportSummary.before(stats);
    requestAnimationFrame(() => {
      window.scrollTo(0, scrollOffsets[name] || 0);
      document.dispatchEvent(new CustomEvent('workspacechange', {detail: name}));
    });
  }
  nav.addEventListener('click', e => {
    const button = e.target.closest('button[data-workspace]');
    if (button) show(button.dataset.workspace);
  });
  returnToRoute.addEventListener('click', () => show('route'));
  toParameters.addEventListener('click', () => show('parameters'));
  if (desktop) window.showRunWorkspace = show;
  show('route');
})();
