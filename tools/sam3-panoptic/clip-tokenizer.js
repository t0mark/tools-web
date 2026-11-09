/*
 * CLIP BPE 토크나이저 (OpenAI CLIP SimpleTokenizer 와 같은 규칙)
 * 데이터: clip_tokenizer.json (byte_encoder, encoder, merges)
 */
export class ClipTokenizer {
  constructor(data) {
    this.byteEncoder = new Map(Object.entries(data.byte_encoder).map(([k, v]) => [Number(k), v]));
    this.encoder = new Map(Object.entries(data.encoder));
    this.ranks = new Map();
    data.merges.forEach((m, i) => {
      const key = Array.isArray(m) ? `${m[0]} ${m[1]}` : m;
      this.ranks.set(key, i);
    });
    this.cache = new Map();
    this.sot = this.encoder.get('<|startoftext|>') ?? 49406;
    this.eot = this.encoder.get('<|endoftext|>') ?? 49407;
    this.pat = /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/giu;
  }

  bpe(token) {
    if (this.cache.has(token)) return this.cache.get(token);
    let word = [...token.slice(0, -1), `${token.slice(-1)}</w>`];
    if (word.length === 1) { const r = [word[0]]; this.cache.set(token, r); return r; }
    for (;;) {
      let best = null;
      let bestRank = Infinity;
      for (let i = 0; i < word.length - 1; i++) {
        const r = this.ranks.get(`${word[i]} ${word[i + 1]}`);
        if (r !== undefined && r < bestRank) { bestRank = r; best = i; }
      }
      if (best === null) break;
      const a = word[best];
      const b = word[best + 1];
      const merged = [];
      for (let i = 0; i < word.length;) {
        if (i < word.length - 1 && word[i] === a && word[i + 1] === b) { merged.push(a + b); i += 2; }
        else { merged.push(word[i]); i++; }
      }
      word = merged;
      if (word.length === 1) break;
    }
    this.cache.set(token, word);
    return word;
  }

  encode(text) {
    const clean = text.replace(/\s+/g, ' ').trim().toLowerCase();
    const ids = [];
    const utf8 = new TextEncoder();
    for (const m of clean.matchAll(this.pat)) {
      const t = [...utf8.encode(m[0])].map((b) => this.byteEncoder.get(b)).join('');
      for (const piece of this.bpe(t)) {
        const id = this.encoder.get(piece);
        if (id !== undefined) ids.push(id);
      }
    }
    return ids;
  }

  // [SOT, ...토큰, EOT, 0, 0, ...] 길이 contextLength (넘치면 잘라서 마지막을 EOT로)
  tokenize(text, contextLength = 32) {
    let ids = [this.sot, ...this.encode(text), this.eot];
    if (ids.length > contextLength) { ids = ids.slice(0, contextLength); ids[contextLength - 1] = this.eot; }
    const out = new Int32Array(contextLength);
    out.set(ids);
    return out;
  }
}
