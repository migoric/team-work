/** 极简 GitLab REST v4 客户端。零依赖，只用 fetch。 */

/** facts 兜底用的已合并 MR 时间窗（天）。阈值只在 sidecar 定义一次，别在别处复写。 */
export const MERGED_MR_WINDOW_DAYS = 90;

export class GitLab {
  constructor({ host, token, jobToken = false }) {
    if (!host) throw new Error('缺少 GitLab host');
    if (!token) throw new Error('缺少 GitLab token');
    this.host = host.replace(/\/$/, '');
    this.token = token;
    this.jobToken = Boolean(jobToken);
  }

  /** CI_JOB_TOKEN 不是 PAT：只能走 JOB-TOKEN 头，当 PRIVATE-TOKEN 发只会换回 401。 */
  authHeaders() {
    return { [this.jobToken ? 'JOB-TOKEN' : 'PRIVATE-TOKEN']: this.token, accept: 'application/json' };
  }

  unauthorizedMessage() {
    return this.jobToken
      ? 'GitLab 返回 401：CI_JOB_TOKEN 对这个接口无效（job token 只覆盖流水线项目范围内的接口，不代表 token 本身无效）'
      : 'GitLab 返回 401：token 无效或已过期';
  }

  url(path, params = {}) {
    const u = new URL(`${this.host}/api/v4${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      u.searchParams.set(k, String(v));
    }
    return u;
  }

  async request(path, params = {}) {
    const res = await fetch(this.url(path, params), {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(20000)
    });

    if (res.status === 401) throw new Error(this.unauthorizedMessage());
    if (res.status === 403) throw new Error('GitLab 返回 403：token 缺少 read_api 权限');
    if (res.status === 404) throw new Error(`GitLab 返回 404：${path}（项目路径或权限不对？）`);
    if (!res.ok) throw new Error(`GitLab 返回 ${res.status} ${res.statusText} → ${path}`);

    return { data: await res.json(), next: res.headers.get('x-next-page') };
  }

  /** 按 x-next-page 翻页，max 是安全上限，避免权限过大时拉爆。 */
  async paged(path, params = {}, max = 500) {
    const out = [];
    let page = 1;
    while (page && out.length < max) {
      const { data, next } = await this.request(path, { ...params, per_page: 100, page });
      if (!Array.isArray(data) || data.length === 0) break;
      out.push(...data);
      page = next ? Number(next) : 0;
    }
    return out.slice(0, max);
  }

  me() {
    return this.request('/user').then((r) => r.data);
  }

  projects() {
    return this.paged('/projects', { membership: true, order_by: 'last_activity_at', simple: true }, 200);
  }

  issues(projectId) {
    return this.paged(`/projects/${encodeURIComponent(projectId)}/issues`, { state: 'opened', scope: 'all' });
  }

  openMergeRequests(projectId) {
    return this.paged(`/projects/${encodeURIComponent(projectId)}/merge_requests`, { state: 'opened', scope: 'all' });
  }

  /**
   * 最近一段时间已合并的 MR。给 facts 兜底用：issue 没写任务清单时，
   * 「关联 MR 已合并」就是进度证据，只拉 open 会把这种情况误报成零进度。
   */
  mergedMergeRequests(projectId, { sinceDays = MERGED_MR_WINDOW_DAYS } = {}) {
    const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
    return this.paged(`/projects/${encodeURIComponent(projectId)}/merge_requests`, {
      state: 'merged',
      scope: 'all',
      order_by: 'updated_at',
      updated_after: since
    });
  }

  /** 只取路径信息，不取 diff 正文——影响面分析只需要知道改了哪些文件。 */
  mergeRequestDiffs(projectId, iid) {
    return this.paged(
      `/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}/diffs`,
      { per_page: 100 },
      300
    );
  }

  activeMilestones(projectId) {
    return this.paged(`/projects/${encodeURIComponent(projectId)}/milestones`, { state: 'active' });
  }

  /**
   * 读仓库里的一个文本文件（比如 CI 追加的 metrics/health.jsonl）。
   * 404 = 这个分支上还没有这个文件，属于正常情况，返回 null 而不是抛。
   */
  async rawFile(projectId, filePath, ref = 'main') {
    const url = this.url(
      `/projects/${encodeURIComponent(projectId)}/repository/files/${encodeURIComponent(filePath)}/raw`,
      { ref }
    );
    const res = await fetch(url, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(20000)
    });
    if (res.status === 404) return null;
    if (res.status === 401) throw new Error(this.unauthorizedMessage());
    if (res.status === 403) throw new Error('GitLab 返回 403：token 缺少 read_api 权限');
    if (!res.ok) throw new Error(`GitLab 返回 ${res.status} ${res.statusText} → ${filePath}`);
    return res.text();
  }
}
