// A small stand-in for the browser DOM, just enough to run app.js in Node:
// an HTML parser, the CSS selectors app.js uses, events, and canvas stubs.

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const FOCUSABLE = new Set(["input", "button", "textarea", "select", "a"]);

export const decode = s =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m);
const escText = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = s => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const kebab = s => s.replace(/[A-Z]/g, c => "-" + c.toLowerCase());

export class Node {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; this._listeners = {}; }
  get parentElement() { return this.parentNode instanceof Element ? this.parentNode : null; }
  get isConnected() { let n = this; while (n) { if (n instanceof Document) return true; n = n.parentNode; } return false; }
  appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.childNodes.push(c); this.ownerDocument?._appended(c); return c; }
  remove() { const p = this.parentNode; if (!p) return; p.childNodes.splice(p.childNodes.indexOf(this), 1); this.parentNode = null; }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { const l = this._listeners[type]; if (l && l.includes(fn)) l.splice(l.indexOf(fn), 1); }
  get textContent() { return this.childNodes.map(c => c.textContent).join(""); }
  set textContent(v) { this._clear(); const s = String(v ?? ""); if (s) this.appendChild(new Text(this.ownerDocument, s)); }
  _clear() { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; }
}

export class Text extends Node {
  constructor(doc, data) { super(doc); this.data = data; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

export class Element extends Node {
  constructor(doc, tag) {
    super(doc);
    this.localName = tag.toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.attributes = [];
    const el = this;
    this.dataset = new Proxy({}, {
      get: (_, k) => (typeof k === "string" ? el.getAttribute("data-" + kebab(k)) ?? undefined : undefined),
      set: (_, k, v) => (el.setAttribute("data-" + kebab(k), v), true),
      deleteProperty: (_, k) => (el.removeAttribute("data-" + kebab(k)), true),
      has: (_, k) => el.hasAttribute("data-" + kebab(k)),
    });
    const props = () => (el.getAttribute("style") ?? "").split(";").map(s => s.trim()).filter(Boolean)
      .map(s => [s.slice(0, s.indexOf(":")).trim(), s.slice(s.indexOf(":") + 1).trim()]);
    this.style = new Proxy({}, {
      get: (_, k) => (k === "cssText" ? el.getAttribute("style") ?? "" : typeof k === "string" ? (props().find(([n]) => n === kebab(k)) || [])[1] ?? "" : undefined),
      set: (_, k, v) => {
        if (k === "cssText") { el.setAttribute("style", String(v)); return true; }
        const ps = props().filter(([n]) => n !== kebab(k));
        if (v !== "" && v != null) ps.push([kebab(k), String(v)]);
        el.setAttribute("style", ps.map(([n, x]) => `${n}:${x}`).join(";"));
        return true;
      },
    });
    const list = () => el.className.split(/\s+/).filter(Boolean);
    this.classList = {
      contains: c => list().includes(c),
      add: (...cs) => { el.className = [...list(), ...cs.filter(c => !list().includes(c))].join(" "); },
      remove: (...cs) => { el.className = list().filter(c => !cs.includes(c)).join(" "); },
      toggle: (c, force) => {
        const want = force === undefined ? !list().includes(c) : !!force;
        el.className = (want ? [...list().filter(x => x !== c), c] : list().filter(x => x !== c)).join(" ");
        return want;
      },
    };
  }
  getAttribute(n) { const a = this.attributes.find(a => a[0] === n); return a ? a[1] : null; }
  setAttribute(n, v) { const a = this.attributes.find(a => a[0] === n); if (a) a[1] = String(v); else this.attributes.push([n, String(v)]); }
  removeAttribute(n) { const i = this.attributes.findIndex(a => a[0] === n); if (i >= 0) this.attributes.splice(i, 1); }
  hasAttribute(n) { return this.attributes.some(a => a[0] === n); }
  _flag(n, v) { if (v) { if (!this.hasAttribute(n)) this.setAttribute(n, ""); } else this.removeAttribute(n); }
  get id() { return this.getAttribute("id") ?? ""; } set id(v) { this.setAttribute("id", v); }
  get className() { return this.getAttribute("class") ?? ""; } set className(v) { this.setAttribute("class", v); }
  get hidden() { return this.hasAttribute("hidden"); } set hidden(v) { this._flag("hidden", v); }
  get disabled() { return this.hasAttribute("disabled"); } set disabled(v) { this._flag("disabled", v); }
  get href() { return this.getAttribute("href") ?? ""; } set href(v) { this.setAttribute("href", v); }
  get download() { return this.getAttribute("download") ?? ""; } set download(v) { this.setAttribute("download", v); }
  get src() { return this.getAttribute("src") ?? ""; } set src(v) { this.setAttribute("src", v); }
  get width() { return Number(this.getAttribute("width") ?? 300); } set width(v) { this.setAttribute("width", v); }
  get height() { return Number(this.getAttribute("height") ?? 150); } set height(v) { this.setAttribute("height", v); }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.localName === "textarea") return this.textContent;
    if (this.localName === "select") {
      const opts = this.querySelectorAll("option"), o = opts.find(o => o.hasAttribute("selected")) || opts[0];
      return o ? o.getAttribute("value") ?? o.textContent : "";
    }
    return this.getAttribute("value") ?? "";
  }
  set value(v) { this._value = String(v ?? ""); }
  get checked() { return this._checked ?? this.hasAttribute("checked"); } set checked(v) { this._checked = !!v; }
  get children() { return this.childNodes.filter(c => c instanceof Element); }
  get nextElementSibling() {
    const sib = this.parentNode ? this.parentNode.childNodes : [];
    for (let i = sib.indexOf(this) + 1; i < sib.length; i++) if (sib[i] instanceof Element) return sib[i];
    return null;
  }
  get innerHTML() { return this.childNodes.map(serialize).join(""); }
  set innerHTML(html) { this._clear(); for (const n of parse(this.ownerDocument, String(html))) this.appendChild(n); }
  insertAdjacentHTML(pos, html) {
    const nodes = parse(this.ownerDocument, html);
    if (pos === "beforeend") return nodes.forEach(n => this.appendChild(n));
    if (pos !== "afterend") throw new Error("insertAdjacentHTML: " + pos);
    const p = this.parentNode; let i = p.childNodes.indexOf(this) + 1;
    for (const n of nodes) { n.parentNode = p; p.childNodes.splice(i++, 0, n); }
  }
  querySelectorAll(sel) { return selectAll(this, sel); }
  querySelector(sel) { return selectAll(this, sel)[0] ?? null; }
  matches(sel) { return parseSelector(sel).some(g => matchChain(this, g)); }
  closest(sel) { for (let n = this; n instanceof Element; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  focus() { this.ownerDocument._focus(this); }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument._focus(null); }
  select() { this._selected = true; }
  scrollIntoView() {}
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; }
  getContext() { return (this._ctx ||= makeContext(this)); }
  toDataURL(type = "image/png", q) {
    const ops = this._ctx ? this._ctx.ops.length : 0;
    return `data:${type};base64,` + Buffer.from(`${type}|${this.width}x${this.height}|ops ${ops}|q ${q ?? "-"}`).toString("base64");
  }
  toBlob(cb, type, q) { const b = new Blob([`${type}|${this.width}x${this.height}|q ${q}`], { type }); queueMicrotask(() => cb(b)); }
  // a programmatic click: the click event and the browser's default action
  click() {
    if (this.disabled && FOCUSABLE.has(this.localName)) return;
    const box = this.localName === "input" && this.getAttribute("type") === "checkbox";
    if (box) this.checked = !this.checked;
    const ev = fire(this, "click");
    if (ev.defaultPrevented) { if (box) this.checked = !this.checked; return; }
    if (box) fire(this, "change");
    if (this.localName === "a" && this.hasAttribute("download")) this.ownerDocument._env.download(this);
    const form = this.closest("form");
    if (form && this.localName === "button" && (this.getAttribute("type") ?? "submit") === "submit") fire(form, "submit");
  }
}

