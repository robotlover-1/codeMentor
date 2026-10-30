/**
 * Heuristic, dependency-free source parsing.
 *
 * This is deliberately not an AST: it works on comment/string-masked text and
 * records a `confidence` marker on everything it produces. The scanner uses it
 * to build a navigable symbol map, never to claim semantic certainty.
 */

import {
  CONTROL_KEYWORDS,
  NOT_CALLABLE,
  countLines,
  lineStarts,
  maskSource,
  matchBrace,
  offsetToLine,
  oneLine,
  splitLines,
  toPosix,
  truncate,
} from './core.js';

const MAX_CALLS_PER_SYMBOL = 60;
const MAX_SYMBOLS_PER_FILE = 400;

/* -------------------------------------------------------------------- header */

function cleanFunctionHeader(header) {
  return header
    .replace(/^[ \t]*#[^\n]*$/gm, ' ')
    .replace(/@\w+(?:\s*\([^)]*\))?/g, ' ')
    .replace(/\b(?:__attribute__|__declspec|alignas|noexcept|override|final|constexpr)\s*(?:\([^)]*\))?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseBraceFunctionHeader(header) {
  const cleaned = cleanFunctionHeader(header);
  if (!cleaned || cleaned.length > 2400) return null;
  if (cleaned.includes('=')) return null;
  const match = /([A-Za-z_]\w*)\s*\(([^()]*)\)$/.exec(cleaned);
  if (!match) return null;
  const name = match[1];
  if (CONTROL_KEYWORDS.has(name) || NOT_CALLABLE.has(name)) return null;
  const prefix = cleaned.slice(0, match.index).trim();
  if (prefix.includes('(') || prefix.includes(')')) return null;
  if (/[.\->]$/.test(prefix)) return null;
  if (/\b(?:typedef|struct|union|enum|class|interface)\s*$/.test(prefix)) return null;
  const modifiers = [];
  for (const keyword of ['static', 'inline', 'extern', 'public', 'private', 'protected', 'async', 'final', 'abstract', 'virtual']) {
    if (new RegExp(`\\b${keyword}\\b`).test(prefix)) modifiers.push(keyword);
  }
  return {
    name,
    returnType: prefix,
    signature: truncate(cleaned, 300),
    modifiers,
    isStatic: modifiers.includes('static'),
    nameIndex: cleaned.lastIndexOf(name),
  };
}

/* --------------------------------------------------------------------- calls */

export function extractCalls(masked, start, end, selfName, starts) {
  const calls = [];
  const seen = new Set();
  const slice = masked.slice(start, end);
  const pattern = /\b([A-Za-z_]\w*)\s*\(/g;
  let match;
  while ((match = pattern.exec(slice)) !== null) {
    const name = match[1];
    if (name === selfName) continue;
    if (NOT_CALLABLE.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const line = starts ? offsetToLine(starts, start + match.index) : 0;
    calls.push({ name, line });
    if (calls.length >= MAX_CALLS_PER_SYMBOL) break;
  }
  return calls;
}

/* ---------------------------------------------------------- brace languages */

function parseBraceLanguage(masked, text, starts, language) {
  const symbols = [];
  const structures = [];
  let boundary = 0;
  let index = 0;

  while (index < masked.length && symbols.length < MAX_SYMBOLS_PER_FILE) {
    const char = masked[index];
    if (char === ';' || char === '}') {
      boundary = index + 1;
      index += 1;
      continue;
    }
    if (char !== '{') {
      index += 1;
      continue;
    }

    const header = masked.slice(boundary, index);
    const parsed = parseBraceFunctionHeader(header);
    if (!parsed) {
      boundary = index + 1;
      index += 1;
      continue;
    }

    const end = matchBrace(masked, index);
    const nameOffset = boundary + Math.max(0, masked.slice(boundary, index).lastIndexOf(parsed.name));
    const line = offsetToLine(starts, nameOffset);
    const endLine = offsetToLine(starts, end);
    const calls = extractCalls(masked, index + 1, end, parsed.name, starts);
    const exported = language.family === 'js'
      ? /\bexport\b/.test(masked.slice(Math.max(0, boundary - 40), index))
      : !parsed.isStatic;

    symbols.push({
      name: parsed.name,
      kind: 'function',
      line,
      endLine,
      signature: parsed.signature,
      modifiers: parsed.modifiers,
      isStatic: parsed.isStatic,
      exported,
      loc: Math.max(1, endLine - line + 1),
      calls,
    });

    boundary = end + 1;
    index = end + 1;
  }

  return { symbols, structures };
}

/* ---------------------------------------------------------------- C structs */

const STRUCT_PATTERN = /(typedef\s+)?\b(struct|union|enum|class|interface|trait|impl)\s+([A-Za-z_]\w*)?\s*\{/g;

function parseStructuralTypes(masked, text, starts, language) {
  const structures = [];
  let match;
  STRUCT_PATTERN.lastIndex = 0;
  while ((match = STRUCT_PATTERN.exec(masked)) !== null) {
    if (structures.length >= 200) break;
    const kind = match[2];
    const open = match.index + match[0].length - 1;
    if (masked[open] !== '{') continue;
    const end = matchBrace(masked, open);
    const line = offsetToLine(starts, match.index + match[0].indexOf(kind));
    const endLine = offsetToLine(starts, end);
    let name = match[3] || '';
    if (!name) {
      const tail = /^\s*([A-Za-z_]\w*)\s*;/.exec(masked.slice(end + 1, end + 200));
      if (tail) name = tail[1];
    }
    if (!name) name = `anonymous_${line}`;
    const bodyOriginal = text.slice(masked.indexOf('{', open) + 1, end);
    const bodyMasked = masked.slice(open + 1, end);
    structures.push({
      name,
      kind: kind === 'impl' ? 'impl' : kind,
      line,
      endLine,
      fields: parseFields(bodyOriginal, bodyMasked, kind, language),
      methods: parseMethods(bodyMasked, starts, open + 1),
    });
    STRUCT_PATTERN.lastIndex = end + 1;
  }
  return structures;
}

function parseFields(bodyOriginal, bodyMasked, kind, language) {
  const fields = [];
  const lines = splitLines(bodyOriginal);
  const maskedLines = splitLines(bodyMasked);
  for (let index = 0; index < lines.length && fields.length < 80; index += 1) {
    const maskedLine = maskedLines[index] ?? '';
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    if (trimmed.includes('(') || maskedLine.includes('(')) continue;
    if (/^(public|private|protected)\s*:/.test(trimmed)) continue;

    let statement = trimmed.replace(/;.*$/, '').trim();
    if (!statement || statement.includes('{') || statement.includes('}')) continue;
    if (kind === 'enum') {
      for (const part of statement.split(',')) {
        const name = part.trim().split('=')[0].trim();
        if (/^[A-Za-z_]\w*$/.test(name)) fields.push({ name, type: 'enum', line: index + 1 });
      }
      continue;
    }

    if (language?.family === 'js' && statement.includes(':')) {
      const [namePart, typePart] = statement.split(':');
      const name = namePart.trim().replace(/^readonly\s+/, '').replace(/\?$/, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) {
        fields.push({ name, type: truncate((typePart || '').trim(), 80), line: index + 1 });
      }
      continue;
    }

    const parts = statement.split(',');
    const first = parts[0].trim();
    const firstMatch = /^(.*?)([A-Za-z_]\w*)\s*(\[[^\]]*\])?$/.exec(first);
    if (!firstMatch) continue;
    const type = firstMatch[1].trim().replace(/\s+/g, ' ');
    const name = firstMatch[2];
    if (!name || NOT_CALLABLE.has(name)) continue;
    fields.push({ name, type: truncate(type, 80) || 'unknown', line: index + 1 });
    for (const extra of parts.slice(1)) {
      const extraName = extra.trim().replace(/\[[^\]]*\]/, '').trim();
      if (/^[A-Za-z_]\w*$/.test(extraName)) fields.push({ name: extraName, type: truncate(type, 80) || 'unknown', line: index + 1 });
    }
  }
  return fields;
}

function parseMethods(bodyMasked, starts, baseOffset) {
  const names = [];
  const pattern = /\b([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{/g;
  let match;
  while ((match = pattern.exec(bodyMasked)) !== null && names.length < 40) {
    const name = match[1];
    if (CONTROL_KEYWORDS.has(name) || NOT_CALLABLE.has(name)) continue;
    names.push(name);
  }
  return names;
}

/* ------------------------------------------------------------------- python */

function pythonBlockEnd(lines, startIndex, indent) {
  let end = startIndex;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const currentIndent = line.length - line.replace(/^\s+/, '').length;
    if (currentIndent <= indent) break;
    end = index;
  }
  return end;
}

function parsePython(masked, text, starts, language) {
  const symbols = [];
  const structures = [];
  const maskedLines = splitLines(masked);
  const originalLines = splitLines(text);

  for (let index = 0; index < maskedLines.length && symbols.length < MAX_SYMBOLS_PER_FILE; index += 1) {
    const line = maskedLines[index];
    const def = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
    if (def) {
      const indent = def[1].length;
      const name = def[2];
      const end = pythonBlockEnd(maskedLines, index, indent);
      const signature = truncate(`${originalLines[index] || ''}`.trim().replace(/\s+/g, ' '), 300);
      const bodyMasked = maskedLines.slice(index + 1, end + 1).join('\n');
      const calls = extractCalls(bodyMasked, 0, bodyMasked.length, name, null);
      symbols.push({
        name,
        kind: name.startsWith('__') && name.endsWith('__') ? 'dunder' : 'function',
        line: index + 1,
        endLine: end + 1,
        signature,
        modifiers: /async/.test(line) ? ['async'] : [],
        isStatic: indent > 0 && /^\s*@staticmethod/.test(maskedLines[index - 1] || ''),
        exported: !name.startsWith('_'),
        loc: Math.max(1, end - index + 1),
        calls,
      });
      continue;
    }
    const cls = /^(\s*)class\s+([A-Za-z_]\w*)/.exec(line);
    if (cls) {
      const indent = cls[1].length;
      const end = pythonBlockEnd(maskedLines, index, indent);
      const bodyMasked = maskedLines.slice(index + 1, end + 1).join('\n');
      const methods = [];
      for (const bodyLine of splitLines(bodyMasked)) {
        const method = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(bodyLine);
        if (method) methods.push(method[1]);
      }
      structures.push({
        name: cls[2],
        kind: 'class',
        line: index + 1,
        endLine: end + 1,
        fields: [],
        methods,
      });
    }
  }
  return { symbols, structures };
}

/* ----------------------------------------------------------------------- go */

function parseGo(masked, text, starts) {
  const symbols = [];
  const structures = [];
  const pattern = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm;
  let match;
  while ((match = pattern.exec(masked)) !== null && symbols.length < MAX_SYMBOLS_PER_FILE) {
    const name = match[1];
    const open = masked.indexOf('{', match.index);
    if (open === -1) continue;
    const end = matchBrace(masked, open);
    const line = offsetToLine(starts, match.index);
    const endLine = offsetToLine(starts, end);
    const calls = extractCalls(masked, open + 1, end, name, starts);
    symbols.push({
      name,
      kind: 'function',
      line,
      endLine,
      signature: oneLine(text.slice(match.index, open), 300),
      modifiers: [],
      isStatic: false,
      exported: /^[A-Z]/.test(name),
      loc: Math.max(1, endLine - line + 1),
      calls,
    });
    pattern.lastIndex = end;
  }
  const typePattern = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)\s*\{/gm;
  while ((match = typePattern.exec(masked)) !== null && structures.length < 200) {
    const open = match.index + match[0].length - 1;
    const end = matchBrace(masked, open);
    structures.push({
      name: match[1],
      kind: match[2],
      line: offsetToLine(starts, match.index),
      endLine: offsetToLine(starts, end),
      fields: parseFields(text.slice(open + 1, end), masked.slice(open + 1, end), 'struct', { family: 'go' }),
      methods: [],
    });
    typePattern.lastIndex = end;
  }
  return { symbols, structures };
}

/* ------------------------------------------------------------------- js / ts */

function parseJs(masked, text, starts, language) {
  const symbols = [];
  const structures = [];
  const push = (name, kind, matchIndex, openIndex = -1, signature = '') => {
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) return;
    if (!name || CONTROL_KEYWORDS.has(name)) return;
    const line = offsetToLine(starts, matchIndex);
    let endLine = line;
    let calls = [];
    if (openIndex >= 0) {
      const end = matchBrace(masked, openIndex);
      endLine = offsetToLine(starts, end);
      calls = extractCalls(masked, openIndex + 1, end, name, starts);
    } else {
      const lineEnd = masked.indexOf('\n', matchIndex);
      const stop = lineEnd === -1 ? masked.length : lineEnd;
      endLine = offsetToLine(starts, stop);
      calls = extractCalls(masked, matchIndex, stop, name, starts);
    }
    symbols.push({
      name,
      kind,
      line,
      endLine,
      signature: truncate(signature || oneLine(text.slice(matchIndex, Math.min(matchIndex + 240, text.length)), 240), 300),
      modifiers: [],
      isStatic: false,
      exported: /\bexport\b/.test(masked.slice(Math.max(0, matchIndex - 60), matchIndex + 20)),
      loc: Math.max(1, endLine - line + 1),
      calls,
    });
  };

  for (const match of masked.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const open = masked.indexOf('{', match.index);
    push(match[1], 'function', match.index, open, text.slice(match.index, open > 0 ? open : match.index + 120));
  }
  for (const match of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*)?\(([^)=\n]*)\)?\s*=>/g)) {
    const open = masked.indexOf('{', match.index);
    const arrow = masked.indexOf('=>', match.index);
    const hasBlock = open !== -1 && open > arrow && open - arrow < 200;
    push(match[1], 'arrow', match.index, hasBlock ? open : -1, text.slice(match.index, Math.min(match.index + 160, text.length)));
  }
  for (const match of masked.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) {
    const open = masked.indexOf('{', match.index);
    const end = open >= 0 ? matchBrace(masked, open) : match.index;
    structures.push({
      name: match[1],
      kind: 'class',
      line: offsetToLine(starts, match.index),
      endLine: offsetToLine(starts, end),
      fields: open >= 0 ? parseFields(text.slice(open + 1, end), masked.slice(open + 1, end), 'struct', { family: 'js' }) : [],
      methods: open >= 0 ? parseMethods(masked.slice(open + 1, end), starts, open + 1) : [],
    });
  }
  for (const match of masked.matchAll(/\binterface\s+([A-Za-z_$][\w$]*)/g)) {
    structures.push({
      name: match[1],
      kind: 'interface',
      line: offsetToLine(starts, match.index),
      endLine: offsetToLine(starts, match.index),
      fields: [],
      methods: [],
    });
  }
  for (const match of masked.matchAll(/\btype\s+([A-Za-z_$][\w$]*)\s*=/g)) {
    structures.push({
      name: match[1],
      kind: 'type',
      line: offsetToLine(starts, match.index),
      endLine: offsetToLine(starts, match.index),
      fields: [],
      methods: [],
    });
  }
  return { symbols, structures };
}

