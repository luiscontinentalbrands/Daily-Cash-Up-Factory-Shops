// Recording stand-in for jsPDF: every drawing call is logged, and output() returns that log,
// so a "PDF" can be compared line by line.
const short = s => (typeof s === "string" && s.startsWith("data:") ? s.slice(0, 40) + "…" : s);

export class jsPDF {
  constructor(opts = {}) {
    this.log = [["new", opts]];
    this._orient = opts.orientation === "landscape" ? "l" : "p";
    const self = this;
    this.internal = { pageSize: { getWidth: () => (self._orient === "l" ? 297 : 210), getHeight: () => (self._orient === "l" ? 210 : 297) } };
  }
  addPage(format, orientation) { this.log.push(["addPage", format, orientation]); if (orientation) this._orient = orientation[0]; return this; }
  splitTextToSize(text, width) {
    this.log.push(["splitTextToSize", text, width]);
    const max = Math.max(1, Math.floor(width / 2)), lines = [];
    let cur = "";
    for (const w of String(text).split(" ")) { if (cur && (cur + " " + w).length > max) { lines.push(cur); cur = w; } else cur = cur ? cur + " " + w : w; }
    lines.push(cur);
    return lines;
  }
  getImageProperties(data) { this.log.push(["getImageProperties", short(data)]); return /jpeg/.test(data) ? { width: 1200, height: 1600 } : { width: 600, height: 200 }; }
  addImage(data, ...rest) { this.log.push(["addImage", short(data), ...rest]); return this; }
  output(type) {
    const text = this.log.map(e => JSON.stringify(e)).join("\n");
    if (type === "blob") return new Blob([text], { type: "application/pdf" });
    if (type === "arraybuffer") return new TextEncoder().encode(text).buffer;
    return text;
  }
}
for (const op of ["setFont", "setFontSize", "setTextColor", "setFillColor", "roundedRect", "rect", "text", "setDrawColor", "setLineWidth", "line"])
  jsPDF.prototype[op] = function (...a) { this.log.push([op, ...a]); return this; };
