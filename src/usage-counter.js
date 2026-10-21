// 每日用量强一致计数：按 UTC 日期命名 DO 实例。
export class UsageCounter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/add" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const cur = (await this.state.storage.get("counters")) || {
        requests: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };
      cur.requests += Number(body.requests) || 0;
      cur.prompt_tokens += Number(body.prompt) || 0;
      cur.completion_tokens += Number(body.completion) || 0;
      cur.total_tokens += Number(body.total) || 0;
      await this.state.storage.put("counters", cur);
      return Response.json(cur);
    }
    if (url.pathname === "/get") {
      const cur = (await this.state.storage.get("counters")) || {
        requests: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };
      return Response.json(cur);
    }
    return new Response("not found", { status: 404 });
  }
}
