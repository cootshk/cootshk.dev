// This file is run as a Cloudflare Worker and handles the proxy (https://cootshk.dev/_/desmos/... => https://www.desmos.com/...)
//
// Deploy with a route of `cootshk.dev/_/desmos/*` (plus `cootshk.dev/*` if you want the
// referer-based fallback for stray root-relative subresource requests).
//
// How it works:
//   1. Server side, every text response (html/js/css/json/svg) has absolute desmos.com URLs
//      rewritten to /_/desmos/... , and HTML root-relative attributes get the prefix prepended.
//   2. Client side, a bootstrap script is injected at the very top of <head>. It patches
//      fetch / Request / XMLHttpRequest / Worker / SharedWorker / WebSocket / EventSource /
//      sendBeacon / importScripts / history / element src+href setters so that URLs built at
//      runtime (Desmos eval()s and blob-Workers a lot of its code) keep the prefix.
//      Blob Workers get the bootstrap source prepended to their body so the patches apply
//      inside the worker scope too.

const PREFIX = "/_/desmos"; // no trailing slash
const MAIN_HOST = "www.desmos.com";
const BOOTSTRAP_PATH = PREFIX + "/_proxy/bootstrap.js";
const HOST_SEGMENT = "/_h/"; // /_/desmos/_h/<other.desmos.com>/<path>

// Hosts we are willing to proxy. Everything else is left untouched.
const ALLOWED_HOST = /^(?:[a-z0-9-]+\.)*desmos\.com$/i;

const REWRITABLE = /^(?:text\/html|text\/css|text\/javascript|application\/javascript|application\/x-javascript|application\/ecmascript|text\/ecmascript|application\/json|application\/manifest\+json|image\/svg\+xml|text\/plain)/i;
const IS_JS = /^(?:text\/javascript|application\/javascript|application\/x-javascript|application\/ecmascript|text\/ecmascript)/i;

// Headers that must not be copied through, either because they describe the upstream
// transfer (CF already decoded it) or because they would block framing/rewritten assets.
const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "report-to",
  "nel",
  "expect-ct",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "alt-svc",
]);

const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "x-forwarded-proto",
  "x-real-ip",
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === BOOTSTRAP_PATH) {
      return new Response(buildBootstrap(url.origin), {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }

    const target = resolveTarget(url);
    if (!target) return fallback(request, url, env);

    return proxy(request, url, target);
  },
};

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

/** Map an incoming proxy URL onto the upstream URL it stands for, or null. */
function resolveTarget(url) {
  if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + "/")) return null;

  let rest = url.pathname.slice(PREFIX.length) || "/";
  let host = MAIN_HOST;

  if (rest.startsWith(HOST_SEGMENT)) {
    const tail = rest.slice(HOST_SEGMENT.length);
    const slash = tail.indexOf("/");
    host = (slash === -1 ? tail : tail.slice(0, slash)).toLowerCase();
    rest = slash === -1 ? "/" : tail.slice(slash);
    if (!ALLOWED_HOST.test(host)) return null;
  }

  return new URL("https://" + host + rest + url.search);
}

/**
 * Requests that escaped the prefix (a root-relative URL the parser fetched before our
 * patches ran) still carry a Referer pointing inside the proxy - bounce those back in.
 */
function fallback(request, url, env) {
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const ref = new URL(referer);
      if (ref.origin === url.origin && (ref.pathname === PREFIX || ref.pathname.startsWith(PREFIX + "/"))) {
        return Response.redirect(url.origin + PREFIX + url.pathname + url.search, 307);
      }
    } catch (_) {}
  }
  // Not ours: hand back to the zone's normal origin / static assets.
  if (env && env.ASSETS) return env.ASSETS.fetch(request);
  return fetch(request);
}

// ---------------------------------------------------------------------------
// proxying
// ---------------------------------------------------------------------------

