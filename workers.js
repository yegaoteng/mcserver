const SERVER_ADDR = 'xfan.l.cd'; // 你的服务器地址

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

// API A：mcstatus.io —— 负责 online / players / motd / version
async function queryFromMcstatus() {
  try {
    const res = await fetch(`https://api.mcstatus.io/v2/status/java/${SERVER_ADDR}`, {
      headers: { 'User-Agent': 'Minecraft-Monitor' },
    });
    if (!res.ok) throw new Error('mcstatus.io 请求失败');
    const data = await res.json();
    if (data.online !== true) return { online: false };
    return {
      online: true,
      motd: data.motd || null,
      version: data.version || null,
      players: {
        online: Number(data.players?.online || 0),
        max: Number(data.players?.max || 20),
      },
    };
  } catch (e) {
    console.error('[API A 失败]', e.message);
    return null; // 返回 null 表示获取失败
  }
}

// API B：mcsrvstat.us —— 专门负责 ping（取它的顶层 ping 字段）
async function queryPing() {
  try {
    const res = await fetch(`https://api.mcsrvstat.us/2/${SERVER_ADDR}`, {
      headers: { 'User-Agent': 'Minecraft-Monitor' },
    });
    if (!res.ok) throw new Error('mcsrvstat.us 请求失败');
    const data = await res.json();
    if (data.online !== true) return 0;
    return Number(data.ping || 0); // 直接返回 ping 数值
  } catch (e) {
    console.error('[API B 失败]', e.message);
    return 0;
  }
}

// 合并两个 API 的结果（双 API 互补）
async function queryServerFull() {
  // 并发请求两个 API，提高效率
  const [info, ping] = await Promise.all([
    queryFromMcstatus(),
    queryPing(),
  ]);

  // 如果 API A 完全失败（返回 null），返回离线兜底
  if (!info) {
    return {
      online: false,
      motd: null,
      version: null,
      players: { online: 0, max: 20 },
      ping: 0,
    };
  }

  return {
    online: info.online,
    motd: info.online ? info.motd : null,
    version: info.online ? info.version : null,
    players: info.players,
    ping: info.online ? ping : 0, // 只有在线时才记录 ping
  };
}

// 简易版（用于 Cron 写入 D1）
async function queryServerSimple() {
  const [info, ping] = await Promise.all([
    queryFromMcstatus(),
    queryPing(),
  ]);
  if (!info || !info.online) return { online: false, ping: 0, players: 0 };
  return {
    online: true,
    ping: ping,
    players: info.players.online,
  };
}

export default {
  // Cron：每分钟采集一次写入 D1
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

    // GET /status —— 实时合并状态
    if (path === '/status') {
      const realtime = await queryServerFull();
      return jsonResponse(realtime);
    }

    // GET /metrics —— 从 D1 读历史
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
        return jsonResponse({ ok: true });
      } catch (e) {
        return jsonResponse({ ok: false, error: e.message }, 400);
      }
    }

    // GET /init —— 建表
    if (path === '/init') {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time INTEGER NOT NULL,
        online INTEGER NOT NULL,
        ping INTEGER NOT NULL,
        players INTEGER NOT NULL
      )`).run();
      await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_metrics_time ON metrics(time)').run();
      return jsonResponse({ ok: true, msg: 'D1 表已创建' });
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
};
