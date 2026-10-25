'use strict';

/* global PetMarkdown */

// Builds DOM nodes from PetMarkdown's tree. Text always goes in as text nodes,
// so nothing in Claude's reply can inject HTML. Links open in the browser
// through the main process (http/https only).
const PetMarkdownView = (() => {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function inline(nodes, parent, opts) {
    for (const n of nodes) {
      switch (n.type) {
        case 'text':
          parent.appendChild(document.createTextNode(n.text));
          break;
        case 'br':
          parent.appendChild(document.createElement('br'));
          break;
        case 'code':
          parent.appendChild(el('code', null, n.text));
          break;
        case 'strong':
        case 'em':
        case 'del': {
          const node = el(n.type === 'strong' ? 'strong' : n.type === 'em' ? 'em' : 'del');
          inline(n.children, node, opts);
          parent.appendChild(node);
          break;
        }
        case 'link': {
          const safe = /^https?:\/\//i.test(n.href);
          const node = el(safe ? 'a' : 'span', safe ? 'md-link' : null);
          if (safe) {
            node.href = n.href;
            node.title = n.href;
            node.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              if (opts.onLink) opts.onLink(n.href);
            });
          }
          inline(n.children, node, opts);
          parent.appendChild(node);
          break;
        }
        default:
          break;
      }
    }
  }

  function codeBlock(block, opts) {
    const wrap = el('div', 'md-code');
    const head = el('div', 'md-code-head');
    head.appendChild(el('span', 'md-code-lang', block.lang || ''));
    const copy = el('button', 'md-code-copy', opts.copyLabel || 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', (e) => {
      e.stopPropagation();
      if (opts.onCopy) opts.onCopy(block.text);
      copy.textContent = opts.copiedLabel || '✓';
      setTimeout(() => (copy.textContent = opts.copyLabel || 'Copy'), 1200);
    });
    head.appendChild(copy);
    wrap.appendChild(head);
    const pre = el('pre');
    pre.appendChild(el('code', null, block.text));
    wrap.appendChild(pre);
    return wrap;
  }

  function blocks(list, parent, opts) {
    for (const b of list) {
      switch (b.type) {
        case 'heading': {
          const node = el(`h${Math.min(6, b.level)}`, 'md-h');
          inline(b.children, node, opts);
          parent.appendChild(node);
          break;
        }
        case 'paragraph': {
          const node = el('p');
          inline(b.children, node, opts);
          parent.appendChild(node);
          break;
        }
        case 'code':
          parent.appendChild(codeBlock(b, opts));
          break;
        case 'quote': {
          const node = el('blockquote');
          blocks(b.blocks, node, opts);
          parent.appendChild(node);
          break;
        }
        case 'hr':
          parent.appendChild(el('hr'));
          break;
        case 'list': {
          const node = el(b.ordered ? 'ol' : 'ul');
          if (b.ordered && b.start !== 1) node.start = b.start;
          for (const item of b.items) {
            const li = el('li');
            if (item.checked !== null) {
              li.className = 'md-task';
              li.appendChild(el('span', `md-check${item.checked ? ' done' : ''}`, item.checked ? '✓' : ''));
            }
            blocks(item.blocks, li, opts);
            node.appendChild(li);
          }
          parent.appendChild(node);
          break;
        }
        case 'table': {
          const scroll = el('div', 'md-table');
          const table = el('table');
          const head = el('tr');
          b.header.forEach((cell, i) => {
            const th = el('th');
            if (b.align[i]) th.style.textAlign = b.align[i];
            inline(cell, th, opts);
            head.appendChild(th);
          });
          table.appendChild(el('thead')).appendChild(head);
          const body = el('tbody');
          for (const row of b.rows) {
            const tr = el('tr');
            b.header.forEach((_, i) => {
              const td = el('td');
              if (b.align[i]) td.style.textAlign = b.align[i];
              inline(row[i] || [], td, opts);
              tr.appendChild(td);
            });
            body.appendChild(tr);
          }
          table.appendChild(body);
          scroll.appendChild(table);
          parent.appendChild(scroll);
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * @param {string} text Markdown
   * @param {{onLink?: Function, onCopy?: Function, copyLabel?: string, copiedLabel?: string}} opts
   */
  function render(text, opts = {}) {
    const root = el('div', 'md');
    blocks(PetMarkdown.parse(text), root, opts);
    return root;
  }

  return { render };
})();

window.PetMarkdownView = PetMarkdownView;
