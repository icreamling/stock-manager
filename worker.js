// Cloudflare Worker：在你原本的 stock-api 上加入 /quote（盤中即時）與 /close（收盤資料）兩條路徑
// 原本「股票清單」的程式碼請整段搬進下面的 handleStockList()，根路徑 "/" 的行為維持不變。

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
};
const json = (data, status = 200, maxAge = 0) =>
    new Response(JSON.stringify(data), {
        status,
        headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${maxAge}` }
    });

export default {
    async fetch(request, env, ctx) {
        if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
        const url = new URL(request.url);
        if (url.pathname === "/quote") return quote(url);
        if (url.pathname === "/close") return close(url);
        return handleStockList(request, env, ctx); // ← 你原本的股票清單程式碼
    }
};

// 你原本的程式碼放這裡（需回傳含 CORS 標頭的 Response）
async function handleStockList(request, env, ctx) {
    return json({ error: "請把原本的股票清單程式碼貼到 handleStockList()" }, 500);
}

// ① 盤中即時：代理證交所 getStockInfo.jsp
async function quote(url) {
    const ex = url.searchParams.get("ex_ch");
    if (!ex || ex.length > 2000 || !/^[a-z0-9_.|]+$/i.test(ex)) return json({ error: "bad ex_ch" }, 400);
    try {
        const r = await fetch(
            `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(ex)}&json=1&delay=0&_=${Date.now()}`,
            { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://mis.twse.com.tw/stock/index.jsp" } }
        );
        if (!r.ok) return json({ error: "upstream " + r.status }, 502);
        return json(await r.json(), 200, 5);
    } catch (e) {
        return json({ error: String(e) }, 502);
    }
}

// ② 收盤資料：證交所 STOCK_DAY_ALL + 櫃買 tpex_mainboard_quotes，只回傳你要的代碼
async function close(url) {
    const codes = new Set((url.searchParams.get("codes") || "").split(",").map(s => s.trim()).filter(Boolean));
    if (!codes.size) return json({});
    const num = v => {
        const n = parseFloat(String(v ?? "").replace(/,/g, ""));
        return Number.isFinite(n) ? n : null;
    };
    const sources = [
        { url: "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", code: ["Code"], close: ["ClosingPrice"], change: ["Change"] },
        { url: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes", code: ["SecuritiesCompanyCode", "Code"], close: ["Close", "ClosingPrice"], change: ["Change"] }
    ];
    const out = {};
    await Promise.all(sources.map(async s => {
        try {
            const r = await fetch(s.url, { headers: { "User-Agent": "Mozilla/5.0" }, cf: { cacheTtl: 300, cacheEverything: true } });
            if (!r.ok) return;
            const rows = await r.json();
            if (!Array.isArray(rows)) return;
            for (const row of rows) {
                const pick = keys => keys.map(k => row[k]).find(v => v !== undefined);
                const code = String(pick(s.code) ?? "").trim();
                if (!codes.has(code)) continue;
                const price = num(pick(s.close));
                if (!(price > 0)) continue;
                const change = num(pick(s.change));
                const prev = change === null ? null : price - change;   // 昨收 ＝ 收盤 − 漲跌
                out[code] = { price, prev: prev > 0 ? Math.round(prev * 10000) / 10000 : null };
            }
        } catch (e) { /* 單一來源失敗就略過 */ }
    }));
    return json(out, 200, 300);
}