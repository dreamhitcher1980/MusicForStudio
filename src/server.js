// ---------------------------------------------------------------------------
// Remote generation clients for local AI servers (MusicGen wrapper + ACE-Step)
// plus tiny fetch helpers shared by the rest of the app. Everything talks to
// a server the user starts on their own machine — nothing is uploaded here.
// The structured prompt builder lives in knowledge.js but is part of this
// module's public surface: remote engines are the only consumers of it.
// ---------------------------------------------------------------------------

export { expandPrompt } from './knowledge.js';

export const DEFAULT_URL = 'http://127.0.0.1:7860';
export const DEFAULT_ACESTEP_URL = 'http://127.0.0.1:8001';
const REMOTE_TIMEOUT_MS = 180000; // generation can take minutes on CPU
const ACESTEP_POLL_MS = 1500;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), ms)),
  ]);
}

// Health check used by the Settings "Test connection" button.
export async function checkServer(url = DEFAULT_URL, engine = 'musicgen') {
  const base = (url || '').trim().replace(/\/+$/, '');
  if (engine === 'acestep') {
    const res = await withTimeout(fetch(`${base}/health`), 5000);
    if (!res.ok) throw new Error(`Server replied ${res.status}`);
    let model = 'ACE-Step 1.5';
    try {
      const data = await res.json();
      if (data && data.data && typeof data.data === 'object') {
        model = `ACE-Step 1.5 (${data.data.dit_model || data.data.model || 'local'})`;
      }
    } catch {}
    return { model, cuda: true, url: base, engine };
  }
  const res = await withTimeout(fetch(`${base}/api/health`), 5000);
  if (!res.ok) throw new Error(`Server replied ${res.status}`);
  const data = await res.json();
  if (!data || data.ok !== true) throw new Error('Unexpected health response');
  return { model: data.model || 'musicgen', cuda: !!data.cuda, url: base, engine: 'musicgen' };
}

// MusicGen wrapper: POST /api/generate → WAV bytes.
export async function generateRemote(prompt, { url = DEFAULT_URL, duration = 24, seed = 0 } = {}) {
  const base = (url || '').trim().replace(/\/+$/, '');
  const res = await withTimeout(
    fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, duration, seed }),
    }),
    REMOTE_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`Server replied ${res.status}`);
  const blob = await res.blob();
  if (!blob || blob.size === 0) throw new Error('Server returned empty audio');
  return blob;
}

function unwrapGradio(payload) {
  if (payload && typeof payload.code === 'number' && payload.code !== 200) {
    throw new Error(payload.error || `Server error ${payload.code}`);
  }
  return payload && payload.data !== undefined ? payload.data : payload;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ACE-Step 1.5 (github.com/ace-step/ACE-Step-1.5): submit a task to
// /release_task, poll /query_result until it finishes, then download the WAV.
export async function generateAceStep(
  prompt,
  { url = DEFAULT_ACESTEP_URL, duration = 30, seed = null, lyrics = '', bpm = null, referenceBlob = null, coverStrength = 0.5 } = {}
) {
  const base = (url || '').trim().replace(/\/+$/, '');
  const params = {
    prompt,
    lyrics: lyrics || '',
    audio_duration: Math.max(10, Math.min(600, Math.round(duration))),
    audio_format: 'wav',
    batch_size: 1,
    use_random_seed: seed == null,
    seed: seed ?? -1,
    inference_steps: 8,
  };
  if (bpm) params.bpm = Math.round(bpm);

  let res;
  if (referenceBlob) {
    // Style transfer: send the reference audio as multipart form data.
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.append(k, String(v));
    form.append('reference_audio', referenceBlob, 'reference.wav');
    form.append('audio_cover_strength', String(Math.max(0.05, Math.min(1, coverStrength))));
    res = await withTimeout(fetch(`${base}/release_task`, { method: 'POST', body: form }), 60000);
  } else {
    res = await withTimeout(
      fetch(`${base}/release_task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      }),
      15000
    );
  }
  if (!res.ok) throw new Error(`Server replied ${res.status}`);

  const submitted = unwrapGradio(await res.json());
  const taskId =
    submitted && (submitted.task_id || (Array.isArray(submitted) && submitted[0] && submitted[0].task_id));
  if (!taskId) throw new Error('Server did not return a task id');

  const deadline = Date.now() + REMOTE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(ACESTEP_POLL_MS);
    const poll = await withTimeout(
      fetch(`${base}/query_result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id_list: [taskId] }),
      }),
      10000
    );
    if (!poll.ok) throw new Error(`Server replied ${poll.status}`);
    const payload = unwrapGradio(await poll.json());
    const entry = Array.isArray(payload) ? payload.find((e) => e && e.task_id === taskId) || payload[0] : null;
    if (!entry) continue;
    if (entry.status === 2) throw new Error('Generation failed on the server');
    if (entry.status !== 1) continue; // still queued/running

    let result = entry.result;
    if (typeof result === 'string') {
      try {
        result = JSON.parse(result);
      } catch {
        throw new Error('Unreadable result payload');
      }
    }
    const item = Array.isArray(result) ? result[0] : result;
    if (!item || !item.file) throw new Error('Result had no audio file');

    const audio = await withTimeout(fetch(`${base}${item.file}`), 60000);
    if (!audio.ok) throw new Error(`Audio download replied ${audio.status}`);
    const blob = await audio.blob();
    if (!blob || blob.size === 0) throw new Error('Server returned empty audio');
    blob.acestepMeta = item.metas || null;
    blob.acestepSeed = item.seed_value || null;
    return blob;
  }
  throw new Error('Generation timed out');
}

// Duration of a WAV blob in seconds, from its fmt/data chunk headers (0 if it
// isn't a RIFF/WAVE file). Cheap — no decoding involved.
export async function wavDuration(blob) {
  const buf = await blob.arrayBuffer();
  const view = new DataView(buf);
  if (view.getUint32(0, true) !== 1179011410) return 0; // 'RIFF'
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataSize = view.getUint32(40, true);
  const bytesPerSec = sampleRate * channels * (bitsPerSample / 8);
  return bytesPerSec ? dataSize / bytesPerSec : 0;
}
