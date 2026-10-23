#!/usr/bin/env node
'use strict';

// Render the app/tray icon (assets/tray.png) from Mochi's first idle frame.

const fs = require('fs');
const path = require('path');
const { Canvas } = require('./raster');
const { encodePNG } = require('../src/shared/png');
const mochi = require('./designs/mochi');

const frame = new Canvas(mochi.size.width, mochi.size.height);
mochi.draw(frame, { state: 'idle', frame: 0, frames: 6, t: 0 });
frame.outline(mochi.outline);

let minX = frame.width;
let minY = frame.height;
let maxX = 0;
let maxY = 0;
for (let y = 0; y < frame.height; y++) {
  for (let x = 0; x < frame.width; x++) {
    if (!frame.alpha(x, y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
}

const side = Math.max(maxX - minX, maxY - minY) + 3;
const square = new Canvas(side, side);
const cropped = new Canvas(maxX - minX + 1, maxY - minY + 1);
for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) cropped.set(x - minX, y - minY, frame.get(x, y));
square.draw(cropped, Math.floor((side - cropped.width) / 2), Math.floor((side - cropped.height) / 2));

const icon = square.scale(4);
const out = path.join(__dirname, '..', 'assets', 'tray.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePNG(icon.width, icon.height, icon.data));
console.log(`${out} (${icon.width}x${icon.height})`);
