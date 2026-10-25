'use strict';

// A small Markdown renderer for Claude's replies: headings, lists, quotes, code, tables,
// bold / italic / strike / inline code and links. It builds DOM nodes (never innerHTML),
// so nothing in a reply can run in the pet.

(function (root) {
  const INLINE = [
    { kind: 'code', re: /`([^`\n]+)`/ },
    { kind: 'link', re: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/ },
    { kind: 'strong', re: /\*\*(?=\S)([\s\S]*?\S)\*\*/ },
    { kind: 'strong', re: /__(?=\S)([\s\S]*?\S)__/ },
    { kind: 'del', re: /~~(?=\S)([\s\S]*?\S)~~/ },
    { kind: 'em', re: /(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/ },
    { kind: 'em', re: /(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/ },
    { kind: 'url', re: /https?:\/\/[^\s<>()]+[^\s<>().,;:!?、。」）]/ },
  ];

  function inline(text, onLink) {
    const out = [];
    let rest = String(text);
    while (rest) {
      let best = null;
      for (const rule of INLINE) {
        const m = rule.re.exec(rest);
        if (m && (!best || m.index < best.m.index)) best = { rule, m };
      }
      if (!best) {
        out.push(document.createTextNode(rest));
        break;
      }
      const { rule, m } = best;
      if (m.index) out.push(document.createTextNode(rest.slice(0, m.index)));
      let node;
      if (rule.kind === 'code') {
        node = document.createElement('code');
        node.textContent = m[1];
      } else if (rule.kind === 'link' || rule.kind === 'url') {
        const href = rule.kind === 'link' ? m[2] : m[0];
        node = document.createElement('a');
        node.href = '#';
        node.title = href;
        node.addEventListener('click', (e) => {
          e.preventDefault();
          if (onLink) onLink(href);
        });
        if (rule.kind === 'link') node.append(...inline(m[1], onLink));
        else node.textContent = href;
      } else {
        node = document.createElement(rule.kind);
        node.append(...inline(m[1], onLink));
      }
      out.push(node);
      rest = rest.slice(m.index + m[0].length);
    }
    return out;
  }

  const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function cells(line) {
    return line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
  }

  /** A code block, with a copy button when the caller can copy. */
  function codeBlock(text, onCopy, labels = {}) {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = text;
    pre.appendChild(code);
    if (!onCopy) return pre;
    const wrap = document.createElement('div');
    wrap.className = 'md-code';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'md-code-copy';
    copy.textContent = labels.copy || 'Copy';
    copy.addEventListener('click', (e) => {
      e.stopPropagation();
      onCopy(text);
      copy.textContent = labels.copied || '✓';
      setTimeout(() => (copy.textContent = labels.copy || 'Copy'), 1200);
    });
    wrap.append(pre, copy);
    return wrap;
  }

  /** Render Markdown text into a container element (its children are replaced). */
  function render(container, source, { onLink, onCopy, labels } = {}) {
    container.replaceChildren();
    const lines = String(source || '')
      .replace(/\r\n?/g, '\n')
      .split('\n');
    const el = (tag, cls) => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      return node;
    };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // fenced code
      const fence = /^\s*(```|~~~)/.exec(line);
      if (fence) {
        const code = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
        i++;
        container.appendChild(codeBlock(code.join('\n'), onCopy, labels));
        continue;
      }
      if (!line.trim()) {
        i++;
        continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        const h = el('div', `md-h md-h${heading[1].length}`);
        h.append(...inline(heading[2], onLink));
        container.appendChild(h);
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        container.appendChild(el('hr'));
        i++;
        continue;
      }
      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
        const q = el('blockquote');
        render(q, quote.join('\n'), { onLink, onCopy, labels });
        container.appendChild(q);
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
        const table = el('table');
        const head = el('tr');
        for (const c of cells(line)) {
          const th = el('th');
          th.append(...inline(c, onLink));
          head.appendChild(th);
        }
        table.appendChild(head);
        i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          const tr = el('tr');
          for (const c of cells(lines[i++])) {
            const td = el('td');
            td.append(...inline(c, onLink));
            tr.appendChild(td);
          }
          table.appendChild(tr);
        }
        const wrap = el('div', 'md-table');
        wrap.appendChild(table);
        container.appendChild(wrap);
        continue;
      }
      if (LIST_ITEM.test(line)) {
        // nested by indentation: a stack of open lists
        const stack = [];
        while (i < lines.length && (LIST_ITEM.test(lines[i]) || (/^\s+\S/.test(lines[i]) && stack.length))) {
          const m = LIST_ITEM.exec(lines[i]);
          if (!m) {
            // a continuation line of the previous item
            const last = stack[stack.length - 1].list.lastElementChild;
            last.append(document.createElement('br'), ...inline(lines[i].trim(), onLink));
            i++;
            continue;
          }
          const indent = m[1].replace(/\t/g, '  ').length;
          const ordered = /\d/.test(m[2]);
          while (stack.length && indent < stack[stack.length - 1].indent) stack.pop();
          let top = stack[stack.length - 1];
          if (!top || indent > top.indent) {
            const list = el(ordered ? 'ol' : 'ul');
            if (ordered) list.start = parseInt(m[2], 10) || 1;
            if (top) top.list.lastElementChild.appendChild(list);
            else container.appendChild(list);
            top = { indent, list };
            stack.push(top);
          }
          const li = el('li');
          const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
          if (task) li.append(task[1] === ' ' ? '☐ ' : '☑ ', ...inline(task[2], onLink));
          else li.append(...inline(m[3], onLink));
          top.list.appendChild(li);
          i++;
        }
        continue;
      }
      // paragraph: consecutive plain lines, kept as line breaks
      const p = el('p');
      let first = true;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\s*(```|~~~|#{1,6}\s|>)/.test(lines[i]) &&
        !LIST_ITEM.test(lines[i]) &&
        !(lines[i].includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]))
      ) {
        if (!first) p.appendChild(document.createElement('br'));
        p.append(...inline(lines[i], onLink));
        first = false;
        i++;
      }
      container.appendChild(p);
    }
    return container;
  }

  root.PetMarkdown = { render };
})(typeof window !== 'undefined' ? window : globalThis);
