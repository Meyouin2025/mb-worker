// worker.js — MB Builder/Doctor backend (Cloudflare Worker)
// Bindings needed in wrangler.toml:
//  - R2_BUCKET binding: SITE
//  - VARS: ALLOW_ORIGINS='["https://mb.meyoustudios.com","https://<your>.pages.dev"]'
//  - Optional: PROVIDER, OPENAI_API_KEY, GROQ_API_KEY (for real generate-html later)

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    // --- CORS allowlist ---
    const origins = JSON.parse(env.ALLOW_ORIGINS || "[]");
    const origin = req.headers.get("Origin") || "";
    const allow = origins.includes(origin);

    // Handle preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(allow, origin) });
    }

    // Router
    try {
      if (url.pathname === "/api/ping") {
        return json({ ok: true, time: new Date().toISOString() }, allow, origin);
      }

      if (url.pathname === "/api/list" && req.method === "GET") {
        const prefix = url.searchParams.get("prefix") || "";
        const items = [];
        for await (const obj of env.SITE.list({ prefix })) {
          items.push({ key: obj.key, size: obj.size, uploaded: obj.uploaded?.toISOString?.() });
        }
        return json({ ok: true, items }, allow, origin);
      }

      if (url.pathname === "/api/read" && req.method === "GET") {
        const path = url.searchParams.get("path");
        if (!path) return json({ ok: false, error: "path required" }, allow, origin, 400);
        const obj = await env.SITE.get(path);
        if (!obj) return json({ ok: false, error: "not found" }, allow, origin, 404);
        const body = await obj.text();
        return new Response(body, { status: 200, headers: { ...corsHeaders(allow, origin), "Content-Type": contentType(path) } });
      }

      if (url.pathname === "/api/write" && req.method === "POST") {
        const { path, content } = await safeJson(req);
        if (!path) return json({ ok: false, error: "path required" }, allow, origin, 400);
        await env.SITE.put(path, content ?? "", { httpMetadata: { contentType: contentType(path) } });
        return json({ ok: true, path }, allow, origin);
      }

      if (url.pathname === "/api/apply-diff" && req.method === "POST") {
        // Minimal placeholder: accept complete file writes [{path, content}], or a unified diff later.
        const payload = await safeJson(req);
        if (Array.isArray(payload?.files)) {
          for (const f of payload.files) {
            if (!f.path) continue;
            await env.SITE.put(f.path, f.content ?? "", { httpMetadata: { contentType: contentType(f.path) } });
          }
          return json({ ok: true, applied: payload.files.length }, allow, origin);
        }
        // TODO: parse unified diff (git-style). For now error out if not files[]
        return json({ ok: false, error: "Provide files[] or unified diff (TODO)" }, allow, origin, 400);
      }

      if (url.pathname === "/api/generate-html" && req.method === "POST") {
        // Today: return a safe template stub. Later: call Llama/GPT based on env.PROVIDER
        const { prompt, section = "page" } = await safeJson(req);
        const html = `<!-- generated: ${section} -->
<section class="card">
  <h2>${escapeHtml(prompt || "New Section")}</h2>
  <p>This is a generated placeholder. Replace with model output when keys are set.</p>
</section>`;
        const css = `.card{background:#101a2e;border:1px solid #1f2e4f;border-radius:20px;padding:16px;color:#e8eefc}`;
        const js  = ``;
        return json({ ok: true, html, css, js }, allow, origin);
      }

      if (url.pathname === "/api/analyze-cors" && req.method === "POST") {
        const { url: target } = await safeJson(req);
        if (!target) return json({ ok: false, error: "url required" }, allow, origin, 400);
        let res;
        try {
          res = await fetch(target, { method: "GET" });
        } catch (e) {
          return json({ ok: false, error: "fetch_failed", detail: String(e) }, allow, origin, 502);
        }
        const headers = {};
        res.headers.forEach((v, k) => headers[k.toLowerCase()] = v);
        const suggestions = corsSuggestions(headers);
        return json({ ok: true, status: res.status, headers, suggestions }, allow, origin);
      }

      if (url.pathname === "/api/upload" && req.method === "POST") {
        const ct = req.headers.get("Content-Type") || "";
        if (!ct.startsWith("multipart/form-data")) {
          return json({ ok: false, error: "multipart/form-data required" }, allow, origin, 400);
        }
        const form = await req.formData();
        const file = form.get("file");
        if (!file || typeof file === "string") return json({ ok: false, error: "file required" }, allow, origin, 400);
        const key = `assets/${Date.now()}_${sanitize(file.name)}`;
        await env.SITE.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
        return json({ ok: true, key, url: `/assets/${key.split("/").pop()}` }, allow, origin);
      }

      if (url.pathname === "/api/deploy" && req.method === "POST") {
        // Stub: implement Pages Direct Upload or Git push later.
        return json({ ok: false, message: "Deploy not wired yet. Choose Pages Direct Upload or Git mode." }, allow, origin, 501);
      }

      return json({ ok: false, error: "Route not found" }, allow, origin, 404);
    } catch (err) {
      return json({ ok: false, error: "server_error", detail: String(err) }, allow, origin, 500);
    }
  }
};

function corsHeaders(allow, origin) {
  const h = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Max-Age": "86400",
  };
  if (allow) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
function json(obj, allow, origin, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(allow, origin), "Content-Type": "application/json" }
  });
}
function contentType(path) {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css"))  return "text/css; charset=utf-8";
  if (path.endsWith(".js"))   return "text/javascript; charset=utf-8";
  if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(path)) return "image/*";
  return "text/plain; charset=utf-8";
}
async function safeJson(req) {
  const txt = await req.text();
  return txt ? JSON.parse(txt) : {};
}
function sanitize(name="file"){ return name.replace(/[^a-zA-Z0-9._-]/g,"_"); }
function escapeHtml(s=""){ return s.replace(/[&<>\"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c])); }
function corsSuggestions(h) {
  const out = [];
  if (!h["access-control-allow-origin"]) out.push("Add Access-Control-Allow-Origin for your site origin (or reflect allowlist).");
  if (!h["access-control-allow-methods"]) out.push("Add Access-Control-Allow-Methods: GET,POST,OPTIONS.");
  if (!h["access-control-allow-headers"]) out.push("Add Access-Control-Allow-Headers: content-type, authorization.");
  return out.length ? out : ["CORS looks okay or target doesn’t support CORS (use server-to-server fetch)."];
}
