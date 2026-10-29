import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut }
    from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp }
    from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/* ============ 1. 設定 ============ */
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
const SNAP_TAB = "持股總表紀錄";
const HEADER = ["id", "日期", "類型", "代碼", "名稱", "成交價", "股數", "手續費"];
const SNAP_HEADER = ["日期", "範圍", "代碼", "名稱", "持有股數", "剩餘持股成本", "當前總價值", "累計獲益金額", "獲益百分比"];
const SCOPE_ALL = "含已賣出";
const SCOPE_HELD = "未含已賣出";

// 你自己的 Cloudflare Worker（股票清單在根路徑；/quote 盤中即時、/close 收盤資料，見 worker.js）
const WORKER_URL = "https://stock-api.icreamling.workers.dev";
const PRICE_CONFIG = {
    workerUrl: WORKER_URL,
    finmindToken: "",   // 選填：FinMind token
    corsProxies: [      // Worker 的 /quote 失敗時的備援
        u => "https://corsproxy.io/?url=" + encodeURIComponent(u),
        u => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u)
    ]
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

const $ = id => document.getElementById(id);
const enc = encodeURIComponent;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;

/* ============ 2. 狀態 ============ */
let stockMaster = [];
let user = null;
let accessToken = null;     // 只存在記憶體，重新整理後需重新連線
let sheetId = null;
let initing = false;
let selectedStock = null;
let transactions = [];
let snapshots = [];         // 每日快照（來自「持股總表紀錄」分頁）
let currentPrices = {}, prevCloses = {}, quoteDates = {};
let nextId = 1;
let saveChain = Promise.resolve();
let refreshing = false, autoTimer = null, lastSnapWrite = 0;
const expandedStocks = new Set();
const TOKEN_KEY = "stock_gtoken";
const TOKEN_TTL = 55 * 60 * 1000;   // Google token 約 1 小時，提早 5 分鐘作廢

/* ============ 3. 畫面狀態與頁籤 ============ */
const TABS = ["summary", "trade", "list", "chart"];
function setView() {
    const ready = !!(user && accessToken && sheetId);
    const showApp = ready && !initing;
    $("loginCard").hidden = !!user;
    $("heroCard").hidden = showApp;
    $("loadingCard").hidden = !(user && initing);
    $("connectCard").hidden = !(user && !initing && !ready);
    $("appRoot").hidden = !showApp;
    $("navMenu").hidden = !showApp;
    document.body.classList.toggle("has-menu", showApp);
    if (showApp) renderChart();
}
function showTab(name) {
    if (!TABS.includes(name)) name = "summary";
    TABS.forEach(t => { $("panel-" + t).hidden = t !== name; });
    document.querySelectorAll(".nav-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
    window.scrollTo({ top: 0 });
    try { history.replaceState(null, "", "#" + name); } catch { }
    if (name === "chart") renderChart();
}
function setSync(msg, isError = false) {
    $("syncStatus").textContent = msg;
    $("syncStatus").className = "sync-status" + (isError ? " error" : "");
}

/* ============ 4. 登入 / 登出 ============ */
function saveToken(token) {
    try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token, uid: user?.uid, exp: Date.now() + TOKEN_TTL })); } catch { }
}
function loadToken(uid) {
    try {
        const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || "null");
        if (t && t.uid === uid && t.exp > Date.now()) return t.token;
    } catch { }
    clearToken();
    return null;
}
function clearToken() {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { }
}
async function login() {
    try {
        const provider = new GoogleAuthProvider();
        provider.addScope(DRIVE_SCOPE);
        const result = await signInWithPopup(auth, provider);
        user = result.user;
        accessToken = GoogleAuthProvider.credentialFromResult(result)?.accessToken || null;
        if (accessToken) { saveToken(accessToken); await init(); } else setView();
    } catch (e) {
        if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
            alert("登入失敗：" + e.message);
        }
    }
}
async function logout() { await signOut(auth); }
onAuthStateChanged(auth, u => {
    user = u;
    if (!u) {
        clearToken();
        accessToken = null; sheetId = null; transactions = []; snapshots = [];
        currentPrices = {}; prevCloses = {}; quoteDates = {}; lastSnapWrite = 0;
        expandedStocks.clear(); clearInterval(autoTimer); $("autoRefresh").value = "0";
        $("chartStock").dataset.sig = "";
        updateFilterOptions(); renderStocks();
    } else {
        $("userName").textContent = u.displayName || u.email || "已登入";
        // 重新整理後，用暫存的 token 直接連回試算表
        if (!accessToken) accessToken = loadToken(u.uid);
        if (accessToken && !sheetId && !initing) { setView(); init(); return; }
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
        accessToken = null; clearToken(); setView();
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
            sheets: [{ properties: { title: SHEET_TAB } }, { properties: { title: SNAP_TAB } }]
        })
    });
    return j.spreadsheetId;
}

