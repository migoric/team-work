/** 极简 GitLab REST v4 客户端。零依赖，只用 fetch。 */

export class GitLab {
  constructor({ host, token }) {
    if (!host) throw new Error('缺少 GitLab host');
    if (!token) throw new Error('缺少 GitLab token');
    this.host = host.replace(/\/$/, '');
    this.token = token;
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
      headers: {
        'PRIVATE-TOKEN': this.token,
        accept: 'application/json'
      },
      signal: AbortSignal.timeout(20000)
    });

    if (res.status === 401) throw new Error('GitLab 返回 401：token 无效或已过期');
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
}
