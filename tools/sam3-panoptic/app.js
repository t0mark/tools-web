/*
 * SAM 3 파놉틱 세그멘테이션
 *
 * SAM 3는 "텍스트 개념 → 해당하는 모든 객체 마스크"를 내주는 모델이라 그 자체로 파놉틱 출력은 없다.
 * 그래서
 *  1) 물체(things: 사람, 차…)와 배경(stuff: 하늘, 도로…) 개념 목록을 Roboflow SAM 3 API로 보내 마스크를 구하고
 *     - API 키는 비밀번호로 암호화해 두고(ENCRYPTED_KEY), 사용자가 비밀번호를 넣으면 브라우저에서 복호화
 *  2) 돌아온 마스크들을 브라우저에서 하나의 라벨 맵으로 합친다.
 *     - 픽셀마다 한 영역만: 물체 > 배경, 같은 종류끼리는 신뢰도 높은 쪽
 *     - 물체는 인스턴스별로, 배경은 같은 클래스끼리 하나의 영역으로
 */
(() => {
  'use strict';

  const API_URL = 'https://serverless.roboflow.com/sam3/concept_segment';
  const MAX_PROMPTS = 16; // 요청당 최대 프롬프트 수
  const MAX_SIDE = 1280; // 업로드 전 최대 변 길이
  const REQUEST_THRESH = 0.3; // 서버 기준은 낮게 받고, 화면에서 슬라이더로 거름
  const PW_STORAGE = 'toolsweb.sam3Password';
  // Roboflow 프라이빗 API 키를 비밀번호로 암호화한 값 (scripts/encrypt-key.mjs 로 생성)
  // PBKDF2-SHA256(600,000회) → AES-256-GCM. 비밀번호가 짧으면 공개 리포에서 대입 공격으로 풀릴 수 있음.
  const ENCRYPTED_KEY = {"v":1,"iter":600000,"salt":"Pwr5b/m8yVpDz+TGaeas4g==","iv":"+TvajidY05oV04SH","ct":"lNZ7Y1ILykTZIfodeQ9T/jtGW0f2v6QNdOmwUVqVvxkd8uRN"};

  const DEFAULT_THINGS = 'person, car, bicycle, motorcycle, bus, truck, dog, cat, bird, chair, table, sofa, bed, bottle, cup, laptop, cell phone, book, potted plant, tv, bag, umbrella';
  const DEFAULT_STUFF = 'sky, tree, grass, road, sidewalk, building, wall, floor, ceiling, water, mountain, sand, snow, window, door';

  const KO = {
    person: '사람', car: '자동차', bicycle: '자전거', motorcycle: '오토바이', bus: '버스', truck: '트럭', dog: '개', cat: '고양이',
    bird: '새', chair: '의자', table: '테이블', sofa: '소파', bed: '침대', bottle: '병', cup: '컵', laptop: '노트북',
    'cell phone': '휴대폰', book: '책', 'potted plant': '화분', tv: 'TV', bag: '가방', umbrella: '우산',
    sky: '하늘', tree: '나무', grass: '풀', road: '도로', sidewalk: '인도', building: '건물', wall: '벽', floor: '바닥',
    ceiling: '천장', water: '물', mountain: '산', sand: '모래', snow: '눈', window: '창문', door: '문',
  };
  const labelOf = (t) => KO[t] || t;

  const $ = (id) => document.getElementById(id);
  const els = {
    input: $('file-input'), dropzone: $('dropzone'), pick: $('pick-step'), work: $('work-step'),
    keyCard: $('key-card'), keyState: $('key-state'), password: $('password'), rememberPw: $('remember-pw'), unlock: $('unlock-btn'),
    cv: $('cv'), loading: $('loading'), loadingText: $('loading-text'),
    rAlpha: $('r-alpha'), rAlphaOut: $('r-alpha-out'), rThresh: $('r-thresh'), rThreshOut: $('r-thresh-out'),
    legend: $('legend'), legendEmpty: $('legend-empty'), segCount: $('seg-count'),
    things: $('things'), stuff: $('stuff'), resetPrompts: $('reset-prompts'),
    run: $('run-btn'), save: $('save-btn'), errorBox: $('error-box'), errorText: $('error-text'),
    timing: $('timing'),
  };

  const state = {
    image: null, // 업로드용으로 줄인 캔버스
    name: 'image',
    raw: [], // { prompt, kind:'thing'|'stuff', confidence, polygons }
    apiKey: null, // 복호화된 키 (메모리에만)
    segments: [], // 합쳐진 최종 영역
    labels: null, // Int32Array(w*h), -1 = 없음
    selected: -1,
    opts: { labels: true, borders: true, original: false },
    busy: false,
  };

  // ---------- 저장소 (사생활 보호 모드 등에서 실패할 수 있음) ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 무시 */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* 무시 */ } },
  };

  // ---------- 비밀번호 → API 키 ----------
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function decryptKey(password) {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    const aes = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: b64(ENCRYPTED_KEY.salt), iterations: ENCRYPTED_KEY.iter },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(ENCRYPTED_KEY.iv) }, aes, b64(ENCRYPTED_KEY.ct));
      return new TextDecoder().decode(pt);
    } catch (e) {
      return null; // 비밀번호가 틀리면 GCM 인증 실패
    }
  }

  function syncKeyState() {
    const ready = state.apiKey || els.password.value;
    els.keyState.textContent = state.apiKey ? '열림' : els.password.value ? '입력됨' : '잠김';
    els.keyState.className = `key-state ${ready ? 'ok' : 'missing'}`;
  }

  async function getApiKey() {
    if (state.apiKey) return state.apiKey;
    const pw = els.password.value;
    if (!pw) {
      els.keyCard.open = true;
      els.password.focus();
      throw new Error('비밀번호를 입력해주세요.');
    }
    setProgress('비밀번호 확인 중…');
    const key = await decryptKey(pw);
    if (!key) {
      els.keyCard.open = true;
      els.password.select();
      store.del(PW_STORAGE);
      throw new Error('비밀번호가 틀렸어요.');
    }
    state.apiKey = key;
    if (els.rememberPw.checked) store.set(PW_STORAGE, pw); else store.del(PW_STORAGE);
    els.keyCard.open = false;
    syncKeyState();
    return key;
  }

  els.password.value = store.get(PW_STORAGE) || '';
  els.rememberPw.checked = !!els.password.value || els.rememberPw.checked;
  els.keyCard.open = !els.password.value;
  syncKeyState();
  els.password.addEventListener('input', () => { state.apiKey = null; syncKeyState(); });
  els.password.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); els.unlock.click(); } });
  els.rememberPw.addEventListener('change', () => { if (!els.rememberPw.checked) store.del(PW_STORAGE); });
  els.unlock.addEventListener('click', async () => {
    hideError();
    if (state.image) { analyze(); return; }
    try { els.unlock.disabled = true; await getApiKey(); } catch (e) { showError(e.message); } finally { els.unlock.disabled = false; els.loading.classList.add('hidden'); }
  });

  els.things.value = DEFAULT_THINGS;
  els.stuff.value = DEFAULT_STUFF;
  els.resetPrompts.addEventListener('click', () => { els.things.value = DEFAULT_THINGS; els.stuff.value = DEFAULT_STUFF; });

  const parseList = (s) => [...new Set(s.split(/[,\n]/).map((t) => t.trim().toLowerCase()).filter(Boolean))];

  // ---------- 오류 ----------
  function showError(msg) {
    els.errorText.textContent = msg;
    els.errorBox.classList.remove('hidden');
  }
  function hideError() { els.errorBox.classList.add('hidden'); }

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
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  // ---------- API ----------
  async function callSam3(apiKey, base64, prompts) {
    let res;
    try {
      res = await fetch(`${API_URL}?api_key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format: 'polygon',
          image: { type: 'base64', value: base64 },
          prompts: prompts.map((text) => ({ type: 'text', text })),
          output_prob_thresh: REQUEST_THRESH,
        }),
      });
    } catch (e) {
      throw new Error('서버에 연결하지 못했습니다. 인터넷 연결을 확인해주세요.');
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('저장된 Roboflow API 키가 거절됐어요. 키가 만료되었거나 바뀌었을 수 있어요.');
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch (e) { /* 무시 */ }
      throw new Error(`서버 오류 (${res.status}) ${detail}`);
    }
    const json = await res.json();
    return (json.prompt_results || []).map((r) => ({
      prompt: (r.echo && r.echo.text) || prompts[r.prompt_index] || '?',
      predictions: r.predictions || [],
    }));
  }

  function setProgress(text) {
    els.loadingText.textContent = text;
    if (state.image) els.loading.classList.remove('hidden');
  }

  async function analyze() {
    if (!state.image || state.busy) return;
    hideError();
    const things = parseList(els.things.value);
    const stuff = parseList(els.stuff.value).filter((t) => !things.includes(t));
    const all = [...things, ...stuff];
    if (!all.length) { showError('찾을 대상을 하나 이상 입력해주세요.'); return; }

    state.busy = true;
    els.run.disabled = true;
    els.loading.classList.remove('hidden');
    els.timing.textContent = '';
    try {
      const key = await getApiKey();
      setProgress(`분석 중… (${all.length}개 대상)`);
      const t0 = performance.now();
      const base64 = state.image.toDataURL('image/jpeg', 0.9).split(',')[1];
      const batches = [];
      for (let i = 0; i < all.length; i += MAX_PROMPTS) batches.push(all.slice(i, i + MAX_PROMPTS));
      const results = (await Promise.all(batches.map((b) => callSam3(key, base64, b)))).flat();

      const thingSet = new Set(things);
      state.raw = [];
      for (const r of results) {
        const kind = thingSet.has(r.prompt.toLowerCase()) ? 'thing' : 'stuff';
        for (const p of r.predictions) {
          const polys = Array.isArray(p.masks) ? p.masks.filter((poly) => Array.isArray(poly) && poly.length >= 3) : [];
          if (polys.length) state.raw.push({ prompt: r.prompt.toLowerCase(), kind, confidence: p.confidence, polygons: polys });
        }
      }
      els.timing.textContent = `Roboflow SAM 3 · 대상 ${all.length}개 · ${((performance.now() - t0) / 1000).toFixed(1)}초`;
      compose();
    } catch (err) {
      console.error(err);
      showError((err && err.message) || String(err));
    } finally {
      state.busy = false;
      els.run.disabled = false;
      els.loading.classList.add('hidden');
    }
  }

  // ---------- 파놉틱 합성 ----------
  const rasterCanvas = document.createElement('canvas');

  function rasterize(polygons, w, h) {
    // 폴리곤 → 바운딩 박스 영역의 알파 마스크
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of polygons) for (const [x, y] of poly) {
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(w, Math.ceil(x1) + 1); y1 = Math.min(h, Math.ceil(y1) + 1);
    const bw = x1 - x0, bh = y1 - y0;
    if (bw <= 0 || bh <= 0) return null;
    rasterCanvas.width = bw;
    rasterCanvas.height = bh;
    const ctx = rasterCanvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, bw, bh);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    for (const poly of polygons) {
      poly.forEach(([x, y], i) => (i ? ctx.lineTo(x - x0, y - y0) : ctx.moveTo(x - x0, y - y0)));
      ctx.closePath();
    }
    ctx.fill('evenodd');
    return { x0, y0, bw, bh, alpha: ctx.getImageData(0, 0, bw, bh).data };
  }

  function compose() {
    const w = state.image.width, h = state.image.height;
    const thresh = els.rThresh.value / 100;
    const items = state.raw.filter((r) => r.confidence >= thresh);
    // 나중에 칠한 것이 이김: 배경(낮은 신뢰도→높은) 먼저, 그다음 물체(낮은→높은)
    items.sort((a, b) => (a.kind === b.kind ? a.confidence - b.confidence : a.kind === 'stuff' ? -1 : 1));

    // 배경은 클래스별로 하나의 영역, 물체는 인스턴스별
    const segs = [];
    const stuffSeg = new Map();
    const instanceNo = new Map();
    const labels = new Int32Array(w * h).fill(-1);
    for (const it of items) {
      let id;
      if (it.kind === 'stuff' && stuffSeg.has(it.prompt)) {
        id = stuffSeg.get(it.prompt);
        segs[id].confidence = Math.max(segs[id].confidence, it.confidence);
      } else {
        id = segs.length;
        const n = (instanceNo.get(it.prompt) || 0) + 1;
        instanceNo.set(it.prompt, n);
        segs.push({ id, prompt: it.prompt, kind: it.kind, confidence: it.confidence, n });
        if (it.kind === 'stuff') stuffSeg.set(it.prompt, id);
      }
      if (it.mask) {
        // 기기 모델 마스크(저해상도) → 화면 해상도로 최근접 확대
        const xm = new Int32Array(w);
        for (let x = 0; x < w; x++) xm[x] = Math.min(it.w - 1, Math.floor(((x + 0.5) * it.w) / w));
        for (let y = 0; y < h; y++) {
          const my = Math.min(it.h - 1, Math.floor(((y + 0.5) * it.h) / h)) * it.w;
          const row = y * w;
          for (let x = 0; x < w; x++) if (it.mask[my + xm[x]]) labels[row + x] = id;
        }
        continue;
      }
      const m = rasterize(it.polygons, w, h);
      if (!m) continue;
      for (let y = 0; y < m.bh; y++) {
        const row = (m.y0 + y) * w + m.x0;
        for (let x = 0; x < m.bw; x++) if (m.alpha[(y * m.bw + x) * 4 + 3] >= 128) labels[row + x] = id;
      }
    }

    // 면적·라벨 위치 계산, 다른 영역에 완전히 가려진 영역 제거
    const area = new Float64Array(segs.length);
    const sx = new Float64Array(segs.length), sy = new Float64Array(segs.length);
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i];
      if (l < 0) continue;
      area[l]++; sx[l] += i % w; sy[l] += (i / w) | 0;
    }
    const remap = new Int32Array(segs.length).fill(-1);
    const kept = [];
    const minArea = w * h * 0.0005;
    segs.forEach((s, i) => {
      if (area[i] < minArea) return;
      remap[i] = kept.length;
      kept.push({ ...s, id: kept.length, area: area[i] / (w * h), cx: sx[i] / area[i], cy: sy[i] / area[i] });
    });
    for (let i = 0; i < labels.length; i++) if (labels[i] >= 0) labels[i] = remap[labels[i]];

    // 무게중심이 영역 밖이면(오목한 모양) 영역 안에서 가장 가까운 점으로 라벨 위치 이동
    const best = kept.map(() => ({ d: Infinity, x: 0, y: 0 }));
    for (let i = 0; i < labels.length; i += 3) {
      const l = labels[i];
      if (l < 0) continue;
      const x = i % w, y = (i / w) | 0;
      const d = (x - kept[l].cx) ** 2 + (y - kept[l].cy) ** 2;
      if (d < best[l].d) best[l] = { d, x, y };
    }
    kept.forEach((s, i) => { s.lx = best[i].x; s.ly = best[i].y; });
    // 같은 종류 물체는 왼쪽부터 1, 2, 3… 으로 번호
    const byPrompt = new Map();
    kept.filter((s) => s.kind === 'thing').forEach((s) => byPrompt.set(s.prompt, [...(byPrompt.get(s.prompt) || []), s]));
    for (const list of byPrompt.values()) list.sort((a, b) => a.cx - b.cx).forEach((s, i) => { s.n = i + 1; });

    // 색: 물체는 인스턴스마다, 배경은 클래스 이름으로 고정된 색 (배경은 조금 차분하게)
    kept.forEach((s, i) => {
      const hue = s.kind === 'thing' ? (i * 137.508) % 360 : hashHue(s.prompt);
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
      const fs = Math.max(12, Math.round(Math.max(w, h) / 45));
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
    const base = labelOf(s.prompt);
    if (s.kind === 'stuff') return base;
    const total = state.segments.filter((o) => o.prompt === s.prompt).length;
    return total > 1 ? `${base} ${s.n}` : base;
  }

  function renderLegend() {
    const segs = [...state.segments].sort((a, b) => (a.kind === b.kind ? b.area - a.area : a.kind === 'thing' ? -1 : 1));
    els.segCount.textContent = segs.length ? `${segs.length}개` : '';
    els.legendEmpty.classList.toggle('hidden', segs.length > 0);
    els.legendEmpty.textContent = state.raw.length ? '기준을 넘는 영역이 없어요. 신뢰도 기준을 낮춰보세요.' : '아직 결과가 없어요.';
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
      state.raw = [];
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

  els.run.addEventListener('click', analyze);
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

  function syncRanges() {
    els.rAlphaOut.textContent = `${els.rAlpha.value}%`;
    els.rThreshOut.textContent = (els.rThresh.value / 100).toFixed(2);
  }
  els.rAlpha.addEventListener('input', () => { syncRanges(); render(); });
  els.rThresh.addEventListener('input', () => { syncRanges(); if (state.raw.length) compose(); });
  syncRanges();

  els.save.addEventListener('click', () => {
    els.cv.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${state.name}_sam3-panoptic.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }, 'image/png');
  });
})();
