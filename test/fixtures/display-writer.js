// Owned-server concurrency fixture. Freeze an old writer AFTER reading the slot.
import { writeFileSync, existsSync } from 'node:fs';
import { tmux } from '../../src/runtime.js';
import { DISPLAY, casFormat, updateDisplay } from '../../src/display.js';
const [encoded, ready, release] = process.argv.slice(2);
const record=JSON.parse(Buffer.from(encoded,'base64url'));
let first=true;
const get=()=>tmux(record.socket,['display-message','-p','-t',record.pane,'#{'+DISPLAY+'}']);
updateDisplay(record,{
  read:()=>{const raw=get();if(first){first=false;writeFileSync(ready,'ready');
    const deadline=Date.now()+10000;
    while(!existsSync(release)){if(Date.now()>deadline)throw Error('barrier timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
  }return raw;},
  verify:()=>true, // Synthetic protocol test; real identity verification tested separately.
  cas:(expected,next)=>{tmux(record.socket,['set-option','-p','-F','-t',record.pane,DISPLAY,casFormat(expected,next)]);return get();}
});
