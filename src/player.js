// ---------------------------------------------------------------------------
// Player — thin HTMLAudioElement wrapper with a Web Audio analyser tap for
// the footer visualizer. The rest of the app only talks to this class.
// ---------------------------------------------------------------------------
export class Player {
  constructor({ onTime, onEnd, onPlayState } = {}) {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.onTime = onTime || (() => {});
    this.onEnd = onEnd || (() => {});
    this.onPlayState = onPlayState || (() => {});
    this.ctx = null;
    this.analyser = null;
    this.rafId = null;
    this.vizCanvas = null;
    this.vizCtx = null;

    this.audio.addEventListener('timeupdate', () => this.onTime(this.audio.currentTime));
    this.audio.addEventListener('loadedmetadata', () => this.onTime(0));
    this.audio.addEventListener('ended', () => this.onEnd());
    this.audio.addEventListener('play', () => this.onPlayState(true));
    this.audio.addEventListener('pause', () => this.onPlayState(false));
  }

  get duration() {
    return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
  }

  get paused() {
    return this.audio.paused;
  }

  // Web Audio context + analyser tap, created lazily on first user-initiated
  // playback (browsers won't produce audio before a gesture).
  ensureCtx() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const source = ctx.createMediaElementSource(this.audio);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.82;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    this.ctx = ctx;
    this.analyser = analyser;
    return ctx;
  }

  async load(url, autoplay = true) {
    this.audio.src = url;
    this.audio.currentTime = 0;
    if (autoplay) {
      this.ensureCtx();
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      await this.audio.play();
    }
  }

  play() {
    this.ensureCtx();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    return this.audio.play();
  }

  pause() {
    this.audio.pause();
  }

  toggle() {
    return this.audio.paused ? this.play() : (this.pause(), Promise.resolve());
  }

  seek(t) {
    const dur = this.duration;
    if (!dur) return;
    this.audio.currentTime = Math.min(Math.max(0, t), dur);
    this.onTime(this.audio.currentTime);
  }

  setVolume(v) {
    this.audio.volume = Math.min(1, Math.max(0, v));
  }

  startVisualizer(canvas) {
    if (!canvas) return;
    this.vizCanvas = canvas;
    this.vizCtx = canvas.getContext('2d');
    this.drawViz = this.drawViz.bind(this);
    this.vizLoop();
  }

  vizLoop() {
    this.rafId = requestAnimationFrame(() => this.vizLoop());
    if (!this.analyser || this.audio.paused) {
      this.drawViz(null);
      return;
    }
    const freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(freq);
    this.drawViz(freq);
  }

  drawViz(freq) {
    const canvas = this.vizCanvas;
    const ctx = this.vizCtx;
    if (!canvas || !ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    // No analyser yet (or paused): a calm idle line at the bottom.
    if (!freq) {
      ctx.fillStyle = 'rgba(139, 92, 246, 0.18)';
      ctx.fillRect(0, H - 2, W, 2);
      return;
    }
    const BARS = 110;
    const step = Math.floor(freq.length / BARS);
    const barW = W / BARS;
    const gap = 1.4;
    const n = Math.min(BARS, freq.length);
    for (let i = 0; i < n; i++) {
      const v = freq[i * step] / 255;
      const h = Math.max(2, v * (H - 3));
      const x = i * barW + gap / 2;
      const grad = ctx.createLinearGradient(0, H - h, 0, H);
      grad.addColorStop(0, '#8b5cf6');
      grad.addColorStop(0.55, '#ec4899');
      grad.addColorStop(1, '#f59e0b');
      ctx.fillStyle = grad;
      ctx.globalAlpha = 0.3 + 0.7 * v;
      ctx.fillRect(x, H - h, barW - gap, h);
      ctx.globalAlpha = 1;
    }
  }
}
