import type { SubagentEvent } from '../subagent';
import type { SubagentView } from './Panels';

/** One-way channel for out-of-band notices, e.g. an endpoint fallback. */
export type NoticeBus = {
  bind: (fn: (text: string) => void) => void;
  emit: (text: string) => void;
};

export function createNoticeBus(): NoticeBus {
  const queued: string[] = [];
  let sink: ((text: string) => void) | undefined;
  return {
    bind(fn) {
      sink = fn;
      for (const text of queued.splice(0)) fn(text);
    },
    emit(text) {
      if (sink) sink(text);
      else queued.push(text);
    },
  };
}

/** Subagent progress, from the task tool to the panel. */
export type SubagentBus = {
  bind: (fn: (event: SubagentEvent) => void) => void;
  emit: (event: SubagentEvent) => void;
};

export function createSubagentBus(): SubagentBus {
  const queued: SubagentEvent[] = [];
  let sink: ((event: SubagentEvent) => void) | undefined;
  return {
    bind(fn) {
      sink = fn;
      for (const event of queued.splice(0)) fn(event);
    },
    emit(event) {
      if (sink) sink(event);
      else queued.push(event);
    },
  };
}

/** Folds a subagent event into the panel's view, keeping finished agents visible. */
export function applySubagentEvent(current: SubagentView[], event: SubagentEvent): SubagentView[] {
  switch (event.type) {
    case 'start':
      return [
        ...current,
        { id: event.id, kind: event.kind, description: event.description, steps: [], status: 'running' },
      ];
    case 'step':
      return current.map((a) =>
        a.id === event.id ? { ...a, steps: [...a.steps, { tool: event.tool, summary: event.summary }] } : a,
      );
    case 'result':
      // Attaches to the step it answers rather than appending, so a subagent's
      // step count stays the number of calls it made.
      return current.map((a) => {
        if (a.id !== event.id) return a;
        const last = a.steps.at(-1);
        if (!last || last.tool !== event.tool || last.outcome !== undefined) return a;
        return {
          ...a,
          steps: [...a.steps.slice(0, -1), { ...last, outcome: event.summary, ok: event.ok }],
        };
      });
    case 'end':
      return current.map((a) => (a.id === event.id ? { ...a, status: event.ok ? 'done' : 'failed' } : a));
    case 'error':
      return current.map((a) => (a.id === event.id ? { ...a, status: 'failed', error: event.message } : a));
  }
}
