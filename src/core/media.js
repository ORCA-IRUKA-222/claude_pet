'use strict';

// What is playing on this computer (Spotify, a browser, the Media Player…) and ⏮ ⏯ ⏭ for it,
// for the music widget above the pet.
//
//   Windows  the system media controls (the ones the volume flyout shows), through one
//            PowerShell process kept running; media keys when those can't be reached
//   macOS    Spotify or Music, through osascript
//   Linux    any MPRIS player, through playerctl

const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const ACTIONS = new Set(['play-pause', 'next', 'previous']);
const ANSWER_MS = 8000; // the first answer waits for Windows to load its media API

// One command per line on stdin (status | play-pause | next | previous), one JSON line back.
const WINDOWS_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
function Send($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
$script:keys = $null
function Key([byte]$vk) {
  if (-not $script:keys) {
    $script:keys = Add-Type -Name MediaKeys -Namespace ClaudePet -PassThru -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);'
  }
  $script:keys::keybd_event($vk, 0, 1, [UIntPtr]::Zero)
  $script:keys::keybd_event($vk, 0, 3, [UIntPtr]::Zero)
}
$script:asTask = $null
function Await($op, [Type]$type) {
  $task = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op))
  [void]$task.Wait(5000)
  $task.Result
}
$manager = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1'
  } | Select-Object -First 1
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
} catch {
  $manager = $null
}
Send @{ ready = $true; controls = [bool]$manager }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $cmd = $line.Trim()
  try {
    $session = $null
    if ($manager) { $session = $manager.GetCurrentSession() }
    if ($cmd -eq 'status') {
      if (-not $session) {
        Send @{ ok = $true; controls = [bool]$manager; session = $false }
      } else {
        $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        $info = $session.GetPlaybackInfo()
        Send @{
          ok = $true; controls = $true; session = $true
          app = $session.SourceAppUserModelId; title = $props.Title; artist = $props.Artist
          playing = ($info.PlaybackStatus.ToString() -eq 'Playing')
          canNext = $info.Controls.IsNextEnabled; canPrevious = $info.Controls.IsPreviousEnabled
        }
      }
    } elseif ($cmd -eq 'next') {
      if ($session) { $null = Await ($session.TrySkipNextAsync()) ([bool]) } else { Key 0xB0 }
      Send @{ ok = $true }
    } elseif ($cmd -eq 'previous') {
      if ($session) { $null = Await ($session.TrySkipPreviousAsync()) ([bool]) } else { Key 0xB1 }
      Send @{ ok = $true }
    } elseif ($cmd -eq 'play-pause') {
      if ($session) { $null = Await ($session.TryTogglePlayPauseAsync()) ([bool]) } else { Key 0xB3 }
      Send @{ ok = $true }
    } else {
      Send @{ ok = $false; error = 'unknown command' }
    }
  } catch {
    Send @{ ok = $false; error = $_.Exception.Message }
  }
}
`;

const WINDOWS_KEYS = { next: 0xb0, previous: 0xb1, 'play-pause': 0xb3 };

// Spotify answers the same Apple events as Music, so both are asked in Music's terms (Music is
// always there, and naming an app that isn't installed would make macOS ask where it is).
const MAC_STATUS = `
using terms from application "Music"
  repeat with candidate in {"Spotify", "Music"}
    set appName to contents of candidate
    if application appName is running then
      tell application appName
        set s to player state as string
        try
          return appName & tab & s & tab & (name of current track) & tab & (artist of current track)
        on error
          return appName & tab & s & tab & "" & tab & ""
        end try
      end tell
    end if
  end repeat
