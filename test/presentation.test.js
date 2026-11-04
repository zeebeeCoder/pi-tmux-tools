import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { sessionName, label, width, fit, fitTail, columns, heading, relativeAge, folders, stripColor, DOT_COLORS, validNameFields } from '../src/presentation.js';
import { makeChoices, parseResult, FZF, fzfEnv } from '../src/picker.js';
import { decodeDisplay, encodeDisplay } from '../src/display.js';
const proc = pid => ({pid, birth:'b'+pid, live:true, ppid:1, pgid:pid, tpgid:pid, tty:2});
const binding = {version:1, agent:'pi', owner:'a'.repeat(32), generation:'1', state:'active', socket:'/tmp/x', pane:'%2', tty:'/dev/ttys5',
  server:proc(1), root:proc(2), process:proc(3), sessionId:'long-internal-session-id', sessionFile:null, cwd:'/a/project',
  activity:{state:'working', reason:'fixture', observedAt:null}};
const row = (patch = {}, activity = binding.activity) => ({binding:{...binding, ...patch}, activity});

test('bounded hostile/long/Unicode names cannot supply ANSI, lines, bidi or surrogate controls', () => {
  const hostile = 'a\x1b[31mRED\x1b[0m\t\n\r\u202e\u2028\ud800' + '界😀e\u0301'.repeat(10000);
  const safe = sessionName(hostile);
  assert.ok(safe.length <= 256);
  assert.ok(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(safe));
  assert.match(safe, /\\u001b/);
  assert.equal(sessionName('  '), null);
  for (const value of [null, undefined, {}, 42]) assert.equal(sessionName(value), null);
  assert.equal(sessionName('  日本語 e\u0301 😀  '), '日本語 e\u0301 😀');
  assert.ok(label(hostile).length <= 513); // bounded even with astral characters
});

test('terminal-cell approximation preserves graphemes and alignment at responsive popup widths', () => {
  assert.equal(width('日本語'), 6);
  assert.equal(width('e\u0301'), 1);
  assert.equal(width('😀🇵🇱'), 4);
  assert.equal(width('1️⃣'), 2);
  assert.equal(width('©♥'), 2);
  assert.equal(width('©️♥️'), 4);
  assert.equal(fit('界界', 3), '界…');
  assert.equal(fitTail('long-parent/project', 9), '…/project');
  assert.equal(fit('e\u0301x', 1), '…');
  for (const terminalWidth of [40, 55, 68, 100, 180]) {
    const choices = makeChoices([row({sessionName:sessionName('日本語😀e\u0301'.repeat(100)), sessionNameSource:'pi-api'})], {terminalWidth});
    const c = [...choices.values()][0];
    assert.equal(width(c.line.split('\t')[1]), columns(terminalWidth).reduce((a,b)=>a+b,0) + 2 * (columns(terminalWidth).filter(Boolean).length - 1));
    assert.equal(width(choices.heading), width(c.line.split('\t')[1]));
    assert.ok(width(heading(columns(terminalWidth))) <= terminalWidth - 4);
    assert.ok(!/\p{Mark}$/u.test(c.line.split('\t')[1].trim()));
  }
});

test('folders use shortest distinguishing trailing parent, same cwd stays short, root explicit', () => {
  assert.deepEqual(folders(['/x/a/project','/y/b/project','/z/other','/x/a/project','/']), ['a/project','b/project','other','a/project','/']);
  assert.deepEqual(folders(['/x/a/project','/y/a/project']), ['x/a/project','y/a/project']);
  assert.deepEqual(folders(['/x/project/','/x/project/']), ['project','project']);
});

