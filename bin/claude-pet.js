#!/usr/bin/env node
'use strict';

const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { APP_ROOT, claudeDir, loadConfig, saveConfig } = require('../src/shared/config');
const { buildId } = require('../src/shared/build');
const { translator } = require('../src/shared/i18n');
const { cleanEnv } = require('../src/shared/env');
const client = require('../src/core/client');

const HELP = `claude-pet — Claude Code のデスクトップペット

使い方:
  claude-pet [start]             ペットを起動（起動済みなら表示）
  claude-pet toggle | show | hide
  claude-pet mini | full         ミニ表示 / 通常表示
  claude-pet chat                クイックチャットを開く
  claude-pet quit                終了
  claude-pet status              セッションの状態を表示
  claude-pet update              最新版に更新して起動し直す
  claude-pet cloud setup         クラウドの Claude Code もペットに出す（設定方法を表示）
  claude-pet cloud [on|off|test] クラウド連携の状態 / 切り替え / 届くかテスト
  claude-pet doctor              うまく動かないときの診断
  claude-pet setup               Claude Code にフックと /pet, /hatch-pet を登録
  claude-pet uninstall           登録を解除
  claude-pet pets                使えるペットの一覧
  claude-pet use <id>            ペットを切り替え
  claude-pet next                次のペットに交代
  claude-pet autostart on|off    PC 起動時に自動で起動（ターミナルは開きません）
  claude-pet rotate on|off [--every 60] [--group <名前> | --all]
                                 一定時間ごとにペットを自動で交代
  claude-pet add-image <画像> [--id id] [--name 名前] [--group グループ] [--height 高さ]
                     [--state <状態>=<画像> ...]
                                 透過 PNG / WebP / GIF のイラストからペットを作成
                                 （--height は「大」サイズのときの高さ px。状態ごとに別の絵も指定可:
                                   idle, running, waiting, ready, failed）
  claude-pet add-folder <フォルダ> [--group グループ] [--height 高さ]
                                 フォルダの画像をまとめてペットにする（1 枚 = 1 人、グループ名はフォルダ名）
  claude-pet build <design.js> [--out <dir>] [--install]
                                 コードで描いたペットをスプライトシートに書き出し
`;

const ENTRYPOINTS = {
  cli: 'ターミナル（CLI）',
  'sdk-cli': 'claude -p（ペットのクイックチャットなど）',
  'claude-desktop': 'Claude デスクトップアプリ',
  'claude-vscode': 'VS Code 拡張',
  remote: 'クラウド',
  remote_desktop: 'クラウド',
};

const ICONS = { waiting: '🙋', failed: '⚠️ ', running: '⚙️ ', ready: '✅', idle: '💤' };

function electronBinary() {
  try {
    return require('electron');
  } catch {
    throw new Error('Electron が見つかりません。claude_pet フォルダで npm install を実行してください');
  }
}

async function waitUntilRunning(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await client.isRunning()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function launchApp() {
  const env = cleanEnv();
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary(), [APP_ROOT], { detached: true, stdio: 'ignore', env });
  child.unref();
}

/** A pet started from older files (before `git pull`) is restarted so the update takes effect. */
async function restartIfStale({ wait = true } = {}) {
  const running = await client.health();
  const local = buildId();
  if (!running || !local || running.build === local) return false;
  await stopApp();
  launchApp();
  if (wait) await waitUntilRunning(15000);
  return true;
}

async function stopApp() {
  await client.control('quit');
  const until = Date.now() + 5000;
  while (Date.now() < until && (await client.isRunning())) await new Promise((r) => setTimeout(r, 200));
}

