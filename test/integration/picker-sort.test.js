import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { shellQuote } from '../../src/picker.js';
import { DISPLAY, encodeDisplay } from '../../src/display.js';
import { SORTS } from '../../src/picker-sort.js';

const repo = resolve(import.meta.dirname, '../..');
test('owned real fzf/PTY: bidirectional arrow sort/wrap, Ctrl-B/F query editing, refresh, empty/no-match and exact navigation', {timeout:90000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-picker-sort-'));
  const socket = join(dir, 'owned.sock'), logPath = join(dir, 'pty.log');
  let client;
  const run = args => execFileSync('tmux', ['-u','-N','-S',socket,...args], {
    encoding:'utf8', timeout:2000, stdio:['ignore','pipe','pipe']
  }).replace(/\n$/, '');
  // tmux may insert SGR resets inside a header word across PTY writes.
  const log = () => existsSync(logPath) ? stripVTControlCharacters(readFileSync(logPath, 'utf8')) : '';
  const wait = async (fn, message) => {
    for (let i=0;i<160;i++) { const v=fn(); if (v) return v; await sleep(50); }
    throw Error('Timeout: '+message+'\n'+log().slice(-3500));
  };
  const key = s => client.stdin.write(s);
  const left = '\x1b[D', right = '\x1b[C';
  const agent = async (id, folder, name, kind, state, observedAt) => {
    const ready = join(dir,id+'.json'), cwd = join(dir,folder);
    mkdirSync(cwd, {recursive:true});
    const cmd = 'exec env -i '+['PATH='+process.env.PATH,'HOME='+dir,'TERM=xterm-256color'].map(shellQuote).join(' ')+
      ' TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" '+[process.execPath,join(repo,'test/fixtures/picker-agent.js'),ready,kind,id,cwd].map(shellQuote).join(' ');
    const pane = run(['new-window','-d','-P','-F','#{pane_id}','-t','origin','-n',id,cmd]);
    await wait(() => existsSync(ready), 'synthetic owner '+id);
    const record = JSON.parse(readFileSync(ready,'utf8'));
    // Only test-owned display records; identity stays intact for real Enter
    // validation. No writer/schema modifications or production registry access.
    run(['set-option','-p','-t',pane,DISPLAY,encodeDisplay({...record, sessionName:name,
      activity:{state, reason:'sort fixture', observedAt}})]);
    return {pane,record};
  };
  let clientName;
  const current = () => {
    const session = run(['list-clients','-F','#{client_name}\t#{client_session}']).split('\n')
      .map(s => s.split('\t')).find(r => r[0] === clientName)?.[1];
    return run(['display-message','-p','-t','='+session+':','#{pane_id}']);
  };
  const open = async () => {
    await sleep(400);
    const offset = log().length;
    key('\0a');
    await wait(() => log().slice(offset).includes('Live agents>') && log().slice(offset).includes('Sort: Recent'), 'fresh Recent popup');
    await sleep(120);
  };
  const control = async (keyCode, sort) => {
    const offset = log().length;
    key(keyCode);
    await wait(() => log().slice(offset).includes('Sort: '+sort) && log().slice(offset).includes('Live agents>'), 'control redraw '+sort);
    await sleep(120);
    return log().slice(offset);
  };
  const select = async (pane, why) => {
    key('\r');
    await wait(() => current() === pane, why);
  };
  const filter = async query => { key(query); await sleep(200); };
  try {
    execFileSync('tmux', ['-u','-S',socket,'-f','/dev/null','new-session','-d','-s','origin','exec sleep 120']);
    const origin = run(['display-message','-p','-t','origin:','#{pane_id}']);
    run(['set-option','-g','prefix','C-Space']);
    run(['bind-key','a','run-shell','-b',[process.execPath,join(repo,'bin/picker.js')].map(shellQuote).join(' ')+
      ' open --socket #{q:socket_path} --client #{q:client_name} --client-pid #{client_pid}']);
    const stamp = Date.now()-10000;
    const a = await agent('weak-match','z-folder 界\u202e','X lengthy Q 界😀e\u0301','pi','idle',new Date(stamp+2).toISOString());
    const b = await agent('strong-match','b-folder','XQ','claude','needs-attention',new Date(stamp+1).toISOString());
    const c = await agent('nonmatch','a-folder','A nonmatch','pi','working',new Date(stamp).toISOString());
    client = spawn('python3', [join(repo,'test/fixtures/picker-client.py'),socket,'origin',logPath], {
      stdio:['pipe','pipe','pipe'], env:{PATH:process.env.PATH,HOME:dir,TERM:'xterm-256color'}
    });
    clientName = await wait(() => run(['list-clients','-F','#{client_name}']), 'attached owned client');

    // A has weaker fuzzy score than B, but is newer by one millisecond. The
    // displayed Last event ages are identical. Enter must follow chosen order.
    await open(); await filter('xq'); await select(a.pane, 'Recent beats fzf match score');
    await open(); await filter('xq');
    await control(right,'Project/folder');
    await control('\x12','Project/folder');
    await select(b.pane, 'Right/R preserve Project AND query (otherwise A or C wins)');

    await open(); await filter('xq');
    await control(right,'Project/folder'); await control(right,'Session');
    await select(a.pane, 'Session fuzzy subset stays alphabetic, not match-score sorted');
    await open(); await filter('xq');
    for (const sort of SORTS.slice(1,4)) await control(right,sort);
    await select(b.pane, 'Agent chooses exact Claude pane after reorder');
    await open(); await filter('xq');
    for (const sort of SORTS.slice(1)) await control(right,sort);
    await select(b.pane, 'Status attention first');

    // Reopening is Recent even after Status; full cycle wraps back to Recent.
    await open(); await filter('xq');
    for (const sort of [...SORTS.slice(1),'Recent']) await control(right,sort);
    await select(a.pane, 'Right cycle wraps to Recent with query intact');

    await open(); await filter('xq');
    await control(left,'Status');
    await control('\x12','Status');
    await select(b.pane, 'Left wraps Recent to Status and refresh preserves query/sort');
    await open(); await filter('xq');
    for (const sort of [...SORTS.slice(1).reverse(),'Recent']) await control(left,sort);
    await select(a.pane, 'Left full cycle wraps to Recent with query intact');

    // Each cursor binding is necessary: xz -> x|z -> xq|z -> xqz| -> xq.
    // Missing either Ctrl-B or Ctrl-F leaves xz (no matches) after backspace.
    await open(); await control(right,'Project/folder');
    await filter('xz');
    key('\x02q\x06\x7f'); await sleep(200);
    const edited = await control(left,'Recent');
    assert.ok(edited.includes('xq'), 'Ctrl-B/F actually edit query to xq');
    await control('\x12','Recent');
    await select(a.pane, 'cursor-edited query survives Left and refresh');

    // No-match arrows exit fzf status 1, not cancellation. Query must survive
    // both directions and refresh (no rows before ctrl-u); C is project-first.
    await open(); await filter('no-such-match-987654');
    for (const [code,sort] of [[left,'Status'],['\x12','Status'],[right,'Recent'],[right,'Project/folder'],['\x12','Project/folder']]) {
      const redraw = await control(code,sort);
      assert.ok(redraw.includes('no-such-match-987654'), 'no-match query still displayed after control');
      assert.ok(!redraw.includes('XQ') && !redraw.includes('A nonmatch'), 'still no matching rows');
    }
    assert.equal(current(),a.pane, 'no-match controls never navigate');
    key('\x15'); await sleep(200); await select(c.pane, 'clear preserved no-match query in Project');

    // Nothing to select still permits either arrow/wrap and refresh in that mode.
    for (const owner of [a,b,c]) process.kill(owner.record.process.pid,'SIGUSR2');
    await wait(() => run(['list-panes','-a','-F','#{'+DISPLAY+'}']).split('\n').filter(Boolean)
      .every(raw => JSON.parse(Buffer.from(raw,'base64url')).record.state === 'closed'), 'closed display fixtures');
    run(['switch-client','-c',clientName,'-t',origin]);
    await open();
    await control(left,'Status'); await control('\x12','Status');
    await control(right,'Recent'); await control(right,'Project/folder');
    await agent('revived-z','z-revived','Z new','pi','idle',new Date().toISOString());
    const revived = await agent('revived-a','a-revived','A new','pi','idle',new Date(stamp).toISOString());
    await control('\x12','Project/folder');
    await select(revived.pane,'empty-list arrows survive refresh in Project, not Recent');
    await open(); key('\x1b'); await sleep(350);
    assert.equal(current(),revived.pane,'Esc after sorted reopen never navigates');
  } finally {
    try { run(['kill-server']); } catch {}
    if (client) { client.stdin.destroy(); client.kill('SIGTERM'); }
    rmSync(dir,{recursive:true,force:true});
  }
});
