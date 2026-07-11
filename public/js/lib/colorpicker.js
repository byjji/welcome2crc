/* ============================================================
   lib/colorpicker.js — HSV 원형 색상환 + 명도 슬라이더
   ------------------------------------------------------------
   createColorWheel(canvas, brightInput, onPick)
     canvas      : 색상환을 그릴 <canvas>
     brightInput : 명도 조절 <input type="range" min=0 max=100>
     onPick(hex) : 색이 바뀔 때마다 호출 (#rrggbb)
   반환: { setFromHex(hex) } — 프리셋 등에서 색을 밀어넣을 때 사용
   외부 라이브러리 없이 캔버스만으로 구현 (CSP 안전).
   ============================================================ */

export function createColorWheel(canvas, brightInput, onPick) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2, R = Math.min(cx, cy) - 1;

  let hue = 0;   // 0~360 (각도)
  let sat = 0;   // 0~1   (중심=0, 가장자리=1)
  let val = 1;   // 0~1   (명도)
  let cache = null; // 현재 명도의 색상환 이미지 (명도 바뀔 때만 다시 그림)

  function hsv2rgb(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }

  function toHex() {
    const [r, g, b] = hsv2rgb(hue, sat, val);
    return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
  }

  function hexToHsv(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, max === 0 ? 0 : d / max, max];
  }

  // 현재 명도(val)로 색상환 이미지를 만들어 캐시
  function renderWheel() {
    const img = ctx.createImageData(W, H);
    const d = img.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = x - cx, dy = y - cy, dist = Math.sqrt(dx * dx + dy * dy);
        const i = (y * W + x) * 4;
        if (dist <= R) {
          let h = Math.atan2(dy, dx) * 180 / Math.PI; if (h < 0) h += 360;
          const [r, g, b] = hsv2rgb(h, dist / R, val);
          d[i] = r; d[i + 1] = g; d[i + 2] = b;
          d[i + 3] = dist > R - 1.5 ? Math.round((R - dist) / 1.5 * 255) : 255; // 가장자리 부드럽게
        }
      }
    }
    cache = img;
  }

  // 캐시된 색상환 + 현재 위치 마커를 그림
  function paint() {
    if (!cache) renderWheel();
    ctx.putImageData(cache, 0, 0);
    const ang = hue * Math.PI / 180, r = sat * R;
    const mx = cx + r * Math.cos(ang), my = cy + r * Math.sin(ang);
    ctx.beginPath();
    ctx.arc(mx, my, 6, 0, Math.PI * 2);
    ctx.lineWidth = 2.5; ctx.strokeStyle = "#fff"; ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(0,0,0,0.45)"; ctx.stroke();
  }

  function pickAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * (W / rect.width);
    const y = (clientY - rect.top) * (H / rect.height);
    const dx = x - cx, dy = y - cy;
    let dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > R) dist = R;
    let h = Math.atan2(dy, dx) * 180 / Math.PI; if (h < 0) h += 360;
    hue = h; sat = dist / R;
    paint();
    onPick(toHex());
  }

  let dragging = false;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    pickAt(e.clientX, e.clientY);
  });
  canvas.addEventListener("pointermove", (e) => { if (dragging) pickAt(e.clientX, e.clientY); });
  canvas.addEventListener("pointerup", () => { dragging = false; });
  canvas.addEventListener("pointercancel", () => { dragging = false; });

  brightInput.addEventListener("input", () => {
    val = Math.max(0, Math.min(100, Number(brightInput.value))) / 100;
    renderWheel();
    paint();
    onPick(toHex());
  });

  function setFromHex(hex) {
    const [h, s, v] = hexToHsv(hex);
    hue = h; sat = s; val = v;
    brightInput.value = Math.round(v * 100);
    renderWheel();
    paint();
    onPick(toHex());
  }

  renderWheel();
  paint();
  return { setFromHex };
}