end using terms from
return ""
`;

const MAC_VERBS = { next: 'next track', previous: 'previous track', 'play-pause': 'playpause' };
const PLAYERCTL_VERBS = { next: 'next', previous: 'previous', 'play-pause': 'play-pause' };

/** A readable name for the app that plays (Windows gives an app id). */
function appName(id) {
  const text = String(id || '');
  if (!text) return null;
  const known = [
    [/spotify/i, 'Spotify'],
    [/msedge/i, 'Edge'],
    [/chrome/i, 'Chrome'],
    [/firefox/i, 'Firefox'],
    [/ZuneMusic|Media\s*Player/i, 'メディア プレーヤー'],
    [/AppleMusic|iTunes/i, 'Apple Music'],
    [/vlc/i, 'VLC'],
    [/amazon\s*music/i, 'Amazon Music'],
    [/youtube/i, 'YouTube Music'],
  ];
  for (const [re, name] of known) if (re.test(text)) return name;
  return (
    text
      .replace(/![^!]*$/, '')
      .replace(/_[a-z0-9]{13}$/i, '')
      .replace(/\.exe$/i, '')
      .split(/[\\/.]/)
      .pop() || text
  );
}

const nothing = (extra = {}) => ({
  available: true,
  session: false,
  app: null,
  title: null,
  artist: null,
  playing: false,
  ...extra,
});

/** What the Windows helper said, in the widget's terms. */
function fromWindows(answer) {
  if (!answer || !answer.ok) return { available: false, error: (answer && answer.error) || 'no answer' };
  if (!answer.session) return nothing({ controls: Boolean(answer.controls) });
  return {
    available: true,
    session: true,
    app: appName(answer.app),
    title: answer.title || null,
    artist: answer.artist || null,
    playing: Boolean(answer.playing),
    canNext: answer.canNext !== false,
    canPrevious: answer.canPrevious !== false,
  };
}

/** osascript's tab-separated answer: app, state, title, artist. */
function fromMac(text) {
  const line = String(text || '').trim();
  if (!line) return nothing();
  const [app, playerState, title, artist] = line.split('\t');
  return {
    available: true,
    session: true,
    app,
    title: title || null,
    artist: artist || null,
    playing: playerState === 'playing',
  };
}

/** playerctl's answer: player, status, title, artist. */
function fromPlayerctl(text) {
  const line = String(text || '')
    .split('\n')
    .find((l) => l.trim());
  if (!line) return nothing();
  const [player, status, title, artist] = line.split('\t');
  return {
    available: true,
    session: true,
    app: player ? player.replace(/\..*$/, '').replace(/^./, (c) => c.toUpperCase()) : null,
    title: title || null,
    artist: artist || null,
    playing: status === 'Playing',
  };
}

function run(file, args, { timeout = 5000, ...options } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, windowsHide: true, encoding: 'utf8', ...options }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve(stdout);
    });
  });
}

function encodedCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** The long-lived PowerShell process on Windows: one request at a time, answered line by line. */
class LineHelper {
  constructor({ command, args }) {
    this.command = command;
    this.args = args;
    this.child = null;
    this.buffer = '';
    this.waiting = []; // resolve functions for the answers to come
    this.queue = Promise.resolve();
    this.ready = null;
  }

  start() {
    if (this.child) return this.ready;
    const child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.child = child;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let nl;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).replace(/^﻿/, '').trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        let answer = null;
        try {
          answer = JSON.parse(line);
        } catch {
          continue;
        }
        const next = this.waiting.shift();
        if (next) next(answer);
      }
    });
    const gone = () => {
      if (this.child !== child) return;
      this.child = null;
      for (const next of this.waiting.splice(0)) next(null);
    };
    child.on('error', gone);
    child.on('exit', gone);
    child.stdin.on('error', () => {});
    // its first line says it is ready (and whether the media controls loaded)
    this.ready = this.answer(null);
    return this.ready;
  }

  answer(line) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // no answer: start over next time
        this.waiting = this.waiting.filter((w) => w !== done);
        this.stop();
        resolve(null);
      }, ANSWER_MS);
      const done = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.waiting.push(done);
      if (line != null && this.child) this.child.stdin.write(`${line}\n`);
    });
  }

  request(line) {
    const result = this.queue.then(async () => {
      const ready = await this.start();
      if (!ready || !this.child) return null;
      return this.answer(line);
    });
    this.queue = result.catch(() => null);
    return result;
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (child) child.kill();
    for (const next of this.waiting.splice(0)) next(null);
  }
}

class MediaControl extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.platform]
   * @param {{command: string, args: string[]}} [options.helper] the Windows helper (tests use a stand-in)
   * @param {Function} [options.run] (file, args) → Promise<stdout>, for osascript / playerctl / media keys
   */
  constructor({ platform = process.platform, helper = null, run: runner = run } = {}) {
    super();
    this.platform = platform;
    this.run = runner;
    this.helper =
      platform === 'win32'
        ? new LineHelper(
            helper || {
              command: 'powershell.exe',
              args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand(WINDOWS_HELPER)],
            },
          )
        : null;
  }

  /** { available, session, app, title, artist, playing, … } */
  async status() {
    try {
      if (this.platform === 'win32') return fromWindows(await this.helper.request('status'));
      if (this.platform === 'darwin') return fromMac(await this.run('osascript', ['-e', MAC_STATUS]));
      return fromPlayerctl(
        await this.run('playerctl', ['metadata', '--format', '{{playerName}}\t{{status}}\t{{title}}\t{{artist}}']),
      );
    } catch (err) {
      // playerctl answers "No players found" with an error
      if (/no players? found/i.test(`${err.stderr || ''}${err.message || ''}`)) return nothing();
      return { available: false, error: err.code === 'ENOENT' ? 'missing' : err.message };
    }
  }

  /** ⏯ ⏭ ⏮: 'play-pause' | 'next' | 'previous'. */
  async command(action) {
    if (!ACTIONS.has(action)) throw new Error(`unknown action: ${action}`);
    if (this.platform === 'win32') {
      const answer = await this.helper.request(action);
      if (answer && answer.ok) return true;
      // the helper isn't answering: press the media key instead
      await this.run('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encodedCommand(`${WINDOWS_HELPER.split('$script:asTask = $null')[0]}\nKey ${WINDOWS_KEYS[action]}`),
      ]);
      return true;
    }
    if (this.platform === 'darwin') {
      const now = await this.status();
      if (!now.session) return false;
      const target = now.app === 'Music' ? 'Music' : 'Spotify';
      await this.run('osascript', [
        '-e',
        `using terms from application "Music"\ntell application "${target}" to ${MAC_VERBS[action]}\nend using terms from`,
      ]);
      return true;
    }
    await this.run('playerctl', [PLAYERCTL_VERBS[action]]);
    return true;
  }

  stop() {
    if (this.helper) this.helper.stop();
  }
}

module.exports = { MediaControl, appName, fromWindows, fromMac, fromPlayerctl, WINDOWS_HELPER };
