#!/usr/bin/env node
/**
 * The pixatar command: one-shot commands for scripts, and `serve` (JSON lines over stdin and
 * stdout, see protocol.ts) for long-lived clients such as the Python package, so each avatar
 * costs milliseconds rather than a Node start-up.
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { parseArgs } from 'node:util';

import { fromBase64 } from './bytes.js';
import { handle, type Op, type Request } from './protocol.js';

const USAGE = `Usage:
  pixatar avatar <seed> [--scale N] [--background color|transparent] [--text] [--out FILE]
  pixatar sheet <seed> [--scale N] [--text] [--out FILE]
  pixatar info <seed> [--background color|transparent] [--text]
  pixatar serve
  pixatar --version

A seed is a seed code (px.…) or any free text; --text reads one starting with px. as text.
Put -- before a seed that starts with a dash. avatar and sheet write PNG to --out, or to
stdout when it isn't a terminal. info prints JSON. serve answers one JSON request per line
on stdin with one JSON response per line on stdout, until stdin closes.
`;

function fail(message: string, code = 2): void {
  process.stderr.write(`pixatar: ${message}\n`);
  process.exitCode = code;
}

function serve(): void {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      request = undefined;
    }
    const response =
      request === undefined
        ? { id: null, ok: false, error: { code: 'invalid-request', message: 'A request is one line of JSON.' } }
        : handle(request);
    process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}

function main(argv: string[]): void {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        scale: { type: 'string' },
        background: { type: 'string' },
        text: { type: 'boolean' },
        out: { type: 'string', short: 'o' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    fail(`${(e as Error).message}\n\n${USAGE}`);
    return;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (values.version) {
    const r = handle({ op: 'version' });
    if (r.ok) process.stdout.write(`${String(r.version)} (pixel-agents ${(r.vendor as { version: string }).version})\n`);
    return;
  }
  // `.at`, typed `| undefined`: there may be no command or no seed.
  const command = positionals.at(0);
  const seed = positionals.at(1);
  const rest = positionals.slice(2);
  if (command === 'serve' && seed === undefined) {
    serve();
    return;
  }
  if (command !== 'avatar' && command !== 'sheet' && command !== 'info') {
    fail(`unknown command\n\n${USAGE}`);
    return;
  }
  if (seed === undefined || rest.length) {
    fail(`${command} takes one seed\n\n${USAGE}`);
    return;
  }

  const request: Request = { op: command satisfies Op, seed, text: values.text };
  if (values.scale !== undefined) request.scale = Number(values.scale);
  if (values.background !== undefined) request.background = values.background as Request['background'];
  const response = handle(request);
  if (!response.ok) {
    fail(response.error.message, 1);
    return;
  }
  if (command === 'info') {
    const { id: _id, ok: _ok, ...info } = response;
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    return;
  }
  const png = fromBase64(response.png as string);
  if (values.out !== undefined) fs.writeFileSync(values.out, png);
  else if (process.stdout.isTTY) fail('not writing a PNG to a terminal: use --out FILE or a pipe');
  else process.stdout.write(png);
}

main(process.argv.slice(2));