// 舊版試算表沒有快照分頁時，自動補上
async function ensureSnapTab(id) {
    const meta = await sheets(`/${id}?fields=sheets.properties.title`);
    const has = (meta.sheets || []).some(s => s.properties?.title === SNAP_TAB);
    if (!has) {
        await sheets(`/${id}:batchUpdate`, {
            method: "POST",
            body: JSON.stringify({ requests: [{ addSheet: { properties: { title: SNAP_TAB } } }] })
        });
    }
}

async function useSheet(id) {
    await ensureSnapTab(id);
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
    })).filter(t => t.id > 0 && t.date && t.code && t.price > 0 && t.qty > 0);

    const snapData = await sheets(`/${id}/values/${enc(SNAP_TAB + "!A2:I")}`);
    const snaps = (snapData.values || []).map(r => ({
        date: String(r[0] || ""), scope: String(r[1] || ""), code: String(r[2] || ""), name: String(r[3] || ""),
        shares: Number(r[4]) || 0, cost: Number(r[5]) || 0, value: Number(r[6]) || 0,
        profit: Number(r[7]) || 0, ratio: Number(r[8]) || 0
    })).filter(s => s.date && s.code && (s.scope === SCOPE_ALL || s.scope === SCOPE_HELD));

    transactions = rows;
    snapshots = snaps;
    nextId = rows.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    sheetId = id;
    $("chartStock").dataset.sig = "";
    $("sheetLink").href = "https://docs.google.com/spreadsheets/d/" + id;
    setSync("✅ 已與試算表同步");
    updateFilterOptions();
    renderStocks();
}

async function writeSheet() {
    const rows = transactions.map(t => [
        t.id, t.date, t.type === "buy" ? "買入" : "賣出", t.code, t.name, t.price, t.qty, Number(t.fee) || 0
    ]);
    await sheets(`/${sheetId}/values/${enc(SHEET_TAB)}:clear`, { method: "POST", body: "{}" });
    await sheets(`/${sheetId}/values/${enc(SHEET_TAB + "!A1")}?valueInputOption=RAW`, {
        method: "PUT", body: JSON.stringify({ values: [HEADER, ...rows] })
    });
}
async function writeSnapshots() {
    const rows = snapshots.map(s => [s.date, s.scope, s.code, s.name, s.shares, s.cost, s.value, s.profit, s.ratio]);
    await sheets(`/${sheetId}/values/${enc(SNAP_TAB)}:clear`, { method: "POST", body: "{}" });
    await sheets(`/${sheetId}/values/${enc(SNAP_TAB + "!A1")}?valueInputOption=RAW`, {
        method: "PUT", body: JSON.stringify({ values: [SNAP_HEADER, ...rows] })
    });
}

