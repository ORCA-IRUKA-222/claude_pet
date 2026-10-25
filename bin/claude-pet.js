#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
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

/** A pet started from older files (before `git pull`) is restarted so the update takes effect. */
async function restartIfStale({ wait = true } = {}) {
  const running = await client.health();
  const local = buildId();
  if (!running || !local || running.build === local) return false;
  await client.control('quit');
  const until = Date.now() + 5000;
  while (Date.now() < until && (await client.isRunning())) await new Promise((r) => setTimeout(r, 200));
  launchApp();
  if (wait) await waitUntilRunning(15000);
  return true;
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

async function doctor() {
  const { findClaude } = require('../src/core/claude-path');
  const { transcriptFiles } = require('../src/core/history');
  const installer = require('../src/core/installer');
  const autostart = require('../src/core/autostart');
  const config = loadConfig();
  const running = await client.health();
  const local = buildId();
  const claude = findClaude({ configured: config.claudePath, learned: config.learnedClaudePath });
  const files = transcriptFiles();
  const recent = files.filter((f) => Date.now() - f.mtimeMs <= 7 * 24 * 3600e3).length;
  const lines = [
    [
      'ペット本体',
      !running
        ? '起動していません（claude-pet で起動）'
        : local && running.build !== local
          ? '古いバージョンが動いています（claude-pet で再起動されます）'
          : `起動中（${local || running.version}）`,
    ],
    ['Claude Code', claude || '見つかりません（クイックチャットと「ターミナルで続ける」が使えません）'],
    ['フック', installer.isInstalled() ? '登録済み' : '未登録（claude-pet setup を実行してください）'],
    [
      '会話記録',
      files.length
        ? `${files.length} 件（直近 7 日 ${recent} 件、最新 ${new Date(files[0].mtimeMs).toLocaleString('ja-JP')}）`
        : 'ありません',
    ],
    ['記録の場所', path.join(claudeDir(), 'projects')],
    ['自動起動', autostart.isEnabled() ? 'オン' : 'オフ'],
  ];
  for (const [label, value] of lines) console.log(`${label}: ${value}`);
  if (!files.length) {
    console.log(
      '\nこのPCで Claude Code を使った記録がありません。Claude アプリや Web のクラウドで動く会話は、PC に記録が残らないためペットには出せません。',
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
