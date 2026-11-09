/*
 * 이미지 푸리에 변환 도구
 *  - 이미지를 N×N으로 리샘플링 → 채널별 2D FFT
 *  - 스펙트럼(로그 크기, 중앙 정렬) 표시
 *  - 주파수 마스크 H(u,v)를 곱한 뒤 역 FFT → 결과 이미지
 * 모든 계산은 브라우저 안에서.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    pick: $('pick-step'), work: $('work-step'), input: $('file-input'), dropzone: $('dropzone'),
    views: $('views'), cvOrig: $('cv-orig'), cvSpec: $('cv-spec'), cvFiltered: $('cv-filtered'), cvResult: $('cv-result'),
    origSize: $('orig-size'), normNote: $('norm-note'),
    shapeCtrl: $('shape-ctrl'), drawCtrl: $('draw-ctrl'), widthRow: $('width-row'),
    rCut: $('r-cut'), rCutOut: $('r-cut-out'), rCutLabel: $('r-cut-label'), rWidth: $('r-width'), rWidthOut: $('r-width-out'),
    rBrush: $('r-brush'), rBrushOut: $('r-brush-out'),
    brushBlock: $('brush-block'), brushRestore: $('brush-restore'), brushReset: $('brush-reset'),
    save: $('save-btn'), errorBox: $('error-box'), errorText: $('error-text'),
    zoom: $('zoom'), zoomImg: $('zoom-img'), zoomTitle: $('zoom-title'),
  };

  const state = {
    img: null, // HTMLImageElement
    name: 'image',
    aspect: 1, // width / height
    n: 256,
    color: 'gray',
    pixels: null, // 채널별 Float64Array (0~255), 길이 n*n
    freq: null, // 채널별 { re, im } (FFT 결과, 원래 배치)
    specLog: null, // Float32Array (중앙 정렬) log(1+|F|)
    specMax: 1,
    mask: null, // Float32Array (중앙 정렬) 0~1
    drawMask: null, // 직접 그리기용 마스크 (중앙 정렬)
    brushMode: 'block',
  };

  // ---------- 컬러맵 (inferno 근사) ----------
  const LUT = (() => {
    const stops = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = (i / 255) * (stops.length - 1);
      const a = Math.floor(t);
      const b = Math.min(stops.length - 1, a + 1);
      const f = t - a;
      for (let c = 0; c < 3; c++) lut[i * 3 + c] = stops[a][c] + (stops[b][c] - stops[a][c]) * f;
    }
    return lut;
  })();

  // ---------- 설정값 ----------
  const radio = (name) => document.querySelector(`input[name="${name}"]:checked`).value;
  const filterType = () => radio('ftype');
  const filterShape = () => radio('fshape');

  function showError(msg) {
    els.errorText.textContent = msg;
    els.errorBox.classList.remove('hidden');
  }

  // ---------- 이미지 → 픽셀 ----------
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 열 수 없습니다.')); };
      img.src = url;
    });
  }

  function samplePixels() {
    const n = state.n;
    const c = document.createElement('canvas');
    c.width = n;
    c.height = n;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, n, n);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(state.img, 0, 0, n, n); // 비율은 화면 표시 때 원래대로 되돌림
    const d = ctx.getImageData(0, 0, n, n).data;
    const len = n * n;
    if (state.color === 'gray') {
      const g = new Float64Array(len);
      for (let i = 0; i < len; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
      state.pixels = [g];
    } else {
      const ch = [new Float64Array(len), new Float64Array(len), new Float64Array(len)];
      for (let i = 0; i < len; i++) { ch[0][i] = d[i * 4]; ch[1][i] = d[i * 4 + 1]; ch[2][i] = d[i * 4 + 2]; }
      state.pixels = ch;
    }
  }

  function forward() {
    const n = state.n;
    state.freq = state.pixels.map((p) => {
      const re = Float64Array.from(p);
      const im = new Float64Array(n * n);
      FFT.fft2d(re, im, n, false);
      return { re, im };
    });
    // 표시용 스펙트럼: 컬러면 휘도 가중합(선형이므로 휘도 이미지의 FFT와 같음)
    const w = state.freq.length === 3 ? [0.299, 0.587, 0.114] : [1];
    const spec = new Float32Array(n * n);
    let max = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        let re = 0;
        let im = 0;
        for (let c = 0; c < w.length; c++) { re += w[c] * state.freq[c].re[i]; im += w[c] * state.freq[c].im[i]; }
        const v = Math.log1p(Math.hypot(re, im));
        spec[shiftIndex(x, y, n)] = v;
        if (v > max) max = v;
      }
    }
    state.specLog = spec;
    state.specMax = max || 1;
  }

  // 원래 배치 (x,y) → 중앙 정렬 배치 인덱스
  function shiftIndex(x, y, n) {
    const h = n >> 1;
    return ((y + h) % n) * n + ((x + h) % n);
  }

  // ---------- 마스크 ----------
  function lowpass(d, c, shape) {
    if (shape === 'ideal') return d <= c ? 1 : 0;
    if (shape === 'gaussian') return Math.exp(-(d * d) / (2 * c * c));
    return 1 / (1 + Math.pow(d / c, 4)); // 버터워스 2차
  }

  function bandpass(d, c, w, shape) {
    const x = (d - c) / (w / 2);
    if (shape === 'ideal') return Math.abs(x) <= 1 ? 1 : 0;
    if (shape === 'gaussian') return Math.exp(-(x * x) / 2);
    return 1 / (1 + Math.pow(x, 4));
  }

  function buildMask() {
    const n = state.n;
    const type = filterType();
    if (type === 'draw') {
      if (!state.drawMask || state.drawMask.length !== n * n) state.drawMask = new Float32Array(n * n).fill(1);
      state.mask = state.drawMask;
      return;
    }
    const mask = new Float32Array(n * n);
    if (type === 'none') { mask.fill(1); state.mask = mask; return; }
    const shape = filterShape();
    const c = Math.max(0.005, els.rCut.value / 100);
    const w = Math.max(0.005, els.rWidth.value / 100);
    const h = n / 2;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const d = Math.hypot(x - h, y - h) / h; // 0(중앙)~1(나이퀴스트)~1.41(모서리)
        let v;
        if (type === 'low') v = lowpass(d, c, shape);
        else if (type === 'high') v = 1 - lowpass(d, c, shape);
        else if (type === 'bandpass') v = bandpass(d, c, w, shape);
        else v = 1 - bandpass(d, c, w, shape);
        mask[y * n + x] = v;
      }
    }
    state.mask = mask;
  }

  // ---------- 렌더링 ----------
  function setCanvas(cv, n, aspect) {
    if (cv.width !== n || cv.height !== n) { cv.width = n; cv.height = n; }
    cv.style.aspectRatio = String(aspect);
  }

  function drawPixels(cv, channels, lo = 0, hi = 255) {
    const n = state.n;
    setCanvas(cv, n, state.aspect);
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(n, n);
    const d = img.data;
    const scale = 255 / (hi - lo || 1);
    for (let i = 0; i < n * n; i++) {
      if (channels.length === 1) {
        const v = (channels[0][i] - lo) * scale;
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
      } else {
        d[i * 4] = (channels[0][i] - lo) * scale;
        d[i * 4 + 1] = (channels[1][i] - lo) * scale;
        d[i * 4 + 2] = (channels[2][i] - lo) * scale;
      }
      d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function drawSpectrum(cv, mask) {
    const n = state.n;
    setCanvas(cv, n, 1);
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(n, n);
    const d = img.data;
    const spec = state.specLog;
    const inv = 255 / state.specMax;
    for (let i = 0; i < n * n; i++) {
      let v = spec[i];
      // 필터 후: |F·H| 의 로그 = log(1 + (e^v - 1)·H)
      if (mask) v = Math.log1p(Math.expm1(v) * mask[i]);
      const k = Math.min(255, Math.max(0, Math.round(v * inv))) * 3;
      let r = LUT[k], g = LUT[k + 1], b = LUT[k + 2];
      if (mask && mask[i] < 0.999) {
        // 차단된 영역을 살짝 푸르게 표시해서 마스크 모양이 보이도록
        const m = 1 - mask[i];
        r = r * (1 - m) + 20 * m; g = g * (1 - m) + 40 * m; b = b * (1 - m) + 70 * m;
      }
      d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function inverse() {
    const n = state.n;
    const mask = state.mask;
    const len = n * n;
    // 마스크(중앙 정렬)를 원래 배치로 바꿔 둠
    const h = new Float32Array(len);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) h[y * n + x] = mask[shiftIndex(x, y, n)];

    const out = state.freq.map(({ re, im }) => {
      const r = new Float64Array(len);
      const i2 = new Float64Array(len);
      for (let i = 0; i < len; i++) { r[i] = re[i] * h[i]; i2[i] = im[i] * h[i]; }
      FFT.fft2d(r, i2, n, true);
      return r;
    });

    // 직류(DC) 성분이 크게 줄면 평균 밝기가 0 근처가 되므로 자동으로 대비를 맞춤
    const dc = mask[shiftIndex(0, 0, n)];
    if (dc < 0.5) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const ch of out) for (let i = 0; i < len; i++) { if (ch[i] < lo) lo = ch[i]; if (ch[i] > hi) hi = ch[i]; }
      drawPixels(els.cvResult, out, lo, hi);
      els.normNote.textContent = '※ 직류(평균 밝기) 성분이 제거되어 결과 밝기를 자동 보정(최소~최대 정규화)했어요.';
    } else {
      drawPixels(els.cvResult, out);
      els.normNote.textContent = '';
    }
  }

  let scheduled = false;
  let needForward = false;
  function update({ resample = false } = {}) {
    if (resample) needForward = true;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (!state.img) return;
      if (needForward) {
        needForward = false;
        samplePixels();
        forward();
        drawPixels(els.cvOrig, state.pixels);
        drawSpectrum(els.cvSpec, null);
      }
      buildMask();
      drawSpectrum(els.cvFiltered, state.mask);
      inverse();
    });
  }

  function syncControls() {
    const type = filterType();
    const preset = type !== 'none' && type !== 'draw';
    els.shapeCtrl.classList.toggle('hidden', !preset);
    els.drawCtrl.classList.toggle('hidden', type !== 'draw');
    els.views.classList.toggle('drawing', type === 'draw');
    const band = type === 'bandpass' || type === 'bandstop';
    els.widthRow.classList.toggle('hidden', !band);
    els.rCutLabel.textContent = band ? '중심 반경' : '차단 반경';
    els.rCutOut.textContent = `${els.rCut.value}%`;
    els.rWidthOut.textContent = `${els.rWidth.value}%`;
    els.rBrushOut.textContent = els.rBrush.value;
  }

  // ---------- 직접 그리기 ----------
  function paint(e) {
    const rect = els.cvFiltered.getBoundingClientRect();
    const n = state.n;
    const cx = ((e.clientX - rect.left) / rect.width) * n;
    const cy = ((e.clientY - rect.top) / rect.height) * n;
    const r = (Number(els.rBrush.value) / 256) * n;
    const mask = state.drawMask;
    const block = state.brushMode === 'block';
    const stamp = (px, py) => {
      const x0 = Math.max(0, Math.floor(px - r)), x1 = Math.min(n - 1, Math.ceil(px + r));
      const y0 = Math.max(0, Math.floor(py - r)), y1 = Math.min(n - 1, Math.ceil(py + r));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x + 0.5 - px, y + 0.5 - py) / r;
          if (d > 1) continue;
          const s = d < 0.6 ? 1 : 1 - (d - 0.6) / 0.4; // 가장자리는 부드럽게
          const i = y * n + x;
          mask[i] = block ? Math.min(mask[i], 1 - s) : Math.max(mask[i], s);
        }
      }
    };
    stamp(cx, cy);
    stamp(n + 1 - cx, n + 1 - cy); // 켤레 대칭(픽셀 k ↔ n-k) → 결과가 실수 이미지로 유지됨
    update();
  }

  let painting = false;
  els.cvFiltered.addEventListener('pointerdown', (e) => {
    if (filterType() !== 'draw') return;
    painting = true;
    els.cvFiltered.setPointerCapture(e.pointerId);
    paint(e);
    e.preventDefault();
  });
  els.cvFiltered.addEventListener('pointermove', (e) => { if (painting) paint(e); });
  ['pointerup', 'pointercancel'].forEach((t) => els.cvFiltered.addEventListener(t, () => { painting = false; }));

  function setBrush(mode) {
    state.brushMode = mode;
    els.brushBlock.setAttribute('aria-pressed', String(mode === 'block'));
    els.brushRestore.setAttribute('aria-pressed', String(mode === 'restore'));
  }
  els.brushBlock.addEventListener('click', () => setBrush('block'));
  els.brushRestore.addEventListener('click', () => setBrush('restore'));
  els.brushReset.addEventListener('click', () => { if (state.drawMask) state.drawMask.fill(1); update(); });

  // ---------- 확대 보기 ----------
  els.views.addEventListener('click', (e) => {
    const fig = e.target.closest('.view');
    if (!fig) return;
    if (fig.dataset.view === 'filtered' && filterType() === 'draw') return;
    const cv = fig.querySelector('canvas');
    els.zoomImg.src = cv.toDataURL();
    const a = Number(cv.style.aspectRatio) || 1;
    const maxW = window.innerWidth - 16;
    const maxH = window.innerHeight * 0.8;
    const w = Math.min(maxW, maxH * a);
    els.zoomImg.style.width = `${w}px`;
    els.zoomImg.style.height = `${w / a}px`;
    els.zoomTitle.textContent = fig.querySelector('figcaption').firstChild.textContent.trim();
    els.zoom.showModal();
  });
  els.zoom.addEventListener('click', (e) => { if (e.target === els.zoom) els.zoom.close(); });

  // ---------- 저장 ----------
  els.save.addEventListener('click', () => {
    const n = state.n;
    const w = state.aspect >= 1 ? n : Math.round(n * state.aspect);
    const h = state.aspect >= 1 ? Math.round(n / state.aspect) : n;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(els.cvResult, 0, 0, w, h);
    c.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${state.name}_fft-filtered.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }, 'image/png');
  });

  // ---------- 파일 ----------
  async function open(file) {
    if (!file) return;
    els.errorBox.classList.add('hidden');
    try {
      const img = await loadImage(file);
      state.img = img;
      state.name = file.name.replace(/\.[^.]+$/, '') || 'image';
      state.aspect = img.naturalWidth / img.naturalHeight;
      els.origSize.textContent = `${img.naturalWidth}×${img.naturalHeight}`;
      els.pick.classList.add('hidden');
      els.work.classList.remove('hidden');
      update({ resample: true });
    } catch (err) {
      showError(err.message);
    }
  }

  els.input.addEventListener('change', () => { open(els.input.files[0]); els.input.value = ''; });
  ['dragenter', 'dragover'].forEach((t) => els.dropzone.addEventListener(t, (e) => { e.preventDefault(); els.dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((t) => els.dropzone.addEventListener(t, () => els.dropzone.classList.remove('dragover')));
  els.dropzone.addEventListener('drop', (e) => { e.preventDefault(); open(e.dataTransfer.files[0]); });

  document.querySelectorAll('input[name="ftype"], input[name="fshape"]').forEach((r) => r.addEventListener('change', () => { syncControls(); update(); }));
  [els.rCut, els.rWidth].forEach((r) => r.addEventListener('input', () => { syncControls(); update(); }));
  els.rBrush.addEventListener('input', syncControls);
  document.querySelectorAll('input[name="size"]').forEach((r) => r.addEventListener('change', () => { state.n = Number(radio('size')); state.drawMask = null; update({ resample: true }); }));
  document.querySelectorAll('input[name="color"]').forEach((r) => r.addEventListener('change', () => { state.color = radio('color'); update({ resample: true }); }));

  syncControls();
})();
