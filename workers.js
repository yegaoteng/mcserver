// workers.js —— 修复 mcsrvstat.us 字段解析，保证 motd/players/version 正确

const SERVER_ADDR = 'xfan.l.cd';

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

// 实时查询（mcsrvstat.us）
async function queryServerFull() {
  try {
    const res = await fetch(`https://api.mcsrvstat.us/2/${SERVER_ADDR}`, {
      headers: { 'User-Agent': 'Minecraft-Monitor-Worker' }
    });
    const data = await res.json();
    const online = data.online === true;

    // 处理 motd：确保返回 { clean: [...], html: [...], raw: [...] }
    let motd = null;
    if (online && data.motd) {
      motd = {
        clean: Array.isArray(data.motd.clean) ? data.motd.clean : [],
        html: Array.isArray(data.motd.html) ? data.motd.html : [],
        raw: Array.isArray(data.motd.raw) ? data.motd.raw : [],
      };
    }

    // 处理 players：确保有 online 和 max
    let players = { online: 0, max: 20 }; // 默认 max=20
    if (online && data.players) {
      players = {
        online: typeof data.players.online === 'number' ? data.players.online : 0,
        max: typeof data.players.max === 'number' ? data.players.max : 20,
      };
    }

    // 处理 version：包装成对象
    let version = null;
    if (online && data.version) {
      version = {
        name_raw: String(data.version),
        name_clean: String(data.version),
        protocol: typeof data.protocol === 'number' ? data.protocol : 0,
      };
    }

    // 真实 ping
    const ping = online ? (typeof data.ping === 'number' ? data.ping : 0) : 0;

    return {
      online,
      motd,
      version,
      players,
      ping,
    };
  } catch (e) {
    console.error('mcsrvstat.us 查询失败', e);
    return { online: false, motd: null, version: null, players: { online: 0, max: 20 }, ping: 0 };
  }
}

// 简单查询（用于 Cron）
async function queryServerSimple() {
  try {
    const res = await fetch(`https://api.mcsrvstat.us/2/${SERVER_ADDR}`, {
      headers: { 'User-Agent': 'Minecraft-Monitor-Worker' }
    });
    const data = await res.json();
    const online = data.online === true;
    return {
      online,
      ping: online ? (typeof data.ping === 'number' ? data.ping : 0) : 0,
      players: online ? (typeof data.players?.online === 'number' ? data.players.online : 0) : 0,
    };
  } catch (e) {
    return { online: false, ping: 0, players: 0 };
  }
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const s = await queryServerSimple();
      await env.DB.prepare(
        'INSERT INTO metrics (time, online, ping, players) VALUES (?, ?, ?, ?)'
      ).bind(Date.now(), s.online ? 1 : 0, s.ping, s.players).run();
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
        '10m': 10 * 60 * 1000,
        '1h': 60 * 60 * 1000,
        '24h': 24 * 60 * 60 * 1000,
        '7d': 7 * 24 * 60 * 60 * 1000,
        '30d': 30 * 24 * 60 * 60 * 1000,
      };
      const range = url.searchParams.get('range') || '1h';
      const since = Date.now() - (rangeMap[range] || rangeMap['1h']);
      const { results } = await env.DB
        .prepare('SELECT time, online, ping, players FROM metrics WHERE time >= ? ORDER BY time ASC')
        .bind(since)
        .all();
      return jsonResponse(results.map(r => ({
        time: r.time,
        online: r.online === 1,
        ping: r.ping,
        players: r.players,
      })));
    }

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
        return jsonResponse({ ok: true });
      } catch (e) {
        return jsonResponse({ ok: false, error: e.message }, 400);
      }
    }

    if (path === '/init') {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time INTEGER NOT NULL,
        online INTEGER NOT NULL,
        ping INTEGER NOT NULL,
        players INTEGER NOT NULL
      )`).run();
      await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_metrics_time ON metrics(time)').run();
      return jsonResponse({ ok: true, msg: '表已创建' });
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
};
