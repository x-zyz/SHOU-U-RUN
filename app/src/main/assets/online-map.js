(function(root) {
  'use strict';
  const sources = {
    online: {
      name: 'OpenStreetMap', host: 'tile.openstreetmap.org',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
    },
    esri: {
      name: 'Esri 卫星影像', host: 'server.arcgisonline.com',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Tiles © Esri, Maxar, Earthstar Geographics, GIS User Community'
    }
  };
  const retryDelays = [2000, 5000];
  const requestTimeout = 12000;

  // Image requests retain WebView HTTP caching and do not require CORS support.
  // Each visible tile has a deadline and a bounded retry budget. Never cache-bust.
  const ResilientTiles = L.TileLayer.extend({
    initialize(url, options) {
      L.TileLayer.prototype.initialize.call(this, url, options);
      this.requests = new Map();
      this.on('tileunload tileabort', e => this.discard(e.tile));
    },
    createTile(coords, done) {
      const tile = document.createElement('img');
      tile.alt = '';
      tile.referrerPolicy = 'strict-origin-when-cross-origin';
      tile.style.visibility = 'hidden';
      const entry = {tile, done, zoom: coords.z, url: this.getTileUrl(coords), attempts: 0,
        state: 'waiting', timer: null, sequence: 0, completed: false, detail: ''};
      this.requests.set(tile, entry);
      // Leaflet must register the tile before a synchronous offline failure.
      entry.timer = setTimeout(() => this.request(entry), 0);
      return tile;
    },
    clearRequest(entry) {
      clearTimeout(entry.timer);
      entry.timer = null;
      entry.tile.onload = entry.tile.onerror = null;
      entry.sequence++;
    },
    request(entry) {
      if (!this.requests.has(entry.tile)) return;
      this.clearRequest(entry);
      // Leaflet can retain completed image elements from the previous zoom while
      // new tiles load. Do not spend a retry on those off-screen coordinates.
      if (entry.zoom !== this._tileZoom) {
        this.fail(entry, '缩放级别已改变', false);
        return;
      }
      if (navigator.onLine === false || document.hidden) {
        this.fail(entry, navigator.onLine === false ? '设备离线' : '页面已暂停', false);
        return;
      }
      entry.attempts++;
      entry.state = 'loading';
      const sequence = entry.sequence;
      const current = () => this.requests.has(entry.tile) && sequence === entry.sequence;
      entry.tile.onload = () => {
        if (!current()) return;
        this.clearRequest(entry);
        entry.state = 'loaded';
        entry.detail = '';
        entry.tile.style.visibility = '';
        entry.completed = true;
        entry.done(null, entry.tile);
        this.fire('progress');
      };
      entry.tile.onerror = () => {
        if (current()) this.fail(entry, entry.detail || '网络或图源响应异常');
      };
      entry.timer = setTimeout(() => {
        if (current()) this.fail(entry, entry.detail || '请求超时');
      }, requestTimeout);
      entry.tile.src = entry.url;
      this.fire('progress');
    },
    fail(entry, detail, retry = true) {
      this.clearRequest(entry);
      entry.tile.removeAttribute('src');
      entry.tile.style.visibility = 'hidden';
      entry.detail = detail;
      if (retry && !entry.blocked && entry.attempts <= retryDelays.length &&
          navigator.onLine !== false && !document.hidden) {
        entry.state = 'retrying';
        entry.timer = setTimeout(() => this.request(entry), retryDelays[entry.attempts - 1]);
      } else {
        entry.state = 'failed';
        if (!entry.completed) {
          entry.completed = true;
          entry.done(new Error(detail), entry.tile);
        }
      }
      this.fire('progress');
    },
    discard(tile) {
      const entry = this.requests.get(tile);
      if (!entry) return;
      this.clearRequest(entry);
      this.requests.delete(tile);
      tile.removeAttribute('src');
      this.fire('progress');
    },
    onRemove(map) {
      for (const tile of this.requests.keys()) this.discard(tile);
      L.TileLayer.prototype.onRemove.call(this, map);
    },
    pause() {
      for (const entry of this.requests.values()) {
        if (entry.state !== 'loaded' && entry.state !== 'failed') {
          this.fail(entry, navigator.onLine === false ? '设备离线' : '页面已暂停', false);
        }
      }
    },
    reportError(error) {
      for (const entry of this.requests.values()) {
        if (entry.url !== error.url || entry.state === 'loaded') continue;
        const code = Number(error.code);
        entry.detail = error.kind === 'http' ? 'HTTP ' + code :
          ({'-2': 'DNS 解析失败', '-6': '连接失败', '-8': '连接超时', '-11': 'TLS 证书或握手失败'})[code] || '网络错误 ' + code;
        // Do not hammer a service which has explicitly refused access.
        if (error.kind === 'http' && [400, 401, 403, 404, 429].includes(code)) {
          entry.blocked = true;
          if (entry.state === 'retrying') this.fail(entry, entry.detail, false);
        }
      }
      this.fire('progress');
    }
  });

  function install(map, offline) {
    const note = document.getElementById('mapStatus');
    const select = document.getElementById('mapSource');
    const retry = document.getElementById('retryMap');
    const coverage = L.latLngBounds([30.65,120.8], [31.9,122.15]);
    let layer = null, lastSource = 'online', renderTimer = null, lastRecovery = -Infinity;
    let manifestError = false, offlineCount = 0;
    const failedOfflineTiles = new Set();
    const offlineError = () => manifestError || failedOfflineTiles.size > 0;
    const fallback = () => !coverage.contains(map.getCenter()) ?
      '当前位置超出上海离线覆盖范围' : offlineError() ? '离线地图也未能读取，请检查安装包' : '空缺处显示上海离线地图';
    function render() {
      renderTimer = null;
      if (!layer) {
        note.textContent = offlineError() ? '离线地图读取失败，可点击重试或检查安装包。' :
          !coverage.contains(map.getCenter()) ? '已离开上海离线覆盖范围，请返回上海或切换在线地图。' :
          '上海全市离线地图 · 无需联网浏览' + (offlineCount ? ' · ' + offlineCount + ' 个分块' : '');
        retry.textContent = offlineError() ? '重试离线地图' : '重试联网';
        return;
      }
      retry.textContent = '重试联网';
      const entries = [...layer.requests.values()];
      const loaded = entries.filter(e => e.state === 'loaded').length;
      const failed = entries.filter(e => e.state === 'failed').length;
      const pending = entries.length - loaded - failed;
      const detail = entries.find(e => e.state !== 'loaded' && e.detail)?.detail;
      const name = sources[lastSource].name;
      if (navigator.onLine === false) {
        note.textContent = '设备离线 · ' + fallback() + '；联网后自动恢复。';
      } else if (pending) {
        note.textContent = name + '加载中' + (entries.some(e => e.state === 'retrying') ? '，正在重试失败图块' : '') +
          ' · ' + loaded + '/' + entries.length + ' · ' + fallback() + '。';
      } else if (failed) {
        note.textContent = name + (loaded ? '部分图块未加载' : '暂不可用') +
          (detail ? '（' + detail + '）' : '') + ' · ' + fallback() + '；可重试或切换图源。';
      } else {
        note.textContent = name + (loaded ? '已加载 · ' + loaded + ' 个图块' : '等待加载…');
      }
    }
    function scheduleRender() {
      if (renderTimer === null) renderTimer = setTimeout(render, 0);
    }
    function removeOnline() {
      const previous = layer;
      layer = null;
      if (previous) {
        previous.off('progress', scheduleRender);
        map.removeLayer(previous);
      }
    }
    function offlineOnly() {
      removeOnline();
      select.value = 'offline';
      map.setMinZoom(9);
      render();
    }
    function startOnline(source) {
      removeOnline();
      lastSource = source === 'esri' ? 'esri' : 'online';
      select.value = lastSource;
      const provider = sources[lastSource];
      layer = new ResilientTiles(provider.url, {
        minZoom: 9, maxZoom: 20, maxNativeZoom: 19,
        // Retina + zoomOffset used to request z=20 from an OSM server capped at 19.
        // Native 256px tiles also avoid fourfold requests on phones/high-DPI PCs.
        detectRetina: false, updateWhenIdle: true, updateWhenZooming: false,
        keepBuffer: 1, attribution: provider.attribution
      });
      layer.on('progress', scheduleRender);
      layer.addTo(map);
      render();
    }
    function recover(force = false) {
      if (!layer || navigator.onLine === false || document.hidden) return;
      if (!force && (Date.now() - lastRecovery < 30000 ||
          ![...layer.requests.values()].some(e => e.state === 'failed'))) return;
      lastRecovery = Date.now();
      // Cached successful tiles are reused by the HTTP cache; failed requests get
      // a fresh bounded budget. No periodic retry loop runs during an outage.
      layer.redraw();
      render();
    }
    select.onchange = () => select.value === 'offline' ? offlineOnly() : startOnline(select.value);
    retry.onclick = () => {
      if (!layer && offlineError()) {
        offline.redraw();
        root.RunOffline.ready().then(m => setOfflineState(m)).catch(() => setOfflineState(null));
      } else if (layer) recover(true);
      else startOnline(lastSource);
    };
    const onOnline = () => recover(true);
    const onOffline = () => { if (layer) layer.pause(); render(); };
    const onVisibility = () => {
      if (document.hidden) {
        lastRecovery = -Infinity;
        if (layer) layer.pause();
      }
      else recover();
    };
    root.addEventListener('online', onOnline);
    root.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);
    map.on('moveend', scheduleRender);
    const reportError = error => {
      if (!layer || !error || typeof error !== 'object') return;
      try {
        if (new URL(error.url).hostname !== sources[lastSource].host) return;
      } catch (_) { return; }
      layer.reportError(error);
    };
    root.onMapNetworkError = reportError;
    map.on('unload', () => {
      removeOnline();
      clearTimeout(renderTimer);
      root.removeEventListener('online', onOnline);
      root.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
      map.off('moveend', scheduleRender);
      if (root.onMapNetworkError === reportError) root.onMapNetworkError = () => {};
    });
    function setOfflineState(manifest) {
      manifestError = !manifest;
      offlineCount = manifest?.tile_count || 0;
      scheduleRender();
    }
    offline.on('tileerror', e => { failedOfflineTiles.add(e.tile); scheduleRender(); });
    offline.on('tileload tileunload', e => { failedOfflineTiles.delete(e.tile); scheduleRender(); });
    render();
    return {offlineOnly, startOnline, setOfflineState};
  }
  root.RunOnline = {install};
})(window);
