import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut }
    from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp }
    from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/* ============ 1. 設定：Firebase 網頁應用程式設定 ============ */
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
    apiKey: "AIzaSyAg8Cjx4mHmafY0EUVnXBDIiNHzFrWUhsY",
    authDomain: "stock-65e2a.firebaseapp.com",
    projectId: "stock-65e2a",
    storageBucket: "stock-65e2a.firebasestorage.app",
    messagingSenderId: "498582195853",
    appId: "1:498582195853:web:334305d223a5968fcc5cc4",
    measurementId: "G-D5ED3281W7"
};
// 只申請「本網站自己建立的檔案」權限，無法讀取使用者其他雲端檔案
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const SHEET_TAB = "交易紀錄";
const HEADER = ["id", "日期", "類型", "代碼", "名稱", "成交價", "股數", "手續費"];

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

const $ = id => document.getElementById(id);
const enc = encodeURIComponent;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ============ 2. 狀態 ============ */
let stockMaster = [];

const sources = [
    {
        market: "上市",
        url: "https://openapi.twse.com.tw/v1/opendata/t187ap03_L"
    },
    {
        market: "上市基金",
        url: "https://openapi.twse.com.tw/v1/opendata/t187ap47_L"
    },
    {
        market: "上櫃",
        url: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O"
    },
    {
        market: "興櫃",
        url: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_R"
    },
    {
        market: "上櫃行情",
        url: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes"
    },
    {
        market: "興櫃行情",
        url: "https://www.tpex.org.tw/openapi/v1/tpex_esb_latest_statistics"
    }
];

let user = null;
let accessToken = null;     // 只存在記憶體，重新整理後需重新連線
let sheetId = null;
let initing = false;
let selectedStock = null;
let transactions = [];
let currentPrices = {};
let prevCloses = {};
let quoteDates = {};
let nextId = 1;
let saveChain = Promise.resolve();
const expandedStocks = new Set();

/* ============ 3. 畫面狀態切換 ============ */
function setView() {
    const ready = !!(user && accessToken && sheetId);
    $("loginCard").hidden = !!user;
    $("loadingCard").hidden = !(user && initing);
    $("connectCard").hidden = !(user && !initing && !ready);
    $("appRoot").hidden = !(ready && !initing);
}
function setSync(msg, isError = false) {
    $("syncStatus").textContent = msg;
    $("syncStatus").className = "sync-status" + (isError ? " error" : "");
}

/* ============ 4. 登入 / 登出 ============ */
async function login() {
    try {
        const provider = new GoogleAuthProvider();
        provider.addScope(DRIVE_SCOPE);
        const result = await signInWithPopup(auth, provider);
        user = result.user;
        accessToken = GoogleAuthProvider.credentialFromResult(result)?.accessToken || null;
        if (accessToken) await init(); else setView();
    } catch (e) {
        if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
            alert("登入失敗：" + e.message);
        }
    }
}
async function logout() {
    await signOut(auth);
}
onAuthStateChanged(auth, u => {
    user = u;
    if (!u) {
        accessToken = null; sheetId = null; transactions = []; currentPrices = {}; prevCloses = {}; quoteDates = {};
        expandedStocks.clear(); clearInterval(autoTimer); $("autoRefresh").value = "0";
        updateFilterOptions(); renderStocks();
    } else {
        $("userName").textContent = u.displayName || u.email || "已登入";
    }
    setView();
});

