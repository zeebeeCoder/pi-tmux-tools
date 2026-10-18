// Explicit opt-in benchmark. Only disposable servers, synthetic owners and PTY.
// Run: node test/benchmark-picker.js [label] [--strict-scan]
// --strict-scan reproduces the old SCAN cost; PTY always runs current picker.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { inspect } from '../src/runtime.js';
import * as runtime from '../src/runtime.js';
import { makeChoices, shellQuote as q } from '../src/picker.js';
const repo = resolve(import.meta.dirname, '..'), dir = mkdtempSync(join(tmpdir(), 'picker-bench-'));
const socket = join(dir, 'owned.sock'), trace = join(dir, 'calls'), log = join(dir, 'pty.log');
const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
const realPython = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim();
const originalPath = process.env.PATH;
const fast = Boolean(runtime.readDisplay) && !process.argv.includes('--strict-scan');
const run = args => execFileSync(realTmux, ['-u', '-N', '-S', socket, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).replace(/\n$/, '');
const wait = async fn => { for (let i=0;i<1000;i++) { const v=fn(); if(v) return v; await sleep(5); } throw Error('fixture timeout'); };
const counts = () => readFileSync(trace,'utf8').split('\n').reduce((a,s) => { if(s) a[s]=(a[s]??0)+1; return a; }, {});
let client;
try {
  mkdirSync(join(dir,'bin'));
  for(const [name, real] of [['tmux', realTmux], ['python3', realPython]])
    writeFileSync(join(dir,'bin',name), '#!/bin/sh\nprintf '+q(name+'\n')+' >> '+q(trace)+'\nexec '+q(real)+' "$@"\n', { mode: 0o755 });
  execFileSync(realTmux, ['-u','-S',socket,'-f','/dev/null','new-session','-d','-s','fixture','exec sleep 120']);
  for(let i=1;i<8;i++) {
    const ready=join(dir,'owner-'+i);
    const cmd = i<=5 ? 'exec env -i '+['PATH='+originalPath,'HOME='+dir,'TERM=xterm-256color'].map(q).join(' ')+
      ' TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" '+[process.execPath,join(repo,'test/fixtures/picker-agent.js'),ready,i%2?'pi':'claude','bench-'+i,dir].map(q).join(' ') : 'exec sleep 120';
    run(['new-window','-d','-t','fixture','-n','pane-'+i,cmd]);
    if(i<=5) await wait(()=>existsSync(ready));
  }
  process.env.PATH=join(dir,'bin')+':'+originalPath;
  writeFileSync(trace,'');
  const scans=[];
  for(let i=0;i<5;i++) {
    const t=performance.now();
    const rows=fast ? runtime.readDisplay(socket) : inspect(socket,{persistence:false});
    const choices=makeChoices(rows);
    if(choices.size!==5) throw Error('expected five agents');
    scans.push(performance.now()-t);
  }
  const scanCalls=counts();
  if(fast && (scanCalls.python3 || scanCalls.tmux!==5)) throw Error('fast listing must use one tmux call and zero process probes');
  run(['set-environment','-g','PATH',process.env.PATH]);
  run(['set-option','-g','prefix','C-Space']);
  const command=['env','PATH='+process.env.PATH,process.execPath,join(repo,'bin/picker.js')].map(q).join(' ')+
    ' open --socket #{q:socket_path} --client #{q:client_name} --client-pid #{client_pid}';
  run(['bind-key','a','run-shell','-b',command]);
  client=spawn(realPython,[join(repo,'test/fixtures/picker-client.py'),socket,'fixture',log],{stdio:['pipe','pipe','pipe'],env:{PATH:originalPath,HOME:dir,TERM:'xterm-256color'}});
  await wait(()=>run(['list-clients','-F','#{client_name}']));
  const pty=[], ptyCalls=[];
  for(let i=0;i<3;i++) {
    await sleep(400);
    const offset=existsSync(log)?readFileSync(log).length:0;
    writeFileSync(trace,'');
    const t=performance.now(); client.stdin.write('\0a');
    await wait(()=>readFileSync(log).subarray(offset).includes(Buffer.from('bench-')));
    pty.push(performance.now()-t); ptyCalls.push(counts());
    client.stdin.write('\x1b');
  }
  console.log(JSON.stringify({label:process.argv[2]??'current',scanPath:fast?'materialized':'legacy-strict',panes:8,agents:5,scanMs:scans,scanCallsTotal:scanCalls,ptyKeyToRowsMs:pty,ptyCalls},null,2));
} finally {
  process.env.PATH=originalPath;
  try{run(['kill-server']);}catch{}
  if(client){client.stdin.destroy();client.kill('SIGTERM');}
  rmSync(dir,{recursive:true,force:true});
}
