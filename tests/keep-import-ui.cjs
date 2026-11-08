'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('app/src/main/assets/index.html');
const recorder = read('app/src/main/assets/recorder.js');
const bridge = read('desktop/desktop-bridge.js');
const window = read('desktop/MainWindow.xaml.cs');
const client = read('desktop/KeepClient.cs');

assert.match(html, /id="importKeepRun"/, 'missing import button');
assert.ok(html.indexOf('src="keep-import.js"') >= 0, 'missing keep-import.js script');
assert.ok(html.indexOf('src="keep-import.js"') < html.indexOf('src="recorder.js"'),
  'keep-import.js must load before recorder.js');
assert.match(recorder, /native\.importKeepRun\(\)/, 'recorder must call native import');
assert.match(recorder, /window\.onKeepImportResult\s*=/, 'recorder must expose import callback');
assert.match(bridge, /importKeepRun/, 'desktop bridge must expose importKeepRun');
assert.match(bridge, /kind === 'keepRun'/, 'desktop bridge must route keepRun');
assert.match(window, /"keepRun"/, 'MainWindow must handle keepRun');
assert.match(window, /"keepArtifacts"/, 'MainWindow must handle keepArtifacts');
assert.match(client, /ImportLatestOutdoorRun/, 'KeepClient must expose ImportLatestOutdoorRun');

console.log('PASS keep import UI/bridge contract');
