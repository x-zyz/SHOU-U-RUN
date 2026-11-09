(() => {
  const bridge = window.Android;
  const check = document.getElementById('checkUpdate');
  const install = document.getElementById('installUpdate');
  const status = document.getElementById('updateStatus');
  if (!bridge?.installUpdate) return;
  check.hidden = false;

  const repo = 'x-zyz/SHOU-U-RUN';
  const suffix = bridge.desktopWorkbench ? '-Windows-x64-Setup.exe' : '.apk';
  const parse = tag => /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)?.slice(1).map(Number);
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  let offer;

  check.onclick = async () => {
    check.disabled = true;
    install.hidden = true;
    offer = null;
    status.textContent = '正在检查更新…';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('https://api.github.com/repos/' + repo + '/releases?per_page=15', {
        signal: controller.signal
      });
      if (!response.ok) throw Error('Release request failed');
      const releases = await response.json();
      const current = parse(document.getElementById('appVersion').textContent);
      for (const release of releases) {
        const version = parse(release.tag_name);
        if (!version || release.draft || release.prerelease || compare(version, current) <= 0 ||
            (offer && compare(version, offer.version) <= 0)) continue;
        const name = 'SHOU-U-RUN-' + release.tag_name + suffix;
        const url = 'https://github.com/' + repo + '/releases/download/' + release.tag_name + '/' + name;
        const asset = release.assets.find(item => item.name === name && item.state === 'uploaded' &&
          item.browser_download_url === url && /^sha256:[0-9a-f]{64}$/.test(item.digest));
        if (asset) offer = { tag: release.tag_name, version, hash: asset.digest.slice(7) };
      }
      status.textContent = offer ? '发现新版本 ' + offer.tag : '当前已是最新版本。';
      install.hidden = !offer;
    } catch {
      status.textContent = '暂时无法检查更新，请确认 GitHub 可访问后重试。';
    } finally {
      clearTimeout(timeout);
      check.disabled = false;
    }
  };

  install.onclick = () => {
    if (!offer) return;
    check.disabled = install.disabled = true;
    status.textContent = '正在下载安装包…';
    bridge.installUpdate(offer.tag, offer.hash);
  };

  window.onUpdateResult = message => {
    status.textContent = message;
    check.disabled = install.disabled = false;
  };
})();
