/*
 * MP4 → MP3 변환기 (완전 클라이언트 사이드)
 *
 * 1) 브라우저 내장 디코더(Web Audio decodeAudioData)로 MP4 안의 오디오 트랙(AAC 등)을 PCM으로 디코딩
 *    - 44.1kHz로 리샘플링해서 받음
 * 2) PCM → 16-bit 정수로 변환 (모노 선택 시 다운믹스)
 * 3) Web Worker에서 LAME(lamejs)로 CBR MP3 인코딩 → 진짜 MP3 비트스트림 (audio/mpeg)
 */
(() => {
  'use strict';

  const OUTPUT_SAMPLE_RATE = 44100;

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
  async function decodeAudio(arrayBuffer) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    let ctx;
    let closeCtx = null;
    if (OAC) {
      ctx = new OAC(2, 1, OUTPUT_SAMPLE_RATE);
    } else {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC({ sampleRate: OUTPUT_SAMPLE_RATE });
      closeCtx = () => ctx.close();
    }
    try {
      return await new Promise((resolve, reject) => {
        // 구형 Safari는 콜백 방식만 지원
        const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
        if (p && typeof p.then === 'function') p.then(resolve, reject);
      });
    } finally {
      if (closeCtx) closeCtx().catch(() => {});
    }
  }

  // 5.1ch 등 3채널 이상은 Web Audio 표준 다운믹스로 스테레오/모노로 렌더링
  async function downmixWithWebAudio(buffer, outChannels) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new OAC(outChannels, buffer.length, buffer.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start();
    return ctx.startRendering();
  }

  function floatToInt16(input, output) {
    for (let i = 0; i < input.length; i++) {
      const s = input[i];
      output[i] = s < 0 ? Math.max(-32768, s * 32768) : Math.min(32767, s * 32767);
    }
    return output;
  }

  // AudioBuffer → 채널별 Int16Array
  function toPcm16(buffer, outChannels) {
    const len = buffer.length;
    if (outChannels === 1 && buffer.numberOfChannels > 1) {
      const l = buffer.getChannelData(0);
      const r = buffer.getChannelData(1);
      const out = new Int16Array(len);
      for (let i = 0; i < len; i++) {
        const s = (l[i] + r[i]) * 0.5;
        out[i] = s < 0 ? Math.max(-32768, s * 32768) : Math.min(32767, s * 32767);
      }
      return [out];
    }
    const result = [];
    for (let c = 0; c < outChannels; c++) {
      result.push(floatToInt16(buffer.getChannelData(c), new Int16Array(len)));
    }
    return result;
  }

  // ---------- 인코딩 ----------
  function encodeInWorker(channels, sampleRate, kbps, onProgress) {
    return new Promise((resolve, reject) => {
      const worker = new Worker('encoder.worker.js');
      state.worker = worker;
      worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'progress') onProgress(msg.value);
        else if (msg.type === 'done') { worker.terminate(); state.worker = null; resolve(msg.blob); }
        else if (msg.type === 'error') { worker.terminate(); state.worker = null; reject(new Error(msg.message)); }
      };
      worker.onerror = (e) => {
        worker.terminate();
        state.worker = null;
        reject(new Error(e.message || '인코더를 불러오지 못했습니다.'));
      };
      worker.postMessage({ channels, sampleRate, kbps }, channels.map((c) => c.buffer));
    });
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

    showStep(els.progressStep);
    try {
      setProgress('파일 읽는 중…', null);
      let data = await file.arrayBuffer();
      ensureActive();

      setProgress('오디오 추출 중…', null);
      let audio;
      try {
        audio = await decodeAudio(data);
      } catch (err) {
        throw new Error('이 파일에서 오디오를 읽을 수 없습니다. 오디오 트랙이 없거나 브라우저가 지원하지 않는 코덱일 수 있습니다.');
      }
      data = null;
      ensureActive();

      if (!audio || audio.length === 0) {
        throw new Error('오디오 트랙이 비어 있습니다.');
      }

      const outChannels = Math.min(wantChannels, audio.numberOfChannels);
      if (audio.numberOfChannels > 2) {
        setProgress('채널 다운믹스 중…', null);
        audio = await downmixWithWebAudio(audio, outChannels);
        ensureActive();
      }

      const sampleRate = audio.sampleRate;
      const duration = audio.duration;
      let pcm = toPcm16(audio, outChannels);
      audio = null; // 메모리 해제

      setProgress('MP3 인코딩 중…', 0);
      const blob = await encodeInWorker(pcm, sampleRate, kbps, (r) => {
        if (jobId === state.jobId) setProgress('MP3 인코딩 중…', r);
      });
      pcm = null;
      ensureActive();

      showResult(file, blob, duration);
    } catch (err) {
      if (err instanceof CancelledError) return;
      console.error(err);
      showStep(els.configStep);
      let msg = (err && err.message) || String(err);
      if (err && (err.name === 'NotReadableError' || /memory|allocation|RangeError/i.test(msg + err.name))) {
        msg = '파일이 너무 커서 기기 메모리가 부족합니다. 더 짧은 영상으로 시도해주세요.';
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
