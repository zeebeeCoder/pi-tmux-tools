import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortRows, eventTime, SORTS, nextSort, previousSort } from '../src/picker-sort.js';
import { makeChoices, parseResult, pick } from '../src/picker.js';

const now = Date.parse('2026-10-16T12:00:00.999Z');
const row = (pane, patch = {}, activity = {}) => ({
  binding: { state:'active', agent:'pi', pane:'%' + pane, cwd:'/x/project', sessionId:'id-' + pane,
    owner:String(pane).padStart(32, '0'), ...patch }, activity
});
const ids = rows => rows.map(r => r.binding.pane);
const sorted = (rows, sort = 'Recent') => ids(sortRows(rows, sort, now));
const choicesIds = (rows, options) => [...makeChoices(rows, {now, ...options}).values()].map(c => c.binding.pane);

test('Recent uses exact recorded event milliseconds, not rounded age, write/heartbeat time or state', () => {
  const rows = [row(1, {updatedAt:'2999-01-01', activity:{observedAt:'2999-01-01'}}, {observedAt:'2026-10-16T12:00:00.001Z'}),
    row(2, {}, {state:'unknown', observedAt:'2026-10-16T12:00:00.900Z'}),
    row(3, {}, {state:'working', observedAt:'2026-10-16T12:00:00.899Z'})];
  assert.deepEqual(sorted(rows), ['%2','%3','%1']);
  assert.deepEqual(choicesIds(rows), ['%2','%3','%1']);
  assert.deepEqual(ids(rows), ['%1','%2','%3'], 'input is not mutated');
  assert.ok([...makeChoices(rows, {now}).values()].every(c => c.line.endsWith('now       ')));
});

test('unknown/missing/invalid/future stamps last; equal instants and unknowns have deterministic identity ties', () => {
  const rows = [row(10, {}, {observedAt:null}), row(2, {}, {observedAt:'garbage'}),
    row(3, {}, {observedAt:new Date(now + 1).toISOString()}), row(4),
    row(5, {}, {observedAt:'2026-10-16T12:00:00.999Z'}),
    row(6, {}, {observedAt:'2026-10-16T14:00:00.999+02:00'})];
  const expected = ['%5','%6','%2','%3','%4','%10'];
  assert.deepEqual(sorted(rows), expected);
  assert.deepEqual(sorted([...rows].reverse()), expected);
  for (const r of rows.slice(0,4)) assert.equal(eventTime(r, now), null);
  assert.equal(eventTime(rows[4], now), now);
});

test('Project/folder sorts shortest distinguishing cwd suffix, then full cwd; not inferred project or truncated cell', () => {
  const rows = [row(1, {cwd:'/z/a/project', project:'AAAA'}), row(2, {cwd:'/y/b/project'}),
    row(3, {cwd:'/other'}), row(4, {cwd:'/z/a/project'})];
  assert.deepEqual(sorted(rows, 'Project/folder'), ['%1','%4','%2','%3']);
  const long = 'same'.repeat(100);
  const wide = [row(8, {cwd:'/x/' + long + 'z'}), row(9, {cwd:'/x/' + long + 'a'})];
  assert.deepEqual(choicesIds(wide, {sort:'Project/folder', terminalWidth:40}), ['%9','%8']);
  // Same compact folder name: full cwd, not input order, breaks ties.
  assert.deepEqual(sorted([row(2, {cwd:'/x/project/'}),row(1)], 'Project/folder'), ['%1','%2']);
});

test('Session uses full trusted safe names, natural numeric/case ordering, Unnamed last and stable same-label ties', () => {
  const named = (pane, name, patch = {}) => row(pane, {sessionName:name, sessionNameSource:'pi-api', ...patch});
  const rows = [named(1,'Work 10'),row(2),named(3,'Work 2'),named(4,'Alpha'),
    named(5,'Z but unverified', {sessionNameSource:'tmux-title'}),named(6,'   ')];
  assert.deepEqual(sorted(rows, 'Session'), ['%4','%3','%1','%2','%5','%6']);
  const prefix = 'long title '.repeat(10);
  assert.deepEqual(choicesIds([named(1,prefix+'z'),named(2,prefix+'a')], {sort:'Session', terminalWidth:40}), ['%2','%1']);
  const ties = [named(10,'Same'),named(2,'Same')];
  for (const sort of SORTS) assert.deepEqual(sorted(ties, sort), sorted([...ties].reverse(), sort));
  assert.deepEqual(sorted([named(1,'alpha'),named(2,'Alpha')], 'Session'), ['%2','%1']);
});

