import express from "express";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { URL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

const app = express();

/* ───────────────────────── Proxy codec ───────────────────────── */
function encodeTarget(t) {
  return Buffer.from(t).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function decodeTarget(e) {
  try {
    let b = e.replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    return Buffer.from(b, "base64").toString("utf8");
  } catch { return null; }
}
function resolveUrl(base, rel) {
  try { return new URL(rel, base).href; } catch { return null; }
}

/* ───────────────────────── HTML / CSS rewriting ───────────────────────── */
// Client-side interceptor injected into every proxied HTML page. It rewrites
// XHR / fetch / link-clicks / form-submits / window.open so navigation stays
// inside the proxy.
function clientPatch(baseUrl) {
  return `<script>(function(){
  function enc(u){try{var b=btoa(unescape(encodeURIComponent(u))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');return'/proxy/'+b;}catch(e){return u;}}
  function abs(u){try{return new URL(u,${JSON.stringify(baseUrl)}).href;}catch(e){return u;}}
  function proxify(u){try{u=abs(u);if(/^https?:/i.test(u))return enc(u);}catch(e){}return u;}
  var _xo=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){try{arguments[1]=proxify(u);}catch(e){}return _xo.apply(this,arguments);};
  var _f=window.fetch;
  window.fetch=function(i,x){try{var u=typeof i==='string'?i:i.url;var e=proxify(u);i=typeof i==='string'?e:new Request(e,i);}catch(e){}return _f(i,x);};
  var _wo=window.open;
  window.open=function(u,n,f){try{if(u)u=proxify(u);}catch(e){}return _wo.call(window,u,n,f);};
  document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a');if(!a||!a.href)return;var h=a.getAttribute('href');if(!h||h[0]==='#'||h.startsWith('javascript:')||h.startsWith('mailto:'))return;e.preventDefault();window.location.href=proxify(a.href);},true);
  document.addEventListener('submit',function(e){var f=e.target;var a=abs(f.getAttribute('action')||location.href);e.preventDefault();var d=new FormData(f);if((f.method||'GET').toUpperCase()==='POST'){fetch(enc(a),{method:'POST',body:d}).then(function(r){return r.text();}).then(function(t){document.open();document.write(t);document.close();});}else{var p=new URLSearchParams(d).toString();window.location.href=enc(a+(p?'?'+p:''));}},true);
})();</scr${""}ipt>`;
}

function rewriteHtml(html, baseUrl) {
  // Protect inline <script> BODIES from the attribute/url rewrites below — those
  // regexes would corrupt JS that happens to contain url(...), href=, or regex
  // literals. External <script src> opening tags stay exposed so their src is
  // still rewritten by the href|src|action pass.
  const scripts = [];
  html = html.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, open, body, close) => {
    scripts.push(body);
    return open + `@@UVS${scripts.length - 1}@@` + close;
  });
  html = html
    // Strip meta CSP / X-Frame-Options — they would block our injected script
    // and inline styles, or stop the page rendering inside our iframe.
    .replace(/<meta[^>]+http-equiv=["']?(content-security-policy|x-frame-options)["']?[^>]*>/gi, "")
    // Remove the page's own <base> so our injected one (and rewritten URLs) win.
    .replace(/<base\b[^>]*>/gi, "")
    // Drop SRI / nonce / crossorigin so rewritten assets aren't blocked.
    .replace(/\s(integrity|nonce|crossorigin)=(["'])(.*?)\2/gi, "")
    .replace(/\s(integrity|nonce|crossorigin)=[^\s>]+/gi, "")
    // meta refresh → keep it inside the proxy
    .replace(/(<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=)([^"']+)/gi, (m, pre, u) => {
      const abs = resolveUrl(baseUrl, u.trim());
      return abs ? `${pre}/proxy/${encodeTarget(abs)}` : m;
    })
    .replace(/\b(href|src|action)=(["'])(.*?)\2/gi, (m, a, q, v) => {
      if (!v || v.startsWith("data:") || v.startsWith("javascript:") || v.startsWith("#") || v.startsWith("mailto:") || v.startsWith("blob:")) return m;
      const abs = resolveUrl(baseUrl, v);
      return abs ? `${a}=${q}/proxy/${encodeTarget(abs)}${q}` : m;
    })
    .replace(/\bsrcset=(["'])(.*?)\1/gi, (m, q, s) => {
      const r = s.replace(/([^\s,]+)(\s*(?:\d+(?:\.\d+)?[wx])?)/g, (sm, u, d) => {
        if (!u || u.startsWith("data:")) return sm;
        const abs = resolveUrl(baseUrl, u);
        return abs ? `/proxy/${encodeTarget(abs)}${d}` : sm;
      });
      return `srcset=${q}${r}${q}`;
    })
    .replace(/url\((["']?)(.*?)\1\)/gi, (m, q, v) => {
      if (!v || v.startsWith("data:")) return m;
      const abs = resolveUrl(baseUrl, v);
      return abs ? `url(${q}/proxy/${encodeTarget(abs)}${q})` : m;
    })
    .replace(/<head([^>]*)>/i, `<head$1>\n<base href="${baseUrl}">\n${clientPatch(baseUrl)}`);
  // Restore protected inline script bodies.
  return html.replace(/@@UVS(\d+)@@/g, (m, i) => scripts[+i]);
}

function rewriteCss(css, baseUrl) {
  return css
    .replace(/url\((["']?)(.*?)\1\)/gi, (m, q, v) => {
      if (!v || v.startsWith("data:")) return m;
      const abs = resolveUrl(baseUrl, v);
      return abs ? `url(${q}/proxy/${encodeTarget(abs)}${q})` : m;
    })
    .replace(/@import\s+(["'])(.*?)\1/gi, (m, q, v) => {
      const abs = resolveUrl(baseUrl, v);
      return abs ? `@import ${q}/proxy/${encodeTarget(abs)}${q}` : m;
    });
}

/* ───────────────────────── Remote fetch ───────────────────────── */
function fetchRemote(targetUrl, { method = "GET", headers = {}, body = null } = {}, cb, redirects = 0) {
  if (redirects > 8) return cb({ status: 508, body: "Too many redirects" });
  let p;
  try { p = new URL(targetUrl); } catch { return cb({ status: 400, body: "Bad URL" }); }
  const proto = p.protocol === "https:" ? https : http;
  const outHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
  };
  if (headers.cookie) outHeaders["Cookie"] = headers.cookie;
  if (headers["content-type"] && method !== "GET") outHeaders["Content-Type"] = headers["content-type"];
  const opts = {
    hostname: p.hostname,
    port: p.port || (p.protocol === "https:" ? 443 : 80),
    path: p.pathname + (p.search || ""),
    method,
    headers: outHeaders,
    timeout: 20000,
    // Proxies routinely hit hosts whose chain Node can't verify locally; don't
    // let that block the fetch (only affects the Universe→target hop).
    rejectUnauthorized: false,
  };
  let done = false;
  const once = (e, r) => { if (done) return; done = true; cb(e, r); };
  const req = proto.request(opts, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      const ru = resolveUrl(targetUrl, res.headers.location);
      res.resume();
      // 303 (and 301/302 in practice) become GET on redirect.
      const nextMethod = [301, 302, 303].includes(res.statusCode) ? "GET" : method;
      return ru ? fetchRemote(ru, { method: nextMethod, headers, body: nextMethod === "GET" ? null : body }, cb, redirects + 1)
                : once({ status: 502, body: "Bad redirect" });
    }
    const chunks = [];
    const enc = res.headers["content-encoding"];
    let stream = res;
    try {
      if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
    } catch { stream = res; }
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => once(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), finalUrl: targetUrl }));
    stream.on("error", (e) => once({ status: 502, body: "Stream: " + e.message }));
  });
  req.on("timeout", () => { req.destroy(); once({ status: 504, body: "Timed out" }); });
  req.on("error", (e) => once({ status: 502, body: "Fetch: " + e.message }));
  if (body && method !== "GET") req.write(body);
  req.end();
}

// Decode a response body to a JS string honouring its declared charset.
// Node can't decode arbitrary encodings, but the latin1/win-1252 family covers
// the common non-UTF-8 pages; everything else is treated as UTF-8.
function decodeBody(buf, contentType, html) {
  let cs = (/charset=["']?([\w-]+)/i.exec(contentType || "") || [])[1];
  if (!cs && html) {
    const head = buf.slice(0, 2048).toString("latin1");
    cs = (/charset=["']?([\w-]+)/i.exec(head) || [])[1];
  }
  cs = (cs || "utf-8").toLowerCase();
  if (cs === "iso-8859-1" || cs === "latin1" || cs === "windows-1252" || cs === "cp1252")
    return buf.toString("latin1");
  return buf.toString("utf8");
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.alloc(0)));
  });
}

/* ───────────────────────── Proxy route (before body parsers) ───────────────────────── */
app.all(/^\/proxy\/(.+)$/, async (req, res) => {
  const targetUrl = decodeTarget(req.params[0]);
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    res.status(400).type("text/plain").end("Bad proxy target");
    return;
  }
  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? null : await readBody(req);

  fetchRemote(targetUrl, { method, headers: req.headers, body }, (err, result) => {
    if (err) {
      res.status(err.status || 502).type("text/html").end(
        `<!DOCTYPE html><html><body style="font-family:system-ui,monospace;padding:48px;background:#0e0f14;color:#ff8a8a">
         <h2 style="font-weight:600">Proxy error</h2><p style="opacity:.8">${err.body}</p>
         <p style="opacity:.5;font-size:.85rem">Target: <code>${targetUrl.replace(/[<>&]/g, "")}</code></p></body></html>`
      );
      return;
    }
    const ct = result.headers["content-type"] || "";
    const isHtml = ct.includes("text/html");
    const isCss = ct.includes("text/css") || /\.css(\?|$)/i.test(targetUrl);
    const safe = {};
    // Rewritten text is emitted as UTF-8; pass other content types through as-is.
    if (ct) safe["content-type"] = isHtml ? "text/html; charset=utf-8" : isCss ? "text/css; charset=utf-8" : ct;
    ["cache-control", "vary", "last-modified", "etag", "content-disposition"].forEach((h) => {
      if (result.headers[h]) safe[h] = result.headers[h];
    });
    // Relay Set-Cookie, stripped of Domain/Secure/SameSite so it survives on our origin.
    const sc = result.headers["set-cookie"];
    if (sc) {
      safe["set-cookie"] = (Array.isArray(sc) ? sc : [sc]).map((c) =>
        c.replace(/;\s*domain=[^;]*/gi, "").replace(/;\s*secure/gi, "").replace(/;\s*samesite=[^;]*/gi, "")
      );
    }
    res.status(result.status);
    for (const [k, v] of Object.entries(safe)) res.setHeader(k, v);

    if (isHtml) return res.end(rewriteHtml(decodeBody(result.body, ct, true), targetUrl));
    if (isCss) return res.end(rewriteCss(decodeBody(result.body, ct, false), targetUrl));
    res.end(result.body);
  });
});

/* ───────────────────────── Static + API ───────────────────────── */
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Scramjet + bare-mux + epoxy client bundles (served for the SW-based proxy).
const mercury = path.join(__dirname, "node_modules", "@mercuryworkshop");
const bundleOpts = {
  setHeaders(res, p) {
    if (p.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
    else if (p.endsWith(".mjs") || p.endsWith(".js")) res.setHeader("Content-Type", "text/javascript");
  },
};
app.use("/scram/", express.static(path.join(mercury, "scramjet/dist"), bundleOpts));
app.use("/baremux/", express.static(path.join(mercury, "bare-mux/dist"), bundleOpts));
app.use("/epoxy/", express.static(path.join(mercury, "epoxy-transport/dist"), bundleOpts));
app.use("/libcurl/", express.static(path.join(mercury, "libcurl-transport/dist"), bundleOpts));

app.post("/api/run", async (req, res) => {
  const { language, files, stdin } = req.body || {};
  if (!language || !files?.length)
    return res.status(400).json({ error: "language and files are required" });
  try {
    const r = await fetch("https://emkc.org/api/v2/piston/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language, version: "*", files, stdin: stdin || "" }),
    });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: "runner unreachable", detail: String(err) });
  }
});

const dataFile = path.join(__dirname, "data", "state.json");
fs.mkdirSync(path.dirname(dataFile), { recursive: true });
if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, "{}");

app.get("/api/state", (_req, res) =>
  res.json(JSON.parse(fs.readFileSync(dataFile, "utf-8")))
);
app.post("/api/state", (req, res) => {
  fs.writeFileSync(dataFile, JSON.stringify(req.body ?? {}, null, 2));
  res.json({ ok: true });
});

const server = app.listen(PORT, () => {
  console.log(`\n  🪐  Universe is running\n      → http://localhost:${PORT}\n`);
});

// Wisp WebSocket endpoint — the transport backend Scramjet's epoxy client uses.
server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/wisp/")) wisp.routeRequest(req, socket, head);
  else socket.destroy();
});
