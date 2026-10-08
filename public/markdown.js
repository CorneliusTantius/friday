function safeMarkdownHref(destination) {
  const value = destination.replace(/\\([()<>\\ ])/g, '$1');
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^(https?:|mailto:)/i.test(value)) return null;
  try {
    const url = new URL(value, window.location.href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function markdownLinkAt(source, start) {
  if (source[start] !== '[') return null;
  const labelEnd = source.indexOf('](', start + 1);
  if (labelEnd < 0 || source.slice(start, labelEnd).includes('\n')) return null;

  let depth = 1;
  let escaped = false;
  for (let index = labelEnd + 2; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === '\n') return null;
    if (character === '(') depth += 1;
    if (character === ')' && --depth === 0) {
      const raw = source.slice(labelEnd + 2, index).trim();
      const match = raw.match(/^(<[^>]+>|(?:\\.|[^\s])+?)(?:\s+(?:"[^"]*"|'[^']*'))?$/);
      if (!match) return null;
      const destination = match[1].startsWith('<') ? match[1].slice(1, -1) : match[1];
      return { label: source.slice(start + 1, labelEnd), destination, end: index + 1 };
    }
  }
  return null;
}

function appendPlainTextWithLinks(parent, source) {
  const pattern = /https?:\/\/[^\s<>]+/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    let url = match[0];
    while (/[.,!?;:]$/.test(url)) url = url.slice(0, -1);
    while (url.endsWith(')') && (url.match(/\)/g)?.length || 0) > (url.match(/\(/g)?.length || 0)) {
      url = url.slice(0, -1);
    }
    if (!url) continue;
    const start = match.index;
    parent.append(document.createTextNode(source.slice(cursor, start)));
    const link = document.createElement('a');
    link.href = url; link.target = '_blank'; link.rel = 'noreferrer noopener'; link.textContent = url;
    parent.append(link);
    cursor = start + url.length;
  }
  parent.append(document.createTextNode(source.slice(cursor)));
}

function appendInlineMarkdown(parent, source) {
  const formatting = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;
  const lineBreaks = /<br\s*\/?\s*>/gi;
  let cursor = 0;
  while (cursor < source.length) {
    formatting.lastIndex = cursor;
    lineBreaks.lastIndex = cursor;
    const formatted = formatting.exec(source);
    const lineBreak = lineBreaks.exec(source);
    let link = null;
    let linkIndex = -1;
    for (let index = source.indexOf('[', cursor); index >= 0; index = source.indexOf('[', index + 1)) {
      link = markdownLinkAt(source, index);
      if (link) { linkIndex = index; break; }
    }
    const formatIndex = formatted?.index ?? Infinity;
    const breakIndex = lineBreak?.index ?? Infinity;
    if (!link) linkIndex = Infinity;
    if (!formatted && !link && !lineBreak) {
      appendPlainTextWithLinks(parent, source.slice(cursor));
      break;
    }

    const tokenIndex = Math.min(formatIndex, linkIndex, breakIndex);
    appendPlainTextWithLinks(parent, source.slice(cursor, tokenIndex));
    if (lineBreak && breakIndex <= formatIndex && breakIndex <= linkIndex) {
      parent.append(document.createElement('br'));
      cursor = breakIndex + lineBreak[0].length;
      continue;
    }
    if (link && linkIndex <= formatIndex) {
      const href = safeMarkdownHref(link.destination);
      if (href) {
        const anchor = document.createElement('a');
        anchor.href = href; anchor.target = '_blank'; anchor.rel = 'noreferrer noopener'; appendInlineMarkdown(anchor, link.label);
        parent.append(anchor);
      } else {
        parent.append(document.createTextNode(source.slice(linkIndex, link.end)));
      }
      cursor = link.end;
      continue;
    }

    const token = formatted[0];
    if (token.startsWith('`')) {
      const code = document.createElement('code'); code.textContent = token.slice(1, -1); parent.append(code);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      const strong = document.createElement('strong'); appendInlineMarkdown(strong, token.slice(2, -2)); parent.append(strong);
    } else {
      const emphasis = document.createElement('em'); appendInlineMarkdown(emphasis, token.slice(1, -1)); parent.append(emphasis);
    }
    cursor = formatted.index + token.length;
  }
}

function splitTableRow(line) {
  let source = line.trim();
  if (source.startsWith('|')) source = source.slice(1);
  if (source.endsWith('|') && !source.endsWith('\\|')) source = source.slice(0, -1);
  const cells = [];
  let cell = '';
  let inCode = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\' && source[index + 1] === '|') {
      cell += '|'; index += 1;
    } else if (character === '`') {
      inCode = !inCode; cell += character;
    } else if (character === '|' && !inCode) {
      cells.push(cell.trim()); cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function tableAlignments(line) {
  if (!line.includes('|')) return null;
  const cells = splitTableRow(line);
  if (cells.length < 2) return null;
  const alignments = cells.map((cell) => {
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
    if (cell.endsWith(':')) return 'right';
    return 'left';
  });
  return alignments.every(Boolean) ? alignments : null;
}

function renderMarkdownTable(parent, headers, alignments, rows) {
  const wrapper = document.createElement('div'); wrapper.className = 'table-wrap';
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  headers.forEach((value, index) => {
    const cell = document.createElement('th'); cell.style.textAlign = alignments[index]; appendInlineMarkdown(cell, value); headerRow.append(cell);
  });
  head.append(headerRow); table.append(head);
  const body = document.createElement('tbody');
  for (const values of rows) {
    const row = document.createElement('tr');
    headers.forEach((_, index) => {
      const cell = document.createElement('td'); cell.style.textAlign = alignments[index]; appendInlineMarkdown(cell, values[index] || ''); row.append(cell);
    });
    body.append(row);
  }
  table.append(body); wrapper.append(table); parent.append(wrapper);
}

export function renderMarkdown(parent, source, appendHighlightedCode) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  let paragraph = [];
  let list = null;
  let code = null;
  let codeLanguage = '';
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const element = document.createElement('p');
    paragraph.forEach((line, index) => { if (index) element.append(document.createElement('br')); appendInlineMarkdown(element, line); });
    parent.append(element); paragraph = [];
  };
  const flushList = () => { if (list) parent.append(list.element); list = null; };
  const flushCode = () => { const pre = document.createElement('pre'); appendHighlightedCode(pre, code.join('\n'), codeLanguage); parent.append(pre); code = null; codeLanguage = ''; };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (code) { if (line.trim() === '```') flushCode(); else code.push(line); continue; }
    if (line.trim().startsWith('```')) { flushParagraph(); flushList(); codeLanguage = line.trim().slice(3).trim().split(/\s+/, 1)[0].toLowerCase(); code = []; continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }

    const alignments = index + 1 < lines.length ? tableAlignments(lines[index + 1]) : null;
    if (line.includes('|') && alignments) {
      const headers = splitTableRow(line);
      if (headers.length === alignments.length) {
        flushParagraph(); flushList();
        const rows = [];
        let rowIndex = index + 2;
        while (rowIndex < lines.length && lines[rowIndex].trim() && lines[rowIndex].includes('|')) {
          rows.push(splitTableRow(lines[rowIndex])); rowIndex += 1;
        }
        renderMarkdownTable(parent, headers, alignments, rows);
        index = rowIndex - 1;
        continue;
      }
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph(); flushList();
      const element = document.createElement(`h${heading[1].length}`); appendInlineMarkdown(element, heading[2]); parent.append(element); continue;
    }
    const taskItem = line.match(/^\s*(?:[-*+]\s+|\d+\.\s+)\[([ xX])\]\s*(.*)$/);
    const listItem = taskItem || line.match(/^\s*(?:[-*+]\s+|\d+\.\s+)(.+)$/);
    if (listItem) {
      flushParagraph();
      const ordered = /^\s*\d+\./.test(line);
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, element: document.createElement(ordered ? 'ol' : 'ul') }; }
      const item = document.createElement('li');
      if (taskItem) {
        list.element.classList.add('contains-task-list');
        item.classList.add('task-list-item');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.checked = taskItem[1].toLowerCase() === 'x'; checkbox.disabled = true;
        checkbox.setAttribute('aria-label', checkbox.checked ? 'Completed task' : 'Incomplete task');
        item.append(checkbox, document.createTextNode(' '));
        appendInlineMarkdown(item, taskItem[2]);
      } else appendInlineMarkdown(item, listItem[1]);
      list.element.append(item); continue;
    }
    if (line.startsWith('>')) {
      flushParagraph(); flushList();
      const quote = document.createElement('blockquote'); appendInlineMarkdown(quote, line.replace(/^>\s?/, '')); parent.append(quote); continue;
    }
    paragraph.push(line);
  }
  if (code) flushCode();
  flushParagraph(); flushList();
}
