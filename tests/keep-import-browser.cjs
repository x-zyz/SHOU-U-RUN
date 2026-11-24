'use strict';

// Run with the bundled map test dependency:
// $env:NODE_PATH='local-build\map-deps\node_modules'; node tests/keep-import-browser.cjs

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require('playwright');

const assets = path.resolve(__dirname, '../app/src/main/assets');
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(assets, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(assets + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, body) => {
    if (error) { res.writeHead(404).end(); return; }
    const type = {'.html': 'text/html; charset=utf-8', '.js': 'application/javascript',
      '.json': 'application/json', '.css': 'text/css', '.png': 'image/png'}[path.extname(file)];
    res.writeHead(200, {'Content-Type': type || 'application/octet-stream'}).end(body);
  });
});

const at = (seconds, speed = 2.5, extra = {}) => ({
  timestamp: seconds * 10, speed: speed * 3.6, currentTotalDistance: seconds * speed,
  accuracyRadius: 0, isPause: false, ...extra
});
const activity = {
  source: 'keep', activityId: 'fixture', dataType: 'outdoorRunning',
  startTime: 1767225600000, endTime: 1767225660000, distanceM: 150, durationS: 60,
  points: Array.from({length: 13}, (_, i) => at(i * 5, 2.5, {
    latitude: 31.2 + i * 0.0001, longitude: 121.4 + i * 0.0001
  }))
};

let browser;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {channel: 'chrome'})});
  const context = await browser.newContext({viewport: {width: 1180, height: 900}});
  await context.addInitScript(() => {
    window.__calls = {imports: 0, report: null, sample: null};
    window.Android = {
      desktopWorkbench: true,
      fitRunPace: () => {},
      importKeepRun: () => { window.__calls.imports++; },
      saveKeepImportArtifacts: (report, sample) => {
        window.__calls.report = report;
        window.__calls.sample = sample;
      },
      recordRun: () => {},
      recorderState: () => JSON.stringify({state: 'idle', file: '', activeSeconds: 0, count: 0}),
      realRunHistory: () => '[]',
      keepAuthState: () => '',
      importKeepHistory: () => {},
      saveFile: (...args) => { window.__calls.file = args; },
      setWorkspace: () => {}
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 15000});
  await page.waitForFunction(() => window.KeepRunImport && window.RunPaceProfile);
  await page.evaluate(() => window.showRunWorkspace?.('real'));
  assert.equal(await page.locator('#importKeepRun').isVisible(), true, 'import button visible');
  await page.locator('#importKeepRun').click();
  assert.equal(await page.evaluate(() => window.__calls.imports), 1, 'native import invoked');
  assert.match(await page.locator('#personalPaceStatus').textContent(), /正在从 Keep 读取/);

  await page.evaluate(activity => {
    window.onKeepImportResult(false, undefined, '请先在页面下方登录 Keep，再导入跑步。');
    window.onKeepImportResult(true, activity, '');
  }, activity);

  await page.waitForFunction(() => document.querySelector('#personalPaceStatus').textContent.includes('Keep 导入成功'));
  assert.match(await page.locator('#personalPaceSummary').textContent(), /^Keep 导入 · 1 次跑步 · 60 秒/);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('shou.personal-pace.v1')));
  assert.equal(stored.enabled, true);
  assert.equal(stored.profile.source, 'keep');
  assert.equal(stored.profile.imports[0].source, 'keep');
  const report = JSON.parse(await page.evaluate(() => window.__calls.report));
  const sample = JSON.parse(await page.evaluate(() => window.__calls.sample));
  assert.equal(report.summary.windowCount, 12);
  assert.equal(report.summary.validSeconds, 60);
  assert.equal(report.fit.ok, true);
  assert.ok(!JSON.stringify(report).includes('latitude'));
  assert.equal(sample.sanitized, true);
  assert.ok(sample.points.every(point => point.latitude === undefined && point.longitude === undefined));

  await page.locator('#browseKeepHistory').click();
  await page.evaluate(activity => window.onKeepHistoryResult({
    phase: 'done',
    activities: ['file', 'app', 'external', 'unknown'].map(origin => ({...activity, origin}))
  }), activity);
  await page.locator('[data-filter]').selectOption('nonApp');
  assert.equal(await page.locator('[data-record] option').count(), 3);
  await page.locator('[data-record]').selectOption('2');
  await page.locator('[data-title]').fill('Local & edited');
  const start = page.locator('[data-start]');
  const edited = await start.evaluate(input => {
    const date = new Date(input.value);
    date.setSeconds(date.getSeconds() + 120);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  await start.fill(edited);
  await page.getByText('编辑整次运动数据', {exact:true}).click();
  await page.locator('[data-summary] input[name="distanceM"]').fill('160.5');
  await page.getByText('编辑 GPS 采样点', {exact:true}).click();
  await page.locator('[data-point-fields] input[name="heartRate"]').fill('145');
  await page.locator('[data-point-fields] input[name="altitude"]').fill('12.5');
  await page.locator('[data-apply]').click();
  await page.getByRole('button', {name: '保存本地 GPX 副本'}).click();
  const [name, data, mime] = await page.evaluate(() => window.__calls.file);
  const xml = Buffer.from(data, 'base64').toString('utf8');
  assert.equal(name, 'keep-local-copy.gpx');
  assert.equal(mime, 'application/gpx+xml');
  assert.ok(xml.includes('Local &amp; edited'));
  assert.ok(xml.includes(new Date(activity.startTime + 120000).toISOString()));
  assert.ok(xml.includes('lat="31.2" lon="121.4"'));
  assert.ok(xml.includes('<shou:distanceM>160.5</shou:distanceM>'));
  assert.ok(xml.includes('<gpxtpx:hr>145</gpxtpx:hr>'));
  assert.ok(xml.includes('<ele>12.5</ele>'));
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('shou.personal-pace.v1'))), stored);
  assert.deepEqual(errors, []);

  await browser.close();
  browser = undefined;
  server.close();
  console.log('PASS browser Keep import flow');
})().catch(async error => {
  console.error(error);
  if (browser) await browser.close().catch(() => {});
  server.close();
  process.exitCode = 1;
});
