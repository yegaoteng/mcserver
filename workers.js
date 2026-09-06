const SERVER_ADDR = "xfan.l.cd"; // 你的服务器地址
const corsHeaders = { "Access-Control-Allow-Origin": "*" };

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

// 调用第三方API获取全量数据
async function queryServerFull() {
  try {
    // 优先使用 mcstatus.io，如果之前用的是 mcsrvstat.us 可以替换下面的URL
    const res = await fetch(`https://api.mcstatus.io/v2/status/java/${SERVER_ADDR}`);
    if (!res.ok) throw new Error("API请求失败");
    const data = await res.json();
    
    const online = data.online === true;
    if (!online) {
      return { online: false, motd: null, version: null, players: { online: 0, max: 20 }, ping: 0 };
    }

    // 兼容不同API的 ping/latency 字段
    const realPing = Number(data.ping || data.latency?.java || 0);

    return {
      online: true,
      motd: data.motd || { raw: [], clean: [], html: [] },
      version: data.version || { name_raw: "Unknown", name_clean: "Unknown", protocol: 0 },
      players: {
        online: Number(data.players?.online || 0),
        max: Number(data.players?.max || 20)
      },
      ping: realPing
    };
  } catch (e) {
    console.error("第三方API请求异常:", e);
    // 异常时返回离线结构，防止前端崩溃
    return { online: false, motd: null, version: null, players: { online: 0, max: 20 }, ping: 0, error: e.message };
  }
}

// 简易查询（用于定时写入D1）
async function queryServerSimple() {
  try {
    const res = await fetch(`https://api.mcstatus.io/v2/status/java/${SERVER_ADDR}`);
    const data = await res.json();
    const online = data.online === true;
    return {
      online,
      ping: online ? Number(data.ping || data.latency?.java || 0) : 0,
      players: online ? Number(data.players?.online || 0) : 0
    };
  } catch (e) {
    return { online: false, ping: 0, players: 0 };
  }
}

export default {
  // 定时触发器：每分钟采集一次存入D1
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const s = await queryServerSimple();
      if (env.DB) {
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

    // 实时状态接口（API不变）
    if (path === '/status') {
      const realtime = await queryServerFull();
      return jsonResponse(realtime);
    }

    // 历史数据接口（从D1读取）
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

    // 初始化D1表
    if (path === '/init') {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL,
        online INTEGER NOT NULL, ping INTEGER NOT NULL, players INTEGER NOT NULL)`).run();
      await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_metrics_time ON metrics(time)').run();
      return jsonResponse({ ok: true, msg: 'D1表已创建' });
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
};
