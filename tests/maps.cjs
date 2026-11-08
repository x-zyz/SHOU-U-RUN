// npm install --no-save playwright; node tests/maps.cjs
// Uses installed Chrome by default; set CHROME_PATH to use another Chromium build.
// All online tiles are intercepted locally. No provider traffic or account calls.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assets = path.resolve(__dirname, '../app/src/main/assets');
const artifacts = path.resolve(__dirname, '../local-build/map-tests');
fs.mkdirSync(artifacts, {recursive: true});
const tilePattern = /https:\/\/(tile\.openstreetmap\.org|server\.arcgisonline\.com)\//;
const tileBody = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#c9dfcc"/></svg>';
const serveTile = route => route.fulfill({status: 200, contentType: 'image/svg+xml', body: tileBody});
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(assets, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(assets + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, body) => {
    if (error) { res.writeHead(404).end(); return; }
    const type = {'.html':'text/html; charset=utf-8', '.js':'application/javascript', '.json':'application/json', '.css':'text/css', '.png':'image/png'}[path.extname(file)];
    res.writeHead(200, {'Content-Type':type || 'application/octet-stream'}).end(body);
  });
});
let browser, origin, tests = 0;
async function fixture({width = 390, desktop = false, tiles = serveTile, setup} = {}) {
  const context = await browser.newContext({viewport: {width, height: 900}, deviceScaleFactor: 3});
  await context.addInitScript(({desktop}) => {
    window.savedFiles = [];
    window.Android = {desktopWorkbench: desktop, setWorkspace() {},
      recordRun() {}, recorderState: () => JSON.stringify({state:'idle', file:'', activeSeconds:0, count:0}),
      realRunHistory: () => '[]', keepAuthState: () => '',
      saveFile: (...args) => window.savedFiles.push(args)};
  }, {desktop});
  await context.route(tilePattern, tiles);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (setup) await setup(page, context);
  await page.goto(origin);
  await page.waitForFunction(() => typeof map !== 'undefined' && window.RunOnline);
  return {context, page, errors};
}
async function online(page, source = 'online') { await page.selectOption('#mapSource', source); }
async function state(page) {
  return page.evaluate(() => {
    let online;
    map.eachLayer(layer => { if (layer.requests) online = layer; });
    return online ? [...online.requests.values()].map(e => ({state: e.state, attempts: e.attempts, url: e.url})) : [];
  });
}
async function settled(page, wanted) {
  await page.waitForFunction(wanted => {
    let layer;
    map.eachLayer(item => { if (item.requests) layer = item; });
    return layer && layer.requests.size > 0 && [...layer.requests.values()].every(e => e.state === wanted);
  }, wanted, {timeout: 8000});
}
async function test(name, fn) {
  await fn(); tests++;
  console.log('PASS ' + name);
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {channel:'chrome'})});

  await test('original retina configuration requests z20; fixed configuration stays <=19 at view z20', async () => {
    const {page, context, errors} = await fixture();
    const original = await page.evaluate(() => {
      const old = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:20, maxNativeZoom:19, detectRetina:true});
      old._tileZoom = 19;
      return old.getTileUrl(L.point(1, 1));
    });
    assert.match(original, /\/20\//);
    await online(page);
    await page.evaluate(() => map.setView([30.88913,121.89635], 20, {animate:false}));
    await settled(page, 'loaded');
    assert.ok((await state(page)).every(e => Number(new URL(e.url).pathname.split('/')[1]) <= 19));
    assert.ok(await page.evaluate(() => document.querySelectorAll('.leaflet-offline-pane canvas').length > 0));
    assert.deepEqual(errors, []);
    await context.close();
  });

  await test('transient tile failure retries twice then succeeds without changing source', async () => {
    const counts = new Map();
    const {page, context, errors} = await fixture({tiles: route => {
      const n = (counts.get(route.request().url()) || 0) + 1;
      counts.set(route.request().url(), n);
      return n < 3 ? route.abort('connectionfailed') : serveTile(route);
    }});
    await page.clock.install();
    await online(page);
    await settled(page, 'retrying');
    await page.clock.fastForward(2100);
    await page.waitForFunction(() => { let l; map.eachLayer(x => {if(x.requests) l=x;}); return [...l.requests.values()].every(e=>e.attempts===2 && e.state==='retrying'); });
    await page.clock.fastForward(5100);
    await settled(page, 'loaded');
    assert.ok([...counts.values()].every(n => n === 3));
    assert.equal(await page.inputValue('#mapSource'), 'online');
    assert.deepEqual(errors, []);
    await context.close();
  });

  await test('hung requests time out; retry budget stops after three attempts', async () => {
    let requests = 0;
    const {page, context, errors} = await fixture({tiles: () => { requests++; }});
    await page.clock.install();
    await online(page);
    await settled(page, 'loading');
    const tiles = (await state(page)).length;
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.clock.fastForward(12100);
      await settled(page, attempt === 2 ? 'failed' : 'retrying');
      if (attempt < 2) { await page.clock.fastForward(attempt === 0 ? 2100 : 5100); await settled(page, 'loading'); }
    }
    await page.clock.fastForward(120000);
    await settled(page, 'failed');
    assert.ok(requests <= tiles * 3);
    assert.ok((await state(page)).every(e => e.attempts === 3));
    await page.clock.runFor(20);
    assert.match(await page.textContent('#mapStatus'), /请求超时/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await test('offline selection makes no tile requests; online event recovers automatically', async () => {
    let requests = 0;
    const {page, context, errors} = await fixture({tiles: route => {requests++; return serveTile(route);}});
    await context.setOffline(true);
    await online(page);
    await settled(page, 'failed');
    assert.equal(requests, 0);
    await context.setOffline(false);
    await settled(page, 'loaded');
    assert.ok(requests > 0);
    await page.selectOption('#mapSource', 'offline');
    const before = requests;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    assert.equal(await page.inputValue('#mapSource'), 'offline');
    assert.equal(requests, before);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await test('source switch cancels old retries and ignores late errors from the previous host', async () => {
    let osm = 0;
    const {page, context, errors} = await fixture({tiles: route => {
      if (route.request().url().includes('openstreetmap')) {osm++; return route.abort();}
      return serveTile(route);
    }});
    await page.clock.install();
    await online(page);
    await settled(page, 'retrying');
    const before = osm;
    await online(page, 'esri');
    await settled(page, 'loaded');
    await page.evaluate(() => window.onMapNetworkError({url:'https://tile.openstreetmap.org/16/54958/26850.png',kind:'http',code:403}));
    await page.clock.fastForward(60000);
    assert.equal(osm, before);
    assert.equal(await page.inputValue('#mapSource'), 'esri');
    assert.match(await page.textContent('#mapStatus'), /Esri.*已加载/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await test('zooming cancels retries for obsolete tile coordinates', async () => {
    const counts = new Map();
    const {page, context, errors} = await fixture({tiles: route => {
      const url = route.request().url();
      counts.set(url, (counts.get(url) || 0) + 1);
      return url.includes('/16/') ? route.abort() : serveTile(route);
    }});
    await page.clock.install();
    await online(page);
    await settled(page, 'retrying');
    await page.evaluate(() => map.setZoom(17, {animate:false}));
    await page.clock.fastForward(10000);
    await settled(page, 'loaded');
    assert.ok([...counts].filter(([url]) => url.includes('/16/')).every(([, n]) => n === 1));
    assert.deepEqual(errors, []);
    await context.close();
  });

  await test('native HTTP 429 stops pending retries and reports the actual status', async () => {
    let requests = 0;
    const {page, context, errors} = await fixture({tiles: route => {requests++; return route.abort();}});
    await page.clock.install();
    await online(page);
    await settled(page, 'retrying');
    const before = requests;
    await page.evaluate(() => {
      map.eachLayer(l => { if(l.requests) for(const e of l.requests.values()) window.onMapNetworkError({url:e.url,kind:'http',code:429}); });
    });
    await settled(page, 'failed');
    await page.clock.fastForward(30000);
    assert.equal(requests, before);
    assert.match(await page.textContent('#mapStatus'), /HTTP 429/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await test('manifest failure can recover without restarting the page', async () => {
    let failing = true;
    const {page, context, errors} = await fixture({setup: async page => {
      await page.route('**/shanghai/manifest.json', route => failing ? route.fulfill({status:503,body:''}) : route.continue());
    }});
    await page.waitForFunction(() => document.getElementById('mapStatus').textContent.includes('读取失败'));
    failing = false;
    await page.click('#retryMap');
    await page.waitForFunction(() => document.getElementById('mapStatus').textContent.includes('个分块'));
    assert.equal(await page.inputValue('#mapSource'), 'offline');
    assert.deepEqual(errors, []);
    await context.close();
  });

  await test('failed offline tile promises are evicted and readable after retry', async () => {
    let failing = true, failedRequests = 0, recoveredRequests = 0;
    const {page, context, errors} = await fixture({setup: async page => {
      await page.route(/\/shanghai\/\d+\/\d+\/\d+\.json/, route => {
        if (failing) {failedRequests++; return route.fulfill({status:503,body:''});}
        recoveredRequests++; return route.continue();
      });
    }});
    await page.waitForFunction(() => document.getElementById('mapStatus').textContent.includes('读取失败'));
    assert.ok(failedRequests > 0);
    failing = false;
    await page.click('#retryMap');
    await page.waitForFunction(() => document.getElementById('mapStatus').textContent.includes('个分块'));
    await page.waitForFunction(() => document.querySelectorAll('.leaflet-offline-pane .leaflet-tile-loaded').length > 0);
    assert.ok(recoveredRequests > 0);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await test('background pause cancels retries and foreground resumes; outside Shanghai is identified', async () => {
    let failing = true, requests = 0;
    const {page, context, errors} = await fixture({tiles: route => {
      requests++; return failing ? route.abort() : serveTile(route);
    }});
    await page.clock.install();
    await online(page);
    await settled(page, 'retrying');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {configurable:true, value:true});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settled(page, 'failed');
    const before = requests;
    await page.clock.fastForward(60000);
    assert.equal(requests, before);
    failing = false;
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {configurable:true, value:false});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settled(page, 'loaded');
    await page.selectOption('#mapSource', 'offline');
    await page.evaluate(() => map.setView([39.9,116.4], 16, {animate:false}));
    await page.clock.runFor(100);
    assert.match(await page.textContent('#mapStatus'), /离开上海离线覆盖范围/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await test('repeated missing offline tile still reports failure after retry', async () => {
    const {page, context, errors} = await fixture({setup: async page => {
      await page.route(/\/shanghai\/\d+\/\d+\/\d+\.json/, route => route.fulfill({status:404,body:''}));
    }});
    await page.waitForFunction(() => document.getElementById('mapStatus').textContent.includes('读取失败'));
    await page.click('#retryMap');
    await page.waitForFunction(() => document.getElementById('mapStatus').textContent.includes('读取失败'));
    assert.equal(await page.inputValue('#mapSource'), 'offline');
    assert.deepEqual(errors, []);
    await context.close();
  });

  await test('mobile and desktop navigation, sample route, parameter changes, GPX/FIT export', async () => {
    for (const width of [375, 768, 1440]) {
      const {page, context, errors} = await fixture({width, desktop:width === 1440});
      await page.waitForFunction(() => document.querySelectorAll('.leaflet-offline-pane .leaflet-tile-loaded').length > 0);
      const tile = page.locator('.leaflet-offline-pane canvas.leaflet-tile-loaded').first();
      assert.equal(await tile.evaluate(canvas => canvas.width), width === 1440 ? 768 : 512);
      await page.screenshot({path:path.join(artifacts, 'route-' + width + '.png'), fullPage:true});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.click('#sample');
      await page.waitForFunction(() => !document.getElementById('gpx').disabled);
      await page.evaluate(() => window.showRunWorkspace ? showRunWorkspace('parameters') : document.querySelector('[data-workspace="parameters"]').click());
      const chart = page.locator('#chart');
      assert.equal(await chart.evaluate(canvas => canvas.width / canvas.clientWidth), width === 1440 ? 3 : 2);
      await page.locator('#pace').fill('450');
      await page.waitForFunction(() => document.getElementById('paceValue').textContent.includes('7′30'));
      await page.evaluate(() => window.showRunWorkspace ? showRunWorkspace('output') : document.querySelector('[data-workspace="output"]').click());
      await page.click('#gpx');
      await page.click('#fit');
      const saves = await page.evaluate(() => savedFiles);
      assert.equal(saves.length, 2);
      assert.match(Buffer.from(saves[0][1], 'base64').toString('utf8'), /<gpx/);
      assert.equal(Buffer.from(saves[1][1], 'base64').subarray(8,12).toString(), '.FIT');
      assert.deepEqual(errors, []);
      await context.close();
    }
  });
  console.log('All ' + tests + ' map regression tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  server.close();
});
