#!/usr/bin/env node
import { EXIT, fail, main } from './main.js';

main().then(
  (code) => process.stdout.write('', () => process.exit(code)),
  (e: Error) => fail(EXIT.network, e.message),
);
