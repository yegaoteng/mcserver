// workers.js —— 纯 JavaScript 版，零类型报错
// 对应 wrangler.toml 里的 binding = "DB"

const SERVER_ADDR = 'xfan.l.cd';

// 查询 MC 服务器状态（调用公开 API）
async function queryServer() {
  try {
    const res = await fetch(`https://api.mcstatus.io/v2/status/java/${SERVER_ADDR}`);
    const data = await res.json();
    const online = data.online === true;
    return {
      online,
      ping: online ? Number(data.latency?.java || 0) : 0,
      players: online ? Number(data.players?.online || 0) : 0
    };
  } catch (e) {
    return { online: false, ping: 0, players: 0 };
  }
}

export default {
  // Cron 触发器：每 1 分钟采集一次（Cloudflare 最短间隔）
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const s = await queryServer();
      await env.DB.prepare(
        'INSERT INTO metrics (time, online, ping, players) VALUES (?, ?, ?, ?)'
      ).bind(Date.now(), s.online ? 1 : 0, s.ping, s.players).run();
      console.log('[Cron] 采集完成', s);
    })());
  },

  // HTTP 请求处理
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // GET /status —— 最新状态
    if (path === '/status') {
      const row = await env.DB
        .prepare('SELECT * FROM metrics ORDER BY time DESC LIMIT 1')
        .first();
      if (!row) return Response.json({ online: false });
      return Response.json({
        online: row.online === 1,
        ping: row.ping,
        players: { online: row.players, max: 20 },
        motd: { clean: ['小帆的服务器'] },
        version: { name_clean: '1.21.10' }
      });
    }

    // GET /metrics?range=1h|24h|7d|30d
    if (path === '/metrics') {
      const rangeMap = {
        '10m': 10 * 60 * 1000,
        '1h': 60 * 60 * 1000,
        '24h': 24 * 60 * 60 * 1000,
        '7d': 7 * 24 * 60 * 60 * 1000,
        '30d': 30 * 24 * 60 * 60 * 1000
      };
      const range = url.searchParams.get('range') || '1h';
      const since = Date.now() - (rangeMap[range] || rangeMap['1h']);
      const { results } = await env.DB
        .prepare('SELECT time, online, ping, players FROM metrics WHERE time >= ? ORDER BY time ASC')
        .bind(since)
        .all();
      return Response.json(results.map(r => ({
        time: r.time,
        online: r.online === 1,
        ping: r.ping,
        players: r.players
      })));
    }

    // POST /collect —— 手动写入（调试用）
    if (path === '/collect' && request.method === 'POST') {
      try {
        const d = await request.json();
        await env.DB.prepare(
          'INSERT INTO metrics (time, online, ping, players) VALUES (?, ?, ?, ?)'
        ).bind(
          Date.now(),
          Number(d.online) ? 1 : 0,
          Number(d.ping) || 0,
          Number(d.players) || 0
        ).run();
        return Response.json({ ok: true });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 400 });
      }
    }

    // GET /init —— 首次建表（访问一次即可）
    if (path === '/init') {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time INTEGER NOT NULL,
        online INTEGER NOT NULL,
        ping INTEGER NOT NULL,
        players INTEGER NOT NULL
      )`).run();
      await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_metrics_time ON metrics(time)').run();
      return Response.json({ ok: true, msg: '表已创建' });
    }

    return new Response('Not Found', { status: 404 });
  }
};