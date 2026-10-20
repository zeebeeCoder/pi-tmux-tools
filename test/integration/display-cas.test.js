import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { observePane, tmux, publish, readDisplay, validateTarget } from '../../src/runtime.js';
import { PREFIX } from '../../src/logic.js';
import { shellQuote as q } from '../../src/picker.js';
import { DISPLAY, encodeDisplay, decodeDisplay, casFormat } from '../../src/display.js';
const exec=promisify(execFile);
test('real tmux atomic CAS and frozen old writer cannot erase newer generation', {timeout:30000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'display-cas-')),socket=join(dir,'owned.sock');let child;
  const originalPath=process.env.PATH;
  try {
    execFileSync('tmux',['-u','-S',socket,'-f','/dev/null','new-session','-d','-s','fixture','exec sleep 120']);
    const current=observePane(socket,'%0');
    const r={version:1,agent:'pi',owner:'a'.repeat(32),generation:'1',state:'active',socket,pane:'%0',
      tty:current.tty,server:current.server,root:current.root,process:current.root,cwd:dir,sessionId:'one',sessionFile:null,
      activitySequence:'0',activity:{state:'unknown',reason:'fixture',observedAt:null}};
    publish(r);
    const get=()=>tmux(socket,['display-message','-p','-t','%0','#{'+DISPLAY+'}']);
    const expected=get(), candidates=Array.from({length:20},(_,i)=>encodeDisplay({...r,activitySequence:String(i+1)}));
    await Promise.all(candidates.map(next=>exec('tmux',['-u','-N','-S',socket,'set-option','-p','-F','-t','%0',DISPLAY,casFormat(expected,next)])));
    assert.ok(candidates.includes(get()));
    const winner=get();
    tmux(socket,['set-option','-p','-F','-t','%0',DISPLAY,casFormat(expected,encodeDisplay(r))]);
    assert.equal(get(),winner,'stale expected value never overwrites the winner');
    // Freeze old shutdown at the read/CAS boundary, then install generation 2.
    const ready=join(dir,'ready'),release=join(dir,'release');
    child=spawn(process.execPath,[resolve('test/fixtures/display-writer.js'),Buffer.from(JSON.stringify({...r,state:'closed'})).toString('base64url'),ready,release],{stdio:['ignore','pipe','pipe']});
    const exit=new Promise((res,rej)=>{child.once('error',rej);child.once('exit',code=>code===0?res():rej(Error('writer exit '+code)));});
    for(let i=0;i<500&&!existsSync(ready);i++)await sleep(10);
    assert.ok(existsSync(ready));
    const newer={...r,owner:'b'.repeat(32),generation:'2',sessionId:'two'};publish(newer);
    writeFileSync(release,'go');await exit;
    assert.equal(decodeDisplay(get()).sessionId,'two');
    assert.equal(readDisplay(socket)[0].binding.owner,newer.owner);
    // Formats in labels are inert, line controls are sanitized in single scan.
    // tmux 3.7 refuses control characters in names itself; formats must stay inert either way.
    const rename=(command,target,hostile,plain)=>{try{tmux(socket,[command,'-t',target,hostile]);return true;}catch{tmux(socket,[command,'-t',target,plain]);return false;}};
    const sessionControls=rename('rename-session','fixture','hostile\t##{pane_id}','hostile ##{pane_id}');
    const windowControls=rename('rename-window','%0','window\n##{pane_id}','window ##{pane_id}');
    const rows=readDisplay(socket);assert.equal(rows.length,1);
    assert.equal(rows[0].pane.sessionName,sessionControls?'hostile\\t#{pane_id}':'hostile #{pane_id}');
    assert.equal(rows[0].pane.windowName,windowControls?'window\\n#{pane_id}':'window #{pane_id}');

    // Actual executable tracing, not only a dependency seam. Unrelated stale
    // owners and corrupt history must not turn listing into diagnostics.
    const phantom=2147483000;
    tmux(socket,['set-option','-p','-t','%0',PREFIX+'f'.repeat(32),JSON.stringify({...r,owner:'f'.repeat(32),process:{...r.process,pid:phantom}})]);
    tmux(socket,['set-option','-p','-t','%0','@pi_continuity_event_v1_'+'e'.repeat(32),'bad-json']);
    const realTmux=execFileSync('which',['tmux'],{encoding:'utf8'}).trim();
    const realPython=execFileSync('which',['python3'],{encoding:'utf8'}).trim();
    const bin=join(dir,'bin'),trace=join(dir,'trace');mkdirSync(bin);
    for(const [name,real] of [['tmux',realTmux],['python3',realPython]])writeFileSync(join(bin,name),
      '#!/bin/sh\nprintf '+q(name+' %s\\n')+' "'+(name==='tmux'?'$5':'$*')+'" >> '+q(trace)+'\nexec '+q(real)+' "$@"\n',{mode:0o755});
    process.env.PATH=bin+':'+originalPath;writeFileSync(trace,'');
    assert.equal(readDisplay(socket).length,1);
    const listTrace=readFileSync(trace,'utf8');
    assert.equal(listTrace.split('\n').filter(Boolean).length,1);
    assert.match(listTrace,/tmux .*list-panes/);assert.ok(!listTrace.includes('python3'));
    writeFileSync(trace,'');
    const selected=validateTarget(socket,'%0',newer);
    assert.equal(selected.binding.owner,newer.owner);
    const probes=readFileSync(trace,'utf8').split('\n').filter(s=>s.startsWith('python3 '));
    assert.equal(probes.length,3);assert.ok(probes.every(s=>!s.includes(String(phantom))), 'only selected owner/server/root ancestry probed');
    tmux(socket,['set-option','-p','-t','%0',DISPLAY,'corrupt']);
    assert.doesNotThrow(()=>publish({...newer,activitySequence:'1'}), 'optional display failure must not discard successful registration');
    assert.equal(readDisplay(socket).length,0,'corrupt display fails closed, never reconstructed on list');
  } finally {
    process.env.PATH=originalPath;
    try{tmux(socket,['kill-server']);}catch{}
    if(child?.exitCode===null)child.kill('SIGTERM');
    rmSync(dir,{recursive:true,force:true});
  }
});