/* ============ 5. Google Sheets ============ */
async function sheets(path, options = {}) {
    const res = await fetch(SHEETS_API + path, {
        ...options,
        headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" }
    });
    if (res.status === 401) {
        accessToken = null; setView();
        throw new Error("Google 授權已過期，請重新連線");
    }
    if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        const err = new Error(j.error?.message || "HTTP " + res.status);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

async function createSheet() {
    const j = await sheets("", {
        method: "POST",
        body: JSON.stringify({
            properties: { title: "股票投資統整表" },
            sheets: [{ properties: { title: SHEET_TAB } }]
        })
    });
    return j.spreadsheetId;
}

async function useSheet(id) {
    const data = await sheets(`/${id}/values/${enc(SHEET_TAB + "!A2:H")}`);

    const rows = (data.values || []).map(r => ({
        id: Number(r[0]),
        date: String(r[1] || ""),
        type: r[2] === "賣出" ? "sell" : "buy",
        code: String(r[3] || ""),
        name: String(r[4] || ""),
        price: Number(r[5]),
        qty: Number(r[6]),
        fee: Math.max(0, Number(r[7]) || 0)
    })).filter(t =>
        t.id > 0 && t.date && t.code && t.price > 0 && t.qty > 0
    );
    transactions = rows;
    nextId = rows.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    sheetId = id;
    $("sheetLink").href = "https://docs.google.com/spreadsheets/d/" + id;
    setSync("✅ 已與試算表同步");
    updateFilterOptions();
    renderStocks();
}

async function writeSheet() {
    const rows = transactions.map(t => [
        t.id,
        t.date,
        t.type === "buy" ? "買入" : "賣出",
        t.code,
        t.name,
        t.price,
        t.qty,
        Number(t.fee) || 0
    ]);
    await sheets(`/${sheetId}/values/${enc(SHEET_TAB)}:clear`, { method: "POST", body: "{}" });
    await sheets(`/${sheetId}/values/${enc(SHEET_TAB + "!A1")}?valueInputOption=RAW`, {
        method: "PUT", body: JSON.stringify({ values: [HEADER, ...rows] })
    });
}

function persist() {
    setSync("儲存中…");
    saveChain = saveChain.then(writeSheet).then(
        () => setSync("✅ 已同步 " + new Date().toLocaleTimeString("zh-TW", { hour12: false })),
        e => setSync("⚠️ 儲存失敗：" + e.message, true)
    );
    return saveChain;
}

/* ============ 6. Firebase：只存 uid 與試算表 ID ============ */
const userRef = () => doc(db, "users", user.uid);
const saveSheetId = id => setDoc(userRef(), { sheetId: id, lastLogin: serverTimestamp() });

async function init() {
    if (initing) return;
    initing = true; setView();
    try {
        await loadStockMaster();
        const snap = await getDoc(userRef());
        let id = snap.exists() ? snap.data().sheetId : null;
        if (id) {
            try { await useSheet(id); }
            catch (e) {
                if ([400, 403, 404].includes(e.status)) {
                    if (!confirm("找不到原本的試算表（可能已刪除或沒有權限）。\n要建立一份新的試算表嗎？")) throw e;
                    id = null;
                } else throw e;
            }
        }
        if (!id) { id = await createSheet(); await useSheet(id); }
        await saveSheetId(id);
        refreshPrices();
    } catch (e) {
        alert("初始化失敗：" + e.message);
    } finally {
        initing = false; setView();
    }
}

async function changeSheet() {
    const input = prompt("貼上要使用的試算表網址或 ID。\n留空並按確定＝建立一份全新的試算表。\n（限本網站先前建立的試算表）");
    if (input === null) return;
    try {
        const m = input.match(/\/d\/([\w-]+)/);
        let id = m ? m[1] : input.trim();
        if (!id) id = await createSheet();
        await useSheet(id);
        await saveSheetId(id);
        refreshPrices();
    } catch (e) {
        alert("無法使用該試算表：" + e.message + "\n因權限限制，本站只能存取由本站自己建立的試算表。");
    }
}

/* ============ 7. 交易表單 ============ */
function todayString() {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function money(v) { return Number(v).toLocaleString("zh-TW", { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
function percent(v) { return Number(v).toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%"; }
function profitClass(v) { return v > 0 ? "profit" : v < 0 ? "loss" : ""; }

function handleTypeChange() {
    const selling = $("transactionType").value === "sell";
    $("tradePriceLabel").textContent = selling ? "賣出成交價" : "買入價格";
    $("tradePrice").placeholder = selling ? "請輸入賣出成交價" : "請輸入買入價格";
    $("transactionHint").textContent = selling
        ? "賣出會減少持股。系統會檢查該交易日期當下是否有足夠股數，並以先進先出計算已實現損益。"
        : "買入會增加持股與成本；目前股價由股價更新功能自動取得。";
    $("qty").placeholder = selling ? "輸入要賣出的股數" : "輸入要買進的股數";
}

function searchStock() {
    const keyword = $("stockKeyword").value.trim();
    const box = $("searchResult");
    box.innerHTML = "";
    if (!keyword) { box.style.display = "none"; return; }
    const results = stockMaster.filter(s => s.code.includes(keyword) || s.name.includes(keyword));
    results.forEach(stock => {
        const div = document.createElement("div");
        div.className = "search-item";
        div.textContent = stock.code + " " + stock.name;
        div.onclick = () => {
            selectedStock = stock;
            $("stockKeyword").value = stock.code + " " + stock.name;
            box.style.display = "none";
            if ($("transactionType").value === "sell") {
                $("transactionHint").textContent = `目前可賣出股數：${money(getLedger(stock.code).shares)} 股。賣出數量不能超過交易日期當下的可用持股。`;
            }
        };
        box.appendChild(div);
    });
    if (!results.length) {
        const div = document.createElement("div");
        div.className = "search-item"; div.textContent = "查無此股票，請從清單選擇";
        box.appendChild(div);
    }
    box.style.display = "block";
}

/* ============ 8. 股票名稱 ============ */
async function loadStockMaster() {
    const response = await fetch(
        "https://stock-api.icreamling.workers.dev/"
    );

    if (!response.ok) {
        throw new Error(`股票清單 API 失敗：HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
        throw new Error("股票清單 API 回傳格式不是陣列");
    }

    stockMaster = data;
    console.log(stockMaster)
}

/* FIFO 先進先出法
 * 1. 買入：建立一批持股，成本包含買入手續費
 * 2. 賣出：依買入時間，先扣除最早買入的持股
 * 3. 賣出損益：賣出金額 - FIFO 成本 - 賣出手續費
 * 4. 同日交易依 id 順序處理
 */
function getLedger(code) {
    const items = transactions
        .filter(t => t.code === code)
        .sort((a, b) =>
            a.date.localeCompare(b.date) || a.id - b.id
        );

    // 每個 lot 代表一批買入的股票
    const lots = [];

    let shares = 0;
    let cost = 0;
    let realized = 0;

    const details = {};

    for (const t of items) {
        const fee = Math.max(0, Number(t.fee) || 0);

        if (t.type === "buy") {
            const buyCost = t.price * t.qty + fee;

            lots.push({
                id: t.id,
                shares: t.qty,
                unitCost: buyCost / t.qty
            });

            shares += t.qty;
            cost += buyCost;

            details[t.id] = {
                realizedProfit: 0,
                costBasis: buyCost,
                fee,
                soldShares: 0
            };

        } else {
            // 賣出股數不得超過當下持股
            if (shares <= 0 || t.qty > shares) {
                return {
                    valid: false,
                    shares,
                    cost,
                    realized,
                    details
                };
            }

            let remaining = t.qty;
            let costBasis = 0;

            // FIFO：先消耗最早買入的 lot
            while (remaining > 0) {
                const lot = lots[0];

                if (!lot) {
                    return {
                        valid: false,
                        shares,
                        cost,
                        realized,
                        details
                    };
                }

                const usedShares = Math.min(
                    remaining,
                    lot.shares
                );

                costBasis += usedShares * lot.unitCost;

                lot.shares -= usedShares;
                remaining -= usedShares;

                if (lot.shares <= 0) {
                    lots.shift();
                }
            }

            const sellAmount = t.price * t.qty;
            const profit = sellAmount - costBasis - fee;

            shares -= t.qty;
            cost -= costBasis;
            realized += profit;

            if (Math.abs(shares) < 1e-8) {
                shares = 0;
                cost = 0;
                lots.length = 0;
            }

            details[t.id] = {
                realizedProfit: profit,
                costBasis,
                fee,
                soldShares: t.qty
            };
        }
    }

    return {
        valid: true,
        shares,
        cost: Math.max(0, cost),
        realized,
        details
    };
}


function validateLedgerForCode(code, candidate) {
    const original = transactions;
    transactions = [...original, candidate];
    const ledger = getLedger(code);
    transactions = original;
    return ledger;
}

function addTransaction() {
    if (!sheetId) { alert("尚未連線到試算表"); return; }
    if (!selectedStock) { alert("請先從股票搜尋清單選擇股票"); return; }
    const type = $("transactionType").value;
    const price = Number($("tradePrice").value);
    const qty = Number($("qty").value);
    const feeInput = $("tradeFee").value.trim();
    const fee = feeInput === "" ? 0 : Number(feeInput);
    const date = $("tradeDate").value;
    const code = selectedStock.code;

    if ($("tradePrice").value.trim() === "" || !Number.isFinite(price) || price <= 0) {
        alert(type === "buy" ? "請輸入大於 0 的買入價格" : "請輸入大於 0 的賣出成交價"); return;
    }
    if (!Number.isInteger(qty) || qty <= 0) { alert("請輸入大於 0 的整數股數"); return; }
    if (!date) { alert("請選擇交易日期"); return; }
    if (!Number.isFinite(fee) || fee < 0) {
        alert("手續費不可小於 0");
        return;
    }
    const candidate = { id: nextId, code, name: selectedStock.name, type, date, price, qty, fee };
    const check = validateLedgerForCode(code, candidate);
    if (!check.valid) {
        alert(`這筆賣出會造成持股不足！\n依交易日期與順序，賣出前可用股數為 ${money(check.shares)} 股，不能賣出 ${money(qty)} 股。`);
        return;
    }
    nextId++;
    transactions.push(candidate);
    $("stockKeyword").value = "";
    $("tradePrice").value = "";
    $("qty").value = "";
    $("tradeFee").value = "0";
    $("tradeDate").value = todayString();
    selectedStock = null;

    updateFilterOptions(); renderStocks(); handleTypeChange();
    persist();
    refreshPrices();
}

/* ============ 8. 即時股價 ============ */
const PRICE_CONFIG = {
    workerUrl: "",      // 選填：你自己的 Cloudflare Worker 網址
    finmindToken: "",   // 選填：FinMind token
    corsProxies: [
        u => "https://corsproxy.io/?url=" + enc(u),
        u => "https://api.allorigins.win/raw?url=" + enc(u)
    ]
};
let refreshing = false, autoTimer = null;

async function fetchJson(url, ms = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
    } finally { clearTimeout(timer); }
}
function parseMis(json) {
    const quotes = {};
    (json.msgArray || []).forEach(item => {
        const prev = parseFloat(item.y);                 // 昨收
        let p = parseFloat(item.z);                      // 當盤成交價
        if (!(p > 0)) p = parseFloat((item.b || "").split("_")[0]);
        if (!(p > 0)) p = prev;
        if (!(p > 0)) return;
        const d = String(item.d || "");                  // 例如 20261028
        quotes[item.c] = {
            price: p,
            prev: prev > 0 ? prev : null,
            date: /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null
        };
    });
    return quotes;
}
async function fetchFromMis(codes) {
    const exCh = codes.flatMap(c => ["tse_" + c + ".tw", "otc_" + c + ".tw"]).join("|");
    const target = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&json=1&delay=0&_=${Date.now()}`;
    const attempts = [];
    if (PRICE_CONFIG.workerUrl) attempts.push(() => fetchJson(PRICE_CONFIG.workerUrl + "?ex_ch=" + enc(exCh)));
    PRICE_CONFIG.corsProxies.forEach(p => attempts.push(() => fetchJson(p(target))));
    for (const run of attempts) {
        try {
            const prices = parseMis(await run());
            if (Object.keys(prices).length) return prices;
        } catch (e) { console.warn("即時行情來源失敗：", e.message); }
    }
    return {};
}
async function fetchFromFinMind(code) {
    try {
        const start = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
        let url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${code}&start_date=${start}`;
        if (PRICE_CONFIG.finmindToken) url += "&token=" + PRICE_CONFIG.finmindToken;
        const json = await fetchJson(url);
        const rows = json.data || [];
        const last = rows.at(-1), before = rows.at(-2);
        if (!(last && last.close > 0)) return null;
        return {
            price: Number(last.close),
            prev: before && before.close > 0 ? Number(before.close) : null,
            date: last.date || null
        };
    } catch (e) { console.warn("FinMind 失敗：", code, e.message); return null; }
}
async function refreshPrices() {
    if (refreshing) return;
    const codes = [...new Set(transactions.map(t => t.code))];
    const status = $("priceStatus");
    if (!codes.length) { status.className = "price-status"; status.textContent = "請先新增交易紀錄"; return; }
    refreshing = true;
    $("refreshBtn").disabled = true;
    status.className = "price-status"; status.textContent = "更新中…";

    const quotes = await fetchFromMis(codes);
    let usedBackup = false;
    for (const code of codes.filter(c => !quotes[c])) {
        const q = await fetchFromFinMind(code);
        if (q) { quotes[code] = q; usedBackup = true; }
    }
    Object.entries(quotes).forEach(([code, q]) => {
        currentPrices[code] = q.price;
        if (q.prev) prevCloses[code] = q.prev;
        if (q.date) quoteDates[code] = q.date;
    });
    const failed = codes.filter(c => !quotes[c]);
    renderStocks();

    const time = new Date().toLocaleTimeString("zh-TW", { hour12: false });
    if (failed.length) {
        status.className = "price-status error";
        status.textContent = `⚠️ ${time} 更新 ${codes.length - failed.length}/${codes.length} 檔，失敗：${failed.join("、")}（沿用舊股價）`;
    } else {
        status.textContent = `✅ ${time} 已更新 ${codes.length} 檔` + (usedBackup ? "（部分為日收盤價）" : "");
    }
    $("refreshBtn").disabled = false;
    refreshing = false;
}
function setAutoRefresh() {
    clearInterval(autoTimer);
    const ms = Number($("autoRefresh").value);
    if (ms > 0) { autoTimer = setInterval(refreshPrices, ms); refreshPrices(); }
}

/* ============ 9. 列表渲染 ============ */
function groupStocks() {
    const groups = {};
    [...new Set(transactions.map(t => t.code))].forEach(code => {
        const items = transactions.filter(t => t.code === code);
        const ledger = getLedger(code);
        const current = currentPrices[code] ?? 0;
        const value = ledger.shares * current;
        const unrealized = value - ledger.cost;

        // 當日損益：以「行情日期」為界，之前的持股用昨收當基準，當日交易用成交價
        const prev = prevCloses[code], quoteDate = quoteDates[code];
        let dayPnl = null, dayBase = 0;
        if (current > 0 && prev > 0 && quoteDate) {
            let sharesBefore = 0, flow = 0, todayBuyCost = 0;
            items.forEach(t => {
                const fee = Number(t.fee) || 0;
                if (t.date < quoteDate) {
                    sharesBefore += t.type === "buy" ? t.qty : -t.qty;
                } else if (t.type === "buy") {
                    const c = t.price * t.qty + fee;
                    flow -= c; todayBuyCost += c;
                } else {
                    flow += t.price * t.qty - fee;
                }
            });
            dayPnl = value + flow - sharesBefore * prev;
            dayBase = sharesBefore * prev + todayBuyCost;
        }

        groups[code] = {
            code, name: items[0].name, items, shares: ledger.shares, cost: ledger.cost, value,
            realized: ledger.realized, unrealized, profit: ledger.realized + unrealized,
            dayPnl, dayBase,
            totalBuyCost: items
                .filter(t => t.type === "buy")
                .reduce((s, t) => s + t.price * t.qty + (Number(t.fee) || 0), 0)
        };
    });
    return groups;
}
function updateFilterOptions() {
    const filter = $("stockFilter");
    const old = filter.value;
    const groups = groupStocks();
    filter.innerHTML = '<option value="all">全部股票</option>';
    Object.values(groups).sort((a, b) => a.code.localeCompare(b.code)).forEach(g => {
        const opt = document.createElement("option");
        opt.value = g.code; opt.textContent = g.code + " " + g.name;
        filter.appendChild(opt);
    });
    filter.value = (old === "all" || groups[old]) ? old : "all";
}
function renderStocks() {
    const list = $("stockList");
    const all = Object.values(groupStocks()).sort((a, b) => a.code.localeCompare(b.code));
    const filter = $("stockFilter").value;
    list.innerHTML = "";

    const totalProfit = all.reduce((s, g) => s + g.profit, 0);
    $("invested").textContent = money(all.reduce((s, g) => s + g.cost, 0));
    $("stockCount").textContent = money(all.reduce((s, g) => s + g.shares, 0));
    $("tradeCount").textContent = all.length;
    $("totalProfit").textContent = (totalProfit > 0 ? "+" : "") + money(totalProfit);
    $("totalProfit").className = profitClass(totalProfit);
    const dayList = all.filter(g => g.dayPnl !== null);
    if (dayList.length) {
        const dayPnl = Math.round(dayList.reduce((s, g) => s + g.dayPnl, 0) * 100) / 100;
        const dayBase = dayList.reduce((s, g) => s + g.dayBase, 0);
        const dayRate = dayBase > 0 ? Math.round(dayPnl / dayBase * 10000) / 100 : 0;
        $("dayProfit").textContent = (dayPnl > 0 ? "+" : "") + money(dayPnl);
        $("dayProfit").className = profitClass(dayPnl);
        $("dayRate").textContent = (dayRate > 0 ? "+" : "") + percent(dayRate);
        $("dayRate").className = profitClass(dayRate);
    } else {
        $("dayProfit").textContent = "—"; $("dayProfit").className = "";
        $("dayRate").textContent = "—"; $("dayRate").className = "";
    }

    const visible = all.filter(g => filter === "all" || g.code === filter);
    if (!visible.length) {
        const tr = document.createElement("tr");
        tr.innerHTML = '<td colspan="7"><div class="empty-state">🌱 目前還沒有交易紀錄，新增一筆買入開始追蹤吧！</div></td>';
        list.appendChild(tr); return;
    }
    visible.forEach(g => {
        const ratio = g.totalBuyCost > 0 ? g.profit / g.totalBuyCost * 100 : 0;
        const open = expandedStocks.has(g.code);
        const tr = document.createElement("tr");
        tr.className = "stock-row";
        tr.innerHTML = `
            <td><button class="detail-btn" data-action="toggle" data-code="${esc(g.code)}">${open ? "收合 ▲" : "明細 ▼"}</button></td>
            <td class="stock-name">${esc(g.code)} ${esc(g.name)}</td>
            <td>${money(g.shares)}</td>
            <td>${money(g.cost)}</td>
            <td>${money(g.value)}</td>
            <td class="${profitClass(g.profit)}">${g.profit > 0 ? "+" : ""}${money(g.profit)}</td>
            <td class="${profitClass(ratio)}">${percent(ratio)}</td>`;
        list.appendChild(tr);
        if (open) list.appendChild(createDetailRow(g));
    });
}
function createDetailRow(group) {
    const row = document.createElement("tr");
    row.className = "detail-row";
    const cell = document.createElement("td"); cell.colSpan = 7;
    const title = document.createElement("div"); title.className = "detail-title";
    title.textContent = `${group.code} ${group.name}｜買入／賣出交易明細`;
    const hint = document.createElement("p"); hint.className = "table-hint";
    hint.textContent = "成本均價含手續費：買入為該筆買入均價，賣出為先進先出（FIFO）對應的成本均價。買入單筆損益為未實現損益；刪除歷史交易可能影響後續賣出的成本與損益。";
    const wrap = document.createElement("div"); wrap.className = "detail-table table-wrap";
    const table = document.createElement("table");
    table.innerHTML = `<thead><tr><th>日期</th><th>買入／賣出</th><th>股數</th><th>成交價</th><th>成本均價</th><th>現價</th><th>手續費</th><th>單筆獲益金額</th><th>單筆獲益百分比</th><th>操作</th></tr></thead><tbody></tbody>`;
    const tbody = table.querySelector("tbody");
    const items = [...group.items].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    const ledger = getLedger(group.code);
    const current = currentPrices[group.code] ?? 0;

    items.forEach(item => {
        const isBuy = item.type === "buy";
        const info = ledger.details?.[item.id] || { realizedProfit: 0, costBasis: 0 };
        const avgCost = info.costBasis > 0 ? info.costBasis / item.qty : 0;
        let profit, ratio;
        if (isBuy) {
            const buyCost = item.price * item.qty + (Number(item.fee) || 0);
            profit = current * item.qty - buyCost;
            ratio = buyCost > 0 ? profit / buyCost * 100 : 0;
        } else {
            profit = info.realizedProfit;
            ratio = info.costBasis > 0 ? profit / info.costBasis * 100 : 0;
        }
        const tr = document.createElement("tr");
        tr.innerHTML = `<td></td>
            <td><span class="type-badge ${isBuy ? "type-buy" : "type-sell"}">${isBuy ? "🟢 買入" : "🌸 賣出"}</span></td>
            <td>${money(item.qty)}</td>
            <td>${money(item.price)}</td>
            <td>${avgCost > 0 ? money(avgCost) : "-"}</td>
            <td>${current > 0 ? money(current) : "-"}</td>
            <td></td>
            <td class="${profitClass(profit)}">${profit > 0 ? "+" : ""}${money(profit)}</td>
            <td class="${profitClass(ratio)}">${percent(ratio)}</td>
            <td><button class="delete-btn" data-action="delete" data-id="${item.id}" data-code="${esc(group.code)}">刪除</button></td>`;

        const dateInput = document.createElement("input");
        dateInput.type = "date"; dateInput.className = "date-input"; dateInput.value = item.date;
        dateInput.setAttribute("aria-label", "交易日期");
        dateInput.addEventListener("change", () => {
            if (!dateInput.value) { alert("日期不可空白"); dateInput.value = item.date; return; }
            const oldDate = item.date; item.date = dateInput.value;
            if (!getLedger(group.code).valid) {
                item.date = oldDate;
                alert("修改日期後會造成賣出時持股不足，已取消這次修改。");
            } else persist();
            renderStocks();
        });

        const feeInput = document.createElement("input");
        feeInput.type = "number"; feeInput.min = "0"; feeInput.step = "any";
        feeInput.value = String(Number(item.fee) || 0);
        feeInput.className = "fee-input";
        feeInput.setAttribute("aria-label", "手續費");
        feeInput.addEventListener("change", () => {
            const newFee = feeInput.value.trim() === "" ? 0 : Number(feeInput.value);
            if (!Number.isFinite(newFee) || newFee < 0) {
                alert("手續費不可小於 0");
                feeInput.value = String(Number(item.fee) || 0);
                return;
            }
            const oldFee = Number(item.fee) || 0;
            item.fee = newFee;
            if (!getLedger(group.code).valid) {
                item.fee = oldFee; feeInput.value = String(oldFee);
                alert("修改手續費後資料檢查未通過，已取消修改。");
                return;
            }
            renderStocks();
            persist();
        });

        tr.children[0].appendChild(dateInput);
        tr.children[6].appendChild(feeInput);   // 手續費欄位位置已改為第 7 欄（index 6）
        tbody.appendChild(tr);
    });
    wrap.appendChild(table); cell.append(title, hint, wrap); row.appendChild(cell);
    return row;
}

/* ============ 10. 事件綁定 ============ */
$("loginBtn").addEventListener("click", login);
$("connectBtn").addEventListener("click", login);
$("logoutBtn").addEventListener("click", logout);
$("logoutBtn2").addEventListener("click", logout);
$("changeSheetBtn").addEventListener("click", changeSheet);
$("addBtn").addEventListener("click", addTransaction);
$("refreshBtn").addEventListener("click", refreshPrices);
$("autoRefresh").addEventListener("change", setAutoRefresh);
$("stockFilter").addEventListener("change", renderStocks);
$("transactionType").addEventListener("change", handleTypeChange);
$("stockKeyword").addEventListener("input", () => { selectedStock = null; searchStock(); });
document.addEventListener("click", e => { if (!e.target.closest(".search-box")) $("searchResult").style.display = "none"; });

$("stockList").addEventListener("click", event => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const { action, code } = button.dataset;
    if (action === "toggle") {
        expandedStocks.has(code) ? expandedStocks.delete(code) : expandedStocks.add(code);
        renderStocks(); return;
    }
    if (action === "delete") {
        const id = Number(button.dataset.id);
        const item = transactions.find(t => t.id === id);
        if (!item) return;
        if (!confirm(`確定刪除 ${item.code} ${item.name} 的這筆${item.type === "buy" ? "買入" : "賣出"}交易嗎？`)) return;
        transactions = transactions.filter(t => t.id !== id);
        if (!getLedger(code).valid) alert("刪除後資料仍有持股不足問題，請檢查交易日期與順序。");
        if (!transactions.some(t => t.code === code)) { delete currentPrices[code]; delete prevCloses[code]; delete quoteDates[code]; expandedStocks.delete(code); }
        updateFilterOptions(); renderStocks(); persist();
    }
});

$("tradeDate").value = todayString();
handleTypeChange();
updateFilterOptions();
renderStocks();
setView();