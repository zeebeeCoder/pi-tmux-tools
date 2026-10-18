import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const refuse = reason => { throw new Error('DR-1 admission refused: ' + reason); };
const identity = x => Number.isSafeInteger(x?.pid) && x.pid > 0 && x.pid <= 2147483647 && typeof x.birth === 'string' && x.birth.length > 0;

// Called with freshly reloaded authority and validated selected + recorded pinned
// manifests. Historical source identities must agree with immutable server history.
export function admissionPlan(owner, manifests) {
  const identities = [], sockets = Object.keys(owner.servers);
  for (const entry of Object.values(owner.servers)) {
    if (!((entry.role === 'source' && entry.phase === 'source') ||
          (entry.role === 'destination' && ['complete', 'complete-with-gaps'].includes(entry.phase)))) {
      refuse('unresolved managed generation');
    }
    if (entry.role === 'destination' && (!entry.source || typeof entry.source.pair !== 'string' || typeof entry.source.manifestHash !== 'string')) {
      refuse('missing recorded recovery source');
    }
    if (!identity(entry)) refuse('missing managed server identity');
    identities.push({ pid: entry.pid, birth: entry.birth });
  }
  if (!Array.isArray(owner.agents)) refuse('invalid tracked identity history');
  for (const entry of owner.agents) {
    if (!identity(entry)) refuse('invalid tracked process identity');
    identities.push({ pid: entry.pid, birth: entry.birth });
  }
  for (const manifest of manifests) {
    const p = manifest.provenance, recorded = owner.servers[p.socket];
    if (p.storeToken !== owner.token || !recorded || recorded.generation !== p.generation ||
        recorded.pid !== p.pid || recorded.birth !== p.birth) refuse('stale/unanchored manifest source identity');
    identities.push({ pid: p.pid, birth: p.birth });
    for (const pane of Object.values(manifest.panes)) if (pane.binding) {
      if (!identity(pane.binding)) refuse('invalid saved process identity');
      identities.push({ pid: pane.binding.pid, birth: pane.binding.birth });
    }
  }
  return { identities, request: { pids: [...new Set(identities.map(x => x.pid))], sockets } };
}

export function probeAdmission(request) {
  try {
    return JSON.parse(execFileSync('/usr/bin/python3', [join(import.meta.dirname, 'admission-probe.py')], {
      input: JSON.stringify(request), encoding: 'utf8', timeout: 15000,
      maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    }));
  } catch { refuse('identity probe failed (payload omitted)'); }
}

export function assertAdmission(plan, result) {
  for (const expected of plan.identities) {
    const p = result?.pids?.[expected.pid];
    if (p?.state === 'absent') continue;
    if (p?.state !== 'present' || typeof p.birth !== 'string' || !p.birth || typeof p.live !== 'boolean') {
      refuse('unknown process absence');
    }
    // A positively observed different birth proves that the old identity is gone.
    if (p.birth === expected.birth && p.live) refuse('known process still live');
  }
  for (const socket of plan.request.sockets) {
    const s = result?.sockets?.[socket];
    if (s?.state === 'present') refuse('managed socket still live');
    if (s?.state !== 'absent') refuse('unknown socket absence');
  }
  assert(plan.identities.length > 0, 'DR-1 admission requires anchored source identity');
}
