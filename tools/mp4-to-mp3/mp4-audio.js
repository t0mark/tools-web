/*
 * MP4/MOV에서 AAC 오디오 트랙만 꺼내는 최소 디멀티플렉서
 *
 * 큰 동영상(수백 MB~GB)을 통째로 메모리에 올리면 휴대폰에서 디코딩이 실패하므로,
 *  1) moov 박스(목차)만 읽어서 오디오 샘플의 위치/크기를 알아내고
 *  2) 오디오 프레임만 골라 ADTS(.aac) 스트림으로 감싼 뒤
 *  3) 일정 길이(구간)씩 나눠서 브라우저 디코더로 넘긴다.
 *
 * 지원하지 않는 경우(AAC가 아닌 코덱, fragmented MP4 등)는 open()이 null을 반환 → 호출부에서 기존 방식으로 처리.
 */
(function (global) {
  'use strict';

  const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
  const READ_WINDOW = 8 * 1024 * 1024; // 한 번에 읽는 최대 바이트
  const MAX_MOOV = 256 * 1024 * 1024;

  function fourcc(dv, o) {
    return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  }

  function* boxes(dv, start, end) {
    let o = start;
    while (o + 8 <= end) {
      let size = dv.getUint32(o);
      const type = fourcc(dv, o + 4);
      let hdr = 8;
      if (size === 1) {
        if (o + 16 > end) return;
        size = dv.getUint32(o + 8) * 4294967296 + dv.getUint32(o + 12);
        hdr = 16;
      } else if (size === 0) {
        size = end - o;
      }
      if (size < hdr || o + size > end) return;
      yield { type, start: o, content: o + hdr, end: o + size };
      o += size;
    }
  }

  function child(dv, box, type) {
    for (const b of boxes(dv, box.content, box.end)) if (b.type === type) return b;
    return null;
  }

  function path(dv, box, ...types) {
    let b = box;
    for (const t of types) {
      b = child(dv, b, t);
      if (!b) return null;
    }
    return b;
  }

  async function readBytes(file, start, end) {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }

  async function readMoov(file) {
    const size = file.size;
    let o = 0;
    while (o + 8 <= size) {
      const head = await readBytes(file, o, Math.min(o + 16, size));
      const dv = new DataView(head.buffer);
      let bs = dv.getUint32(0);
      const type = fourcc(dv, 4);
      let hdr = 8;
      if (bs === 1) {
        if (head.length < 16) return null;
        bs = dv.getUint32(8) * 4294967296 + dv.getUint32(12);
        hdr = 16;
      } else if (bs === 0) {
        bs = size - o;
      }
      if (bs < hdr) return null;
      if (type === 'moov') {
        if (bs > MAX_MOOV) return null;
        const bytes = await readBytes(file, o, o + bs);
        return new DataView(bytes.buffer);
      }
      o += bs;
    }
    return null;
  }

  // ---- esds / AudioSpecificConfig ----
  function readDescLen(u8, p) {
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const b = u8[p.o++];
      len = (len << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return len;
  }

  function parseEsds(u8) {
    const p = { o: 0 };
    if (u8[p.o++] !== 0x03) return null;
    readDescLen(u8, p);
    p.o += 2; // ES_ID
    const flags = u8[p.o++];
    if (flags & 0x80) p.o += 2;
    if (flags & 0x40) p.o += u8[p.o] + 1;
    if (flags & 0x20) p.o += 2;
    if (u8[p.o++] !== 0x04) return null;
    const dcLen = readDescLen(u8, p);
    const dcEnd = p.o + dcLen;
    const oti = u8[p.o];
    p.o += 13;
    let asc = null;
    if (p.o < dcEnd && u8[p.o] === 0x05) {
      p.o++;
      const l = readDescLen(u8, p);
      asc = u8.subarray(p.o, p.o + l);
    }
    return { oti, asc };
  }

  function parseAsc(asc) {
    let bit = 0;
    const read = (n) => {
      let v = 0;
      for (let i = 0; i < n; i++) {
        const byte = asc[bit >> 3];
        if (byte === undefined) throw new Error('ASC too short');
        v = (v << 1) | ((byte >> (7 - (bit & 7))) & 1);
        bit++;
      }
      return v;
    };
    const readAot = () => { const a = read(5); return a === 31 ? 32 + read(6) : a; };
    const readRate = () => { const i = read(4); return i === 15 ? { index: -1, rate: read(24) } : { index: i, rate: ADTS_RATES[i] }; };

    let aot = readAot();
    const core = readRate();
    const channelConfig = read(4);
    let outRate = core.rate;
    let sbr = false;
    if (aot === 5 || aot === 29) {
      sbr = true;
      outRate = readRate().rate;
      aot = readAot();
    }
    return { aot, coreIndex: core.index, coreRate: core.rate, outRate, channelConfig, sbr };
  }

  // ---- sample entry ----
  function findEsds(dv, entry) {
    const c = entry.content;
    const version = dv.getUint16(c + 8);
    const childStart = c + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
    for (const b of boxes(dv, childStart, entry.end)) {
      if (b.type === 'esds') return b;
      if (b.type === 'wave') {
        for (const w of boxes(dv, b.content, b.end)) if (w.type === 'esds') return w;
      }
    }
    return null;
  }

  function parseSampleTable(dv, stbl) {
    const stsz = child(dv, stbl, 'stsz');
    const stsc = child(dv, stbl, 'stsc');
    const stco = child(dv, stbl, 'stco') || child(dv, stbl, 'co64');
    if (!stsz || !stsc || !stco) return null;

    const fixed = dv.getUint32(stsz.content + 4);
    const count = dv.getUint32(stsz.content + 8);
    if (!count) return null;
    const sizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixed || dv.getUint32(stsz.content + 12 + i * 4);

    const is64 = stco.type === 'co64';
    const chunkCount = dv.getUint32(stco.content + 4);
    const chunkOff = new Float64Array(chunkCount);
    for (let i = 0; i < chunkCount; i++) {
      const p = stco.content + 8 + i * (is64 ? 8 : 4);
      chunkOff[i] = is64 ? dv.getUint32(p) * 4294967296 + dv.getUint32(p + 4) : dv.getUint32(p);
    }

    const entries = dv.getUint32(stsc.content + 4);
    const offsets = new Float64Array(count);
    let s = 0;
    for (let e = 0; e < entries && s < count; e++) {
      const p = stsc.content + 8 + e * 12;
      const first = dv.getUint32(p);
      const spc = dv.getUint32(p + 4);
      const next = e + 1 < entries ? dv.getUint32(p + 12) : chunkCount + 1;
      for (let ch = first; ch < next && ch <= chunkCount && s < count; ch++) {
        let off = chunkOff[ch - 1];
        for (let k = 0; k < spc && s < count; k++) {
          offsets[s] = off;
          off += sizes[s];
          s++;
        }
      }
    }
    if (s < count) return null;
    return { count, sizes, offsets };
  }

  function pickDecodeRate(rate) {
    if (MP3_RATES.includes(rate)) return rate;
    if (rate > 48000) return rate % 11025 === 0 ? 44100 : 48000;
    return MP3_RATES.find((r) => r >= rate) || 48000;
  }

  // ---- 공개 API ----
  async function open(file) {
    const moov = await readMoov(file);
    if (!moov) return null;
    const root = boxes(moov, 0, moov.byteLength).next().value;
    if (!root || root.type !== 'moov') return null;

    for (const trak of boxes(moov, root.content, root.end)) {
      if (trak.type !== 'trak') continue;
      const hdlr = path(moov, trak, 'mdia', 'hdlr');
      if (!hdlr || fourcc(moov, hdlr.content + 8) !== 'soun') continue;
      const stbl = path(moov, trak, 'mdia', 'minf', 'stbl');
      const stsd = stbl && child(moov, stbl, 'stsd');
      if (!stsd) continue;
      const entry = boxes(moov, stsd.content + 8, stsd.end).next().value;
      if (!entry || entry.type !== 'mp4a') continue;

      const esdsBox = findEsds(moov, entry);
      if (!esdsBox) continue;
      const esds = parseEsds(new Uint8Array(moov.buffer, esdsBox.content + 4, esdsBox.end - esdsBox.content - 4));
      if (!esds || esds.oti !== 0x40 || !esds.asc) continue; // 0x40 = MPEG-4 AAC

      let cfg;
      try { cfg = parseAsc(esds.asc); } catch (e) { continue; }
      // ADTS로 표현 가능한 경우만 (AAC Main/LC/SSR/LTP, 표준 샘플레이트, 채널 구성 1~7)
      if (cfg.aot < 1 || cfg.aot > 4 || cfg.coreIndex < 0 || cfg.coreIndex > 12) continue;
      if (cfg.channelConfig < 1 || cfg.channelConfig > 7) continue;

      const table = parseSampleTable(moov, stbl);
      if (!table) continue;

      return new Mp4AacTrack(file, cfg, table);
    }
    return null;
  }

  class Mp4AacTrack {
    constructor(file, cfg, table) {
      this.file = file;
      this.cfg = cfg;
      this.count = table.count;
      this.sizes = table.sizes;
      this.offsets = table.offsets;
      this.decodeRate = pickDecodeRate(cfg.outRate);
      // 디코딩 결과(decodeRate 기준)에서 AAC 프레임 하나가 차지하는 샘플 수
      this.samplesPerFrame = (1024 * this.decodeRate) / cfg.coreRate;
      this.duration = (this.count * 1024) / cfg.coreRate;
      this.buf = null;
      this.bufStart = 0;
      this.bufEnd = 0;
    }

    async _load(i) {
      const start = this.offsets[i];
      let end = start + this.sizes[i];
      for (let j = i + 1; j < this.count; j++) {
        const o = this.offsets[j];
        const e = o + this.sizes[j];
        if (o < start || e - start > READ_WINDOW) break;
        if (e > end) end = e;
      }
      this.buf = await readBytes(this.file, start, end);
      this.bufStart = start;
      this.bufEnd = end;
    }

    async _frame(i) {
      const s = this.offsets[i];
      const e = s + this.sizes[i];
      if (!this.buf || s < this.bufStart || e > this.bufEnd) await this._load(i);
      return this.buf.subarray(s - this.bufStart, e - this.bufStart);
    }

    // 프레임 [from, to)를 ADTS 스트림으로
    async buildAdts(from, to) {
      const frames = [];
      let total = 0;
      for (let i = from; i < to; i++) {
        const f = await this._frame(i);
        frames.push(f);
        total += f.length + 7;
      }
      const out = new Uint8Array(total);
      const profile = this.cfg.aot - 1;
      const sfi = this.cfg.coreIndex;
      const chan = this.cfg.channelConfig;
      let o = 0;
      for (const f of frames) {
        const len = f.length + 7;
        out[o] = 0xff;
        out[o + 1] = 0xf1; // MPEG-4, layer 0, CRC 없음
        out[o + 2] = (profile << 6) | (sfi << 2) | (chan >> 2);
        out[o + 3] = ((chan & 3) << 6) | (len >> 11);
        out[o + 4] = (len >> 3) & 0xff;
        out[o + 5] = ((len & 7) << 5) | 0x1f;
        out[o + 6] = 0xfc;
        out.set(f, o + 7);
        o += len;
      }
      return out.buffer;
    }
  }

  global.Mp4Audio = { open };
})(self);
