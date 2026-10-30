import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply } from '../index.js';
import { buildSymbolIndex, findSymbols, scanProject, traceChain } from '../lib/analyze.js';
import { languageOf, maskSource, matchBrace, SCHEMA_VERSION } from '../lib/core.js';
import { KnowledgeStore } from '../lib/fs-scan.js';
import {
  buildQuestionBank,
  currentQuestion,
  getReport,
  startSession,
  submitAnswer,
} from '../lib/interview.js';
import { parseSource } from '../lib/parse.js';
import { buildRoadmap, LEVELS, listProgress, MODES, recordProgress } from '../lib/plan.js';
import {
  briefTask,
  buildVerificationPlan,
  generateTasks,
  suggestReferencePatch,
} from '../lib/practice.js';
import { buildUiView, CodeMentorService } from '../lib/service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, '..');
const fixtureSource = path.join(here, 'fixtures', 'sample-project');
const realProject = process.env.CODEMENTOR_REAL_PROJECT
  || 'C:/Users/28935/Desktop/pp/批量转台球式/自研开发板STM32F407';

let passed = 0;
const failures = [];

async function test(name, callback) {
  try {
    await callback();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL - ${name}`);
    console.error(error?.stack || error);
  }
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codementor-test-'));
const workProject = path.join(tempRoot, 'sample-project');
await cp(fixtureSource, workProject, { recursive: true });
const dataDir = path.join(tempRoot, 'data');
const realDataDir = path.join(tempRoot, 'data-real');

function makeService(extra = {}) {
  const ctx = {
    get: () => undefined,
    effect: (fn) => fn(),
    logger: { info() {}, warn() {} },
  };
  return new CodeMentorService(ctx, { dataDir, commandTimeoutMs: 30_000, ...extra });
}

function makeApplyContext() {
  const tools = new Map();
  const disposers = [];
  const sections = [];
  const context = {
    get(name) {
      if (name === 'systemPrompt') {
        return {
          section(section) {
            sections.push(section);
            return () => {};
          },
        };
      }
      return undefined;
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    logger: { info() {}, warn() {} },
  };
  return { context, tools, disposers, sections };
}

/* ------------------------------------------------------------------ core */

await test('maskSource keeps offsets and removes comments/strings', () => {
  const text = 'int main(void) {\n  printf("a{b}c"); // comment {\n  return 0;\n}\n';
  const masked = maskSource(text, { family: 'c' });
  assert.equal(masked.length, text.length);
  assert.equal(masked.split('\n').length, text.split('\n').length);
  assert.ok(!masked.includes('comment'));
  assert.ok(!masked.includes('a{b}c'));
  const open = masked.indexOf('{');
  const close = matchBrace(masked, open);
  assert.equal(masked[close], '}');
});

await test('parseSource finds C functions, struct, calls and TODOs', async () => {
  const text = await readFile(path.join(fixtureSource, 'src', 'engine.c'), 'utf8');
  const record = parseSource(text, { path: 'src/engine.c', size: text.length, mtimeMs: 1 }, languageOf('src/engine.c'));
  const names = record.symbols.map((symbol) => symbol.name);
  for (const expected of ['pid_reset', 'pid_set', 'pid_compute', 'engine_init', 'engine_set_target', 'engine_step', 'engine_report']) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  assert.ok(record.symbols.find((symbol) => symbol.name === 'engine_report').calls.some((call) => call.name === 'sprintf'));
  assert.ok(record.signals.unsafe.some((item) => item.name === 'sprintf'));
  assert.ok(record.signals.alloc.some((item) => item.name === 'malloc'));
  assert.ok(record.signals.ignoredReturn.some((item) => item.name === 'HAL_UART_Transmit'));

  const header = await readFile(path.join(fixtureSource, 'src', 'engine.h'), 'utf8');
  const headerRecord = parseSource(header, { path: 'src/engine.h', size: header.length, mtimeMs: 1 }, languageOf('src/engine.h'));
  const structure = headerRecord.structures.find((item) => item.name === 'PID_TypeDef');
  assert.ok(structure, 'PID_TypeDef struct missing');
  assert.ok(structure.fields.some((field) => field.name === 'target'));
  assert.ok(headerRecord.symbols.some((symbol) => symbol.kind === 'prototype' && symbol.name === 'engine_init'));
});

/* -------------------------------------------------------------- plugin logic */

await test('manifest, bundle patch, locales and icon are valid', async () => {
  const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@local/codementor');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.ok(manifest.exports['./client']);
  assert.ok(manifest.files.includes('client.js'));
  const patch = await readFile(path.join(packageDir, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.includes("name: '@local/codementor'"));
  for (const locale of ['zh', 'en']) {
    const data = JSON.parse(await readFile(path.join(packageDir, 'locale', `${locale}.json`), 'utf8'));
    assert.ok(data.meta.title.length > 3);
    assert.ok(data.meta.description.length > 20);
  }
  const icon = await readFile(path.join(packageDir, 'icon.svg'), 'utf8');
  assert.ok(icon.trim().startsWith('<svg'));
  assert.ok((await stat(path.join(packageDir, 'icon.svg'))).size < 256 * 1024);
  execFileSync(process.execPath, ['--check', path.join(packageDir, 'client.js')], { stdio: 'pipe' });
});

await test('apply registers eight tools and a behavior prompt section', async () => {
  const { context, tools, sections } = makeApplyContext();
  apply(context, { dataDir });
  assert.equal(tools.size, 8);
  for (const name of [
    'codementor_scan', 'codementor_overview', 'codementor_explore', 'codementor_roadmap',
    'codementor_progress', 'codementor_practice', 'codementor_interview', 'codementor_refresh',
  ]) {
    assert.ok(tools.has(name), `missing tool ${name}`);
    assert.equal(typeof tools.get(name).execute, 'function');
  }
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'codementor:behavior');
  assert.ok(sections[0].text.includes('codementor_scan'));
});

await test('disable/re-enable removes and re-adds every tool registration', async () => {
  const first = makeApplyContext();
  apply(first.context, { dataDir });
  assert.equal(first.tools.size, 8);
  for (const dispose of [...first.disposers].reverse()) dispose();
  assert.equal(first.tools.size, 0);
  const second = makeApplyContext();
  apply(second.context, { dataDir });
  assert.equal(second.tools.size, 8);
  for (const dispose of [...second.disposers].reverse()) dispose();
  assert.equal(second.tools.size, 0);
});

await test('tool execute returns lossless JSON (no undefined/NaN/Infinity)', async () => {
  const { context, tools } = makeApplyContext();
  apply(context, { dataDir });
  const value = await tools.get('codementor_scan').execute({ path: workProject, force: true }, { signal: new AbortController().signal });
  const problems = [];
  const walk = (item, at) => {
    if (item === undefined) { problems.push(`${at}=undefined`); return; }
    if (typeof item === 'number' && !Number.isFinite(item)) { problems.push(`${at}=${item}`); return; }
    if (typeof item === 'function') { problems.push(`${at}=function`); return; }
    if (item && typeof item === 'object') {
      const proto = Object.getPrototypeOf(item);
      if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) problems.push(`${at}=proto:${proto?.constructor?.name}`);
      for (const key of Object.keys(item)) walk(item[key], `${at}.${key}`);
    }
  };
  walk(value, 'value');
  assert.deepEqual(problems, []);
  const overview = await tools.get('codementor_overview').execute({ path: workProject }, { signal: new AbortController().signal });
  walk(overview, 'overview');
  assert.deepEqual(problems, []);
});

/* ------------------------------------------------------------ fixture scan */

const service = makeService();
const scanned = await service.scan({ path: workProject, force: true }, { signal: new AbortController().signal });

await test('scan fixture: stack, modules, entry point, build and tests', () => {
  assert.equal(scanned.ok, true, JSON.stringify(scanned.error));
  const project = scanned.project;
  assert.ok(project.languages.some((language) => language.id === 'c'));
  assert.ok(project.manifests.some((manifest) => manifest.id === 'npm'));
  assert.ok(project.buildCommands.some((command) => command.kind === 'build' && command.display.includes('tools/build.mjs')));
  const entry = scanned.entryPoints.find((item) => item.name === 'main');
  assert.ok(entry, 'main entry missing');
  assert.equal(entry.file, 'src/main.c');
  const modules = scanned.modules.map((module) => module.name);
  assert.ok(modules.includes('src'));
  assert.ok(modules.includes('src/net'));
  assert.ok(scanned.stats.testFiles >= 1);
  assert.ok(scanned.stats.symbols >= 10);
});

await test('scan fixture: module dependency edge src -> src/net (header import)', async () => {
  const knowledge = (await service.ensureKnowledge({ path: workProject })).knowledge;
  const net = knowledge.modules.find((module) => module.name === 'src/net');
  const src = knowledge.modules.find((module) => module.name === 'src');
  assert.ok(net);
  assert.ok(src);
  assert.ok(src.deps.includes(net.id), `expected ${src.id} -> ${net.id}, got ${JSON.stringify(src.deps)}`);
});

await test('overview marks evidence kinds and returns Mermaid', async () => {
  const value = await service.overview({ path: workProject }, { signal: new AbortController().signal });
  assert.equal(value.ok, true, JSON.stringify(value.error));
  assert.ok(value.oneLiner.text.length > 10);
  assert.ok(['source', 'doc', 'inference', 'unverified'].includes(value.oneLiner.kind));
  assert.ok(value.architecture.mermaid.startsWith('flowchart'));
  assert.ok(value.chain.steps.length >= 2);
  assert.ok(value.claims.some((claim) => claim.kind === 'source'));
  assert.ok(value.claims.some((claim) => claim.evidence.length > 0));
});

await test('traceChain from main reaches both engine and server modules', async () => {
  const knowledge = (await service.ensureKnowledge({ path: workProject })).knowledge;
  const traced = traceChain(knowledge, 'main', { maxDepth: 4 });
  assert.equal(traced.ok, true);
  const names = traced.nodes.map((node) => node.name);
  assert.ok(names.includes('engine_init'));
  assert.ok(names.includes('server_start'));
  assert.ok(names.includes('net_send'));
  assert.ok(traced.primary.length >= 2);
  assert.equal(traced.confidence, 'confirmed');
});

await test('explore symbol returns definitions plus real call sites', async () => {
  const value = await service.explore({ path: workProject, target: 'engine_init', mode: 'symbol' }, { signal: new AbortController().signal });
  assert.equal(value.ok, true);
  assert.ok(value.definitions.some((definition) => definition.file === 'src/engine.c'));
  assert.ok(value.references.some((reference) => reference.file === 'src/main.c'));
});

await test('explore file and chain modes both work', async () => {
  const file = await service.explore({ path: workProject, target: 'src/engine.c', mode: 'file' }, { signal: new AbortController().signal });
  assert.equal(file.ok, true);
  assert.equal(file.file.path, 'src/engine.c');
  assert.ok(file.file.symbols.length >= 5);
  const chain = await service.explore({ path: workProject, target: 'engine_init', mode: 'chain', depth: 4 }, { signal: new AbortController().signal });
  assert.equal(chain.ok, true);
  assert.ok(chain.chain.nodes.some((node) => node.name === 'pid_reset'));
});

/* ------------------------------------------------------------- roadmap/progress */

await test('roadmap: entry module is P0 and 30m budget is bounded', async () => {
  const value = await service.roadmap({ path: workProject, goal: 'onboarding', level: 'beginner', mode: '30m' }, { signal: new AbortController().signal });
  assert.equal(value.ok, true);
  assert.ok(value.plan.items.length <= MODES['30m'].maxItems);
  const src = value.plan.items.find((item) => item.module === 'src');
  assert.ok(src, 'entry module src missing from roadmap');
  assert.equal(src.priority, 'P0');
  assert.ok(src.rationale.length >= 3);
  assert.ok(value.plan.caveat.includes('预算'));
});

await test('roadmap: prerequisites are ordered before dependents', async () => {
  const value = await service.roadmap({ path: workProject, goal: 'onboarding', level: 'intermediate', mode: '2h' }, { signal: new AbortController().signal });
  assert.equal(value.ok, true);
  const names = value.plan.items.map((item) => item.module);
  const srcIndex = names.indexOf('src');
  const netIndex = names.indexOf('src/net');
  assert.ok(srcIndex >= 0, JSON.stringify(names));
  assert.ok(netIndex >= 0, JSON.stringify(names));
  // src includes net/server.h, so the net module is a prerequisite of src.
  assert.ok(netIndex < srcIndex, `expected src/net before src: ${JSON.stringify(names)}`);
});

await test('roadmap: deep mode returns more items than 30m and keeps scores explainable', async () => {
  const knowledge = (await service.ensureKnowledge({ path: workProject })).knowledge;
  const short = buildRoadmap(knowledge, { goal: 'interview', level: 'intermediate', mode: '30m' });
  const deep = buildRoadmap(knowledge, { goal: 'interview', level: 'advanced', mode: 'deep' });
  assert.ok(deep.items.length >= short.items.length);
  for (const item of deep.items) {
    assert.ok(item.components.importance >= 0 && item.components.importance <= 1);
    assert.ok(item.score >= 0 && item.score <= 1);
    assert.ok(item.objective.length > 10);
  }
});

await test('progress gating: reading cannot jump to level 4; evidence unlocks levels', async () => {
  const serviceLocal = makeService();
  await serviceLocal.scan({ path: workProject, force: true }, { signal: new AbortController().signal });
  const knowledge = (await serviceLocal.ensureKnowledge({ path: workProject })).knowledge;
  const readOnly = recordProgress(knowledge, { module: 'src', level: 4, evidenceKind: 'read', detail: '读了 engine.c' });
  assert.equal(readOnly.ok, true);
  assert.equal(readOnly.applied, false);
  assert.equal(readOnly.level, 1);
  assert.ok(readOnly.missingEvidence.length > 0);

  recordProgress(knowledge, { module: 'src', level: 2, evidenceKind: 'explained', detail: '解释了 main 到 pid 的链路' });
  const located = recordProgress(knowledge, { module: 'src', level: 3, evidenceKind: 'located', detail: '定位 src/engine.c:33' });
  assert.equal(located.applied, true);
  assert.equal(located.level, 3);

  recordProgress(knowledge, { module: 'src', level: 4, evidenceKind: 'modified', detail: '增加 NULL 检查' });
  const verified = recordProgress(knowledge, { module: 'src', level: 4, evidenceKind: 'verified', detail: 'node tools/build.mjs 退出码 0' });
  assert.equal(verified.applied, true);
  assert.equal(verified.level, 4);

  const interview = recordProgress(knowledge, { module: 'src', level: 5, evidenceKind: 'interview', detail: '通过追问', score: 0.8 });
  assert.equal(interview.applied, true);
  assert.equal(interview.level, 5);

  const invalid = recordProgress(knowledge, { module: 'src', level: 5, evidenceKind: 'bogus' });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.reason.includes('evidenceKind'));
});

await test('progress list exposes next recommendation', async () => {
  const value = await service.progress({ path: workProject, action: 'list' }, { signal: new AbortController().signal });
  assert.equal(value.ok, true);
  assert.ok(Array.isArray(value.progress.items));
  assert.ok(value.progress.items.length >= 2);
  assert.ok(value.next.module.length > 0);
});

/* ----------------------------------------------------------------- practice */

const practiceList = await service.practice({ path: workProject, action: 'list' }, { signal: new AbortController().signal });

await test('practice generates evidence-based tasks and a runnable verification plan', () => {
  assert.equal(practiceList.ok, true, JSON.stringify(practiceList.error));
  assert.ok(practiceList.tasks.length >= 3);
  const kinds = new Set(practiceList.tasks.map((task) => task.kind));
  assert.ok(kinds.has('todo'), 'TODO task missing');
  assert.ok(kinds.has('error-handling'), 'ignored-return task missing');
  assert.ok(kinds.has('safety'), 'unsafe-call task missing');
  const build = practiceList.verificationPlan.find((step) => step.kind === 'build');
  assert.ok(build.available);
  assert.ok(build.display.includes('tools/build.mjs'));
  const testStep = practiceList.verificationPlan.find((step) => step.kind === 'test');
  assert.ok(testStep.available);
  for (const task of practiceList.tasks) {
    assert.ok(task.target.file);
    assert.ok(task.objective.length > 10);
    assert.ok(task.risk.level);
    assert.ok(task.evidence.length > 0);
  }
});

await test('practice brief: guided withholds patches, coop adds constraints', async () => {
  const taskId = practiceList.tasks[0].id;
  const guided = await service.practice({ path: workProject, action: 'brief', task_id: taskId, mode: 'guided' }, { signal: new AbortController().signal });
  assert.equal(guided.ok, true);
  assert.equal(guided.task.referencePatch.available, false);
  assert.ok(guided.task.hints.length >= 3);
  const coop = await service.practice({ path: workProject, action: 'brief', task_id: taskId, mode: 'coop' }, { signal: new AbortController().signal });
  assert.ok(coop.task.hints.length >= guided.task.hints.length);
  assert.ok(coop.task.invariants.length >= 2);
  const byIndex = await service.practice({ path: workProject, action: 'brief', task_id: '#1', mode: 'coop' }, { signal: new AbortController().signal });
  assert.equal(byIndex.ok, true);
  assert.equal(byIndex.task.id, taskId);
});

await test('practice reference patch is a proposal, never marked verified', async () => {
  const knowledge = (await service.ensureKnowledge({ path: workProject })).knowledge;
  const tasks = generateTasks(knowledge).tasks;
  const safety = tasks.find((task) => task.kind === 'safety');
  const patch = suggestReferencePatch(knowledge, safety);
  assert.equal(patch.available, true);
  assert.equal(patch.verified, false);
  assert.ok(patch.proposal.includes('dst_size'));
});

await test('practice verify without authorization does not execute anything', async () => {
  const taskId = practiceList.tasks[0].id;
  const value = await service.practice({ path: workProject, action: 'verify', task_id: taskId }, { signal: new AbortController().signal });
  assert.equal(value.ok, true);
  assert.equal(value.result.executed, false);
  assert.ok(value.result.reason.includes('授权'));
  const executed = (value.result.planned || []).filter((step) => step.available);
  assert.ok(executed.length >= 2);
});

await test('practice verify with authorization executes build and test commands', async () => {
  const taskId = practiceList.tasks[0].id;
  const value = await service.practice({ path: workProject, action: 'verify', task_id: taskId, authorized: true }, { signal: new AbortController().signal });
  assert.equal(value.ok, true, JSON.stringify(value.error));
  assert.equal(value.result.executed, true);
  const build = value.result.results.find((result) => result.stepId === 'build');
  const testStep = value.result.results.find((result) => result.stepId === 'test');
  assert.equal(build.executed, true);
  assert.equal(build.exitCode, 0);
  assert.equal(testStep.executed, true);
  assert.equal(testStep.exitCode, 0);
  assert.equal(value.result.summary.verdict, 'passed-for-executed-steps');
  const manual = value.result.results.find((result) => result.stepId === 'manual-regression');
  assert.equal(manual.executed, false);
  assert.equal(manual.skipped, true);
});

/* ---------------------------------------------------------------- interview */

await test('interview: bank is source-grounded and every question has followups', async () => {
  const knowledge = (await service.ensureKnowledge({ path: workProject })).knowledge;
  const bank = buildQuestionBank(knowledge);
  assert.ok(bank.questions.length >= 5);
  for (const question of bank.questions) {
    assert.ok(question.prompt.length > 20);
    assert.ok(question.rubric.length > 0);
    assert.ok(question.recommended.concise.length > 10);
    assert.ok(Array.isArray(question.followups));
  }
  assert.ok(bank.questions.some((question) => question.dimension === 'concurrency' || question.dimension === 'architecture'));
});

await test('interview: start asks exactly one question', async () => {
  const started = await service.interview({ path: workProject, action: 'start', difficulty: 'mid', max_questions: 3 }, { signal: new AbortController().signal });
  assert.equal(started.ok, true);
  assert.ok(started.question.questionId);
  assert.ok(started.question.prompt);
  assert.equal(started.question.kind, 'base');
});

await test('interview: strong answer triggers follow-up, weak answer retries then moves on', async () => {
  const serviceLocal = makeService();
  await serviceLocal.scan({ path: workProject, force: true }, { signal: new AbortController().signal });
  const knowledge = (await serviceLocal.ensureKnowledge({ path: workProject })).knowledge;
  startSession(knowledge, { difficulty: 'mid', maxQuestions: 3 });
  const bank = knowledge.interview.bank;

  const current = currentQuestion(knowledge);
  const base = bank.questions.find((question) => question.id === current.questionId);
  const strong = [
    '首先给出结论。',
    ...base.rubric.flatMap((item) => item.keywords || []),
    base.prompt,
    '其次结合源码行号和失败路径说明。',
    '最后总结设计取舍与验证方式。',
  ].join(' ');
  const first = submitAnswer(knowledge, { answer: strong });
  assert.equal(first.ok, true);
  assert.equal(first.verdict, 'strong', JSON.stringify(first.grading));
  assert.ok(['followup', 'next'].includes(first.action));

  const secondCurrent = currentQuestion(knowledge);
  const secondId = secondCurrent.questionId;
  let secondRubric;
  if (secondId.includes(':f')) {
    const [baseId, follow] = secondId.split(':f');
    const found = bank.questions.find((question) => question.id === baseId);
    secondRubric = found.followups[Number(follow)].keywords || [];
  } else {
    const found = bank.questions.find((question) => question.id === secondId);
    secondRubric = found.rubric.flatMap((item) => item.keywords || []);
  }
  const secondAnswer = submitAnswer(knowledge, { answer: `首先 ${secondRubric.join(' ')} 其次 源码 行号 最后 验证` });
  assert.equal(secondAnswer.ok, true);

  // A weak answer must not silently advance on the first attempt.
  const knowledge2 = (await serviceLocal.ensureKnowledge({ path: workProject })).knowledge;
  startSession(knowledge2, { difficulty: 'junior', maxQuestions: 2 });
  const weak = submitAnswer(knowledge2, { answer: '不知道' });
  assert.equal(weak.ok, true);
  assert.equal(weak.verdict, 'weak');
  assert.equal(weak.action, 'retry-same');
  const retry = submitAnswer(knowledge2, { answer: '不知道' });
  assert.equal(retry.action, 'moved-on-after-retry');
  assert.ok(knowledge2.interview.weakPoints.length >= 1);
});

await test('interview report aggregates dimensions and weak points', async () => {
  const started = await service.interview({ path: workProject, action: 'start', difficulty: 'junior', max_questions: 2 }, { signal: new AbortController().signal });
  assert.equal(started.ok, true);
  const answered = await service.interview({ path: workProject, action: 'answer', answer: '不知道' }, { signal: new AbortController().signal });
  assert.equal(answered.ok, true);
  const value = await service.interview({ path: workProject, action: 'report' }, { signal: new AbortController().signal });
  assert.equal(value.ok, true);
  assert.ok(value.dimensions.length >= 1);
  assert.ok(value.weakest);
  assert.ok(typeof value.recommendation === 'string');
});

await test('interview bank action lists questions without answers', async () => {
  const value = await service.interview({ path: workProject, action: 'bank' }, { signal: new AbortController().signal });
  assert.equal(value.ok, true);
  assert.ok(value.count >= 5);
  assert.ok(value.questions.every((question) => !question.recommended));
});

/* ------------------------------------------------------------------- cache */

await test('cache: second scan reuses the stored analysis', async () => {
  const serviceLocal = makeService();
  const first = await serviceLocal.scan({ path: workProject }, { signal: new AbortController().signal });
  assert.equal(first.ok, true);
  const second = await serviceLocal.scan({ path: workProject }, { signal: new AbortController().signal });
  assert.equal(second.ok, true);
  assert.ok(['memory', 'disk'].includes(second.cache.hit), JSON.stringify(second.cache));
  const store = new KnowledgeStore({ dataDir });
  const stored = await store.load(workProject);
  assert.equal(stored.ok, true);
  assert.equal(stored.data.schemaVersion, SCHEMA_VERSION);
  assert.ok(stored.data.analysis);
});

await test('refresh: unchanged project reuses every parsed file', async () => {
  const serviceLocal = makeService();
  await serviceLocal.scan({ path: workProject, force: true }, { signal: new AbortController().signal });
  const refreshed = await serviceLocal.refresh({ path: workProject }, { signal: new AbortController().signal });
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.mode, 'up-to-date');
  assert.equal(refreshed.counts.parsedFiles, 0);
  assert.ok(refreshed.counts.reusedFiles >= 8);
});

await test('refresh: changed file is re-parsed and old conclusions become stale', async () => {
  const file = path.join(workProject, 'src', 'engine.c');
  const original = await readFile(file, 'utf8');
  try {
    const serviceLocal = makeService();
    await serviceLocal.scan({ path: workProject, force: true }, { signal: new AbortController().signal });
    await writeFile(file, `${original}\n/* CODEMENTOR_TEST_CHANGE */\n`, 'utf8');
    const refreshed = await serviceLocal.refresh({ path: workProject }, { signal: new AbortController().signal });
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.mode, 'incremental');
    assert.ok(refreshed.changed.modified.includes('src/engine.c'), JSON.stringify(refreshed.changed));
    assert.equal(refreshed.counts.parsedFiles, 1);
    assert.ok(refreshed.affectedModules.includes('src'));
    assert.ok(refreshed.stale.claims >= 1);
  } finally {
    await writeFile(file, original, 'utf8');
    const serviceLocal = makeService();
    await serviceLocal.refresh({ path: workProject }, { signal: new AbortController().signal });
  }
});

/* -------------------------------------------------------------- error paths */

await test('missing path, remote URL and empty target return structured errors', async () => {
  const missing = await service.scan({ path: path.join(tempRoot, 'does-not-exist') }, { signal: new AbortController().signal });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'PROJECT_NOT_FOUND');
  const remote = await service.scan({ path: 'https://github.com/example/repo' }, { signal: new AbortController().signal });
  assert.equal(remote.ok, false);
  assert.equal(remote.error.code, 'REMOTE_REPOSITORY');
  const empty = await service.explore({ path: workProject, target: '' }, { signal: new AbortController().signal });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, 'INVALID_TARGET');
  const noCache = await service.interview({ path: tempRoot, action: 'report' }, { signal: new AbortController().signal });
  assert.equal(typeof noCache.ok, 'boolean');
});

await test('tool execute surfaces cancellation as AbortError', async () => {
  const { context, tools } = makeApplyContext();
  apply(context, { dataDir });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => tools.get('codementor_scan').execute({ path: workProject }, { signal: controller.signal }),
    (error) => error?.name === 'AbortError',
  );
});

/* ----------------------------------------------------------------- ui view */

await test('buildUiView exposes every panel section without scanning', async () => {
  const knowledge = (await service.ensureKnowledge({ path: workProject })).knowledge;
  const view = buildUiView(knowledge);
  assert.equal(view.meta.name, knowledge.name);
  assert.ok(view.overview.modules.length >= 2);
  assert.ok(view.explorer.modules.length >= 2);
  assert.ok(Array.isArray(view.explorer.chains));
  assert.ok(view.practice.verificationPlan.steps.length >= 3);
  assert.ok(view.interview.bank.count >= 5);
  assert.ok(Array.isArray(view.overview.claims));
});

/* ------------------------------------------------------------ real repository */

const realExists = await stat(realProject).then((info) => info.isDirectory()).catch(() => false);

await test('real repository: scan finds entry, modules, build system and a source-verified chain', async () => {
  if (!realExists) {
    console.log('   (skipped: real project not available)');
    return;
  }
  const ctx = {
    get: () => undefined,
    effect: (fn) => fn(),
    logger: { info() {}, warn() {} },
  };
  const realService = new CodeMentorService(ctx, { dataDir: realDataDir, commandTimeoutMs: 30_000 });
  const scan = await realService.scan({ path: realProject, force: true }, { signal: new AbortController().signal });
  assert.equal(scan.ok, true, JSON.stringify(scan.error));
  assert.ok(scan.project.languages.some((language) => language.id === 'c'));
  assert.ok(scan.project.manifests.some((manifest) => manifest.id === 'keil'));
  assert.ok(scan.modules.some((module) => module.name === 'Core/Src'));
  const entry = scan.entryPoints.find((item) => item.name === 'main' && item.file === 'Core/Src/main.c');
  assert.ok(entry, 'Core/Src/main.c entry missing');
  assert.ok(scan.entryPoints.some((item) => item.kind === 'reset-handler'));
  assert.ok(scan.project.buildCommands.some((command) => command.kind === 'build' && command.available === false));

  const overview = await realService.overview({ path: realProject }, { signal: new AbortController().signal });
  assert.equal(overview.ok, true);
  assert.ok(['inference', 'unverified'].includes(overview.oneLiner.kind), 'missing README must not be reported as a document fact');
  assert.ok(overview.concurrency.isrs.some((isr) => isr.name === 'TIM5_IRQHandler'));
  assert.ok(!overview.concurrency.isrs.some((isr) => isr.name === 'Error_Handler'));
  assert.equal(overview.startup.steps[0].to, 'SystemInit');
  assert.equal(overview.startup.steps[overview.startup.steps.length - 1].to, 'main');
  const targets = overview.chain.steps.map((step) => step.to);
  assert.ok(targets.includes('cmd_dispatch'), JSON.stringify(overview.chain.steps));
  assert.ok(targets.includes('rtc_set_time'), JSON.stringify(overview.chain.steps));
  assert.ok(overview.dataStructures.items.some((item) => item.name === 'PID_TypeDef'));
  assert.ok(overview.mermaid.architecture.startsWith('flowchart'));

  const knowledge = (await realService.ensureKnowledge({ path: realProject })).knowledge;
  const index = buildSymbolIndex(knowledge);
  assert.ok(index.definitions.has('cmd_dispatch'));
  const symbols = findSymbols(knowledge, 'cmd_dispatch');
  assert.ok(symbols.length >= 1);
  assert.equal(symbols[0].kind, 'function');
  const dispatchChain = traceChain(knowledge, 'cmd_dispatch', { maxDepth: 3 });
  assert.equal(dispatchChain.ok, true);
  assert.equal(dispatchChain.start.file, 'Core/Src/cmd_handler.c');

  const roadmap = await realService.roadmap({ path: realProject, goal: 'onboarding', level: 'intermediate', mode: '2h' }, { signal: new AbortController().signal });
  assert.equal(roadmap.ok, true);
  const planned = roadmap.plan.items.map((item) => item.module);
  assert.ok(!planned.includes('doc'), `utility doc module leaked into P0/P1: ${JSON.stringify(planned)}`);
  assert.ok(!planned.includes('(root)'), `root utility module leaked into P0/P1: ${JSON.stringify(planned)}`);
  assert.ok(planned.includes('Core/Src'));
  const srcIndex = planned.indexOf('Core/Src');
  const incIndex = planned.indexOf('Core/Inc');
  assert.ok(incIndex >= 0 && incIndex < srcIndex, `prerequisite Core/Inc must precede Core/Src: ${JSON.stringify(planned)}`);
  assert.ok(!planned.includes('Core/Inc/arch'), `insubstantial module leaked into plan: ${JSON.stringify(planned)}`);
});

await test('real repository: three consecutive source-grounded interview rounds', async () => {
  if (!realExists) {
    console.log('   (skipped: real project not available)');
    return;
  }
  const ctx = { get: () => undefined, effect: (fn) => fn(), logger: {} };
  const realService = new CodeMentorService(ctx, { dataDir: realDataDir });
  const knowledge = (await realService.ensureKnowledge({ path: realProject, allowScan: false })).knowledge;
  startSession(knowledge, { difficulty: 'mid', maxQuestions: 3 });
  const bank = knowledge.interview.bank;
  let rounds = 0;
  const seen = [];
  while (rounds < 3) {
    const current = currentQuestion(knowledge);
    assert.equal(current.ok, true, JSON.stringify(current));
    seen.push(current.questionId);
    let keywords = [];
    if (current.questionId.includes(':f')) {
      const [baseId, follow] = current.questionId.split(':f');
      keywords = bank.questions.find((question) => question.id === baseId).followups[Number(follow)].keywords || [];
    } else {
      const question = bank.questions.find((item) => item.id === current.questionId);
      keywords = question.rubric.flatMap((item) => item.keywords || []);
    }
    const answer = `首先给出结论。${keywords.join(' ')}。其次结合真实源码行号说明调用链。最后说明设计取舍、失败路径和验证方式。`;
    const graded = submitAnswer(knowledge, { answer });
    assert.equal(graded.ok, true);
    assert.ok(graded.grading.overall > 0, 'grading produced no score');
    rounds += 1;
  }
  assert.equal(rounds, 3);
  assert.ok(new Set(seen).size >= 2, 'same question repeated three times');
  const report = getReport(knowledge);
  assert.equal(report.ok, true);
  assert.ok(report.session.answered >= 3);
});

await test('real repository: practice plan is honest about an unavailable Keil build', async () => {
  if (!realExists) {
    console.log('   (skipped: real project not available)');
    return;
  }
  const ctx = { get: () => undefined, effect: (fn) => fn(), logger: {} };
  const realService = new CodeMentorService(ctx, { dataDir: realDataDir });
  const list = await realService.practice({ path: realProject, action: 'list' }, { signal: new AbortController().signal });
  assert.equal(list.ok, true);
  assert.ok(list.tasks.length >= 3);
  const kinds = new Set(list.tasks.map((task) => task.kind));
  assert.ok(kinds.size >= 2, `practice tasks are not varied: ${JSON.stringify([...kinds])}`);
  assert.ok(!list.tasks.some((task) => /HAL_GPIO_WritePin|HAL_NVIC_SetPriority/.test(task.title)), 'void HAL calls must not become error-handling tasks');
  const build = list.verificationPlan.find((step) => step.kind === 'build');
  assert.equal(build.available, false);
  assert.ok(build.reason.length > 10);
  const brief = await realService.practice({ path: realProject, action: 'brief', task_id: list.tasks[0].id, mode: 'coop' }, { signal: new AbortController().signal });
  assert.equal(brief.ok, true);
  assert.ok(brief.task.invariants.length >= 2);
});

console.log(`\n${passed} passed, ${failures.length} failed.`);
if (failures.length) {
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error?.message || failure.error}`);
  process.exitCode = 1;
}
await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
