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

// ---------- 主 API：minecraftpinger.com ----------
async function queryPrimary() {
  try {
    const res = await fetch(`https://www.minecraftpinger.com/api/v1/${SERVER_ADDR}`, {
      headers: { 'User-Agent': 'Minecraft-Monitor/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.server) return null; // 离线
    return {
      online: true,
      motd: { clean: [data.server.motd], raw: [data.server.motd], html: [data.server.motd] },
      version: { name_raw: data.server.version, name_clean: data.server.version, protocol: 0 },
      players: {
        online: Number(data.server.players?.online || 0),
        max: Number(data.server.players?.max || 20),
      },
      ping: Number(data.server.ping || 0),
    };
  } catch (e) {
    console.error('[主API失败]', e.message);
    return null;
  }
}

// ---------- 备选 API：mc-api.io ----------
async function querySecondary() {
  try {
    const res = await fetch(`https://mc-api.io/server/JAVA/${SERVER_ADDR}`, {
      headers: { 'User-Agent': 'Minecraft-Monitor/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.online) return null;
    return {
      online: true,
      motd: { clean: [data.motd], raw: [data.motd], html: [data.motd] },
      version: { name_raw: data.version, name_clean: data.version, protocol: data.protocol || 0 },
      players: {
        online: Number(data.onlinePlayers || 0),
        max: Number(data.maxPlayers || 20),
      },
      ping: Number(data.ping || 0),
    };
  } catch (e) {
    console.error('[备选API失败]', e.message);
    return null;
  }
}

// ---------- 合并结果：取最小 ping ----------
async function queryServerFull() {
  // 并发请求两个 API
  const [primary, secondary] = await Promise.all([queryPrimary(), querySecondary()]);

  // 收集所有成功的 API 结果
  const results = [];
  if (primary) results.push(primary);
  if (secondary) results.push(secondary);

  // 没有一个 API 成功 → 离线
  if (results.length === 0) {
    return {
      online: false,
      motd: null,
      version: null,
      players: { online: 0, max: 20 },
      ping: 0,
    };
  }

  // 选择 ping 最小的那个结果作为最终输出
  const best = results.reduce((a, b) => (a.ping <= b.ping ? a : b));

  // 但 players / motd / version 尽量用主 API 的（如果主 API 成功）
  if (primary) {
    best.motd = primary.motd;
    best.version = primary.version;
    best.players = primary.players;
  }
  // 如果主 API 失败，就用备选的结果（已经是 best 了）

  return best;
}

// ---------- 简易版（用于 Cron 写入 D1，同样取最小 ping）----------
async function queryServerSimple() {
  const [primary, secondary] = await Promise.all([queryPrimary(), querySecondary()]);
  let online = false;
  let ping = 0;
  let players = 0;

  if (primary) {
    online = true;
    ping = primary.ping;
    players = primary.players.online;
  }
  if (secondary) {
    if (!online || secondary.ping < ping) {
      online = true;
      ping = secondary.ping;
      players = secondary.players.online;
    }
  }
  return { online, ping, players };
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
      return jsonResponse({ ok: true, msg: 'D1 表已创建' });
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
};
