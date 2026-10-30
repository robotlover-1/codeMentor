/**
 * CodeMentor panel v2.
 *
 * Project import/switch, real source browsing, lesson-based roadmap, grouped
 * practice and an interactive interview room. Every write goes through the Host
 * API with the `x-codementor-action` header; answers are never shown before the
 * learner submits.
 */

window.__ModuleLoader__.load({
  id: '@local/codementor',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const PANEL_ID = 'codementor';
    const STORAGE_PROJECT = 'codementor.project';

    const css = `
      .cm-panel { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; }
      .cm-header { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); flex-wrap: wrap; }
      .cm-brand { display: flex; flex-direction: column; min-width: 160px; gap: 1px; }
      .cm-brand strong { font-size: 15px; font-weight: 650; }
      .cm-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
      .cm-select, .cm-input, .cm-textarea { font: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 6px 8px; min-width: 0; }
      .cm-select:focus-visible, .cm-input:focus-visible, .cm-textarea:focus-visible, .cm-btn:focus-visible, .cm-tab:focus-visible, .cm-link:focus-visible, .cm-card:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .cm-input { font-size: 12px; }
      .cm-textarea { width: 100%; box-sizing: border-box; min-height: 108px; resize: vertical; font-size: 13px; line-height: 1.6; }
      .cm-btn { font: inherit; font-size: 12px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 5px 10px; cursor: pointer; white-space: nowrap; }
      .cm-btn:hover { background: var(--dsw-alias-bg-overlay); border-color: var(--dsw-alias-border-l2); }
      .cm-btn:disabled { opacity: .55; cursor: default; }
      .cm-btn.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-weight: 600; }
      .cm-btn.primary:hover { filter: brightness(1.05); }
      .cm-btn.ghost { background: transparent; }
      .cm-btn.small { padding: 3px 7px; font-size: 11px; }
      .cm-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-left: auto; }
      .cm-tabs { flex: 0 0 auto; display: flex; gap: 2px; padding: 6px 14px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); overflow-x: auto; }
      .cm-tab { border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); padding: 7px 10px; font: inherit; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
      .cm-tab:hover { color: var(--dsw-alias-label-primary); }
      .cm-tab.active { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); font-weight: 600; }
      .cm-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 14px 16px 28px; }
      .cm-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 12px; padding: 12px 14px; margin-bottom: 12px; min-width: 0; }
      .cm-card h2 { font-size: 14px; margin: 0 0 8px; }
      .cm-card h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--dsw-alias-label-secondary); margin: 0 0 7px; }
      .cm-card h4 { font-size: 12.5px; margin: 10px 0 4px; }
      .cm-card p { margin: 0 0 6px; font-size: 12.8px; line-height: 1.65; overflow-wrap: anywhere; }
      .cm-muted { color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 1.55; overflow-wrap: anywhere; }
      .cm-mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; overflow-wrap: anywhere; }
      .cm-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .cm-between { justify-content: space-between; }
      .cm-chips { display: flex; flex-wrap: wrap; gap: 5px; margin: 6px 0; }
      .cm-chip { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); border-radius: 999px; padding: 2px 7px; font-size: 10.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .cm-chip.ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .cm-chip.warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
      .cm-chip.error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .cm-link { border: 0; background: transparent; padding: 0; color: var(--dsw-alias-brand-primary); font: inherit; font-size: 11.5px; cursor: pointer; text-align: left; overflow-wrap: anywhere; }
      .cm-link:hover { text-decoration: underline; }
      .cm-empty { display: grid; place-items: center; min-height: 40vh; text-align: center; padding: 20px; color: var(--dsw-alias-label-secondary); font-size: 13px; }
      .cm-error { border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); border-radius: 10px; padding: 9px 11px; font-size: 12.5px; line-height: 1.55; margin-bottom: 10px; overflow-wrap: anywhere; }
      .cm-warn { border: 1px solid var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); border-radius: 10px; padding: 9px 11px; font-size: 12px; line-height: 1.55; margin-bottom: 10px; }
      .cm-note { border-left: 2px solid var(--dsw-alias-border-l2); padding-left: 9px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 1.6; }
      .cm-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
      .cm-grid-2 { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(260px, 1fr); gap: 14px; align-items: start; }
      .cm-split { display: flex; gap: 12px; align-items: flex-start; min-height: 60vh; }
      .cm-side { flex: 0 0 300px; min-width: 0; max-height: 74vh; overflow: auto; }
      .cm-main { flex: 1 1 auto; min-width: 0; }
      @media (max-width: 980px) { .cm-grid-2 { grid-template-columns: minmax(0, 1fr); } .cm-split { flex-direction: column; } .cm-side { flex-basis: auto; width: 100%; max-height: none; } }
      .cm-step { display: flex; gap: 10px; padding: 9px 0; border-bottom: 1px dashed var(--dsw-alias-border-l1); }
      .cm-step:last-child { border-bottom: 0; }
      .cm-step-no { flex: 0 0 auto; width: 22px; height: 22px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); display: grid; place-items: center; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .cm-step.done .cm-step-no { background: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-bg-base); }
      .cm-step-body { min-width: 0; flex: 1 1 auto; }
      .cm-step-body strong { font-size: 12.8px; }
      .cm-lesson { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 9px; padding: 8px 9px; margin-bottom: 6px; cursor: pointer; }
      .cm-lesson:hover { border-color: var(--dsw-alias-border-l2); }
      .cm-lesson.active { border-color: var(--dsw-alias-brand-primary); }
      .cm-lesson .cm-name { font-size: 12.5px; font-weight: 600; overflow-wrap: anywhere; }
      .cm-tree { font-size: 12px; line-height: 1.15; }
      .cm-tree-node { display: flex; align-items: center; gap: 4px; width: 100%; border: 0; background: transparent; color: var(--dsw-alias-label-primary); padding: 3px 4px; border-radius: 5px; cursor: pointer; text-align: left; font: inherit; }
      .cm-tree-node:hover { background: var(--dsw-alias-bg-layer-2); }
      .cm-tree-node.active { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-brand-primary); }
      .cm-tree-node .cm-dir { color: var(--dsw-alias-label-secondary); }
      .cm-tree-file { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .cm-code-wrap { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: auto; max-height: 64vh; background: var(--dsw-alias-bg-base); }
      .cm-code { margin: 0; padding: 8px 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; line-height: 1.55; min-width: 100%; }
      .cm-line { display: flex; white-space: pre; }
      .cm-line .ln { flex: 0 0 48px; text-align: right; padding-right: 10px; color: var(--dsw-alias-label-secondary); user-select: none; }
      .cm-line .tx { flex: 1 1 auto; padding-right: 14px; }
      .cm-line.highlight { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }
      .cm-badge { font-size: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 2px 6px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .cm-badge.source { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .cm-badge.warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
      .cm-badge.error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .cm-divider { height: 1px; background: var(--dsw-alias-border-l1); margin: 10px 0; }
      .cm-code-inline { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; background: var(--dsw-alias-bg-layer-2); border-radius: 4px; padding: 1px 4px; }
      .cm-footer { flex: 0 0 auto; border-top: 1px solid var(--dsw-alias-border-l1); padding: 7px 16px; color: var(--dsw-alias-label-secondary); font-size: 10.8px; display: flex; gap: 10px; flex-wrap: wrap; }
      .cm-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 6px 12px; font-size: 11.5px; z-index: 20; }
      .cm-bar { height: 5px; background: var(--dsw-alias-bg-layer-2); border-radius: 999px; overflow: hidden; }
      .cm-bar > i { display: block; height: 100%; background: var(--dsw-alias-brand-primary); }
      .cm-review-block { border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; padding: 9px 10px; margin: 8px 0; background: var(--dsw-alias-bg-base); }
      .cm-review-block h4 { margin: 0 0 4px; font-size: 12px; }
      .cm-list { margin: 4px 0 0 18px; padding: 0; font-size: 12.3px; line-height: 1.6; }
      .cm-list li { margin: 2px 0; overflow-wrap: anywhere; }
      .cm-kv { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 5px 8px; font-size: 12px; }
      .cm-kv dt { color: var(--dsw-alias-label-secondary); }
      .cm-kv dd { margin: 0; overflow-wrap: anywhere; }
      .cm-textarea:disabled { opacity: .65; }
    `;

    /* ------------------------------------------------------------------ api */

    async function api(path, options = {}) {
      const { method = 'GET', body, signal } = options;
      const headers = {};
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        headers['x-codementor-action'] = '1';
      }
      const response = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        const error = new Error(data?.error?.message || `HTTP ${response.status}`);
        error.code = data?.error?.code || 'HTTP_ERROR';
        error.status = response.status;
        throw error;
      }
      return data;
    }

    function storageGet(key, fallback = '') {
      try {
        return window.localStorage.getItem(key) ?? fallback;
      } catch {
        return fallback;
      }
    }

    function storageSet(key, value) {
      try {
        if (value === null || value === undefined) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, String(value));
      } catch {
        /* storage disabled */
      }
    }

    function fmt(value) {
      const text = String(value || '');
      return text.length > 160 ? `${text.slice(0, 157)}…` : text;
    }

    function cite(item) {
      return item?.file ? `${item.file}:${item.line || 1}` : '';
    }

    function turnId() {
      return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    }

    function useToast() {
      const [toast, setToast] = useState('');
      const timer = useRef(null);
      const show = useCallback((message) => {
        setToast(message);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setToast(''), 2200);
      }, []);
      useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
      return { toast, show };
    }

    /* ------------------------------------------------------------ components */

    function Btn({ children, onClick, variant = '', disabled = false, small = false, title = '' }) {
      return h('button', {
        type: 'button',
        className: `cm-btn${variant ? ` ${variant}` : ''}${small ? ' small' : ''}`,
        onClick,
        disabled,
        title,
      }, children);
    }

    function Chip({ children, tone = '' }) {
      return h('span', { className: `cm-chip${tone ? ` ${tone}` : ''}` }, children);
    }

    function Confidence({ value }) {
      const map = {
        source: ['源码确认', 'source'],
        doc: ['文档说明', 'source'],
        inference: ['分析推断', 'warn'],
        unverified: ['待验证', 'error'],
        'confirmed-gap': ['已确认缺口', 'source'],
        candidate: ['候选风险', 'warn'],
      };
      const [label, tone] = map[value] || [value || '待验证', 'warn'];
      return h('span', { className: `cm-badge ${tone}` }, label);
    }

    function ErrorBox({ error, onRetry }) {
      if (!error) return null;
      return h('div', { className: 'cm-error' },
        h('div', null, error.message || String(error)),
        error.code ? h('div', { className: 'cm-muted' }, `错误码：${error.code}`) : null,
        onRetry ? h('div', { style: { marginTop: 6 } }, h(Btn, { small: true, onClick: onRetry }, '重试')) : null,
      );
    }

    function ImportBar({ onImport, busy, onClose, error }) {
      const [path, setPath] = useState('');
      return h('div', { className: 'cm-card', style: { margin: '10px 16px 0' } },
        h('div', { className: 'cm-row cm-between' },
          h('h3', { style: { margin: 0 } }, '导入本地项目'),
          h(Btn, { small: true, variant: 'ghost', onClick: onClose }, '收起'),
        ),
        h('p', { className: 'cm-muted' }, '输入本机目录并扫描。GitHub 链接请先克隆到本地。'),
        h('div', { className: 'cm-row' },
          h('input', {
            className: 'cm-input', style: { flex: '1 1 260px' }, placeholder: 'C:\\work\\project',
            value: path, onChange: (event) => setPath(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter' && path.trim()) onImport(path.trim()); },
          }),
          h(Btn, { variant: 'primary', disabled: busy || !path.trim(), onClick: () => onImport(path.trim()) }, busy ? '扫描中…' : '导入并扫描'),
        ),
        h(ErrorBox, { error }),
      );
    }

    function Welcome({ projects, onImport, busy, error }) {
      const [path, setPath] = useState('');
      return h('div', { className: 'cm-body' },
        h('div', { className: 'cm-card' },
          h('h2', null, '先选择或导入一个本地项目'),
          h('p', { className: 'cm-muted' }, 'CodeMentor 会扫描项目并生成可点击的架构、课程、源码阅读和面试训练。GitHub 链接不能直接扫描；请先克隆到本地。'),
          h(ErrorBox, { error }),
          h('div', { className: 'cm-row', style: { marginTop: 8 } },
            h('input', {
              className: 'cm-input', style: { flex: '1 1 260px' },
              placeholder: '例如 C:\\work\\my-project',
              value: path,
              onChange: (event) => setPath(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter' && path.trim()) onImport(path.trim()); },
            }),
            h(Btn, { variant: 'primary', disabled: busy || !path.trim(), onClick: () => onImport(path.trim()) }, busy ? '扫描中…' : '导入并扫描'),
          ),
          h('div', { className: 'cm-note', style: { marginTop: 10 } }, '扫描只读取项目文件并写入独立缓存目录；不会修改仓库，也不会执行构建。'),
        ),
        projects.length ? h('div', { className: 'cm-card' },
          h('h3', null, '最近项目'),
          projects.map((project) => h('div', { key: project.id, className: 'cm-row cm-between', style: { padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
            h('div', null,
              h('div', { style: { fontSize: 13, fontWeight: 600 } }, project.name),
              h('div', { className: 'cm-muted cm-mono' }, project.root),
            ),
            h(Btn, { small: true, onClick: () => onImport(project.root) }, project.analyzed ? '打开' : '扫描'),
          )),
        ) : null,
      );
    }

    function CapabilityCard({ capability, onOpenSource, moduleForTeaching, onTeach, teaching }) {
      const [open, setOpen] = useState(false);
      const details = open ? h('div', { style: { marginTop: 8 } },
        h('dl', { className: 'cm-kv' },
          h('dt', null, '触发'), h('dd', null, capability.trigger),
          h('dt', null, '处理'), h('dd', null, capability.process),
          h('dt', null, '失败'), h('dd', null, capability.failure),
          h('dt', null, '上游'), h('dd', null, (capability.upstream || []).join('、') || '未发现'),
          h('dt', null, '下游'), h('dd', null, (capability.downstream || []).join('、') || '未发现'),
        ),
        capability.sources?.length ? h('div', null,
          h('h4', null, '涉及源码'),
          capability.sources.map((source, index) => h('button', {
            key: `${source.file}:${source.line}:${index}`, type: 'button', className: 'cm-link', style: { display: 'block' },
            onClick: () => onOpenSource(source.file, source.line),
          }, `${cite(source)}${source.symbol ? ` · ${source.symbol}` : ''}`)),
        ) : null,
        moduleForTeaching ? h('div', { className: 'cm-row', style: { marginTop: 6 } },
          h(Btn, { small: true, onClick: () => onTeach(moduleForTeaching, capability.id) }, teaching?.loading ? '生成中…' : '让导师解释这个功能'),
        ) : null,
        teaching?.data ? h('div', { className: 'cm-review-block' },
          h('div', { className: 'cm-row cm-between' },
            h('strong', null, teaching.data.source === 'model' ? '导师讲解（模型）' : '导师讲解（证据版）'),
            h(Confidence, { value: teaching.data.confidence }),
          ),
          h('p', null, teaching.data.summary),
          h('p', { className: 'cm-muted' }, teaching.data.scenario),
          teaching.data.note ? h('div', { className: 'cm-muted' }, teaching.data.note) : null,
        ) : null,
        teaching?.error ? h('div', { className: 'cm-warn' }, teaching.error.message) : null,
      ) : null;
      return h('div', { className: 'cm-card', style: { marginBottom: 0, background: 'var(--dsw-alias-bg-base)' } },
        h('div', { className: 'cm-row cm-between' },
          h('strong', null, capability.title),
          h(Confidence, { value: capability.evidenceLevel }),
        ),
        h('p', { style: { marginTop: 5 } }, capability.purpose),
        h('div', { className: 'cm-muted' }, `${capability.input} → ${capability.output}`),
        h('div', { className: 'cm-row', style: { marginTop: 6 } },
          h(Btn, { small: true, variant: 'ghost', onClick: () => setOpen((current) => !current) }, open ? '收起详情' : '查看实现'),
          capability.sources?.[0] ? h(Btn, { small: true, onClick: () => onOpenSource(capability.sources[0].file, capability.sources[0].line) }, '打开源码') : null,
        ),
        details,
      );
    }

    function HomeTab({ view, openSource, startLesson, startInterview }) {
      const home = view.home;
      const introduction = home?.introduction?.text || '这个项目还没有可读的简介；先看功能卡与源码入口。';
      const capabilities = home?.capabilities || [];
      const flow = home?.flow || [];
      const modules = home?.modules || [];
      const findings = home?.findings || [];
      const [teaching, setTeaching] = useState({});

      const teach = async (module, capabilityId = '') => {
        if (!module) return;
        setTeaching((current) => ({ ...current, [module.moduleId]: { ...(current[module.moduleId] || {}), loading: true, error: null } }));
        try {
          const data = await api('/api/codementor/teaching/module', {
            method: 'POST',
            body: { projectId: view.meta.projectId, moduleId: module.moduleId, capabilityId, level: 'beginner' },
          });
          setTeaching((current) => ({ ...current, [module.moduleId]: { loading: false, data: data.teaching, error: null } }));
        } catch (error) {
          setTeaching((current) => ({ ...current, [module.moduleId]: { loading: false, error, data: null } }));
        }
      };

      return h('div', null,
        h('div', { className: 'cm-card' },
          h('h2', null, view.meta.name),
          h('p', { style: { fontSize: 13.5, lineHeight: 1.7 } }, introduction),
          h('div', { className: 'cm-row' },
            h(Btn, { variant: 'primary', disabled: !home?.startLesson, onClick: () => home?.startLesson && startLesson(home.startLesson.lessonId) }, '开始第一课'),
            h(Btn, { onClick: () => startInterview('') }, '先做一轮面试'),
            home?.startLesson ? h('span', { className: 'cm-muted' }, `第一课：${home.startLesson.lessonTitle || home.startLesson.title}`) : null,
          ),
        ),
        h('div', { className: 'cm-card' },
          h('h3', null, '能完成什么事'),
          h('p', { className: 'cm-muted' }, home?.capabilityNote || '功能节点由真实符号与调用点组合；业务解释标注为推断或待确认。'),
          h('div', { className: 'cm-grid' },
            capabilities.slice(0, 6).map((capability) => h(CapabilityCard, {
              key: capability.id,
              capability,
              onOpenSource: openSource,
              moduleForTeaching: modules.find((module) => (capability.relatedModules || []).includes(module.name)) || null,
              teaching: teaching[modules.find((module) => (capability.relatedModules || []).includes(module.name))?.moduleId],
              onTeach: teach,
            })),          ),
          !capabilities.length ? h('p', { className: 'cm-muted' }, '没有找到足够证据形成功能节点；可在技术详情中查看源码组织。') : null,
        ),
        h('div', { className: 'cm-card' },
          h('h3', null, '系统如何完成一件典型的事'),
          flow.length
            ? h('div', { className: 'cm-steps' }, flow.map((step, index) => h('div', { key: step.id, className: 'cm-step' },
              h('div', { className: 'cm-step-no' }, index + 1),
              h('div', { className: 'cm-step-body' },
                h('div', { className: 'cm-row cm-between' },
                  h('strong', null, step.title),
                  h(Confidence, { value: step.evidenceLevel }),
                ),
                h('div', { className: 'cm-muted' }, step.purpose),
                step.sources?.[0] ? h('button', { type: 'button', className: 'cm-link', onClick: () => openSource(step.sources[0].file, step.sources[0].line) }, cite(step.sources[0])) : null,
              ),
            )))
            : h('p', { className: 'cm-muted' }, '当前没有可确认的功能流程；先阅读功能卡中的源码入口。'),
        ),
        h('div', { className: 'cm-card' },
          h('h3', null, '新人应该从哪开始'),
          (home?.gettingStarted || []).map((step) => h('div', { key: step.id, className: `cm-step${step.done ? ' done' : ''}` },
            h('div', { className: 'cm-step-no' }, step.done ? '✓' : step.order),
            h('div', { className: 'cm-step-body' },
              h('div', { className: 'cm-row cm-between' },
                h('strong', null, step.title),
                step.done ? h(Chip, { tone: 'ok' }, step.doneLabel) : null,
              ),
              h('div', { className: 'cm-muted', style: { marginTop: 3 } }, step.description),
              h('div', { className: 'cm-row', style: { marginTop: 5 } },
                step.action?.type === 'lesson'
                  ? h(Btn, { small: true, onClick: () => startLesson(step.action.lessonId) }, '打开课程')
                  : step.action?.file
                    ? h(Btn, { small: true, onClick: () => openSource(step.action.file, step.action.line, { chainId: step.action.chainId }) }, '打开源码')
                    : null,
              ),
            ),
          )),
        ),
        h('details', { className: 'cm-card' },
          h('summary', { className: 'cm-link' }, '深入技术细节：源码架构、模块职责与证据状态'),
          h('div', { style: { marginTop: 10 } },
            h('h3', null, '源码架构（目录/模块）'),
            h('div', { className: 'cm-chips' },
              ...(modules || []).slice(0, 8).map((module) => h(Chip, { key: module.moduleId }, module.name)),
            ),
            view.overview.architecture?.mermaid ? h('details', null,
              h('summary', { className: 'cm-muted' }, 'Mermaid 架构图'),
              h('pre', { className: 'cm-code', style: { maxHeight: 220, overflow: 'auto' } }, view.overview.architecture.mermaid),
            ) : null,
            h('div', { className: 'cm-grid', style: { marginTop: 10 } },
              modules.map((module) => h('div', { key: module.moduleId, className: 'cm-card', style: { marginBottom: 0, background: 'var(--dsw-alias-bg-base)' } },
                h('div', { className: 'cm-row cm-between' }, h('strong', null, module.name), h(Confidence, { value: module.confidence })),
                h('p', { style: { marginTop: 4 } }, module.summary),
                h('div', { className: 'cm-muted' }, module.responsibility),
                h('div', { className: 'cm-row', style: { marginTop: 6 } },
                  module.startHere ? h(Btn, { small: true, onClick: () => openSource(module.startHere.file, module.startHere.line) }, '从这里开始') : null,
                  h(Btn, { small: true, variant: 'ghost', onClick: () => teach(module) }, teaching[module.moduleId]?.loading ? '生成中…' : '导师讲解'),
                ),
                teaching[module.moduleId]?.data ? h('div', { className: 'cm-review-block' },
                  h('div', { className: 'cm-row cm-between' }, h('strong', null, '导师讲解'), h(Confidence, { value: teaching[module.moduleId].data.confidence })),
                  h('p', null, teaching[module.moduleId].data.summary),
                  h('p', { className: 'cm-muted' }, teaching[module.moduleId].data.scenario),
                  teaching[module.moduleId].data.note ? h('div', { className: 'cm-muted' }, teaching[module.moduleId].data.note) : null,
                ) : null,
                teaching[module.moduleId]?.error ? h('div', { className: 'cm-warn' }, teaching[module.moduleId].error.message) : null,
              )),
            ),
            h('h3', { style: { marginTop: 14 } }, '核心发现与源码依据'),
            findings.map((finding) => h('div', { key: finding.id, className: 'cm-review-block' },
              h('div', { className: 'cm-row cm-between' }, h('strong', null, finding.title), h(Confidence, { value: finding.confidence })),
              h('p', { style: { marginTop: 4 } }, finding.text),
              finding.evidence?.[0] ? h('button', { type: 'button', className: 'cm-link', onClick: () => openSource(finding.evidence[0].file, finding.evidence[0].line) }, cite(finding.evidence[0])) : null,
            )),
            h('details', null,
              h('summary', { className: 'cm-muted' }, '全部证据状态与内部分析 claims'),
              (view.overview.claims || []).slice(0, 20).map((claim) => h('div', { key: claim.id, style: { padding: '4px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
                h('div', { className: 'cm-row cm-between' }, h('span', null, claim.text), h(Confidence, { value: claim.kind })),
                claim.evidence?.length ? h('div', { className: 'cm-mono' }, claim.evidence.slice(0, 3).map(cite).join('、')) : null,
              )),
            ),
          ),
        ),
      );
    }

    function LearnTab({ view, initialLessonId, openSource, startInterview, onRefresh }) {
      const lessons = view.lessons?.items || [];
      const [selected, setSelected] = useState(initialLessonId || lessons[0]?.lessonId || '');
      const [busy, setBusy] = useState('');
      const [error, setError] = useState(null);
      const [detail, setDetail] = useState('');
      const [ref, setRef] = useState('');
      const [showComplete, setShowComplete] = useState(false);
      const lesson = lessons.find((item) => item.lessonId === selected) || lessons[0] || null;

      useEffect(() => {
        if (initialLessonId) setSelected(initialLessonId);
      }, [initialLessonId]);
      useEffect(() => {
        if (lessons.length && !lessons.some((item) => item.lessonId === selected)) setSelected(lessons[0].lessonId);
      }, [lessons, selected]);

      const update = async (status) => {
        if (!lesson) return;
        setBusy(status);
        setError(null);
        try {
          await api('/api/codementor/lesson/update', {
            method: 'POST',
            body: { projectId: view.meta.projectId, lessonId: lesson.lessonId, status, detail, ref },
          });
          setShowComplete(false);
          setDetail('');
          setRef('');
          await onRefresh();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy('');
        }
      };

      return h('div', { className: 'cm-split' },
        h('div', { className: 'cm-side' },
          h('div', { className: 'cm-card' },
            h('h3', null, `学习路线（${view.lessons?.progress?.completed || 0}/${lessons.length} 完成）`),
            (view.lessons?.route || []).map((phase) => h('div', { key: phase.id, className: 'cm-row', style: { marginBottom: 4 } },
              h(Chip, { tone: phase.blocked ? 'warn' : '' }, phase.title),
              h('span', { className: 'cm-muted' }, phase.detail),
            )),
            lessons.map((item) => h('div', {
              key: item.lessonId,
              className: `cm-lesson${item.lessonId === lesson?.lessonId ? ' active' : ''}`,
              onClick: () => setSelected(item.lessonId),
              onKeyDown: (event) => { if (event.key === 'Enter') setSelected(item.lessonId); },
              role: 'button', tabIndex: 0,
            },
              h('div', { className: 'cm-row cm-between' },
                h('div', { className: 'cm-name' }, item.title),
                h(Chip, { tone: item.status === 'completed' ? 'ok' : '' }, item.status === 'completed' ? '已完成' : item.status === 'in_progress' ? '进行中' : item.priority),
              ),
              h('div', { className: 'cm-muted' }, `${item.estimatedMinutes} 分钟 · ${item.module?.role || ''}`),
            )),
          ),
        ),
        h('div', null,
          lesson ? h(React.Fragment, null,
            h('div', { className: 'cm-card' },
              h('div', { className: 'cm-row cm-between' },
                h('h2', { style: { margin: 0 } }, lesson.lessonTitle || lesson.title),
                h(Chip, null, lesson.priority),
              ),
              h('p', { style: { marginTop: 8 } }, lesson.why || lesson.whyLearn),
              h('div', { className: 'cm-chips' },
                ...lesson.prerequisites.map((item) => h(Chip, { key: item }, `前置：${item}`)),
                h(Chip, null, `${lesson.estimatedMinutes} 分钟`),
                lesson.capability ? h(Chip, { tone: lesson.capability.evidenceLevel === 'verified' ? 'ok' : 'warn' }, lesson.capability.title) : null,
              ),
              h('h4', null, '本课完成后能做什么'),
              h('p', null, lesson.expectedOutcome || lesson.learningObjectives?.[0] || ''),
              h('div', { className: 'cm-note' }, lesson.conceptExplanation || ''),
              h('ul', { className: 'cm-list' }, (lesson.learningObjectives || []).map((item, index) => h('li', { key: index }, item))),
            ),
            h('div', { className: 'cm-card' },
              h('h3', null, '动手步骤'),
              (lesson.walkthrough || []).map((step, index) => h('div', { key: `${step.kind}-${index}`, className: 'cm-step' },
                h('div', { className: 'cm-step-no' }, index + 1),
                h('div', { className: 'cm-step-body' },
                  h('div', { className: 'cm-row cm-between' }, h('strong', null, step.title), h(Chip, null, step.kind)),
                  h('p', { style: { marginTop: 3 } }, step.action),
                  step.expected ? h('div', { className: 'cm-muted' }, `预期：${step.expected}`) : null,
                  step.evidence?.length ? h('div', { className: 'cm-row', style: { marginTop: 3 } },
                    ...step.evidence.slice(0, 3).map((evidence) => h('button', { key: cite(evidence), type: 'button', className: 'cm-link', onClick: () => openSource(evidence.file, evidence.line) }, cite(evidence))),
                  ) : null,
                ),
              )),
              !lesson.walkthrough?.length ? h('div', null, lesson.steps.map((step, index) => h('div', { key: `${step.type}-${index}`, className: 'cm-step' },
                h('div', { className: 'cm-step-no' }, index + 1),
                h('div', { className: 'cm-step-body' },
                  h('strong', null, step.title),
                  step.content ? h('p', { style: { marginTop: 3 } }, step.content) : null,
                  step.prompt ? h('p', { style: { marginTop: 3 } }, step.prompt) : null,
                  step.instruction ? h('p', { style: { marginTop: 3 } }, step.instruction) : null,
                  step.target ? h('button', { type: 'button', className: 'cm-link', onClick: () => openSource(step.target.file, step.target.line) }, `打开 ${cite(step.target)}`) : null,
                ),
              ))) : null,
            ),
            h('div', { className: 'cm-grid-2' },
              h('div', { className: 'cm-card' },
                h('h3', null, '理解问题'),
                h('ul', { className: 'cm-list' }, (lesson.checkQuestions || []).map((item, index) => h('li', { key: index }, item))),
                h(Btn, { small: true, onClick: () => startInterview(lesson.module.name) }, '去面试间回答'),
              ),
              h('div', { className: 'cm-card' },
                h('h3', null, '最小任务'),
                h('p', null, lesson.microTask?.title || '按步骤完成一次观察与记录。'),
                h('div', { className: 'cm-muted' }, lesson.microTask?.action || ''),
                lesson.microTask?.acceptance ? h('div', { className: 'cm-note', style: { marginTop: 6 } }, `验收：${lesson.microTask.acceptance}`) : null,
                lesson.next ? h('div', { style: { marginTop: 8 } },
                  h(Btn, { small: true, onClick: () => lesson.next.type === 'lesson' ? setSelected(lesson.next.lessonId) : null }, lesson.next.type === 'lesson' ? `下一课：${lesson.next.title}` : '下一阶段：实践'),
                ) : null,
              ),
            ),
            h('div', { className: 'cm-card' },
              h('h3', null, '完成标准'),
              h('ul', { className: 'cm-list' }, (lesson.acceptance || lesson.completionCriteria || []).map((item, index) => h('li', { key: index }, item))),
              h('div', { className: 'cm-row', style: { marginTop: 10 } },
                h(Btn, { variant: 'primary', disabled: busy === 'in_progress', onClick: () => update('in_progress') }, lesson.status === 'in_progress' ? '继续学习' : '开始本课'),
                h(Btn, { onClick: () => setShowComplete((current) => !current) }, '标记完成'),
                h(Btn, { variant: 'ghost', onClick: () => openSource(lesson.startHere.file, lesson.startHere.line) }, '查看源码'),
                h(Btn, { variant: 'ghost', onClick: () => startInterview(lesson.module.name) }, '检测掌握程度'),
              ),
              showComplete ? h('div', { style: { marginTop: 10 } },
                h('p', { className: 'cm-muted' }, '完成需要实际依据：写下你解释了什么，并给出一个真实 file:line。只点按钮不会记为完成。'),
                h('input', { className: 'cm-input', style: { width: '100%', boxSizing: 'border-box', marginBottom: 6 }, placeholder: '例如：能解释 main→cmd_dispatch→rtc_set_time 的参数与失败路径', value: detail, onChange: (event) => setDetail(event.target.value) }),
                h('input', { className: 'cm-input', style: { width: '100%', boxSizing: 'border-box' }, placeholder: '依据位置，例如 Core/Src/main.c:249', value: ref, onChange: (event) => setRef(event.target.value) }),
                h('div', { className: 'cm-row', style: { marginTop: 6 } },
                  h(Btn, { variant: 'primary', disabled: busy === 'completed', onClick: () => update('completed') }, busy === 'completed' ? '保存中…' : '确认完成'),
                ),
              ) : null,
              h(ErrorBox, { error }),
            ),
          ) : h('div', { className: 'cm-card' }, h('p', null, '还没有课程。请刷新项目或重新扫描。')),
        ),
      );
    }

    function buildTree(nodes) {
      const root = { path: '', type: 'dir', children: [], depth: 0 };
      const map = new Map([['', root]]);
      for (const node of nodes) {
        const segments = node.path.split('/');
        const parentPath = segments.slice(0, -1).join('/');
        const parent = map.get(parentPath) || root;
        const item = { ...node, children: [] };
        parent.children.push(item);
        if (node.type === 'dir') map.set(node.path, item);
      }
      return root;
    }

    function TreeView({ nodes, expanded, onToggle, onOpen, selected }) {
      return h(React.Fragment, null,
        nodes.map((node) => node.type === 'dir'
          ? h('div', { key: node.path },
            h('button', { type: 'button', className: 'cm-tree-node', onClick: () => onToggle(node.path) },
              h('span', { className: 'cm-dir' }, expanded.has(node.path) ? '▾' : '▸'),
              h('span', { className: 'cm-tree-file' }, node.path.split('/').pop()),
            ),
            expanded.has(node.path)
              ? h('div', { style: { paddingLeft: 10 } }, h(TreeView, { nodes: node.children, expanded, onToggle, onOpen, selected }))
              : null,
          )
          : h('button', {
            key: node.path, type: 'button',
            className: `cm-tree-node${selected === node.path ? ' active' : ''}`,
            onClick: () => onOpen(node.path, 1),
            title: node.path,
          },
            h('span', { className: 'cm-dir' }, '·'),
            h('span', { className: 'cm-tree-file' }, node.path.split('/').pop()),
          )),
      );
    }

    function SourceTab({ view, projectId, target, openSource, onRefreshView, onBack, showToast }) {
      const [tree, setTree] = useState(null);
      const [treeError, setTreeError] = useState(null);
      const [expanded, setExpanded] = useState(new Set(['src']));
      const [query, setQuery] = useState('');
      const [file, setFile] = useState(null);
      const [fileError, setFileError] = useState(null);
      const [loading, setLoading] = useState(false);
      const [symbolInfo, setSymbolInfo] = useState(null);
      const [symbolError, setSymbolError] = useState(null);
      const [drawer, setDrawer] = useState('chain');
      const codeRef = useRef(null);
      const abortRef = useRef(null);

      const selectedPath = target?.file || file?.path || '';

      useEffect(() => {
        let cancelled = false;
        setTreeError(null);
        api(`/api/codementor/tree?projectId=${encodeURIComponent(projectId)}`)
          .then((data) => { if (!cancelled) setTree(data); })
          .catch((error) => { if (!cancelled) setTreeError(error); });
        return () => { cancelled = true; };
      }, [projectId]);

      const loadFile = useCallback(async (path, line) => {
        if (!path) return;
        if (abortRef.current) abortRef.current.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setLoading(true);
        setFileError(null);
        const focusLine = Math.max(1, Number(line) || 1);
        const start = Math.max(1, focusLine - 60);
        const end = start + 399;
        try {
          const data = await api(`/api/codementor/file?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}&start=${start}&end=${end}`, { signal: controller.signal });
          setFile(data);
        } catch (error) {
          if (error.name === 'AbortError') return;
          setFileError(error);
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
      }, [projectId]);

      useEffect(() => {
        if (target?.file) loadFile(target.file, target.line);
      }, [target?.file, target?.line, loadFile]);

      useEffect(() => {
        if (target?.file || file) return;
        const start = view.explorer?.startHere?.file || view.lessons?.items?.[0]?.startHere?.file;
        if (start) loadFile(start, 1);
      }, [target, file, view, loadFile]);

      useEffect(() => {
        const line = target?.line;
        if (!file || !line || !codeRef.current) return;
        const element = codeRef.current.querySelector(`[data-line="${line}"]`);
        if (element?.scrollIntoView) element.scrollIntoView({ block: 'center' });
      }, [file, target]);

      useEffect(() => {
        setExpanded((current) => {
          const next = new Set(current);
          for (const node of (tree?.nodes || []).filter((item) => item.type === 'dir' && item.depth === 1)) next.add(node.path);
          if (selectedPath) {
            const segments = selectedPath.split('/');
            for (let index = 1; index < segments.length; index += 1) next.add(segments.slice(0, index).join('/'));
          }
          return next;
        });
      }, [tree, selectedPath]);

      const open = (path, line) => {
        openSource(path, line || 1, target?.chainId ? { chainId: target.chainId } : {});
      };

      const loadMore = async () => {
        if (!file || !file.truncated) return;
        setLoading(true);
        try {
          const data = await api(`/api/codementor/file?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(file.path)}&start=${file.end + 1}&end=${file.end + 400}`);
          setFile((current) => current ? { ...data, lines: [...current.lines, ...data.lines], start: current.start } : data);
        } catch (error) {
          setFileError(error);
        } finally {
          setLoading(false);
        }
      };

      const search = (query || '').trim().toLowerCase();
      const filtered = useMemo(() => {
        if (!tree?.nodes) return [];
        if (!search) return null;
        return tree.nodes.filter((node) => node.type === 'file' && node.path.toLowerCase().includes(search)).slice(0, 80);
      }, [tree, search]);
      const symbolResults = useMemo(() => {
        if (!search) return [];
        const out = [];
        for (const module of view.explorer?.modules || []) {
          for (const symbol of module.symbols || []) {
            if (symbol.name.toLowerCase().includes(search)) out.push({ ...symbol, module: module.name });
            if (out.length >= 40) break;
          }
          if (out.length >= 40) break;
        }
        return out;
      }, [search, view]);

      const explainSymbol = async () => {
        setSymbolError(null);
        setSymbolInfo(null);
        const line = target?.line || 1;
        let found = null;
        for (const module of view.explorer?.modules || []) {
          for (const symbol of module.symbols || []) {
            if (symbol.file === selectedPath && symbol.line <= line && (symbol.endLine || symbol.line) >= line) {
              found = symbol;
              break;
            }
          }
          if (found) break;
        }
        if (!found) {
          setSymbolError(new Error('当前行没有可识别的函数符号；可先在上方搜索函数名。'));
          return;
        }
        try {
          const data = await api('/api/codementor/explain/function', {
            method: 'POST',
            body: { projectId, symbolId: found.id },
          });
          setSymbolInfo(data);
        } catch (error) {
          setSymbolError(error);
        }
      };

      const saveLearning = async () => {
        if (!selectedPath) return;
        try {
          await api('/api/codementor/learning/save', { method: 'POST', body: { projectId, file: selectedPath, line: target?.line || 1, note: '源码阅读' } });
          showToast('已加入学习');
          onRefreshView();
        } catch (error) {
          showToast(error.message);
        }
      };

      const treeRoot = tree ? buildTree(tree.nodes) : null;
      return h('div', null,
        h('div', { className: 'cm-row', style: { marginBottom: 10 } },
          h('input', {
            className: 'cm-input', style: { flex: '1 1 260px' },
            placeholder: '搜索文件或函数，例如 engine / cmd_dispatch',
            value: query, onChange: (event) => setQuery(event.target.value),
          }),
          h(Btn, { onClick: () => loadFile(selectedPath, target?.line || 1), disabled: !selectedPath }, '重新读取'),
          h(Btn, { variant: 'ghost', onClick: () => { onRefreshView(); } }, '刷新视图'),
          h(Btn, { variant: 'ghost', onClick: onBack }, '返回路线'),
        ),
        h('div', { className: 'cm-split' },
          h('div', { className: 'cm-side' },
            h('div', { className: 'cm-card' },
              h('h3', null, '文件'),
              treeError ? h(ErrorBox, { error: treeError, onRetry: () => setTree(null) }) : null,
              !tree && !treeError ? h('div', { className: 'cm-muted' }, '加载文件树…') : null,
              filtered
                ? h('div', null, filtered.map((node) => h('button', {
                  key: node.path, type: 'button',
                  className: `cm-tree-node${selectedPath === node.path ? ' active' : ''}`,
                  onClick: () => open(node.path, 1), title: node.path,
                }, node.path)))
                : treeRoot ? h(TreeView, {
                  nodes: treeRoot.children,
                  expanded,
                  selected: selectedPath,
                  onToggle: (path) => setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(path)) next.delete(path); else next.add(path);
                    return next;
                  }),
                  onOpen: open,
                }) : null,
              symbolResults.length ? h(React.Fragment, null,
                h('div', { className: 'cm-divider' }),
                h('h3', null, '函数命中'),
                symbolResults.map((symbol) => h('button', {
                  key: symbol.id || `${symbol.file}:${symbol.line}`,
                  type: 'button', className: 'cm-link', style: { display: 'block', padding: '3px 0' },
                  onClick: () => open(symbol.file, symbol.line),
                }, `${symbol.name} — ${symbol.file}:${symbol.line}`)),
              ) : null,
            ),
          ),
          h('div', { className: 'cm-main' },
            fileError ? h(ErrorBox, { error: fileError, onRetry: () => loadFile(selectedPath, target?.line) }) : null,
            loading ? h('div', { className: 'cm-card' }, h('p', { className: 'cm-muted' }, '读取源码…')) : null,
            file ? h('div', null,
              h('div', { className: 'cm-card' },
                h('div', { className: 'cm-row cm-between' },
                  h('div', null,
                    h('h2', { style: { margin: 0 } }, file.path),
                    h('div', { className: 'cm-muted' }, `${file.totalLines} 行 · ${file.lang} · ${file.size} 字节`),
                  ),
                  h('div', { className: 'cm-row' },
                    h(Btn, { small: true, onClick: explainSymbol }, '解释本函数'),
                    h(Btn, { small: true, onClick: saveLearning }, '加入学习'),
                    h(Btn, { small: true, variant: 'ghost', onClick: () => open(file.path, 1) }, '回到开头'),
                  ),
                ),
                file.stale ? h('div', { className: 'cm-warn', style: { marginTop: 8 } }, `${file.staleReason} 可点「重新读取」或「刷新项目」。`) : null,
              ),
              symbolError ? h('div', { className: 'cm-warn' }, symbolError.message) : null,
              symbolInfo?.ok ? h('div', { className: 'cm-card' },
                h('div', { className: 'cm-row cm-between' },
                  h('h3', { style: { margin: 0 } }, `函数：${symbolInfo.symbol.name}`),
                  h(Chip, { tone: symbolInfo.explanation?.source === 'model' ? 'ok' : 'warn' }, symbolInfo.explanation?.source === 'model' ? '导师语义解释' : '保守解释'),
                ),
                h('div', { className: 'cm-muted cm-mono' }, `${symbolInfo.symbol.file}:${symbolInfo.symbol.line}-${symbolInfo.symbol.endLine || symbolInfo.symbol.line}`),
                h('p', { style: { marginTop: 6 } }, symbolInfo.explanation?.oneLine),
                h('dl', { className: 'cm-kv' },
                  h('dt', null, '何时调用'), h('dd', null, symbolInfo.explanation?.when),
                  h('dt', null, '输入输出'), h('dd', null, symbolInfo.explanation?.inputOutput),
                  h('dt', null, '失败分支'), h('dd', null, symbolInfo.explanation?.failure),
                  h('dt', null, '副作用'), h('dd', null, symbolInfo.explanation?.sideEffects),
                  h('dt', null, '功能位置'), h('dd', null, symbolInfo.explanation?.relation),
                ),
                (symbolInfo.explanation?.steps || []).length ? h('div', null,
                  h('h4', null, '执行步骤'),
                  h('ul', { className: 'cm-list' }, symbolInfo.explanation.steps.map((step, index) => h('li', { key: index }, step))),
                ) : null,
                (symbolInfo.explanation?.uncertainties || []).length ? h('div', null,
                  h('h4', null, '待核实'),
                  h('ul', { className: 'cm-list' }, symbolInfo.explanation.uncertainties.map((item, index) => h('li', { key: index }, item))),
                ) : null,
                symbolInfo.explanation?.note ? h('div', { className: 'cm-note', style: { marginTop: 6 } }, symbolInfo.explanation.note) : null,
                symbolInfo.technical ? h('details', { style: { marginTop: 8 } },
                  h('summary', { className: 'cm-muted' }, '技术详情：调用方 / 被调用方'),
                  h('h4', null, `调用方（${symbolInfo.technical.callers.length}）`),
                  symbolInfo.technical.callers.slice(0, 10).map((caller) => h('button', { key: `${caller.file}:${caller.line}`, type: 'button', className: 'cm-link', onClick: () => open(caller.file, caller.line) }, `${caller.name} — ${caller.file}:${caller.line}`)),
                  h('h4', null, `被调用方（${symbolInfo.technical.callees.length}）`),
                  symbolInfo.technical.callees.slice(0, 10).map((callee) => h('button', { key: `${callee.file}:${callee.line}`, type: 'button', className: 'cm-link', onClick: () => open(callee.file, callee.line) }, `${callee.name} — ${callee.file}:${callee.line}`)),
                  symbolInfo.technical.capability ? h('div', { className: 'cm-muted' }, `功能节点：${symbolInfo.technical.capability.title}（${symbolInfo.technical.capability.evidenceLevel}）`) : null,
                ) : null,
              ) : null,
              h('div', { className: 'cm-code-wrap', ref: codeRef },
                h('pre', { className: 'cm-code' },
                  file.lines.map((line) => h('div', {
                    key: line.number,
                    className: `cm-line${target?.line === line.number ? ' highlight' : ''}`,
                    'data-line': line.number,
                  },
                    h('span', { className: 'ln' }, String(line.number)),
                    h('span', { className: 'tx' }, line.text),
                  )),
                ),
              ),
              file.truncated ? h('div', { className: 'cm-row', style: { marginTop: 5 } },
                h('span', { className: 'cm-muted' }, `已显示到第 ${file.end} 行，共 ${file.totalLines} 行`),
                h(Btn, { small: true, onClick: loadMore, disabled: loading }, loading ? '读取中…' : '继续读取后 400 行'),
              ) : null,
              h('div', { className: 'cm-card', style: { marginTop: 10 } },
                h('div', { className: 'cm-tabs', style: { paddingLeft: 0, marginBottom: 6 } },
                  ['chain', 'structure', 'saved'].map((id) => h('button', {
                    key: id, type: 'button', className: `cm-tab${drawer === id ? ' active' : ''}`,
                    onClick: () => setDrawer(id),
                  }, id === 'chain' ? '执行链路' : id === 'structure' ? '数据结构' : '学习收藏')),
                ),
                drawer === 'chain' ? h('div', null,
                  (view.explorer.chains || []).map((chain) => h('div', { key: chain.id, style: { marginBottom: 8 } },
                    h('div', { className: 'cm-row cm-between' },
                      h('strong', null, `${chain.start?.name || chain.name}`),
                      h(Chip, null, chain.confidence),
                    ),
                    (chain.primary || []).slice(0, 6).map((step) => h('button', {
                      key: `${step.step}-${step.to}`, type: 'button', className: 'cm-link', style: { display: 'block' },
                      onClick: () => open(step.file, step.line, { chainId: chain.id }),
                    }, `${step.step}. ${step.from} → ${step.to}（${cite({ file: step.file, line: step.line })}）`)),
                  )),
                ) : null,
                drawer === 'structure' ? h('div', null,
                  (view.explorer.structures || []).slice(0, 10).map((structure) => h('button', {
                    key: `${structure.file}:${structure.line}`, type: 'button', className: 'cm-link', style: { display: 'block' },
                    onClick: () => open(structure.file, structure.line),
                  }, `${structure.kind} ${structure.name} — ${structure.file}:${structure.line}（${structure.fields?.length || 0} 字段）`)),
                ) : null,
                drawer === 'saved' ? h('div', null,
                  (view.saved || []).length
                    ? view.saved.map((item) => h('button', {
                      key: `${item.file}:${item.line}`, type: 'button', className: 'cm-link', style: { display: 'block' },
                      onClick: () => open(item.file, item.line),
                    }, `${item.file}:${item.line} ${item.note || ''}`))
                    : h('div', { className: 'cm-muted' }, '还没有收藏。打开文件后点「加入学习」。'),
                ) : null,
              ),
            ) : h('div', { className: 'cm-card' }, h('p', { className: 'cm-muted' }, '从左侧选择一个文件开始阅读。')),
          ),
        ),
      );
    }

    function PracticeTab({ view, openSource, showToast }) {
      const stages = view.practice.stages || [];
      const [stageId, setStageId] = useState(view.practice.defaultStage || stages[0]?.stage || 'A');
      const stage = stages.find((item) => item.stage === stageId) || stages[0] || null;
      const [candidateId, setCandidateId] = useState('');
      const candidate = (stage?.candidates || []).find((item) => item.id === candidateId) || (stage?.candidates || [])[0] || null;
      const [answer, setAnswer] = useState('');
      const [review, setReview] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);

      useEffect(() => { setCandidateId(''); setReview(null); setAnswer(''); }, [stageId, view.meta.projectId]);

      const submitReview = async () => {
        if (!stage) return;
        setBusy(true);
        setError(null);
        try {
          const data = await api('/api/codementor/practice/review', {
            method: 'POST',
            body: { projectId: view.meta.projectId, taskId: candidate?.id || stage.id, answer },
          });
          setReview(data);
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      };

      const entry = candidate?.target || stage?.codeEntry || stage?.steps?.flatMap((step) => step.evidence || [])[0] || null;
      return h('div', { className: 'cm-split' },
        h('div', { className: 'cm-side' },
          h('div', { className: 'cm-card' },
            h('h3', null, '实践路径：观察 → 定位 → 复现 → 小改 → 验证'),
            stages.map((item) => h('div', {
              key: item.stage,
              className: `cm-lesson${item.stage === stageId ? ' active' : ''}`,
              onClick: () => setStageId(item.stage),
              role: 'button', tabIndex: 0,
            },
              h('div', { className: 'cm-row cm-between' },
                h('div', { className: 'cm-name' }, `${item.stage} · ${item.stageTitle}`),
                item.blocked ? h(Chip, { tone: 'warn' }, '阻塞') : null,
              ),
              h('div', { className: 'cm-muted' }, item.title),
            )),
            h('p', { className: 'cm-muted', style: { marginTop: 6 } }, view.practice.note),
          ),
          (stage?.candidates || []).length ? h('div', { className: 'cm-card' },
            h('h3', null, '候选改动（需先核实）'),
            stage.candidates.map((item) => h('div', {
              key: item.id,
              className: `cm-lesson${candidate?.id === item.id ? ' active' : ''}`,
              onClick: () => setCandidateId(item.id),
              role: 'button', tabIndex: 0,
            },
              h('div', { className: 'cm-name' }, item.title),
              h('div', { className: 'cm-row' }, h(Chip, null, item.kind), h(Confidence, { value: item.confidence })),
            )),
          ) : null,
        ),
        h('div', { className: 'cm-main' },
          stage ? h('div', { className: 'cm-card' },
            h('div', { className: 'cm-row cm-between' },
              h('h2', { style: { margin: 0 } }, `${stage.stage} · ${stage.title}`),
              h('span', { className: 'cm-row' },
                h(Chip, null, stage.readOnly ? '只读' : '需要授权'),
                stage.confidence ? h(Confidence, { value: stage.confidence }) : null,
              ),
            ),
            stage.blocked ? h('div', { className: 'cm-warn', style: { marginTop: 8 } }, `本阶段受阻：${stage.blockedReason || '环境或证据不足'}`) : null,
            h('p', { style: { marginTop: 8 } }, stage.scenario),
            h('h4', null, '前置条件'),
            h('ul', { className: 'cm-list' }, (stage.prerequisites || []).map((item, index) => h('li', { key: index }, item))),
            h('h4', null, '操作步骤'),
            (stage.steps || []).map((step, index) => h('div', { key: index, className: 'cm-step' },
              h('div', { className: 'cm-step-no' }, index + 1),
              h('div', { className: 'cm-step-body' },
                h('strong', null, step.action),
                h('div', { className: 'cm-muted' }, `预期：${step.expected}`),
                step.evidence?.length ? h('div', { className: 'cm-row', style: { marginTop: 3 } },
                  ...step.evidence.slice(0, 4).map((evidence) => h('button', { key: cite(evidence), type: 'button', className: 'cm-link', onClick: () => openSource(evidence.file, evidence.line) }, cite(evidence))),
                ) : null,
              ),
            )),
            h('h4', null, '常见问题'),
            h('ul', { className: 'cm-list' }, (stage.pitfalls || []).map((item, index) => h('li', { key: index }, item))),
            h('h4', null, '验收标准'),
            h('ul', { className: 'cm-list' }, (stage.acceptance || []).map((item, index) => h('li', { key: index }, item))),
            candidate ? h('div', { className: 'cm-review-block' },
              h('div', { className: 'cm-row cm-between' }, h('strong', null, candidate.title), h(Confidence, { value: candidate.confidence })),
              h('p', { className: 'cm-muted' }, candidate.objective || ''),
              candidate.evidence?.length ? h('div', null, candidate.evidence.slice(0, 4).map((evidence) => h('button', { key: cite(evidence), type: 'button', className: 'cm-link', style: { display: 'block' }, onClick: () => openSource(evidence.file, evidence.line) }, cite(evidence)))) : null,
            ) : null,
            entry ? h('div', { className: 'cm-row', style: { marginTop: 8 } },
              h(Btn, { small: true, onClick: () => openSource(entry.file, entry.line) }, '打开入口源码'),
            ) : null,
            h('h4', { style: { marginTop: 12 } }, '提交你的观察/解释'),
            h('textarea', {
              className: 'cm-textarea', value: answer,
              placeholder: '记录真实输入/输出、源码依据、你确认和仍然待核实的部分；没有运行就明确写环境阻塞。',
              onChange: (event) => setAnswer(event.target.value),
            }),
            h('div', { className: 'cm-row', style: { marginTop: 6 } },
              h(Btn, { variant: 'primary', disabled: busy || answer.trim().length < 10, onClick: submitReview }, busy ? '评审中…' : '请求导师评审'),
              h(Btn, { variant: 'ghost', onClick: () => { if (entry) openSource(entry.file, entry.line); } }, '查看源码'),
            ),
            h(ErrorBox, { error }),
            review ? h('div', { className: 'cm-review-block' },
              h('div', { className: 'cm-row cm-between' },
                h('strong', null, '导师评审'),
                h(Chip, { tone: review.semantic ? 'ok' : 'warn' }, review.semantic ? '语义评审' : '规则提示'),
              ),
              review.semantic ? h('pre', { className: 'cm-code', style: { whiteSpace: 'pre-wrap', padding: 8 } }, review.text) : h('div', null,
                h('p', { className: 'cm-muted' }, review.note || '当前无法调用语义评审，请按清单自检。'),
                h('ul', { className: 'cm-list' }, (review.checklist || []).map((item) => h('li', { key: item }, item))),
              ),
            ) : null,
            !stage.readOnly ? h('div', { className: 'cm-note', style: { marginTop: 8 } }, '真正修改/执行验证请在对话中使用 codementor_practice，并显式授权 authorized=true；面板不会自动改仓库或执行命令。') : null,
          ) : h('div', { className: 'cm-card' }, h('p', { className: 'cm-muted' }, '选择左侧阶段查看任务。')),
        ),
      );
    }

    function ReviewPanel({ review, onOpenSource }) {
      if (!review) return null;
      const dims = review.dimensions || {};
      const labels = { technicalAccuracy: '技术准确性', sourceGrounding: '源码依据', engineeringTradeoffs: '工程取舍', communication: '表达清晰度' };
      const decisions = { followup: '继续追问', clarify: '请补充', next: '进入下一题', finish: '结束本轮' };
      return h('div', { className: 'cm-review-block' },
        h('div', { className: 'cm-row cm-between' },
          h('strong', null, '面试官点评'),
          h('span', { className: 'cm-row' },
            h(Chip, { tone: review.semantic ? 'ok' : 'warn' }, review.semantic ? '语义评审' : '规则诊断'),
            h(Chip, null, decisions[review.decision] || review.decision),
          ),
        ),
        Object.keys(labels).map((key) => h('div', { key, style: { marginTop: 6 } },
          h('div', { className: 'cm-row cm-between' }, h('span', { className: 'cm-muted' }, labels[key]), h('span', { className: 'cm-muted' }, `${Number(dims[key] || 0).toFixed(1)} / 5`)),
          h('div', { className: 'cm-bar' }, h('i', { style: { width: `${Math.min(100, (Number(dims[key] || 0) / 5) * 100)}%` } })),
        )),
        review.overallComment ? h('p', { style: { marginTop: 8 } }, review.overallComment) : null,
        review.correctPoints?.length ? h('div', null, h('h4', null, '答对的部分'), h('ul', { className: 'cm-list' }, review.correctPoints.map((item) => h('li', { key: item }, item)))) : null,
        review.incorrectPoints?.length ? h('div', null, h('h4', null, '需要纠正'), review.incorrectPoints.map((item, index) => h('div', { key: index, className: 'cm-warn' },
          h('div', null, item.claim),
          h('div', null, `错因：${item.whyIncorrect}`),
          item.file ? h('button', { type: 'button', className: 'cm-link', onClick: () => onOpenSource(item.file, item.line || 1) }, cite(item)) : null,
        ))) : null,
        review.missingPoints?.length ? h('div', null, h('h4', null, '遗漏的重点'), h('ul', { className: 'cm-list' }, review.missingPoints.map((item) => h('li', { key: item }, item)))) : null,
        review.uncertainties?.length ? h('div', null, h('h4', null, '需要核对'), h('ul', { className: 'cm-list' }, review.uncertainties.map((item) => h('li', { key: item }, item)))) : null,
        review.evidence?.length ? h('div', null, h('h4', null, '可核对源码'), review.evidence.map((item) => h('button', { key: cite(item), type: 'button', className: 'cm-link', style: { display: 'block' }, onClick: () => onOpenSource(item.file, item.line) }, cite(item)))) : null,
        h('div', { className: 'cm-note', style: { marginTop: 8 } }, review.reviewerNote || ''),
        (review.improvedAnswer?.concise || review.improvedAnswer?.detailed)
          ? h('details', { style: { marginTop: 8 } },
            h('summary', { className: 'cm-link' }, '展开推荐回答（回答后可见）'),
            review.improvedAnswer.concise ? h('div', null, h('h4', null, '1 分钟版'), h('p', null, review.improvedAnswer.concise)) : null,
            review.improvedAnswer.detailed ? h('div', null, h('h4', null, '深入版'), h('p', null, review.improvedAnswer.detailed)) : null,
            h('div', { className: 'cm-muted' }, '推荐回答是面试官建议，引用位置仍应回到源码核对。'),
          )
          : null,
      );
    }

    function InterviewTab({ view, projectId, presetFocus, openSource, onRefreshView }) {
      const [session, setSession] = useState(view.interview || null);
      const [difficulty, setDifficulty] = useState(view.interview?.difficulty || 'mid');
      const [focus, setFocus] = useState(presetFocus || view.interview?.focus || '');
      const [maxQuestions, setMaxQuestions] = useState(view.interview?.maxQuestions || 5);
      const [answer, setAnswer] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [review, setReview] = useState(null);
      const [next, setNext] = useState(null);
      const [pendingTurn, setPendingTurn] = useState('');
      const [startedAt, setStartedAt] = useState(0);

      useEffect(() => { if (presetFocus) setFocus(presetFocus); }, [presetFocus]);
      useEffect(() => {
        if (!view.interview?.sessionId) return;
        if (!session?.sessionId || view.interview.sessionId !== session.sessionId) setSession(view.interview);
      }, [view.interview?.sessionId, session?.sessionId]);
      useEffect(() => {
        const current = session?.current;
        if (!current) { setAnswer(''); return; }
        const draft = storageGet(`codementor.draft.${projectId}.${session.sessionId}.${current.questionId}`, '');
        setAnswer(draft);
      }, [session?.current?.questionId, projectId, session?.sessionId]);

      const start = async () => {
        setBusy(true);
        setError(null);
        try {
          const data = await api('/api/codementor/interview/start', {
            method: 'POST',
            body: { projectId, difficulty, focus, maxQuestions },
          });
          setSession(data.session);
          setReview(null);
          setNext(null);
          setAnswer('');
          setStartedAt(Date.now());
          onRefreshView();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      };

      const submit = async () => {
        if (!session?.current || answer.trim().length < 2) return;
        const id = pendingTurn || turnId();
        setPendingTurn(id);
        setBusy(true);
        setError(null);
        try {
          const data = await api('/api/codementor/interview/answer', {
            method: 'POST',
            body: { projectId, sessionId: session.sessionId, turnId: id, answer },
          });
          setReview(data.review);
          setNext(data.next);
          setSession(data.view);
          setAnswer('');
          setPendingTurn('');
          storageSet(`codementor.draft.${projectId}.${session.sessionId}.${session.current?.questionId}`, null);
          onRefreshView();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      };

      const finish = async () => {
        setBusy(true);
        setError(null);
        try {
          const data = await api('/api/codementor/interview/finish', { method: 'POST', body: { projectId } });
          setSession(data.view);
          onRefreshView();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      };

      const updateDraft = (value) => {
        setAnswer(value);
        if (session?.current) storageSet(`codementor.draft.${projectId}.${session.sessionId}.${session.current.questionId}`, value);
      };

      const reviewer = view.meta.reviewer || session?.reviewer || null;
      if (!session || session.status === 'idle') {
        return h('div', { className: 'cm-card' },
          h('h2', null, '模拟面试'),
          h('p', { className: 'cm-muted' }, '选择目标和难度后开始。回答前不会看到参考答案或评分要点；每答完一题，面试官会基于你的原话点评，并决定追问、补充或下一题。'),
          reviewer ? h('div', { className: reviewer.semanticAvailable ? 'cm-note' : 'cm-warn', style: { marginBottom: 8 } }, reviewer.note) : null,
          h('div', { className: 'cm-row', style: { marginTop: 10 } },
            h('label', { className: 'cm-row' }, h('span', { className: 'cm-muted' }, '难度'),
              h('select', { className: 'cm-select', value: difficulty, onChange: (event) => setDifficulty(event.target.value) },
                h('option', { value: 'junior' }, '初级'),
                h('option', { value: 'mid' }, '中级'),
                h('option', { value: 'senior' }, '高级'),
              )),
            h('label', { className: 'cm-row' }, h('span', { className: 'cm-muted' }, '目标'),
              h('select', { className: 'cm-select', value: focus, onChange: (event) => setFocus(event.target.value) },
                (session?.setup?.focuses || [{ id: '', label: '项目整体' }]).map((item) => h('option', { key: item.id, value: item.id }, item.label)),
              )),
            h('label', { className: 'cm-row' }, h('span', { className: 'cm-muted' }, '题数'),
              h('input', { className: 'cm-input', type: 'number', min: 1, max: 12, value: maxQuestions, onChange: (event) => setMaxQuestions(Number(event.target.value) || 5), style: { width: 64 } }),
            ),
            h(Btn, { variant: 'primary', disabled: busy, onClick: start }, busy ? '准备中…' : '开始模拟面试'),
          ),
          h(ErrorBox, { error }),
          session?.turns?.length ? h('div', { style: { marginTop: 12 } }, h(ReviewHistory, { turns: session.turns, openSource })) : null,
        );
      }

      if (session.status === 'finished') {
        return h('div', null,
          h('div', { className: 'cm-card' },
            h('div', { className: 'cm-row cm-between' },
              h('h2', { style: { margin: 0 } }, '本轮面试结束'),
              h(Btn, { onClick: start }, '再来一轮'),
            ),
            session.report ? h('div', null,
              h('div', { className: 'cm-chips' }, (session.report.scores || []).map((score) => h(Chip, { key: score.key }, `${score.label} ${score.average}/5`))),
              h('p', { className: 'cm-muted' }, session.report.recommendation),
              session.report.evidence?.length ? h('div', null, h('h4', null, '建议回看'), session.report.evidence.map((item) => h('button', { key: cite(item), type: 'button', className: 'cm-link', style: { display: 'block' }, onClick: () => openSource(item.file, item.line) }, cite(item)))) : null,
            ) : h('p', { className: 'cm-muted' }, '本轮没有回答记录。'),
          ),
          h(ReviewHistory, { turns: session.turns, openSource }),
        );
      }

      const current = next || session.current;
      const progress = `${session.turn}/${session.maxQuestions}`;
      return h('div', null,
        h('div', { className: 'cm-card' },
          h('div', { className: 'cm-row cm-between' },
            h('div', null,
              h('h2', { style: { margin: 0 } }, `第 ${session.turn} 题`),
              h('div', { className: 'cm-muted' }, `${session.difficultyLabel} · ${session.focus || '项目整体'} · 基础题 ${progress}`),
            ),
            h('div', { className: 'cm-row' },
              h(Btn, { small: true, variant: 'ghost', onClick: finish, disabled: busy }, '结束本轮'),
            ),
          ),
          current ? h(React.Fragment, null,
            h('p', { style: { fontSize: 14, lineHeight: 1.7, marginTop: 10 } }, current.prompt),
            current.why ? h('div', { className: 'cm-muted' }, `为什么问：${current.why}`) : null,
            h('div', { className: 'cm-chips' },
              h(Chip, null, current.kind === 'base' ? '基础题' : '追问'),
              h(Chip, null, current.dimension),
              h(Chip, null, current.difficulty),
            ),
            h('textarea', {
              className: 'cm-textarea', value: answer, disabled: busy,
              placeholder: '用中文写下你的回答；Ctrl+Enter 提交，Enter 换行。回答前不会显示参考答案。',
              onChange: (event) => updateDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  submit();
                }
              },
            }),
            h('div', { className: 'cm-row', style: { marginTop: 6 } },
              h(Btn, { variant: 'primary', disabled: busy || answer.trim().length < 2, onClick: submit }, busy ? '评审中…' : '提交回答'),
              h('span', { className: 'cm-muted' }, '提交后才会显示点评与推荐回答。'),
            ),
            h(ErrorBox, { error, onRetry: submit }),
            review ? h(ReviewPanel, { review, onOpenSource: openSource }) : null,
            next ? h('div', { className: 'cm-note', style: { marginTop: 8 } }, '已根据本题回答进入下一问。', ) : null,
          ) : h('p', { className: 'cm-muted' }, '当前没有题目，结束本轮或重新开始。'),
        ),
        session.turns?.length ? h(ReviewHistory, { turns: session.turns, openSource }) : null,
      );
    }

    function ReviewHistory({ turns, openSource }) {
      if (!turns?.length) return null;
      return h('div', { className: 'cm-card' },
        h('h3', null, '问答记录'),
        turns.map((turn, index) => h('details', { key: turn.turnId, style: { marginBottom: 8 } },
          h('summary', { className: 'cm-muted' }, `第 ${index + 1} 问：${fmt(turn.prompt)}`),
          h('div', { style: { marginTop: 6 } },
            h('div', { className: 'cm-muted' }, '你的回答'),
            h('p', null, turn.answer),
            h(ReviewPanel, { review: turn.review, onOpenSource: openSource }),
          ),
        )),
      );
    }

    /* ------------------------------------------------------------------ app */

    function App() {
      const [projects, setProjects] = useState([]);
      const [projectId, setProjectId] = useState(() => storageGet(STORAGE_PROJECT, ''));
      const [view, setView] = useState(null);
      const [phase, setPhase] = useState('booting');
      const [error, setError] = useState(null);
      const [tab, setTab] = useState('home');
      const [busy, setBusy] = useState(false);
      const [importOpen, setImportOpen] = useState(false);
      const [importError, setImportError] = useState(null);
      const [sourceTarget, setSourceTarget] = useState(null);
      const [lessonTarget, setLessonTarget] = useState('');
      const [interviewPreset, setInterviewPreset] = useState('');
      const loadRef = useRef(0);
      const { toast, show } = useToast();

      const fetchProjects = useCallback(async () => {
        const data = await api('/api/codementor/projects');
        setProjects(data.projects || []);
        return data.projects || [];
      }, []);

      const loadProject = useCallback(async (id) => {
        if (!id) return;
        const token = ++loadRef.current;
        setPhase((current) => current === 'ready' ? current : 'loading');
        setError(null);
        try {
          const data = await api(`/api/codementor/project?id=${encodeURIComponent(id)}`);
          if (token !== loadRef.current) return;
          setView(data.view);
          setProjectId(id);
          storageSet(STORAGE_PROJECT, id);
          setPhase('ready');
        } catch (caught) {
          if (token !== loadRef.current) return;
          setError(caught);
          setPhase('error');
        }
      }, []);

      useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const list = await api('/api/codementor/projects');
            if (cancelled) return;
            setProjects(list.projects || []);
            const saved = storageGet(STORAGE_PROJECT, '');
            const next = list.projects?.find((item) => item.id === saved)?.id || list.projects?.[0]?.id || '';
            if (next) await loadProject(next);
            else setPhase('empty');
          } catch (caught) {
            if (!cancelled) { setError(caught); setPhase('error'); }
          }
        })();
        return () => { cancelled = true; };
      }, [loadProject]);

      const importProject = async (path) => {
        setBusy(true);
        setError(null);
        setImportError(null);
        try {
          const data = await api('/api/codementor/projects/scan', { method: 'POST', body: { path } });
          await fetchProjects();
          setSourceTarget(null);
          setLessonTarget('');
          setTab('home');
          setView(data.view);
          setProjectId(data.project.id);
          storageSet(STORAGE_PROJECT, data.project.id);
          setPhase('ready');
          setImportOpen(false);
          setImportError(null);
          show('项目已导入并完成扫描');
        } catch (caught) {
          setImportError(caught);
        } finally {
          setBusy(false);
        }
      };

      const refreshProject = async () => {
        if (!projectId) return;
        setBusy(true);
        setError(null);
        try {
          const data = await api('/api/codementor/project/refresh', { method: 'POST', body: { projectId } });
          setView(data.view);
          await fetchProjects();
          show('项目已刷新');
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      };

      const reloadView = useCallback(async () => {
        if (!projectId) return;
        try {
          const data = await api(`/api/codementor/project?id=${encodeURIComponent(projectId)}`);
          setView(data.view);
        } catch {
          /* keep current view; the next action will surface the error */
        }
      }, [projectId]);

      const openSource = (file, line, extra = {}) => {
        if (!file) return;
        setSourceTarget({ file, line: line || 1, at: Date.now(), ...extra });
        setTab('source');
      };

      const startLesson = (lessonId) => {
        setLessonTarget(lessonId || '');
        setTab('learn');
      };

      const startInterview = (focus) => {
        setInterviewPreset(focus || '');
        setTab('interview');
      };

      const switchProject = (id) => {
        if (!id || id === projectId) return;
        setView(null);
        setSourceTarget(null);
        setLessonTarget('');
        setInterviewPreset('');
        setTab('home');
        setPhase('loading');
        loadProject(id);
      };

      const tabs = [
        ['home', '首页'],
        ['learn', '学习路线'],
        ['source', '源码'],
        ['practice', '实践'],
        ['interview', '面试'],
      ];

      let content;
      if (phase === 'booting' || phase === 'loading') {
        content = h('div', { className: 'cm-empty' }, '正在加载项目…');
      } else if (phase === 'empty' || (!projects.length && !view)) {
        content = h(Welcome, { projects, onImport: importProject, busy, error: importError || (phase === 'error' ? error : null) });
      } else if (phase === 'error' && !view) {
        content = h('div', { className: 'cm-body' },
          h(ErrorBox, { error, onRetry: () => loadProject(projectId || projects[0]?.id) }),
        );
      } else if (view) {
        content = h('div', { className: 'cm-body', key: projectId },
          error ? h(ErrorBox, { error, onRetry: reloadView }) : null,
          tab === 'home' ? h(HomeTab, { view, openSource, startLesson, startInterview }) : null,
          tab === 'learn' ? h(LearnTab, { view, initialLessonId: lessonTarget, openSource, startInterview, onRefresh: reloadView }) : null,
          tab === 'source' ? h(SourceTab, { view, projectId, target: sourceTarget, openSource, onRefreshView: reloadView, onBack: () => setTab('learn'), showToast: show }) : null,
          tab === 'practice' ? h(PracticeTab, { view, openSource, showToast: show }) : null,
          tab === 'interview' ? h(InterviewTab, { view, projectId, presetFocus: interviewPreset, openSource, onRefreshView: reloadView }) : null,
        );
      } else {
        content = h(Welcome, { projects, onImport: importProject, busy, error: importError || error });
      }

      return h('section', { className: 'cm-panel' },
        h('style', null, css),
        h('div', { className: 'cm-header' },
          h('div', { className: 'cm-brand' },
            h('strong', null, 'CodeMentor'),
            h('span', { className: 'cm-sub' }, view ? `${view.meta.name} · ${view.meta.commit ? String(view.meta.commit).slice(0, 8) : 'no-git'}${view.meta.dirty ? ' · 有未提交改动' : ''}` : '项目源码学习与工程训练'),
          ),
          projects.length
            ? h('select', {
              className: 'cm-select', value: projectId, 'aria-label': '切换项目',
              onChange: (event) => switchProject(event.target.value),
            }, projects.map((project) => h('option', { key: project.id, value: project.id }, project.name)))
            : null,
          h('div', { className: 'cm-actions' },
            h(Btn, { small: true, onClick: () => setImportOpen((current) => !current) }, '导入项目'),
            h(Btn, { small: true, onClick: refreshProject, disabled: !projectId || busy }, busy ? '刷新中…' : '刷新项目'),
          ),
        ),
        importOpen ? h(ImportBar, {
          onImport: importProject,
          busy,
          error: importError,
          onClose: () => setImportOpen(false),
        }) : null,
        view ? h('div', { className: 'cm-tabs' }, tabs.map(([id, label]) => h('button', {
          key: id, type: 'button', className: `cm-tab${tab === id ? ' active' : ''}`, onClick: () => setTab(id),
        }, label))) : null,
        content,
        h('div', { className: 'cm-footer' },
          h('span', null, view?.meta?.updatedAt ? `分析于 ${String(view.meta.updatedAt).slice(0, 16).replace('T', ' ')}` : '尚未分析项目'),
          view?.meta?.stale?.claims ? h('span', null, `${view.meta.stale.claims} 条结论需要刷新`) : null,
          h('span', null, '面板只读缓存；导入与刷新会真实扫描，不会修改仓库'),
        ),
        toast ? h('div', { className: 'cm-toast', role: 'status' }, toast) : null,
      );
    }

    function PanelIcon({ size = 20, active = false }) {
      const color = active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)';
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('path', { d: 'M9 6L4.5 12 9 18', stroke: color, strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M15 6l4.5 6L15 18', stroke: color, strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M12 15c0-4 2-5 4-7', stroke: 'var(--dsw-alias-state-success-primary)', strokeWidth: 1.6, strokeLinecap: 'round' }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 24, label: 'CodeMentor',
        }, PanelIcon));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID,
        }, App));
      },
    };
  },
});
