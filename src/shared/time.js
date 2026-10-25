// Duration parsing and formatting. Usable from Node and from the renderer.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetTime = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const MAX = 24 * HOUR;

  const UNITS = [
    [/^(h|hr|hrs|hour|hours|時間)$/, HOUR],
    [/^(m|min|mins|minute|minutes|分)$/, MINUTE],
    [/^(s|sec|secs|second|seconds|秒)$/, SECOND],
  ];

  /**
   * "25" (minutes), "10m", "90s", "1h30m", "1時間30分", "5:00", "1:05:00" → milliseconds.
   * Returns null for anything else, zero, or more than a day.
   */
  function parseDuration(input) {
    const text = String(input == null ? '' : input)
      .trim()
      .toLowerCase()
      .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
      .replace(/：/g, ':');
    if (!text) return null;
    let ms = null;
    if (/^\d+(\.\d+)?$/.test(text)) {
      ms = parseFloat(text) * MINUTE;
    } else if (/^\d+(:\d{1,2}){1,2}$/.test(text)) {
      const parts = text.split(':').map(Number);
      if (parts.slice(1).some((n) => n >= 60)) return null;
      const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
      ms = h * HOUR + m * MINUTE + s * SECOND;
    } else {
      const re = /(\d+(?:\.\d+)?)\s*([a-z]+|時間|分|秒)/g;
      let consumed = '';
      let total = 0;
      let match;
      while ((match = re.exec(text))) {
        const unit = UNITS.find(([pattern]) => pattern.test(match[2]));
        if (!unit) return null;
        total += parseFloat(match[1]) * unit[1];
        consumed += match[0];
      }
      if (consumed.replace(/\s/g, '') !== text.replace(/\s/g, '')) return null;
      ms = total;
    }
    ms = Math.round(ms);
    return ms > 0 && ms <= MAX ? ms : null;
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  /** 272000 → "4:32", 3723000 → "1:02:03". */
  function formatClock(ms) {
    const total = Math.max(0, Math.floor(ms / SECOND));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  /** A short human duration: "45秒", "12分", "1時間5分" / "45s", "12 min", "1 h 5 min". */
  function formatSpan(ms, language = 'ja') {
    const total = Math.max(0, Math.round(ms / SECOND));
    const ja = language !== 'en';
    if (total < 60) return ja ? `${total}秒` : `${total}s`;
    const minutes = Math.round(total / 60);
    if (minutes < 60) return ja ? `${minutes}分` : `${minutes} min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (ja) return m ? `${h}時間${m}分` : `${h}時間`;
    return m ? `${h} h ${m} min` : `${h} h`;
  }

  return { SECOND, MINUTE, HOUR, parseDuration, formatClock, formatSpan };
});
