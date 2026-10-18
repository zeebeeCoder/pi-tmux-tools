import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISPLAY, encodeDisplay, decodeDisplay, casFormat, updateDisplay, displayRows } from '../src/display.js';
const proc = pid => ({pid, birth:'birth:'+pid, live:true, ppid:1, pgid:pid, tpgid:pid, tty:2});
const record = (generation='1', extra={}) => ({version:1, agent:'pi', owner:'a'.repeat(32), generation,
  state:'active', socket:'/tmp/owned.sock', pane:'%2', tty:'/dev/ttys5', server:proc(1), root:proc(2), process:proc(3),
  sessionId:'one', sessionFile:null, cwd:'/cwd', activitySequence:'0',
  activity:{state:'unknown', reason:'activation', observedAt:null}, ...extra});
function store(initial=null) {
  let raw=initial?encodeDisplay(initial):'';
  let verified=0;
  const ops={read:()=>raw, verify:()=>{verified++;return true;}, cas:(expected,next)=>{if(raw===expected)raw=next;return raw;}};
  return {ops, get:()=>raw?decodeDisplay(raw):null, verified:()=>verified};
}
test('display is additive/versioned; encoding cannot interpolate agent data as tmux formats',()=>{
  const r=record('1',{cwd:'/a\t\n#{pane_id},bad'});
  assert.equal(decodeDisplay(encodeDisplay(r)).cwd,r.cwd);
  assert.match(casFormat('',encodeDisplay(r)),/^#\{\?/);
  assert.throws(()=>casFormat('#{evil}','safe'));
  for(const raw of ['bad','{}',Buffer.from('{}').toString('base64url')])assert.throws(()=>decodeDisplay(raw));
});
test('late generation, old shutdown, scoped event and stale Pi sequence cannot overwrite current',()=>{
  const newer=record('20',{owner:'b'.repeat(32),sessionId:'two',activitySequence:'5'});
  for(const older of [record(),record('1',{state:'closed'}),record('10',{sessionId:'two'})]) {
    const s=store(newer);assert.equal(updateDisplay(older,s.ops),false);assert.deepEqual(s.get(),newer);
  }
  const s=store(newer);
  assert.equal(updateDisplay({...newer,activitySequence:'4',activity:{...newer.activity,state:'working'}},s.ops),false);
  assert.equal(updateDisplay({...newer,state:'closed'},s.ops),true);
  assert.equal(updateDisplay({...newer,activitySequence:'6'},s.ops),false,'closed generation is terminal');
  const fork=record('21',{owner:'c'.repeat(32),state:'closed'});
  assert.equal(updateDisplay(fork,{...s.ops,activation:true}),true,'closed fork activation installs newer barrier');
  assert.equal(updateDisplay(newer,s.ops),false);
});
test('equal kernel generation across distinct activations suppresses ambiguity, never arrival-order selection',()=>{
  const a=record('10',{agent:'claude'}),b={...a,owner:'b'.repeat(32),sessionId:'two'},s=store(a);
  assert.equal(updateDisplay(b,{...s.ops,activation:true}),true);
  assert.equal(s.get().state,'closed');assert.equal(s.get().registrationReason,'ambiguous-generation');
  assert.equal(updateDisplay(a,s.ops),false);
  assert.equal(updateDisplay({...b,owner:'c'.repeat(32),generation:'11'},{...s.ops,activation:true}),true);
  assert.equal(s.get().state,'active');
});
test('CAS interleaving: new activation between old read and write survives old retry',()=>{
  const old=record(), newer=record('2',{owner:'b'.repeat(32),sessionId:'new'}), s=store(old);
  let first=true;
  const cas=(expected,next)=>{if(first){first=false;updateDisplay(newer,s.ops);}return s.ops.cas(expected,next);};
  assert.equal(updateDisplay({...old,state:'closed'},{...s.ops,cas}),false);
  assert.deepEqual(s.get(),newer);
});
test('cross-process CAS retry re-verifies ownership; old process cannot replace new owner',()=>{
  const old=record(), newer=record('1',{process:proc(4),owner:'b'.repeat(32)}), s=store(old);
  let first=true, verifications=0;
  assert.equal(updateDisplay({...old,activitySequence:'1'},{...s.ops,
    cas:(expected,next)=>{if(first){first=false;updateDisplay(newer,s.ops);}return s.ops.cas(expected,next);},
    verify:()=>{verifications++;return false;}}),false);
  assert.equal(verifications,1);assert.deepEqual(s.get(),newer);
  assert.equal(updateDisplay({...old,state:'closed'},s.ops),false);
  assert.equal(updateDisplay(old,{...s.ops,eventOnly:true}),false);
});
test('Claude retries rederive AFTER read, including delayed SessionStart and terminal SessionEnd',()=>{
  const r=record('10',{agent:'claude'}),s=store(r);
  let working=false, derives=0, first=true;
  const derive=r=>{derives++;return {...r,activity:{...r.activity,state:working?'working':'unknown'}};};
  assert.equal(updateDisplay(r,{...s.ops,derive,cas:(expected,next)=>{
    if(first){first=false;working=true;updateDisplay(r,{...s.ops,derive});}
    return s.ops.cas(expected,next);
  }}),true);
  assert.ok(derives>=3);assert.equal(s.get().activity.state,'working');
  assert.equal(updateDisplay(r,{...s.ops,eventOnly:true,derive:r=>({...r,state:'closed'})}),true);
  assert.equal(updateDisplay(r,{...s.ops,activation:true,derive}),false);
});
test('fast reader is exactly one list command; no history/options/probes, stale owners honestly recorded',()=>{
  const r=record(), raw=encodeDisplay(r); let calls=0;
  const line=raw=>['%2','1','2','/dev/ttys5','$1','@2','2','0','session','window',raw].join('\t');
  const rows=displayRows(r.socket,(socket,args)=>{calls++;assert.equal(socket,r.socket);
    assert.deepEqual(args.slice(0,3),['list-panes','-a','-F']);
    return [line(raw),line('bad'),line(encodeDisplay({...r,state:'closed'})),line(encodeDisplay({...r,root:proc(9)}))].join('\n');
  });
  assert.equal(calls,1);assert.equal(rows.length,1);assert.equal(rows[0].status,'recorded-last-observed');
  assert.equal(rows[0].binding.process.pid,3,'no live claim about this PID');
});
