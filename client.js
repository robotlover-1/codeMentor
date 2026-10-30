/**
 * CodeMentor Web panel.
 *
 * Read-only projection of the Host cache: the page never scans the filesystem
 * and never executes commands. Learning actions stay in the conversation through
 * the codementor_* tools; this panel is the map and the report.
 */

window.__ModuleLoader__.load({
  id: '@local/codementor',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    const PANEL_ID = 'codementor';
    const API = '/api/codementor/project';

    const css = `
      .cm-panel {
        height: 100%; min-height: 0; display: flex; flex-direction: column;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit;
      }
      .cm-header {
        display: flex; align-items: center; gap: 10px; padding: 11px 16px 9px;
        border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); flex: 0 0 auto;
        flex-wrap: wrap;
      }
      .cm-title { display: flex; flex-direction: column; gap: 1px; min-width: 180px; }
      .cm-title strong { font-size: 15px; font-weight: 650; letter-spacing: .01em; }
      .cm-sub { color: var(--dsw-alias-label-secondary); font-size: 11px; overflow-wrap: anywhere; }
      .cm-project {
        margin-left: 6px; max-width: 260px; font: inherit; font-size: 11.5px; padding: 5px 7px;
        border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
      }
      .cm-actions { margin-left: auto; display: flex; gap: 6px; align-items: center; }
      .cm-btn {
        border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 5px 9px;
        font: inherit; font-size: 11.5px; cursor: pointer;
      }
      .cm-btn:hover { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay); }
      .cm-btn:disabled { opacity: .55; cursor: default; }
      .cm-btn.is-active { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
      .cm-btn:focus-visible, .cm-tab:focus-visible, .cm-card:focus-visible, .cm-row:focus-visible,
      .cm-task:focus-visible, .cm-symbol:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .cm-tabs {
        display: flex; gap: 4px; padding: 7px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-base); overflow-x: auto; flex: 0 0 auto;
      }
      .cm-tab {
        border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary);
        padding: 5px 9px; border-radius: 7px; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
      }
      .cm-tab:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .cm-tab.is-active { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l1); }
      .cm-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 14px 16px 28px; }
      .cm-empty { display: grid; place-items: center; min-height: 56vh; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 13px; padding: 24px; }
      .cm-empty code { color: var(--dsw-alias-brand-primary); }
      .cm-note {
        font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary);
        border-left: 2px solid var(--dsw-alias-border-l2); padding-left: 9px;
      }
      .cm-error { color: var(--dsw-alias-state-error-primary); font-size: 12.5px; line-height: 1.6; }
      .cm-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 2px; }
      .cm-chip {
        border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
        border-radius: 999px; padding: 3px 8px; font-size: 10.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap;
      }
      .cm-chip b { color: var(--dsw-alias-label-primary); font-weight: 650; }
      .cm-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(260px, 1fr); gap: 14px; align-items: start; }
      .cm-grid-2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; align-items: start; }
      @media (max-width: 940px) { .cm-grid, .cm-grid-2 { grid-template-columns: minmax(0, 1fr); } }
      .cm-card {
        border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
        border-radius: 11px; padding: 11px 12px; margin-bottom: 12px; min-width: 0;
      }
      .cm-card h3 { margin: 0 0 7px; font-size: 12px; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); font-weight: 650; }
      .cm-card h4 { margin: 10px 0 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .cm-card p { margin: 0 0 6px; font-size: 12.5px; line-height: 1.6; overflow-wrap: anywhere; }
      .cm-lead { font-size: 13.5px; line-height: 1.6; }
      .cm-mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; overflow-wrap: anywhere; }
      .cm-pre {
        margin: 7px 0 0; padding: 9px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
        background: var(--dsw-alias-bg-base); overflow: auto; max-height: 220px; font-size: 10.8px; line-height: 1.5; white-space: pre;
          color: var(--dsw-alias-label-secondary);
      }
      .cm-list { display: flex; flex-direction: column; gap: 6px; }
      .cm-row {
        display: flex; flex-direction: column; gap: 3px; text-align: left; width: 100%;
        border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base);
        color: inherit; border-radius: 8px; padding: 7px 9px; font: inherit; cursor: default;
      }
      .cm-row.is-clickable { cursor: pointer; }
      .cm-row.is-clickable:hover { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
      .cm-row.is-active { border-color: var(--dsw-alias-brand-primary); }
      .cm-row-head { display: flex; align-items: center; gap: 6px; justify-content: space-between; }
      .cm-row-name { font-size: 12.5px; font-weight: 600; overflow-wrap: anywhere; }
      .cm-row-sub { font-size: 10.8px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
      .cm-badge {
        font-size: 9.5px; line-height: 1; letter-spacing: .05em; text-transform: uppercase;
        border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary);
        border-radius: 999px; padding: 3px 5px; white-space: nowrap;
      }
      .cm-badge.p0 { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .cm-badge.p1 { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
      .cm-badge.p2 { color: var(--dsw-alias-label-secondary); }
      .cm-badge.source { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .cm-badge.doc { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
      .cm-badge.inference { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
      .cm-badge.unverified, .cm-badge.stale { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .cm-badge.ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .cm-bar { height: 4px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; margin-top: 2px; }
      .cm-bar > i { display: block; height: 100%; background: var(--dsw-alias-brand-primary); }
      .cm-kv { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 4px 9px; font-size: 11.5px; }
      .cm-kv dt { color: var(--dsw-alias-label-secondary); }
      .cm-kv dd { margin: 0; overflow-wrap: anywhere; }
      .cm-steps { display: flex; flex-direction: column; gap: 5px; }
      .cm-step {
        border-left: 2px solid var(--dsw-alias-brand-primary); padding: 3px 0 3px 8px;
        font-size: 11.5px; line-height: 1.5; overflow-wrap: anywhere;
      }
      .cm-step .cm-from { color: var(--dsw-alias-label-secondary); }
      .cm-code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; }
      .cm-split { display: flex; gap: 14px; align-items: flex-start; }
      .cm-col { flex: 0 0 260px; min-width: 0; }
      .cm-col-main { flex: 1 1 auto; min-width: 0; }
      @media (max-width: 860px) { .cm-split { flex-direction: column; } .cm-col { flex-basis: auto; width: 100%; } }
      .cm-symbol { border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; padding: 5px 7px; background: var(--dsw-alias-bg-base); font-size: 11px; }
      .cm-symbol + .cm-symbol { margin-top: 5px; }
      .cm-symbol b { font-weight: 600; }
      .cm-footer { padding: 8px 16px 12px; border-top: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font-size: 10.8px; flex: 0 0 auto; }
      .cm-toast {
        position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
        background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1);
        padding: 6px 11px; border-radius: 999px; font-size: 11.5px; z-index: 20;
      }
      .cm-inline { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .cm-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.55; margin-top: 5px; }
    `;

    const DIMENSION_LABEL = {
      overview: '项目全景',
      roadmap: '学习路线',
      explorer: '代码探索',
      practice: '实践工坊',
      interview: '面试间',
    };

    const CLAIM_LABEL = { source: '源码事实', doc: '文档陈述', inference: '推断', unverified: '待验证' };

    function ellipsis(value, max = 120) {
      const text = String(value || '');
      return text.length > max ? `${text.slice(0, max - 1)}…` : text;
    }

    function fileLine(file, line) {
      if (!file) return '';
      return `${file}${line ? `:${line}` : ''}`;
    }

    function evidenceFirst(list) {
      const first = Array.isArray(list) ? list[0] : list;
      return first ? fileLine(first.file, first.line) : '';
    }

    function useCopy() {
      const [toast, setToast] = useState('');
      const copy = useCallback(async (text) => {
        try {
          await navigator.clipboard.writeText(text);
          setToast('已复制');
        } catch {
          setToast('复制失败，请手动选择');
        }
        setTimeout(() => setToast(''), 1500);
      }, []);
      return { toast, copy };
    }

    useCopy.displayName = 'useCopy';

    function useCodeMentor() {
      const [state, setState] = useState({ phase: 'loading', projects: [], view: null, error: '', projectId: '' });
      const load = useCallback(async (id, signal) => {
        setState((current) => ({ ...current, phase: current.view ? 'refreshing' : 'loading', error: '' }));
        try {
          const url = id ? `${API}?id=${encodeURIComponent(id)}` : API;
          const response = await fetch(url, { cache: 'no-store', signal });
          const data = await response.json().catch(() => null);
          if (!response.ok || !data?.ok) {
            throw new Error(data?.error?.message || `HTTP ${response.status}`);
          }
          setState({ phase: 'ready', projects: data.projects || [], view: data.view, error: '', projectId: data.projectId || '' });
        } catch (error) {
          if (error?.name === 'AbortError') return;
          setState((current) => ({ ...current, phase: 'error', error: error?.message || String(error) }));
        }
      }, []);
      useEffect(() => {
        const controller = new AbortController();
        load('', controller.signal);
        return () => controller.abort();
      }, [load]);
      return { ...state, reload: (id) => load(id) };
    }

    function Chip({ children, tone = '' }) {
      return h('span', { className: `cm-chip${tone ? ` ${tone}` : ''}` }, children);
    }

    function Badge({ value, label }) {
      const map = { source: 'source', doc: 'doc', inference: 'inference', unverified: 'unverified', stale: 'stale' };
      return h('span', { className: `cm-badge ${map[value] || ''}` }, label || CLAIM_LABEL[value] || value);
    }

    function Note({ children }) {
      return h('div', { className: 'cm-note' }, children);
    }

    function Empty({ title, detail, command }) {
      return h('div', { className: 'cm-empty' },
        h('div', null,
          h('div', { style: { fontSize: 14, color: 'var(--dsw-alias-label-primary)', marginBottom: 8 } }, title),
          h('div', null, detail),
          command ? h('div', { className: 'cm-mono', style: { marginTop: 10, color: 'var(--dsw-alias-brand-primary)' } }, command) : null,
        ),
      );
    }

    function StatRow({ view }) {
      const stats = view?.overview?.inventory || {};
      const languages = (stats.languages || []).slice(0, 3);
      return h('div', { className: 'cm-chips' },
        h(Chip, null, h('b', null, stats.nonVendoredSourceFiles ?? '—'), ' 源文件'),
        h(Chip, null, h('b', null, view?.explorer?.modules?.length ?? '—'), ' 模块'),
        h(Chip, null, h('b', null, view?.overview?.chain?.steps?.length ?? 0), ' 链步骤'),
        h(Chip, null, h('b', null, view?.practice?.tasks?.length ?? 0), ' 练习'),
        h(Chip, null, h('b', null, view?.interview?.bank?.count ?? 0), ' 面试题'),
        ...languages.map((language) => h(Chip, { key: language.id }, `${language.name} ${Math.round((language.share || 0) * 100)}%`)),
        view?.meta?.dirty ? h(Chip, { tone: 'stale' }, '工作区有未提交改动') : null,
      );
    }

    function ModuleList({ view, selected, onSelect }) {
      const modules = (view?.overview?.modules || []).slice(0, 20);
      return h('div', { className: 'cm-list' },
        modules.map((module) => h('button', {
          key: module.id,
          type: 'button',
          className: `cm-row is-clickable${selected === module.id ? ' is-active' : ''}`,
          onClick: () => onSelect(module.id),
        },
          h('div', { className: 'cm-row-head' },
            h('span', { className: 'cm-row-name' }, module.name),
            h('span', { className: 'cm-badge' }, module.vendored ? '第三方' : '源码'),
          ),
          h('div', { className: 'cm-row-sub' }, `${module.files} 文件 · ${module.symbols} 符号 · 重要度 ${module.importance}`),
          h('div', { className: 'cm-bar' }, h('i', { style: { width: `${Math.round((module.importance || 0) * 100)}%` } })),
          h('div', { className: 'cm-row-sub', style: { marginTop: 3 } },
            module.deps?.length ? `依赖 ${module.deps.slice(0, 3).join(', ')}${module.deps.length > 3 ? '…' : ''}` : '无模块依赖'),
        )),
      );
    }

    function ChainSteps({ chain }) {
      if (!chain?.steps?.length) return h(Note, null, '尚未构建出可核对的调用链。可在对话中执行 codementor_explore mode=chain。');
      return h('div', { className: 'cm-steps' },
        chain.steps.map((step) => h('div', { key: `${step.step}-${step.to}`, className: 'cm-step' },
          h('span', { className: 'cm-from' }, `${step.step}. `),
          h('span', { className: 'cm-code' }, step.from),
          ' → ',
          h('span', { className: 'cm-code' }, step.to),
          step.confidence === 'inferred' ? h('span', { className: 'cm-badge inference', style: { marginLeft: 6 } }, '推断') : null,
          h('div', { className: 'cm-row-sub cm-mono' }, fileLine(step.file, step.line)),
        )),
      );
    }

    function ClaimList({ view }) {
      const claims = (view?.overview?.claims || []).slice(0, 30);
      if (!claims.length) return h(Note, null, '没有生成结论。');
      return h('div', { className: 'cm-list' },
        claims.map((claim) => h('div', { key: claim.id, className: 'cm-row' },
          h('div', { className: 'cm-row-head' },
            h('span', { className: 'cm-row-name' }, ellipsis(claim.text, 150)),
            h('span', { className: 'cm-inline' },
              claim.stale ? h(Badge, { value: 'stale' }) : null,
              h(Badge, { value: claim.kind }),
            ),
          ),
          claim.evidence?.length ? h('div', { className: 'cm-row-sub cm-mono' }, claim.evidence.slice(0, 3).map((item) => fileLine(item.file, item.line)).join('、')) : null,
        )),
      );
    }

    function OverviewTab({ view, onGo }) {
      const [selectedModule, setSelectedModule] = useState(view?.overview?.modules?.[0]?.id || '');
      const module = (view?.overview?.modules || []).find((item) => item.id === selectedModule);
      const mermaid = view?.overview?.architecture?.mermaid;
      const chain = view?.overview?.chain;
      const startup = view?.overview?.startup;
      const data = view?.overview?.dataStructures;
      const concurrency = view?.overview?.concurrency;
      const risks = view?.overview?.risks || [];
      const conflicts = view?.overview?.conflicts || [];
      const { copy } = useCopy();

      return h(React.Fragment, null,
        h('div', { className: 'cm-card' },
          h('h3', null, '一句话结论'),
          h('p', { className: 'cm-lead' }, view?.overview?.oneLiner?.text || '缺少可读的 README，项目目标需要从源码确认。'),
          h('div', { className: 'cm-inline' },
            h(Badge, { value: view?.overview?.oneLiner?.kind }),
            h('span', { className: 'cm-row-sub cm-mono' }, evidenceFirst(view?.overview?.oneLiner?.evidence)),
          ),
          view?.overview?.problem?.text ? h(React.Fragment, null,
            h('h3', { style: { marginTop: 12 } }, '主要解决的问题'),
            h('p', null, view.overview.problem.text),
            h('div', { className: 'cm-inline' },
              h(Badge, { value: view.overview.problem.kind }),
              h('span', { className: 'cm-row-sub cm-mono' }, evidenceFirst(view.overview.problem.evidence)),
            ),
          ) : null,
          h(StatRow, { view }),
        ),
        h('div', { className: 'cm-grid' },
          h('div', null,
            h('div', { className: 'cm-card' },
              h('h3', null, '系统架构'),
              mermaid
                ? h(React.Fragment, null,
                  h('pre', { className: 'cm-pre' }, mermaid),
                  h('button', { type: 'button', className: 'cm-btn', style: { marginTop: 6 }, onClick: () => copy(mermaid) }, '复制 Mermaid'),
                )
                : h(Note, null, '未生成架构图。'),
            ),
            h('div', { className: 'cm-card' },
              h('h3', null, '模块职责与依赖'),
              h(ModuleList, { view, selected: selectedModule, onSelect: setSelectedModule }),
              module ? h('div', { style: { marginTop: 10 } },
                h('h4', null, `${module.name} 的证据`),
                h('dl', { className: 'cm-kv' },
                  h('dt', null, '文件 / 符号'), h('dd', null, `${module.files} / ${module.symbols}`),
                  h('dt', null, '依赖'), h('dd', null, module.deps?.join('、') || '无'),
                  h('dt', null, '被依赖'), h('dd', null, module.dependents?.join('、') || '无'),
                ),
                (module.topFiles || []).slice(0, 5).map((file) => h('div', { key: file.path, className: 'cm-row-sub cm-mono' }, `${file.path} · ${file.loc} 行 · ${file.symbols} 符号`)),
              ) : null,
            ),
            h('div', { className: 'cm-card' },
              h('h3', null, '典型执行链路'),
              h('div', { className: 'cm-inline', style: { marginBottom: 7 } },
                h(Chip, null, `置信度 ${chain?.confidence || 'unknown'}`),
                chain?.steps?.length ? h(Chip, null, `${chain.steps.length} 步`) : null,
                h('button', { type: 'button', className: 'cm-btn', onClick: () => onGo('explorer') }, '在代码探索中查看调用链'),
              ),
              h(ChainSteps, { chain }),
              startup?.steps?.length ? h(React.Fragment, null,
                h('h3', { style: { marginTop: 12 } }, '启动路径'),
                h(ChainSteps, { chain: { steps: startup.steps } }),
                (startup.notes || []).map((note, index) => h(Note, { key: index }, note)),
              ) : null,
            ),
            h('div', { className: 'cm-card' },
              h('h3', null, '核心数据结构'),
              data?.top
                ? h(React.Fragment, null,
                  h('p', null, `${data.top.name} · ${fileLine(data.top.file, data.top.line)} · ${data.top.fields?.length || 0} 字段`),
                  h('div', { className: 'cm-inline' },
                    h(Chip, null, `生命周期：${data.top.lifecycle?.verdict || 'unverified'}`),
                    h(Chip, null, `置信度：${data.top.lifecycle?.confidence || 'unverified'}`),
                  ),
                  h('div', { className: 'cm-chips' }, (data.top.fields || []).slice(0, 14).map((field) => h(Chip, { key: field.name }, field.name))),
                  (data.top.lifecycle?.declarations || []).slice(0, 5).map((item, index) => h('div', { key: index, className: 'cm-row-sub cm-mono' }, `实例 ${fileLine(item.file, item.line)} ${item.variable || ''}`)),
                  (data.top.lifecycle?.releases || []).slice(0, 5).map((item, index) => h('div', { key: index, className: 'cm-row-sub cm-mono' }, `释放 ${fileLine(item.file, item.line)} ${item.variable || ''}`)),
                )
                : h(Note, null, '未识别到结构体/类定义。'),
            ),
          ),
          h('div', null,
            h('div', { className: 'cm-card' },
              h('h3', null, '并发与异步'),
              h('p', null, `模型：${concurrency?.model || 'unknown'}`),
              h('div', { className: 'cm-chips' },
                h(Chip, null, h('b', null, concurrency?.counts?.isr ?? 0), ' ISR'),
                h(Chip, null, h('b', null, concurrency?.counts?.rtos ?? 0), ' RTOS'),
                h(Chip, null, h('b', null, concurrency?.counts?.lock ?? 0), ' 锁/临界区'),
              ),
              (concurrency?.isrs || []).slice(0, 6).map((isr) => h('div', { key: `${isr.file}:${isr.line}`, className: 'cm-row-sub cm-mono' }, `${isr.name} — ${fileLine(isr.file, isr.line)}`)),
            ),
            h('div', { className: 'cm-card' },
              h('h3', null, '构建与测试'),
              (view?.overview?.build?.commands || []).map((command) => h('div', { key: command.display || command.label, className: 'cm-row' },
                h('div', { className: 'cm-row-head' },
                  h('span', { className: 'cm-row-sub cm-mono' }, command.display || command.label),
                  h('span', { className: `cm-badge ${command.available ? 'ok' : 'unverified'}` }, command.available ? '可执行' : '需手工'),
                ),
                command.available ? null : h('div', { className: 'cm-row-sub' }, command.reason),
              )),
              h('h4', null, '测试'),
              h('p', null, `${view?.overview?.testing?.count || 0} 个测试文件${view?.overview?.testing?.frameworks?.length ? ` · ${view.overview.testing.frameworks.join('、')}` : ' · 未识别框架'}`),
            ),
            h('div', { className: 'cm-card' },
              h('h3', null, '风险与冲突'),
              risks.slice(0, 6).map((risk, index) => h('div', { key: index, className: 'cm-row' },
                h('div', { className: 'cm-row-head' },
                  h('span', { className: 'cm-row-name' }, risk.kind),
                  h('span', { className: `cm-badge ${risk.severity === 'high' ? 'p0' : risk.severity === 'medium' ? 'p1' : 'p2'}` }, risk.severity),
                ),
                h('div', { className: 'cm-row-sub' }, risk.text),
                risk.evidence?.length ? h('div', { className: 'cm-row-sub cm-mono' }, risk.evidence.slice(0, 2).map((item) => fileLine(item.file, item.line)).join('、')) : null,
              )),
              conflicts.map((conflict, index) => h('div', { key: `c${index}`, className: 'cm-row' },
                h('div', { className: 'cm-row-head' }, h('span', { className: 'cm-row-name' }, '文档 vs 源码'), h(Badge, { value: 'unverified' })),
                h('div', { className: 'cm-row-sub' }, conflict.text),
              )),
            ),
            h('div', { className: 'cm-card' },
              h('h3', null, '结论与证据状态'),
              h(ClaimList, { view }),
            ),
          ),
        ),
      );
    }

    function RoadmapTab({ view, onGo }) {
      const plan = view?.roadmap;
      if (!plan) {
        return h('div', { className: 'cm-card' },
          h('h3', null, '还没有学习路线'),
          h('p', null, '在对话中执行：'),
          h('pre', { className: 'cm-pre' }, 'codementor_roadmap goal=onboarding level=beginner mode=2h'),
          h(Note, null, '生成后这里会显示 P0/P1/P2 顺序、依据、前置模块和下一步建议。'),
        );
      }
      return h(React.Fragment, null,
        h('div', { className: 'cm-card' },
          h('h3', null, '路线概览'),
          h('p', { className: 'cm-lead' }, plan.summary),
          h('div', { className: 'cm-chips' },
            h(Chip, null, `目标：${plan.goalLabel}`),
            h(Chip, null, `水平：${plan.levelLabel}`),
            h(Chip, null, `模式：${plan.modeLabel}`),
            h(Chip, null, `生成于 ${String(plan.generatedAt || '').slice(0, 16).replace('T', ' ')}`),
          ),
          h(Note, null, plan.caveat),
        ),
        h('div', { className: 'cm-card' },
          h('h3', null, `学习顺序（${plan.items.length} 项）`),
          h('div', { className: 'cm-list' },
            plan.items.map((item) => h('div', { key: item.moduleId, className: 'cm-row' },
              h('div', { className: 'cm-row-head' },
                h('span', { className: 'cm-row-name' }, `${item.order}. ${item.module}`),
                h('span', { className: 'cm-inline' },
                  h('span', { className: `cm-badge ${item.priority.toLowerCase()}` }, item.priority),
                  h('span', { className: 'cm-chip' }, `评分 ${item.score}`),
                ),
              ),
              h('div', { className: 'cm-row-sub' }, item.objective),
              h('div', { className: 'cm-row-sub' }, item.rationale?.join('；')),
              h('div', { className: 'cm-row-sub' },
                `状态：${item.status?.label || '未学习'} · 预算 ${item.budgetMinutes} 分钟`,
                item.prerequisites?.length ? ` · 前置：${item.prerequisites.map((dep) => dep.name).join('、')}` : '',
              ),
              h('div', { className: 'cm-row-sub cm-mono' }, (item.files || []).slice(0, 2).join('、')),
            )),
          ),
        ),
        h('div', { className: 'cm-grid-2' },
          h('div', { className: 'cm-card' },
            h('h3', null, '下一步'),
            view?.progress?.next
              ? h(React.Fragment, null,
                h('p', { className: 'cm-lead' }, view.progress.next.module),
                h('p', null, view.progress.next.reason),
                h('div', { className: 'cm-chips' },
                  h(Chip, null, `等级 ${view.progress.next.level} · ${view.progress.next.label}`),
                  h(Chip, null, `优先级 ${view.progress.next.priority}`),
                ),
              )
              : h(Note, null, '全部模块已完成或还没有路线。'),
          ),
          h('div', { className: 'cm-card' },
            h('h3', null, '进度证据'),
            (view?.progress?.counts || []).map((count) => h('div', { key: count.level, className: 'cm-row-sub' }, `L${count.level} ${count.label}：${count.count} 个模块`)),
            h('button', { type: 'button', className: 'cm-btn', style: { marginTop: 8 }, onClick: () => onGo('interview') }, '去面试间检验掌握程度'),
          ),
        ),
        plan.skipped?.length ? h('div', { className: 'cm-card' },
          h('h3', null, '未纳入本次预算'),
          h('div', { className: 'cm-chips' }, plan.skipped.slice(0, 12).map((item) => h(Chip, { key: item.moduleId }, `${item.module} · ${item.priority}`))),
        ) : null,
      );
    }

    function ExplorerTab({ view }) {
      const modules = view?.explorer?.modules || [];
      const [selectedId, setSelectedId] = useState(modules[0]?.id || '');
      const [chainId, setChainId] = useState(view?.explorer?.chains?.[0]?.id || '');
      const selected = modules.find((module) => module.id === selectedId) || modules[0] || null;
      const chain = (view?.explorer?.chains || []).find((item) => item.id === chainId) || view?.explorer?.chains?.[0] || null;

      return h('div', { className: 'cm-split' },
        h('div', { className: 'cm-col' },
          h('div', { className: 'cm-card', style: { marginBottom: 10 } },
            h('h3', null, '模块'),
            h('div', { className: 'cm-list' },
              modules.map((module) => h('button', {
                key: module.id, type: 'button',
                className: `cm-row is-clickable${module.id === selected?.id ? ' is-active' : ''}`,
                onClick: () => setSelectedId(module.id),
              },
                h('div', { className: 'cm-row-head' },
                  h('span', { className: 'cm-row-name' }, module.name),
                  h('span', { className: 'cm-badge' }, module.vendored ? '第三方' : `${module.files} 文件`),
                ),
                h('div', { className: 'cm-row-sub' }, `${module.loc} 行 · ${module.symbols?.length || 0} 个已索引符号`),
              )),
            ),
          ),
          h('div', { className: 'cm-card' },
            h('h3', null, '调用链'),
            h('div', { className: 'cm-list' },
              (view?.explorer?.chains || []).map((item) => h('button', {
                key: item.id, type: 'button',
                className: `cm-row is-clickable${item.id === chain?.id ? ' is-active' : ''}`,
                onClick: () => setChainId(item.id),
              },
                h('div', { className: 'cm-row-head' },
                  h('span', { className: 'cm-row-name' }, item.start?.name || item.name),
                  h('span', { className: 'cm-badge' }, item.confidence),
                ),
                h('div', { className: 'cm-row-sub' }, `${item.stats?.nodes ?? 0} 节点 / ${item.stats?.edges ?? 0} 边${item.stale ? ' · 已过期' : ''}`),
              )),
            ),
          ),
        ),
        h('div', { className: 'cm-col-main' },
          h('div', { className: 'cm-card' },
            h('h3', null, selected ? `模块 ${selected.name}` : '模块详情'),
            selected
              ? h(React.Fragment, null,
                h('dl', { className: 'cm-kv' },
                  h('dt', null, '路径'), h('dd', { className: 'cm-mono' }, selected.path || '(root)'),
                  h('dt', null, '文件 / 行数'), h('dd', null, `${selected.files} / ${selected.loc}`),
                  h('dt', null, '依赖'), h('dd', null, selected.deps?.join('、') || '无'),
                ),
                h('h4', null, '已索引符号（点击无副作用，仅展示证据位置）'),
                (selected.symbols || []).slice(0, 30).map((symbol) => h('div', { key: symbol.id, className: 'cm-symbol' },
                  h('b', null, symbol.name),
                  h('span', { className: 'cm-row-sub' }, ` · ${symbol.kind} · ${symbol.line}-${symbol.endLine} · 调用 ${symbol.calls}`),
                  h('div', { className: 'cm-row-sub cm-mono' }, `${symbol.file}:${symbol.line}`),
                )),
                (selected.symbols || []).length === 0 ? h(Note, null, '这个模块没有被解析出符号（可能是头文件、第三方或解析预算外）。') : null,
              )
              : h(Note, null, '没有模块数据。'),
          ),
          chain ? h('div', { className: 'cm-card' },
            h('h3', null, `调用链 · ${chain.start?.name || chain.name}`),
            h('div', { className: 'cm-inline', style: { marginBottom: 7 } },
              h(Chip, null, `起点 ${fileLine(chain.start?.file, chain.start?.line)}`),
              h(Chip, null, `置信度 ${chain.confidence}`),
              chain.stale ? h(Badge, { value: 'stale', label: '已过期' }) : null,
            ),
            h(ChainSteps, { chain: { steps: chain.primary || [] } }),
            (chain.notes || []).map((note, index) => h(Note, { key: index }, note)),
          ) : null,
          h('div', { className: 'cm-card' },
            h('h3', null, '关键数据结构'),
            (view?.explorer?.structures || []).slice(0, 10).map((structure) => h('div', { key: `${structure.file}:${structure.line}`, className: 'cm-row' },
              h('div', { className: 'cm-row-head' },
                h('span', { className: 'cm-row-name' }, `${structure.kind} ${structure.name}`),
                h('span', { className: 'cm-badge' }, structure.lifecycle?.verdict || 'unverified'),
              ),
              h('div', { className: 'cm-row-sub cm-mono' }, fileLine(structure.file, structure.line)),
              h('div', { className: 'cm-row-sub' }, (structure.fields || []).slice(0, 10).map((field) => field.name).join('、')),
            )),
          ),
          h('div', { className: 'cm-card' },
            h('h3', null, '文件（按模块排序）'),
            h('div', { className: 'cm-list' },
              (view?.explorer?.files || []).slice(0, 24).map((file) => h('div', { key: file.path, className: 'cm-row' },
                h('div', { className: 'cm-row-head' },
                  h('span', { className: 'cm-row-name cm-mono' }, file.path),
                  h('span', { className: 'cm-badge' }, `${file.loc} 行`),
                ),
                h('div', { className: 'cm-row-sub' }, `${file.symbols} 符号 · ${file.structures} 结构${file.parseError ? ` · 解析失败：${file.parseError}` : ''}`),
              )),
            ),
          ),
        ),
      );
    }

    function PracticeTab({ view }) {
      const tasks = view?.practice?.tasks || [];
      const [selectedId, setSelectedId] = useState(tasks[0]?.id || '');
      const task = tasks.find((item) => item.id === selectedId) || tasks[0] || null;
      const plan = view?.practice?.verificationPlan;
      return h('div', { className: 'cm-split' },
        h('div', { className: 'cm-col' },
          h('div', { className: 'cm-card' },
            h('h3', null, `实践任务（${tasks.length}）`),
            tasks.length === 0
              ? h(Note, null, '还没有任务。在对话中执行 codementor_practice action=generate。')
              : h('div', { className: 'cm-list' },
                tasks.map((item) => h('button', {
                  key: item.id, type: 'button',
                  className: `cm-row is-clickable${item.id === task?.id ? ' is-active' : ''}`,
                  onClick: () => setSelectedId(item.id),
                },
                  h('div', { className: 'cm-row-head' },
                    h('span', { className: 'cm-row-name' }, ellipsis(item.title, 90)),
                    h('span', { className: `cm-badge ${item.risk?.level === 'high' ? 'p0' : item.risk?.level === 'medium' ? 'p1' : 'p2'}` }, item.risk?.level || 'low'),
                  ),
                  h('div', { className: 'cm-row-sub' }, `${item.kind} · ${item.module || '—'}`),
                  h('div', { className: 'cm-row-sub cm-mono' }, fileLine(item.target?.file, item.target?.line)),
                )),
              ),
          ),
        ),
        h('div', { className: 'cm-col-main' },
          task ? h('div', { className: 'cm-card' },
            h('h3', null, task.title),
            h('p', { className: 'cm-lead' }, task.objective),
            h('dl', { className: 'cm-kv' },
              h('dt', null, '当前行为'), h('dd', null, task.currentBehavior),
              h('dt', null, '预期行为'), h('dd', null, task.expectedBehavior),
              h('dt', null, '修改范围'), h('dd', null, task.scope),
              h('dt', null, '风险'), h('dd', null, `${task.risk?.level} — ${(task.risk?.reasons || []).join('；')}`),
            ),
            h('h4', null, '不变量'),
            (task.invariants || []).map((item, index) => h('div', { key: index, className: 'cm-row-sub' }, `- ${item}`)),
            h('h4', null, '思考线索'),
            (task.hints?.guided || []).map((item, index) => h('div', { key: index, className: 'cm-row-sub' }, `- ${item}`)),
            (task.hints?.coop || []).map((item, index) => h('div', { key: `c${index}`, className: 'cm-row-sub' }, `- ${item}`)),
            h('div', { className: 'cm-hint' }, '默认只读。真正修改代码需要在对话中明确授权；参考实现只在用户要求时给出，且不会被标记为已验证。'),
          ) : h('div', { className: 'cm-card' }, h('h3', null, '任务详情'), h(Note, null, '选择左侧任务查看修改前检查。')),
          h('div', { className: 'cm-card' },
            h('h3', null, '验证计划'),
            h('p', null, '执行必须由用户在对话中授权（codementor_practice action=verify authorized=true）。未执行的步骤不能算通过。'),
            (plan?.steps || []).map((step) => h('div', { key: step.id, className: 'cm-row' },
              h('div', { className: 'cm-row-head' },
                h('span', { className: 'cm-row-name' }, step.label),
                h('span', { className: `cm-badge ${step.available ? 'ok' : 'unverified'}` }, step.available ? '可执行' : '手工/不可用'),
              ),
              h('div', { className: 'cm-row-sub cm-mono' }, step.display || '—'),
              step.available ? null : h('div', { className: 'cm-row-sub' }, step.reason),
            )),
          ),
        ),
      );
    }

    function InterviewTab({ view }) {
      const bank = view?.interview?.bank;
      const report = view?.interview?.report;
      const weakPoints = view?.interview?.weakPoints || [];
      const [selectedId, setSelectedId] = useState(bank?.questions?.[0]?.id || '');
      const question = (bank?.questions || []).find((item) => item.id === selectedId) || bank?.questions?.[0] || null;
      return h(React.Fragment, null,
        h('div', { className: 'cm-card' },
          h('h3', null, '面试间'),
          report?.ok
            ? h(React.Fragment, null,
              h('p', null, `会话 ${report.session?.id} · 已回答 ${report.session?.answered ?? 0} 题`),
              h('div', { className: 'cm-chips' },
                (report.dimensions || []).map((dimension) => h(Chip, { key: dimension.dimension }, `${dimension.label} ${dimension.average}`)),
              ),
              h('p', { className: 'cm-row-sub' }, report.recommendation),
            )
            : h(Note, null, '还没有面试记录。在对话中执行 codementor_interview action=start 开始一轮；默认一次只问一题。'),
          h('div', { className: 'cm-inline', style: { marginTop: 8 } },
            h(Chip, null, `题库 ${bank?.count ?? 0} 题`),
            (bank?.dimensions || []).map((dimension) => h(Chip, { key: dimension }, dimension)),
          ),
        ),
        h('div', { className: 'cm-split' },
          h('div', { className: 'cm-col' },
            h('div', { className: 'cm-card' },
              h('h3', null, '题库'),
              (bank?.questions || []).map((item) => h('button', {
                key: item.id, type: 'button',
                className: `cm-row is-clickable${item.id === question?.id ? ' is-active' : ''}`,
                onClick: () => setSelectedId(item.id),
              },
                h('div', { className: 'cm-row-head' },
                  h('span', { className: 'cm-row-name' }, ellipsis(item.prompt, 88)),
                  h('span', { className: 'cm-badge' }, item.difficulty),
                ),
                h('div', { className: 'cm-row-sub' }, `${item.dimension} · 追问 ${item.followups} 层`),
              )),
            ),
          ),
          h('div', { className: 'cm-col-main' },
            question ? h('div', { className: 'cm-card' },
              h('h3', null, '题目'),
              h('p', { className: 'cm-lead' }, question.prompt),
              h('div', { className: 'cm-chips' },
                h(Chip, null, question.dimension),
                h(Chip, null, `追问 ${question.followups} 层`),
                question.evidence?.[0] ? h(Chip, null, fileLine(question.evidence[0].file, question.evidence[0].line)) : null,
              ),
              h('h4', null, '简短版参考回答'),
              h('p', null, question.recommended?.concise || '—'),
              h('h4', null, '深入版参考回答'),
              h('p', null, question.recommended?.deep || '—'),
              h('div', { className: 'cm-hint' }, '评分基于关键词覆盖与表达结构，不是 LLM 主观判断；回答后以对话中的纠错与证据行为准。'),
            ) : null,
            h('div', { className: 'cm-card' },
              h('h3', null, '薄弱点'),
              weakPoints.length
                ? weakPoints.slice(0, 8).map((point, index) => h('div', { key: index, className: 'cm-row' },
                  h('div', { className: 'cm-row-head' }, h('span', { className: 'cm-row-name' }, point.label), h('span', { className: 'cm-badge' }, point.dimension)),
                  h('div', { className: 'cm-row-sub' }, (point.missing || []).join('；')),
                ))
                : h(Note, null, '还没有薄弱点记录。'),
            ),
          ),
        ),
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

    function Panel() {
      const { phase, projects, view, error, projectId, reload } = useCodeMentor();
      const [tab, setTab] = useState('overview');
      const [toast, setToast] = useState('');
      const notify = useCallback((message) => {
        setToast(message);
        setTimeout(() => setToast(''), 1600);
      }, []);

      const tabs = useMemo(() => [
        { id: 'overview', label: DIMENSION_LABEL.overview },
        { id: 'roadmap', label: DIMENSION_LABEL.roadmap },
        { id: 'explorer', label: DIMENSION_LABEL.explorer },
        { id: 'practice', label: DIMENSION_LABEL.practice },
        { id: 'interview', label: DIMENSION_LABEL.interview },
      ], []);

      const header = h('div', { className: 'cm-header' },
        h('div', { className: 'cm-title' },
          h('strong', null, 'CodeMentor 工程导师'),
          h('span', { className: 'cm-sub' }, view ? `${view.meta.name} · ${ellipsis(view.meta.root, 64)}` : '项目源码学习 · 只读缓存视图'),
        ),
        projects.length
          ? h('select', {
            className: 'cm-project',
            value: projectId,
            'aria-label': '选择已分析项目',
            onChange: (event) => reload(event.target.value),
          }, projects.map((project) => h('option', { key: project.id, value: project.id }, `${project.name}（${project.modules} 模块）`)))
          : null,
        h('div', { className: 'cm-actions' },
          view?.meta?.commit ? h('span', { className: 'cm-chip' }, `${String(view.meta.commit).slice(0, 8)}${view.meta.dirty ? ' +dirty' : ''}`) : null,
          h('button', {
            type: 'button', className: 'cm-btn', disabled: phase === 'loading' || phase === 'refreshing',
            onClick: () => reload(projectId),
          }, phase === 'refreshing' ? '刷新中…' : '刷新缓存视图'),
        ),
      );

      let body;
      if (phase === 'loading') {
        body = h(Empty, { title: '正在读取 CodeMentor 缓存…', detail: '面板只读取已分析项目；首次使用需要先在对话里扫描项目。' });
      } else if (phase === 'error') {
        body = h('div', { className: 'cm-body' },
          h('div', { className: 'cm-card' },
            h('h3', null, '无法读取缓存'),
            h('div', { className: 'cm-error' }, error),
            h('p', null, '首次使用请在对话中执行：'),
            h('pre', { className: 'cm-pre' }, 'codementor_scan path="C:/path/to/project"\ncodementor_overview'),
            h('button', { type: 'button', className: 'cm-btn', style: { marginTop: 8 }, onClick: () => reload(projectId) }, '重试'),
          ),
        );
      } else if (!view) {
        body = h('div', { className: 'cm-body' },
          h(Empty, {
            title: '还没有已分析的 CodeMentor 项目',
            detail: '在对话中扫描一个本地项目后，这里会出现架构、路线、练习与面试记录。',
            command: 'codementor_scan',
          }),
        );
      } else {
        body = h('div', { className: 'cm-body' },
          tab === 'overview' ? h(OverviewTab, { view, onGo: setTab }) : null,
          tab === 'roadmap' ? h(RoadmapTab, { view, onGo: setTab }) : null,
          tab === 'explorer' ? h(ExplorerTab, { view }) : null,
          tab === 'practice' ? h(PracticeTab, { view }) : null,
          tab === 'interview' ? h(InterviewTab, { view }) : null,
        );
      }

      return h('section', { className: 'cm-panel' },
        h('style', null, css),
        header,
        view ? h('div', { className: 'cm-tabs', role: 'tablist' }, tabs.map((item) => h('button', {
          key: item.id, type: 'button', role: 'tab', 'aria-selected': tab === item.id,
          className: `cm-tab${tab === item.id ? ' is-active' : ''}`,
          onClick: () => setTab(item.id),
        }, item.label))) : null,
        body,
        h('div', { className: 'cm-footer' },
          `只读缓存视图${view?.meta?.updatedAt ? ` · 更新于 ${String(view.meta.updatedAt).slice(0, 16).replace('T', ' ')}` : ''}`,
          view?.meta?.stale?.claims ? ` · ${view.meta.stale.claims} 条结论已过期，建议先 codementor_refresh` : '',
          ' · 扫描/学习/修改请在对话中使用 codementor_* 工具',
        ),
        toast ? h('div', { className: 'cm-toast', role: 'status' }, toast) : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 24, label: 'CodeMentor 工程导师',
        }, PanelIcon));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID,
        }, Panel));
      },
    };
  },
});
