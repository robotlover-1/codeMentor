import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { apply } from '../index.js';
import { createApiHandler } from '../lib/api.js';
import { buildSymbolIndex, findSymbols, scanProject, traceChain } from '../lib/analyze.js';
import { buildCapabilities } from '../lib/capabilities.js';
import { languageOf, maskSource, matchBrace, SCHEMA_VERSION } from '../lib/core.js';
import { KnowledgeStore } from '../lib/fs-scan.js';
import { buildLessons, buildModuleNarratives, moduleNarrative } from '../lib/mentor.js';
import { explainFunction, moduleTeaching } from '../lib/teaching.js';
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
import { createSemanticReviewer } from '../lib/reviewer.js';
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
  const view = buildUiView(knowledge, { projectId: 'sample' });
  assert.equal(view.meta.name, knowledge.name);
  assert.ok(view.overview.modules.length >= 2);
  assert.ok(view.explorer.modules.length >= 2);
  assert.ok(Array.isArray(view.explorer.chains));
  assert.ok(view.practice.verificationPlan.steps.length >= 3);
  assert.ok(view.home.gettingStarted.length === 3);
  assert.ok(view.home.modules.length >= 2);
  assert.ok(view.lessons.items.length >= 1);
  assert.ok(view.practice.categories.some((category) => category.id === 'understand' && category.tasks.length >= 1));
  assert.equal(view.interview.status, 'idle');
  assert.ok(!('bank' in view.interview), 'the private question bank must not be exposed');
  assert.ok(Array.isArray(view.overview.claims));
  for (const lesson of view.lessons.items) {
    assert.ok(lesson.steps.some((step) => step.type === 'read'));
    assert.ok(lesson.steps.some((step) => step.type === 'explain'));
    assert.ok(lesson.completionCriteria.length >= 2);
  }
});

/* --------------------------------------------------------------- panel API */

function callApi(handler, { method = 'GET', url, body, headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:1234', ...headers };
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: this.statusCode, json: text ? JSON.parse(text) : null });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const writeHeaders = {
  origin: 'http://127.0.0.1:1234',
  'x-codementor-action': '1',
  'content-type': 'application/json',
};

