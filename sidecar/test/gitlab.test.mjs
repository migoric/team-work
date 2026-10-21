/** GitLab 客户端的测试。fetch 全部用桩代替，不发真实网络请求。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GitLab, MERGED_MR_WINDOW_DAYS } from '../lib/gitlab.mjs';

function stubFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = real;
  };
}

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('rawFile：404 返回 null（分支上没这个文件是正常情况），401 文案区分 token 类型', async () => {
  let restore = stubFetch(async () => new Response('not found', { status: 404 }));
  const gl = new GitLab({ host: 'https://gitlab.example.com', token: 'glpat-x' });
  assert.equal(await gl.rawFile('g/p', 'metrics/health.jsonl'), null);
  restore();

  restore = stubFetch(async () => new Response('unauthorized', { status: 401 }));
  await assert.rejects(() => gl.rawFile('g/p', 'f'), /token 无效或已过期/);
  const job = new GitLab({ host: 'https://gitlab.example.com', token: 'ci-job', jobToken: true });
  // job token 的 401 不能报「token 无效」——它可能只是够不到这个接口
  await assert.rejects(() => job.rawFile('g/p', 'f'), /CI_JOB_TOKEN/);
  await assert.rejects(() => job.request('/user'), /CI_JOB_TOKEN/);
  restore();
});

test('jobToken 走 JOB-TOKEN 头，PAT 走 PRIVATE-TOKEN 头', async () => {
  const seen = [];
  const restore = stubFetch(async (url, opts) => {
    seen.push(opts.headers);
    return jsonResponse({});
  });
  await new GitLab({ host: 'https://x.com', token: 'pat-a' }).request('/user');
  await new GitLab({ host: 'https://x.com', token: 'job-b', jobToken: true }).request('/user');
  restore();

  assert.equal(seen[0]['PRIVATE-TOKEN'], 'pat-a');
  assert.equal(seen[0]['JOB-TOKEN'], undefined);
  assert.equal(seen[1]['JOB-TOKEN'], 'job-b');
  assert.equal(seen[1]['PRIVATE-TOKEN'], undefined);
});

test('mergedMergeRequests 拉 state=merged、按 updated_at 排序并带时间窗', async () => {
  let url = null;
  const restore = stubFetch(async (u) => {
    url = new URL(u);
    return jsonResponse([]);
  });
  const gl = new GitLab({ host: 'https://gitlab.example.com', token: 'x' });
  const rows = await gl.mergedMergeRequests('group/proj');
  restore();

  assert.deepEqual(rows, []);
  assert.equal(url.searchParams.get('state'), 'merged');
  assert.equal(url.searchParams.get('order_by'), 'updated_at');
  assert.ok(url.searchParams.get('updated_after'), '要带 updated_after 时间窗');
  assert.equal(MERGED_MR_WINDOW_DAYS, 90);
});

test('paged 按 x-next-page 翻页并受 max 上限约束', async () => {
  const pages = [];
  const restore = stubFetch(async (u) => {
    const url = new URL(u);
    pages.push(Number(url.searchParams.get('page')));
    const next = pages.length < 3 ? String(pages.length + 1) : null;
    return new Response(JSON.stringify([pages.length]), {
      status: 200,
      headers: { 'content-type': 'application/json', ...(next ? { 'x-next-page': next } : {}) }
    });
  });
  const gl = new GitLab({ host: 'https://x.com', token: 't' });
  const rows = await gl.paged('/projects');
  restore();
  assert.deepEqual(rows, [1, 2, 3]);
  assert.deepEqual(pages, [1, 2, 3]);
});