test('Agent alphabetic and Status attention/working/idle/unknown; same-label ties independent of input order', () => {
  const rows = [row(1, {}, {state:'idle'}),row(2, {agent:'claude'}, {state:'working'}),
    row(3, {}, {state:'needs-attention'}),row(4, {}, {state:'unknown'}),row(5, {}, {state:'invalid'})];
  assert.deepEqual(sorted(rows, 'Agent'), ['%2','%1','%3','%4','%5']);
  assert.deepEqual(sorted(rows, 'Status'), ['%3','%2','%1','%4','%5']);
  for (const sort of SORTS) assert.deepEqual(sorted(rows, sort), sorted([...rows].reverse(), sort));
  assert.deepEqual(SORTS.map(nextSort), [...SORTS.slice(1),'Recent']);
  assert.deepEqual(SORTS.map(previousSort), ['Status',...SORTS.slice(0,-1)]);
});

test('hostile and Unicode sort metadata remains safe/full, stable and exact-token selectable', () => {
  const rows = [row(1, {cwd:'/界/😀\u202e\t\n\x1b]52;c;bad', sessionName:'界😀e\u0301', sessionNameSource:'pi-api'}),
    row(2, {cwd:'/界/😀\u202e\t\n\x1b]52;c;bad', sessionName:'$(touch NEVER) #{pane_id}', sessionNameSource:'pi-api'})];
  for (const sort of SORTS) {
    const choices = makeChoices(rows, {sort, now, terminalWidth:180});
    assert.equal(choices.sort, sort);
    for (const c of choices.values()) {
      assert.ok(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(c.line.replace('\t','')));
      assert.equal(parseResult({status:0, stdout:'x\n\n'+c.line+'\n'}, choices).binding, c.binding);
    }
    assert.deepEqual(sorted(rows, sort), sorted([...rows].reverse(), sort));
  }
});

test('arrows wrap both directions, preserve query/mode through refresh without rereading; empty/no-match and reopen', () => {
  const query = "界 ' $(never)";
  const modes = ['Recent', ...SORTS.slice(1), 'Recent', ...SORTS.slice(1).reverse(), 'Recent'];
  for (const rows of [[], [row(1)]]) {
    const calls = [];
    let reads = 0;
    const run = () => {
      let i = 0;
      const outputs = [
        ...Array(5).fill('right'), ...Array(5).fill('left')
      ].flatMap(key => [key, 'ctrl-r']);
      pick({socket:'/owned'}, {
        readDisplay() { reads++; return rows; },
        runFzf(choices, q) {
          calls.push([choices.sort,q]);
          return i < outputs.length ? {status:1, stdout:query+'\n'+outputs[i++]+'\n'} : {status:130};
        }, navigate() { assert.fail('empty/no-match must not navigate'); }
      });
    };
    run(); run();
    const expected = [['Recent',''], ...modes.slice(1).flatMap(mode => [[mode,query],[mode,query]])];
    assert.deepEqual(calls, [...expected,...expected]);
    assert.equal(reads,22, 'only initial read and Ctrl-R for each popup');
  }
});

test('arrow results never select; only Enter selects exact current token/line after sorting', () => {
  const rows = [row(1, {cwd:'/z'}),row(2, {cwd:'/a'})], query = 'kept';
  const choices = makeChoices(rows);
  const line = [...choices.values()][0].line;
  for (const status of [0,1]) for (const [key,direction] of [['left',-1],['right',1]]) {
    assert.deepEqual(parseResult({status, stdout:query+'\n'+key+'\n'+line+'\n'}, choices),
      {action:'sort', query, direction});
  }
  assert.throws(() => parseResult({status:0, stdout:query+'\nctrl-s\n'+line+'\n'}, choices), /Invalid/);
  let reads = 0, calls = 0, navigated;
  pick({socket:'/owned'}, {
    readDisplay() { reads++; return rows; },
    runFzf(current, q) {
      if (calls++ === 0) return {status:0, stdout:query+'\nright\n'+line+'\n'};
      assert.equal(current.sort, 'Project/folder');
      assert.equal(q, query);
      assert.throws(() => parseResult({status:0, stdout:query+'\n\n'+line+'\n'}, current), /Unknown/);
      return {status:0, stdout:query+'\n\n'+[...current.values()][0].line+'\n'};
    },
    navigate(context, selected) { navigated = selected; }
  });
  assert.equal(navigated, rows[1].binding);
  assert.equal(reads,1);
});
