#!/usr/bin/env node
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Coordinator, repo, plugin, PATH, quote } from '../../src/recovery/coordinator.js';
import { json, hash, load, locked } from '../../src/recovery/model.js';
const env = { PATH, HOME: '/nonexistent', LC_ALL: 'C', PYTHONDONTWRITEBYTECODE: '1' };
const cli = (...args) => JSON.parse(execFileSync(process.execPath, [join(repo,'bin/recovery.js'), ...args], { env, encoding:'utf8', timeout:120000, stdio:['ignore','pipe','pipe'] }));
const fileRef = (root,id) => ({ file:join(root,'histories',id+'.jsonl'), id, cwd:join(root,'workspace') });
function invented(root,id) {
  const b=fileRef(root,id), timestamp='2026-01-01T00:00:00.000Z';
  const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  fs.writeFileSync(b.file,[{type:'session',version:3,id,timestamp,cwd:b.cwd},
    {type:'message',id:'aabb0001',parentId:null,timestamp,message:{role:'user',content:'Invented inventory record: three blue compasses.',timestamp:1767225600000}},
    {type:'message',id:'aabb0002',parentId:'aabb0001',timestamp,message:{role:'assistant',content:[{type:'text',text:'Invented historical answer: three blue compasses.'}],api:'openai-responses',provider:'openai',model:'gpt-4o',usage,stopReason:'stop',timestamp:1767225600000}},
    {type:'thinking_level_change',id:'aabb0003',parentId:'aabb0002',timestamp,thinkingLevel:'off'}].map(JSON.stringify).join('\n')+'\n',{mode:0o600}); return b;
}
function hashes() {
  const paths=[join(repo,'extension.ts'),join(repo,'src/runtime.js'),'/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/main.js','/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js'];
  for(const dir of ['scripts','save_command_strategies']) for(const n of fs.readdirSync(join(plugin,dir))) if(fs.statSync(join(plugin,dir,n)).isFile()) paths.push(join(plugin,dir,n));
  paths.push(join(plugin,'resurrect.tmux'));
  for(const p of ['src/process-info.py','src/recovery/admission.js','src/recovery/admission-probe.py','src/recovery/model.js','src/recovery/coordinator.js','src/recovery/tmux_guard.py','src/recovery/resurrect-contract.json','bin/recovery.js','test/manual/durable-recovery.js'])paths.push(join(repo,p));
  return Object.fromEntries(paths.map(p=>[p,hash(fs.readFileSync(p))]));
}
function refusedWithoutEffects(c, label, reason) {
  const ownership=fs.readFileSync(join(c.root,'ownership.json'));
  const pointer=fs.readFileSync(join(c.store,'latest.json'));
  const audit=fs.readFileSync(join(c.root,'audit.jsonl'));
  const entries=fs.readdirSync(c.root).sort();
  let refusal;
  try { cli('recover',c.root,label); assert.fail('fresh recovery must refuse'); }
  catch(e) {
    assert.equal(e.status,1,'expected CLI refusal, not test assertion');
    refusal=JSON.parse(String(e.stderr)); assert.match(refusal.reason,reason);
  }
  assert.deepEqual(fs.readFileSync(join(c.root,'ownership.json')),ownership);
  assert.deepEqual(fs.readFileSync(join(c.store,'latest.json')),pointer);
  assert.deepEqual(fs.readFileSync(join(c.root,'audit.jsonl')),audit);
  assert.deepEqual(fs.readdirSync(c.root).sort(),entries,'no pin/profile/lock remains');
  assert(!fs.existsSync(join(c.owner.runtime,label+'.sock')));
  assert(!JSON.parse(ownership).servers[join(c.owner.runtime,label+'.sock')]);
  return refusal;
}
function files(root) { return fs.readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(root,e.name)):e.isFile()?[join(root,e.name)]:[]); }
async function saveChild(root) {
  const c=new Coordinator(join(root,'store')), a=fileRef(root,'fixture-A'), b=fileRef(root,'fixture-B'), d=fileRef(root,'fixture-C');
  const s=c.start('source','source');
  for(const name of ['alpha','beta']) {
    c.tmux(s,['new-session','-d','-s',name,'-c',a.cwd,'-x','100','-y','32']);
    c.tmux(s,['rename-window','-t',name+':1',name+'-main']);
    c.tmux(s,['split-window','-d',name==='alpha'?'-h':'-v','-t',name+':1','-c',join(root,'tools')]);
  }
  c.tmux(s,['kill-session','-t','bootstrap']);
  c.tmux(s,['set-option','-g','renumber-windows','on']);
  const t=c.topology(s), pa=t.panes['alpha:1.1'].runtime, pb=t.panes['beta:1.1'].runtime;
  c.tmux(s,['respawn-pane','-k','-t',pa,'-c',a.cwd,c.piCommand(s,a.file,true)]); await c.registration(s,pa,a);
  c.tmux(s,['respawn-pane','-k','-t',pb,'-c',b.cwd,c.piCommand(s,b.file)]); await c.registration(s,pb,b);
  c.tmux(s,['respawn-pane','-k','-t',t.panes['alpha:1.2'].runtime,'-c',join(root,'tools'),'exec /bin/bash --noprofile --norc -c '+quote('read -r unused')+' COMMAND_CANARY_NOT_SAVED_92']);
  const one=cli('save',c.root,'source');
  c.tmux(s,['send-keys','-t',pa,'-l','/fixture-resume '+d.file]); c.tmux(s,['send-keys','-t',pa,'Enter']); await c.registration(s,pa,d);
  const two=cli('save',c.root,'source');
  assert.equal(one.layout,two.layout); assert.notEqual(one.pointer.pair,two.pointer.pair);
  assert.equal(two.manifest.panes['alpha:1.1'].binding.file,d.file);
  assert.deepEqual(load(c.store,c.root,one.pointer).manifest,one.manifest);
  const before=fs.readFileSync(join(c.store,'latest.json'));
  await assert.rejects(c.save(s,p=>{if(p==='before-pointer')throw Error('injected publication failure');}));
  assert.deepEqual(fs.readFileSync(join(c.store,'latest.json')),before);
  await assert.rejects(c.save(s,p=>{if(p==='after-capture')c.tmux(s,['rename-window','-t','alpha:1','drift']);}));
  c.tmux(s,['rename-window','-t','alpha:1','alpha-main']);
  assert.deepEqual(fs.readFileSync(join(c.store,'latest.json')),before);
  const capture=files(c.store).concat(fs.readdirSync(c.root).filter(n=>n.startsWith('capture-')).flatMap(n=>files(join(c.root,n))));
  assert(capture.every(p=>!fs.readFileSync(p,'utf8').includes('COMMAND_CANARY_NOT_SAVED_92')));
  console.log(json({one,two,source:s,checks:['conversation-only change / prior pair retained','prepublication failure / drift retain latest','command canary absent upstream and committed']}));
}
async function main() {
  const base=join(repo,'.recovery-test-state'); fs.mkdirSync(base,{recursive:true,mode:0o700});
  const root=join(base,randomUUID()); fs.mkdirSync(root,{mode:0o700});
  for(const n of ['workspace','tools','histories'])fs.mkdirSync(join(root,n),{mode:0o700});
  const runtime=fs.realpathSync('/tmp')+'/durable-recovery-'+randomUUID();
  const settings={width:100,height:32,base:1,paneBase:1,renumber:'on'};
  const config=join(root,'config.json'); fs.writeFileSync(config,json({store:join(root,'store'),runtime,settings}));
  const evidence=join(repo,'evidence/durable-recovery-delegation','dr1-'+new Date().toISOString().replaceAll(':','-'));
  const report={success:false,checks:[],hashesBefore:hashes(),versions:{node:process.version,pi:JSON.parse(fs.readFileSync('/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/package.json')).version}};
  const check=name=>report.checks.push(name); let initialized=false;
  const refs=['fixture-A','fixture-B','fixture-C'].map(id=>invented(root,id));
  const originals=refs.map(b=>fs.readFileSync(b.file));
  try {
    cli('init',config); initialized=true;
    const saved=JSON.parse(execFileSync(process.execPath,[import.meta.filename,'save-child',root],{env,encoding:'utf8',timeout:180000,stdio:['ignore','pipe','pipe']}));
    report.saved=saved; report.checks.push(...saved.checks);
    let c=new Coordinator(join(root,'store'));
    report.versions.tmux=c.tmux(saved.source,['-V']);
    const sourceOwners=c.strict(saved.source).filter(r=>r.binding).map(r=>r.binding.process);
    report.liveSourceRefusal=refusedWithoutEffects(c,'blockedsource',/DR-1.*known process still live/);
    assert.deepEqual(c.strict(saved.source).filter(r=>r.binding).map(r=>r.binding.process),sourceOwners);
    assert.equal(cli('recover',c.root,'source').status,'attach-only');
    check('DR-1 live native source: different-label CLI refused before pin/socket/entry; source PIDs and pointer unchanged');
    await c.stop(saved.source); await c.agentsGone();
    fs.rmSync(runtime,{recursive:true});
    check('saving child ended; owned source server/agents exited; entire runtime directory removed');
    let pointerBytes=fs.readFileSync(join(c.store,'latest.json'));
    const inspect=cli('inspect',c.root); assert.equal(inspect.pair.pointer.pair,saved.two.pointer.pair);
    // Missing cwd and malformed metadata refuse BEFORE any runtime recreation.
    fs.rmdirSync(join(root,'tools'));
    assert.throws(()=>cli('recover',c.root,'missingcwd')); assert(!fs.existsSync(runtime));
    fs.mkdirSync(join(root,'tools'));
    fs.writeFileSync(join(c.store,'latest.json'),json({...saved.two.pointer,manifestHash:'0'.repeat(64)}));
    assert.throws(()=>cli('recover',c.root,'malformed')); assert(!fs.existsSync(runtime));
    fs.writeFileSync(join(c.store,'latest.json'),pointerBytes);
    check('missing cwd / malformed metadata refuse before mutation');
    const stale=new Coordinator(c.root);
    const result=cli('recover',c.root,'destination'); report.recovery=result;
    assert.equal(result.status,'complete'); assert.equal(result.launches.length,2);
    check('NEW CLI reconstructs 100x32 / base1 independent sessions and exact C/B from persistent store');
    c=new Coordinator(c.root); const topology=c.topology(result.socket), pids=c.strict(result.socket).filter(r=>r.binding).map(r=>r.binding.process.pid);
    for(let i=0;i<2;i++) assert.equal(cli('recover',c.root,'destination').status,'attach-only');
    assert.deepEqual(c.topology(result.socket),topology); assert.deepEqual(c.strict(result.socket).filter(r=>r.binding).map(r=>r.binding.process.pid),pids);
    for(const [coord,p] of Object.entries(saved.two.manifest.panes)) if(!p.binding)assert.equal(topology.identity[coord].command,'bash');
    check('independent repeated CLI leaves PIDs/topology unchanged; ordinary panes are shells');
    report.liveRecoveredRefusal=refusedWithoutEffects(c,'blockedrecovered',/DR-1.*known process still live/);
    assert.deepEqual(c.strict(result.socket).filter(r=>r.binding).map(r=>r.binding.process.pid),pids);
    check('DR-1 live recovered native owners: different-label CLI refused without effects or PID changes');
    const promoted=cli('save',c.root,'destination'); report.completedSave=promoted.pointer;
    assert.notEqual(promoted.pointer.pair,saved.two.pointer.pair);
    assert.deepEqual(load(c.store,c.root,saved.two.pointer).manifest,saved.two.manifest);
    assert.deepEqual(c.entry(result.socket).source,saved.two.pointer);
    pointerBytes=fs.readFileSync(join(c.store,'latest.json'));
    check('explicit complete-generation save publishes fresh pair while retaining original pinned source');
    await c.stop(result.socket); await c.agentsGone();
    assert.equal((await stale.connect('destination')).status,'attach-only');
    fs.unlinkSync(result.socket);
    assert.equal(cli('recover',c.root,'destination').status,'attach-only'); assert.equal((await stale.connect('destination')).status,'attach-only');
    await assert.rejects(locked(c.root,lease=>stale.persist(lease)),/stale ownership writer/);
    assert(!fs.existsSync(result.socket));
    check('consumed history survives dead socket removal / stale independent object writer');
    fs.unlinkSync(refs[1].file);
    const gap=cli('recover',c.root,'gap'); report.gap=gap; assert.equal(gap.status,'complete-with-gaps'); assert.equal(gap.launches.length,1); assert.equal(gap.gaps[0].reason,'missing-exact-file'); assert(!fs.existsSync(refs[1].file));
    c=new Coordinator(c.root); await c.stop(gap.socket); await c.agentsGone(); fs.writeFileSync(refs[1].file,originals[1]);
    check('missing exact file leaves explained shell gap without replacement');
    const partial=await c.connect('partial',undefined,{afterLaunch:()=>{throw Error('injected launch uncertainty');}}); report.partial=partial; assert.equal(partial.status,'uncertain'); assert.equal(partial.launches.length,1);
    const partialState=c.topology(partial.socket);
    assert.equal(cli('recover',c.root,'partial').status,'attach-only'); assert.deepEqual(c.topology(partial.socket),partialState);
    assert.throws(()=>cli('save',c.root,'partial')); assert.deepEqual(fs.readFileSync(join(c.store,'latest.json')),pointerBytes);
    check('partial uncertainty: independent CLI no retry / no degraded promotion');
    await c.stop(partial.socket); await c.agentsGone();
    report.unresolvedRefusal=refusedWithoutEffects(c,'blockeduncertain',/DR-1.*unresolved managed generation/);
    assert.equal(cli('recover',c.root,'partial').status,'attach-only');
    check('DR-1 unresolved launch uncertainty blocks fresh labels even after owned shutdown; existing label remains attach-only');
    refs.forEach((b,i)=>assert.deepEqual(fs.readFileSync(b.file),originals[i]));
    report.transcripts=refs.map((b,i)=>({id:b.id,sha256:hash(originals[i]),byteIdentical:true}));
    check('invented histories byte-identical; no submitted task prompt/model activity');
    report.hashesAfter=hashes(); assert.deepEqual(report.hashesAfter,report.hashesBefore); check('installed plugin/Pi core/accepted registrar hashes unchanged');
    report.success=true;
  } catch(e) { report.failure={message:e.status !== undefined ? 'child process failed (payload omitted), status=' + e.status : e.message.split('\n')[0],location:e.stack?.split('\n').filter(s=>s.trimStart().startsWith('at ')).slice(0,4)}; }
  finally {
    if(initialized) {
      try { report.cleanup=cli('cleanup',join(root,'store')); }
      catch(e) { report.cleanup={error:'cleanup subprocess failed; ownership investigation required',retainedRoot:root,runtime}; report.success=false; }
      report.audit=fs.existsSync(join(root,'store/audit.jsonl'))?fs.readFileSync(join(root,'store/audit.jsonl'),'utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse):[];
    }
    fs.mkdirSync(evidence,{recursive:true});
    if(report.cleanup?.ownedServersStopped) {
      fs.rmSync(runtime,{recursive:true,force:true});fs.rmSync(root,{recursive:true});
      report.cleanup.fixtureRemoved=!fs.existsSync(root); report.cleanup.runtimeRemoved=!fs.existsSync(runtime);
    } else console.log('Retained private state: '+root+'; cleanup: node bin/recovery.js cleanup '+quote(join(root,'store')));
    fs.writeFileSync(join(evidence,'report.json'),json(report).replaceAll(root,'$FIXTURE').replaceAll(runtime,'$RUNTIME').replaceAll(repo,'$REPO').replaceAll(plugin,'$PLUGIN'));
  }
  console.log(`${report.success?'PASS':'FAIL'} ${report.checks.length} checks; ${evidence}/report.json`);
  if(report.failure)console.log(json(report.failure));
  if(!report.success)process.exitCode=1;
}
if(process.argv[2]==='save-child')await saveChild(process.argv[3]); else await main();
