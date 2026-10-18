import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attach } from '../src/extension.ts';
import { hookInput } from '../src/claude.js';
import { claudeName, validHookEvent } from '../src/activity.js';
import { sessionName } from '../src/presentation.js';
const activity = {state:'unknown',reason:'activation',observedAt:'2026-10-16T00:00:00Z'};

test('Pi name lifecycle: registration/reload, rename/clear, turn sampling, stale context/payload isolation, no activity freshness fabrication', () => {
  const h = {}, published = [], acquired = [], closed = [];
  let name = 'Original', owner = 0;
  const ctx = (id='one',file='/one') => ({mode:'tui',hasUI:true,cwd:'/cwd',
    sessionManager:{getSessionId:()=>id,getSessionFile:()=>file},ui:{setStatus(){}},isIdle:()=>true,hasPendingMessages:()=>false});
  attach({on:(event,fn)=>h[event]=fn,registerCommand(){},getSessionName:()=>name}, {
    acquire:options=>{acquired.push(options);return {record:{...options,owner:String(++owner),generation:String(owner),state:'active',activity,activitySequence:'0'}};},
    publish:r=>published.push(r),close:r=>closed.push(r),persistence:()=>({})
  });
  h.session_start({reason:'startup'},ctx());
  assert.equal(acquired.at(-1).sessionName,'Original');
  name = 'Renamed\x1b[31m\n界';
  h.session_info_changed({name:'Old delayed payload'},ctx());
  const renamed = published.at(-1);
  assert.equal(renamed.sessionName,sessionName(name));
  assert.equal(renamed.activity,activity,'metadata event preserves actual observation time/state');
  assert.equal(renamed.sessionNameSource,'pi-api');
  name=undefined;
  h.session_info_changed({name:undefined},ctx());
  assert.equal(published.at(-1).sessionName,null);
  name='Turn sample'; h.turn_start({},ctx());
  assert.equal(published.at(-1).sessionName,'Turn sample');
  name='Other scope'; h.session_start({reason:'resume'},ctx('two','/two'));
  assert.equal(acquired.at(-1).sessionName,'Other scope');
  const count=published.length;
  name='Current new name'; h.session_info_changed({name:'STALE'},ctx());
  assert.equal(published.length,count,'stale context cannot update a different record');
  h.session_info_changed({name:'STALE'},ctx('two','/two'));
  assert.equal(published.at(-1).sessionName,'Current new name','current API, never old event payload');
  h.session_start({reason:'reload'},ctx('two','/two'));
  assert.equal(acquired.at(-1).sessionName,'Current new name');
  assert.equal(closed.length,2);
  h.session_shutdown({}); const after=published.length;
  h.session_info_changed({},ctx('two','/two')); assert.equal(published.length,after);
});

const input = {hook_event_name:'SessionStart',source:'startup',session_id:'one',transcript_path:'/one',cwd:'/cwd'};
const record = {owner:'a'.repeat(32),generation:'10',sessionId:'one',sessionFile:'/one',sessionName:'Activation',sessionNameSource:'claude-hook'};
const event = (order,name,patch={})=>({...record,version:1,id:'b'.repeat(32),order:String(order),event:'UserPromptSubmit',
  observedAt:'2026-10-16T00:00:00Z',promptId:'prompt',notification:null,sessionName:name,...patch});

test('Claude captures only documented custom session_title snapshots; absent/old/unsupported title is honest fallback', () => {
  for (const type of ['SessionStart','UserPromptSubmit']) {
    const got=hookInput({...input,hook_event_name:type,session_title:'My custom\n界',title:'NOT session',session_name:'NOT API'});
    assert.equal(got.sessionName,'My custom\\u000a界');
    assert.equal(got.sessionNameSource,'claude-hook');
    assert.equal(hookInput({...input,hook_event_name:type}).sessionName,null);
  }
  const got=hookInput({...input,hook_event_name:'Notification',session_title:'UNSUPPORTED',title:'Permission needed'});
  assert.equal(got.sessionName,undefined);
  assert.equal(got.title,undefined);
});

test('Claude write-time name reduction follows scoped source order, clear, old events, ambiguity and delayed arrivals', () => {
  assert.deepEqual(claudeName(record,[]),{});
  const old=event(11,'Old'), newer=event(12,'New');
  assert.deepEqual(claudeName(record,[newer,old]),{sessionName:'New',sessionNameSource:'claude-hook'});
  assert.equal(claudeName(record,[old,newer,event(13,null)]).sessionName,null);
  for (const patch of [{owner:'c'.repeat(32)},{generation:'11'},{sessionId:'other'},{sessionFile:'/other'},{order:'9'},{event:'Notification'}]) {
    assert.equal(claudeName(record,[old,{...newer,...patch}]).sessionName,'Old');
  }
  const legacy=event(14,'ignored'); delete legacy.sessionName; delete legacy.sessionNameSource;
  assert.equal(validHookEvent(legacy),true);
  assert.equal(claudeName(record,[old,legacy]).sessionName,'Old');
  assert.equal(claudeName(record,[old,newer,event(12,'Ambiguous')]).sessionName,null);
});
