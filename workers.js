const SERVER_ADDR = 'xfan.rthl.xyz'; // 请确保这里是你的服务器地址
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

// 实时完整查询（使用 mcstatus.io）
async function queryServerFull() {
  try {
    const res = await fetch(`https://api.mcstatus.io/v2/status/java/${SERVER_ADDR}`);
    const data = await res.json();
    const online = data.online === true;
    
    // 真实 Ping 读取
    const ping = online ? Number(data.latency?.java || 0) : 0;
    
    return {
      online,
      motd: online ? data.motd : null,
      version: online ? data.version : null,
      players: online ? data.players : { online: 0, max: Number(data.players?.max) || 20 },
      ping,
    };
  } catch (e) {
    // 暴露真实错误信息，方便排查
    return { online: false, motd: null, version: null, players: { online: 0, max: 20 }, ping: 0, error: e.message };
  }
}

// 简易查询（用于定时写入数据库）
async function queryServerSimple() {
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
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const s = await queryServerSimple();
      if(env.DB) {
        await env.DB.prepare('INSERT INTO metrics (time, online, ping, players) VALUES (?, ?, ?, ?)')
          .bind(Date.now(), s.online ? 1 : 0, s.ping, s.players).run();
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
      return jsonResponse({ ok: true, msg: '表已创建' });
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
};
