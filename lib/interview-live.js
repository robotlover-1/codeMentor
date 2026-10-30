/**
 * Interactive interview v2.
 *
 * A live session keeps private question data on the Host. The panel receives only
 * the current question, and a review (plus recommended answer) only after the
 * learner has submitted. Follow-ups come from the reviewer's reading of that
 * answer, with a rule-based fallback that is explicitly labelled.
 */

import { nowIso, round, truncate } from './core.js';
import { ensureBank, gradeAnswer } from './interview.js';
import { heuristicReview } from './reviewer.js';

const DIFFICULTY_LABEL = { junior: '初级', mid: '中级', senior: '高级' };
const FOCUS_OPTIONS = [
  { id: '', label: '项目整体' },
  { id: 'architecture', label: '项目架构' },
  { id: 'mechanism', label: '核心实现' },
  { id: 'concurrency', label: '并发与中断' },
  { id: 'performance', label: '性能优化' },
  { id: 'design', label: '设计取舍' },
  { id: 'modification', label: 'Bug 排查' },
];

function sessionId() {
  return `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function publicQuestion(question, session) {
  if (!question) return null;
  const answered = session.turns.filter((turn) => turn.questionId === question.id).length;
  return {
    questionId: question.id,
    prompt: question.prompt,
    dimension: question.dimension,
    difficulty: question.difficulty,
    kind: question.kind || 'base',
    why: question.why || '',
    turn: session.turns.length + 1,
    answered,
  };
}

function currentInternal(session) {
  return session.currentId ? session.questions[session.currentId] || null : null;
}

function pickBaseQuestions(bank, { difficulty, focus, maxQuestions }) {
  let pool = bank.questions.slice();
  if (focus) {
    const filtered = pool.filter((question) => question.dimension === focus || question.prompt.includes(focus));
    if (filtered.length) pool = filtered;
  }
  if (difficulty === 'junior') pool = pool.filter((question) => question.difficulty !== 'senior');
  if (difficulty === 'mid') {
    const filtered = pool.filter((question) => question.difficulty !== 'junior');
    if (filtered.length >= 3) pool = filtered;
  }
  return pool.slice(0, Math.max(1, Math.min(12, maxQuestions || 5)));
}

export function startLiveInterview(knowledge, options = {}) {
  const bank = ensureBank(knowledge);
  const difficulty = ['junior', 'mid', 'senior'].includes(options.difficulty) ? options.difficulty : 'mid';
  const focus = typeof options.focus === 'string' ? options.focus : '';
  const maxQuestions = Math.max(1, Math.min(12, Number(options.maxQuestions) || 5));
  const bases = pickBaseQuestions(bank, { difficulty, focus, maxQuestions });
  if (!bases.length) return { ok: false, reason: '题库为空，无法开始面试。' };
  knowledge.interview = knowledge.interview || {};
  const questions = {};
  for (const question of bases) questions[question.id] = { ...question, kind: 'base' };
  const session = {
    version: 2,
    id: sessionId(),
    projectId: options.projectId || '',
    commit: options.commit || knowledge.git?.commit || null,
    difficulty,
    focus,
    maxQuestions,
    status: 'asking',
    baseIds: bases.map((question) => question.id),
    baseIndex: 0,
    currentId: bases[0].id,
    questions,
    turns: [],
    startedAt: nowIso(),
    updatedAt: nowIso(),
  };
  knowledge.interview.live = session;
  return { ok: true, session: liveView(knowledge) };
}

export function getLiveSession(knowledge) {
  return knowledge.interview?.live || null;
}

export function liveView(knowledge) {
  const session = getLiveSession(knowledge);
  if (!session) {
    return {
      status: 'idle',
      setup: {
        difficulties: Object.entries(DIFFICULTY_LABEL).map(([id, label]) => ({ id, label })),
        focuses: FOCUS_OPTIONS,
        defaultDifficulty: 'mid',
        defaultFocus: '',
        maxQuestions: 5,
      },
      turns: [],
      current: null,
    };
  }
  return {
    status: session.status,
    sessionId: session.id,
    projectId: session.projectId,
    commit: session.commit,
    difficulty: session.difficulty,
    difficultyLabel: DIFFICULTY_LABEL[session.difficulty] || session.difficulty,
    focus: session.focus,
    maxQuestions: session.maxQuestions,
    turn: session.turns.length + 1,
    baseIndex: session.baseIndex,
    current: session.status === 'asking' ? publicQuestion(currentInternal(session), session) : null,
    turns: session.turns.map((turn) => ({
      turnId: turn.turnId,
      questionId: turn.questionId,
      prompt: turn.prompt,
      answer: turn.answer,
      review: turn.review,
      decision: turn.decision,
      semantic: turn.semantic,
      at: turn.at,
      nextQuestionId: turn.nextQuestionId || null,
    })),
    report: buildLiveReport(knowledge),
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
  };
}

function nextBase(session) {
  while (session.baseIndex + 1 < session.baseIds.length) {
    session.baseIndex += 1;
    const id = session.baseIds[session.baseIndex];
    if (session.questions[id]) return id;
  }
  return null;
}

function dynamicQuestion(session, parent, prompt, kind, decision) {
  const id = `d${session.turns.length + 1}-${Math.random().toString(36).slice(2, 5)}`;
  session.questions[id] = {
    id,
    prompt,
    dimension: parent?.dimension || 'mechanism',
    difficulty: parent?.difficulty || session.difficulty,
    kind,
    why: decision?.nextQuestionWhy || '',
    evidence: decision?.evidence || parent?.evidence || [],
    parentQuestionId: parent?.id || null,
  };
  return id;
}

function publicReview(review, semantic, reviewerNote) {
  return {
    semantic,
    model: review.model || null,
    correctPoints: review.correctPoints || [],
    incorrectPoints: review.incorrectPoints || [],
    missingPoints: review.missingPoints || [],
    uncertainties: review.uncertainties || [],
    dimensions: review.dimensions || {},
    overallComment: review.overallComment || '',
    improvedAnswer: review.improvedAnswer || { concise: '', detailed: '' },
    decision: review.decision || 'next',
    evidence: review.evidence || [],
    reviewerNote: reviewerNote || (semantic
      ? '由 Host 默认模型评审；只发送题目、回答和有限源码证据。'
      : '当前为规则诊断，不是语义评分；请结合源码行核对。'),
  };
}

export async function answerLiveInterview(knowledge, input = {}) {
  const session = getLiveSession(knowledge);
  if (!session) return { ok: false, reason: '没有进行中的面试，请先开始。' };
  if (input.sessionId && input.sessionId !== session.id) return { ok: false, reason: '会话已切换，请刷新页面后重试。' };
  if (session.status !== 'asking') return { ok: false, reason: '本轮面试已结束。' };
  const turnId = String(input.turnId || '').trim();
  if (!turnId || !/^[A-Za-z0-9._:-]{6,80}$/.test(turnId)) return { ok: false, reason: '缺少合法的 turnId。' };
  const previous = session.turns.find((turn) => turn.turnId === turnId);
  if (previous) {
    const next = previous.nextQuestionId ? session.questions[previous.nextQuestionId] : null;
    return {
      ok: true,
      replayed: true,
      review: previous.review,
      semantic: previous.semantic,
      next: next ? publicQuestion(next, session) : null,
      status: session.status,
      view: liveView(knowledge),
    };
  }
  const answer = String(input.answer || '').trim();
  if (answer.length < 2) return { ok: false, reason: '回答太短，请至少写一句完整的话。' };
  if (answer.length > 8000) return { ok: false, reason: '回答过长，请控制在 8000 字以内。' };

  const question = currentInternal(session);
  if (!question) return { ok: false, reason: '当前题目不存在，请重新开始。' };

  const evidence = [];
  const seen = new Set();
  for (const item of [...(question.evidence || []), ...(question.expectedFacts || []).flatMap((fact) => fact.evidence || [])]) {
    if (!item?.file) continue;
    const key = `${item.file}:${item.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push(item);
  }
  const history = session.turns.map((turn) => ({ prompt: turn.prompt, answer: turn.answer, review: turn.review }));

  let reviewResult = input.reviewer
    ? await input.reviewer.review({
      projectName: input.projectName,
      commit: session.commit,
      question: question.prompt,
      answer,
      history,
      evidence,
      snippets: input.snippets || '',
      knownFiles: input.knownFiles || [],
      dimension: question.dimension,
      difficulty: question.difficulty,
      signal: input.signal,
    })
    : { ok: false, semantic: false, reason: '未配置评审器。' };

  let semantic = Boolean(reviewResult.ok && reviewResult.semantic);
  if (!reviewResult.ok) {
    const unavailableReason = reviewResult.reason || '模型路由不可用';
    const grading = gradeAnswer(
      { rubric: question.rubric || [], evidence: question.evidence || [] },
      answer,
    );
    reviewResult = heuristicReview({
      question: question.prompt,
      answer,
      grading,
      missing: grading.missing || [],
      knownFiles: input.knownFiles || [],
    });
    semantic = false;
    reviewResult.uncertainties = [
      ...(reviewResult.uncertainties || []),
      `语义评审不可用：${unavailableReason}`,
    ];
  }

  let nextId = null;
  let decision = reviewResult.decision;
  if (decision === 'followup' || decision === 'clarify') {
    const prompt = String(reviewResult.nextQuestion || '').trim();
    if (prompt) {
      nextId = dynamicQuestion(session, question, prompt, decision === 'clarify' ? 'clarify' : 'followup', reviewResult);
    } else {
      decision = 'next';
    }
  }
  if (decision === 'next') nextId = nextBase(session);
  if (decision === 'finish') nextId = null;

  session.currentId = nextId;
  session.status = nextId ? 'asking' : 'finished';
  const turn = {
    turnId,
    questionId: question.id,
    prompt: question.prompt,
    answer,
    review: publicReview(reviewResult, semantic),
    semantic,
    decision,
    nextQuestionId: nextId,
    at: nowIso(),
  };
  session.turns.push(turn);
  session.updatedAt = nowIso();
  return {
    ok: true,
    replayed: false,
    review: turn.review,
    semantic,
    decision,
    next: nextId ? publicQuestion(session.questions[nextId], session) : null,
    status: session.status,
    view: liveView(knowledge),
  };
}

