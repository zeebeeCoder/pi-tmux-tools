import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admissionPlan, assertAdmission, probeAdmission } from '../src/recovery/admission.js';
function fixture() {
  const owner={token:'store',servers:{'/private/fixture.sock':{role:'source',phase:'source',generation:'gen',pid:101,birth:'1:1'}},agents:[{pid:102,birth:'2:2'}]};
  const manifest={provenance:{storeToken:'store',socket:'/private/fixture.sock',generation:'gen',pid:101,birth:'1:1'},panes:{a:{binding:{pid:103,birth:'3:3'}}}};
  const plan=admissionPlan(owner,[manifest]);
  const result={pids:Object.fromEntries(plan.request.pids.map(p=>[p,{state:'absent'}])),sockets:{'/private/fixture.sock':{state:'absent'}}};
  return {owner,manifest,plan,result};
}
test('DR-1 admission includes managed, tracked and selected/historical manifest PID+birth identities',()=>{
  const {plan,result}=fixture(); assert.deepEqual(plan.request.pids,[101,102,103]); assert.doesNotThrow(()=>assertAdmission(plan,result));
  for(const i of plan.identities) {
    const r=structuredClone(result);r.pids[i.pid]={state:'present',birth:i.birth,live:true};
    assert.throws(()=>assertAdmission(plan,r),/known process still live/);
  }
  const {owner,manifest}=fixture(),latest=structuredClone(manifest);latest.panes.a.binding=null;
  const historical=admissionPlan(owner,[latest,manifest]);
  result.pids[103]={state:'present',birth:'3:3',live:true};
  assert.throws(()=>assertAdmission(historical,result),/known process still live/);
});
test('DR-1 omitted/error/malformed probe result is never absence',()=>{
  const {plan,result}=fixture();
  for(const p of [undefined,{state:'unknown'},{state:'present'},{state:'present',birth:'1:1',live:'false'},{state:'other'}]) {
    const r=structuredClone(result);r.pids[101]=p; assert.throws(()=>assertAdmission(plan,r),/unknown process absence/);
  }
  assert.throws(()=>assertAdmission(plan,undefined),/unknown process absence/);
  for(const state of ['present','unknown',undefined]) {
    const r=structuredClone(result);r.sockets['/private/fixture.sock']={state};assert.throws(()=>assertAdmission(plan,r),/socket/);
  }
});
test('DR-1 positive PID reuse / zombie observation proves old workload gone, not probe errors',()=>{
  const {plan,result}=fixture();
  result.pids[101]={state:'present',birth:'new-birth',live:true};
  result.pids[102]={state:'present',birth:'2:2',live:false};
  assert.doesNotThrow(()=>assertAdmission(plan,result));
  plan.identities.push({pid:101,birth:'new-birth'});
  assert.throws(()=>assertAdmission(plan,result),/known process still live/);
});
test('DR-1 stale/unanchored manifest source metadata refuses before probing',()=>{
  const {owner,manifest}=fixture();
  for(const [field,value] of [['storeToken','foreign'],['socket','/private/missing.sock'],['generation','old'],['pid',999],['birth','old']]) {
    const m=structuredClone(manifest);m.provenance[field]=value;
    assert.throws(()=>admissionPlan(owner,[m]),/stale\/unanchored/);
  }
});
test('DR-1 unresolved generations stay blocked even with every PID absent',()=>{
  const {owner,manifest}=fixture();
  for(const phase of ['creating','restoring','launching','uncertain','unknown']) {
    const o=structuredClone(owner);Object.values(o.servers)[0].phase=phase;
    assert.throws(()=>admissionPlan(o,[manifest]),/unresolved managed generation/);
  }
  const o=structuredClone(owner);delete Object.values(o.servers)[0].birth;
  assert.throws(()=>admissionPlan(o,[manifest]),/missing managed server identity/);
  const d=structuredClone(owner);Object.assign(Object.values(d.servers)[0],{role:'destination',phase:'complete'});
  assert.throws(()=>admissionPlan(d,[manifest]),/missing recorded recovery source/);
});
test('DR-1 native local probe explicitly identifies this process without registry-helper omissions',()=>{
  const r=probeAdmission({pids:[process.pid],sockets:[]});
  assert.equal(r.pids[process.pid].state,'present');assert.equal(r.pids[process.pid].live,true);
  assert.match(r.pids[process.pid].birth,/^\d+:\d+$/);
});
