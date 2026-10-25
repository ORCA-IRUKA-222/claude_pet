#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const { APP_ROOT, loadConfig, saveConfig } = require('../src/shared/config');
const { translator } = require('../src/shared/i18n');
const { cleanEnv } = require('../src/shared/env');
const { parseDuration, formatSpan } = require('../src/shared/time');
const client = require('../src/core/client');

const HELP = `claude-pet — Claude Code のデスクトップペット

使い方:
  claude-pet [start]             ペットを起動（起動済みなら表示）
  claude-pet toggle | show | hide
  claude-pet mini | full         ミニ表示 / 通常表示
  claude-pet chat                クイックチャットを開く
  claude-pet quit                終了
  claude-pet status              セッションの状態を表示
  claude-pet timer <時間> [名前]  タイマーを開始（例: 10m, 1h30m, 5:00）。timer stop で止める
  claude-pet pomo [start | stop | skip]
                                 ポモドーロタイマー
  claude-pet memo <内容>          メモを追加（今のフォルダのプロジェクト名が付きます）
  claude-pet dnd [時間 | off]     おやすみモード（時間なしは解除するまで）
  claude-pet shot                スクリーンショットを撮ってクイックチャットで質問
  claude-pet setup               Claude Code にフックと /pet, /hatch-pet を登録
  claude-pet uninstall           登録を解除
  claude-pet pets                使えるペットの一覧
  claude-pet use <id>            ペットを切り替え
  claude-pet add-image <画像> [--name 名前]
                                 透過 PNG / WebP / GIF 1 枚からペットを作成
  claude-pet build <design.js> [--out <dir>] [--install]
                                 コードで描いたペットをスプライトシートに書き出し
`;

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

async function start({ wait = true } = {}) {
  if (await client.isRunning()) {
    await client.control('show');
    return 'shown';
  }
  launchApp();
  if (wait && !(await waitUntilRunning(15000))) throw new Error('ペットの起動を確認できませんでした');
  return 'starting';
}

/** Start the pet if needed and wait for it: timers and おやすみモード live in the app. */
async function ensureRunning(running) {
  if (running) return;
  launchApp();
  if (!(await waitUntilRunning(10000))) throw new Error('ペットの起動を確認できませんでした');
}

function clockText(ts, language) {
  return new Date(ts).toLocaleTimeString(language === 'en' ? 'en-US' : 'ja-JP', { hour: '2-digit', minute: '2-digit' });
}

/** Run a pet command and return a short message for the user. */
async function runPetCommand(args, { wait = true, cwd = process.cwd() } = {}) {
  const config = loadConfig();
  const t = translator(config.language);
  const [action = 'toggle', ...rest] = args;
  const running = await client.isRunning();

  switch (action) {
    case 'timer': {
      const [first = '', ...label] = rest;
      if (['stop', 'off', 'cancel', 'reset'].includes(first)) {
        if (!running) return t('cli.notRunning');
        await client.control('timer', { command: 'reset' });
        return t('cli.timerStopped');
      }
      const ms = parseDuration(first);
      if (!ms) return t('cli.badDuration');
      await ensureRunning(running);
      await client.control('timer', { command: 'start', ms, label: label.join(' ') });
      return t('cli.timerStarted', { time: formatSpan(ms, config.language) });
    }
    case 'pomo':
    case 'pomodoro': {
      const sub = rest[0] || 'start';
      if (sub === 'stop' || sub === 'off' || sub === 'skip') {
        if (!running) return t('cli.notRunning');
        await client.control('timer', { command: sub === 'skip' ? 'pomo-skip' : 'pomo-stop' });
        return sub === 'skip' ? t('cli.pomoSkipped') : t('cli.pomoStopped');
      }
      await ensureRunning(running);
      const res = await client.control('timer', { command: 'pomo-start' });
      return t('cli.pomoStarted', { focus: res.timers.pomodoro.settings.focusMinutes });
    }
    case 'memo': {
      const text = rest.join(' ').trim();
      if (!text) return t('cli.needText');
      if (running) await client.control('memo-add', { text, cwd });
      else new (require('../src/core/memos').MemoStore)().add({ text, cwd });
      return t('cli.memoAdded', { text: text.length > 60 ? `${text.slice(0, 59)}…` : text });
    }
    case 'dnd': {
      const arg = rest[0] || '';
      if (arg === 'off') {
        if (!running) return t('cli.dndOff');
        await client.control('dnd', { off: true });
        return t('cli.dndOff');
      }
      let minutes = null;
      if (arg && arg !== 'on') {
        const ms = parseDuration(arg);
        if (!ms) return t('cli.badDuration');
        minutes = ms / 60e3;
      }
      await ensureRunning(running);
      const res = await client.control('dnd', { minutes });
      return t('cli.dndOn', {
        until:
          res.dnd && res.dnd.until ? t('cli.dndUntil', { time: clockText(res.dnd.until, config.language) }) : t('cli.dndForever'),
      });
    }
    case 'shot':
    case 'screenshot':
      await ensureRunning(running);
      await client.control('screenshot');
      return t('cli.shown');
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
    default:
      return t('cli.usage');
  }
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
    reason = await runPetCommand(args, { wait: false, cwd: input.cwd || process.cwd() });
  } catch (err) {
    reason = `🐾 ${err.message}`;
  }
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
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
    case 'timer':
    case 'pomo':
    case 'pomodoro':
    case 'memo':
    case 'dnd':
    case 'shot':
    case 'screenshot':
      console.log(await runPetCommand([command, ...args]));
      break;
    case 'pet':
      // Same arguments as the /pet slash command (no argument toggles).
      console.log(await runPetCommand(args));
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
      break;
    }
    case 'uninstall': {
      const installer = require('../src/core/installer');
      const result = installer.uninstall();
      if (result.settings) console.log(`フックを削除しました: ${result.settings}`);
      for (const dir of result.skills) console.log(`スキルを削除しました: ${dir}`);
      break;
    }
    case 'add-image': {
      const { createImagePet } = require('../src/core/pets');
      const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--name');
      if (!file || !fs.existsSync(file)) throw new Error('画像ファイルを指定してください');
      const pet = createImagePet(file, { name: option(args, '--name') });
      console.log(`ペットを作成しました: ${pet.displayName} (${pet.key || pet.id}) → ${pet.dir}`);
      console.log(`切り替えるには: claude-pet use ${pet.id}`);
      break;
    }
    case 'build': {
      const { buildPet } = require('../tools/build-pet');
      const design = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
      if (!design) throw new Error('design.js を指定してください');
      const result = buildPet(design, { outDir: option(args, '--out'), install: args.includes('--install') });
      console.log(`package: ${result.outDir}`);
      console.log(`contact sheet: ${result.contactSheet}`);
      if (result.installedTo) console.log(`installed: ${result.installedTo}`);
      for (const p of result.problems) console.log(`warning: ${p}`);
      if (!result.problems.length) console.log('validation: ok');
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

module.exports = { runPetCommand, main };