await test('panel API: import two projects, read tree/file, refresh new file, reject traversal', async () => {
  const apiData = path.join(tempRoot, 'api-data');
  const apiService = new CodeMentorService({ get: () => undefined, effect: (fn) => fn(), logger: {} }, { dataDir: apiData });
  const handler = createApiHandler(apiService);
  const second = path.join(tempRoot, 'sample-project-2');
  await cp(workProject, second, { recursive: true });

  const first = await callApi(handler, { method: 'POST', url: '/api/codementor/projects/scan', headers: writeHeaders, body: { path: workProject } });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.ok(first.json.project.id);
  const secondImport = await callApi(handler, { method: 'POST', url: '/api/codementor/projects/scan', headers: writeHeaders, body: { path: second } });
  assert.equal(secondImport.status, 200);
  assert.notEqual(secondImport.json.project.id, first.json.project.id);

  const projects = await callApi(handler, { url: '/api/codementor/projects' });
  assert.equal(projects.status, 200);
  assert.ok(projects.json.projects.length >= 2);

  const view = await callApi(handler, { url: `/api/codementor/project?id=${secondImport.json.project.id}` });
  assert.equal(view.status, 200);
  assert.equal(view.json.view.meta.projectId, secondImport.json.project.id);

  const tree = await callApi(handler, { url: `/api/codementor/tree?projectId=${secondImport.json.project.id}` });
  assert.equal(tree.status, 200);
  assert.ok(tree.json.nodes.some((node) => node.path === 'src/engine.c'));

  const capabilities = await callApi(handler, { url: `/api/codementor/capabilities?projectId=${secondImport.json.project.id}` });
  assert.equal(capabilities.status, 200);
  assert.ok(capabilities.json.nodes.length >= 1);

  const teach = await callApi(handler, {
    method: 'POST', url: '/api/codementor/teaching/module', headers: writeHeaders,
    body: { projectId: secondImport.json.project.id, moduleId: view.json.view.home.modules[0].moduleId },
  });
  assert.equal(teach.status, 200);
  assert.equal(teach.json.teaching.source, 'fallback');
  assert.ok(!/包含.*等符号/.test(teach.json.teaching.summary));

  const firstSymbol = view.json.view.explorer.modules.flatMap((module) => module.symbols)[0];
  const explain = await callApi(handler, {
    method: 'POST', url: '/api/codementor/explain/function', headers: writeHeaders,
    body: { projectId: secondImport.json.project.id, symbolId: firstSymbol.id },
  });
  assert.equal(explain.status, 200);
  assert.ok(explain.json.explanation.oneLine.length > 10);
  assert.equal(explain.json.explanation.source, 'fallback');

  const file = await callApi(handler, { url: `/api/codementor/file?projectId=${secondImport.json.project.id}&path=src/engine.c&start=1&end=6` });
  assert.equal(file.status, 200);
  assert.equal(file.json.lines.length, 6);
  assert.equal(file.json.lines[0].number, 1);

  const traversal = await callApi(handler, { url: `/api/codementor/file?projectId=${secondImport.json.project.id}&path=../README.md` });
  assert.equal(traversal.status, 403);
  assert.equal(traversal.json.error.code, 'PATH_TRAVERSAL');

  await writeFile(path.join(second, 'src', 'new_module.c'), 'int new_module(void) { return 1; }\n', 'utf8');
  const refreshed = await callApi(handler, { method: 'POST', url: '/api/codementor/project/refresh', headers: writeHeaders, body: { projectId: secondImport.json.project.id } });
  assert.equal(refreshed.status, 200);
  const tree2 = await callApi(handler, { url: `/api/codementor/tree?projectId=${secondImport.json.project.id}` });
  assert.ok(tree2.json.nodes.some((node) => node.path === 'src/new_module.c'), 'new file must appear after refresh');

  const noHeader = await callApi(handler, { method: 'POST', url: '/api/codementor/projects/scan', headers: { 'content-type': 'application/json' }, body: { path: workProject } });
  assert.equal(noHeader.status, 403);
  const crossSite = await callApi(handler, { method: 'POST', url: '/api/codementor/projects/scan', headers: { ...writeHeaders, origin: 'https://evil.example' }, body: { path: workProject } });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.json.error.code, 'ORIGIN_REJECTED');
});

await test('panel API: lesson completion requires file:line evidence', async () => {
  const apiService = new CodeMentorService({ get: () => undefined, effect: (fn) => fn(), logger: {} }, { dataDir: path.join(tempRoot, 'api-data') });
  const handler = createApiHandler(apiService);
  const projects = await callApi(handler, { url: '/api/codementor/projects' });
  const id = projects.json.projects[0].id;
  const lessons = await callApi(handler, { url: `/api/codementor/lessons?projectId=${id}` });
  assert.equal(lessons.status, 200);
  assert.ok(lessons.json.items.length >= 1);
  const lessonId = lessons.json.items[0].lessonId;

  const missing = await callApi(handler, { method: 'POST', url: '/api/codementor/lesson/update', headers: writeHeaders, body: { projectId: id, lessonId, status: 'completed' } });
  assert.equal(missing.status, 409);
  assert.match(missing.json.reason, /依据|file:line/);

  const done = await callApi(handler, {
    method: 'POST', url: '/api/codementor/lesson/update', headers: writeHeaders,
    body: { projectId: id, lessonId, status: 'completed', detail: '能解释入口和调用链', ref: 'src/main.c:5' },
  });
  assert.equal(done.status, 200);
  assert.equal(done.json.lesson.status, 'completed');
  const after = await callApi(handler, { url: `/api/codementor/lessons?projectId=${id}` });
  assert.equal(after.json.items.find((item) => item.lessonId === lessonId).status, 'completed');
});

