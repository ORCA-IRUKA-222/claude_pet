// Codex/ChatGPT-compatible pet atlas layout: 8 columns x 9 rows of 192x208 cells.
// Loaded both from Node (require) and from the renderer (<script>), hence the wrapper.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetAtlas = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CELL_WIDTH = 192;
  const CELL_HEIGHT = 208;
  const COLUMNS = 8;

  function durations(count, each, last) {
    const list = new Array(count).fill(each);
    list[count - 1] = last;
    return list;
  }

  const ROWS = [
    { state: 'idle', frames: 6, durations: [280, 110, 110, 140, 140, 320] },
    { state: 'running-right', frames: 8, durations: durations(8, 120, 220) },
    { state: 'running-left', frames: 8, durations: durations(8, 120, 220) },
    { state: 'waving', frames: 4, durations: durations(4, 140, 280) },
    { state: 'jumping', frames: 5, durations: durations(5, 140, 280) },
    { state: 'failed', frames: 8, durations: durations(8, 140, 240) },
    { state: 'waiting', frames: 6, durations: durations(6, 150, 260) },
    { state: 'running', frames: 6, durations: durations(6, 120, 220) },
    { state: 'review', frames: 6, durations: durations(6, 150, 280) },
  ];

  const ROW_INDEX = {};
  ROWS.forEach((row, index) => {
    row.index = index;
    ROW_INDEX[row.state] = row;
  });

  return {
    CELL_WIDTH,
    CELL_HEIGHT,
    COLUMNS,
    ROWS,
    ROW_INDEX,
    SHEET_WIDTH: CELL_WIDTH * COLUMNS,
    SHEET_HEIGHT: CELL_HEIGHT * ROWS.length,
  };
});
