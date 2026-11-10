/*
 * 파놉틱 세그멘테이션
 *  - MaskFormer(Swin-Tiny, COCO 파놉틱 133종)를 브라우저에서 실행 (seg.worker.js, transformers.js)
 *  - 모든 픽셀을 물체(사람·자동차 등 80종, 개체별 구분) 또는 배경(하늘·벽 등 53종)으로 나눈 결과를 표시
 */
(() => {
  'use strict';

  const MAX_SIDE = 768; // 분석·표시 해상도(긴 변)

  // COCO 파놉틱: 물체(things) 80종 — 나머지는 배경(stuff)
  const THINGS = new Set(['person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
    'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear',
    'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
    'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle', 'wine glass', 'cup', 'fork',
    'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake',
    'chair', 'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard',
    'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear',
    'hair drier', 'toothbrush']);

  const KO = {
    person: '사람', bicycle: '자전거', car: '자동차', motorcycle: '오토바이', airplane: '비행기', bus: '버스', train: '기차',
    truck: '트럭', boat: '배', 'traffic light': '신호등', 'fire hydrant': '소화전', 'stop sign': '정지 표지판',
    'parking meter': '주차 미터기', bench: '벤치', bird: '새', cat: '고양이', dog: '개', horse: '말', sheep: '양', cow: '소',
    elephant: '코끼리', bear: '곰', zebra: '얼룩말', giraffe: '기린', backpack: '배낭', umbrella: '우산', handbag: '핸드백',
    tie: '넥타이', suitcase: '여행가방', frisbee: '원반', skis: '스키', snowboard: '스노보드', 'sports ball': '공', kite: '연',
    'baseball bat': '야구방망이', 'baseball glove': '야구글러브', skateboard: '스케이트보드', surfboard: '서핑보드',
    'tennis racket': '테니스라켓', bottle: '병', 'wine glass': '와인잔', cup: '컵', fork: '포크', knife: '칼', spoon: '숟가락',
    bowl: '그릇', banana: '바나나', apple: '사과', sandwich: '샌드위치', orange: '오렌지', broccoli: '브로콜리', carrot: '당근',
    'hot dog': '핫도그', pizza: '피자', donut: '도넛', cake: '케이크', chair: '의자', couch: '소파', 'potted plant': '화분',
    bed: '침대', 'dining table': '식탁', toilet: '변기', tv: 'TV', laptop: '노트북', mouse: '마우스', remote: '리모컨',
    keyboard: '키보드', 'cell phone': '휴대폰', microwave: '전자레인지', oven: '오븐', toaster: '토스터', sink: '싱크대',
    refrigerator: '냉장고', book: '책', clock: '시계', vase: '꽃병', scissors: '가위', 'teddy bear': '곰인형',
    'hair drier': '드라이기', toothbrush: '칫솔',
    banner: '현수막', blanket: '담요', bridge: '다리', cardboard: '골판지', counter: '조리대', curtain: '커튼', 'door-stuff': '문',
    'floor-wood': '나무 바닥', flower: '꽃', fruit: '과일', gravel: '자갈', house: '집', light: '조명', 'mirror-stuff': '거울',
    net: '그물', pillow: '베개', platform: '승강장', playingfield: '경기장', railroad: '철로', river: '강', road: '도로',
    roof: '지붕', sand: '모래', sea: '바다', shelf: '선반', snow: '눈', stairs: '계단', tent: '텐트', towel: '수건',
    'wall-brick': '벽돌 벽', 'wall-stone': '돌벽', 'wall-tile': '타일 벽', 'wall-wood': '나무 벽', 'water-other': '물',
    'window-blind': '블라인드', 'window-other': '창문', 'tree-merged': '나무', 'fence-merged': '울타리', 'ceiling-merged': '천장',
    'sky-other-merged': '하늘', 'cabinet-merged': '수납장', 'table-merged': '테이블', 'floor-other-merged': '바닥',
    'pavement-merged': '포장도로', 'mountain-merged': '산', 'grass-merged': '풀밭', 'dirt-merged': '흙', 'paper-merged': '종이',
    'food-other-merged': '음식', 'building-other-merged': '건물', 'rock-merged': '바위', 'wall-other-merged': '벽',
    'rug-merged': '러그',
  };
  const labelOf = (t) => KO[t] || t.replace(/-(merged|other|stuff)/g, '');

  const $ = (id) => document.getElementById(id);
  const els = {
    input: $('file-input'), dropzone: $('dropzone'), pick: $('pick-step'), work: $('work-step'),
    cv: $('cv'), loading: $('loading'), loadingText: $('loading-text'), progress: $('progress'), progressBar: $('progress-bar'),
    rAlpha: $('r-alpha'), rAlphaOut: $('r-alpha-out'),
    legend: $('legend'), legendEmpty: $('legend-empty'), segCount: $('seg-count'), timing: $('timing'),
    save: $('save-btn'), errorBox: $('error-box'), errorText: $('error-text'),
  };

  const state = {
    image: null, // 분석·표시용 캔버스 (긴 변 MAX_SIDE 이하)
    name: 'image',
    segments: [],
    labels: null, // Int32Array(w*h), -1 = 없음
    selected: -1,
    opts: { labels: true, borders: true, original: false },
    busy: false,
  };

  function showError(msg) {
    els.errorText.textContent = msg;
    els.errorBox.classList.remove('hidden');
  }
  function hideError() { els.errorBox.classList.add('hidden'); }

  function setProgress(text, ratio) {
    els.loadingText.textContent = text;
    els.progress.classList.toggle('hidden', ratio == null);
    if (ratio != null) els.progressBar.style.width = `${Math.round(Math.min(1, ratio) * 100)}%`;
  }

  // ---------- 이미지 ----------
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 열 수 없습니다.')); };
      img.src = url;
    });
  }

  function shrink(img) {
    const s = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  // ---------- 분석 (워커) ----------
  let worker = null;
  function runWorker(canvas) {
    if (!worker) worker = new Worker('seg.worker.js?v=20261110d', { type: 'module' });
    const { width, height } = canvas;
    const rgba = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
    return new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') setProgress(`모델 내려받는 중 ${(m.loaded / 1048576).toFixed(0)} / ${(m.total / 1048576).toFixed(0)}MB`, m.loaded / m.total);
        else if (m.type === 'stage') setProgress(m.text, null);
        else if (m.type === 'result') resolve(m);
        else if (m.type === 'error') reject(new Error(m.message));
      };
      worker.onerror = (e) => { worker = null; reject(new Error(e.message || '분석 모듈을 불러오지 못했어요.')); };
      worker.postMessage({ type: 'run', rgba, width, height }, [rgba.buffer]);
    });
  }

  async function analyze() {
    if (!state.image || state.busy) return;
    hideError();
    state.busy = true;
    els.loading.classList.remove('hidden');
    els.timing.textContent = '';
    setProgress('준비 중…', null);
    try {
      const res = await runWorker(state.image);
      compose(res.segments);
      const t = res.timings;
      els.timing.textContent = `기기에서 처리 · 분석 ${(t.infer / 1000).toFixed(1)}초`
        + (t.load > 1500 ? ` · 모델 준비 ${(t.load / 1000).toFixed(1)}초` : '');
    } catch (err) {
      console.error(err);
      let msg = (err && err.message) || String(err);
      if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(msg)) msg = `모델을 내려받지 못했어요. 인터넷 연결을 확인해주세요. (${msg})`;
      else if (/memory|allocation|RangeError/i.test(msg)) msg = `기기 메모리가 부족해요. 다른 앱을 닫고 다시 시도해주세요. (${msg})`;
      showError(msg);
    } finally {
      state.busy = false;
      els.loading.classList.add('hidden');
      els.progress.classList.add('hidden');
    }
  }

  // ---------- 결과 정리 ----------
  function compose(raw) {
    const w = state.image.width, h = state.image.height;
    const labels = new Int32Array(w * h).fill(-1);
    const segs = raw.map((r, id) => ({ id, label: r.label, kind: THINGS.has(r.label) ? 'thing' : 'stuff', confidence: r.score ?? 1 }));
    raw.forEach((r, id) => {
      const xm = new Int32Array(w);
      for (let x = 0; x < w; x++) xm[x] = Math.min(r.w - 1, Math.floor(((x + 0.5) * r.w) / w));
      for (let y = 0; y < h; y++) {
        const my = Math.min(r.h - 1, Math.floor(((y + 0.5) * r.h) / h)) * r.w;
        const row = y * w;
        for (let x = 0; x < w; x++) if (r.mask[my + xm[x]]) labels[row + x] = id;
      }
    });

    // 면적·라벨 위치 (가려져서 사라진 영역은 제거)
    const area = new Float64Array(segs.length);
    const sx = new Float64Array(segs.length), sy = new Float64Array(segs.length);
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i];
      if (l < 0) continue;
      area[l]++; sx[l] += i % w; sy[l] += (i / w) | 0;
    }
    const remap = new Int32Array(segs.length).fill(-1);
    const kept = [];
    segs.forEach((s, i) => {
      if (area[i] < 1) return;
      remap[i] = kept.length;
      kept.push({ ...s, id: kept.length, area: area[i] / (w * h), cx: sx[i] / area[i], cy: sy[i] / area[i] });
    });
    for (let i = 0; i < labels.length; i++) if (labels[i] >= 0) labels[i] = remap[labels[i]];

    // 오목한 영역은 무게중심이 밖에 있을 수 있어 영역 안 가장 가까운 점에 라벨 배치
    const best = kept.map(() => ({ d: Infinity, x: 0, y: 0 }));
    for (let i = 0; i < labels.length; i += 2) {
      const l = labels[i];
      if (l < 0) continue;
      const x = i % w, y = (i / w) | 0;
      const d = (x - kept[l].cx) ** 2 + (y - kept[l].cy) ** 2;
      if (d < best[l].d) best[l] = { d, x, y };
    }
    kept.forEach((s, i) => { s.lx = best[i].x; s.ly = best[i].y; });

    // 같은 종류 물체는 왼쪽부터 1, 2, 3…
    const byLabel = new Map();
    kept.filter((s) => s.kind === 'thing').forEach((s) => byLabel.set(s.label, [...(byLabel.get(s.label) || []), s]));
    for (const list of byLabel.values()) list.sort((a, b) => a.cx - b.cx).forEach((s, i) => { s.n = i + 1; s.total = list.length; });

    // 색: 물체는 개체마다, 배경은 종류마다 고정 (배경은 차분하게)
    kept.forEach((s, i) => {
      const hue = s.kind === 'thing' ? (i * 137.508) % 360 : hashHue(s.label);
      s.color = hsl(hue, s.kind === 'thing' ? 0.85 : 0.45, s.kind === 'thing' ? 0.55 : 0.5);
    });

    state.segments = kept;
    state.labels = labels;
    state.selected = -1;
    renderLegend();
    render();
  }

  function hashHue(s) {
    let h = 0;
    for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h % 360;
  }

  function hsl(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
    return [f(0), f(8), f(4)];
  }

  // ---------- 그리기 ----------
  function render() {
    if (!state.image) return;
    const w = state.image.width, h = state.image.height;
    const cv = els.cv;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(state.image, 0, 0);
    if (!state.labels || state.opts.original) return;

    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const labels = state.labels;
    const alpha = els.rAlpha.value / 100;
    const sel = state.selected;
    const segs = state.segments;
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i];
      const p = i * 4;
      if (sel >= 0 && l !== sel) { // 선택한 영역 외에는 어둡게
        d[p] *= 0.35; d[p + 1] *= 0.35; d[p + 2] *= 0.35;
        continue;
      }
      if (l < 0) continue;
      const c = segs[l].color;
      const x = i % w;
      const edge = state.opts.borders && (
        (x + 1 < w && labels[i + 1] !== l) || (x > 0 && labels[i - 1] !== l) ||
        (i + w < labels.length && labels[i + w] !== l) || (i >= w && labels[i - w] !== l));
      if (edge) { d[p] = 255; d[p + 1] = 255; d[p + 2] = 255; continue; }
      d[p] += (c[0] - d[p]) * alpha;
      d[p + 1] += (c[1] - d[p + 1]) * alpha;
      d[p + 2] += (c[2] - d[p + 2]) * alpha;
    }
    ctx.putImageData(img, 0, 0);

    if (state.opts.labels) {
      const fs = Math.max(11, Math.round(Math.max(w, h) / 50));
      ctx.font = `600 ${fs}px -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const s of segs) {
        if (sel >= 0 && s.id !== sel) continue;
        if (s.area < 0.004 && sel < 0) continue; // 너무 작은 영역은 라벨 생략
        const text = segName(s);
        const tw = ctx.measureText(text).width;
        const pad = fs * 0.35;
        const bx = Math.min(Math.max(s.lx - tw / 2 - pad, 0), w - tw - pad * 2);
        const by = Math.min(Math.max(s.ly - fs * 0.7, 0), h - fs * 1.4);
        ctx.fillStyle = `rgba(${s.color.join(',')},0.92)`;
        roundRect(ctx, bx, by, tw + pad * 2, fs * 1.4, fs * 0.35);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(text, bx + pad + tw / 2, by + fs * 0.72);
      }
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function segName(s) {
    const base = labelOf(s.label);
    return s.kind === 'thing' && s.total > 1 ? `${base} ${s.n}` : base;
  }

  function renderLegend() {
    const segs = [...state.segments].sort((a, b) => (a.kind === b.kind ? b.area - a.area : a.kind === 'thing' ? -1 : 1));
    const covered = segs.reduce((a, s) => a + s.area, 0);
    els.segCount.textContent = segs.length ? `${segs.length}개 · 사진의 ${(covered * 100).toFixed(0)}% 분류` : '';
    els.legendEmpty.classList.toggle('hidden', segs.length > 0);
    els.legendEmpty.textContent = state.labels ? '찾은 영역이 없어요.' : '아직 결과가 없어요.';
    els.legend.replaceChildren(...segs.map((s) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.id = s.id;
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = '<span class="sw"></span><span class="name"></span><span class="meta"></span>';
      b.querySelector('.sw').style.background = `rgb(${s.color.join(',')})`;
      const name = b.querySelector('.name');
      name.textContent = segName(s);
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = s.kind === 'thing' ? '물체' : '배경';
      name.append(kind);
      b.querySelector('.meta').textContent = `${(s.area * 100).toFixed(1)}% · ${Math.round(s.confidence * 100)}`;
      li.append(b);
      return li;
    }));
  }

  function select(id) {
    state.selected = state.selected === id ? -1 : id;
    els.legend.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.id) === state.selected)));
    render();
  }

  // ---------- 이벤트 ----------
  async function open(file) {
    if (!file) return;
    hideError();
    try {
      const img = await loadImage(file);
      state.image = shrink(img);
      state.name = file.name.replace(/\.[^.]+$/, '') || 'image';
      state.segments = [];
      state.labels = null;
      state.selected = -1;
      els.pick.classList.add('hidden');
      els.work.classList.remove('hidden');
      renderLegend();
      render();
      analyze();
    } catch (err) {
      showError(err.message);
    }
  }

  els.input.addEventListener('change', () => { open(els.input.files[0]); els.input.value = ''; });
  ['dragenter', 'dragover'].forEach((t) => els.dropzone.addEventListener(t, (e) => { e.preventDefault(); els.dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((t) => els.dropzone.addEventListener(t, () => els.dropzone.classList.remove('dragover')));
  els.dropzone.addEventListener('drop', (e) => { e.preventDefault(); open(e.dataTransfer.files[0]); });

  els.legend.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) select(Number(b.dataset.id));
  });
  els.cv.addEventListener('click', (e) => {
    if (!state.labels) return;
    const r = els.cv.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * els.cv.width);
    const y = Math.floor(((e.clientY - r.top) / r.height) * els.cv.height);
    const l = state.labels[y * els.cv.width + x];
    select(l >= 0 ? l : state.selected);
  });

  document.querySelectorAll('[data-toggle]').forEach((btn) => btn.addEventListener('click', () => {
    const k = btn.dataset.toggle;
    state.opts[k] = !state.opts[k];
    btn.setAttribute('aria-pressed', String(state.opts[k]));
    render();
  }));

  function syncRanges() { els.rAlphaOut.textContent = `${els.rAlpha.value}%`; }
  els.rAlpha.addEventListener('input', () => { syncRanges(); render(); });
  syncRanges();

  els.save.addEventListener('click', () => {
    els.cv.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${state.name}_panoptic.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }, 'image/png');
  });
})();
