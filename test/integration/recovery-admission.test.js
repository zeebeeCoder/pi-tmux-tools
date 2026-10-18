import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Coordinator } from '../../src/recovery/coordinator.js';
import { probeAdmission } from '../../src/recovery/admission.js';
import { locked, publish } from '../../src/recovery/model.js';

function setup() {
  const root=fs.realpathSync(fs.mkdtempSync('/tmp/drone-admission-'));fs.chmodSync(root,0o700);
  const c=Coordinator.create({store:join(root,'store'),runtime:join(root,'runtime'),settings:{width:100,height:32,base:0,paneBase:0,renumber:'off'}});
  return {root,c};
}
function snapshot(c) {
  return {owner:fs.readFileSync(join(c.root,'ownership.json'),'utf8'),pointer:fs.readFileSync(join(c.store,'latest.json'),'utf8'),
    audit:fs.readFileSync(join(c.root,'audit.jsonl'),'utf8'),entries:fs.readdirSync(c.root).sort(),runtime:fs.readdirSync(c.owner.runtime).sort()};
}
async function refuse(c,label,reason) {
  const before=snapshot(c);await assert.rejects(c.connect(label),reason);
  assert.deepEqual(snapshot(c),before,'no pin/socket/entry/pointer/audit mutation');
  assert(!fs.existsSync(join(c.owner.runtime,label+'.sock')));
}
async function source(c) {
  const s=c.start('source','source');c.tmux(s,['rename-session','-t','bootstrap','alpha']);c.tmux(s,['rename-window','-t','alpha:0','main']);
  const pair=await c.save(s);return {s,pair};
}
async function childProcess() {
  const child=spawn(process.execPath,['-e','process.stdin.resume()'],{env:{PATH:'/usr/bin:/bin'},stdio:['pipe','ignore','ignore']});
  await once(child,'spawn');
  const identity=probeAdmission({pids:[child.pid],sockets:[]}).pids[child.pid];assert.equal(identity.state,'present');
  return {child,identity,close:async()=>{const exit=once(child,'close');child.stdin.end();await exit;}};
}

test('DR-1 fresh authority defeats stale object; source and recovered live servers refuse new labels', {timeout:60000},async()=>{
  const {root,c}=setup(),stale=new Coordinator(c.root);
  try {
    const {s}=await source(c);
    // This object predates every server record; connect must reload under lock.
    await refuse(stale,'blockedsource',/DR-1.*still live/);
    assert.equal((await stale.connect('source')).status,'attach-only');
    await c.stop(s);
    const recovered=await c.connect('recovered');assert.equal(recovered.status,'complete');
    await refuse(c,'blockedrecovered',/DR-1.*still live/);
    assert.equal((await c.connect('recovered')).status,'attach-only');
    await c.stop(recovered.socket);
    const next=await c.connect('afterexit');assert.equal(next.status,'complete');
  } finally {await new Coordinator(c.root).cleanup();fs.rmSync(root,{recursive:true});}
});

test('DR-1 known process survivor WITHOUT socket blocks; selected manifest-only owner also blocks', {timeout:60000},async()=>{
  const {root,c}=setup();let survivor;
  try {
    const {s,pair}=await source(c);await c.stop(s);fs.unlinkSync(s);
    survivor=await childProcess();
    // No managed server/socket remains. Only a tracked private process survives.
    c.owner.agents.push({pid:survivor.child.pid,birth:survivor.identity.birth});await locked(c.root,l=>c.persist(l));
    await refuse(c,'blockedsurvivor',/DR-1.*known process still live/);
    await survivor.close();survivor=null;
    // Fresh untracked process is represented only in a valid saved binding.
    survivor=await childProcess();
    const m=structuredClone(pair.manifest),p=Object.values(m.panes)[0];
    p.binding={file:join(root,'invented.jsonl'),id:'invented',cwd:p.cwd,owner:'a'.repeat(32),generation:'1',pid:survivor.child.pid,birth:survivor.identity.birth};
    publish(c.store,c.root,pair.layout,m);
    assert(!c.owner.agents.some(a=>a.pid===survivor.child.pid && a.birth===survivor.identity.birth));
    await refuse(c,'blockedmanifest',/DR-1.*known process still live/);
    await survivor.close();survivor=null;
    // Missing exact file is then a gap, not a bypass of the managed-live check.
    assert.equal((await c.connect('afterexit')).status,'complete-with-gaps');
  } finally {if(survivor)await survivor.close();await new Coordinator(c.root).cleanup();fs.rmSync(root,{recursive:true});}
});

test('DR-1 probe uncertainty, stale source metadata and unresolved phases refuse without effects', {timeout:60000},async()=>{
  const {root,c}=setup();
  try {
    const {s,pair}=await source(c);await c.stop(s);
    const native=c.admissionProbe.bind(c);
    for(const result of [undefined,{state:'unknown',reason:'injected permission error'}]) {
      c.admissionProbe=request=>{const r=native(request);r.pids[pair.manifest.provenance.pid]=result;return r;};
      await refuse(c,'unknownpid',/DR-1.*unknown process absence/);
    }
    c.admissionProbe=request=>{const r=native(request);r.sockets[s]={state:'unknown',reason:'injected socket timeout'};return r;};
    await refuse(c,'unknownsocket',/DR-1.*unknown socket absence/);
    // Existing target remains read-only, even if a probe would throw.
    c.admissionProbe=()=>{throw Error('must not probe attach-only');};
    assert.equal((await c.connect('source')).status,'attach-only');c.admissionProbe=native;
    const m=structuredClone(pair.manifest);m.provenance.birth='stale-source-birth';publish(c.store,c.root,pair.layout,m);
    await refuse(c,'stalesource',/DR-1.*stale\/unanchored manifest/);
    publish(c.store,c.root,pair.layout,pair.manifest);
    // Controlled shell-only history fault injection, not a production phase reset.
    for(const phase of ['creating','restoring','launching','uncertain']) {
      c.owner.servers[s].phase=phase;await locked(c.root,l=>c.persist(l));
      await refuse(c,'unresolved',/DR-1.*unresolved managed generation/);
      assert.equal((await c.connect('source')).status,'attach-only');
    }
    // Cleanup stops resources but does not resolve/erase uncertain history.
  } finally {await new Coordinator(c.root).cleanup();fs.rmSync(root,{recursive:true});}
});
