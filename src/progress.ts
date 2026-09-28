import { styleText } from 'node:util';

export interface Progress {
  total(n: number): void;
  tick(): void;
  done(): void;
}

const WIDTH = 28;
const FRAME_MS = 80;

export function createProgress(label: string, stream: NodeJS.WriteStream = process.stderr, enabled = stream.isTTY): Progress {
  if (!enabled) return { total() {}, tick() {}, done() {} };
  let total = 0;
  let count = 0;
  let last = 0;
  let finished = false;

  const draw = (force = false) => {
    const now = Date.now();
    if (!force && now - last < FRAME_MS) return;
    last = now;
    const ratio = total ? Math.min(count / total, 1) : 0;
    const filled = Math.round(ratio * WIDTH);
    const bar = styleText('cyan', '█'.repeat(filled)) + styleText('gray', '░'.repeat(WIDTH - filled));
    stream.write(`\r\x1b[2K${label} ${bar} ${count}/${total}`);
  };

  return {
    total(n) {
      total += n;
      draw();
    },
    tick() {
      count++;
      draw(count === total);
    },
    done() {
      if (finished) return;
      finished = true;
      stream.write('\r\x1b[2K');
    },
  };
}
