// ==UserScript==
// @name         wplace.live Auto Paint v3 (Main World)
// @namespace    wplace-auto-paint-v3
// @version      1.0.0
// @description  直接主世界运行，复用 SvelteKit pawtect 认证，按左上角到最近同色点的路径绘画
// @match        https://wplace.live/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/**
 * 策略（1.0.0）：
 * - @grant none → 代码直接在页面主世界运行，不需要 script 标签注入
 * - 自动绘画附带最近一次页面 PAINT 捕获的 pawtect token
 * - Cloudflare / HTML 拦截页不得误判为 color_locked
 * - 首次 100% 不匹配时强制重拉瓦片，不复用地图拦截缓存
 */

"use strict";

(function () {
    const TAG = "[wplace-v3]";

    const CFG = {
        delayMin: 3000,
        delayMax: 8000,
        batchSize: 1,
        debug: false,
        singleColorBatch: false,
        singleColorBatchSize: 5,
    };

    var TILE_SIZE = 1000;
    var COLOR_LOCKED_PHRASES = [
        "color_locked", "color-locked", "color locked",
        "not_owned", "not owned", "not_unlocked", "not unlocked",
        "color not unlocked", "locked_color", "locked color",
        "palette locked", "unlearned", "not learned", "not_learned"
    ];

    function log(level, ...args) {
        if (level === "debug" && !CFG.debug) return;
        console[level](TAG, ...args);
    }
    function info(...args) { log("info", ...args); }
    function warn(...args) { log("warn", ...args); }
    function error(...args) { log("error", ...args); }
    function debug(...args) { log("debug", ...args); }

    function sleep(ms) { return new Promise(function (r) { return setTimeout(r, ms); }); }
    function rand(min, max) { return Math.random() * (max - min) + min; }

    function headerValue(headers, name) {
        if (!headers) return "";
        var want = String(name).toLowerCase();
        try {
            if (typeof headers.get === "function") {
                return headers.get(name) || headers.get(want) || "";
            }
        } catch (e) {}
        if (Array.isArray(headers)) {
            for (var i = 0; i < headers.length; i++) {
                if (headers[i] && String(headers[i][0]).toLowerCase() === want) return headers[i][1] || "";
            }
            return "";
        }
        if (typeof headers === "object") {
            for (var key in headers) {
                if (headers.hasOwnProperty(key) && String(key).toLowerCase() === want) return headers[key] || "";
            }
        }
        return "";
    }

    function isHtmlBody(text) {
        if (!text) return false;
        var t = String(text).trim().toLowerCase();
        if (!t) return false;
        return t.charAt(0) === "<" ||
            t.indexOf("<!doctype html") >= 0 ||
            t.indexOf("<html") >= 0 ||
            t.indexOf("<head") >= 0;
    }

    function isChallengeText(text, contentType) {
        var ctype = String(contentType || "").toLowerCase();
        if (ctype.indexOf("text/html") >= 0 || ctype.indexOf("application/xhtml") >= 0) return true;
        if (!text) return false;
        var lower = String(text).toLowerCase();
        if (isHtmlBody(text)) return true;
        return lower.indexOf("just a moment") >= 0 ||
            lower.indexOf("cf-browser-verification") >= 0 ||
            lower.indexOf("cf-challenge") >= 0 ||
            lower.indexOf("challenge-platform") >= 0 ||
            lower.indexOf("checking your browser") >= 0 ||
            lower.indexOf("_cf_chl") >= 0;
    }

    function extractErrorText(text) {
        if (!text) return "";
        var raw = String(text).trim();
        if (!raw || isHtmlBody(raw)) return "";
        try {
            var obj = JSON.parse(raw);
            if (typeof obj === "string") return obj;
            var parts = [];
            var keys = ["error", "code", "reason", "message", "msg", "detail", "error_code", "errorCode"];
            for (var i = 0; i < keys.length; i++) {
                if (obj && obj[keys[i]] != null && obj[keys[i]] !== "") parts.push(String(obj[keys[i]]));
            }
            if (parts.length) return parts.join(" ");
            return JSON.stringify(obj);
        } catch (e) {
            return raw;
        }
    }

    function isColorLockedText(text) {
        if (!text || isHtmlBody(text)) return false;
        var hay = extractErrorText(text).toLowerCase();
        if (!hay) return false;
        for (var i = 0; i < COLOR_LOCKED_PHRASES.length; i++) {
            if (hay.indexOf(COLOR_LOCKED_PHRASES[i]) >= 0) return true;
        }
        return false;
    }

    function classifyPaintFailure(status, text, contentType) {
        if (isChallengeText(text, contentType)) return "challenge";
        if (status === 429) return "rate_limit";
        if (isColorLockedText(text)) return "color_locked";
        if (status === 401 || status === 403) return "auth";
        if (status === 400) return "bad_request";
        return "http_" + status;
    }

    // ========================= 调色板 =========================
    var PALETTE = [
        {id:0,hex:"transparent"},{id:1,hex:"#000000",rgb:[0,0,0]},
        {id:2,hex:"#3C3C3C",rgb:[60,60,60]},{id:3,hex:"#787878",rgb:[120,120,120]},
        {id:4,hex:"#D2D2D2",rgb:[210,210,210]},{id:5,hex:"#FFFFFF",rgb:[255,255,255]},
        {id:6,hex:"#600018",rgb:[96,0,24]},{id:7,hex:"#ED1C24",rgb:[237,28,36]},
        {id:8,hex:"#FF7F27",rgb:[255,127,39]},{id:9,hex:"#F6AA09",rgb:[246,170,9]},
        {id:10,hex:"#F9DD3B",rgb:[249,221,59]},{id:11,hex:"#FFFABC",rgb:[255,250,188]},
        {id:12,hex:"#0EB968",rgb:[14,185,104]},{id:13,hex:"#13E67B",rgb:[19,230,123]},
        {id:14,hex:"#87FF5E",rgb:[135,255,94]},{id:15,hex:"#0C816E",rgb:[12,129,110]},
        {id:16,hex:"#10AEA6",rgb:[16,174,166]},{id:17,hex:"#13E1BE",rgb:[19,225,190]},
        {id:18,hex:"#28509E",rgb:[40,80,158]},{id:19,hex:"#4093E4",rgb:[64,147,228]},
        {id:20,hex:"#60F7F2",rgb:[96,247,242]},{id:21,hex:"#6B50F6",rgb:[107,80,246]},
        {id:22,hex:"#99B1FB",rgb:[153,177,251]},{id:23,hex:"#780C99",rgb:[120,12,153]},
        {id:24,hex:"#AA38B9",rgb:[170,56,185]},{id:25,hex:"#E09FF9",rgb:[224,159,249]},
        {id:26,hex:"#CB007A",rgb:[203,0,122]},{id:27,hex:"#EC1F80",rgb:[236,31,128]},
        {id:28,hex:"#F38DA9",rgb:[243,141,169]},{id:29,hex:"#684634",rgb:[104,70,52]},
        {id:30,hex:"#95682A",rgb:[149,104,42]},{id:31,hex:"#F8B277",rgb:[248,178,119]},
        {id:32,hex:"#AAAAAA",rgb:[170,170,170]},
        {id:33,hex:"#A50E1E",rgb:[165,14,30]},{id:34,hex:"#FA8072",rgb:[250,128,114]},
        {id:35,hex:"#E45C1A",rgb:[228,92,26]},{id:36,hex:"#D6B594",rgb:[214,181,148]},
        {id:37,hex:"#9C8431",rgb:[156,132,49]},{id:38,hex:"#C5AD31",rgb:[197,173,49]},
        {id:39,hex:"#E8D45F",rgb:[232,212,95]},{id:40,hex:"#4A6B3A",rgb:[74,107,58]},
        {id:41,hex:"#5A944A",rgb:[90,148,74]},{id:42,hex:"#84C573",rgb:[132,197,115]},
        {id:43,hex:"#0F799F",rgb:[15,121,159]},{id:44,hex:"#BBFAF2",rgb:[187,250,242]},
        {id:45,hex:"#7DC7FF",rgb:[125,199,255]},{id:46,hex:"#4D31B8",rgb:[77,49,184]},
        {id:47,hex:"#4A4284",rgb:[74,66,132]},{id:48,hex:"#7A71C4",rgb:[122,113,196]},
        {id:49,hex:"#B5AEF1",rgb:[181,174,241]},{id:50,hex:"#DBA463",rgb:[219,164,99]},
        {id:51,hex:"#D18051",rgb:[209,128,81]},{id:52,hex:"#FFC5A5",rgb:[255,197,165]},
        {id:53,hex:"#9B5249",rgb:[155,82,73]},{id:54,hex:"#D18078",rgb:[209,128,120]},
        {id:55,hex:"#FAB6A4",rgb:[250,182,164]},{id:56,hex:"#7B6352",rgb:[123,99,82]},
        {id:57,hex:"#9C846B",rgb:[156,132,107]},{id:58,hex:"#333941",rgb:[51,57,65]},
        {id:59,hex:"#6D758D",rgb:[109,117,141]},{id:60,hex:"#B3B9D1",rgb:[179,185,209]},
        {id:61,hex:"#6D643F",rgb:[109,100,63]},{id:62,hex:"#948C6B",rgb:[148,140,107]},
        {id:63,hex:"#CDC59E",rgb:[205,197,158]}
    ];

    var FREE_IDS = new Set();
    for (var i = 1; i <= 31; i++) FREE_IDS.add(i);

    // ========================= 状态 =========================
    var state = {
        template: null,
        running: false,
        paused: false,
        paintCount: 0,
        mismatchCount: 0,
        status: "就绪",
        phase: "free",
        tileCache: {},
        lastTileUrl: null,
        pawtectToken: null,
        interceptTemplate: null,
        concreteErr: 0,
        skippedNoTile: 0,
        lastMismatchCount: -1,
        noProgressRuns: 0,
        chargesCount: 0,
        chargesMax: 0,
        chargesCooldownMs: 0,
        lockedColors: {}, // { colorId: true } 标记因未解锁而跳过的颜色
        routeLastPoint: null, // 最近一次成功绘画的点，用于保持连续的绘画路径
        challengeStreak: 0,
        awaitingChallenge: false,
        didSuspiciousRescan: false,
        cursorCoord: null, // { tlX, tlY, pxX, pxY, gx, gy }
    };

    var _failedTiles = {};
    var _tileInflight = {};

    function isFree(colorId) { return FREE_IDS.has(colorId); }

    function rgbDist(a, b) {
        return (a[0]-b[0])*(a[0]-b[0]) + (a[1]-b[1])*(a[1]-b[1]) + (a[2]-b[2])*(a[2]-b[2]);
    }

    function nearestColorId(r, g, b) {
        var best = 1, bestD = Infinity;
        for (var i = 0; i < PALETTE.length; i++) {
            var c = PALETTE[i];
            if (c.id === 0 || !c.rgb) continue;
            var d = rgbDist(c.rgb, [r, g, b]);
            if (d < bestD) { bestD = d; best = c.id; }
        }
        return best;
    }

    // ========================= Fetch 拦截（学习 auth 格式） =========================
    var _origFetch = window.fetch;
    var _pawtectToken = null;
    var _intercepted = false;
    var _paintWaiters = [];
    var _tileWaiters = {};
    var _selfPaintDepth = 0;

    function notePawtectToken(token, fromSelf) {
        if (!token) return;
        var prev = _pawtectToken;
        _pawtectToken = token;
        if (fromSelf) {
            debug("pawtect 令牌由脚本请求携带:", token.substring(0, 30) + "...");
            return;
        }
        if (token !== prev) {
            info("🎯 pawtect 令牌已捕获:", token.substring(0, 30) + "...");
            updateInfo();
        }
        if (state.awaitingChallenge) {
            state.awaitingChallenge = false;
            if (state.running && state.paused) {
                state.paused = false;
                setStatus("验证已通过，继续绘画");
            }
        }
    }

    function imageDataFromBitmap(bmp) {
        var w = bmp && (bmp.width || bmp.naturalWidth) ? (bmp.width || bmp.naturalWidth) : TILE_SIZE;
        var h = bmp && (bmp.height || bmp.naturalHeight) ? (bmp.height || bmp.naturalHeight) : TILE_SIZE;
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, w, h);
    }

    window.fetch = function (req, opts) {
        opts = opts || {};
        var url = typeof req === "string" ? req : (req && req.url) || "";
        var method = ((req && req.method) || opts.method || "GET").toUpperCase();
        var body = opts.body || null;
        var headers = opts.headers || (req && req.headers) || null;
        var selfPaint = _selfPaintDepth > 0;

        var token = headerValue(headers, "x-pawtect-token");
        if (token) notePawtectToken(token, selfPaint);

        // 点格子时页面会 GET /pixel/{tlX}/{tlY}?x=&y=，无需登录、无需打开 Paint
        if (method === "GET" && url.indexOf("/pixel/") >= 0) {
            var pixelCoord = parseCoordFromPixelUrl(url);
            if (pixelCoord) setCursorCoord(pixelCoord);
        }

        // 捕获 paint 请求模板（只记页面自己的第一次真实 PAINT，不记脚本请求）
        if (url.indexOf("/paint") >= 0 && method === "POST" && !selfPaint && !_intercepted) {
            _intercepted = true;
            var parsedBody = null;
            try { parsedBody = typeof body === "string" ? JSON.parse(body) : null; } catch(e){}
            var hdrs = {};
            if (headers instanceof Headers) headers.forEach(function(v, k) { hdrs[k] = v; });
            else if (headers && typeof headers === "object" && !Array.isArray(headers)) Object.assign(hdrs, headers);
            else if (Array.isArray(headers)) for (var hi = 0; hi < headers.length; hi++) hdrs[headers[hi][0]] = headers[hi][1];
            state.interceptTemplate = { url: url, headers: hdrs, bodyTemplate: parsedBody };
            info("🎯 捕获 paint 模板:", url);
            info("   Body:", typeof body === "string" ? body.substring(0, 300) : body);
            if (parsedBody && parsedBody.tiles && parsedBody.tiles[0] && parsedBody.tiles[0].pixels) {
                var tile = parsedBody.tiles[0];
                var px = tile.pixels.x && tile.pixels.x[0];
                var py = tile.pixels.y && tile.pixels.y[0];
                if (tile.x != null && tile.y != null && px != null && py != null) {
                    setCursorCoord(coordFromParts(tile.x, tile.y, px, py));
                }
            }
            for (var i = 0; i < _paintWaiters.length; i++) _paintWaiters[i]();
            _paintWaiters = [];
        }

        // 捕获 tile URL 模板 + 缓存 imageData
        if (url.indexOf("/tiles/") >= 0 && method === "GET") {
            if (!state.lastTileUrl) {
                state.lastTileUrl = url;
                info("🎯 瓦片 URL 模板:", url);
            }
            var m = url.match(/tiles\/(\d+)\/(\d+)\./);
            if (m) {
                var key = parseInt(m[1]) + "," + parseInt(m[2]);
                if (_tileWaiters[key]) {
                    for (var wi = 0; wi < _tileWaiters[key].length; wi++) _tileWaiters[key][wi]();
                    delete _tileWaiters[key];
                }
            }
        }

        return _origFetch.apply(this, arguments);
    };

    function waitForPaintTemplate(timeoutMs) {
        return new Promise(function(resolve) {
            if (state.interceptTemplate) { resolve(true); return; }
            var done = false;
            var timer = setTimeout(function() {
                if (done) return;
                done = true;
                var idx = _paintWaiters.indexOf(w);
                if (idx >= 0) _paintWaiters.splice(idx, 1);
                resolve(false);
            }, timeoutMs);
            var w = function() {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(true);
            };
            _paintWaiters.push(w);
        });
    }

    // ========================= API =========================

    function sendPaint(bodyObj) {
        var url = "https://backend.wplace.live/paint";
        var bodyStr = JSON.stringify(bodyObj);
        var headers = { "Content-Type": "application/json" };
        if (_pawtectToken) headers["x-pawtect-token"] = _pawtectToken;

        debug("🎨 → paint:", bodyStr.substring(0, 200));

        _selfPaintDepth++;
        return window.fetch(url, {
            method: "POST",
            headers: headers,
            body: bodyStr,
            credentials: "include",
        }).then(function(r) {
            var ctype = "";
            try { ctype = r.headers.get("content-type") || ""; } catch (e) {}
            return r.text().then(function(text) {
                debug("🎨 ← paint:", r.status, text.substring(0, 150));
                if (r.status === 200 || r.status === 201 || r.status === 204) {
                    if (isChallengeText(text, ctype)) return { ok: false, reason: "challenge", body: text };
                    return { ok: true };
                }
                return { ok: false, reason: classifyPaintFailure(r.status, text, ctype), body: text };
            });
        }).then(function(result) {
            _selfPaintDepth = Math.max(0, _selfPaintDepth - 1);
            return result;
        }, function(err) {
            _selfPaintDepth = Math.max(0, _selfPaintDepth - 1);
            throw err;
        });
    }

    function isUsableTile(imgData) {
        return !!(imgData && imgData.data && imgData.data.length && (imgData.width || TILE_SIZE) > 0);
    }

    function tileUrl(tileX, tileY, bustCache) {
        var url = state.lastTileUrl
            ? state.lastTileUrl.replace(/\/\d+\/\d+\.png/, "/" + tileX + "/" + tileY + ".png")
            : "https://backend.wplace.live/files/s0/tiles/" + tileX + "/" + tileY + ".png";
        if (bustCache) {
            url += (url.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now();
        }
        return url;
    }

    function fetchTile(tileX, tileY, bustCache) {
        var key = tileX + "," + tileY;
        if (_failedTiles[key] && !bustCache) return Promise.reject(new Error("tile previously failed"));
        var url = tileUrl(tileX, tileY, bustCache);
        debug("📷 → tile:", url);

        return window.fetch(url, { credentials: "include", mode: "cors" }).then(function(resp) {
            if (!resp.ok) throw new Error("tile HTTP " + resp.status);
            var ctype = "";
            try { ctype = resp.headers.get("content-type") || ""; } catch (e) {}
            if (ctype && ctype.indexOf("image/") < 0 && ctype.indexOf("octet-stream") < 0) {
                throw new Error("tile not image: " + ctype);
            }
            return resp.blob();
        }).then(function(blob) {
            if (!blob || !blob.size) throw new Error("tile blob empty");
            return createImageBitmap(blob);
        }).then(function(bmp) {
            var imgData = imageDataFromBitmap(bmp);
            if (!isUsableTile(imgData)) throw new Error("tile decoded unusable");
            return imgData;
        }).catch(function(e) {
            debug("   Strategy 1 failed:", e && e.message);
            return new Promise(function(resolve, reject) {
                var img = new Image();
                img.crossOrigin = "anonymous";
                img.onload = function() {
                    try {
                        var imgData = imageDataFromBitmap(img);
                        if (!isUsableTile(imgData)) reject(new Error("img tile unusable"));
                        else resolve(imgData);
                    } catch (err) { reject(err); }
                };
                img.onerror = function() { reject(new Error("img tag load failed")); };
                img.src = url;
            });
        }).catch(function() {
            _failedTiles[key] = true;
            throw new Error("tile " + tileX + "," + tileY + ": all strategies failed");
        });
    }

    function getTile(tx, ty, forceRefresh) {
        var key = tx + "," + ty;
        if (!forceRefresh && isUsableTile(state.tileCache[key])) {
            return Promise.resolve(state.tileCache[key]);
        }
        if (!forceRefresh && _tileInflight[key]) return _tileInflight[key];
        _tileInflight[key] = fetchTile(tx, ty, !!forceRefresh).then(function(imgData) {
            state.tileCache[key] = imgData;
            delete _failedTiles[key];
            return imgData;
        }).catch(function(err) {
            _failedTiles[key] = true;
            throw err;
        }).then(function(imgData) {
            delete _tileInflight[key];
            return imgData;
        }, function(err) {
            delete _tileInflight[key];
            throw err;
        });
        return _tileInflight[key];
    }

    function readPixel(imgData, px, py) {
        var w = imgData.width || TILE_SIZE;
        var h = imgData.height || TILE_SIZE;
        if (px < 0 || py < 0 || px >= w || py >= h) return 0;
        var i = (py * w + px) * 4;
        if (imgData.data[i + 3] < 128) return 0;
        return nearestColorId(imgData.data[i], imgData.data[i+1], imgData.data[i+2]);
    }

    // ========================= 绘画路径：左上角 → 最近同色点 =========================
    function buildPixelMap() {
        var map = {};
        if (!state.template || !state.template.pixels) return map;
        var px = state.template.pixels;
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (var i = 0; i < px.length; i++) {
            map[px[i].x + "," + px[i].y] = px[i].colorId;
            if (px[i].x < minX) minX = px[i].x;
            if (px[i].x > maxX) maxX = px[i].x;
            if (px[i].y < minY) minY = px[i].y;
            if (px[i].y > maxY) maxY = px[i].y;
        }
        state.pixelMap = map;
        state.bounds = { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
    }

    function compareTopLeft(a, b) {
        // 屏幕坐标中 y 越小越靠上，y 相同再比较 x 越小越靠左。
        if (a.y !== b.y) return a.y - b.y;
        if (a.x !== b.x) return a.x - b.x;
        return a.colorId - b.colorId;
    }

    function findTopLeft(points) {
        var best = null;
        for (var i = 0; i < points.length; i++) {
            if (!best || compareTopLeft(points[i], best) < 0) best = points[i];
        }
        return best;
    }

    function findNearestSameColor(from, points) {
        var best = null;
        var bestDistance = Infinity;
        for (var i = 0; i < points.length; i++) {
            var point = points[i];
            if (point.colorId !== from.colorId) continue;
            var dx = point.x - from.x;
            var dy = point.y - from.y;
            var distance = dx * dx + dy * dy;
            if (distance < bestDistance ||
                (distance === bestDistance && (!best || compareTopLeft(point, best) < 0))) {
                best = point;
                bestDistance = distance;
            }
        }
        return best;
    }

    function selectPaintBatch(mismatches, limit, sameColorOnly) {
        var remaining = mismatches.slice();
        var batch = [];
        var current = state.routeLastPoint;
        var batchColor = null;

        while (batch.length < limit && remaining.length > 0) {
            var next = current ? findNearestSameColor(current, remaining) : findTopLeft(remaining);
            if (!next) next = findTopLeft(remaining);

            if (batch.length > 0 && sameColorOnly && next.colorId !== batchColor) break;
            if (batch.length === 0) batchColor = next.colorId;

            var index = remaining.indexOf(next);
            if (index >= 0) remaining.splice(index, 1);
            batch.push(next);
            current = next;
        }
        return batch;
    }

    // ========================= 持久化 (localStorage) =========================
    var STORAGE_KEY_TEMPLATE = "wplace-v3-template";
    var STORAGE_KEY_SETTINGS = "wplace-v3-settings";

    function saveTemplateToStorage() {
        try {
            if (!state.template) return;
            localStorage.setItem(STORAGE_KEY_TEMPLATE, JSON.stringify(state.template));
            info("💾 模板已保存:", state.template.pixels.length, "px");
            updateStorageUI();
        } catch(e) { warn("模板保存失败:", e.message); }
    }

    function loadTemplateFromStorage() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY_TEMPLATE);
            if (raw) {
                state.template = JSON.parse(raw);
                buildPixelMap();
                info("📂 从缓存加载模板:", state.template.pixels.length, "px");
                return true;
            }
        } catch(e) { warn("模板加载失败:", e.message); }
        return false;
    }

    function saveSettings() {
        try {
            localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify({
                delayMin: CFG.delayMin,
                delayMax: CFG.delayMax,
                singleColorBatch: CFG.singleColorBatch,
                singleColorBatchSize: CFG.singleColorBatchSize,
            }));
        } catch(e) {}
    }

    function loadSettings() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY_SETTINGS);
            if (raw) {
                var s = JSON.parse(raw);
                if (s.delayMin !== undefined) CFG.delayMin = s.delayMin;
                if (s.delayMax !== undefined) CFG.delayMax = s.delayMax;
                if (s.singleColorBatch !== undefined) CFG.singleColorBatch = s.singleColorBatch;
                if (s.singleColorBatchSize !== undefined) CFG.singleColorBatchSize = s.singleColorBatchSize;
                var dmin = document.getElementById("wplace-v3-delay-min");
                if (dmin) dmin.value = CFG.delayMin / 1000;
                var dmax = document.getElementById("wplace-v3-delay-max");
                if (dmax) dmax.value = CFG.delayMax / 1000;
                var cb = document.getElementById("wplace-v3-single-color");
                if (cb) cb.checked = CFG.singleColorBatch;
                var ni = document.getElementById("wplace-v3-batch-size");
                if (ni) ni.value = CFG.singleColorBatchSize;
            }
        } catch(e) {}
    }

    function clearStorage() {
        try {
            localStorage.removeItem(STORAGE_KEY_TEMPLATE);
            localStorage.removeItem(STORAGE_KEY_SETTINGS);
            state.template = null;
            state.pixelMap = null;
            state.routeLastPoint = null;
            state.paintCount = 0;
            updateInfo();
            updateStorageUI();
            setStatus("缓存已清除");
            info("🗑 缓存已清除");
        } catch(e) {}
    }

    function updateStorageUI() {
        var el = document.getElementById("wplace-v3-storage");
        if (!el) return;
        var hasTemplate = !!(state.template && state.template.pixels);
        if (hasTemplate && localStorage.getItem(STORAGE_KEY_TEMPLATE)) {
            el.innerHTML = '💾 已保存';
            el.style.color = '#22c55e';
        } else if (hasTemplate) {
            el.innerHTML = '📋 内存中';
            el.style.color = '#f59e0b';
        } else {
            el.innerHTML = '📂 无缓存';
            el.style.color = '#94a3b8';
        }
    }

    function updateChargesUI() {
        var el = document.getElementById("wplace-v3-charges");
        if (!el) return;
        var count = Math.round(state.chargesCount * 10) / 10;
        var max = Math.round(state.chargesMax * 10) / 10;
        if (max > 0) {
            el.textContent = count + " / " + max;
        } else {
            el.textContent = String(count);
        }
        if (state.chargesCount === 0) {
            el.style.color = '#ef4444';
        } else if (state.chargesMax > 0 && state.chargesCount < state.chargesMax) {
            el.style.color = '#f59e0b';
        } else {
            el.style.color = '#22c55e';
        }
    }

    // ========================= 差异检测 =========================
    function findMismatches(forceRefresh) {
        if (!state.template || !state.template.pixels) return Promise.resolve({ mismatches: [], skippedNoTile: 0, totalPixels: 0 });
        var px = state.template.pixels;
        var tileGroups = {};
        for (var j = 0; j < px.length; j++) {
            var p = px[j];
            var tx = Math.floor(p.x / TILE_SIZE);
            var ty = Math.floor(p.y / TILE_SIZE);
            var key = tx + "," + ty;
            if (!tileGroups[key]) tileGroups[key] = [];
            tileGroups[key].push(p);
        }

        var keys = Object.keys(tileGroups);
        var fetches = [];
        for (var i = 0; i < keys.length; i++) {
            var parts = keys[i].split(",");
            var tx = parseInt(parts[0]), ty = parseInt(parts[1]);
            fetches.push(getTile(tx, ty, forceRefresh).catch(function() { return null; }));
        }

        return Promise.all(fetches).then(function() {
            var mismatches = [];
            var skipped = 0;
            var skippedLocked = 0;
            var compared = 0;
            for (var j = 0; j < px.length; j++) {
                var p = px[j];
                if (state.phase === "free" && !isFree(p.colorId)) continue;
                if (state.lockedColors && state.lockedColors[p.colorId]) { skippedLocked++; continue; }
                var tx = Math.floor(p.x / TILE_SIZE);
                var ty = Math.floor(p.y / TILE_SIZE);
                var key = tx + "," + ty;
                var td = state.tileCache[key];
                if (!isUsableTile(td)) { skipped++; continue; }
                compared++;
                var cur = readPixel(td, p.x % TILE_SIZE, p.y % TILE_SIZE);
                if (cur !== p.colorId) mismatches.push(p);
            }

            // 首次扫描 100% 不匹配时，更可能是瓦片缓存/解码竞态，强制重拉一次
            if (!state.didSuspiciousRescan && compared > 50 && skipped === 0 && mismatches.length === compared) {
                state.didSuspiciousRescan = true;
                warn("首次扫描全部不匹配 (" + compared + " px)，强制重新拉取瓦片后再比一次");
                state.tileCache = {};
                _failedTiles = {};
                _tileInflight = {};
                return findMismatches(true);
            }

            return { mismatches: mismatches, skippedNoTile: skipped, skippedLocked: skippedLocked, totalPixels: px.length };
        });
    }

    // ========================= 绘画 =========================
    function paintPixels(pixels) {
        var groups = {};
        for (var j = 0; j < pixels.length; j++) {
            var p = pixels[j];
            var tx = Math.floor(p.x / TILE_SIZE);
            var ty = Math.floor(p.y / TILE_SIZE);
            var key = tx + "," + ty;
            if (!groups[key]) groups[key] = [];
            groups[key].push(p);
        }

        var tiles = [];
        for (var key in groups) {
            if (!groups.hasOwnProperty(key)) continue;
            var gp = groups[key];
            var xArr = [], yArr = [], cArr = [];
            for (var j = 0; j < gp.length; j++) {
                xArr.push(gp[j].x % TILE_SIZE);
                yArr.push(gp[j].y % TILE_SIZE);
                cArr.push(gp[j].colorId);
            }
            var parts = key.split(",");
            var tile = { x: parseInt(parts[0]), y: parseInt(parts[1]), pixels: { x: xArr, y: yArr, colors: cArr } };
            tiles.push(tile);
        }

        var body = { season: 0, tiles: tiles };
        return sendPaint(body);
    }

    // 绘画后失效对应 tile 缓存，确保下次 diff 检测拉取最新数据
    function invalidateTiles(pixels) {
        var keys = {};
        for (var j = 0; j < pixels.length; j++) {
            var tx = Math.floor(pixels[j].x / TILE_SIZE);
            var ty = Math.floor(pixels[j].y / TILE_SIZE);
            keys[tx + "," + ty] = true;
        }
        for (var key in keys) {
            if (keys.hasOwnProperty(key)) {
                delete state.tileCache[key];
                delete _failedTiles[key];
                delete _tileInflight[key];
            }
        }
    }

    function fetchMe() {
        return window.fetch("https://backend.wplace.live/me", { credentials: "include" })
            .then(function(r) {
                var ctype = "";
                try { ctype = r.headers.get("content-type") || ""; } catch (e) {}
                return r.text().then(function(text) {
                    if (isChallengeText(text, ctype)) return { challenge: true, body: text };
                    if (!r.ok) return null;
                    try { return JSON.parse(text); } catch (e) { return null; }
                });
            })
            .then(function(me) {
                if (me && me.charges !== undefined) {
                    state.chargesCount = me.charges.count || 0;
                    state.chargesMax = me.charges.max || me.charges.maxCharges || 0;
                    state.chargesCooldownMs = me.charges.cooldownMs || 0;
                    updateChargesUI();
                }
                return me;
            })
            .catch(function() { return null; });
    }

    function waitForCharges() {
        var start = Date.now();
        function check() {
            if (!state.running) return Promise.resolve(0);
            if (state.paused || state.awaitingChallenge) return Promise.resolve(null);
            if (Date.now() - start > 120000) return Promise.resolve(0);
            return fetchMe().then(function(me) {
                if (me && me.challenge) {
                    pauseForChallenge("me");
                    return null;
                }
                if (me && me.charges !== undefined) {
                    if (me.charges.count > 0) return me.charges.count;
                    var wait = me.charges.cooldownMs || 10000;
                    setStatus("⏳ 充能等待 " + Math.ceil(wait / 1000) + "秒");
                    return sleep(Math.min(wait, 10000)).then(check);
                }
                return 999;
            });
        }
        return check();
    }

    function pauseForChallenge(where) {
        state.paused = true;
        state.awaitingChallenge = true;
        state.challengeStreak = (state.challengeStreak || 0) + 1;
        warn("Cloudflare / 浏览器验证拦截 (" + (where || "paint") + ")，已暂停。请完成页面验证并手动 PAINT 一次后再继续。");
        setStatus("🛡️ 验证拦截，请完成验证并 PAINT 一次，再点 ⏸ 继续");
    }

    // ========================= UI =========================
    var uiPanel = null;

    function setStatus(s) {
        state.status = s;
        var el = document.getElementById("wplace-v3-status-text");
        if (el) el.textContent = s;
        info("状态:", s);
    }

    function createUI() {
        if (document.getElementById("wplace-v3-panel")) return;

        // 恢复面板位置
        var savedPos = null;
        try { savedPos = JSON.parse(localStorage.getItem("wplace-v3-panel-pos")); } catch(e) {}
        var panelLeft = (savedPos && savedPos.left) ? savedPos.left : (window.innerWidth - 300) + "px";
        var panelTop = (savedPos && savedPos.top) ? savedPos.top : "80px";

        var panel = document.createElement("div");
        panel.id = "wplace-v3-panel";
        panel.style.cssText = "position:fixed;left:" + panelLeft + ";top:" + panelTop + ";width:280px;background:rgba(20,30,48,0.97);color:#fff;border-radius:12px;padding:14px;font-family:system-ui;font-size:12px;z-index:99999;box-shadow:0 8px 32px rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);backdrop-filter:blur(8px);transition:box-shadow 0.2s;";
        panel.innerHTML =
            '<div id="wplace-v3-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;cursor:grab;user-select:none;padding:4px 0;">' +
                '<span id="wplace-v3-drag-handle" style="cursor:grab;margin-right:6px;opacity:0.5;font-size:14px;line-height:1;">⠿</span>' +
                '<strong style="font-size:14px;flex:1;">🎨 自动绘画 <span style="color:#60f7f2;font-size:10px;">1.0.0</span></strong>' +
                '<button id="wplace-v3-close" style="background:none;border:none;color:#fff;cursor:pointer;font-size:16px;opacity:0.6;">×</button>' +
            '</div>' +
            '<div id="wplace-v3-info" style="margin-bottom:8px;color:#cbd5e1;min-height:32px;line-height:1.5;font-size:12px;">未加载模板</div>' +
            '<button id="wplace-v3-load" style="width:100%;padding:6px;border-radius:6px;border:none;background:#3b82f6;color:#fff;cursor:pointer;font-size:12px;margin-bottom:6px;">📂 加载模板 JSON</button>' +
            '<div style="display:flex;gap:4px;margin-bottom:6px;">' +
                '<button id="wplace-v3-start-free" data-phase="free" style="flex:1;padding:7px;border-radius:6px;border:none;background:#22c55e;color:#fff;cursor:pointer;font-weight:bold;font-size:12px;">▶ 免费</button>' +
                '<button id="wplace-v3-start-all" data-phase="all" style="flex:1;padding:7px;border-radius:6px;border:none;background:#8b5cf6;color:#fff;cursor:pointer;font-size:12px;">▶ 全量</button>' +
                '<button id="wplace-v3-pause-btn" style="padding:7px 12px;border-radius:6px;border:none;background:#f59e0b;color:#fff;cursor:pointer;font-size:12px;">⏸</button>' +
                '<button id="wplace-v3-stop-btn" style="padding:7px 12px;border-radius:6px;border:none;background:#ef4444;color:#fff;cursor:pointer;font-size:12px;">⏹</button>' +
            '</div>' +
            '<div style="margin-bottom:6px;">' +
                '<label style="display:block;margin-bottom:3px;color:#94a3b8;font-size:11px;">延迟 (秒)</label>' +
                '<div style="display:flex;align-items:center;gap:4px;">' +
                    '<input type="number" id="wplace-v3-delay-min" value="3" min="0.1" max="60" step="0.1" style="flex:1;width:0;padding:4px;border-radius:4px;border:none;background:#334155;color:#fff;font-size:11px;text-align:center;">' +
                    '<span style="color:#64748b;font-size:10px;">~</span>' +
                    '<input type="number" id="wplace-v3-delay-max" value="8" min="0.1" max="60" step="0.1" style="flex:1;width:0;padding:4px;border-radius:4px;border:none;background:#334155;color:#fff;font-size:11px;text-align:center;">' +
                '</div>' +
            '</div>' +
            '<div style="margin-bottom:6px;display:flex;align-items:center;gap:6px;">' +
                '<label style="color:#94a3b8;font-size:11px;white-space:nowrap;cursor:pointer;">' +
                    '<input type="checkbox" id="wplace-v3-single-color" style="vertical-align:middle;cursor:pointer;"> 单色批次' +
                '</label>' +
                '<input type="number" id="wplace-v3-batch-size" value="5" min="1" max="50" style="width:50px;padding:2px 4px;border-radius:4px;border:none;background:#334155;color:#fff;font-size:11px;text-align:center;">' +
                '<span style="color:#64748b;font-size:10px;">px/次</span>' +
            '</div>' +
            '<div style="font-size:11px;color:#94a3b8;line-height:1.6;">' +
                '状态：<span id="wplace-v3-status-text" style="color:#fff;">就绪</span><br>' +
                '进度：<span id="wplace-v3-progress" style="color:#fff;">0 / 0</span><br>' +
                '充能：<span id="wplace-v3-charges" style="color:#94a3b8;">--</span><br>' +
                '认证：<span id="wplace-v3-auth" style="color:#f59e0b;">等待（点地图 PAINT 一次）</span><br>' +
                '坐标：<span id="wplace-v3-coord" style="color:#94a3b8;">点击地图格子后显示</span> ' +
                '<button id="wplace-v3-copy-coord" style="font-size:10px;padding:1px 6px;border-radius:3px;border:1px solid #64748b;background:transparent;color:#94a3b8;cursor:pointer;">复制</button><br>' +
                '缓存：<span id="wplace-v3-storage" style="color:#94a3b8;">📂 无缓存</span> ' +
                '<button id="wplace-v3-clear" style="font-size:10px;padding:1px 6px;border-radius:3px;border:1px solid #64748b;background:transparent;color:#94a3b8;cursor:pointer;">🗑</button><br>' +
                '调试：<button id="wplace-v3-debug" style="font-size:10px;padding:1px 6px;border-radius:3px;border:1px solid #64748b;background:transparent;color:#94a3b8;cursor:pointer;">开启</button>' +
            '</div>';

        (document.body || document.documentElement).appendChild(panel);
        uiPanel = panel;

        // === 拖动逻辑 ===
        var dragHandle = document.getElementById("wplace-v3-header");
        var isDragging = false, dragStartX, dragStartY, panelStartX, panelStartY;

        dragHandle.onmousedown = function(e) {
            if (e.target.tagName === "BUTTON") return;
            isDragging = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            panelStartX = panel.offsetLeft;
            panelStartY = panel.offsetTop;
            panel.style.transition = "none";
            panel.style.cursor = "grabbing";
            dragHandle.style.cursor = "grabbing";
            e.preventDefault();
        };

        document.addEventListener("mousemove", function(e) {
            if (!isDragging) return;
            var dx = e.clientX - dragStartX;
            var dy = e.clientY - dragStartY;
            panel.style.left = Math.max(0, panelStartX + dx) + "px";
            panel.style.top = Math.max(0, panelStartY + dy) + "px";
        });

        document.addEventListener("mouseup", function() {
            if (!isDragging) return;
            isDragging = false;
            panel.style.cursor = "";
            panel.style.transition = "";
            dragHandle.style.cursor = "grab";
            try {
                localStorage.setItem("wplace-v3-panel-pos", JSON.stringify({
                    left: panel.style.left,
                    top: panel.style.top,
                }));
            } catch(e) {}
        });

        document.getElementById("wplace-v3-close").onclick = function () { panel.style.display = "none"; };
        document.getElementById("wplace-v3-load").onclick = function () { loadTemplateFromFile(); };
        document.getElementById("wplace-v3-start-free").onclick = function () { saveSettings(); start("free"); };
        document.getElementById("wplace-v3-start-all").onclick = function () { saveSettings(); start("all"); };
        document.getElementById("wplace-v3-pause-btn").onclick = function () {
            if (state.awaitingChallenge && state.paused) {
                state.awaitingChallenge = false;
                state.paused = false;
                setStatus("继续运行（请确认验证已通过）");
                return;
            }
            state.paused = !state.paused;
            setStatus(state.paused ? "已暂停" : "运行中");
        };
        document.getElementById("wplace-v3-stop-btn").onclick = function () {
            state.running = false;
            state.paused = false;
            state.awaitingChallenge = false;
            setStatus("已停止");
        };
        document.getElementById("wplace-v3-delay-min").oninput = function (e) { CFG.delayMin = Math.max(100, (parseFloat(e.target.value) || 3) * 1000); saveSettings(); };
        document.getElementById("wplace-v3-delay-max").oninput = function (e) { CFG.delayMax = Math.max(100, (parseFloat(e.target.value) || 8) * 1000); saveSettings(); };
        document.getElementById("wplace-v3-single-color").onchange = function (e) { CFG.singleColorBatch = e.target.checked; saveSettings(); };
        document.getElementById("wplace-v3-batch-size").oninput = function (e) { CFG.singleColorBatchSize = Math.max(1, parseInt(e.target.value) || 5); saveSettings(); };
        document.getElementById("wplace-v3-clear").onclick = function () { if (confirm("确认清除缓存模板？")) clearStorage(); };
        document.getElementById("wplace-v3-debug").onclick = function (e) {
            CFG.debug = !CFG.debug;
            e.target.textContent = CFG.debug ? "关闭" : "开启";
            e.target.style.color = CFG.debug ? "#22c55e" : "#94a3b8";
            info("调试模式:", CFG.debug);
        };
        document.getElementById("wplace-v3-copy-coord").onclick = function () {
            if (!state.cursorCoord) { setStatus("还没有坐标，先点地图上的一格"); return; }
            var c = state.cursorCoord;
            var text = c.tlX + " " + c.tlY + " " + c.pxX + " " + c.pxY;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function() {
                    setStatus("已复制 Tl/Px: " + text);
                }).catch(function() {
                    window.prompt("复制坐标", text);
                });
            } else {
                window.prompt("复制坐标", text);
            }
        };

    }

    function parseCoordFromPixelUrl(url) {
        if (!url) return null;
        var path = String(url).match(/\/pixel\/(\d+)\/(\d+)/);
        if (!path) return null;
        var query = "";
        var qIdx = url.indexOf("?");
        if (qIdx >= 0) query = url.substring(qIdx + 1).split("#")[0];
        var params = {};
        var parts = query.split("&");
        for (var i = 0; i < parts.length; i++) {
            if (!parts[i]) continue;
            var kv = parts[i].split("=");
            params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || "");
        }
        var pxX = parseInt(params.x, 10);
        var pxY = parseInt(params.y, 10);
        var tlX = parseInt(path[1], 10);
        var tlY = parseInt(path[2], 10);
        if ([tlX, tlY, pxX, pxY].some(function(n) { return isNaN(n); })) return null;
        return coordFromParts(tlX, tlY, pxX, pxY);
    }

    function coordFromParts(tlX, tlY, pxX, pxY) {
        return {
            tlX: tlX, tlY: tlY, pxX: pxX, pxY: pxY,
            gx: tlX * TILE_SIZE + pxX,
            gy: tlY * TILE_SIZE + pxY
        };
    }

    function setCursorCoord(coord) {
        if (!coord) return;
        var prev = state.cursorCoord;
        if (prev && prev.tlX === coord.tlX && prev.tlY === coord.tlY && prev.pxX === coord.pxX && prev.pxY === coord.pxY) return;
        state.cursorCoord = coord;
        updateCoordUI();
        debug("📍 坐标:", "Tl", coord.tlX, coord.tlY, "Px", coord.pxX, coord.pxY, "全局", coord.gx, coord.gy);
    }

    function updateCoordUI() {
        var el = document.getElementById("wplace-v3-coord");
        if (!el) return;
        var c = state.cursorCoord;
        if (!c) {
            el.textContent = "点地图一格即可（无需登录）";
            el.style.color = "#94a3b8";
            return;
        }
        el.innerHTML = 'Tl ' + c.tlX + '/' + c.tlY + ' · Px ' + c.pxX + '/' + c.pxY +
            '<br><span style="color:#64748b;">全局 ' + c.gx + ', ' + c.gy + '</span>';
        el.style.color = "#22c55e";
    }

    function updateInfo() {
        if (!uiPanel) return;
        var info = document.getElementById("wplace-v3-info");
        var prog = document.getElementById("wplace-v3-progress");
        var auth = document.getElementById("wplace-v3-auth");

        if (state.template) {
            var px = state.template.pixels || [];
            var fc = 0, pc = 0;
            for (var j = 0; j < px.length; j++) { if (isFree(px[j].colorId)) fc++; else pc++; }
            info.innerHTML = '<span style="color:#cbd5e1;">' + (state.template.name || '未命名') + '</span><br>总数: ' + px.length + ' | 免费: ' + fc + ' | 付费: ' + pc;
        } else {
            info.innerHTML = "请加载模板 JSON";
        }

        var skipTxt = state.skippedNoTile > 0 ? " | 跳过:" + state.skippedNoTile : "";
        var lockedKeys = Object.keys(state.lockedColors || {});
        var lockedTxt = lockedKeys.length > 0 ? ' | <span style="color:#f59e0b;">🔒' + lockedKeys.length + '色</span>' : "";
        var total = state.template ? (state.template.pixels ? state.template.pixels.length : 0) : 0;
        var correct = total - state.mismatchCount;
        prog.innerHTML = correct + " / " + total + " | 本轮:" + state.paintCount + skipTxt + lockedTxt;

        if (state.awaitingChallenge) {
            auth.textContent = "验证拦截，请完成验证并 PAINT";
            auth.style.color = "#f59e0b";
        } else if (_pawtectToken) {
            auth.textContent = "令牌已捕获";
            auth.style.color = "#22c55e";
        } else {
            auth.textContent = "等待 (点击地图 + PAINT 一次)";
            auth.style.color = "#f59e0b";
        }
    }

    function loadTemplateFromFile() {
        var input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,.jsonl";
        input.onchange = function (e) {
            var file = e.target.files[0];
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function (ev) {
                try {
                    state.template = JSON.parse(ev.target.result);
                    state.paintCount = 0;
                    state.routeLastPoint = null;
                    buildPixelMap();
                    saveTemplateToStorage();
                    setStatus("模板已加载");
                    updateInfo();
                    info("模板已加载:", state.template.pixels.length, "px");
                } catch (err) {
                    alert("JSON 解析错误: " + err.message);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    // ========================= Main Loop =========================
    function start(phase) {
        if (!state.template) { setStatus("无模板！"); loadTemplateFromFile(); return; }
        if (state.running) return;

        state.running = true;
        state.paused = false;
        state.paintCount = 0;
        state.concreteErr = 0;
        state.phase = phase;
        state.routeLastPoint = null;
        state.tileCache = {};
        state.lockedColors = {};
        state.awaitingChallenge = false;
        state.didSuspiciousRescan = false;
        _failedTiles = {};
        _tileInflight = {};

        function loop() {
            if (!state.running) return Promise.resolve();

            if (state.paused) {
                if (!state.awaitingChallenge) setStatus("已暂停");
                return sleep(1000).then(loop);
            }

            setStatus("检测差异中...");
            return findMismatches().then(function(result) {
                var mismatches = result.mismatches;
                state.mismatchCount = mismatches.length;
                state.skippedNoTile = result.skippedNoTile;
                updateInfo();

                var lockedCount = result.skippedLocked || 0;

                if (mismatches.length === 0 && result.skippedNoTile === 0) {
                    if (lockedCount > 0) {
                        setStatus((phase === "free" ? "免费色完成" : "全部完成") + "（跳过未解锁色 " + lockedCount + " px）");
                    } else {
                        setStatus(phase === "free" ? "免费色完成！点「▶ 全量」画付费色" : "全部完成！");
                    }
                    state.running = false;
                    return Promise.resolve();
                }

                if (mismatches.length === 0 && result.skippedNoTile > 0) {
                    setStatus(result.skippedNoTile + " 像素跳过 (瓦片加载失败)");
                    info("部分瓦片加载失败，稍后重试...");
                    return sleep(5000).then(loop);
                }

                if (state.lastMismatchCount === mismatches.length) {
                    state.noProgressRuns = (state.noProgressRuns || 0) + 1;
                    if (state.noProgressRuns >= 5) {
                        setStatus("无进展 x" + state.noProgressRuns);
                        state.noProgressRuns = 0;
                        return sleep(5000).then(loop);
                    }
                } else {
                    state.noProgressRuns = 0;
                }
                state.lastMismatchCount = mismatches.length;

                info("差异:", mismatches.length, "跳过(瓦片):", result.skippedNoTile, "跳过(未解锁):", lockedCount);

                return waitForCharges().then(function(charges) {
                    if (!state.running) return;
                    if (state.awaitingChallenge || charges == null) {
                        return sleep(1000).then(loop);
                    }
                    if (charges <= 0) {
                        setStatus("⛔ 充能点数不足，已停止 | 剩余: " + mismatches.length + " px");
                        info("充能不足: 需要画 " + mismatches.length + " 像素，但充能已耗尽 (等待超时 120s)");
                        state.running = false;
                        return;
                    }

                    var effectiveBatchSize = CFG.singleColorBatch ? CFG.singleColorBatchSize : CFG.batchSize;
                    if (charges < effectiveBatchSize && mismatches.length > charges) {
                        setStatus("⛔ 充能不足批次 (" + effectiveBatchSize + ")，当前仅 " + (Math.round(charges * 10) / 10) + " 点 | 剩余: " + mismatches.length + " px");
                        info("充能不足: 批次需要 " + effectiveBatchSize + " 点，当前仅 " + charges + " 点，剩余 " + mismatches.length + " 像素");
                        state.running = false;
                        return;
                    }

                    var batch = selectPaintBatch(
                        mismatches,
                        Math.min(effectiveBatchSize, charges),
                        CFG.singleColorBatch
                    );
                    if (batch.length === 0) {
                        setStatus("没有可继续的绘画点");
                        state.running = false;
                        return;
                    }
                    setStatus("绘画 " + batch.length + " 像素 [" + (phase === "free" ? "免费" : "全量") + "]" + (CFG.singleColorBatch ? " 色#" + batch[0].colorId : ""));

                    return paintPixels(batch).then(function(paintResult) {
                        if (paintResult.ok) {
                            state.challengeStreak = 0;
                            state.paintCount += batch.length;
                            state.mismatchCount = Math.max(0, state.mismatchCount - batch.length);
                            state.routeLastPoint = batch[batch.length - 1];
                            invalidateTiles(batch);
                        } else {
                            error("绘画失败:", paintResult.reason, (paintResult.body || "").substring(0, 200));
                            if (paintResult.reason === "challenge") {
                                pauseForChallenge("paint");
                                return sleep(1000).then(loop);
                            }
                            if (paintResult.reason === "rate_limit") {
                                setStatus("⏳ 触发限流，等待后重试");
                                return sleep(15000).then(loop);
                            }
                            if (paintResult.reason === "auth") {
                                setStatus("认证过期！点击地图 + PAINT 重新认证");
                                state.running = false;
                                return;
                            }
                            if (paintResult.reason === "color_locked") {
                                var lockedSet = state.lockedColors || {};
                                var lockedIds = [];
                                var colorsInBatch = {};
                                for (var k = 0; k < batch.length; k++) {
                                    colorsInBatch[batch[k].colorId] = true;
                                }
                                var colorIds = Object.keys(colorsInBatch);
                                if (CFG.singleColorBatch || colorIds.length === 1) {
                                    for (var m = 0; m < colorIds.length; m++) {
                                        var cid = parseInt(colorIds[m]);
                                        if (!lockedSet[cid]) {
                                            lockedSet[cid] = true;
                                            lockedIds.push("#" + cid);
                                        }
                                    }
                                    state.lockedColors = lockedSet;
                                    info("🔒 颜色未解锁，已跳过:", lockedIds.join(" "), "后续将自动忽略这些颜色");
                                    setStatus("🔒 颜色未解锁 (" + lockedIds.join(",") + ")，已跳过，继续其他颜色...");
                                } else {
                                    info("🔒 检测到颜色未解锁错误，但当前批次含", colorIds.length, "种颜色，无法确定是哪一个。建议开启「单色批次」模式以自动跳过。");
                                    setStatus("🔒 颜色未解锁（多色批次无法定位），请开启「单色批次」后重试");
                                    state.running = false;
                                    return;
                                }
                                updateInfo();
                                var waitLocked = rand(CFG.delayMin, CFG.delayMax);
                                return sleep(waitLocked).then(loop);
                            }
                            setStatus("绘画失败: " + paintResult.reason + "，稍后重试");
                            return sleep(8000).then(loop);
                        }
                        updateInfo();

                        var wait = rand(CFG.delayMin, CFG.delayMax);
                        return sleep(wait).then(loop);
                    });
                });
            });
        }

        // Ensure we have paint template and charge info before starting
        if (!state.interceptTemplate) {
            info("等待 paint 模板 (点击地图 + PAINT 一次)...");
            return waitForPaintTemplate(30000).then(function(ok) {
                if (!ok) { setStatus("超时：需要 paint 模板"); state.running = false; return; }
                return fetchMe().then(function() { return loop(); });
            });
        }

        return fetchMe().then(function() { return loop(); });
    }

    // ========================= Init =========================
    function init() {
        createUI();
        loadSettings();
        var loaded = loadTemplateFromStorage();
        updateInfo();
        if (loaded) {
            setStatus("从缓存恢复模板");
        }
        info("1.0.0 - @grant none 模式就绪：左上角开始，优先最近同色点");
        info("点击地图 + PAINT 一次获取认证，然后开始");
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

})();
