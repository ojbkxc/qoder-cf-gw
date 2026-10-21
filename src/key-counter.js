// API Key 调用次数原子计数：每把 key 一个 DO 实例，检查与递增在同一事务内完成。
export class ApiKeyCounter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/check" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      // 上限每请求从 KV 透传：改上限立即生效，不再持久化到 DO（避免跨存储漂移）
      const max = Object.prototype.hasOwnProperty.call(body, "max")
        ? Math.max(0, Math.floor(Number(body.max) || 0))
        : Math.max(0, Math.floor(Number(await this.state.storage.get("max")) || 0));
      let used = Number(await this.state.storage.get("used")) || 0;
      if (max > 0 && used >= max) {
        return Response.json({ ok: false, used, max });
      }
      used += 1;
      await this.state.storage.put("used", used);
      return Response.json({ ok: true, used, max });
    }
    if (url.pathname === "/setmax" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const max = Math.max(0, Math.floor(Number(body.max) || 0));
      await this.state.storage.put("max", max);
      return Response.json({ ok: true, max });
    }
    if (url.pathname === "/reset" && request.method === "POST") {
      await this.state.storage.delete("used");
      return Response.json({ ok: true, used: 0 });
    }
    if (url.pathname === "/get") {
      const used = Number(await this.state.storage.get("used")) || 0;
      const max = Math.max(0, Math.floor(Number(await this.state.storage.get("max")) || 0));
      return Response.json({ used, max });
    }
    return new Response("not found", { status: 404 });
  }
}
