import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePatterns, topicMatches } from '../server/mqttLog.mjs';

test('topic patterns: obj and evt, MQTT wildcards as whole levels', () => {
  assert.deepEqual(parsePatterns('obj/doorcounter/+/log, evt/doorcounter/#\n/obj/a'), ['obj/doorcounter/+/log', 'evt/doorcounter/#', 'obj/a']);
  assert.deepEqual(parsePatterns('obj/a,obj/a'), ['obj/a']);
  for (const bad of ['', 'box/#', 'set/x', '#', 'obj/#/x', 'obj/a+b', 'obj/a#', 'obj//a', 'obj/a b', 'x'.repeat(201)]) {
    assert.throws(() => parsePatterns(bad), { status: 400 }, bad);
  }
  assert.throws(() => parsePatterns(Array.from({ length: 11 }, (_, i) => `obj/${i}`).join(',')), { status: 400 });
});

test('MQTT topic matching', () => {
  assert.ok(topicMatches('obj/#', 'obj/a/b/c'));
  assert.ok(topicMatches('obj/+/log', 'obj/door/log'));
  assert.ok(!topicMatches('obj/+/log', 'obj/door/x/log'));
  assert.ok(topicMatches('obj/door/#', 'obj/door'));
  assert.ok(!topicMatches('obj/door', 'obj/door/log'));
  assert.ok(!topicMatches('evt/#', 'obj/a'));
  assert.ok(topicMatches('obj/a', 'obj/a'));
});
