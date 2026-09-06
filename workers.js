// workers.js —— 纯 JavaScript 版，修复 Ping 为 0 问题（改用 mcsrvstat.us）
// 对应 wrangler.toml 里的 binding = "DB"

const SERVER_ADDR = 'xfan.l.cd';

// 统一 CORS 响应头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// 统一 JSON 响应封装
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// 实时查询服务器完整状态（使用 mcsrvstat.us，直接返回真实 ping）
async function queryServerFull() {
  try {
    // 请求 mcsrvstat.us 的 v2 接口
    const res = await fetch(`https://api.mcsrvstat.us/2/${SERVER_ADDR}`, {
      headers: { 'User-Agent': 'Minecraft-Monitor-Worker' } // 该 API 要求提供 User-Agent
    });
    const data = await res.json();
    const online = data.online === true;
    
    // 该 API 直接返回顶层的 ping 数值
    const ping = online ? Number(data.ping || 0) : 0;

    return {
      online,
      motd: online ? data.motd : null,
      version: online ? { 
        name_raw: data.version, 
        name_clean: data.version, 
        protocol: data.protocol 
      } : null,
      players: online ? (data.players || { online: 0, max: 0 }) : { online: 0, max: 0 },
      ping,
    };
  } catch (e) {
    console.error('查询 mcsrvstat.us 失败', e);
    return { online: false, motd: null, version: null, players: { online: 0, max: 0 }, ping: 0 };
  }
}

// Cron 定时采集（仅存入 D1 基础数据）
async function queryServerSimple() {
  try {
    const res = await fetch(`https://api.mcsrvstat.us/2/${SERVER_ADDR}`, {
      headers: { 'User-Agent': 'Minecraft-Monitor-Worker' }
    });
    const data = await res.json();
    const online = data.online === true;
    return {
      online,
      ping: online ? Number(data.ping || 0) : 0,
      players: online ? Number(data.players?.online || 0) : 0
    };
  } catch (e) {
    return { online: false, ping: 0, players: 0 };
  }
}

export default {
  // Cron 触发器：每 1 分钟采集一次
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const s = await queryServerSimple();
      await env.DB.prepare(
        'INSERT INTO metrics (time, online, ping, players) VALUES (?, ?, ?, ?)'
      ).bind(Date.now(), s.online ? 1 : 0, s.ping, s.players).run();
      console.log('[Cron] 采集完成', s);
    })());
  },

  // HTTP 请求处理
  async fetch(request, env) {
    // 处理 OPTIONS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // GET /status —— 实时查询完整状态（含真实 Ping）
    if (path === '/status') {
      const realtime = await queryServerFull();
      return jsonResponse(realtime);
    }

    // GET /metrics?range=10m|1h|24h|7d|30d —— 历史数据
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

    // GET /init —— 首次建表
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