async function proxy(request, url, target) {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const key = name.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(key)) continue;
    if (key === "origin") { headers.set("origin", target.origin); continue; }
    if (key === "referer") { headers.set("referer", unproxyUrl(value, url.origin) || target.origin + "/"); continue; }
    if (key === "accept-encoding") continue; // let the runtime negotiate
    headers.set(name, value);
  }
  headers.set("accept-encoding", "gzip");

  const upstream = await fetch(target.toString(), {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "manual",
  });

  const out = new Headers();
  for (const [name, value] of upstream.headers) {
    if (STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    if (name.toLowerCase() === "set-cookie") continue; // handled below
    out.set(name, value);
  }

  for (const cookie of upstream.headers.getSetCookie?.() ?? []) {
    out.append("set-cookie", rewriteCookie(cookie));
  }

  // Keeps the full path on same-origin subrequests (so the referer fallback can fire)
  // without leaking anything to third parties.
  out.set("referrer-policy", "same-origin");

  const location = upstream.headers.get("location");
  if (location) {
    out.set("location", rewriteText(new URL(location, target).toString(), url.origin));
  }

  const type = upstream.headers.get("content-type") || "";
  if (!REWRITABLE.test(type) || upstream.status === 204 || upstream.status === 304) {
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  }

  let body = await upstream.text();
  body = rewriteText(body, url.origin);
  if (/^text\/html/i.test(type)) body = rewriteHtml(body, url.origin);
  else if (/^text\/css/i.test(type)) body = rewriteCss(body);
  else if (IS_JS.test(type)) body = rewriteCssInJs(body);

  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

/** Re-home a cookie onto our own origin and scope it to the proxy prefix. */
function rewriteCookie(cookie) {
  return cookie
    .split(/;\s*/)
    .filter((part) => !/^domain=/i.test(part))
    .map((part) => (/^path=/i.test(part) ? "Path=" + PREFIX + part.slice(5).replace(/^\/?/, "/") : part))
    .join("; ");
}

/** Turn a proxied URL back into the upstream one (used for the outgoing Referer). */
function unproxyUrl(value, origin) {
  try {
    const u = new URL(value, origin);
    if (u.origin !== origin) return null;
    const target = resolveTarget(u);
    return target ? target.toString() : null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// content rewriting
// ---------------------------------------------------------------------------

// Matches `https://www.desmos.com`, `//www.desmos.com`, `wss://www.desmos.com` and the
// backslash-escaped `https:\/\/www.desmos.com` form that shows up inside JSON and JS strings.
const URL_RE = /(?<![\w:])(?:(https?|wss?):)?(\\?\/\\?\/)((?:[a-z0-9-]+\.)*desmos\.com)/gi;

function rewriteText(text, origin) {
  const secure = origin.startsWith("https:");
  const authority = origin.replace(/^https?:/, "").replace(/^\/\//, ""); // e.g. cootshk.dev

  return text.replace(URL_RE, (match, scheme, slashes, host) => {
    host = host.toLowerCase();
    if (!ALLOWED_HOST.test(host)) return match;

    const escaped = slashes.includes("\\");
    const sl = escaped ? "\\/" : "/";
    const path = (host === MAIN_HOST ? PREFIX : PREFIX + HOST_SEGMENT + host).split("/").join(sl);

    let proto = "";
    if (scheme === "ws" || scheme === "wss") proto = secure ? "wss:" : "ws:";
    else if (scheme) proto = secure ? "https:" : "http:";

    return proto + sl + sl + authority + path;
  });
}

/**
 * Root-relative `url(/assets/...)` and `@import "/..."` in stylesheets. The browser resolves
 * these against the stylesheet's own URL, so nothing client side ever sees them - they have
 * to be fixed here or the request lands on the bare origin (e.g. the dcg-icons woff2).
 */
function rewriteCss(css) {
  return css
    .replace(/url\(\s*(["']?)\/(?!\/)/gi, "url($1" + PREFIX + "/")
    .replace(/@import\s+(["'])\/(?!\/)/gi, "@import $1" + PREFIX + "/");
}

// Same idea for CSS that webpack's style-loader carries inside JS bundles. Deliberately
// stricter than rewriteCss: requiring a file extension keeps it off regex literals like
// `url(/foo/.test(x))`, which a bare `url(/` would happily corrupt.
function rewriteCssInJs(js) {
  return js.replace(
    /url\(\s*(\\?["']?)(\/(?!\/)[A-Za-z0-9_\-.\/~%+]*\.[A-Za-z0-9]{2,8}(?:\?[^)"'\s]*)?)\1\s*\)/g,
    (m, quote, path) => "url(" + quote + PREFIX + path + quote + ")"
  );
}

function rewriteHtml(html, origin) {
  return (
    html
      // Root-relative URLs in markup are fetched by the parser before our patches can run,
      // so they have to be fixed up here.
      .replace(/(\s(?:src|href|action|poster|data-src|formaction)\s*=\s*)(["'])\/(?!\/)/gi, "$1$2" + PREFIX + "/")
      .replace(/(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi, (m, lead, q, list) =>
        lead + q + list.replace(/(^|,\s*)\/(?!\/)/g, "$1" + PREFIX + "/") + q
      )
      // Inline stylesheets need the same url() treatment as external ones.
      .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, css, close) => open + rewriteCss(css) + close)
      .replace(/(\sstyle\s*=\s*)(["'])([^"']*)\2/gi, (m, lead, q, css) => lead + q + rewriteCss(css) + q)
      // Our rewrites invalidate any subresource-integrity hashes.
      .replace(/\sintegrity\s*=\s*(["'])[^"']*\1/gi, "")
      .replace(/\snonce\s*=\s*(["'])[^"']*\1/gi, "")
      // Inject the bootstrap as the first thing in the document.
      .replace(
        /<head([^>]*)>/i,
        (m) => m + '<script src="' + origin + BOOTSTRAP_PATH + '"></script>'
      )
  );
}

// ---------------------------------------------------------------------------
// client-side bootstrap
// ---------------------------------------------------------------------------

const bootstrapCache = new Map();

function buildBootstrap(origin) {
  let src = bootstrapCache.get(origin);
  if (!src) {
    const cfg = {
      prefix: PREFIX,
      origin,
      main: MAIN_HOST,
      hostSegment: HOST_SEGMENT,
      bootstrap: origin + BOOTSTRAP_PATH,
    };
    src = "(" + clientBootstrap.toString() + ")(" + JSON.stringify(cfg) + ");\n";
    bootstrapCache.set(origin, src);
  }
  return src;
}

/**
 * Serialized with Function.prototype.toString and served at BOOTSTRAP_PATH, so it must be
 * completely self-contained - no references to anything in this module's scope.
 *
 * Runs in both window and (Dedicated/Shared)WorkerGlobalScope.
 */
function clientBootstrap(cfg) {
  var g = typeof self !== "undefined" ? self : this;
  if (g.__desmosProxyInstalled) return;
  g.__desmosProxyInstalled = true;

  var PREFIX = cfg.prefix;
  var ORIGIN = cfg.origin;
  var MAIN = cfg.main;
  var HOST_SEG = cfg.hostSegment;
  var BOOT_URL = cfg.bootstrap;
  var BASE = ORIGIN + PREFIX + "/";
  var SECURE = ORIGIN.slice(0, 6) === "https:";
  var AUTHORITY = ORIGIN.replace(/^https?:\/\//, "");

  var isWorker =
    typeof WorkerGlobalScope !== "undefined" && typeof g.importScripts === "function";

  var _XHR = g.XMLHttpRequest;

  function base() {
    if (!isWorker && typeof document !== "undefined" && document.baseURI) return document.baseURI;
    return BASE;
  }

  function isDesmos(host) {
    return /^(?:[a-z0-9-]+\.)*desmos\.com$/i.test(host);
  }

  function proxied(u) {
    var host = u.hostname.toLowerCase();
    var path = host === MAIN ? PREFIX : PREFIX + HOST_SEG + host;
    var ws = u.protocol === "ws:" || u.protocol === "wss:";
    var proto = ws ? (SECURE ? "wss:" : "ws:") : SECURE ? "https:" : "http:";
    return proto + "//" + AUTHORITY + path + u.pathname + u.search + u.hash;
  }

  // The one function everything below funnels through.
  function rw(input) {
    try {
      if (input === null || input === undefined) return input;
      if (typeof URL !== "undefined" && input instanceof URL) input = input.href;
      var u = String(input);
      if (u === "" || u.charAt(0) === "#") return input;
      if (/^(?:blob:|data:|about:|javascript:|mailto:|tel:|filesystem:)/i.test(u)) return input;

      var abs = new URL(u, base());

      if (abs.origin === ORIGIN) {
        // Already inside the proxy? Leave it. Otherwise it is a root-relative Desmos path
        // that resolved against our own origin and needs the prefix put back on.
        if (abs.pathname === PREFIX || abs.pathname.indexOf(PREFIX + "/") === 0) return input;
        return ORIGIN + PREFIX + abs.pathname + abs.search + abs.hash;
      }
      if (isDesmos(abs.hostname)) return proxied(abs);
      return input;
    } catch (e) {
      return input;
    }
  }

  g.__desmosProxyRewrite = rw;

  function wrapConstructor(name, rewriteArgs) {
    var C = g[name];
    if (typeof C !== "function") return;
    g[name] = new Proxy(C, {
      construct: function (Target, args, newTarget) {
        try {
          args = rewriteArgs(args) || args;
        } catch (e) {}
        return Reflect.construct(Target, args, newTarget === g[name] ? Target : newTarget);
      },
    });
  }

  // --- fetch / Request -----------------------------------------------------
  var _Request = g.Request;

  if (typeof g.fetch === "function") {
    var _fetch = g.fetch;
    g.fetch = function (input, init) {
      try {
        if (_Request && input instanceof _Request) {
          var next = rw(input.url);
          if (next !== input.url) input = new _Request(next, input);
        } else {
          input = rw(input);
        }
      } catch (e) {}
      return _fetch.call(this, input, init);
    };
  }

  wrapConstructor("Request", function (args) {
    if (args.length && (typeof args[0] === "string" || (typeof URL !== "undefined" && args[0] instanceof URL))) {
      args[0] = rw(args[0]);
    } else if (args.length && _Request && args[0] instanceof _Request) {
      var next = rw(args[0].url);
      if (next !== args[0].url) args[0] = new _Request(next, args[0]);
    }
    return args;
  });

  // --- XHR -----------------------------------------------------------------
  if (_XHR && _XHR.prototype && _XHR.prototype.open) {
    var _open = _XHR.prototype.open;
    _XHR.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      if (args.length > 1) args[1] = rw(args[1]);
      return _open.apply(this, args);
    };
  }

  // --- sockets / beacons ---------------------------------------------------
  ["WebSocket", "EventSource"].forEach(function (name) {
    wrapConstructor(name, function (args) {
      if (args.length) args[0] = rw(args[0]);
      return args;
    });
  });

  if (g.navigator && typeof g.navigator.sendBeacon === "function") {
    var _beacon = g.navigator.sendBeacon.bind(g.navigator);
    g.navigator.sendBeacon = function (url, data) {
      return _beacon(rw(url), data);
    };
  }

  // --- Workers -------------------------------------------------------------
  // Desmos hands blob: URLs to `new Worker(...)`; splice our own source in front of the
  // blob body so fetch/importScripts are patched inside the worker too.
  var bootSource = null;

  function readSync(url) {
    var xhr = new _XHR();
    xhr.open("GET", url, false);
    xhr.send();
    return xhr.responseText;
  }

  function boot() {
    if (bootSource === null) {
      try {
        bootSource = readSync(BOOT_URL);
      } catch (e) {
        bootSource = "";
      }
    }
    return bootSource;
  }

  ["Worker", "SharedWorker"].forEach(function (name) {
    wrapConstructor(name, function (args) {
      var url = args[0];
      var isModule = args[1] && args[1].type === "module";
      var body;

      if (typeof url === "string" && url.slice(0, 5) === "blob:") {
        body = boot() + "\n;\n" + readSync(url);
      } else {
        var real = rw(url);
        body = isModule
          ? boot() + "\nawait import(" + JSON.stringify(String(real)) + ");\n"
          : boot() + "\nimportScripts(" + JSON.stringify(String(real)) + ");\n";
      }

      args[0] = URL.createObjectURL(new Blob([body], { type: "text/javascript" }));
      return args;
    });
  });

  if (isWorker && typeof g.importScripts === "function") {
    var _importScripts = g.importScripts;
    g.importScripts = function () {
      return _importScripts.apply(g, Array.prototype.map.call(arguments, rw));
    };
  }

  if (isWorker) return; // everything below is document-only

  // --- service workers -----------------------------------------------------
  // A service worker would install its own unprefixed routing; not worth the trouble.
  if (g.navigator && g.navigator.serviceWorker && g.navigator.serviceWorker.register) {
    g.navigator.serviceWorker.register = function () {
      return Promise.reject(new Error("service workers are disabled behind the desmos proxy"));
    };
  }

  // --- navigation ----------------------------------------------------------
  if (g.history) {
    ["pushState", "replaceState"].forEach(function (method) {
      var original = g.history[method];
      if (typeof original !== "function") return;
      g.history[method] = function (state, title, url) {
        if (arguments.length < 3 || url === null || url === undefined) {
          return original.call(g.history, state, title);
        }
        return original.call(g.history, state, title, rw(url));
      };
    });
  }

  if (typeof g.open === "function") {
    var _windowOpen = g.open;
    g.open = function () {
      var args = Array.prototype.slice.call(arguments);
      if (args.length) args[0] = rw(args[0]);
      return _windowOpen.apply(g, args);
    };
  }

  // --- element URL properties ---------------------------------------------
  [
    ["HTMLScriptElement", "src"],
    ["HTMLImageElement", "src"],
    ["HTMLLinkElement", "href"],
    ["HTMLIFrameElement", "src"],
    ["HTMLSourceElement", "src"],
    ["HTMLMediaElement", "src"],
    ["HTMLEmbedElement", "src"],
    ["HTMLTrackElement", "src"],
    ["HTMLObjectElement", "data"],
    ["HTMLAnchorElement", "href"],
    ["HTMLFormElement", "action"],
    ["HTMLBaseElement", "href"],
  ].forEach(function (pair) {
    var C = g[pair[0]];
    var key = pair[1];
    if (!C || !C.prototype) return;
    var desc = Object.getOwnPropertyDescriptor(C.prototype, key);
    if (!desc || !desc.set || !desc.configurable) return;
    Object.defineProperty(C.prototype, key, {
      configurable: true,
      enumerable: desc.enumerable,
      get: function () {
        return desc.get.call(this);
      },
      set: function (value) {
        desc.set.call(this, rw(value));
      },
    });
  });

  if (g.Element && g.Element.prototype.setAttribute) {
    var URL_ATTRS = { src: 1, href: 1, action: 1, data: 1, poster: 1, formaction: 1 };
    var _setAttribute = g.Element.prototype.setAttribute;
    g.Element.prototype.setAttribute = function (name, value) {
      if (name && URL_ATTRS[String(name).toLowerCase()]) value = rw(value);
      return _setAttribute.call(this, name, value);
    };
  }
}
