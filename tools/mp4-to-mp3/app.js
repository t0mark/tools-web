/*
 * MP4 → MP3 변환기 (완전 클라이언트 사이드)
 *
 * 1) MP4 목차(moov)만 읽어 AAC 오디오 프레임 위치를 찾고, 오디오 데이터만 골라 읽음 (mp4-audio.js)
 *    → 1GB 넘는 동영상도 파일 전체를 메모리에 올리지 않음
 * 2) 30초 구간씩 브라우저 내장 디코더(decodeAudioData)로 PCM 디코딩
 * 3) 16-bit 변환(필요 시 다운믹스) 후 Web Worker의 LAME(lamejs)로 CBR MP3 인코딩 → 진짜 MP3 (audio/mpeg)
 * MP4가 아니거나 AAC가 아니면 파일 전체를 한 번에 디코딩하는 방식으로 처리
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    pickStep: $('pick-step'),
    configStep: $('config-step'),
    progressStep: $('progress-step'),
    resultStep: $('result-step'),
    dropzone: $('dropzone'),
    fileInput: $('file-input'),
    fileName: $('file-name'),
    fileDetail: $('file-detail'),
    changeFile: $('change-file'),
    estimate: $('estimate'),
    convertBtn: $('convert-btn'),
    progressText: $('progress-text'),
    progressPct: $('progress-pct'),
    progressBar: $('progress-bar'),
    cancelBtn: $('cancel-btn'),
    resultName: $('result-name'),
    sizeBefore: $('size-before'),
    sizeAfter: $('size-after'),
    reduction: $('reduction'),
    resultAudio: $('result-audio'),
    downloadBtn: $('download-btn'),
    shareBtn: $('share-btn'),
    againBtn: $('again-btn'),
    errorBox: $('error-box'),
    errorText: $('error-text'),
  };

  const state = {
    file: null,
    duration: null, // seconds (메타데이터로 미리 추정)
    resultUrl: null,
    resultFile: null,
    worker: null,
    jobId: 0,
  };

  // ---------- utils ----------
  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '-';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let v = bytes / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  }

  function formatDuration(sec) {
    if (!Number.isFinite(sec)) return '';
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(h ? 2 : 1, '0');
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function baseName(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
  }

  function extName(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toUpperCase().slice(0, 4) : 'FILE';
  }

  function getSettings() {
    return {
      kbps: Number(document.querySelector('input[name="bitrate"]:checked').value),
      channels: Number(document.querySelector('input[name="channels"]:checked').value),
    };
  }

  function showStep(step) {
    for (const s of [els.pickStep, els.configStep, els.progressStep, els.resultStep]) {
      s.classList.toggle('hidden', s !== step);
    }
    window.scrollTo({ top: 0 });
  }

  function showError(msg) {
    els.errorText.textContent = msg;
    els.errorBox.classList.remove('hidden');
  }

  function hideError() {
    els.errorBox.classList.add('hidden');
  }

  function setProgress(text, ratio) {
    els.progressText.textContent = text;
    const bar = els.progressBar.parentElement;
    if (ratio == null) {
      bar.classList.add('indeterminate');
      els.progressBar.style.width = '';
      els.progressPct.textContent = '';
    } else {
      bar.classList.remove('indeterminate');
      const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
      els.progressBar.style.width = `${pct}%`;
      els.progressPct.textContent = `${pct}%`;
    }
  }

  function releaseResult() {
    if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.resultUrl = null;
    state.resultFile = null;
    els.resultAudio.removeAttribute('src');
    els.resultAudio.load();
  }

  // ---------- 파일 선택 ----------
  function probeDuration(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const media = document.createElement(file.type.startsWith('audio/') ? 'audio' : 'video');
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        URL.revokeObjectURL(url);
        media.removeAttribute('src');
        resolve(v);
      };
      media.preload = 'metadata';
      media.muted = true;
      media.onloadedmetadata = () => finish(Number.isFinite(media.duration) ? media.duration : null);
      media.onerror = () => finish(null);
      setTimeout(() => finish(null), 8000);
      media.src = url;
    });
  }

  function updateEstimate() {
    const { kbps } = getSettings();
    if (state.duration) {
      const bytes = (state.duration * kbps * 1000) / 8;
      els.estimate.innerHTML = `예상 MP3 용량 <b>약 ${formatBytes(bytes)}</b>`;
    } else {
      els.estimate.textContent = `${kbps} kbps · 길이 정보 없음 (변환 후 확인)`;
    }
  }

  async function selectFile(file) {
    if (!file) return;
    hideError();
    releaseResult();
    state.file = file;
    state.duration = null;

    els.fileName.textContent = file.name;
    els.fileDetail.textContent = formatBytes(file.size);
    document.querySelector('.file-badge').textContent = extName(file.name);
    els.estimate.textContent = '예상 용량 계산 중…';
    showStep(els.configStep);

    const duration = await probeDuration(file);
    if (state.file !== file) return; // 그 사이 다른 파일 선택됨
    state.duration = duration;
    if (duration) els.fileDetail.textContent = `${formatBytes(file.size)} · ${formatDuration(duration)}`;
    updateEstimate();
  }

  // ---------- 디코딩 ----------
  const SEGMENT_SECONDS = 30; // 한 번에 디코딩/인코딩하는 길이
  const WARMUP_FRAMES = 3; // 구간 경계에서 AAC 디코더 상태를 맞추기 위해 앞에 겹쳐 넣는 프레임 수

  function newDecodeContext(sampleRate) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (OAC) {
      try { return { ctx: new OAC(2, 1, sampleRate), close() {} }; } catch (e) { /* 아래로 */ }
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ sampleRate });
    return { ctx, close() { ctx.close().catch(() => {}); } };
  }

  function decodeWith(ctx, arrayBuffer) {
    return new Promise((resolve, reject) => {
      // 구형 Safari는 콜백 방식만 지원
      const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
  }

  function channelsOf(buffer, start = 0, end = buffer.length) {
    const out = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c).subarray(start, end));
    return out;
  }

  /*
   * 오디오 소스: { sampleRate, segments() } — segments()는 { channels: Float32Array[], progress } 를 차례로 내놓는다.
   * 1순위: MP4/MOV의 AAC 트랙만 직접 꺼내서 구간별로 디코딩 (대용량 파일도 OK)
   * 2순위: 파일 전체를 브라우저 디코더에 통째로 넘김 (작은 파일, 기타 형식)
   */
  async function openMp4Source(file) {
    let track = null;
    try { track = await window.Mp4Audio.open(file); } catch (e) { console.warn('MP4 파싱 실패', e); }
    if (!track) return null;

    const rate = track.decodeRate;
    const spf = track.samplesPerFrame;
    const framesPerSeg = Math.max(1, Math.round((SEGMENT_SECONDS * rate) / spf));

    return {
      kind: 'mp4',
      sampleRate: rate,
      async *segments() {
        const dec = newDecodeContext(rate);
        try {
          for (let s = 0; s < track.count; s += framesPerSeg) {
            const e = Math.min(track.count, s + framesPerSeg);
            const from = Math.max(0, s - WARMUP_FRAMES);
            const adts = await track.buildAdts(from, e);
            const audio = await decodeWith(dec.ctx, adts);
            // 겹쳐 넣은 앞부분은 버리고, 이 구간 프레임에 해당하는 끝부분만 사용
            const want = Math.round((e - s) * spf);
            const start = s === 0 ? 0 : Math.max(0, audio.length - want);
            yield { channels: channelsOf(audio, start), progress: e / track.count };
          }
        } finally {
          dec.close();
        }
      },
    };
  }

  async function openWholeFileSource(file, onStage) {
    onStage('파일 읽는 중…');
    let data = await file.arrayBuffer();
    onStage('오디오 추출 중…');
    const dec = newDecodeContext(44100);
    let audio;
    try {
      audio = await decodeWith(dec.ctx, data);
    } catch (err) {
      throw new Error('이 파일에서 오디오를 읽을 수 없습니다. 오디오 트랙이 없거나 브라우저가 지원하지 않는 코덱일 수 있습니다.');
    } finally {
      dec.close();
      data = null;
    }
    if (!audio || audio.length === 0) throw new Error('오디오 트랙이 비어 있습니다.');
    const step = audio.sampleRate * SEGMENT_SECONDS;
    return {
      kind: 'whole',
      sampleRate: audio.sampleRate,
      async *segments() {
        for (let s = 0; s < audio.length; s += step) {
          const e = Math.min(audio.length, s + step);
          yield { channels: channelsOf(audio, s, e), progress: e / audio.length };
        }
      },
    };
  }

  const clip16 = (s) => (s < 0 ? Math.max(-32768, s * 32768) : Math.min(32767, s * 32767));

  // 채널별 Float32 → 출력 채널 수에 맞게 다운믹스 + 16-bit 변환 (Web Audio 표준 다운믹스 계수)
  function toPcm16(chs, outCh) {
    const n = chs.length;
    const len = chs[0].length;
    const L = new Int16Array(len);
    const R = outCh === 2 ? new Int16Array(len) : null;
    const [c0, c1, c2, , c4, c5] = chs; // 5.1: L R C LFE SL SR
    const k = Math.SQRT1_2;
    for (let i = 0; i < len; i++) {
      let l, r;
      if (n === 1) { l = r = c0[i]; }
      else if (n >= 6) { l = c0[i] + k * (c2[i] + c4[i]); r = c1[i] + k * (c2[i] + c5[i]); }
      else if (n === 4) { l = 0.5 * (c0[i] + c2[i]); r = 0.5 * (c1[i] + chs[3][i]); }
      else { l = c0[i]; r = c1[i]; }
      if (R) { L[i] = clip16(l); R[i] = clip16(r); }
      else if (n >= 6) { L[i] = clip16(k * (c0[i] + c1[i]) + c2[i] + 0.5 * (c4[i] + c5[i])); }
      else { L[i] = clip16(n === 1 ? l : 0.5 * (l + r)); }
    }
    return R ? [L, R] : [L];
  }

  // ---------- 인코딩 (워커) ----------
  function createEncoder(sampleRate, channels, kbps) {
    const worker = new Worker('encoder.worker.js?v=20261109c');
    state.worker = worker;
    const waiting = new Map();
    let onDone = null;
    let failed = null;
    const fail = (err) => {
      failed = err;
      for (const w of waiting.values()) w.reject(err);
      waiting.clear();
      if (onDone) onDone.reject(err);
    };
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'ack') { waiting.get(msg.id).resolve(); waiting.delete(msg.id); }
      else if (msg.type === 'done') onDone.resolve(msg.blob);
      else if (msg.type === 'error') fail(new Error(msg.message));
    };
    worker.onerror = (e) => fail(new Error(e.message || '인코더를 불러오지 못했습니다.'));
    worker.postMessage({ type: 'init', sampleRate, channels, kbps });

    let nextId = 0;
    return {
      push(pcm) {
        if (failed) return Promise.reject(failed);
        const id = nextId++;
        return new Promise((resolve, reject) => {
          waiting.set(id, { resolve, reject });
          worker.postMessage({ type: 'chunk', id, pcm }, pcm.map((c) => c.buffer));
        });
      },
      end() {
        if (failed) return Promise.reject(failed);
        return new Promise((resolve, reject) => {
          onDone = { resolve, reject };
          worker.postMessage({ type: 'end' });
        });
      },
      terminate() {
        worker.terminate();
        if (state.worker === worker) state.worker = null;
      },
    };
  }

  class CancelledError extends Error {}

  async function convert() {
    const file = state.file;
    if (!file) return;
    hideError();
    releaseResult();

    const jobId = ++state.jobId;
    const ensureActive = () => { if (jobId !== state.jobId) throw new CancelledError(); };
    const { kbps, channels: wantChannels } = getSettings();
    const onStage = (t) => { ensureActive(); setProgress(t, null); };

    showStep(els.progressStep);
    let encoder = null;
    try {
      setProgress('파일 분석 중…', null);
      let source = await openMp4Source(file);
      ensureActive();
      if (!source) source = await openWholeFileSource(file, onStage);
      console.info('[mp4-to-mp3] source:', source.kind, source.sampleRate);
      ensureActive();

      setProgress('MP3 변환 중…', 0);
      let outCh = 0;
      let samples = 0;
      let pending = Promise.resolve();
      for await (const seg of source.segments()) {
        ensureActive();
        if (!encoder) {
          outCh = Math.min(wantChannels, seg.channels.length);
          encoder = createEncoder(source.sampleRate, outCh, kbps);
        }
        const pcm = toPcm16(seg.channels, outCh);
        samples += pcm[0].length;
        await pending; // 워커가 이전 구간을 끝낼 때까지 대기 (메모리 사용량 제한)
        ensureActive();
        pending = encoder.push(pcm);
        setProgress('MP3 변환 중…', seg.progress * 0.98);
      }
      if (!encoder || samples === 0) throw new Error('오디오 트랙이 비어 있습니다.');
      await pending;
      ensureActive();
      setProgress('마무리 중…', 0.99);
      const blob = await encoder.end();
      encoder.terminate();
      ensureActive();

      showResult(file, blob, samples / source.sampleRate);
    } catch (err) {
      if (encoder) encoder.terminate();
      if (err instanceof CancelledError) return;
      console.error(err);
      showStep(els.configStep);
      let msg = (err && err.message) || String(err);
      if (err && (err.name === 'EncodingError' || err.name === 'NotSupportedError')) {
        msg = '이 파일에서 오디오를 읽을 수 없습니다. 오디오 트랙이 없거나 브라우저가 지원하지 않는 코덱일 수 있습니다.';
      }
      if (err && (err.name === 'NotReadableError' || /memory|allocation|RangeError/i.test(msg + err.name))) {
        msg = '기기 메모리가 부족합니다. 다른 앱을 닫고 다시 시도하거나 더 짧은 영상으로 시도해주세요.';
      }
      showError(msg);
    }
  }

  function cancel() {
    state.jobId++;
    if (state.worker) {
      state.worker.terminate();
      state.worker = null;
    }
    showStep(els.configStep);
  }

  // ---------- 결과 ----------
  function showResult(srcFile, blob, duration) {
    const name = `${baseName(srcFile.name)}.mp3`;
    state.resultFile = new File([blob], name, { type: 'audio/mpeg' });
    state.resultUrl = URL.createObjectURL(state.resultFile);

    els.resultName.textContent = name;
    els.sizeBefore.textContent = formatBytes(srcFile.size);
    els.sizeAfter.textContent = formatBytes(blob.size);
    const saved = 1 - blob.size / srcFile.size;
    els.reduction.textContent = saved > 0
      ? `${Math.round(saved * 100)}% 줄었어요 · ${formatDuration(duration)}`
      : formatDuration(duration);

    els.resultAudio.src = state.resultUrl;
    els.downloadBtn.href = state.resultUrl;
    els.downloadBtn.download = name;

    const canShare = !!(navigator.canShare && navigator.canShare({ files: [state.resultFile] }));
    els.shareBtn.classList.toggle('hidden', !canShare);

    showStep(els.resultStep);
  }

  async function share() {
    if (!state.resultFile) return;
    try {
      await navigator.share({ files: [state.resultFile], title: state.resultFile.name });
    } catch (err) {
      if (err && err.name !== 'AbortError') showError('공유하지 못했습니다. 다운로드 버튼을 이용해주세요.');
    }
  }

  function reset() {
    state.jobId++;
    releaseResult();
    hideError();
    state.file = null;
    state.duration = null;
    els.fileInput.value = '';
    showStep(els.pickStep);
  }

  // ---------- 이벤트 ----------
  els.fileInput.addEventListener('change', () => selectFile(els.fileInput.files[0]));
  els.changeFile.addEventListener('click', () => { els.fileInput.value = ''; els.fileInput.click(); });
  document.querySelectorAll('input[name="bitrate"], input[name="channels"]').forEach((r) => {
    r.addEventListener('change', updateEstimate);
  });
  els.convertBtn.addEventListener('click', convert);
  els.cancelBtn.addEventListener('click', cancel);
  els.shareBtn.addEventListener('click', share);
  els.againBtn.addEventListener('click', reset);

  // 데스크톱용 드래그 앤 드롭
  ['dragenter', 'dragover'].forEach((t) => els.dropzone.addEventListener(t, (e) => {
    e.preventDefault();
    els.dropzone.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((t) => els.dropzone.addEventListener(t, () => els.dropzone.classList.remove('dragover')));
  els.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) selectFile(f);
  });
})();