await test('panel API: interview hides answers, reviews answer, is idempotent and varies by answer', async () => {
  const apiService = new CodeMentorService({ get: () => undefined, effect: (fn) => fn(), logger: {} }, { dataDir: path.join(tempRoot, 'api-data') });
  const handler = createApiHandler(apiService);
  const projects = await callApi(handler, { url: '/api/codementor/projects' });
  const id = projects.json.projects[0].id;
  const started = await callApi(handler, { method: 'POST', url: '/api/codementor/interview/start', headers: writeHeaders, body: { projectId: id, difficulty: 'mid', maxQuestions: 3 } });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  const session = started.json.session;
  assert.equal(session.status, 'asking');
  assert.ok(session.current.prompt);
  assert.ok(!('recommended' in session.current));
  assert.ok(!('expectedFacts' in session.current));
  assert.ok(!('rubric' in session.current));

  const knowledge = (await apiService.projectKnowledge(id)).knowledge;
  const bank = knowledge.interview.bank;
  const base = bank.questions.find((question) => question.id === session.current.questionId);
  const strongAnswer = [
    '首先给出结论。',
    ...base.rubric.flatMap((item) => item.keywords || []),
    '其次结合真实源码行号说明调用链。',
    '最后说明失败路径、验证方式与设计取舍。',
  ].join(' ');

  const first = await callApi(handler, {
    method: 'POST', url: '/api/codementor/interview/answer', headers: writeHeaders,
    body: { projectId: id, sessionId: session.sessionId, turnId: 'turn-aaaaaa', answer: strongAnswer },
  });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.ok(first.json.review.overallComment);
  assert.ok(first.json.review.improvedAnswer);
  assert.equal(first.json.semantic, false);
  assert.ok(['followup', 'clarify', 'next'].includes(first.json.review.decision));
  const turnsAfterFirst = first.json.view.turns.length;

  const duplicate = await callApi(handler, {
    method: 'POST', url: '/api/codementor/interview/answer', headers: writeHeaders,
    body: { projectId: id, sessionId: session.sessionId, turnId: 'turn-aaaaaa', answer: '重复提交' },
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.json.replayed, true);
  assert.equal(duplicate.json.view.turns.length, turnsAfterFirst);

  const second = await callApi(handler, { method: 'POST', url: '/api/codementor/interview/start', headers: writeHeaders, body: { projectId: id, difficulty: 'mid', maxQuestions: 3 } });
  const weak = await callApi(handler, {
    method: 'POST', url: '/api/codementor/interview/answer', headers: writeHeaders,
    body: { projectId: id, sessionId: second.json.session.sessionId, turnId: 'turn-bbbbbb', answer: '不知道' },
  });
  assert.equal(weak.status, 200);
  assert.notEqual(
    `${weak.json.review.overallComment}`,
    `${first.json.review.overallComment}`,
    'different answers must produce different reviews',
  );
  const weakNext = weak.json.next?.prompt || '';
  const firstNext = first.json.next?.prompt || '';
  assert.notEqual(firstNext, weakNext, 'different answers must lead to different follow-ups');

  const finished = await callApi(handler, { method: 'POST', url: '/api/codementor/interview/finish', headers: writeHeaders, body: { projectId: id } });
  assert.equal(finished.status, 200);
  assert.equal(finished.json.view.status, 'finished');
});

await test('semantic reviewer parses structured JSON, validates evidence and follows up on the answer', async () => {
  let captured = null;
  const payload = {
    correctPoints: ['指出 ET 需要读到 EAGAIN'],
    incorrectPoints: [{ claim: 'ET 会一直通知', whyIncorrect: 'ET 由状态变化触发，不保证重复通知', file: 'src/main.c', line: 5 }],
    missingPoints: ['没有解释不读完会导致旧事件丢失'],
    uncertainties: ['需要核对缓冲区大小'],
    dimensions: { technicalAccuracy: 3, sourceGrounding: 2, engineeringTradeoffs: 2, communication: 4 },
    overallComment: '你把读到 EAGAIN 说对了，但把触发条件说错了，而且没有说明未读完的风险。',
    improvedAnswer: { concise: 'ET 下要读到 EAGAIN，否则边缘事件不再通知。', detailed: 'ET 依赖状态变化；未读完会丢掉后续事件，需要维护读缓冲与解析状态。' },
    decision: 'followup',
    nextQuestion: '如果只读到半个命令，之后没有新数据，ET 下会发生什么？',
    nextQuestionWhy: '检查你是否理解边缘触发与缓冲状态。',
    evidence: [{ file: 'src/main.c', line: 5 }, { file: 'not/indexed.c', line: 1 }],
  };
  const fakeCtx = {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
      if (name === 'llm') {
        return {
          async *stream(options) {
            captured = options;
            yield { type: 'text-delta', text: JSON.stringify(payload) };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      }
      return undefined;
    },
    effect: (fn) => fn(),
  };
  const reviewer = createSemanticReviewer(fakeCtx);
  assert.equal(reviewer.available(), true);
  const result = await reviewer.review({
    projectName: 'sample',
    question: '为什么 ET 要读到 EAGAIN？',
    answer: '因为 ET 会一直通知。',
    evidence: [{ file: 'src/main.c', line: 5 }],
    knownFiles: ['src/main.c'],
    snippets: '5  if (read(...) < 0) ...',
    dimension: 'mechanism',
    difficulty: 'senior',
  });
  assert.equal(result.ok, true);
  assert.equal(result.semantic, true);
  assert.equal(result.decision, 'followup');
  assert.match(result.nextQuestion, /半个命令/);
  assert.equal(result.dimensions.technicalAccuracy, 3);
  assert.equal(result.evidence.length, 1);
  assert.ok(result.uncertainties.some((item) => item.includes('not/indexed.c')));
  assert.equal(captured.provider, 'fake');
  assert.ok(captured.system.includes('面试官'));
  assert.ok(!JSON.stringify(captured).includes('CodeMentor 项目源码学习'), 'no full repo or system prompt leak');
});

/* ------------------------------------------------------------ v3 content */

await test('v3 capabilities: source-grounded capabilities, not directory mirrors', async () => {
  const knowledge = (await service.ensureKnowledge({ path: workProject })).knowledge;
  const capabilities = buildCapabilities(knowledge);
  assert.ok(capabilities.nodes.length >= 2);
  assert.ok(capabilities.nodes.length <= 6);
  const moduleNames = new Set(knowledge.modules.map((module) => module.name));
  const knownFiles = new Set(knowledge.symbols.map((symbol) => symbol.file));
  for (const capability of capabilities.nodes) {
    assert.ok(capability.title.length > 4);
    assert.ok(!moduleNames.has(capability.title), `capability title mirrors a module: ${capability.title}`);
    assert.ok(!/包含.*等符号/.test(capability.purpose));
    assert.ok(['verified', 'inferred', 'unknown'].includes(capability.evidenceLevel));
    assert.ok(capability.sources.length >= 1);
    for (const source of capability.sources) {
      assert.ok(knownFiles.has(source.file), `unknown capability source ${source.file}`);
      assert.ok(source.line > 0);
    }
  }
  assert.ok(capabilities.flow.length >= 1);
  assert.ok(capabilities.flow.every((step) => capabilities.nodes.some((node) => node.id === step.id)));

  const narratives = buildModuleNarratives(knowledge, capabilities);
  for (const narrative of narratives) {
    assert.ok(!/包含.*等符号/.test(narrative.summary), `symbol dump leaked into summary: ${narrative.summary}`);
    assert.notEqual(narrative.role, '程序入口与主循环');
    assert.ok(narrative.summary.length > 8);
  }
});

await test('v3 lessons: no unrelated chain fallback; each lesson has unique activity', async () => {
  const knowledge = (await service.ensureKnowledge({ path: workProject })).knowledge;
  const capabilities = buildCapabilities(knowledge);
  const lessons = buildLessons(knowledge, { capabilities });
  assert.ok(lessons.length >= 1);
  const questions = new Set();
  for (const lesson of lessons) {
    assert.ok(!lesson.title.startsWith('读懂 '), `old generic lesson title: ${lesson.title}`);
    assert.ok(lesson.expectedOutcome.length > 10);
    assert.ok(lesson.walkthrough.length >= 3);
    assert.ok(lesson.checkQuestions.length >= 1);
    assert.ok(lesson.microTask?.action.length > 5);
    assert.ok(lesson.acceptance.length >= 2);
    assert.ok(lesson.next);
    questions.add(lesson.checkQuestions[0]);
    if (!lesson.capability) {
      assert.ok(!lesson.walkthrough.some((step) => step.kind === 'trace'), `unrelated chain used for ${lesson.module.name}`);
    }
  }
  if (lessons.length >= 2) assert.ok(questions.size >= 2, 'lessons reuse the same understanding question');
});

await test('v3 teaching: deterministic fallback, model JSON validated, cache keyed by evidence', async () => {
  const knowledge = (await service.ensureKnowledge({ path: workProject })).knowledge;
  const capabilities = buildCapabilities(knowledge);
  const module = knowledge.modules.find((item) => item.name === 'src');
  const fallback = await moduleTeaching({ knowledge, module, capabilities, reviewer: null });
  assert.equal(fallback.source, 'fallback');
  assert.ok(!/包含.*等符号/.test(fallback.summary));
  assert.ok(fallback.note.includes('未使用模型'));

  let calls = 0;
  const reviewer = {
    available: () => true,
    modelKey: () => 'fake/model',
    complete: async () => {
      calls += 1;
      return {
        ok: true,
        model: { provider: 'fake', model: 'fake' },
        text: JSON.stringify({
          summary: '这个功能把控制算法的目标值和反馈变成执行器动作。',
          responsibility: '维持闭环控制。',
          scenario: '操作员设定目标速度后持续运行。',
          inputs: '目标值与反馈',
          outputs: '控制量',
          failure: '反馈丢失时需要保护，待核实。',
          confidence: 'inferred',
          evidence: [{ file: 'src/engine.c', line: 20 }, { file: 'no/such.c', line: 1 }],
        }),
      };
    },
  };
  const first = await moduleTeaching({ knowledge, module, capabilities, reviewer, readSnippet: async () => '20  pid_compute(...)' });
  assert.equal(first.source, 'model');
  assert.equal(first.summary.includes('符号'), false);
  assert.equal(first.evidence.length, 1);
  assert.ok(first.rejectedEvidence.includes('no/such.c:1'));
  const second = await moduleTeaching({ knowledge, module, capabilities, reviewer, readSnippet: async () => '' });
  assert.equal(second.cached, true);
  assert.equal(calls, 1, 'cached teaching must not call the model twice');
  const record = knowledge.files.find((file) => file.path === 'src/engine.c');
  record.mtimeMs += 1;
  await moduleTeaching({ knowledge, module, capabilities, reviewer, readSnippet: async () => '' });
  assert.equal(calls, 2, 'evidence change must invalidate the teaching cache');
});

await test('v3 practice: staged observe/locate/reproduce/small-change/verify with honest blocking', async () => {
  const knowledge = (await service.ensureKnowledge({ path: workProject })).knowledge;
  const capabilities = buildCapabilities(knowledge);
  const generated = generateTasks(knowledge);
  const { buildPracticeView } = await import('../lib/mentor.js');
  const practice = buildPracticeView(knowledge, generated.tasks, capabilities);
  assert.deepEqual(practice.stages.map((stage) => stage.stage), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(practice.defaultStage, 'A');
  for (const stage of practice.stages) {
    assert.ok(stage.title.length > 8);
    assert.ok(stage.steps.length >= 1);
    assert.ok(stage.acceptance.length >= 1);
  }
  assert.equal(practice.stages[0].blocked, false, 'fixture has an executable node build command');
  assert.ok(practice.stages[3].candidates.every((task) => task.confidence !== 'confirmed' || task.kind === 'testing'));
  assert.ok(practice.stages[3].candidates.every((task) => task.confidenceLabel.includes('候选') || task.confidenceLabel.includes('已确认')));
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
  const realView = buildUiView(knowledge, { projectId: 'real' });
  assert.ok(!realView.home.modules.some((module) => module.name === '(root)' || module.name === 'doc'));
  assert.ok(realView.lessons.items.length >= 2);
  assert.ok(realView.home.findings.length >= 3);
  assert.ok(realView.practice.categories.find((category) => category.id === 'understand').tasks.length >= 3);
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

await test('real repository v3: capability-first home, differentiated lessons, blocked environment', async () => {
  if (!realExists) {
    console.log('   (skipped: real project not available)');
    return;
  }
  const ctx = { get: () => undefined, effect: (fn) => fn(), logger: {} };
  const realService = new CodeMentorService(ctx, { dataDir: realDataDir });
  const projects = await realService.listProjects();
  const project = projects.find((item) => item.analyzed) || projects[0];
  assert.ok(project);
  const { knowledge } = await realService.projectKnowledge(project.id);
  const capabilities = buildCapabilities(knowledge);
  const titles = capabilities.nodes.map((node) => node.title);
  assert.ok(titles.some((title) => title.includes('命令')), JSON.stringify(titles));
  assert.ok(titles.some((title) => title.includes('控制')), JSON.stringify(titles));
  assert.ok(titles.some((title) => title.includes('启动')), JSON.stringify(titles));
  for (const node of capabilities.nodes) {
    assert.ok(!knowledge.modules.some((module) => module.name === node.title), `capability mirrors a module: ${node.title}`);
    assert.ok(node.sources.length >= 1);
    assert.ok(node.sources.every((source) => knowledge.files.some((file) => file.path === source.file) || knowledge.symbols.some((symbol) => symbol.file === source.file)));
  }

  const view = buildUiView(knowledge, { projectId: project.id });
  assert.ok(view.home.capabilities.length >= 3);
  assert.ok(view.home.flow.length >= 1);
  assert.ok(view.home.modules.every((module) => !/包含.*等符号/.test(module.summary)));
  assert.ok(view.lessons.items.every((lesson) => !lesson.title.startsWith('读懂 ')));
  const coreInc = view.lessons.items.find((lesson) => lesson.module.name === 'Core/Inc');
  assert.ok(coreInc);
  assert.equal(coreInc.capability, null);
  assert.ok(!coreInc.walkthrough.some((step) => step.kind === 'trace'), 'Core/Inc must not borrow an unrelated chain');
  assert.ok(view.practice.stages.length === 5);
  assert.equal(view.practice.stages[0].blocked, true, 'Keil build must be honestly blocked');
  assert.match(view.practice.stages[0].blockedReason, /构建|运行|入口/);
  assert.ok(view.practice.stages[3].candidates.every((task) => task.confidence === 'candidate' || task.confidence === 'confirmed-gap'));

  const symbol = knowledge.symbols.find((item) => item.name === 'cmd_dispatch');
  const explanation = await realService.explainSymbol(project.id, symbol.id);
  assert.equal(explanation.ok, true);
  assert.equal(explanation.explanation.source, 'fallback');
  assert.ok(explanation.explanation.oneLine.length > 10);
  assert.ok(explanation.explanation.when.includes('cmd_dispatch') || explanation.explanation.when.includes('调用方'));
  assert.ok(Array.isArray(explanation.technical.callers));

  const prototype = knowledge.symbols.find((item) => item.name === 'cmd_dispatch' && item.kind === 'prototype');
  if (prototype) {
    const resolved = await realService.explainSymbol(project.id, prototype.id);
    assert.equal(resolved.symbol.kind, 'function');
    assert.match(resolved.symbol.file, /cmd_handler\.c$/);
    assert.ok(resolved.technical.callers.some((caller) => caller.line === 249), 'caller location must be the real call site');
  }

  const module = knowledge.modules.find((item) => item.name === 'Core/Src');
  const teaching = await realService.teachModule(project.id, module.id);
  assert.equal(teaching.ok, true);
  assert.equal(teaching.teaching.source, 'fallback');
  assert.ok(!/包含.*等符号/.test(teaching.teaching.summary));
});

console.log(`\n${passed} passed, ${failures.length} failed.`);
if (failures.length) {
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error?.message || failure.error}`);
  process.exitCode = 1;
}
await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
