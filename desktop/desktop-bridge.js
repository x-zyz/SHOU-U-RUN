(() => {
  'use strict';
  const send = (action, fields = {}) => window.chrome.webview.postMessage({ action, ...fields });
  let account = '';
  Object.defineProperty(window, 'Android', {
    value: Object.freeze({
      desktopWorkbench: true,
      installUpdate: (tag, hash) => send('installUpdate', { tag, hash }),
      keepAuthState: () => account,
      reportKeepSession: () => send('restore'),
      saveKeepToken: token => send('manual', { token }),
      sendKeepSms: phone => send('sms', { phone }),
      verifyKeepSms: (phone, code) => send('login', { phone, code }),
      logoutKeep: () => send('logout'),
      uploadKeep: (activity, token) => send('upload', { activity, token }),
      importKeepRun: () => send('keepRun'),
      importKeepHistory: () => send('keepHistory'),
      scanKeepFiles: () => send('keepScanFiles'),
      convertKeepFiles: () => send('keepConvertFiles'),
      saveKeepImportArtifacts: (report, sample) => send('keepArtifacts', { report, sample }),
      saveFile: (name, base64) => send('save', { name, base64 }),
      fitRunPace: () => send('fitPace'),
      setWorkspace: workspace => send('workspace', { workspace })
    })
  });
  window.chrome.webview.addEventListener('message', ({ data }) => {
    if (data.kind === 'update') {
      window.onUpdateResult?.(data.message);
    } else if (data.kind === 'mapError') {
      window.onMapNetworkError?.(data.error);
    } else if (data.kind === 'auth') {
      account = data.account;
      window.onKeepAuthResult?.(data.phase, data.ok, data.message);
    } else if (data.kind === 'upload') {
      window.onKeepUploadResult?.(data.ok, data.message);
    } else if (data.kind === 'keepHistory') {
      window.onKeepHistoryResult?.(data);
    } else if (data.kind === 'keepBatch') {
      window.onKeepBatchResult?.(data);
    } else if (data.kind === 'keepRun') {
      if (typeof data.account === 'string') account = data.account;
      window.onKeepImportResult?.(data.ok, data.activity, data.message);
    } else if (data.kind === 'save') {
      window.onSaveResult?.(data.ok, data.message);
    } else if (data.kind === 'navigate') {
      window.showRunWorkspace?.(data.workspace);
    } else if (data.kind === 'pace') {
      window.onRunPaceSamples?.(data.runs, data.message);
    }
  });
  document.addEventListener('DOMContentLoaded', () => {
    const version = document.getElementById('appVersion');
    if (version) {
      version.textContent = 'v' + desktopVersion;
      version.after(' · Windows');
    }
  });
})();
