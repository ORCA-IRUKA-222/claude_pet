// A small Markdown parser for Claude's replies (headings, lists, code, quotes,
// tables, emphasis, links). It returns a plain tree; the renderer builds DOM
// nodes from it, so no HTML string is ever injected. Usable from Node and the renderer.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetMarkdown = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
  const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
  const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE = /^ {0,3}>\s?(.*)$/;
  const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;
  const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

  function indentOf(line) {
    return line.match(/^ */)[0].length;
  }

  function isTableStart(lines, i) {
    return i + 1 < lines.length && lines[i].includes('|') && lines[i + 1].includes('|') && TABLE_DELIMITER.test(lines[i + 1]);
  }

  function startsBlock(lines, i) {
    const line = lines[i];
    return (
      FENCE.test(line) ||
      HEADING.test(line) ||
      HR.test(line) ||
      QUOTE.test(line) ||
      LIST_ITEM.test(line) ||
      isTableStart(lines, i)
    );
  }

  function splitRow(line) {
    let text = line.trim();
    if (text.startsWith('|')) text = text.slice(1);
    if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
    return text.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
  }

  function parseList(lines, start) {
    const first = lines[start].match(LIST_ITEM);
    const baseIndent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const list = { type: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items: [] };
    let i = start;

    while (i < lines.length) {
      const m = lines[i].match(LIST_ITEM);
      if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;
      const contentIndent = baseIndent + m[2].length + 1;
      const body = [m[3] || ''];
      i += 1;
      while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
          let next = i + 1;
          while (next < lines.length && !lines[next].trim()) next += 1;
          if (next < lines.length && indentOf(lines[next]) >= contentIndent) {
            body.push('');
            i += 1;
            continue;
          }
          break;
        }
        if (indentOf(line) >= contentIndent) {
          body.push(line.slice(contentIndent));
        } else if (indentOf(line) > baseIndent) {
          body.push(line.trimStart());
        } else if (!startsBlock(lines, i) && body[body.length - 1].trim()) {
          body.push(line.trim()); // lazy continuation of the item's paragraph
        } else {
          break;
        }
        i += 1;
      }
      let checked = null;
      const task = body[0].match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        checked = task[1] !== ' ';
        body[0] = task[2];
      }
      list.items.push({ checked, blocks: parseBlocks(body) });
      // A blank line between items keeps the same list going.
      let next = i;
      while (next < lines.length && !lines[next].trim()) next += 1;
      const following = next < lines.length && lines[next].match(LIST_ITEM);
      if (next !== i && following && following[1].length === baseIndent && /\d/.test(following[2]) === ordered) i = next;
    }
    return { block: list, next: i };
  }

  function parseBlocks(lines) {
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }

      const fence = line.match(FENCE);
      if (fence) {
        const indent = fence[1].length;
        const marker = fence[2];
        const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
        const body = [];
        i += 1;
        while (i < lines.length && !close.test(lines[i])) {
          body.push(lines[i].slice(Math.min(indent, indentOf(lines[i]))));
          i += 1;
        }
        i += 1; // closing fence (or end of text)
        blocks.push({ type: 'code', lang: fence[3] || '', text: body.join('\n') });
        continue;
      }

      const heading = line.match(HEADING);
      if (heading) {
        blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2] || '') });
        i += 1;
        continue;
      }

      if (HR.test(line)) {
        blocks.push({ type: 'hr' });
        i += 1;
        continue;
      }

      if (QUOTE.test(line)) {
        const body = [];
        while (i < lines.length && QUOTE.test(lines[i])) {
          body.push(lines[i].match(QUOTE)[1]);
          i += 1;
        }
        blocks.push({ type: 'quote', blocks: parseBlocks(body) });
        continue;
      }

      if (LIST_ITEM.test(line)) {
        const { block, next } = parseList(lines, i);
        blocks.push(block);
        i = next;
        continue;
      }

      if (isTableStart(lines, i)) {
        const header = splitRow(line);
        const align = splitRow(lines[i + 1]).map((cell) =>
          cell.startsWith(':') && cell.endsWith(':')
            ? 'center'
            : cell.endsWith(':')
              ? 'right'
              : cell.startsWith(':')
                ? 'left'
                : null,
        );
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          rows.push(splitRow(lines[i]).map(parseInline));
          i += 1;
        }
        blocks.push({ type: 'table', align, header: header.map(parseInline), rows });
        continue;
      }

      const para = [line.trim()];
      i += 1;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
        para.push(lines[i].trim());
        i += 1;
      }
      blocks.push({ type: 'paragraph', children: parseInline(para.join('\n')) });
    }
    return blocks;
  }

  // ---------------------------------------------------------------- inline

  const ESCAPABLE = /[!-/:-@[-`{-~]/;
  const BARE_URL = /^https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"、。」）]/;

  function isWordChar(ch) {
    return Boolean(ch) && /[\p{L}\p{N}]/u.test(ch);
  }

  /** Find a closing delimiter that follows non-space text. */
  function findClose(text, delim, from) {
    let at = text.indexOf(delim, from);
    while (at >= 0) {
      if (at > from && !/\s/.test(text[at - 1]) && text[at - 1] !== '\\') {
        if (delim[0] !== '_' || !isWordChar(text[at + delim.length])) return at;
      }
      at = text.indexOf(delim, at + 1);
    }
    return -1;
  }

  function parseInline(text) {
    const out = [];
    let buffer = '';
    const flush = () => {
      if (buffer) out.push({ type: 'text', text: buffer });
      buffer = '';
    };
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      const rest = text.slice(i);

      if (ch === '\\' && ESCAPABLE.test(text[i + 1] || '')) {
        buffer += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '\n') {
        flush();
        out.push({ type: 'br' });
        i += 1;
        continue;
      }
      if (ch === '`') {
        const ticks = rest.match(/^`+/)[0];
        const end = text.indexOf(ticks, i + ticks.length);
        if (end > 0) {
          flush();
          let code = text.slice(i + ticks.length, end).replace(/\n/g, ' ');
          if (/^ .* $/.test(code)) code = code.slice(1, -1);
          out.push({ type: 'code', text: code });
          i = end + ticks.length;
          continue;
        }
        buffer += ticks;
        i += ticks.length;
        continue;
      }
      if (ch === '[') {
        const link = rest.match(
          /^\[((?:[^\][]|\[[^\]]*\])*)\]\(\s*<?([^\s<>()]*(?:\([^\s()]*\)[^\s<>()]*)*)>?(?:\s+"[^"]*")?\s*\)/,
        );
        if (link) {
          flush();
          out.push({ type: 'link', href: link[2], children: parseInline(link[1]) });
          i += link[0].length;
          continue;
        }
      }
      if (ch === '<') {
        const auto = rest.match(/^<(https?:\/\/[^\s<>]+)>/);
        if (auto) {
          flush();
          out.push({ type: 'link', href: auto[1], children: [{ type: 'text', text: auto[1] }] });
          i += auto[0].length;
          continue;
        }
      }
      if (ch === 'h' && !isWordChar(text[i - 1])) {
        const url = rest.match(BARE_URL);
        if (url) {
          flush();
          out.push({ type: 'link', href: url[0], children: [{ type: 'text', text: url[0] }] });
          i += url[0].length;
          continue;
        }
      }
      if (ch === '*' || ch === '_' || ch === '~') {
        const run = rest.match(/^(\*+|_+|~+)/)[0];
        const intraword = ch === '_' && isWordChar(text[i - 1]);
        const candidates = ch === '~' ? (run.length >= 2 ? ['~~'] : []) : run.length >= 2 ? [ch + ch, ch] : [ch];
        let matched = false;
        for (const delim of intraword ? [] : candidates) {
          const start = i + delim.length;
          if (!text[start] || /\s/.test(text[start])) continue;
          const end = findClose(text, delim, start);
          if (end < 0) continue;
          flush();
          const type = delim[0] === '~' ? 'del' : delim.length === 2 ? 'strong' : 'em';
          out.push({ type, children: parseInline(text.slice(start, end)) });
          i = end + delim.length;
          matched = true;
          break;
        }
        if (matched) continue;
        buffer += run;
        i += run.length;
        continue;
      }
      buffer += ch;
      i += 1;
    }
    flush();
    return out;
  }

  function parse(text) {
    return parseBlocks(
      String(text || '')
        .replace(/\r\n?/g, '\n')
        .replace(/\t/g, '    ')
        .split('\n'),
    );
  }

  return { parse, parseInline };
});
