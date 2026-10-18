import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { Coordinator } from '../../src/recovery/coordinator.js';
import { locked } from '../../src/recovery/model.js';
for (const removeDeadSocket of [false,true]) {
  test(`durable authority: base0 / 140x45 / stale writer / dead socket ${removeDeadSocket?'absent':'present'}`, {timeout:90000}, async () => {
    const root=fs.realpathSync(fs.mkdtempSync('/tmp/durable-owner-')); fs.chmodSync(root,0o700);
    fs.mkdirSync(join(root,'workspace'),{mode:0o700});
    const c=Coordinator.create({store:join(root,'store'),runtime:join(root,'runtime'),settings:{width:140,height:45,base:0,paneBase:0,renumber:'off'}});
    try {
      const s=c.start('source','source');
      c.tmux(s,['rename-session','-t','bootstrap','alpha']); c.tmux(s,['rename-window','-t','alpha:0','main']);
      const pair=await c.save(s); await c.stop(s);
      const stale=new Coordinator(c.root), staleWrite=new Coordinator(c.root);
      const result=await c.connect('target',pair.pointer); assert.equal(result.status,'complete'); assert.equal(result.launches.length,0);
      await c.stop(result.socket);
      if(removeDeadSocket)fs.unlinkSync(result.socket);
      const owner=fs.readFileSync(join(c.root,'ownership.json'),'utf8'), audit=fs.readFileSync(join(c.root,'audit.jsonl'),'utf8');
      assert.equal((await stale.connect('target')).status,'attach-only');
      await assert.rejects(locked(c.root,l=>staleWrite.persist(l)),/stale ownership writer/);
      assert.throws(()=>stale.start('target','source'),/already used/);
      assert.equal(fs.readFileSync(join(c.root,'ownership.json'),'utf8'),owner);
      assert.equal(fs.readFileSync(join(c.root,'audit.jsonl'),'utf8'),audit);
      assert.equal(fs.existsSync(result.socket),!removeDeadSocket);
      assert.throws(()=>c.phase(s,'uncertain'), /guarded subprocess failed/);
      assert.equal(fs.readFileSync(join(c.root,'ownership.json'),'utf8'),owner);
    } finally {await new Coordinator(c.root).cleanup(); fs.rmSync(root,{recursive:true});}
  });
}
