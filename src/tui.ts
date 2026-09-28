import { emitKeypressEvents } from 'node:readline';
import { styleText } from 'node:util';
import type { Changelog } from './types.js';
import { formatChangelog } from './format.js';
import { type Choice, type Row, levelColor } from './rows.js';

export interface PickerState {
  cursor: number;
  choice: (number | null)[];
}

export function initialState(rows: Row[]): PickerState {
  return { cursor: 0, choice: rows.map((r) => (r.selected === undefined ? null : r.selected)) };
}

/** Pure key handling so the picker logic is testable without a terminal. */
export function reduce(state: PickerState, rows: Row[], key: string): PickerState | 'submit' | 'cancel' {
  const { cursor } = state;
  const row = rows[cursor];
  const choice = [...state.choice];
  const n = row?.choices.length ?? 0;
  switch (key) {
    case 'up':
      return { ...state, cursor: Math.max(0, cursor - 1) };
    case 'down':
      return { ...state, cursor: Math.min(rows.length - 1, cursor + 1) };
    case 'left':
      if (!row?.location || n === 0) return state;
      choice[cursor] = choice[cursor] === null ? n - 1 : choice[cursor]! - 1 < 0 ? null : choice[cursor]! - 1;
      return { ...state, choice };
    case 'right':
      if (!row?.location || n === 0) return state;
      choice[cursor] = choice[cursor] === null ? 0 : choice[cursor]! + 1 >= n ? null : choice[cursor]! + 1;
      return { ...state, choice };
    case 'space':
      if (!row?.location || n === 0) return state;
      choice[cursor] = choice[cursor] === null ? (row.selected ?? n - 1) : null;
      return { ...state, choice };
    case 'all': {
      const anySelected = choice.some((c) => c !== null);
      return { ...state, choice: rows.map((r) => (anySelected || !r.location || !r.choices.length ? null : (r.selected ?? r.choices.length - 1))) };
    }
    case 'enter':
      return 'submit';
    case 'cancel':
      return 'cancel';
    default:
      return state;
  }
}

const KEYMAP: Record<string, string> = {
  up: 'up', k: 'up', down: 'down', j: 'down', left: 'left', h: 'left', right: 'right', l: 'right',
  space: 'space', a: 'all', return: 'enter', enter: 'enter', escape: 'cancel', q: 'cancel', c: 'changelog',
  pageup: 'pageup', pagedown: 'pagedown',
};

export async function pick(
  rows: Row[],
  loadChangelog: (row: Row, choice: Choice) => Promise<Changelog>,
): Promise<Map<Row, Choice> | undefined> {
  const input = process.stdin;
  const out = process.stdout;
  let state = initialState(rows);
  let view: { lines: string[]; top: number; title: string } | undefined;
  let busy = false;

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  out.write('\x1b[?1049h\x1b[?25l');

  const render = () => {
    const height = out.rows ?? 24;
    const width = out.columns ?? 80;
    const body = view ? renderView(view, height, width) : renderList(rows, state, height, width, busy);
    out.write(`\x1b[H\x1b[2J${body}`);
  };

  const onResize = () => render();
  out.on('resize', onResize);

  return new Promise((resolvePick) => {
    const finish = (result: Map<Row, Choice> | undefined) => {
      input.off('keypress', onKey);
      out.off('resize', onResize);
      input.setRawMode(false);
      input.pause();
      out.write('\x1b[?25h\x1b[?1049l');
      resolvePick(result);
    };

    const onKey = (_: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      if (key.ctrl && key.name === 'c') return finish(undefined);
      const action = KEYMAP[key.name ?? key.sequence ?? ''];
      if (!action) return;

      if (view) {
        const page = Math.max(1, (out.rows ?? 24) - 3);
        if (action === 'up') view.top = Math.max(0, view.top - 1);
        else if (action === 'down') view.top = Math.min(Math.max(0, view.lines.length - page), view.top + 1);
        else if (action === 'pageup') view.top = Math.max(0, view.top - page);
        else if (action === 'pagedown') view.top = Math.min(Math.max(0, view.lines.length - page), view.top + page);
        else if (action === 'cancel' || action === 'left' || action === 'changelog') view = undefined;
        return render();
      }

      if (action === 'changelog') {
        const row = rows[state.cursor];
        const index = state.choice[state.cursor] ?? row?.selected ?? (row ? row.choices.length - 1 : -1);
        const choice = row?.choices[index];
        if (!row || !choice || busy) return;
        busy = true;
        render();
        loadChangelog(row, choice)
          .then((log) => formatChangelog(log, (out.columns ?? 80) - 2).split('\n'))
          .catch((e: Error) => [`Could not load the changelog: ${e.message}`])
          .then((lines) => {
            busy = false;
            view = { lines, top: 0, title: `${row.name}  ${row.current} → ${choice.version}` };
            render();
          });
        return;
      }

      const next = reduce(state, rows, action);
      if (next === 'cancel') return finish(undefined);
      if (next === 'submit') {
        const result = new Map<Row, Choice>();
        state.choice.forEach((c, i) => {
          const row = rows[i];
          const choice = c === null ? undefined : row?.choices[c];
          if (row && choice) result.set(row, choice);
        });
        return finish(result);
      }
      state = next;
      render();
    };

    input.on('keypress', onKey);
    render();
  });
}

function renderList(rows: Row[], state: PickerState, height: number, width: number, busy: boolean): string {
  const header = styleText('bold', 'Choose upgrades') + styleText('gray', '  ↑↓ move  ←→ version  space toggle  a all  c changelog  enter apply  q quit');
  const visible = Math.max(1, height - 3);
  const top = Math.min(Math.max(0, state.cursor - Math.floor(visible / 2)), Math.max(0, rows.length - visible));
  const nameWidth = Math.min(Math.max(...rows.map((r) => r.name.length), 4), Math.max(20, width - 40));
  const lines = rows.slice(top, top + visible).map((row, i) => {
    const index = top + i;
    const active = index === state.cursor;
    const c = state.choice[index] ?? null;
    const mark = c === null ? '○' : styleText('green', '●');
    const name = truncate(row.name, nameWidth).padEnd(nameWidth);
    const options = row.location
      ? row.choices.map((ch, j) => (j === c ? styleText(['inverse', levelColor(ch.level)], ` ${ch.version} `) : styleText(levelColor(ch.level), ` ${ch.version} `))).join(' ')
      : styleText('gray', `${row.choices.at(-1)?.version ?? ''} (not rewritable)`);
    const line = `${active ? styleText('cyan', '❯') : ' '} ${mark} ${active ? styleText('bold', name) : name}  ${row.current.padEnd(12)} ${options}`;
    return line;
  });
  const footer = busy ? styleText('yellow', 'Loading changelog…') : styleText('gray', `${state.choice.filter((c) => c !== null).length} of ${rows.length} selected`);
  return [header, '', ...lines, footer].join('\n');
}

function renderView(view: { lines: string[]; top: number; title: string }, height: number, width: number): string {
  const page = Math.max(1, height - 3);
  const header = styleText('bold', truncate(view.title, width - 30)) + styleText('gray', '  ↑↓ scroll  q back');
  const body = view.lines.slice(view.top, view.top + page);
  const footer = styleText('gray', `${Math.min(view.top + page, view.lines.length)}/${view.lines.length}`);
  return [header, '', ...body, footer].join('\n');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