/* --------------------------------------------------------------------- rust */

function parseRust(masked, text, starts) {
  const symbols = [];
  const structures = [];
  const fnPattern = /\bfn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/g;
  let match;
  while ((match = fnPattern.exec(masked)) !== null && symbols.length < MAX_SYMBOLS_PER_FILE) {
    const open = masked.indexOf('{', match.index);
    if (open === -1) continue;
    const end = matchBrace(masked, open);
    const line = offsetToLine(starts, match.index);
    const endLine = offsetToLine(starts, end);
    symbols.push({
      name: match[1],
      kind: 'function',
      line,
      endLine,
      signature: oneLine(text.slice(match.index, open), 300),
      modifiers: [],
      isStatic: false,
      exported: /\bpub\b/.test(masked.slice(Math.max(0, match.index - 20), match.index)),
      loc: Math.max(1, endLine - line + 1),
      calls: extractCalls(masked, open + 1, end, match[1], starts),
    });
    fnPattern.lastIndex = end;
  }
  for (const head of masked.matchAll(/\b(struct|enum|trait)\s+([A-Za-z_]\w*)\s*\{/g)) {
    const open = head.index + head[0].length - 1;
    const end = matchBrace(masked, open);
    structures.push({
      name: head[2],
      kind: head[1],
      line: offsetToLine(starts, head.index),
      endLine: offsetToLine(starts, end),
      fields: parseFields(text.slice(open + 1, end), masked.slice(open + 1, end), 'struct', { family: 'rust' }),
      methods: [],
    });
  }
  return { symbols, structures };
}

/* ----------------------------------------------------------------- assembly */

function parseAssembly(masked, text, starts) {
  const labels = [];
  for (const match of masked.matchAll(/^\s*([A-Za-z_]\w*)\s+(?:PROC|EXPORT|GLOBAL)\b/gim)) {
    labels.push({ name: match[1], index: match.index, line: offsetToLine(starts, match.index) });
  }
  for (const match of masked.matchAll(/^([A-Za-z_]\w*):\s*$/gm)) {
    labels.push({ name: match[1], index: match.index, line: offsetToLine(starts, match.index) });
  }
  labels.sort((left, right) => left.index - right.index);

  const symbols = [];
  for (let order = 0; order < labels.length && symbols.length < MAX_SYMBOLS_PER_FILE; order += 1) {
    const label = labels[order];
    const end = order + 1 < labels.length ? labels[order + 1].index : masked.length;
    const block = masked.slice(label.index, end);
    const calls = [];
    const seen = new Set();
    const record = (name, index) => {
      if (!name || seen.has(name)) return;
      seen.add(name);
      calls.push({ name, line: offsetToLine(starts, label.index + index) });
    };
    for (const match of block.matchAll(/\b(?:BL|BLX)\s+([A-Za-z_]\w*)/g)) record(match[1], match.index);
    for (const match of block.matchAll(/=\s*([A-Za-z_]\w*)/g)) record(match[1], match.index);
    for (const match of block.matchAll(/\b(?:B|BX)\s+([A-Za-z_]\w*)/g)) record(match[1], match.index);
    symbols.push({
      name: label.name,
      kind: 'label',
      line: label.line,
      endLine: offsetToLine(starts, end),
      signature: truncate(oneLine(text.slice(label.index, Math.min(label.index + 120, text.length)), 160), 160),
      modifiers: [],
      isStatic: false,
      exported: true,
      loc: Math.max(1, offsetToLine(starts, end) - label.line + 1),
      calls: calls.slice(0, MAX_CALLS_PER_SYMBOL),
    });
  }
  return { symbols: dedupeSymbols(symbols), structures: [] };
}

function parseCPrototypes(masked, text, starts) {
  const symbols = [];
  const lines = splitLines(masked);
  for (let index = 0; index < lines.length && symbols.length < MAX_SYMBOLS_PER_FILE; index += 1) {
    const line = lines[index].trim();
    if (!line.endsWith(';') || line.includes('{') || line.includes('=') || line.includes('(*')) continue;
    const match = /^([A-Za-z_][\w\s\*]*?)\b([A-Za-z_]\w*)\s*\(([^()]*)\)\s*;$/.exec(line);
    if (!match) continue;
    const name = match[2];
    if (CONTROL_KEYWORDS.has(name) || NOT_CALLABLE.has(name)) continue;
    symbols.push({
      name,
      kind: 'prototype',
      line: index + 1,
      endLine: index + 1,
      signature: truncate(line, 300),
      modifiers: /\bstatic\b/.test(line) ? ['static'] : [],
      isStatic: /\bstatic\b/.test(line),
      exported: !/\bstatic\b/.test(line),
      loc: 1,
      calls: [],
    });
  }
  return symbols;
}

function dedupeSymbols(symbols) {
  const seen = new Map();
  for (const symbol of symbols) {
    const key = `${symbol.name}:${symbol.line}`;
    if (!seen.has(key)) seen.set(key, symbol);
  }
  return [...seen.values()];
}

/* --------------------------------------------------------------- auxiliaries */

export function findTodos(text) {
  const todos = [];
  const lines = splitLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /(?:\/\/|\/\*|#|<!--|;)\s*(TODO|FIXME|XXX|HACK)\b[:\s-]*(.{0,200})/i.exec(line);
    if (!match) continue;
    todos.push({
      kind: match[1].toUpperCase(),
      text: truncate(match[2].replace(/\*\/\s*$/, '').trim(), 200),
      line: index + 1,
    });
  }
  return todos;
}

export function findIncludes(text, language) {
  const imports = [];
  const lines = splitLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (language?.family === 'c') {
      const match = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/.exec(line);
      if (match) imports.push({ kind: 'include', target: match[1], line: index + 1, raw: truncate(line.trim(), 160) });
      continue;
    }
    if (language?.family === 'python') {
      const match = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/.exec(line);
      if (match) imports.push({ kind: 'import', target: match[1] || match[2], line: index + 1, raw: truncate(line.trim(), 160) });
      continue;
    }
    if (language?.family === 'go') {
      const match = /^\s*(?:import\s+)?(?:\w+\s+)?"([^"]+)"/.exec(line);
      if (match) imports.push({ kind: 'import', target: match[1], line: index + 1, raw: truncate(line.trim(), 160) });
      continue;
    }
    if (language?.family === 'rust') {
      const match = /^\s*use\s+([\w:]+)/.exec(line);
      if (match) imports.push({ kind: 'use', target: match[1], line: index + 1, raw: truncate(line.trim(), 160) });
      continue;
    }
    if (language?.family === 'js' || language?.family === 'java') {
      const match = /(?:from\s*|require\s*\(\s*|import\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/.exec(line);
      if (match) imports.push({ kind: 'import', target: match[1], line: index + 1, raw: truncate(line.trim(), 160) });
    }
  }
  return imports;
}

