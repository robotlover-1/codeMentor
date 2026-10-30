/**
 * Host HTTP API for the CodeMentor panel.
 *
 * GETs expose cached knowledge and approved-root source reads. POSTs are the only
 * way to scan, advance a lesson or submit an interview answer. Every write needs
 * a same-origin JSON request carrying the `x-codementor-action` header, which a
 * cross-site form cannot send without a rejected preflight.
 */

import { CodeMentorError, errorInfo } from './core.js';
import { buildUiView } from './service.js';
import { reviewerStatus } from './reviewer.js';
import { ProjectRegistryError } from './projects.js';
import { SourceAccessError } from './source.js';

const MAX_BODY_BYTES = 512 * 1024;

export const API_PATHS = [
  '/api/codementor/state',
  '/api/codementor/projects',
  '/api/codementor/projects/scan',
  '/api/codementor/project',
  '/api/codementor/project/refresh',
  '/api/codementor/tree',
  '/api/codementor/file',
  '/api/codementor/symbol',
  '/api/codementor/lessons',
  '/api/codementor/capabilities',
  '/api/codementor/teaching/module',
  '/api/codementor/explain/function',
  '/api/codementor/lesson/update',
  '/api/codementor/learning/save',
  '/api/codementor/interview',
  '/api/codementor/interview/start',
  '/api/codementor/interview/answer',
  '/api/codementor/interview/finish',
  '/api/codementor/practice/review',
];

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function send(res, status, payload, method) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if (method === 'HEAD') {
    res.end();
    return;
  }
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, 'BODY_TOO_LARGE', '请求体过大。');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'BODY_INVALID', '请求体不是合法 JSON。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(400, 'BODY_INVALID', '请求体必须是 JSON 对象。');
  }
  return parsed;
}

function checkWriteRequest(req) {
  if (req.headers['x-codementor-action'] !== '1') {
    throw new ApiError(403, 'ACTION_HEADER_REQUIRED', '写操作需要 x-codementor-action 头。');
  }
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiError(415, 'CONTENT_TYPE_REQUIRED', '写操作需要 application/json。');
  }
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = '';
    }
    if (!originHost || originHost !== host) {
      throw new ApiError(403, 'ORIGIN_REJECTED', '跨站写请求被拒绝。');
    }
  }
  if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') {
    throw new ApiError(403, 'ORIGIN_REJECTED', '跨站请求被拒绝。');
  }
}

function checkReadRequest(req) {
  if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') {
    throw new ApiError(403, 'ORIGIN_REJECTED', '跨站请求被拒绝。');
  }
}

function errorStatus(error) {
  if (error instanceof ApiError) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof SourceAccessError) {
    const status = error.code === 'FILE_NOT_FOUND' ? 404 : error.code === 'PATH_OUTSIDE' || error.code === 'PATH_TRAVERSAL' ? 403 : 400;
    return { status, code: error.code, message: error.message };
  }
  if (error instanceof ProjectRegistryError) {
    const status = error.code === 'PROJECT_UNKNOWN' || error.code === 'PROJECT_NOT_ANALYZED' ? 404 : 409;
    return { status, code: error.code, message: error.message };
  }
  if (error instanceof CodeMentorError) {
    const status = error.code === 'PROJECT_NOT_FOUND' ? 404 : error.code === 'REMOTE_REPOSITORY' ? 400 : 400;
    return { status, code: error.code, message: error.message };
  }
  return { status: 500, code: String(error?.code || 'INTERNAL'), message: String(error?.message || error) };
}

