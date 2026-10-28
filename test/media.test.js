'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers');
const { MediaControl, appName, fromWindows, fromMac } = require('../src/core/media');

test('players are named the way people know them', () => {
  assert.equal(appName('Spotify.exe'), 'Spotify');
  assert.equal(appName('Chrome'), 'Chrome');
  assert.equal(appName('MSEdge'), 'Edge');
  assert.equal(appName('Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic'), 'メディア プレーヤー');
  assert.equal(appName('SomeVendor.CoolPlayer_1a2b3c4d5e6f7!App'), 'CoolPlayer');
  assert.equal(appName(''), null);
});

test('answers from Windows and macOS read the same', () => {
  assert.deepEqual(
    fromWindows({ ok: true, session: true, app: 'Spotify.exe', title: '夜に駆ける', artist: 'YOASOBI', playing: true }),
    {
      available: true,
      session: true,
      app: 'Spotify',
      title: '夜に駆ける',
      artist: 'YOASOBI',
      playing: true,
      canNext: true,
      canPrevious: true,
    },
  );
  assert.equal(fromWindows({ ok: true, session: false, controls: true }).session, false);
  assert.equal(fromWindows(null).available, false);
  assert.deepEqual(fromMac('Spotify\tplaying\tSong\tArtist\n'), {
    available: true,
    session: true,
    app: 'Spotify',
    title: 'Song',
    artist: 'Artist',
    playing: true,
  });
  assert.equal(fromMac('').session, false);
});

// a stand-in for the PowerShell helper, speaking the same line protocol
const FAKE_HELPER = `
const readline = require('readline');
const log = process.env.LOG;
let playing = true, n = 1;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
send({ ready: true, controls: true });
readline.createInterface({ input: process.stdin }).on('line', (cmd) => {
  require('fs').appendFileSync(log, cmd + '\\n');
  if (cmd === 'status') return send({ ok: true, session: true, app: 'Spotify.exe', title: '曲' + n, artist: 'アーティスト', playing });
  if (cmd === 'next') n++;
  if (cmd === 'previous') n--;
  if (cmd === 'play-pause') playing = !playing;
  if (cmd === 'hang') return;
  send({ ok: true });
});
`;

test('on Windows one helper process answers status and ⏮ ⏯ ⏭ in turn', async (t) => {
  const dir = tempDir();
  const script = path.join(dir, 'helper.js');
  fs.writeFileSync(script, FAKE_HELPER);
  process.env.LOG = path.join(dir, 'log.txt');
  const media = new MediaControl({ platform: 'win32', helper: { command: process.execPath, args: [script] } });
  t.after(() => media.stop());
  const [a, b] = await Promise.all([media.status(), media.status()]);
  assert.equal(a.title, '曲1');
  assert.equal(b.app, 'Spotify');
  assert.equal(await media.command('next'), true);
  assert.equal((await media.status()).title, '曲2');
  await media.command('play-pause');
  assert.equal((await media.status()).playing, false);
  await assert.rejects(() => media.command('rm -rf'), /unknown action/);
  assert.deepEqual(fs.readFileSync(process.env.LOG, 'utf8').trim().split('\n'), [
    'status',
    'status',
    'next',
    'status',
    'play-pause',
    'status',
  ]);
});

test('on Windows a helper that has gone is started again', async (t) => {
  const dir = tempDir();
  const script = path.join(dir, 'helper.js');
  fs.writeFileSync(script, FAKE_HELPER);
  process.env.LOG = path.join(dir, 'log.txt');
  const media = new MediaControl({ platform: 'win32', helper: { command: process.execPath, args: [script] } });
  t.after(() => media.stop());
  assert.equal((await media.status()).title, '曲1');
  media.helper.child.kill();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await media.status()).title, '曲1', 'a new helper');
});

test('on Linux it asks playerctl, and says when playerctl is missing', async () => {
  const calls = [];
  const fake = (answers) => async (file, args) => {
    calls.push([file, ...args].join(' '));
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const media = new MediaControl({
    platform: 'linux',
    run: fake(['spotify\tPlaying\tSong\tArtist\n', '', Object.assign(new Error('x'), { stderr: 'No players found' })]),
  });
  assert.deepEqual(await media.status(), {
    available: true,
    session: true,
    app: 'Spotify',
    title: 'Song',
    artist: 'Artist',
    playing: true,
  });
  assert.equal(await media.command('next'), true);
  assert.equal(calls[1], 'playerctl next');
  assert.equal((await media.status()).session, false);

  const missing = new MediaControl({
    platform: 'linux',
    run: fake([Object.assign(new Error('spawn playerctl ENOENT'), { code: 'ENOENT' })]),
  });
  assert.deepEqual(await missing.status(), { available: false, error: 'missing' });
});