export function countBranches(masked) {
  const matches = masked.match(/\b(?:if|for|while|case|catch|switch|else\s+if)\b|&&|\|\|/g);
  return matches ? matches.length : 0;
}

/* ------------------------------------------------------------------ signals */

const SIGNAL_PATTERNS = [
  {
    kind: 'rtos',
    pattern: /\b(xTaskCreate\w*|vTaskStartScheduler|xTaskDelete|xQueueCreate\w*|xQueueSend\w*|xQueueReceive|xQueueOverwrite|xSemaphoreCreate\w*|xSemaphoreTake|xSemaphoreGive|xEventGroup\w*|vTaskDelay\w*|taskENTER_CRITICAL|taskEXIT_CRITICAL|portENTER_CRITICAL|portEXIT_CRITICAL|osThreadNew|osMessageQueue\w*|osSemaphore\w*|k_thread_create|k_sem_take|k_mutex_lock)\s*\(/g,
  },
  { kind: 'lock', pattern: /\b(pthread_mutex_\w+|std::mutex|lock_guard|unique_lock|spin_lock\w*|spin_unlock\w*|atomic_\w+|__disable_irq|__enable_irq)\b/g },
  { kind: 'alloc', pattern: /\b(malloc|calloc|realloc|strdup|new|k_malloc|pvPortMalloc)\s*[\(\[]/g },
  { kind: 'free', pattern: /\b(free|delete|k_free|vPortFree)\s*[\(\[]/g },
  { kind: 'unsafe', pattern: /\b(strcpy|strcat|sprintf|vsprintf|gets|scanf|sscanf|memcpy|memmove)\s*\(/g },
  { kind: 'io', pattern: /\b(fopen|fwrite|fread|fclose|HAL_FLASH\w*|HAL_EEPROM\w*|sqlite3_\w+|redis\w*|write|read|recv|send)\s*\(/g },
  { kind: 'dma', pattern: /\b(HAL_[A-Z0-9_]*DMA\w*|DMA_[A-Z0-9_]+)\b/g },
  { kind: 'irq', pattern: /\b(HAL_NVIC_\w+|NVIC_\w+|__NVIC\w+|EXTI_\w+IRQHandler)\b/g },
];

const IGNORED_RETURN = /^\s*(HAL_[A-Za-z0-9_]+|fwrite|fread|fclose|write|read|malloc|calloc|realloc|pthread_[a-z_]+|xQueue[A-Za-z]+|xSemaphore[A-Za-z]+|os[A-Z][A-Za-z]+)\s*\(/;

/**
 * One regex pass per file collects the facts later modules need: RTOS and lock
 * primitives, allocation/free sites, risky libc calls, ignored return values,
 * and typed declarations used for data-structure lifecycle evidence.
 */
export function scanSignals(text, masked) {
  const starts = lineStarts(text);
  const signals = {
    rtos: [],
    lock: [],
    alloc: [],
    free: [],
    unsafe: [],
    io: [],
    dma: [],
    irq: [],
    ignoredReturn: [],
    typeRefs: [],
    frees: [],
  };

  for (const { kind, pattern } of SIGNAL_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null && signals[kind].length < 200) {
      const name = match[1];
      if (!name) continue;
      const line = offsetToLine(starts, match.index);
      signals[kind].push({ name, line });
    }
  }

  const lines = splitLines(text);
  for (let index = 0; index < lines.length && signals.ignoredReturn.length < 80; index += 1) {
    const line = lines[index];
    if (!IGNORED_RETURN.test(line)) continue;
    if (/^\s*[A-Za-z_][\w.\[\]>-]*\s*=\s*[^=]/.test(line)) continue;
    if (/\breturn\b/.test(line)) continue;
    const name = /^\s*([A-Za-z_]\w*)\s*\(/.exec(line)?.[1];
    if (name) signals.ignoredReturn.push({ name, line: index + 1 });
  }

  const declaration = /\b([A-Z][A-Za-z0-9_]{2,})\s*(\*+)?\s+([A-Za-z_]\w*)\s*(?=[;=,\[)])/g;
  let match;
  while ((match = declaration.exec(masked)) !== null && signals.typeRefs.length < 120) {
    signals.typeRefs.push({
      type: match[1],
      variable: match[3],
      pointer: Boolean(match[2]),
      form: 'declaration',
      line: offsetToLine(starts, match.index),
    });
  }
  const staticDecl = /^\s*static\s+([A-Z][A-Za-z0-9_]{2,})\s+([A-Za-z_]\w*)/gm;
  while ((match = staticDecl.exec(masked)) !== null && signals.typeRefs.length < 140) {
    signals.typeRefs.push({
      type: match[1],
      variable: match[2],
      pointer: false,
      form: 'static',
      line: offsetToLine(starts, match.index),
    });
  }
  const sizeofExpr = /\bsizeof\s*\(\s*([A-Z][A-Za-z0-9_]{2,})\s*\)/g;
  while ((match = sizeofExpr.exec(masked)) !== null && signals.typeRefs.length < 160) {
    signals.typeRefs.push({
      type: match[1],
      variable: '',
      pointer: false,
      form: 'sizeof',
      line: offsetToLine(starts, match.index),
    });
  }
  const newExpr = /\bnew\s+([A-Z][A-Za-z0-9_]{2,})\b/g;
  while ((match = newExpr.exec(masked)) !== null && signals.typeRefs.length < 180) {
    signals.typeRefs.push({
      type: match[1],
      variable: '',
      pointer: false,
      form: 'new',
      line: offsetToLine(starts, match.index),
    });
  }
  const freeCall = /\b(?:free|delete|k_free|vPortFree)\s*\(?\s*([A-Za-z_]\w*)/g;
  while ((match = freeCall.exec(masked)) !== null && signals.frees.length < 80) {
    signals.frees.push({ variable: match[1], line: offsetToLine(starts, match.index) });
  }

  return signals;
}

/* ------------------------------------------------------------------ exports */

export function parseSource(text, file, language) {
  const masked = maskSource(text, language);
  const starts = lineStarts(text);
  const base = {
    path: toPosix(file.path),
    lang: language?.id || 'unknown',
    family: language?.family || 'other',
    size: file.size,
    mtimeMs: file.mtimeMs,
    source: true,
    loc: countLines(text),
    branches: countBranches(masked),
    confidence: 'heuristic',
    parseError: null,
  };

  try {
    let parsed;
    switch (language?.family) {
      case 'python':
        parsed = parsePython(masked, text, starts, language);
        break;
      case 'go':
        parsed = parseGo(masked, text, starts);
        break;
      case 'js':
        parsed = parseJs(masked, text, starts, language);
        break;
      case 'rust':
        parsed = parseRust(masked, text, starts);
        break;
      case 'asm':
        parsed = parseAssembly(masked, text, starts);
        break;
      case 'c':
      case 'java':
        parsed = parseBraceLanguage(masked, text, starts, language);
        if (!parsed.structures.length) {
          parsed.structures = parseStructuralTypes(masked, text, starts, language);
        } else {
          parsed.structures = [
            ...parsed.structures,
            ...parseStructuralTypes(masked, text, starts, language).filter(
              (item) => !parsed.structures.some((existing) => existing.name === item.name && existing.line === item.line),
            ),
          ];
        }
        if (language?.id === 'c-header' || /\.(h|hpp|hh|hxx)$/i.test(file.path)) {
          parsed.symbols = [...parsed.symbols, ...parseCPrototypes(masked, text, starts)];
        }
        break;
      default:
        parsed = { symbols: [], structures: [] };
    }

    return {
      ...base,
      symbols: dedupeSymbols(parsed.symbols).slice(0, MAX_SYMBOLS_PER_FILE),
      structures: parsed.structures.slice(0, 200),
      imports: findIncludes(text, language),
      todos: findTodos(text),
      signals: scanSignals(text, masked),
    };
  } catch (error) {
    return {
      ...base,
      symbols: [],
      structures: [],
      imports: [],
      todos: [],
      parseError: truncate(error?.message || String(error), 200),
    };
  }
}

export function emptyFileRecord(file, reason) {
  return {
    path: toPosix(file.path),
    lang: file.lang,
    family: file.family,
    size: file.size,
    mtimeMs: file.mtimeMs,
    source: false,
    loc: 0,
    branches: 0,
    confidence: 'none',
    parseError: null,
    skippedReason: reason || '',
    symbols: [],
    structures: [],
    imports: [],
    todos: [],
    signals: {
      rtos: [], lock: [], alloc: [], free: [], unsafe: [], io: [], dma: [], irq: [],
      ignoredReturn: [], typeRefs: [], frees: [],
    },
  };
}
