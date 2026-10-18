#!/usr/bin/env node
// One fresh-shell entry point. All children receive an allowlisted environment.
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const repo=resolve(import.meta.dirname,'../..');
const dir=join(repo,'evidence/durable-recovery-delegation','dr1-verification-'+new Date().toISOString().replaceAll(':','-'));
fs.mkdirSync(dir,{recursive:true});
const log=join(dir,'output.txt');
const env={PATH:'/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',HOME:'/nonexistent',LC_ALL:'C',PYTHONDONTWRITEBYTECODE:'1',npm_config_update_notifier:'false'};
const python=spawnSync('/usr/bin/python3',['test/recovery-admission-probe.py'],{cwd:repo,env,encoding:'utf8',timeout:30000});
const pythonOutput=(python.stdout??'')+(python.stderr??'');
process.stdout.write(pythonOutput);fs.appendFileSync(log,'CHECK recovery-local probe\n'+pythonOutput+'exit='+python.status+'\n');
if(python.status!==0){console.log('Executed output: '+log);process.exit(1);}
const unit=fs.readdirSync(join(repo,'test')).filter(n=>n.endsWith('.test.js') && n!=='recovery-lab.test.js').map(n=>'test/'+n);
for(const args of [['scripts/build-extension.js','--check'],['--test','--test-concurrency=1',...unit],['--test','--test-concurrency=1','test/integration/durable-recovery.test.js','test/integration/recovery-admission.test.js'],['test/manual/durable-recovery.js']]) {
  const header='\nCHECK '+args[0]+'\n'; process.stdout.write(header); fs.appendFileSync(log,header);
  const result=spawnSync(process.execPath,args,{cwd:repo,env,encoding:'utf8',timeout:360000,maxBuffer:8*1024*1024});
  const output=(result.stdout??'')+(result.stderr??''); process.stdout.write(output); fs.appendFileSync(log,output.replaceAll(repo,'$REPO'));
  fs.appendFileSync(log,'exit='+result.status+'\n');
  if(result.status!==0){process.exitCode=1; break;}
}
console.log('Executed output: '+log);
