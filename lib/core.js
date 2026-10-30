/**
 * CodeMentor core primitives: errors, text helpers, language tables, masking,
 * brace matching and deterministic scoring helpers.
 *
 * Everything here is dependency free so the bundle works both inside the DSH
 * host process and from a plain `node` test runner.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

export const PLUGIN_NAME = 'codementor';
export const PLUGIN_VERSION = '1.0.0';
export const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ errors */

export class CodeMentorError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'CodeMentorError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('operation aborted');
    error.name = 'AbortError';
    throw error;
  }
}

export function errorInfo(error) {
  if (!error) return { name: 'Error', code: 'UNKNOWN', message: 'unknown error' };
  return {
    name: String(error.name || 'Error'),
    code: String(error.code || (isAbortError(error) ? 'ABORTED' : 'ERROR')),
    message: String(error.message || error),
  };
}

/* -------------------------------------------------------------------- text */

export function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

export function relPath(root, target) {
  return toPosix(path.relative(root, target));
}

export function sha1(value, length = 40) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, length);
}

export function slugify(value) {
  const ascii = String(value)
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (ascii || 'project').toLowerCase().slice(0, 48);
}

export function nowIso() {
  return new Date().toISOString();
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function truncate(value, max = 200) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

export function oneLine(value, max = 400) {
  return truncate(String(value ?? '').replace(/\s+/g, ' ').trim(), max);
}

export function stripMarkdown(value) {
  return String(value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function countLines(text) {
  if (!text) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

export function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

export function offsetToLine(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

export function splitLines(text) {
  return String(text ?? '').split(/\r\n|\n|\r/);
}

export function uniqueBy(items, keyOf) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Calls known to return void even when their vendored header is outside the
 * parse budget. An ignored "return value" of these is not a defect.
 */
export const KNOWN_VOID_CALLS = new Set([
  'HAL_GPIO_WritePin', 'HAL_GPIO_TogglePin', 'HAL_NVIC_SetPriority', 'HAL_NVIC_EnableIRQ',
  'HAL_NVIC_DisableIRQ', 'HAL_NVIC_ClearPendingIRQ', 'HAL_NVIC_SystemReset', 'HAL_Delay',
  'HAL_IncTick', 'HAL_SuspendTick', 'HAL_ResumeTick', 'HAL_GPIO_DeInit', 'HAL_GPIO_Init',
  '__disable_irq', '__enable_irq', 'vTaskDelay', 'vTaskDelayUntil', 'vTaskStartScheduler',
  'taskENTER_CRITICAL', 'taskEXIT_CRITICAL', 'portENTER_CRITICAL', 'portEXIT_CRITICAL',
  'print', 'printf', 'puts', 'perror',
]);

/** Extract the declared return type from a parsed function prototype. */
export function declaredReturnType(symbol) {
  if (!symbol || symbol.kind !== 'prototype' || !symbol.signature) return '';
  const pattern = new RegExp(`^\\s*([A-Za-z_][\\w\\s\\*]*?)\\s+${escapeRegExp(symbol.name)}\\s*\\(`);
  const match = pattern.exec(symbol.signature);
  return match ? match[1].trim() : '';
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/* --------------------------------------------------------------- languages */

const LANGUAGE_TABLE = [
  { id: 'c', name: 'C', exts: ['.c'], family: 'c' },
  { id: 'cpp', name: 'C++', exts: ['.cc', '.cpp', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.ipp'], family: 'c' },
  { id: 'c-header', name: 'C header', exts: ['.h'], family: 'c' },
  {
    id: 'typescript',
    name: 'TypeScript',
    exts: ['.ts', '.mts', '.cts'],
    family: 'js',
  },
  { id: 'tsx', name: 'TypeScript JSX', exts: ['.tsx'], family: 'js' },
  { id: 'javascript', name: 'JavaScript', exts: ['.js', '.mjs', '.cjs', '.jsx'], family: 'js' },
  { id: 'python', name: 'Python', exts: ['.py', '.pyi'], family: 'python' },
  { id: 'go', name: 'Go', exts: ['.go'], family: 'go' },
  { id: 'java', name: 'Java', exts: ['.java'], family: 'java' },
  { id: 'kotlin', name: 'Kotlin', exts: ['.kt', '.kts'], family: 'java' },
  { id: 'csharp', name: 'C#', exts: ['.cs'], family: 'java' },
  { id: 'rust', name: 'Rust', exts: ['.rs'], family: 'rust' },
  { id: 'swift', name: 'Swift', exts: ['.swift'], family: 'c' },
  { id: 'ruby', name: 'Ruby', exts: ['.rb'], family: 'python' },
  { id: 'php', name: 'PHP', exts: ['.php'], family: 'js' },
  { id: 'lua', name: 'Lua', exts: ['.lua'], family: 'python' },
  { id: 'shell', name: 'Shell', exts: ['.sh', '.bash', '.zsh', '.ps1'], family: 'shell' },
  { id: 'sql', name: 'SQL', exts: ['.sql'], family: 'other' },
  { id: 'asm', name: 'Assembly', exts: ['.s', '.asm', '.S'], family: 'asm' },
  { id: 'proto', name: 'Protobuf', exts: ['.proto'], family: 'other' },
  { id: 'glsl', name: 'GLSL', exts: ['.glsl', '.vert', '.frag', '.hlsl'], family: 'c' },
];

const EXT_INDEX = new Map();
for (const entry of LANGUAGE_TABLE) {
  for (const ext of entry.exts) EXT_INDEX.set(ext.toLowerCase(), entry);
}

const CONFIG_EXTS = new Set([
  '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties',
  '.xml', '.plist', '.gradle', '.cmake', '.mk', '.uvprojx', '.uvproj', '.ioc', '.sln', '.csproj',
  '.vcxproj', '.ld', '.icf', '.sct', '.mex', '.txt', '.md', '.rst', '.adoc', '.csv',
]);

export const DOC_EXTS = new Set(['.md', '.markdown', '.rst', '.adoc', '.txt']);
export const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.pdf', '.zip', '.gz', '.7z',
  '.rar', '.bin', '.hex', '.elf', '.axf', '.o', '.obj', '.a', '.lib', '.so', '.dll', '.exe', '.pyc',
  '.class', '.jar', '.map', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.db', '.sqlite',
  '.crf', '.d', '.dep', '.lnp', '.lst', '.sct', '.map', '.htm', '.html', '.bak', '.iex', '.build_log',
]);

export function extnameLower(filePath) {
  return path.extname(String(filePath)).toLowerCase();
}

export function languageOf(filePath) {
  const ext = extnameLower(filePath);
  return EXT_INDEX.get(ext) || null;
}

export function isSourceLanguage(language) {
  return Boolean(language) && !['sql', 'proto', 'asm', 'shell'].includes(language.id);
}

export function isConfigFile(filePath) {
  return CONFIG_EXTS.has(extnameLower(filePath));
}

export function isDocFile(filePath) {
  return DOC_EXTS.has(extnameLower(filePath));
}

export function isBinaryFile(filePath) {
  return BINARY_EXTS.has(extnameLower(filePath));
}

/* ----------------------------------------------------------------- masking */

const C_LIKE_FAMILIES = new Set(['c', 'js', 'go', 'java', 'rust', 'shell', 'asm']);
const HASH_COMMENT_FAMILIES = new Set(['python', 'shell']);
const BACKTICK_FAMILIES = new Set(['js', 'go']);

/**
 * Replace comments and string literal contents with spaces while preserving
 * every newline and every character offset. Parsing therefore works on the
 * masked text, while line/column positions stay valid for the original.
 */
export function maskSource(text, language) {
  const family = language?.family || 'c';
  const output = text.split('');
  const length = text.length;
  const cLike = C_LIKE_FAMILIES.has(family);
  const hashComment = HASH_COMMENT_FAMILIES.has(family);
  const backtick = BACKTICK_FAMILIES.has(family);
  const pythonTriple = family === 'python';
  let index = 0;

  const blank = (position) => {
    if (position < length && text[position] !== '\n' && text[position] !== '\r') output[position] = ' ';
  };

  while (index < length) {
    const char = text[index];
    const next = text[index + 1];

    if (cLike && char === '/' && next === '/') {
      while (index < length && text[index] !== '\n') {
        blank(index);
        index += 1;
      }
      continue;
    }

    if (cLike && char === '/' && next === '*') {
      blank(index);
      blank(index + 1);
      index += 2;
      while (index < length && !(text[index] === '*' && text[index + 1] === '/')) {
        blank(index);
        index += 1;
      }
      if (index < length) {
        blank(index);
        blank(index + 1);
        index += 2;
      }
      continue;
    }

    if (hashComment && char === '#') {
      while (index < length && text[index] !== '\n') {
        blank(index);
        index += 1;
      }
      continue;
    }

    if (pythonTriple && (char === '"' || char === "'") && next === char && text[index + 2] === char) {
      const quote = text.slice(index, index + 3);
      blank(index);
      blank(index + 1);
      blank(index + 2);
      index += 3;
      while (index < length) {
        if (text.startsWith(quote, index)) {
          blank(index);
          blank(index + 1);
          blank(index + 2);
          index += 3;
          break;
        }
        blank(index);
        index += 1;
      }
      continue;
    }

    if (char === '"' || char === "'" || (backtick && char === '`')) {
      const quote = char;
      blank(index);
      index += 1;
      while (index < length) {
        if (text[index] === '\\') {
          blank(index);
          blank(index + 1);
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          blank(index);
          index += 1;
          break;
        }
        blank(index);
        index += 1;
      }
      continue;
    }

    index += 1;
  }

  return output.join('');
}

export function matchBrace(masked, openIndex) {
  if (masked[openIndex] !== '{') return openIndex;
  let depth = 0;
  for (let index = openIndex; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return masked.length - 1;
}

export const CONTROL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'do', 'else', 'case', 'default',
  'new', 'delete', 'throw', 'try', 'typeof', 'alignof', '_Alignof', 'static_assert', 'assert',
  'defined', 'decltype', 'noexcept', 'requires', 'co_await', 'co_return', 'co_yield', 'await',
  'with', 'using', 'lock', 'foreach', 'unless', 'until', 'match', 'when', 'yield', 'super', 'this',
]);

export const NOT_CALLABLE = new Set([
  ...CONTROL_KEYWORDS,
  'void', 'int', 'char', 'short', 'long', 'float', 'double', 'signed', 'unsigned', 'const', 'struct',
  'union', 'enum', 'class', 'template', 'typename', 'namespace', 'public', 'private', 'protected',
  'static', 'extern', 'inline', 'volatile', 'register', 'auto', 'bool', 'true', 'false', 'NULL',
  'nullptr', 'std', 'string', 'vector', 'map', 'set', 'pair', 'uint8_t', 'uint16_t', 'uint32_t',
  'uint64_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'size_t', 'ssize_t', 'function', 'async',
  'def', 'fn', 'func', 'impl', 'trait', 'interface', 'type', 'let', 'var', 'val', 'fun', 'import',
  'export', 'from', 'package', 'module', 'print', 'printf', 'puts', 'memcpy', 'memset', 'strlen',
]);

/* ------------------------------------------------------------------- scores */

export function normalize(value, max) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return clamp(value / max, 0, 1);
}

export function weightedScore(components, weights) {
  let total = 0;
  let weightSum = 0;
  for (const [key, value] of Object.entries(components)) {
    const weight = Number(weights?.[key] ?? 1);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    total += clamp(Number(value) || 0, 0, 1) * weight;
    weightSum += weight;
  }
  if (weightSum === 0) return 0;
  return round(total / weightSum, 4);
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    const existing = groups.get(key);
    if (existing) existing.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
