'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseICS, expandEvents, normalizeUrl, CalendarFeed, toEpoch, parseDateValue } = require('../src/core/calendar');

function ics(...events) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR'].join(
    '\r\n',
  );
}

const OCT = (d, h = 0, m = 0) => Date.UTC(2026, 9, d, h, m);
const WINDOW = [Date.UTC(2026, 9, 1), Date.UTC(2027, 0, 1)];

function starts(text, from = WINDOW[0], to = WINDOW[1]) {
  return expandEvents(parseICS(text), from, to).map((o) => o.start);
}

test('time zones: TZID, UTC and DST changes', () => {
  assert.equal(toEpoch(parseDateValue('20261026T100000', { TZID: 'Asia/Tokyo' })), OCT(26, 1));
  assert.equal(toEpoch(parseDateValue('20261026T100000Z')), OCT(26, 10));
  // New York leaves daylight saving time on 1 Nov 2026: 9:00 is 13:00Z before and 14:00Z after.
  const weekly = ics([
    'UID:ny',
    'DTSTART;TZID=America/New_York:20261026T090000',
    'DTEND;TZID=America/New_York:20261026T093000',
    'RRULE:FREQ=WEEKLY;COUNT=2',
    'SUMMARY:Standup',
  ]);
  assert.deepEqual(starts(weekly), [OCT(26, 13), Date.UTC(2026, 10, 2, 14)]);
});

test('weekly BYDAY with COUNT, monthly nth weekday, UNTIL', () => {
  const mwf = ics(['UID:a', 'DTSTART:20261026T010000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=4']);
  assert.deepEqual(starts(mwf), [OCT(26, 1), OCT(28, 1), OCT(30, 1), Date.UTC(2026, 10, 2, 1)]);

  const secondTuesday = ics(['UID:b', 'DTSTART:20261013T010000Z', 'RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3']);
  assert.deepEqual(starts(secondTuesday), [OCT(13, 1), Date.UTC(2026, 10, 10, 1), Date.UTC(2026, 11, 8, 1)]);

  const lastFriday = ics(['UID:c', 'DTSTART:20261030T010000Z', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20261231T000000Z']);
  assert.deepEqual(starts(lastFriday), [OCT(30, 1), Date.UTC(2026, 10, 27, 1), Date.UTC(2026, 11, 25, 1)]);

  const daily = ics(['UID:d', 'DTSTART:20261029T010000Z', 'RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261104T000000Z']);
  assert.deepEqual(starts(daily), [OCT(29, 1), OCT(31, 1), Date.UTC(2026, 10, 2, 1)]);
});

test('EXDATE removes and RECURRENCE-ID moves an occurrence', () => {
  const text = ics(
    ['UID:r', 'DTSTART:20261026T010000Z', 'RRULE:FREQ=DAILY;COUNT=4', 'EXDATE:20261027T010000Z', 'SUMMARY:Daily'],
    ['UID:r', 'RECURRENCE-ID:20261028T010000Z', 'DTSTART:20261028T050000Z', 'SUMMARY:Daily (moved)'],
  );
  const list = expandEvents(parseICS(text), ...WINDOW);
  assert.deepEqual(
    list.map((o) => [o.start, o.summary]),
    [
      [OCT(26, 1), 'Daily'],
      [OCT(28, 5), 'Daily (moved)'],
      [OCT(29, 1), 'Daily'],
    ],
  );
});

test('old daily events still reach today, all-day and cancelled events', () => {
  const old = ics(['UID:o', 'DTSTART:20100101T010000Z', 'RRULE:FREQ=DAILY']);
  assert.deepEqual(starts(old, OCT(25), OCT(27)), [OCT(25, 1), OCT(26, 1)]);

  const allDay = ics(
    ['UID:h', 'DTSTART;VALUE=DATE:20261103', 'DTEND;VALUE=DATE:20261104', 'SUMMARY:Holiday'],
    ['UID:x', 'DTSTART:20261026T010000Z', 'STATUS:CANCELLED'],
  );
  const list = expandEvents(parseICS(allDay), ...WINDOW);
  assert.equal(list.length, 1);
  assert.equal(list[0].allDay, true);
  assert.equal(list[0].start, new Date(2026, 10, 3).getTime());
});

test('folded lines, escaped text and alarms', () => {
  const text = ics([
    'UID:f',
    'DTSTART:20261026T010000Z',
    'SUMMARY:Design review\\, part 2',
    ' (long title)',
    'LOCATION:Room A\\nFloor 3',
    'BEGIN:VALARM',
    'SUMMARY:alarm text',
    'END:VALARM',
  ]);
  const [event] = parseICS(text);
  assert.equal(event.summary, 'Design review, part 2(long title)');
  assert.equal(event.location, 'Room A\nFloor 3');
});

test('only http(s) and webcal URLs are accepted', () => {
  assert.equal(normalizeUrl('webcal://example.com/cal.ics'), 'https://example.com/cal.ics');
  assert.equal(
    normalizeUrl('https://calendar.google.com/calendar/ical/x/basic.ics'),
    'https://calendar.google.com/calendar/ical/x/basic.ics',
  );
  assert.equal(normalizeUrl('file:///etc/passwd'), null);
  assert.equal(normalizeUrl('not a url'), null);
});

test('feed refreshes, lists upcoming events and reminds once', async () => {
  let now = OCT(26, 0, 50);
  const body = ics(['UID:m', 'DTSTART:20261026T010000Z', 'DTEND:20261026T013000Z', 'SUMMARY:Meeting']);
  const feed = new CalendarFeed({ now: () => now, fetch: async () => ({ ok: true, status: 200, text: async () => body }) });
  feed.setUrl('https://example.com/a.ics');
  await feed.refresh();
  assert.equal(feed.snapshot().error, null);
  assert.equal(feed.snapshot().events[0].summary, 'Meeting');

  assert.equal(feed.dueReminders(5).length, 0); // 10 minutes away
  now = OCT(26, 0, 56);
  assert.equal(feed.dueReminders(5).length, 1);
  assert.equal(feed.dueReminders(5).length, 0);

  const broken = new CalendarFeed({ fetch: async () => ({ ok: false, status: 404, text: async () => '' }) });
  broken.setUrl('https://example.com/missing.ics');
  await broken.refresh();
  assert.equal(broken.snapshot().error, 'HTTP 404');
  assert.throws(() => broken.setUrl('ftp://example.com'));
});