export class Document extends Node {
  constructor(env) {
    super(null);
    this.ownerDocument = this;
    this._env = env;
    this.visibilityState = "visible";
    this.documentElement = new Element(this, "html");
    this.head = new Element(this, "head");
    this.body = new Element(this, "body");
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this._active = null;
  }
  get activeElement() { return this._active && this._active.isConnected ? this._active : this.body; }
  _focus(el) {
    const prev = this.activeElement;
    if (prev === el) return;
    this._active = el;
    if (prev !== this.body) fire(prev, "blur", {}, false);
    if (el) fire(el, "focus", {}, false);
  }
  _appended(n) { if (n instanceof Element && n.localName === "script" && n.isConnected) this._env.loadScript(n); }
  createElement(tag) { return new Element(this, tag); }
  getElementById(id) { return walk(this.documentElement).find(e => e.getAttribute("id") === id) ?? null; }
  querySelectorAll(sel) { return selectAll(this.documentElement, sel, true); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

export function fire(target, type, init = {}, bubbles = true) {
  const env = (target.ownerDocument || target)._env;
  const ev = { type, target, defaultPrevented: false, _stop: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this._stop = true; }, ...init };
  for (let n = target; n; n = bubbles ? n.parentNode : null) {
    ev.currentTarget = n;
    for (const fn of [...(n._listeners[type] || [])]) {
      try {
        const r = fn.call(n, ev);
        if (r && typeof r.then === "function") r.catch(e => env.errors.push(e));
      } catch (e) { env.errors.push(e); }
    }
    if (ev._stop) break;
  }
  return ev;
}

function makeContext(canvas) {
  const ctx = { canvas, ops: [] };
  for (const op of ["beginPath", "arc", "fill", "moveTo", "lineTo", "stroke", "clearRect", "fillRect", "drawImage"])
    ctx[op] = (...a) => { ctx.ops.push(op); if (op === "clearRect") ctx.ops.length = 0; };
  return ctx;
}

/* ---------- parsing and serializing ---------- */
export function parse(doc, html) {
  const roots = [], stack = [];
  const add = n => { const p = stack[stack.length - 1]; if (p) { n.parentNode = p; p.childNodes.push(n); } else roots.push(n); };
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)/y, endRe = /<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/y, closeRe = /\s*\/?>/y;
  const attrRe = /\s*([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { add(new Text(doc, decode(html.slice(i)))); break; }
    if (lt > i) add(new Text(doc, decode(html.slice(i, lt))));
    i = lt;
    if (html.startsWith("<!--", i)) { const e = html.indexOf("-->", i); i = e < 0 ? html.length : e + 3; continue; }
    if (html.startsWith("<!", i)) { i = html.indexOf(">", i) + 1; continue; }
    endRe.lastIndex = i;
    let m = endRe.exec(html);
    if (m) {
      const k = stack.map(e => e.localName).lastIndexOf(m[1].toLowerCase());
      if (k >= 0) stack.length = k;
      i = endRe.lastIndex;
      continue;
    }
    tagRe.lastIndex = i;
    m = tagRe.exec(html);
    if (!m) { add(new Text(doc, "<")); i++; continue; }
    const el = new Element(doc, m[1]);
    i = tagRe.lastIndex;
    for (;;) {
      closeRe.lastIndex = i;
      if (closeRe.exec(html)) { i = closeRe.lastIndex; break; }
      attrRe.lastIndex = i;
      const a = attrRe.exec(html);
      if (!a) throw new Error("Could not parse tag near: " + html.slice(i, i + 60));
      const name = a[1].toLowerCase();
      if (!el.hasAttribute(name)) el.attributes.push([name, decode(a[2] ?? a[3] ?? a[4] ?? "")]);
      i = attrRe.lastIndex;
    }
    add(el);
    if (VOID.has(el.localName)) continue;
    if (RAW.has(el.localName)) {
      const end = new RegExp(`</${el.localName}\\s*>`, "ig");
      end.lastIndex = i;
      const e = end.exec(html), body = html.slice(i, e ? e.index : html.length);
      if (body) { const t = new Text(doc, el.localName === "script" || el.localName === "style" ? body : decode(body)); t.parentNode = el; el.childNodes.push(t); }
      i = e ? end.lastIndex : html.length;
      continue;
    }
    stack.push(el);
  }
  return roots;
}

function serialize(n) {
  if (n instanceof Text) return escText(n.data);
  const attrs = n.attributes.map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${escAttr(v)}"`)).join("");
  return VOID.has(n.localName) ? `<${n.localName}${attrs}>` : `<${n.localName}${attrs}>${n.childNodes.map(serialize).join("")}</${n.localName}>`;
}

// Readable, stable rendering of a subtree for snapshots: one tag per line, live form values,
// runs of HTML whitespace collapsed to one space (so indentation in templates does not matter).
export function pretty(node, ind = "") {
  const txt = s => JSON.stringify(s.replace(/[ \t\n\r\f]+/g, " "));
  if (node instanceof Text) return node.data ? [ind + txt(node.data)] : [];
  const attrs = node.attributes.map(a => [...a]);
  if (node.localName === "input") {
    const setA = (k, v) => { const a = attrs.find(a => a[0] === k); if (a) a[1] = v; else attrs.push([k, v]); };
    if (node._value !== undefined) setA("value", node._value);
    if (node._checked !== undefined) { const i = attrs.findIndex(a => a[0] === "checked"); if (node._checked && i < 0) attrs.push(["checked", ""]); if (!node._checked && i >= 0) attrs.splice(i, 1); }
  }
  const open = `${ind}<${node.localName}${attrs.map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${escAttr(v)}"`)).join("")}>`;
  if (VOID.has(node.localName)) return [open];
  const kids = node.localName === "textarea" ? (node.value ? [new Text(null, node.value)] : []) : node.childNodes;
  const close = `</${node.localName}>`;
  if (!kids.length) return [open + close];
  if (kids.length === 1 && kids[0] instanceof Text) return [open + txt(kids[0].data) + close];
  return [open, ...kids.flatMap(k => pretty(k, ind + "  ")), ind + close];
}

/* ---------- selectors: tag, #id, .class, [attr], [attr=value], :last-child, descendant, comma groups ---------- */
const cache = new Map();
function parseSelector(sel) {
  if (cache.has(sel)) return cache.get(sel);
  const groups = sel.split(",").map(g => g.trim().split(/\s+/).map(part => {
    const c = { tag: null, id: null, classes: [], attrs: [], last: false };
    const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|(:last-child)/y;
    let i = 0;
    while (i < part.length) {
      re.lastIndex = i;
      const m = re.exec(part);
      if (!m) throw new Error("Unsupported selector: " + sel);
      if (m[1]) c.tag = m[1].toLowerCase(); else if (m[2]) c.id = m[2]; else if (m[3]) c.classes.push(m[3]); else if (m[8]) c.last = true;
      else c.attrs.push([m[4], m[5] ?? m[6] ?? m[7]]);
      i = re.lastIndex;
    }
    return c;
  }));
  cache.set(sel, groups);
  return groups;
}
const matchOne = (el, c) => (!c.tag || el.localName === c.tag) && (!c.id || el.getAttribute("id") === c.id)
  && c.classes.every(x => el.classList.contains(x))
  && c.attrs.every(([k, v]) => (v === undefined ? el.hasAttribute(k) : el.getAttribute(k) === v))
  && (!c.last || (el.parentNode && el.parentNode.children && el.parentNode.children.at(-1) === el));
function matchChain(el, chain, root) {
  if (!matchOne(el, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  for (let n = el.parentNode; i >= 0 && n instanceof Element && n !== root; n = n.parentNode) if (matchOne(n, chain[i])) i--;
  return i < 0;
}
function walk(root, self) {
  const out = self ? [root] : [];
  const go = n => { for (const c of n.childNodes) if (c instanceof Element) { out.push(c); go(c); } };
  go(root);
  return out;
}
function selectAll(root, sel, self) {
  const groups = parseSelector(sel);
  return walk(root, self).filter(el => groups.some(g => matchChain(el, g)));
}
