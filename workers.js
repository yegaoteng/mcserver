const SERVER_ADDR = 'xfan.l.cd'; // 你的服务器地址，可加 :端口

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// 主查询：使用 minecraftpinger.com（含真实 ping）
async function queryServerFull() {
  try {
    const res = await fetch(`https://www.minecraftpinger.com/api/v1/${SERVER_ADDR}`, {
      headers: { 'User-Agent': 'Minecraft-Monitor/1.0' },
    });
    const data = await res.json();

    // 离线或服务不可达时，server 为 null
    if (!data.server) {
      return {
        online: false,
        motd: null,
        version: null,
        players: { online: 0, max: 20 },
        ping: 0,
      };
    }

    const s = data.server;
    return {
      online: true,
      motd: { clean: [s.motd], raw: [s.motd], html: [s.motd] },
      version: { name_raw: s.version, name_clean: s.version, protocol: 0 },
      players: {
        online: Number(s.players.online || 0),
        max: Number(s.players.max || 20),
      },
      // ✅ 真正的 ping 毫秒数
      ping: Number(s.ping || 0),
    };
  } catch (e) {
    console.error('[minecraftpinger 失败]', e.message);
    return { online: false, motd: null, version: null, players: { online: 0, max: 20 }, ping: 0 };
  }
}

// 简易版（用于 Cron 写入 D1）
async function queryServerSimple() {
  try {
    const res = await fetch(`https://www.minecraftpinger.com/api/v1/${SERVER_ADDR}`, {
      headers: { 'User-Agent': 'Minecraft-Monitor/1.0' },
    });
    const data = await res.json();
    if (!data.server) return { online: false, ping: 0, players: 0 };
    return {
      online: true,
      ping: Number(data.server.ping || 0),
      players: Number(data.server.players.online || 0),
    };
  } catch (e) {
    return { online: false, ping: 0, players: 0 };
  }
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const s = await queryServerSimple();
      if (env.DB) {
        await env.DB.prepare(
          'INSERT INTO metrics (time, online, ping, players) VALUES (?, ?, ?, ?)'
        ).bind(Date.now(), s.online ? 1 : 0, s.ping, s.players).run();
      }
      console.log('[Cron] 采集完成', s);
    })());
  },

  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/status') {
      const realtime = await queryServerFull();
      return jsonResponse(realtime);
    }

    if (path === '/metrics') {
      const rangeMap = {
        '10m': 10 * 60 * 1000, '1h': 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000,
        '7d': 7 * 24 * 60 * 60 * 1000, '30d': 30 * 24 * 60 * 60 * 1000,
      };
      const range = url.searchParams.get('range') || '1h';
      const since = Date.now() - (rangeMap[range] || rangeMap['1h']);
      const { results } = await env.DB
        .prepare('SELECT time, online, ping, players FROM metrics WHERE time >= ? ORDER BY time ASC')
        .bind(since).all();
      return jsonResponse(results.map(r => ({
        time: r.time, online: r.online === 1, ping: r.ping, players: r.players,
      })));
    }

    if (path === '/collect' && request.method === 'POST') {
      try {
        const d = await request.json();
        await env.DB.prepare('INSERT INTO metrics (time, online, ping, players) VALUES (?, ?, ?, ?)')
          .bind(Date.now(), Number(d.online) ? 1 : 0, Number(d.ping) || 0, Number(d.players) || 0).run();
        return jsonResponse({ ok: true });
      } catch (e) {
        return jsonResponse({ ok: false, error: e.message }, 400);
      }
    }

    if (path === '/init') {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL,
        online INTEGER NOT NULL, ping INTEGER NOT NULL, players INTEGER NOT NULL)`).run();
      await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_metrics_time ON metrics(time)').run();
      return jsonResponse({ ok: true, msg: 'D1 表已创建' });
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
};