// 所有寫入都串成佇列，避免連續操作時互相覆蓋
function persist() {
    setSync("儲存中…");
    saveChain = saveChain.then(writeSheet).then(
        () => setSync("✅ 已同步 " + new Date().toLocaleTimeString("zh-TW", { hour12: false })),
        e => setSync("⚠️ 儲存失敗：" + e.message, true)
    );
    return saveChain;
}
function persistSnapshots() {
    saveChain = saveChain.then(writeSnapshots).then(
        () => { lastSnapWrite = Date.now(); },
        e => setSync("⚠️ 快照儲存失敗：" + e.message, true)
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
        try { await loadStockMaster(); }
        catch (e) { console.warn(e); alert("股票清單載入失敗，暫時無法搜尋股票：" + e.message); }
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
const signed = v => (v > 0 ? "+" : "") + money(v);

function handleTypeChange() {
    const selling = $("transactionType").value === "sell";
    $("tradePriceLabel").textContent = selling ? "賣出成交價" : "買入價格";
    $("tradePrice").placeholder = selling ? "請輸入賣出成交價" : "請輸入買入價格";
    $("transactionHint").textContent = selling
        ? "賣出會減少持股。系統會檢查該交易日期當下是否有足夠股數，並以先進先出（FIFO）計算已實現損益。"
        : "買入會增加持股與成本（含手續費）；目前股價由股價更新功能自動取得。";
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

async function loadStockMaster() {
    const response = await fetch(WORKER_URL + "/");
    if (!response.ok) throw new Error(`股票清單 API 失敗：HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error("股票清單 API 回傳格式不是陣列");
    stockMaster = data;
}

/* FIFO 先進先出法
 * 買入：建立一批持股，成本包含買入手續費
 * 賣出：先扣除最早買入的持股；損益＝賣出金額 − FIFO 成本 − 賣出手續費
 * 同日交易依 id 順序處理
 */
function getLedger(code) {
    const items = transactions.filter(t => t.code === code)
        .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    const lots = [];
    let shares = 0, cost = 0, realized = 0;
    const details = {};

    for (const t of items) {
        const fee = Math.max(0, Number(t.fee) || 0);
        if (t.type === "buy") {
            const buyCost = t.price * t.qty + fee;
            lots.push({ id: t.id, shares: t.qty, unitCost: buyCost / t.qty });
            shares += t.qty; cost += buyCost;
            details[t.id] = { realizedProfit: 0, costBasis: buyCost, fee, soldShares: 0 };
        } else {
            if (shares <= 0 || t.qty > shares) return { valid: false, shares, cost, realized, details };
            let remaining = t.qty, costBasis = 0;
            while (remaining > 0) {
                const lot = lots[0];
                if (!lot) return { valid: false, shares, cost, realized, details };
                const used = Math.min(remaining, lot.shares);
                costBasis += used * lot.unitCost;
                if (details[lot.id]) details[lot.id].soldShares += used;
                lot.shares -= used; remaining -= used;
                if (lot.shares <= 0) lots.shift();
            }
            const profit = t.price * t.qty - costBasis - fee;
            shares -= t.qty; cost -= costBasis; realized += profit;
            if (Math.abs(shares) < 1e-8) { shares = 0; cost = 0; lots.length = 0; }
            details[t.id] = { realizedProfit: profit, costBasis, fee, soldShares: t.qty };
        }
    }
    return { valid: true, shares, cost: Math.max(0, cost), realized, details };
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
    if (!Number.isFinite(fee) || fee < 0) { alert("手續費不可小於 0"); return; }

    const candidate = { id: nextId, code, name: selectedStock.name, type, date, price, qty, fee };
    const check = validateLedgerForCode(code, candidate);
    if (!check.valid) {
        alert(`這筆賣出會造成持股不足！\n依交易日期與順序，賣出前可用股數為 ${money(check.shares)} 股，不能賣出 ${money(qty)} 股。`);
        return;
    }
    nextId++;
    transactions.push(candidate);
    $("stockKeyword").value = ""; $("tradePrice").value = ""; $("qty").value = ""; $("tradeFee").value = "0";
    $("tradeDate").value = todayString();
    selectedStock = null;

    updateFilterOptions(); renderStocks(); handleTypeChange();
    persist();
    refreshPrices();
}

/* ============ 8. 股價：兩支 API（盤中即時／收盤資料） ============ */
function taipeiNow() {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Taipei", hour12: false, weekday: "short",
        hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date());
    const o = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return { weekday: o.weekday, minutes: (Number(o.hour) % 24) * 60 + Number(o.minute), date: `${o.year}-${o.month}-${o.day}` };
}
// 盤中：週一至週五 09:00–13:35（多留幾分鐘等收盤試算價）
function isMarketOpen() {
    const t = taipeiNow();
    return t.weekday !== "Sat" && t.weekday !== "Sun" && t.minutes >= 540 && t.minutes <= 815;
}
// 收盤資料沒有日期欄位時，推測最近一個交易日（不含國定假日判斷）
function guessTradingDate() {
    const t = taipeiNow();
    const d = new Date(t.date + "T00:00:00Z");
    const day = d.getUTCDay();
    const todayOk = day >= 1 && day <= 5 && t.minutes >= 540;
    if (!todayOk) {
        do { d.setUTCDate(d.getUTCDate() - 1); } while ([0, 6].includes(d.getUTCDay()));
    }
    return d.toISOString().slice(0, 10);
}

async function fetchJson(url, ms = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
    } finally { clearTimeout(timer); }
}

// API ①：證交所即時行情（盤中用）。成交價 → 最佳買價 → 昨收
function parseMis(json) {
    const quotes = {};
    (json.msgArray || []).forEach(item => {
        const prev = parseFloat(item.y);
        let p = parseFloat(item.z);
        if (!(p > 0)) p = parseFloat((item.b || "").split("_")[0]);
        if (!(p > 0)) p = prev;
        if (!(p > 0)) return;
        const d = String(item.d || "");
        quotes[item.c] = {
            price: p,
            prev: prev > 0 ? prev : null,
            date: /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null
        };
    });
    return quotes;
}
async function fetchRealtime(codes) {
    const exCh = codes.flatMap(c => ["tse_" + c + ".tw", "otc_" + c + ".tw"]).join("|");
    const target = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&json=1&delay=0&_=${Date.now()}`;
    const attempts = [];
    if (PRICE_CONFIG.workerUrl) attempts.push(() => fetchJson(`${PRICE_CONFIG.workerUrl}/quote?ex_ch=${enc(exCh)}`));
    PRICE_CONFIG.corsProxies.forEach(p => attempts.push(() => fetchJson(p(target))));
    for (const run of attempts) {
        try {
            const quotes = parseMis(await run());
            if (Object.keys(quotes).length) return quotes;
        } catch (e) { console.warn("即時行情來源失敗：", e.message); }
    }
    return {};
}

// API ②：證交所／櫃買中心每日收盤資料（經你的 Worker /close）
async function fetchClose(codes) {
    if (!PRICE_CONFIG.workerUrl) return {};
    try {
        const j = await fetchJson(`${PRICE_CONFIG.workerUrl}/close?codes=${enc(codes.join(","))}`);
        const date = guessTradingDate();
        const out = {};
        codes.forEach(c => {
            const q = j[c];
            if (q && q.price > 0) out[c] = { price: Number(q.price), prev: q.prev > 0 ? Number(q.prev) : null, date };
        });
        return out;
    } catch (e) { console.warn("收盤資料來源失敗：", e.message); return {}; }
}

// 最後備援：FinMind 日資料
async function fetchFinMind(codes) {
    const out = {};
    for (const code of codes) {
        try {
            const start = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
            let url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${code}&start_date=${start}`;
            if (PRICE_CONFIG.finmindToken) url += "&token=" + PRICE_CONFIG.finmindToken;
            const rows = (await fetchJson(url)).data || [];
            const last = rows.at(-1), before = rows.at(-2);
            if (last && last.close > 0) {
                out[code] = { price: Number(last.close), prev: before && before.close > 0 ? Number(before.close) : null, date: last.date || null };
            }
        } catch (e) { console.warn("FinMind 失敗：", code, e.message); }
    }
    return out;
}

const SOURCE_LABEL = { mis: "即時行情", close: "收盤資料", finmind: "FinMind 日收盤" };

async function refreshPrices() {
    if (refreshing) return;
    const codes = [...new Set(transactions.map(t => t.code))];
    const status = $("priceStatus");
    if (!codes.length) { status.className = "price-status"; status.textContent = "請先新增交易紀錄"; return; }
    refreshing = true;
    $("refreshBtn").disabled = true;
    status.className = "price-status"; status.textContent = "更新中…";

    // 盤中先用即時行情；非盤中先用收盤資料。失敗再換另一支，最後才用 FinMind
    const order = isMarketOpen() ? ["mis", "close", "finmind"] : ["close", "mis", "finmind"];
    const fetchers = { mis: fetchRealtime, close: fetchClose, finmind: fetchFinMind };
    const quotes = {}, used = new Set();
    for (const src of order) {
        const need = codes.filter(c => !quotes[c]);
        if (!need.length) break;
        const got = await fetchers[src](need);
        Object.entries(got).forEach(([c, q]) => { quotes[c] = q; used.add(src); });
    }

    Object.entries(quotes).forEach(([code, q]) => {
        currentPrices[code] = q.price;
        if (q.prev) prevCloses[code] = q.prev;
        if (q.date) quoteDates[code] = q.date;
    });
    const failed = codes.filter(c => !quotes[c]);
    renderStocks();
    if (!failed.length) maybeSaveSnapshot();

    const time = new Date().toLocaleTimeString("zh-TW", { hour12: false });
    const labels = [...used].map(s => SOURCE_LABEL[s]).join("、");
    if (failed.length) {
        status.className = "price-status error";
        status.textContent = `⚠️ ${time} 更新 ${codes.length - failed.length}/${codes.length} 檔，失敗：${failed.join("、")}（沿用舊股價）`;
    } else {
        status.textContent = `✅ ${time} 已更新 ${codes.length} 檔｜來源：${labels}`;
    }
    $("refreshBtn").disabled = false;
    refreshing = false;
}
function setAutoRefresh() {
    clearInterval(autoTimer);
    const ms = Number($("autoRefresh").value);
    if (ms > 0) {
        autoTimer = setInterval(() => { if (isMarketOpen()) refreshPrices(); }, ms);
        refreshPrices();
    }
}

/* ============ 9. 持股總表與每日快照 ============ */
function groupStocks() {
    const groups = {};
    [...new Set(transactions.map(t => t.code))].forEach(code => {
        const items = transactions.filter(t => t.code === code);
        const ledger = getLedger(code);
        const current = currentPrices[code] ?? 0;
        const value = ledger.shares * current;
        const unrealized = value - ledger.cost;

        // 當日損益：以行情日期為界，之前的持股用昨收當基準，當日交易用成交價
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
            proceeds: items.filter(t => t.type === "sell").reduce((s, t) => s + t.price * t.qty - (Number(t.fee) || 0), 0),
            totalBuyCost: items.filter(t => t.type === "buy").reduce((s, t) => s + t.price * t.qty + (Number(t.fee) || 0), 0)
        };
    });
    return groups;
}

function buildSnapshotRows(date) {
    const groups = Object.values(groupStocks()).sort((a, b) => a.code.localeCompare(b.code));
    const held = groups.filter(g => g.shares > 0);
    const rows = [];
    const add = (scope, code, name, shares, cost, value, profit, base) => rows.push({
        date, scope, code, name, shares: r2(shares), cost: r2(cost), value: r2(value),
        profit: r2(profit), ratio: base > 0 ? r2(profit / base * 100) : 0
    });
    const sum = (list, f) => list.reduce((s, g) => s + f(g), 0);

    // 含已賣出：把賣掉的部分也算進帳裡
    //   成本＝累計買入成本；總價值＝持股市值＋賣出實收金額；獲益＝總價值 − 成本（＝已實現＋未實現）
    groups.forEach(g => add(SCOPE_ALL, g.code, g.name, g.shares, g.totalBuyCost, g.value + g.proceeds, g.profit, g.totalBuyCost));
    add(SCOPE_ALL, "ALL", "全部合計", sum(groups, g => g.shares), sum(groups, g => g.totalBuyCost),
        sum(groups, g => g.value + g.proceeds), sum(groups, g => g.profit), sum(groups, g => g.totalBuyCost));
    // 未含已賣出：只看目前持有，獲益＝未實現損益
    held.forEach(g => add(SCOPE_HELD, g.code, g.name, g.shares, g.cost, g.value, g.unrealized, g.cost));
    add(SCOPE_HELD, "ALL", "全部合計", sum(held, g => g.shares), sum(held, g => g.cost), sum(held, g => g.value),
        sum(held, g => g.unrealized), sum(held, g => g.cost));
    return rows;
}
const rowsSig = rows => rows
    .map(r => [r.date, r.scope, r.code, r.shares, r2(r.cost), r2(r.value), r2(r.profit), r2(r.ratio)].join("|"))
    .sort().join("\n");

function maybeSaveSnapshot() {
    if (!sheetId) return;
    const groups = Object.values(groupStocks());
    if (!groups.length) return;
    const heldGroups = groups.filter(g => g.shares > 0);
    if (heldGroups.some(g => !(currentPrices[g.code] > 0))) return;   // 沒有股價就不寫，避免寫入 0

    const date = heldGroups.map(g => quoteDates[g.code]).filter(Boolean).sort().at(-1) || todayString();
    const rows = buildSnapshotRows(date);
    const old = snapshots.filter(s => s.date === date);
    if (rowsSig(old) === rowsSig(rows)) return;                       // 沒變就不寫
    if (isMarketOpen() && Date.now() - lastSnapWrite < 300000) return; // 盤中最多每 5 分鐘寫一次

    snapshots = snapshots.filter(s => s.date !== date).concat(rows)
        .sort((a, b) => a.date.localeCompare(b.date) || a.scope.localeCompare(b.scope) || a.code.localeCompare(b.code));
    renderChart();
    persistSnapshots();
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
    $("totalProfit").textContent = signed(totalProfit);
    $("totalProfit").className = profitClass(totalProfit);

    const dayList = all.filter(g => g.dayPnl !== null);
    if (dayList.length) {
        const dayPnl = r2(dayList.reduce((s, g) => s + g.dayPnl, 0));
        const dayBase = dayList.reduce((s, g) => s + g.dayBase, 0);
        const dayRate = dayBase > 0 ? r2(dayPnl / dayBase * 100) : 0;
        $("dayProfit").textContent = signed(dayPnl);
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
        tr.innerHTML = '<td colspan="9"><div class="empty-state">🌱 目前還沒有交易紀錄，新增一筆買入開始追蹤吧！</div></td>';
        list.appendChild(tr); return;
    }
    visible.forEach(g => {
        const ratio = g.totalBuyCost > 0 ? g.profit / g.totalBuyCost * 100 : 0;
        const hasDay = g.dayPnl !== null;
        const dayRate = hasDay && g.dayBase > 0 ? g.dayPnl / g.dayBase * 100 : 0;
        const open = expandedStocks.has(g.code);
        const tr = document.createElement("tr");
        tr.className = "stock-row";
        tr.innerHTML = `
            <td><button class="detail-btn" data-action="toggle" data-code="${esc(g.code)}">${open ? "收合 ▲" : "明細 ▼"}</button></td>
            <td class="stock-name">${esc(g.code)} ${esc(g.name)}</td>
            <td>${money(g.shares)}</td>
            <td>${money(g.cost)}</td>
            <td>${money(g.value)}</td>
            <td class="${hasDay ? profitClass(g.dayPnl) : ""}">${hasDay ? signed(r2(g.dayPnl)) : "—"}</td>
            <td class="${hasDay ? profitClass(dayRate) : ""}">${hasDay ? (dayRate > 0 ? "+" : "") + percent(dayRate) : "—"}</td>
            <td class="${profitClass(g.profit)}">${signed(g.profit)}</td>
            <td class="${profitClass(ratio)}">${percent(ratio)}</td>`;
        list.appendChild(tr);
        if (open) list.appendChild(createDetailRow(g));
    });
}

function createDetailRow(group) {
    const row = document.createElement("tr");
    row.className = "detail-row";
    const cell = document.createElement("td"); cell.colSpan = 9;
    const title = document.createElement("div"); title.className = "detail-title";
    title.textContent = `${group.code} ${group.name}｜買入／賣出交易明細`;
    const hint = document.createElement("p"); hint.className = "table-hint";
    hint.textContent = "付出成本＝股數 × 成本均價（含手續費）。賣出的成本均價為先進先出（FIFO）對應的買入成本。買入單筆損益為未實現損益；刪除歷史交易可能影響後續賣出的成本與損益。";
    const wrap = document.createElement("div"); wrap.className = "detail-table table-wrap";
    const table = document.createElement("table");
    table.innerHTML = `<thead><tr><th>日期</th><th>買入／賣出</th><th>股數</th><th>成交價</th><th>成本均價</th><th>付出成本</th><th>現價</th><th>手續費</th><th>單筆獲益金額</th><th>單筆獲益百分比</th><th>操作</th></tr></thead><tbody></tbody>`;
    const tbody = table.querySelector("tbody");
    const items = [...group.items].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    const ledger = getLedger(group.code);
    const current = currentPrices[group.code] ?? 0;

    items.forEach(item => {
        const isBuy = item.type === "buy";
        const info = ledger.details?.[item.id];
        const paid = info ? info.costBasis : 0;                 // 付出成本
        const avgCost = paid > 0 ? paid / item.qty : 0;         // 成本均價
        const left = isBuy ? item.qty - (info?.soldShares || 0) : 0;   // 這批還剩幾股
        let profit, ratio;
        if (isBuy) {
            profit = left > 0 && current > 0 ? (current - avgCost) * left : 0;
            ratio = left > 0 && avgCost > 0 ? profit / (avgCost * left) * 100 : 0;
        } else {
            profit = info ? info.realizedProfit : 0;
            ratio = paid > 0 ? profit / paid * 100 : 0;
        }
        const leftTag = isBuy && left < item.qty
            ? `<span class="left-tag ${left > 0 ? "" : "sold-out"}">${left > 0 ? `剩 ${money(left)} 股` : "已全數賣出"}</span>`
            : "";
        const tr = document.createElement("tr");
        tr.innerHTML = `<td></td>
            <td><span class="type-badge ${isBuy ? "type-buy" : "type-sell"}">${isBuy ? "🟢 買入" : "🌸 賣出"}</span></td>
            <td>${money(item.qty)}${leftTag}</td>
            <td>${money(item.price)}</td>
            <td>${avgCost > 0 ? money(avgCost) : "-"}</td>
            <td>${paid > 0 ? money(paid) : "-"}</td>
            <td>${isBuy && current > 0 ? money(current) : "-"}</td>
            <td></td>
            <td class="${profitClass(profit)}">${signed(profit)}</td>
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
        tr.children[7].appendChild(feeInput);   // 手續費欄＝第 8 欄（index 7）
        tbody.appendChild(tr);
    });
    wrap.appendChild(table); cell.append(title, hint, wrap); row.appendChild(cell);
    return row;
}

/* ============ 10. 折線圖（純 SVG，不需外部套件） ============ */
const METRIC_LABEL = { profit: "累計獲益金額", ratio: "獲益百分比", value: "當前總價值", cost: "剩餘持股成本" };
const SERIES = [
    { scope: SCOPE_ALL, fill: "#F2A497", line: "#F2A497", dash: "" },
    { scope: SCOPE_HELD, fill: "#A8D3E6", line: "#5CB6DC", dash: "9 6" }
];
const EMPTY_CHART = `<div class="empty-state">
    <svg viewBox="0 0 100 100" width="90" height="90" aria-hidden="true">
        <rect x="10" y="14" width="80" height="68" rx="12" fill="#fff" stroke="#3E3A39" stroke-width="3" />
        <circle cx="38" cy="44" r="3.5" fill="#3E3A39" /><circle cx="62" cy="44" r="3.5" fill="#3E3A39" />
        <path d="M38 62 Q50 52 62 62" fill="none" stroke="#3E3A39" stroke-width="3.5" stroke-linecap="round" />
        <path d="M30 90 H70" stroke="#3E3A39" stroke-width="3" stroke-linecap="round" />
    </svg><br>還沒有快照紀錄喔～<br>到「持股列表」更新一次股價，就會自動記錄今天的數字。</div>`;

function updateChartOptions() {
    const sel = $("chartStock");
    const old = sel.value || "ALL";
    const names = new Map();
    snapshots.forEach(s => { if (s.code !== "ALL") names.set(s.code, s.name); });
    const codes = [...names.keys()].sort();
    const sig = codes.join(",");
    if (sel.dataset.sig === sig) return;
    sel.dataset.sig = sig;
    sel.innerHTML = '<option value="ALL">全部合計</option>';
    codes.forEach(c => {
        const o = document.createElement("option");
        o.value = c; o.textContent = c + " " + names.get(c);
        sel.appendChild(o);
    });
    sel.value = (old === "ALL" || names.has(old)) ? old : "ALL";
}

function niceScale(min, max, count = 5) {
    if (min === max) { const p = Math.abs(min) || 1; min -= p * 0.5; max += p * 0.5; }
    const rough = (max - min) / (count - 1);
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const n = Math.round((hi - lo) / step);
    const ticks = Array.from({ length: n + 1 }, (_, i) => Math.round((lo + i * step) * 1e6) / 1e6);
    return { lo, hi, ticks };
}
function axisFmt(v, metric) {
    if (metric === "ratio") return (Math.round(v * 100) / 100) + "%";
    const a = Math.abs(v);
    if (a >= 1e8) return (v / 1e8).toFixed(1).replace(/\.0$/, "") + "億";
    if (a >= 1e4) return (v / 1e4).toFixed(1).replace(/\.0$/, "") + "萬";
    return money(v);
}
const valFmt = (metric, v) => metric === "ratio" ? (v > 0 ? "+" : "") + percent(v) : metric === "profit" ? signed(v) : money(v);

function renderChart() {
    if ($("panel-chart").hidden || $("appRoot").hidden) return;
    updateChartOptions();
    const box = $("chartBox");
    const code = $("chartStock").value || "ALL";
    const metric = $("chartMetric").value;
    const days = Number($("chartRange").value);
    const cutoff = days > 0 ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : "";

    const rows = snapshots.filter(s => s.code === code && (!cutoff || s.date >= cutoff));
    const dates = [...new Set(rows.map(s => s.date))].sort();
    if (!dates.length) { box.innerHTML = EMPTY_CHART; return; }

    const map = new Map(rows.map(r => [r.scope + "|" + r.date, r]));
    const series = SERIES.map(s => ({ ...s, data: dates.map(d => map.get(s.scope + "|" + d)?.[metric] ?? null) }));
    const vals = series.flatMap(s => s.data).filter(v => v !== null);
    if (!vals.length) { box.innerHTML = EMPTY_CHART; return; }

    let min = Math.min(...vals), max = Math.max(...vals);
    if (metric === "profit" || metric === "ratio") { min = Math.min(min, 0); max = Math.max(max, 0); }
    const { lo, hi, ticks } = niceScale(min, max);

    const W = Math.max(300, Math.min(960, box.clientWidth - 12 || 700));
    const H = W < 500 ? 280 : 340;
    const L = W < 500 ? 52 : 66, R = 18, T = 18, B = 40;
    const n = dates.length;
    const x = i => n === 1 ? (L + W - R) / 2 : L + i * (W - L - R) / (n - 1);
    const y = v => T + (hi - v) / (hi - lo) * (H - T - B);

    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${METRIC_LABEL[metric]}折線圖">`;
    ticks.forEach(t => {
        svg += `<line x1="${L}" y1="${y(t)}" x2="${W - R}" y2="${y(t)}" stroke="#E7E0D5" stroke-width="1.5" stroke-dasharray="4 4"/>`;
        svg += `<text x="${L - 8}" y="${y(t) + 4}" text-anchor="end" font-size="12" fill="#756D66">${esc(axisFmt(t, metric))}</text>`;
    });
    if (lo < 0 && hi > 0) svg += `<line x1="${L}" y1="${y(0)}" x2="${W - R}" y2="${y(0)}" stroke="#3E3A39" stroke-width="2"/>`;
    svg += `<line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" stroke="#3E3A39" stroke-width="2"/>`;
    svg += `<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#3E3A39" stroke-width="2"/>`;

    const labelCount = Math.min(n, W < 500 ? 4 : 6);
    const idxs = [...new Set(Array.from({ length: labelCount }, (_, k) => labelCount === 1 ? 0 : Math.round(k * (n - 1) / (labelCount - 1))))];
    idxs.forEach(i => {
        svg += `<text x="${x(i)}" y="${H - B + 20}" text-anchor="middle" font-size="12" fill="#756D66">${esc(dates[i].slice(5).replace("-", "/"))}</text>`;
    });

    series.forEach(s => {
        const pts = s.data.map((v, i) => v === null ? null : [x(i), y(v), v, dates[i]]).filter(Boolean);
        if (pts.length > 1) {
            svg += `<path d="${pts.map((p, i) => (i ? "L" : "M") + p[0] + " " + p[1]).join(" ")}" fill="none" stroke="${s.line}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>`;
        }
    });
    series.forEach(s => {
        s.data.forEach((v, i) => {
            if (v === null) return;
            const info = `${dates[i]}｜${s.scope}｜${METRIC_LABEL[metric]}：${valFmt(metric, v)}`;
            svg += `<circle cx="${x(i)}" cy="${y(v)}" r="5.5" fill="${s.fill}" stroke="#3E3A39" stroke-width="2.5" data-info="${esc(info)}"><title>${esc(info)}</title></circle>`;
        });
    });
    svg += `</svg>`;
    box.innerHTML = svg;
}

/* ============ 11. 事件綁定 ============ */
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
document.querySelectorAll(".nav-tab").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));
["chartStock", "chartMetric", "chartRange"].forEach(id => $(id).addEventListener("change", renderChart));
$("chartBox").addEventListener("click", e => {
    const c = e.target.closest("circle[data-info]");
    if (c) $("chartInfo").textContent = c.getAttribute("data-info");
});
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderChart, 150); });

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
        if (!transactions.some(t => t.code === code)) {
            delete currentPrices[code]; delete prevCloses[code]; delete quoteDates[code]; expandedStocks.delete(code);
        }
        updateFilterOptions(); renderStocks(); persist();
    }
});

$("tradeDate").value = todayString();
handleTypeChange();
updateFilterOptions();
renderStocks();
showTab(location.hash.slice(1));
setView();