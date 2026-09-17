// The store's ownership rule: a pending user choice must survive the cache
// re-seeds that arrive constantly (the download poller pings the same cache).
import { uiScale, seedUiScale, selectUiScale, confirmUiScaleSaved } from '../src/lib/stores/ui-scale.ts';
import { get } from 'svelte/store';

let failures = 0;
function check(name, cond) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

seedUiScale('small');
check('seed applies when nothing is pending', get(uiScale) === 'small');

selectUiScale('large');
check('user choice applies', get(uiScale) === 'large');

seedUiScale('small');
check('a cache re-seed does NOT clobber a pending choice', get(uiScale) === 'large');

seedUiScale('medium');
check('repeated re-seeds still do not clobber', get(uiScale) === 'large');

confirmUiScaleSaved();
seedUiScale('medium');
check('after save is confirmed, server values win again', get(uiScale) === 'medium');

console.log(failures === 0 ? '\n=== STORE PASS' : `\n=== STORE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
