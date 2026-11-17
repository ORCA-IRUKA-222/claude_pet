'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers');
const {
  NoticeWatcher,
  parsePayload,
  fromFiletime,
  appName,
  wanted,
  launchId,
  diagnose,
  SAFE_APP_ID,
} = require('../src/core/winnotify');

let sqlite = null;
try {
  sqlite = require('node:sqlite');
} catch {
  // Node without SQLite: the database tests are skipped
}

const toast = (title, body) =>
  `<toast launch="x"><visual><binding template="ToastGeneric"><text id="1">${title}</text>${
    body == null ? '' : `<text id="2">${body}</text>`
  }</binding></visual></toast>`;

// 2026-11-10T12:00:00Z as a FILETIME
const T0 = BigInt(Date.UTC(2026, 10, 10, 12, 0, 0) + 11644473600000) * 10000n;

/** A database shaped like Windows' wpndatabase.db (WAL mode, held open like WpnService does). */
function makeDb(dir) {
  const file = path.join(dir, 'wpndatabase.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`CREATE TABLE NotificationHandler (RecordId INTEGER PRIMARY KEY, PrimaryId TEXT, HandlerType TEXT);
           CREATE TABLE Notification (Id INTEGER PRIMARY KEY, HandlerId INTEGER, Type TEXT, Payload BLOB, ArrivalTime INTEGER);`);
  db.prepare('INSERT INTO NotificationHandler VALUES (?, ?, ?)').run(1, 'com.squirrel.Discord.Discord', 'app:desktop');
  db.prepare('INSERT INTO NotificationHandler VALUES (?, ?, ?)').run(2, 'Microsoft.WindowsStore_8wekyb3d8bbwe!App', 'app:uwp');
  let id = 0;
  const add = (handler, xml, offsetSeconds, type = 'toast') =>
    db
      .prepare('INSERT INTO Notification (Id, HandlerId, Type, Payload, ArrivalTime) VALUES (?, ?, ?, ?, ?)')
      .run(++id, handler, type, Buffer.from(xml), T0 + BigInt(offsetSeconds) * 10000000n);
  return { file, db, add };
}

test('toast XML gives the title and the text, entities decoded', () => {
  assert.deepEqual(parsePayload(toast('たろう (#general, サーバー)', '今日の&quot;会議&quot; &amp; 資料 &#x1F600;')), {
    title: 'たろう (#general, サーバー)',
    body: '今日の"会議" & 資料 😀',
  });
  assert.deepEqual(parsePayload(Buffer.from(toast('A', 'B'))), { title: 'A', body: 'B' });
  assert.deepEqual(parsePayload(Buffer.from('\uFEFF' + toast('U', 'V'), 'utf16le')), { title: 'U', body: 'V' });
  assert.deepEqual(parsePayload(toast('only title')), { title: 'only title', body: '' });
  assert.deepEqual(parsePayload('<toast><visual><binding><text/></binding></visual></toast>'), { title: '', body: '' });
  assert.deepEqual(parsePayload(null), { title: '', body: '' });
});

test('FILETIME becomes epoch milliseconds', () => {
  assert.ok(T0 > BigInt(Number.MAX_SAFE_INTEGER), 'real FILETIMEs are beyond what a number holds');
  assert.equal(fromFiletime(T0), Date.UTC(2026, 10, 10, 12, 0, 0));
  assert.equal(fromFiletime(Number(T0)), Date.UTC(2026, 10, 10, 12, 0, 0), 'a number is only off by its rounding');
  assert.equal(fromFiletime(0), 0);
  assert.equal(fromFiletime('x'), 0);
});

test('app names and the filter', () => {
  assert.equal(appName('com.squirrel.Discord.Discord'), 'Discord');
  assert.equal(appName('Microsoft.WindowsStore_8wekyb3d8bbwe!App'), 'WindowsStore');
  assert.equal(appName('C:\\Program Files\\LINE\\LINE.exe'), 'LINE');
  assert.equal(appName(''), '');
  // Office apps end in their version; the name is not "15"
  assert.equal(appName('Microsoft.Office.OUTLOOK.EXE.15'), 'Outlook');
  assert.equal(appName('Microsoft.Office.WINWORD.EXE.15'), 'Word');
  assert.equal(appName('Microsoft.Office.EXCEL.EXE.15'), 'Excel');
  assert.equal(appName('Microsoft.Office.POWERPNT.EXE.15'), 'PowerPoint');
  assert.equal(appName('com.squirrel.slack.slack'), 'slack');
  assert.equal(appName('Windows.SystemToast.WiFiNetworkManager'), 'WiFiNetworkManager');
  assert.equal(appName('Claude_pzs8sxrjxfjjc!Claude'), 'Claude');
  assert.equal(appName('15'), '15', 'a lone number is all there is');
  assert.ok(wanted('Microsoft.Office.OUTLOOK.EXE.15', ['outlook']), 'the shown name can be used in the apps list');
  assert.ok(wanted('com.squirrel.Discord.Discord', ['discord']));
  assert.ok(wanted('com.squirrel.Discord.Discord', [' DISCORD ']));
  assert.ok(!wanted('com.squirrel.Discord.Discord', ['slack']));
  assert.ok(!wanted('com.squirrel.Discord.Discord', []));
  assert.ok(!wanted('com.squirrel.Discord.Discord', ['']));
  // "all" is every app, except the pet itself
  assert.ok(wanted('com.squirrel.slack.slack', ['all']));
  assert.ok(wanted('Microsoft.YourPhone_8wekyb3d8bbwe!YourPhoneNotifications_jp.offerbox', ['*']));
  assert.ok(!wanted('dev.claude-pet', ['all']));
  assert.ok(!wanted('dev.claude-pet', ['claude-pet']), 'its own notifications never come back');
  assert.equal(
    launchId('Microsoft.YourPhone_8wekyb3d8bbwe!YourPhoneNotifications_com.Slack'),
    'Microsoft.YourPhone_8wekyb3d8bbwe!App',
  );
  assert.equal(launchId('com.squirrel.Discord.Discord'), 'com.squirrel.Discord.Discord');
  assert.equal(launchId('Claude_pzs8sxrjxfjjc!Claude'), 'Claude_pzs8sxrjxfjjc!Claude');
  assert.ok(SAFE_APP_ID.test('com.squirrel.Discord.Discord'));
  assert.ok(SAFE_APP_ID.test('Microsoft.WindowsStore_8wekyb3d8bbwe!App'));
  assert.ok(!SAFE_APP_ID.test('x" & calc.exe'));
  assert.ok(!SAFE_APP_ID.test('a;b'));
});

test('the watcher passes on new notifications of the chosen apps, once', { skip: !sqlite }, () => {
  const { file, db, add } = makeDb(tempDir());
  add(1, toast('old', 'before the pet started'), -60);
  const seen = [];
  const watcher = new NoticeWatcher({ file, apps: () => ['discord'] });
  watcher.on('notice', (n) => seen.push(n));

  watcher.check(); // the first look only remembers where we are
  assert.equal(seen.length, 0, 'earlier notifications are not replayed');

  add(1, toast('さくら', 'おはよう'), 5);
  add(2, toast('Store', 'an update'), 6); // another app
  add(1, toast('ひろ', 'もう寝る？'), 7);
  add(1, '<tile/>', 8, 'tile'); // not a toast
  add(1, toast('', ''), 9); // nothing to say
  watcher.check();
  assert.deepEqual(
    seen.map((n) => [n.appName, n.title, n.body]),
    [
      ['Discord', 'さくら', 'おはよう'],
      ['Discord', 'ひろ', 'もう寝る？'],
    ],
  );
  assert.equal(seen[0].app, 'com.squirrel.Discord.Discord');
  assert.equal(seen[0].arrivedAt, Date.UTC(2026, 10, 10, 12, 0, 5));

  watcher.check();
  assert.equal(seen.length, 2, 'nothing is passed on twice');

  // clearing the notification center and new ones arriving still works (ids start over)
  db.exec('DELETE FROM Notification');
  watcher.check();
  add(1, toast('まお', 'ただいま'), 30);
  watcher.check();
  assert.equal(seen.length, 3);
  assert.equal(seen[2].title, 'まお');
  db.close();
});

test('the apps list is read at every check, and an empty list passes nothing', { skip: !sqlite }, () => {
  const { file, db, add } = makeDb(tempDir());
  let apps = [];
  const seen = [];
  const watcher = new NoticeWatcher({ file, apps: () => apps });
  watcher.on('notice', (n) => seen.push(n.title));
  watcher.check();
  add(1, toast('one', 'a'), 1);
  watcher.check();
  assert.deepEqual(seen, []);
  apps = ['Discord'];
  add(1, toast('two', 'b'), 2);
  watcher.check();
  assert.deepEqual(seen, ['two']);
  db.close();
});

test('a missing file or odd columns are reported, not thrown', { skip: !sqlite }, () => {
  const errors = [];
  const gone = new NoticeWatcher({ file: path.join(tempDir(), 'nope.db'), apps: () => ['discord'] });
  gone.on('error', (e) => errors.push(e.message));
  assert.deepEqual(gone.check(), []);
  assert.equal(errors.length, 1);
  gone.check();
  assert.equal(errors.length, 1, 'the same problem is reported once');

  const dir = tempDir();
  const file = path.join(dir, 'odd.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE Notification (Id INTEGER, Foo TEXT); CREATE TABLE NotificationHandler (RecordId INTEGER, Bar TEXT)');
  db.prepare('INSERT INTO Notification VALUES (1, ?)').run('x');
  db.close();
  const odd = new NoticeWatcher({ file, apps: () => ['discord'] });
  const oddErrors = [];
  odd.on('error', (e) => oddErrors.push(e.message));
  odd.check(); // the first look finds the newest arrival: no ArrivalTime column
  odd.since = 0n;
  odd.signature = '';
  odd.check();
  assert.match(oddErrors[0], /ArrivalTime|列がありません/);
});

test('doctor describes the database without showing the texts', { skip: !sqlite }, () => {
  const { file, db, add } = makeDb(tempDir());
  add(1, toast('secret sender', 'secret text'), 1);
  const report = diagnose({ file, platform: 'win32' });
  assert.ok(report.ok, JSON.stringify(report.steps));
  assert.equal(report.recent.length, 1);
  assert.equal(report.recent[0].name, 'Discord');
  assert.equal(report.recent[0].title, undefined);
  assert.equal(diagnose({ file, platform: 'win32', showText: true }).recent[0].title, 'secret sender');
  assert.equal(diagnose({ file, platform: 'linux' }).ok, false);
  assert.equal(diagnose({ file: path.join(tempDir(), 'x.db'), platform: 'win32' }).ok, false);
  db.close();
  assert.ok(fs.existsSync(file));
});

test('banners: which apps, which registry keys, and what is run', () => {
  const { bannerKey, bannerTargets, setBanners } = require('../src/core/winnotify');
  const apps = [
    { app: 'Microsoft.Office.OUTLOOK.EXE.15', name: 'Outlook' },
    { app: 'com.squirrel.Discord.Discord', name: 'Discord' },
    { app: 'Microsoft.YourPhone_8wekyb3d8bbwe!YourPhoneNotifications_com.Slack', name: 'YourPhone' },
    { app: '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe', name: 'powershell' },
  ];
  // the pet's apps list, unless names are given
  assert.deepEqual(
    bannerTargets(apps, ['discord']).map((a) => a.name),
    ['Discord'],
  );
  assert.deepEqual(
    bannerTargets(apps, ['discord'], ['outlook']).map((a) => a.name),
    ['Outlook'],
  );
  assert.equal(bannerTargets(apps, ['all']).length, 4);

  assert.equal(
    bannerKey('com.squirrel.Discord.Discord'),
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\com.squirrel.Discord.Discord',
  );
  assert.ok(bannerKey('Microsoft.YourPhone_8wekyb3d8bbwe!YourPhoneNotifications_com.Slack'));
  assert.equal(bannerKey(apps[3].app), null, 'a path-like id is not a key name');
  assert.equal(bannerKey('x" /f & calc'), null);

  const calls = [];
  const run = (args) => {
    calls.push(args);
    return { status: 0, output: '' };
  };
  const off = setBanners(bannerTargets(apps, ['discord', 'powershell']), false, run);
  assert.deepEqual(
    off.map((r) => [r.name, r.ok]),
    [
      ['Discord', true],
      ['powershell', false],
    ],
  );
  assert.deepEqual(calls, [
    [
      'add',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\com.squirrel.Discord.Discord',
      '/v',
      'ShowBanner',
      '/t',
      'REG_DWORD',
      '/d',
      '0',
      '/f',
    ],
  ]);

  calls.length = 0;
  const on = setBanners([apps[1]], true, (args) => {
    calls.push(args);
    return { status: 1, output: 'not found' }; // the value was never set
  });
  assert.deepEqual(calls[0].slice(0, 1).concat(calls[0].slice(2)), ['delete', '/v', 'ShowBanner', '/f']);
  assert.deepEqual([on[0].ok, on[0].detail], [true, '元からオンでした']);
  assert.equal(setBanners([apps[1]], false, () => ({ status: 5, output: 'access denied\nmore' }))[0].detail, 'access denied');
});

test('every app that has sent something is known, once, without the pet itself', { skip: !sqlite }, () => {
  const { knownApps } = require('../src/core/winnotify');
  const { file, db, add } = makeDb(tempDir());
  db.prepare('INSERT INTO NotificationHandler VALUES (3, ?, ?)').run('dev.claude-pet', 'app:desktop');
  add(1, toast('a', 'b'), 1);
  add(1, toast('c', 'd'), 2);
  add(2, toast('e', 'f'), 3);
  add(3, toast('pet', 'own'), 4);
  assert.deepEqual(
    knownApps({ file }).map((a) => a.name),
    ['Discord', 'WindowsStore'],
  );
  db.close();
});
