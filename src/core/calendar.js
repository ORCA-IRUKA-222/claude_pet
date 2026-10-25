'use strict';

// Reads a calendar from an iCal (.ics) URL, such as Google Calendar's
// "secret address in iCal format". Only reading: nothing is sent anywhere.
// Supports time zones (TZID), all-day events, and the common recurrence
// rules (daily / weekly / monthly / yearly, INTERVAL, COUNT, UNTIL, BYDAY,
// BYMONTHDAY, BYMONTH), EXDATE and moved occurrences (RECURRENCE-ID).

const DAY = 86400e3;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PERIODS = 5000;

// ---------------------------------------------------------------- parsing

function unescapeText(value) {
  return value.replace(/\\([\\;,nN])/g, (_, ch) => (ch === 'n' || ch === 'N' ? '\n' : ch));
}

function parseContentLine(line) {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuotes = !inQuotes;
    else if (line[i] === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(';');
  const params = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

/** "20261025T100000" (+ TZID / Z) or "20261025" → wall-clock fields and how to read them. */
function parseDateValue(value, params = {}) {
  const v = String(value || '').trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m || params.VALUE === 'DATE') {
    m = m || v.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    return { y: +m[1], mo: +m[2], d: +m[3], h: 0, mi: 0, s: 0, allDay: true, utc: false, tz: null };
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  return {
    y: +m[1],
    mo: +m[2],
    d: +m[3],
    h: +m[4],
    mi: +m[5],
    s: +(m[6] || 0),
    allDay: false,
    utc: Boolean(m[7]),
    tz: m[7] ? null : params.TZID || null,
  };
}

function parseIcsDuration(value) {
  const m = String(value || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 * 86400 + (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

function parseRrule(value) {
  const rule = {};
  for (const part of String(value || '').split(';')) {
    const [k, v] = part.split('=');
    if (k && v) rule[k.toUpperCase()] = v;
  }
  if (!rule.FREQ) return null;
  return {
    freq: rule.FREQ.toUpperCase(),
    interval: Math.max(1, parseInt(rule.INTERVAL, 10) || 1),
    count: rule.COUNT ? parseInt(rule.COUNT, 10) : null,
    until: rule.UNTIL ? parseDateValue(rule.UNTIL) : null,
    byDay: rule.BYDAY
      ? rule.BYDAY.split(',')
          .map((d) =>
            d
              .trim()
              .toUpperCase()
              .match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/),
          )
          .filter(Boolean)
          .map((d) => ({ n: d[1] ? parseInt(d[1], 10) : 0, day: WEEKDAYS.indexOf(d[2]) }))
      : null,
    byMonthDay: rule.BYMONTHDAY
      ? rule.BYMONTHDAY.split(',')
          .map((n) => parseInt(n, 10))
          .filter((n) => n && Math.abs(n) <= 31)
      : null,
    byMonth: rule.BYMONTH
      ? rule.BYMONTH.split(',')
          .map((n) => parseInt(n, 10))
          .filter((n) => n >= 1 && n <= 12)
      : null,
    weekStart: rule.WKST ? Math.max(0, WEEKDAYS.indexOf(rule.WKST.toUpperCase())) : 1,
  };
}

/** Parse VEVENTs out of an .ics document. */
function parseICS(text) {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
  const events = [];
  let current = null;
  let depth = 0; // nested components inside a VEVENT (VALARM)
  for (const raw of lines) {
    const line = parseContentLine(raw);
    if (!line) continue;
    if (line.name === 'BEGIN') {
      if (line.value.toUpperCase() === 'VEVENT' && !current) current = { exdates: [] };
      else if (current) depth += 1;
      continue;
    }
    if (line.name === 'END') {
      if (current && depth > 0) depth -= 1;
      else if (current && line.value.toUpperCase() === 'VEVENT') {
        if (current.start) events.push(current);
        current = null;
      }
      continue;
    }
    if (!current || depth > 0) continue;
    switch (line.name) {
      case 'UID':
        current.uid = line.value;
        break;
      case 'SUMMARY':
        current.summary = unescapeText(line.value);
        break;
      case 'LOCATION':
        current.location = unescapeText(line.value);
        break;
      case 'STATUS':
        current.status = line.value.toUpperCase();
        break;
      case 'DTSTART':
        current.start = parseDateValue(line.value, line.params);
        break;
      case 'DTEND':
        current.end = parseDateValue(line.value, line.params);
        break;
      case 'DURATION':
        current.duration = parseIcsDuration(line.value);
        break;
      case 'RRULE':
        current.rrule = parseRrule(line.value);
        break;
      case 'EXDATE':
        for (const v of line.value.split(',')) {
          const d = parseDateValue(v, line.params);
          if (d) current.exdates.push(d);
        }
        break;
      case 'RECURRENCE-ID':
        current.recurrenceId = parseDateValue(line.value, line.params);
        break;
      default:
        break;
    }
  }
  return events;
}

// ---------------------------------------------------------------- time zones

const formatters = new Map();

function zoneFormatter(tz) {
  if (!formatters.has(tz)) {
    let f = null;
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      f = null; // not an IANA zone name (some calendars use Windows names)
    }
    formatters.set(tz, f);
  }
  return formatters.get(tz);
}

/** Offset of `tz` from UTC at `ts`, in ms (Tokyo → +9h). null for unknown zones. */
function zoneOffset(ts, tz) {
  const f = zoneFormatter(tz);
  if (!f) return null;
  const parts = {};
  for (const p of f.formatToParts(new Date(ts))) parts[p.type] = p.value;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Wall-clock fields → epoch ms, honouring UTC, TZID or (otherwise) the local zone. */
function toEpoch(f) {
  if (f.utc) return Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s);
  if (f.tz && !f.allDay) {
    const guess = Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s);
    const offset = zoneOffset(guess, f.tz);
    if (offset != null) {
      let ts = guess - offset;
      const corrected = zoneOffset(ts, f.tz);
      if (corrected !== offset) ts = guess - corrected;
      return ts;
    }
  }
  return new Date(f.y, f.mo - 1, f.d, f.h, f.mi, f.s).getTime();
}

// ---------------------------------------------------------------- recurrence

// Calendar dates are handled as UTC midnights so weekday maths ignores time zones.
function civil(y, mo, d) {
  return Date.UTC(y, mo - 1, d);
}

function civilFields(ms) {
  const date = new Date(ms);
  return { y: date.getUTCFullYear(), mo: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

function daysInMonth(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** The dates of one month that match BYDAY / BYMONTHDAY (or the start's day of month). */
function monthDates(y, mo, rule, startDay) {
  const last = daysInMonth(y, mo);
  const out = new Set();
  if (rule.byMonthDay) {
    for (const n of rule.byMonthDay) {
      const d = n > 0 ? n : last + n + 1;
      if (d >= 1 && d <= last) out.add(d);
    }
  }
  if (rule.byDay) {
    for (const { n, day } of rule.byDay) {
      const matches = [];
      for (let d = 1; d <= last; d++) if (new Date(civil(y, mo, d)).getUTCDay() === day) matches.push(d);
      if (n === 0) matches.forEach((d) => out.add(d));
      else {
        const pick = n > 0 ? matches[n - 1] : matches[matches.length + n];
        if (pick) out.add(pick);
      }
    }
  }
  if (!rule.byMonthDay && !rule.byDay && startDay <= last) out.add(startDay);
  return [...out].sort((a, b) => a - b).map((d) => civil(y, mo, d));
}

/** Candidate dates (as civil ms) for the k-th period of a rule, in order. */
function periodDates(rule, start, k) {
  const base = civil(start.y, start.mo, start.d);
  switch (rule.freq) {
    case 'DAILY': {
      const date = base + k * rule.interval * DAY;
      const weekday = new Date(date).getUTCDay();
      if (rule.byDay && !rule.byDay.some((b) => b.day === weekday)) return [];
      if (rule.byMonth && !rule.byMonth.includes(civilFields(date).mo)) return [];
      return [date];
    }
    case 'WEEKLY': {
      const offset = (new Date(base).getUTCDay() - rule.weekStart + 7) % 7;
      const weekStart = base - offset * DAY + k * rule.interval * 7 * DAY;
      const days = rule.byDay ? rule.byDay.map((b) => b.day) : [new Date(base).getUTCDay()];
      return [...new Set(days)].map((day) => weekStart + ((day - rule.weekStart + 7) % 7) * DAY).sort((a, b) => a - b);
    }
    case 'MONTHLY': {
      const index = start.mo - 1 + k * rule.interval;
      const y = start.y + Math.floor(index / 12);
      const mo = (index % 12) + 1;
      if (rule.byMonth && !rule.byMonth.includes(mo)) return [];
      return monthDates(y, mo, rule, start.d);
    }
    case 'YEARLY': {
      const y = start.y + k * rule.interval;
      const months = rule.byMonth || [start.mo];
      const ruleForMonth = rule.byMonthDay || rule.byDay ? rule : { ...rule, byDay: null, byMonthDay: null };
      return months.flatMap((mo) => monthDates(y, mo, ruleForMonth, start.d));
    }
    default:
      return k === 0 ? [base] : [];
  }
}

/** The first period worth generating: rules without COUNT can skip straight to the window. */
function firstPeriod(rule, start, first, from) {
  if (rule.count != null || from <= first) return 0;
  const target = new Date(from);
  let periods;
  switch (rule.freq) {
    case 'DAILY':
      periods = (from - first) / (rule.interval * DAY);
      break;
    case 'WEEKLY':
      periods = (from - first) / (rule.interval * 7 * DAY);
      break;
    case 'MONTHLY':
      periods = ((target.getFullYear() - start.y) * 12 + (target.getMonth() + 1 - start.mo)) / rule.interval;
      break;
    case 'YEARLY':
      periods = (target.getFullYear() - start.y) / rule.interval;
      break;
    default:
      periods = 0;
  }
  return Math.max(0, Math.floor(periods) - 1);
}

function eventLength(event) {
  const start = toEpoch(event.start);
  if (event.end) return Math.max(0, toEpoch(event.end) - start);
  if (event.duration != null) return Math.max(0, event.duration);
  return event.start.allDay ? DAY : 0;
}

/** Occurrences of one event that overlap [from, to): [{ start, end }] in epoch ms. */
function occurrences(event, from, to, overridden = new Set()) {
  const length = eventLength(event);
  const first = toEpoch(event.start);
  if (!event.rrule) return first < to && first + Math.max(length, 1) > from ? [{ start: first, end: first + length }] : [];

  const rule = event.rrule;
  const until = rule.until ? toEpoch(rule.until.allDay ? { ...rule.until, h: 23, mi: 59, s: 59 } : rule.until) : Infinity;
  const excluded = new Set(event.exdates.map((d) => toEpoch({ ...d, tz: d.tz || event.start.tz, utc: d.utc })));
  const out = [];
  let count = 0;
  const k0 = firstPeriod(rule, event.start, first, from - length);
  for (let k = k0; k < k0 + MAX_PERIODS; k++) {
    const dates = periodDates(rule, event.start, k);
    let pastWindow = false;
    for (const date of dates) {
      const { y, mo, d } = civilFields(date);
      const start = toEpoch({ ...event.start, y, mo, d });
      if (start < first) continue;
      count += 1;
      if ((rule.count != null && count > rule.count) || start > until) return out;
      if (start >= to) {
        pastWindow = true;
        break;
      }
      if (excluded.has(start) || overridden.has(start)) continue;
      if (start + Math.max(length, 1) > from) out.push({ start, end: start + length });
    }
    if (pastWindow) break;
  }
  return out;
}

/** All occurrences overlapping [from, to), sorted by start. */
function expandEvents(events, from, to) {
  const overrides = new Map(); // uid → Set of replaced occurrence starts
  for (const e of events) {
    if (e.recurrenceId && e.uid) {
      if (!overrides.has(e.uid)) overrides.set(e.uid, new Set());
      overrides.get(e.uid).add(toEpoch({ ...e.recurrenceId, tz: e.recurrenceId.tz || e.start.tz }));
    }
  }
  const out = [];
  for (const e of events) {
    if (e.status === 'CANCELLED') continue;
    const replaced = !e.recurrenceId && e.uid ? overrides.get(e.uid) : undefined;
    for (const o of occurrences(e, from, to, replaced)) {
      out.push({
        uid: e.uid || null,
        summary: e.summary || '',
        location: e.location || '',
        allDay: Boolean(e.start.allDay),
        start: o.start,
        end: o.end,
      });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.summary.localeCompare(b.summary));
}

// ---------------------------------------------------------------- feed

/** webcal:// → https://; anything that isn't http(s) is refused. */
function normalizeUrl(url) {
  const text = String(url || '').trim();
  if (!text) return null;
  const fixed = text.replace(/^webcals?:\/\//i, 'https://');
  let parsed;
  try {
    parsed = new URL(fixed);
  } catch {
    return null;
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
}

class CalendarFeed {
  /**
   * @param {object} opts
   * @param {(url: string, init: object) => Promise<Response>} opts.fetch
   * @param {() => number} [opts.now]
   */
  constructor({ fetch, now = Date.now } = {}) {
    this.fetchImpl = fetch;
    this.now = now;
    this.url = null;
    this.events = [];
    this.updatedAt = null;
    this.error = null;
    this.loading = false;
    this.reminded = new Set();
  }

  setUrl(url) {
    const next = url ? normalizeUrl(url) : null;
    if (url && !next) throw new Error('invalid url');
    if (next !== this.url) {
      this.url = next;
      this.events = [];
      this.updatedAt = null;
      this.error = null;
    }
    return this.url;
  }

  async refresh() {
    if (!this.url || this.loading) return;
    this.loading = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20e3);
    try {
      const res = await this.fetchImpl(this.url, { signal: controller.signal, headers: { accept: 'text/calendar' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error('calendar too large');
      if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('not an iCal file');
      this.events = parseICS(text);
      this.updatedAt = this.now();
      this.error = null;
    } catch (err) {
      this.error = err.name === 'AbortError' ? 'timeout' : err.message;
    } finally {
      clearTimeout(timer);
      this.loading = false;
    }
  }

  upcoming(days = 7) {
    const now = this.now();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    return expandEvents(this.events, today.getTime(), now + days * DAY).filter(
      (o) => o.end > now || (o.allDay && o.end >= today.getTime()),
    );
  }

  /** Timed events starting within the next `minutes` that haven't been announced yet. */
  dueReminders(minutes) {
    const now = this.now();
    const horizon = now + minutes * 60e3;
    const due = expandEvents(this.events, now, horizon + 1).filter((o) => !o.allDay && o.start > now && o.start <= horizon);
    const fresh = due.filter((o) => !this.reminded.has(`${o.uid}@${o.start}`));
    for (const o of fresh) this.reminded.add(`${o.uid}@${o.start}`);
    return fresh;
  }

  snapshot() {
    return {
      configured: Boolean(this.url),
      events: this.url ? this.upcoming(7) : [],
      updatedAt: this.updatedAt,
      error: this.error,
      loading: this.loading,
    };
  }
}

module.exports = {
  parseICS,
  parseDateValue,
  parseRrule,
  parseIcsDuration,
  toEpoch,
  zoneOffset,
  occurrences,
  expandEvents,
  normalizeUrl,
  CalendarFeed,
};