export function finishLiveInterview(knowledge) {
  const session = getLiveSession(knowledge);
  if (!session) return { ok: false, reason: '没有进行中的面试。' };
  session.status = 'finished';
  session.currentId = null;
  session.updatedAt = nowIso();
  return { ok: true, view: liveView(knowledge) };
}

export function buildLiveReport(knowledge) {
  const session = getLiveSession(knowledge);
  if (!session || !session.turns.length) return null;
  const dimensions = new Map();
  for (const turn of session.turns) {
    for (const [key, value] of Object.entries(turn.review?.dimensions || {})) {
      const bucket = dimensions.get(key) || { key, values: [] };
      if (Number.isFinite(Number(value))) bucket.values.push(Number(value));
      dimensions.set(key, bucket);
    }
  }
  const labels = {
    technicalAccuracy: '技术准确性',
    sourceGrounding: '源码依据',
    engineeringTradeoffs: '工程取舍',
    communication: '表达清晰度',
  };
  const scores = [...dimensions.values()]
    .filter((bucket) => bucket.values.length)
    .map((bucket) => ({
      key: bucket.key,
      label: labels[bucket.key] || bucket.key,
      average: round(bucket.values.reduce((sum, value) => sum + value, 0) / bucket.values.length, 1),
    }))
    .sort((left, right) => left.average - right.average);
  const weak = scores[0] || null;
  const evidence = [];
  const seen = new Set();
  for (const turn of session.turns) {
    for (const item of turn.review?.evidence || []) {
      const key = `${item.file}:${item.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push(item);
    }
  }
  return {
    questions: session.turns.length,
    semantic: session.turns.filter((turn) => turn.semantic).length > 0,
    scores,
    weakest: weak,
    evidence: evidence.slice(0, 8),
    recommendation: weak
      ? `下一轮优先补「${weak.label}」；把回答落到具体源码行，并说明失败路径。`
      : '继续练习，把回答落到具体源码行。',
  };
}
