#!/usr/bin/env node
// Explicit local adapter; no activation, attach, scheduler, or default socket.
import * as fs from 'node:fs';
import { join } from 'node:path';
import { Coordinator } from '../src/recovery/coordinator.js';
import { load, json } from '../src/recovery/model.js';
const [command, root, label, ...extra] = process.argv.slice(2);
try {
  if (!root || extra.length || !['init','save','inspect','recover','cleanup'].includes(command)) throw Error('Usage: node bin/recovery.js init CONFIG.json | inspect STORE | save STORE LABEL | recover STORE UNUSED-LABEL | cleanup STORE');
  if (command === 'init') {
    if (label) throw Error('unexpected argument');
    const c = Coordinator.create(JSON.parse(fs.readFileSync(root, 'utf8')));
    console.log(json({ status: 'initialized', store: c.root }));
  } else {
    const c = new Coordinator(root);
    if (command === 'inspect') {
      if (label) throw Error('unexpected argument');
      console.log(json({ pair: load(c.store, c.root), ownership: c.owner, claude: 'unsupported: native persistence/resume unverified' }));
    } else if (command === 'cleanup') {
      if (label) throw Error('unexpected argument');
      console.log(json(await c.cleanup()));
    } else {
      if (!/^[a-z]+$/.test(label ?? '')) throw Error('explicit alphabetic server label required');
      const result = command === 'save' ? await c.save(join(c.owner.runtime, label + '.sock')) : await c.connect(label);
      console.log(json(result));
      if (result.status === 'uncertain') process.exitCode = 2;
    }
  }
} catch (e) {
  console.error(json({ status: 'refused', reason: e.message.split('\n')[0] })); process.exitCode = 1;
}