function git(args) {
  return execFileSync('git', args, { cwd: APP_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** git pull (setting aside local edits), npm ci when the dependencies changed, then (re)start the pet. */
async function update() {
  if (!fs.existsSync(path.join(APP_ROOT, '.git'))) throw new Error('git clone したフォルダではないため更新できません');
  const before = git(['rev-parse', 'HEAD']);
  // npm link / npm install on Windows rewrite bin/claude-pet.js and package-lock.json, which blocks git pull
  if (git(['status', '--porcelain', '--untracked-files=no'])) {
    git(['stash', 'push', '-m', 'claude-pet update']);
    console.log('手元の変更を git stash に退避しました（git stash list で確認できます）');
  }
  execFileSync('git', ['pull', '--ff-only'], { cwd: APP_ROOT, stdio: 'inherit' });
  const after = git(['rev-parse', 'HEAD']);
  const depsChanged = after !== before && git(['diff', '--name-only', before, after, '--', 'package.json', 'package-lock.json']);
  if (depsChanged) {
    // the running pet keeps Electron's files open, so npm ci can't replace them on Windows
    if (await client.isRunning()) await stopApp();
    const npm = spawnSync('npm', ['ci'], { cwd: APP_ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    if (npm.status !== 0) throw new Error('npm ci に失敗しました');
  }
  const t = translator(loadConfig().language);
  if (!(await client.isRunning())) {
    await start();
    return after === before ? t('cli.starting') : `${t('cli.updated')}\n${t('cli.starting')}`;
  }
  if (await restartIfStale()) return `${t('cli.updated')}\n${t('cli.restarted')}`;
  return after === before ? t('cli.upToDate') : t('cli.updated');
}

async function start({ wait = true } = {}) {
  if (await client.isRunning()) {
    await client.control('show');
    return 'shown';
  }
  launchApp();
  if (wait && !(await waitUntilRunning(15000))) throw new Error('ペットの起動を確認できませんでした');
  return 'starting';
}

/** Run a pet command and return a short message for the user. */
async function runPetCommand(args, { wait = true } = {}) {
  const t = translator(loadConfig().language);
  const [action = 'toggle', ...rest] = args;
  const running = await client.isRunning();

  switch (action) {
    case 'toggle': {
      if (!running) {
        await start({ wait });
        return t('cli.starting');
      }
      const res = await client.control('toggle');
      return res.visible ? t('cli.shown') : t('cli.hidden');
    }
    case 'start':
    case 'show':
      if (!running) {
        await start({ wait });
        return t('cli.starting');
      }
      if (await restartIfStale({ wait })) return t('cli.restarted');
      await client.control('show');
      return t('cli.shown');
    case 'hide':
      if (!running) return t('cli.notRunning');
      await client.control('hide');
      return t('cli.hidden');
    case 'mini':
    case 'full': {
      const config = loadConfig();
      config.mini = action === 'mini';
      if (running) await client.control('mini', config.mini);
      else {
        saveConfig(config);
        await start({ wait });
      }
      return config.mini ? t('cli.mini') : t('cli.full');
    }
    case 'chat':
      if (!running) await start({ wait: true });
      await client.control('quickchat');
      return t('cli.shown');
    case 'quit':
      if (!running) return t('cli.notRunning');
      await client.control('quit');
      return t('cli.quit');
    case 'list':
    case 'pets': {
      const { listPets } = require('../src/core/pets');
      return t('cli.petList', {
        list: listPets()
          .map((p) => `${p.key}（${p.displayName}）`)
          .join(', '),
      });
    }
    case 'use': {
      const { listPets } = require('../src/core/pets');
      const id = rest.join(' ').trim();
      const pet = listPets().find((p) => p.key === id || p.id === id || p.displayName === id);
      if (!pet) return t('cli.petNotFound', { id });
      if (running) await client.control('set-pet', pet.key);
      else {
        const config = loadConfig();
        config.pet = pet.key;
        saveConfig(config);
      }
      return t('cli.petChanged', { name: pet.displayName });
    }
    case 'next': {
      if (running) {
        const res = await client.control('next');
        return res.petName ? t('cli.next', { name: res.petName }) : t('cli.noNext');
      }
      const { listPets } = require('../src/core/pets');
      const rotation = require('../src/core/rotation');
      const config = loadConfig();
      const pets = listPets();
      const { next, queue } = rotation.pickNext(rotation.candidates(pets, config.rotation), config.pet, {
        order: rotation.normalizeOrder(config.rotation.order),
        queue: config.rotation.queue,
      });
      if (!next) return t('cli.noNext');
      config.pet = next;
      config.rotation = { ...config.rotation, queue, lastChangedAt: Date.now() };
      saveConfig(config);
      return t('cli.next', { name: pets.find((p) => p.key === next).displayName });
    }
    case 'rotate':
      return rotateCommand(rest, running, t);
    case 'autostart':
      return autostartCommand(rest[0], running, t);
    default:
      return t('cli.usage');
  }
}

/** "30", "30m", "90分", "2h", "1時間" → minutes */
function parseMinutes(token) {
  const m = /^(\d+(?:\.\d+)?)(h|時間|m|min|分)?$/.exec(String(token || '').trim());
  if (!m) return null;
  const value = Number(m[1]) * (m[2] === 'h' || m[2] === '時間' ? 60 : 1);
  return value >= 1 ? Math.round(value) : null;
}

/** Arguments of `rotate`: on | off | <interval> | --every <interval> | --group <name> | --all */
function parseRotateArgs(tokens) {
  const patch = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === 'on') patch.enabled = true;
    else if (token === 'off') patch.enabled = false;
    else if (token === '--every') patch.intervalMinutes = parseMinutes(tokens[++i]) || undefined;
    else if (token === '--all') Object.assign(patch, { group: null, pets: [] });
    else if (token === '--group') {
      // The name runs until the next option, so names with spaces work from /pet too.
      const words = [];
      while (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) words.push(tokens[++i]);
      Object.assign(patch, { group: words.join(' ') || null, pets: [] });
    } else if (parseMinutes(token)) {
      patch.intervalMinutes = parseMinutes(token);
      if (patch.enabled === undefined) patch.enabled = true;
    }
  }
  if (patch.intervalMinutes === undefined) delete patch.intervalMinutes;
  return patch;
}

async function rotateCommand(tokens, running, t) {
  const { listPets } = require('../src/core/pets');
  const rotation = require('../src/core/rotation');
  const { formatMinutes } = require('../src/shared/i18n');
  const patch = parseRotateArgs(tokens);
  const pets = listPets();
  if (patch.group && !pets.some((p) => p.group === patch.group)) return t('cli.groupNotFound', { group: patch.group });

  let state;
  if (!Object.keys(patch).length) {
    state = running ? (await client.control('rotation')).rotation : loadConfig().rotation;
  } else if (running) {
    state = (await client.control('rotation', patch)).rotation;
  } else {
    const config = loadConfig();
    // lastChangedAt 0 makes the app switch right away the next time it starts.
    config.rotation = { ...config.rotation, ...patch, ...(patch.enabled ? { lastChangedAt: 0 } : {}) };
    saveConfig(config);
    state = config.rotation;
  }
  const vars = {
    interval: formatMinutes(t, Number(state.intervalMinutes) || 60),
    count: rotation.candidates(pets, state).length,
    state: state.enabled ? t('cli.on') : t('cli.off'),
  };
  if (!Object.keys(patch).length) return t('cli.rotationStatus', vars);
  return state.enabled ? t('cli.rotationOn', vars) : t('cli.rotationOff');
}

async function autostartCommand(token, running, t) {
  const want = token === 'on' ? true : token === 'off' ? false : undefined;
  let on;
  if (running) on = (await client.control('autostart', want)).autostart;
  else {
    const autostart = require('../src/core/autostart');
    const opts = { electron: electronBinary(), appRoot: APP_ROOT };
    if (want === true) autostart.enable(opts);
    if (want === false) autostart.disable(opts);
    on = autostart.isEnabled(opts);
  }
  if (want === undefined) return t('cli.autostartStatus', { state: on ? t('cli.on') : t('cli.off') });
  if (on !== want) return t('cli.autostartFailed');
  return on ? t('cli.autostartOn') : t('cli.autostartOff');
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

/** UserPromptExpansion hook for `/pet`: run the command and block the expansion. */
async function slashHook() {
  let input = {};
  try {
    input = JSON.parse((await readStdin()) || '{}');
  } catch {
    return;
  }
  if (input.command_name !== 'pet') return;
  let reason;
  try {
    const args = String(input.command_args || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    reason = await runPetCommand(args, { wait: false });
  } catch (err) {
    reason = `🐾 ${err.message}`;
  }
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
}

/** Where cloud/setup.sh is downloaded from: this checkout's branch on GitHub. */
function rawBase() {
  try {
    const m = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(git(['remote', 'get-url', 'origin']));
    let branch = '';
    try {
      branch = git(['rev-parse', '--abbrev-ref', '@{upstream}']).replace(/^origin\//, '');
    } catch {
      branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    }
    if (m && branch && branch !== 'HEAD') return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${branch}`;
  } catch {
    // not a git checkout
  }
  return 'https://raw.githubusercontent.com/ORCA-IRUKA-222/claude_pet/main';
}

const CONNECTION = { connected: '接続中', disconnected: '再接続を待っています', stopped: '停止中' };

/** claude-pet cloud setup | on | off | test | (status) */
async function cloudCommand([action = 'status'] = []) {
  const { newKey, newTopic, seal } = require('../src/shared/seal');
  const running = await client.isRunning();
  const config = loadConfig();
  let cloud = config.cloud;
  const apply = async (patch) => {
    cloud = { ...cloud, ...patch };
    if (running) await client.control('cloud', patch);
    else saveConfig({ ...config, cloud });
  };

  switch (action) {
    case 'setup': {
      // keep an existing topic and key so a setup line already in use stays valid
      await apply(cloud.topic && cloud.key ? { enabled: true } : { enabled: true, topic: newTopic(), key: newKey() });
      const base = rawBase();
      const custom = cloud.server !== 'https://ntfy.sh' ? ` ${cloud.server}` : '';
      return [
        '☁ クラウドの Claude Code をペットに表示する設定',
        '',
        '1. claude.ai の Claude Code（クラウド）で環境の設定を開きます（セッション画面上部の環境名 → 編集）。',
        `2. 「ネットワークアクセス」の許可ドメインに ${new URL(cloud.server).host} を追加します。`,
        '3. 「セットアップスクリプト」に次の 1 行を追加します:',
        '',
        `curl -fsSL ${base}/cloud/setup.sh | sh -s -- ${base} ${cloud.topic} ${cloud.key}${custom} || true`,
        '',
        '4. 新しいクラウドセッションを始めると、ペットの一覧に ☁ 付きで出ます。',
        '',
        'この 1 行には暗号化の鍵が入っています。人に見せないでください。',
        `ペット側の受信だけ先に確かめるには: claude-pet cloud test`,
      ].join('\n');
    }
    case 'on':
      if (!cloud.topic || !cloud.key) return '☁ まだ設定がありません。claude-pet cloud setup を実行してください';
      await apply({ enabled: true });
      return '☁ クラウド連携をオンにしました';
    case 'off':
      await apply({ enabled: false });
      return '☁ クラウド連携をオフにしました（設定は残っています）';
    case 'test': {
      if (!cloud.topic || !cloud.key) return '☁ まだ設定がありません。claude-pet cloud setup を実行してください';
      const { publish } = require('../src/core/relay');
      const id = `cloud-test-${Date.now()}`;
      const event = {
        event: 'Stop',
        session_id: id,
        cwd: '/cloud/テスト',
        ts: Date.now(),
        source: 'cloud',
        message: 'クラウド中継のテストです。届いていれば、ペット側の設定は正しく動いています。',
      };
      await publish(cloud, seal(event, cloud.key));
      if (!running) return '☁ 中継サーバーに送りました。ペットを起動すると一覧に出ます';
      for (let i = 0; i < 20; i++) {
        const status = await client.status();
        if (status && status.sessions.some((s) => s.id === id)) return '☁ テストのメッセージがペットに届きました';
        await new Promise((r) => setTimeout(r, 500));
      }
      return '☁ 中継サーバーには送れましたが、ペットに届きませんでした。claude-pet cloud で状態を確認してください';
    }
    default: {
      if (!cloud.topic || !cloud.key) return '☁ クラウド連携: 未設定（claude-pet cloud setup で設定します）';
      if (!cloud.enabled) return '☁ クラウド連携: オフ（claude-pet cloud on でオンにします）';
      if (!running) return '☁ クラウド連携: オン（ペットは起動していません）';
      const { cloud: live } = await client.control('cloud');
      return `☁ クラウド連携: オン（${CONNECTION[live.connection] || live.connection}）`;
    }
  }
}

/** " (2.1.310)" for the found claude, or "" when it can't tell. */
function claudeVersion(claude) {
  try {
    const out = execFileSync(claude, ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      shell: process.platform === 'win32' && !/\.exe$/i.test(claude),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = /\d+\.\d+\.\d+/.exec(out);
    return m ? `（${m[0]}）` : '';
  } catch {
    return '';
  }
}

async function doctor() {
  const { findClaude, allClaudes } = require('../src/core/claude-path');
  const { transcriptFiles, readSession } = require('../src/core/history');
  const installer = require('../src/core/installer');
  const autostart = require('../src/core/autostart');
  const config = loadConfig();
  const running = await client.health();
  const local = buildId();
  const claude = findClaude({ configured: config.claudePath, learned: config.learnedClaudePath });
  const files = transcriptFiles();
  const recent = files.filter((f) => Date.now() - f.mtimeMs <= 7 * 24 * 3600e3).length;
  const latest = files.map((f) => readSession(f.file)).find((s) => s && s.entrypoint);
  const lines = [
    [
      'ペット本体',
      !running
        ? '起動していません（claude-pet で起動）'
        : local && running.build !== local
          ? '古いバージョンが動いています（claude-pet で再起動されます）'
          : `起動中（${local || running.version}）`,
    ],
    [
      'Claude Code',
      claude ? `${claude}${claudeVersion(claude)}` : '見つかりません（クイックチャットと「ターミナル」が使えません）',
    ],
    ...allClaudes({ learned: config.learnedClaudePath })
      .filter((c) => c.path !== claude)
      .map((c) => ['  ほかの Claude Code', `${c.path}${c.version ? `（${c.version}）` : ''}`]),
    ['クイックチャット', `${config.quickChat.model || 'claude-opus-5-5'}・エフォート ${config.quickChat.effort || 'xhigh'}`],
    ['フック', installer.isInstalled() ? '登録済み' : '未登録（claude-pet setup を実行してください）'],
    [
      '会話記録',
      files.length
        ? `${files.length} 件（直近 7 日 ${recent} 件、最新 ${new Date(files[0].mtimeMs).toLocaleString('ja-JP')}）`
        : 'ありません',
    ],
    ['記録の場所', path.join(claudeDir(), 'projects')],
    ...(latest
      ? [['最近使った Claude Code', `${ENTRYPOINTS[latest.entrypoint] || latest.entrypoint} ${latest.version || ''}`.trim()]]
      : []),
    ['自動起動', autostart.isEnabled() ? 'オン' : 'オフ'],
    ['クラウド連携', config.cloud.topic && config.cloud.enabled ? `オン（${config.cloud.server}）` : 'オフ'],
  ];
  for (const [label, value] of lines) console.log(`${label}: ${value}`);
  if (!claude) {
    const install =
      process.platform === 'win32'
        ? 'PowerShell で  irm https://claude.ai/install.ps1 | iex'
        : 'curl -fsSL https://claude.ai/install.sh | bash';
    console.log(
      `\nクイックチャットには claude コマンドが必要です。${install}  でインストールして、一度 claude を起動してログインしてください。`,
    );
  }
  if (!files.length) {
    console.log(
      '\nこのPCで Claude Code を使った記録がありません。クラウドの Claude Code は claude-pet cloud setup、ブラウザの claude.ai は extension フォルダの拡張機能で表示できます。',
    );
  }
}

function printStatus(data) {
  const sessions = (data && data.sessions) || [];
  if (!sessions.length) {
    console.log('セッションはありません');
    return;
  }
  for (const s of sessions) {
    const what = s.detail || s.activity || '';
    console.log(`${ICONS[s.effectiveStatus] || '•'} ${s.project.padEnd(20)} ${s.effectiveStatus.padEnd(8)} ${what}`);
  }
}

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv) {
  const [command = 'start', ...args] = argv;
  switch (command) {
    case 'start':
    case 'toggle':
    case 'show':
    case 'hide':
    case 'mini':
    case 'full':
    case 'chat':
    case 'quit':
    case 'use':
    case 'next':
    case 'rotate':
    case 'autostart':
      console.log(await runPetCommand([command, ...args]));
      break;
    case 'pet':
      // Same arguments as the /pet slash command (no argument toggles).
      console.log(await runPetCommand(args));
      break;
    case 'doctor':
      await doctor();
      break;
    case 'update':
      console.log(await update());
      break;
    case 'cloud':
      // CLI only, not /pet: the setup line holds the key and shouldn't land in a transcript
      console.log(await cloudCommand(args));
      break;
    case 'status':
      if (!(await client.isRunning())) console.log(translator(loadConfig().language)('cli.notRunning'));
      else printStatus(await client.status());
      break;
    case 'pets': {
      const { listPets } = require('../src/core/pets');
      const current = loadConfig().pet;
      for (const p of listPets()) {
        console.log(`${p.key === current ? '*' : ' '} ${p.key.padEnd(20)} ${p.displayName}  [${p.origin}, ${p.kind}]`);
      }
      break;
    }
    case 'setup': {
      const installer = require('../src/core/installer');
      const result = installer.install();
      console.log(`フックを登録しました: ${result.settings}`);
      for (const dir of result.skills) console.log(`スキルを追加しました: ${dir}`);
      console.log('起動中の Claude Code には、次のセッションから反映されます。');
      console.log('PC 起動時にペットも起動するには: claude-pet autostart on');
      break;
    }
    case 'uninstall': {
      const installer = require('../src/core/installer');
      const result = installer.uninstall();
      if (result.settings) console.log(`フックを削除しました: ${result.settings}`);
      for (const dir of result.skills) console.log(`スキルを削除しました: ${dir}`);
      const autostart = require('../src/core/autostart');
      if (autostart.isEnabled()) {
        autostart.disable();
        console.log('PC 起動時の自動起動をやめました');
      }
      break;
    }
    case 'add-folder': {
      const { importFolder } = require('../src/core/pets');
      const folder = args.find((a, i) => !a.startsWith('--') && !['--group', '--height'].includes(args[i - 1]));
      if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory())
        throw new Error('画像の入ったフォルダを指定してください');
      const result = importFolder(folder, { group: option(args, '--group'), height: option(args, '--height') || 320 });
      console.log(`「${result.group}」に ${result.added.length} 人のペットを追加しました:`);
      for (const pet of result.added) console.log(`  ${pet.displayName}（${pet.id}）`);
      if (result.opaque.length) {
        console.log('\n背景が透明ではない画像があります（四角く表示されます。背景を消した PNG にすると自然に見えます）:');
        for (const file of result.opaque) console.log(`  ${path.basename(file)}`);
      }
      if (result.skipped.length) {
        console.log('\n取り込めなかったもの:');
        for (const s of result.skipped) {
          const why = s.reason === 'jpeg' ? 'JPEG などは透明にできないので、背景を消した PNG / WebP にしてください' : s.reason;
          console.log(`  ${path.basename(s.file)} — ${why}`);
        }
      }
      if (result.added.length) console.log(`\n交代で表示するには: claude-pet rotate on --group "${result.group}" --every 60`);
      break;
    }
    case 'add-image': {
      const { createImagePet } = require('../src/core/pets');
      const valueOptions = new Set(['--id', '--name', '--group', '--height', '--state']);
      const file = args.find((a, i) => !a.startsWith('--') && !valueOptions.has(args[i - 1]));
      if (!file || !fs.existsSync(file)) throw new Error('画像ファイルを指定してください');
      const states = {};
      args.forEach((a, i) => {
        if (a !== '--state') return;
        const [state, image] = String(args[i + 1] || '').split(/=(.*)/s);
        if (!state || !image || !fs.existsSync(image))
          throw new Error(`--state は <状態>=<画像> の形で指定してください: ${args[i + 1]}`);
        states[state] = image;
      });
      const pet = createImagePet(file, {
        id: option(args, '--id'),
        name: option(args, '--name'),
        group: option(args, '--group'),
        height: option(args, '--height'),
        states,
      });
      console.log(`ペットを作成しました: ${pet.displayName} (${pet.key || pet.id}) → ${pet.dir}`);
      console.log(`切り替えるには: claude-pet use ${pet.id}`);
      break;
    }
    case 'build': {
      const { buildPets, printResult } = require('../tools/build-pet');
      const design = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
      if (!design) throw new Error('design.js を指定してください');
      const results = buildPets(design, { outDir: option(args, '--out'), install: args.includes('--install') });
      results.forEach(printResult);
      const groups = [...new Set(results.map((r) => r.manifest.group).filter(Boolean))];
      if (args.includes('--install') && groups.length) {
        console.log(`\n交代で表示するには: claude-pet rotate on --group "${groups[0]}" --every 60`);
      }
      break;
    }
    case 'slash-hook':
      await slashHook();
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`claude-pet: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { runPetCommand, main, parseRotateArgs, parseMinutes };