export function createApiHandler(service) {
  return async function handle(req, res) {
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      send(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '只支持 GET/HEAD/POST。' } }, method);
      return;
    }
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      send(res, 400, { ok: false, error: { code: 'URL_INVALID', message: '请求 URL 非法。' } }, method);
      return;
    }
    try {
      if (method === 'POST') checkWriteRequest(req);
      else checkReadRequest(req);
      const route = url.pathname;
      const query = url.searchParams;

      if (method === 'GET' || method === 'HEAD') {
        if (route === '/api/codementor/state') {
          const status = await service.status();
          send(res, 200, {
            ok: true,
            plugin: status.plugin,
            dataDir: status.dataDir,
            runner: status.runner,
            projects: await service.listProjects(),
            reviewer: reviewerStatus(service.ctx),
          }, method);
          return;
        }
        if (route === '/api/codementor/projects') {
          send(res, 200, { ok: true, projects: await service.listProjects() }, method);
          return;
        }
        if (route === '/api/codementor/project') {
          const id = query.get('id') || '';
          if (!id) throw new ApiError(400, 'PROJECT_ID_REQUIRED', '缺少项目 id。');
          const { knowledge } = await service.projectKnowledge(id);
          const view = buildUiView(knowledge, { projectId: id, reviewer: reviewerStatus(service.ctx) });
          send(res, 200, { ok: true, projectId: id, projects: await service.listProjects(), view }, method);
          return;
        }
        if (route === '/api/codementor/tree') {
          const id = query.get('projectId') || '';
          if (!id) throw new ApiError(400, 'PROJECT_ID_REQUIRED', '缺少 projectId。');
          send(res, 200, await service.tree(id), method);
          return;
        }
        if (route === '/api/codementor/file') {
          const id = query.get('projectId') || '';
          const file = query.get('path') || '';
          if (!id) throw new ApiError(400, 'PROJECT_ID_REQUIRED', '缺少 projectId。');
          const start = Number(query.get('start')) || 1;
          const end = Number(query.get('end')) || start + 399;
          send(res, 200, await service.file(id, file, { start, end }), method);
          return;
        }
        if (route === '/api/codementor/symbol') {
          const id = query.get('projectId') || '';
          const symbolId = query.get('symbolId') || '';
          if (!id || !symbolId) throw new ApiError(400, 'SYMBOL_REQUIRED', '缺少 projectId 或 symbolId。');
          send(res, 200, await service.symbol(id, symbolId), method);
          return;
        }
        if (route === '/api/codementor/lessons') {
          const id = query.get('projectId') || '';
          if (!id) throw new ApiError(400, 'PROJECT_ID_REQUIRED', '缺少 projectId。');
          send(res, 200, await service.lessons(id), method);
          return;
        }
        if (route === '/api/codementor/capabilities') {
          const id = query.get('projectId') || '';
          if (!id) throw new ApiError(400, 'PROJECT_ID_REQUIRED', '缺少 projectId。');
          send(res, 200, await service.capabilities(id), method);
          return;
        }
        if (route === '/api/codementor/interview') {
          const id = query.get('projectId') || '';
          if (!id) throw new ApiError(400, 'PROJECT_ID_REQUIRED', '缺少 projectId。');
          send(res, 200, await service.liveInterview(id), method);
          return;
        }
        throw new ApiError(404, 'NOT_FOUND', `未知接口：${route}`);
      }

      const body = await readJson(req);
      if (route === '/api/codementor/projects/scan') {
        if (typeof body.path !== 'string' || !body.path.trim()) {
          throw new ApiError(400, 'PROJECT_PATH_REQUIRED', '请提供本地项目目录。');
        }
        const result = await service.importProject({ path: body.path.trim() });
        send(res, 200, result);
        return;
      }
      if (route === '/api/codementor/project/refresh') {
        const id = String(body.projectId || body.id || '');
        if (!id) throw new ApiError(400, 'PROJECT_ID_REQUIRED', '缺少 projectId。');
        send(res, 200, await service.refreshProject(id));
        return;
      }
      if (route === '/api/codementor/lesson/update') {
        const id = String(body.projectId || '');
        if (!id) throw new ApiError(400, 'PROJECT_ID_REQUIRED', '缺少 projectId。');
        const result = await service.updateLesson(id, {
          lessonId: body.lessonId,
          status: body.status,
          detail: body.detail,
          ref: body.ref,
          step: body.step,
        });
        send(res, result.ok === false ? 409 : 200, result);
        return;
      }
      if (route === '/api/codementor/teaching/module') {
        const id = String(body.projectId || '');
        if (!id) throw new ApiError(400, 'PROJECT_ID_REQUIRED', '缺少 projectId。');
        send(res, 200, await service.teachModule(id, body.moduleId, body.level || 'beginner', body.capabilityId || ''));
        return;
      }
      if (route === '/api/codementor/explain/function') {
        const id = String(body.projectId || '');
        if (!id) throw new ApiError(400, 'PROJECT_ID_REQUIRED', '缺少 projectId。');
        send(res, 200, await service.explainSymbol(id, body.symbolId, body.level || 'beginner'));
        return;
      }
      if (route === '/api/codementor/learning/save') {
        const id = String(body.projectId || '');
        if (!id) throw new ApiError(400, 'PROJECT_ID_REQUIRED', '缺少 projectId。');
        send(res, 200, await service.saveLearning(id, body));
        return;
      }
      if (route === '/api/codementor/interview/start') {
        const id = String(body.projectId || '');
        if (!id) throw new ApiError(400, 'PROJECT_ID_REQUIRED', '缺少 projectId。');
        send(res, 200, await service.startInterview(id, body));
        return;
      }
      if (route === '/api/codementor/interview/answer') {
        const id = String(body.projectId || '');
        if (!id) throw new ApiError(400, 'PROJECT_ID_REQUIRED', '缺少 projectId。');
        const result = await service.answerInterview(id, {
          sessionId: body.sessionId,
          turnId: body.turnId,
          answer: body.answer,
        });
        send(res, result.ok === false ? 409 : 200, result);
        return;
      }
      if (route === '/api/codementor/interview/finish') {
        const id = String(body.projectId || '');
        if (!id) throw new ApiError(400, 'PROJECT_ID_REQUIRED', '缺少 projectId。');
        send(res, 200, await service.finishInterview(id));
        return;
      }
      if (route === '/api/codementor/practice/review') {
        const id = String(body.projectId || '');
        if (!id) throw new ApiError(400, 'PROJECT_ID_REQUIRED', '缺少 projectId。');
        send(res, 200, await service.reviewPracticeExplanation(id, {
          taskId: body.taskId,
          answer: body.answer,
        }));
        return;
      }
      throw new ApiError(404, 'NOT_FOUND', `未知接口：${route}`);
    } catch (error) {
      const info = errorStatus(error);
      send(res, info.status, {
        ok: false,
        error: {
          code: info.code,
          message: info.message,
          ...(info.status >= 500 ? { detail: errorInfo(error).code } : {}),
        },
      }, method);
    }
  };
}