test('tmux location leads named and unnamed rows; safe, searchable, distinct split panes', () => {
  const pane = {sessionName:'alpha-desk', windowIndex:'3', windowName:'tui', paneIndex:'1'};
  const rows = [{...row(), pane}, {...row({pane:'%3', sessionName:'Named work', sessionNameSource:'pi-api'}),
    pane:{...pane, paneIndex:'2'}}];
  const choices = makeChoices(rows, {terminalWidth:180});
  const lines = [...choices.values()].map(c => c.line);
  for (const line of lines) {
    assert.match(line, /alpha-desk\s+3:tui/);
    assert.ok(!line.includes('Unnamed'));
  }
  assert.ok(lines.some(line => /3:tui\s+1\s+—/.test(line)));
  assert.ok(lines.some(line => /3:tui\s+2\s+Named work/.test(line)));
  for (const query of ['alpha-desk', '3:tui']) {
    const result = spawnSync(FZF, ['--ansi','--delimiter=\t','--with-nth=2..','--filter='+query], {
      input:[...choices.values()].map(c => c.inputLine).join('\n')+'\n', encoding:'utf8', env:fzfEnv()
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trimEnd().split('\n').length, 2);
  }
  const hostile = makeChoices([{...row(), pane:{...pane, sessionName:'a\x1b\t\n\u202e', windowName:'界😀e\u0301'}}], {terminalWidth:180});
  const c = [...hostile.values()][0];
  assert.ok(!/[\p{Cc}\p{Cf}]/u.test(c.line.replace('\t','')));
  assert.equal(parseResult({status:0, stdout:'\n\n'+c.line+'\n'},hostile).binding, c.binding);
  for (const terminalWidth of [32,40,55,64,80,100,120,180,240]) {
    const sizes = columns(terminalWidth);
    assert.ok(sizes.every(n => n >= 0));
    assert.ok(sizes[2] > 0 && sizes[3] > 0 && sizes[4] > 0);
    const view = makeChoices(rows, {terminalWidth});
    assert.ok(width(view.heading) <= terminalWidth - 4);
    assert.equal(width([...view.values()][0].line.split('\t')[1]), width(view.heading));
    if (terminalWidth < 64) assert.equal(sizes[5], 0);
    if (terminalWidth < 104) assert.equal(sizes[6], 0);
  }
});

test('relative observation age boundaries, missing/invalid/future; never used to change state', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  for (const [age, result] of [[0,'now'],[59999,'now'],[60000,'1m'],[119999,'1m'],[120000,'2m'],[3599999,'59m'],[3600000,'1h'],[86399999,'23h'],[86400000,'1d'],[172800000,'2d']]) {
    assert.equal(relativeAge(new Date(now-age).toISOString(),now),result);
  }
  for (const value of [null, undefined, '', 'invalid', new Date(now+1).toISOString()]) assert.equal(relativeAge(value,now),'unknown');
  const c = [...makeChoices([row({}, {...binding.activity, observedAt:'2000-01-01'})], {now}).values()][0];
  assert.match(c.inputLine, /\x1b\[38;5;226m/);
});

test('only code-owned colors; stripped fzf output roundtrips exact token/line, tampering rejected', () => {
  for (const state of [...Object.keys(DOT_COLORS), 'evil\x1b[31m']) {
    const choices = makeChoices([row({sessionName:sessionName('hey\x1b[31m bad'), sessionNameSource:'pi-api'}, {state})]);
    const c = [...choices.values()][0];
    assert.equal(stripColor(c.inputLine), c.line);
    assert.equal((c.inputLine.match(/\x1b/g) ?? []).length, 2);
    assert.equal(parseResult({status:0, stdout:'\n\n'+stripColor(c.inputLine)+'\n'},choices).binding,c.binding);
    assert.throws(()=>parseResult({status:0, stdout:'\n\n'+c.inputLine+'\n'},choices));
    assert.throws(()=>parseResult({status:0, stdout:'\n\n'+c.line+'x\n'},choices));
    assert.ok(!c.line.includes(binding.sessionId));
  }
});

test('real fzf ANSI parsing filters visible names/folders, not hidden tokens or internal metadata', () => {
  const choices = makeChoices([row({sessionName:'Visible conversation',sessionNameSource:'pi-api',cwd:'/x/visible-folder'})], {terminalWidth:180});
  const [[token,c]] = choices;
  const filter = query => spawnSync(FZF, ['--ansi','--delimiter=\t','--with-nth=2..','--filter='+query], {
    input:c.inputLine+'\n',encoding:'utf8',env:fzfEnv()
  });
  for (const query of ['Visible conversation','visible-folder']) {
    const result=filter(query);
    assert.equal(result.status,0); assert.equal(result.stdout,c.line+'\n');
  }
  for (const query of [token,binding.sessionId,binding.pane]) assert.equal(filter(query).status,1);
});

test('legacy metadata remains readable; conversation provenance validated; internal IDs never shown', () => {
  assert.deepEqual(decodeDisplay(encodeDisplay(binding)),binding);
  const c = [...makeChoices([row()]).values()][0];
  assert.match(c.line,/—/); assert.ok(!c.line.includes('long-i'));
  const choices = makeChoices([row(),row({pane:'%3',sessionId:'other-internal-session'})],{terminalWidth:180});
  assert.ok([...choices.values()].every(c => !/Unnamed|long-i|other-/.test(c.line)));
  assert.ok(![...makeChoices([row({sessionName:'unverified title'})]).values()][0].line.includes('unverified'));
  for (const name of ['bad\x1b', 'bad\n', 'bad\u202e', 'x'.repeat(257), 42]) {
    assert.throws(()=>encodeDisplay({...binding,sessionName:name,sessionNameSource:'pi-api'}));
  }
  assert.equal(validNameFields({sessionName:'x',sessionNameSource:'tmux-title'}),false);
  const named = {...binding,sessionName:sessionName('界'.repeat(400)),sessionNameSource:'pi-api'};
  assert.deepEqual(decodeDisplay(encodeDisplay(named)),named);
});
