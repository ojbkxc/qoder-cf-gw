// 单飞续期锁：同一账号的 refresh_token 只能用一次，并发刷新必有一败。
export class RefreshLock {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    if (url.pathname === "/acquire") {
      const until = (await this.state.storage.get("until")) || 0;
      if (until > now) {
        return Response.json({ ok: false, until });
      }
      const lease = now + 30000;
      await this.state.storage.put("until", lease);
      await this.state.storage.setAlarm(lease);
      return Response.json({ ok: true, lease });
    }
    if (url.pathname === "/release") {
      await this.state.storage.delete("until");
      await this.state.storage.deleteAlarm();
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }

  async alarm() {
    await this.state.storage.delete("until");
  }
}
