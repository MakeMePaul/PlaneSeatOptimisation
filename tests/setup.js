import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

document.body.innerHTML = readFileSync(join(root, "tests/fixtures/aeroboard-dom.html"), "utf8");

const win = /** @type {Window & typeof globalThis} */ (globalThis.window || globalThis);
const noop = () => {};
function createMockCanvas2d() {
  return {
    clearRect: noop,
    fillRect: noop,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
    beginPath: noop,
    rect: noop,
    fill: noop,
    stroke: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fillText: noop,
    strokeText: noop,
  };
}
const origGetContext = win.HTMLCanvasElement.prototype.getContext;
win.HTMLCanvasElement.prototype.getContext = function patchedGetContext(type, ...rest) {
  if (type === "2d") {
    return /** @type {CanvasRenderingContext2D} */ (/** @type {unknown} */ (createMockCanvas2d()));
  }
  return origGetContext ? origGetContext.call(this, type, ...rest) : null;
};

function injectScript(relativePath) {
  const code = readFileSync(join(root, relativePath), "utf8");
  const script = document.createElement("script");
  script.textContent = code;
  document.head.appendChild(script);
}

injectScript("algorithms.js");
injectScript("app.js");
