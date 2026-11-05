import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.mjs';

test('new sessions use the output request token instead of an unrelated HTML token', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const listeners = new Map();
  const request = {url: () => `https://arena.ai/ai-proxy/realtime/v1/sessions/${id}/out`,
    headers: () => ({authorization: 'Bearer current-output-token'})};
  let htmlReads = 0;
  const editor = {waitFor: async () => {}, fill: async () => {}};
  const page = {
    goto: async () => {}, waitForLoadState: async () => {}, waitForTimeout: async () => {},
    getByRole: () => ({count: async () => 0}),
    locator: () => ({last: () => editor, click: async () => listeners.get('request')(request)}),
    on: (name, fn) => listeners.set(name, fn), off: (name) => listeners.delete(name),
    waitForResponse: async () => ({status: () => 200, text: async () => JSON.stringify({id}), headers: () => ({})}),
    waitForRequest: async () => request,
    evaluate: async () => {htmlReads++; return '"publicAccessToken":"stale-html-token"';},
  };
  const result = await Bridge.prototype.createAgentSession.call({}, page, 'test');
  assert.equal(result.id, id);
  assert.equal(result.token, 'current-output-token');
  assert.equal(htmlReads, 0);
  assert.equal(listeners.size, 0);
});
