/* =============================================================
 * サクッと動画メーカー
 *  - 写真・テキスト画像 + 音楽 から動画を生成するiPhone向けPWA
 *  - canvas + MediaRecorder + Web Audio で完結
 * ============================================================= */
'use strict';

/* ===== サービスワーカー登録 ===== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.warn('SW登録失敗', err);
    });
  });
}

/* ===== アプリ状態 ===== */
const state = {
  mode: 'auto',          // 'auto' | 'manual'
  materials: [],         // {id,type,src,label,name,width,height,...}
  audio: null,           // {file,url,duration}
  settings: {
    size: '1080x1920',
    transition: 'fade',
    bgColor: 'black',
    fit: 'contain',
    perSec: 3,
  },
  isRendering: false,
  output: null,          // {blob,url,ext,mime}
};

/* ===== DOMヘルパ ===== */
const $  = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

/* ===== 初期化 ===== */
window.addEventListener('DOMContentLoaded', () => {
  bindUI();
  applyMode();
});

function bindUI() {
  // モード切替
  $$('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      applyMode();
    });
  });

  // 写真追加
  $('#photoInput').addEventListener('change', onPhotoSelected);

  // テキスト画像ダイアログ
  $('#openTextDialog').addEventListener('click', openTextDialog);
  $('#textConfirm').addEventListener('click', onTextConfirm);

  // 音楽
  $('#audioInput').addEventListener('change', onAudioSelected);
  $('#audioPreviewBtn').addEventListener('click', toggleAudioPreview);

  // 設定
  $('#setSize').addEventListener('change', e => state.settings.size = e.target.value);
  $('#setTransition').addEventListener('change', e => state.settings.transition = e.target.value);
  $('#setBg').addEventListener('change', e => state.settings.bgColor = e.target.value);
  $('#setFit').addEventListener('change', e => state.settings.fit = e.target.value);
  $('#setPerSec').addEventListener('change', e => state.settings.perSec = Number(e.target.value));

  // 動画生成
  $('#generateBtn').addEventListener('click', generateVideo);

  // 共有
  $('#shareBtn').addEventListener('click', shareVideo);
}

function applyMode() {
  document.body.classList.remove('mode-auto', 'mode-manual');
  document.body.classList.add('mode-' + state.mode);
  $$('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === state.mode);
  });
  $('#modeHint').textContent = state.mode === 'auto'
    ? '写真と音楽を選ぶだけでOK！'
    : '1枚あたりの秒数や効果を細かく設定できます';
}

/* =====================================================
 * 写真選択
 * ===================================================== */
async function onPhotoSelected(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = ''; // 同じファイルを再選択できるように
  for (const file of files) {
    try {
      const m = await loadPhotoFile(file);
      state.materials.push(m);
    } catch (err) {
      showError('写真の読み込みに失敗: ' + (err.message || err));
    }
  }
  renderMaterials();
}

// 写真を読み込み、メモリ節約のため最大1920pxに縮小
async function loadPhotoFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImageEl(url);
    const maxSide = 1920;
    let w = img.naturalWidth, h = img.naturalHeight;
    if (Math.max(w, h) > maxSide) {
      const r = maxSide / Math.max(w, h);
      w = Math.round(w * r);
      h = Math.round(h * r);
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.9));
    return {
      id: makeId(),
      type: 'photo',
      src: URL.createObjectURL(blob),
      label: '写真',
      name: file.name,
      width: w, height: h,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImageEl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('画像の読み込みに失敗'));
    img.src = url;
  });
}

/* =====================================================
 * テキスト画像生成
 * ===================================================== */
function openTextDialog() {
  const dlg = $('#textDialog');
  $('#textError').hidden = true;
  if (typeof dlg.showModal === 'function') {
    try { dlg.showModal(); } catch (_) { dlg.setAttribute('open', ''); }
  } else {
    dlg.setAttribute('open', '');
  }
}

async function onTextConfirm(e) {
  // ダイアログ自動クローズを止めて、自前で制御
  e.preventDefault();
  const text = $('#textContent').value.trim();
  const errEl = $('#textError');
  if (!text) {
    errEl.textContent = 'テキストを入力してください';
    errEl.hidden = false;
    return;
  }
  const bg = $('#textBg').value;
  const fg = $('#textFg').value;
  const sz = $('#textSize').value;
  try {
    const m = await createTextMaterial(text, bg, fg, sz);
    state.materials.push(m);
    renderMaterials();
    $('#textContent').value = '';
    $('#textDialog').close();
  } catch (err) {
    errEl.textContent = 'テキスト画像の生成に失敗: ' + (err.message || err);
    errEl.hidden = false;
  }
}

// 1枚のテキスト画像を生成
async function createTextMaterial(text, bgColor, textColor, sizeKey) {
  const [w, h] = parseSize(state.settings.size);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  drawTextOnCanvas(c, text, bgColor, textColor, sizeKey);
  const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.92));
  return {
    id: makeId(),
    type: 'text',
    src: URL.createObjectURL(blob),
    label: 'テキスト',
    name: text.split('\n')[0].slice(0, 18) || 'テキスト',
    width: w, height: h,
    text, bgColor, textColor, textSize: sizeKey,
  };
}

// テキストをcanvasに中央描画（自動折り返し＋自動縮小）
function drawTextOnCanvas(canvas, text, bg, fg, sizeKey) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;

  // 背景
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // 初期フォントサイズ（短辺基準）
  const baseRatio = sizeKey === 'small' ? 0.05
                  : sizeKey === 'large' ? 0.10
                  :                       0.075;
  let fontSize = Math.round(Math.min(w, h) * baseRatio);
  const padding = Math.round(Math.min(w, h) * 0.08);
  const maxW = w - padding * 2;
  const maxH = h - padding * 2;

  // フォントが収まるまで縮小
  let lines = [];
  while (fontSize > 14) {
    ctx.font = `bold ${fontSize}px -apple-system, "Hiragino Sans", sans-serif`;
    lines = wrapJaText(ctx, text, maxW);
    const totalH = lines.length * fontSize * 1.4;
    if (totalH <= maxH) break;
    fontSize -= 2;
  }

  // 描画
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lineH = fontSize * 1.4;
  const startY = h / 2 - (lines.length - 1) * lineH / 2;
  lines.forEach((line, i) => {
    ctx.fillText(line, w / 2, startY + i * lineH);
  });
}

// 文字単位の折り返し（日本語向け）
function wrapJaText(ctx, text, maxW) {
  const out = [];
  const paragraphs = String(text).split(/\n/);
  for (const para of paragraphs) {
    if (!para) { out.push(''); continue; }
    let line = '';
    for (const ch of para) {
      const test = line + ch;
      if (line && ctx.measureText(test).width > maxW) {
        out.push(line);
        line = ch;
      } else {
        line = test;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/* =====================================================
 * 素材一覧の描画と操作
 * ===================================================== */
function renderMaterials() {
  const ul = $('#materialList');
  ul.innerHTML = '';
  state.materials.forEach((m, idx) => {
    const li = document.createElement('li');
    li.className = 'material';
    li.innerHTML = `
      <img class="thumb" src="${m.src}" alt="">
      <div class="info">
        <div class="label">${idx + 1}. ${m.label}</div>
        <div class="name">${escapeHtml(m.name)}</div>
      </div>
      <div class="actions">
        <button class="icon-btn" data-act="up"   ${idx === 0 ? 'disabled' : ''} aria-label="上へ">↑</button>
        <button class="icon-btn" data-act="down" ${idx === state.materials.length - 1 ? 'disabled' : ''} aria-label="下へ">↓</button>
        <button class="icon-btn danger" data-act="del" aria-label="削除">×</button>
      </div>
    `;
    li.querySelectorAll('.icon-btn').forEach(btn => {
      btn.addEventListener('click', () => onMaterialAction(m.id, btn.dataset.act));
    });
    ul.appendChild(li);
  });
  $('#materialCount').textContent = state.materials.length === 0
    ? '素材はまだありません'
    : `素材 ${state.materials.length} 個（上から順に表示されます）`;
}

function onMaterialAction(id, act) {
  const idx = state.materials.findIndex(m => m.id === id);
  if (idx < 0) return;
  if (act === 'del') {
    URL.revokeObjectURL(state.materials[idx].src);
    state.materials.splice(idx, 1);
  } else if (act === 'up' && idx > 0) {
    [state.materials[idx - 1], state.materials[idx]] =
      [state.materials[idx], state.materials[idx - 1]];
  } else if (act === 'down' && idx < state.materials.length - 1) {
    [state.materials[idx + 1], state.materials[idx]] =
      [state.materials[idx], state.materials[idx + 1]];
  }
  renderMaterials();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));
}

/* =====================================================
 * 音楽選択
 * ===================================================== */
function onAudioSelected(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (state.audio && state.audio.url) URL.revokeObjectURL(state.audio.url);
  const url = URL.createObjectURL(file);
  const tmpAudio = new Audio();
  tmpAudio.preload = 'metadata';
  tmpAudio.src = url;
  tmpAudio.addEventListener('loadedmetadata', () => {
    if (!isFinite(tmpAudio.duration) || tmpAudio.duration <= 0) {
      showError('音楽長の取得に失敗しました。別のファイルをお試しください');
      return;
    }
    state.audio = { file, url, duration: tmpAudio.duration };
    $('#audioInfo').hidden = false;
    $('#audioName').textContent = file.name;
    $('#audioDuration').textContent = '長さ: ' + formatTime(tmpAudio.duration);
    $('#audioPreview').src = url;
    clearError();
  });
  tmpAudio.addEventListener('error', () => {
    showError('音楽ファイルを読み込めませんでした');
  });
}

function toggleAudioPreview() {
  const a = $('#audioPreview');
  if (!a.src) return;
  if (a.paused) {
    a.play().then(() => {
      $('#audioPreviewBtn').textContent = '⏸ 停止';
    }).catch(() => showError('再生できません'));
    a.onended = () => { $('#audioPreviewBtn').textContent = '▶ 試聴'; };
  } else {
    a.pause();
    $('#audioPreviewBtn').textContent = '▶ 試聴';
  }
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* =====================================================
 * ユーティリティ
 * ===================================================== */
function parseSize(s) {
  const [w, h] = s.split('x').map(Number);
  return [w, h];
}
function makeId() {
  return 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}
function showError(msg) {
  const box = $('#errorBox');
  box.textContent = msg;
  box.hidden = false;
  console.warn(msg);
}
function clearError() {
  $('#errorBox').hidden = true;
}
function setProgress(pct, text) {
  $('#progressArea').hidden = false;
  $('#progressFill').style.width = Math.max(0, Math.min(100, pct)) + '%';
  $('#progressText').textContent = text;
}

/* =====================================================
 * 動画生成
 * ===================================================== */
async function generateVideo() {
  if (state.isRendering) return;
  clearError();

  // バリデーション
  if (state.materials.length === 0) {
    showError('素材を1つ以上追加してください（写真かテキスト画像）');
    return;
  }
  if (!state.audio) {
    showError('音楽ファイルを選択してください');
    return;
  }
  if (!window.MediaRecorder) {
    showError('この端末ではMediaRecorderが使えないため動画生成できません');
    return;
  }

  state.isRendering = true;
  $('#generateBtn').disabled = true;
  $('#previewCard').hidden = true;
  setProgress(0, '準備中...');

  /* --- ユーザージェスチャ中に AudioContext と audio要素を起動 --- */
  let audioCtx = null, audioEl = null, audioTracks = [], silentFallback = false;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      audioCtx = new AC();
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      audioEl = new Audio();
      audioEl.src = state.audio.url;
      audioEl.preload = 'auto';
      audioEl.crossOrigin = 'anonymous';

      // iOS再生ロック解除のため、いったん再生→一時停止
      try {
        await audioEl.play();
        audioEl.pause();
        audioEl.currentTime = 0;
      } catch (_) { /* ignore */ }

      const src  = audioCtx.createMediaElementSource(audioEl);
      const dest = audioCtx.createMediaStreamDestination();
      src.connect(dest);
      src.connect(audioCtx.destination); // 端末でも音を聞こえるように
      audioTracks = dest.stream.getAudioTracks();
    }
  } catch (err) {
    console.warn('音声経路の構築に失敗', err);
    silentFallback = true;
  }

  try {
    /* --- 表示秒数の決定 --- */
    const totalDur = state.audio.duration;
    const count    = state.materials.length;
    const perSec   = state.mode === 'auto'
      ? totalDur / count
      : state.settings.perSec;
    const videoDur = state.mode === 'auto'
      ? totalDur
      : Math.min(perSec * count, totalDur);

    /* --- 画像の事前ロード --- */
    setProgress(5, '画像を準備中...');
    const imgs = [];
    for (let i = 0; i < state.materials.length; i++) {
      imgs.push(await loadImageEl(state.materials[i].src));
      setProgress(5 + ((i + 1) / state.materials.length) * 15, '画像を準備中...');
    }

    /* --- canvas準備 --- */
    const [vw, vh] = parseSize(state.settings.size);
    const canvas = document.createElement('canvas');
    canvas.width = vw;
    canvas.height = vh;
    const ctx = canvas.getContext('2d');

    // 最初の1フレームを描画してからストリーム取得
    drawFrame(ctx, vw, vh, imgs[0], 1, state.settings.fit, state.settings.bgColor, 1);

    const fps = 30;
    const videoStream = canvas.captureStream(fps);

    /* --- 合成ストリーム作成 --- */
    const tracks = [...videoStream.getVideoTracks(), ...audioTracks];
    const combined = new MediaStream(tracks);

    /* --- MediaRecorder mimeType 自動選択 --- */
    const mimeCandidates = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a',
      'video/mp4',
      'video/webm;codecs=h264,opus',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    let mimeType = '';
    for (const m of mimeCandidates) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) {
        mimeType = m;
        break;
      }
    }
    const recorder = new MediaRecorder(combined, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };

    const recDone = new Promise((resolve, reject) => {
      recorder.onstop  = () => resolve();
      recorder.onerror = e => reject(e.error || new Error('録画エラー'));
    });

    recorder.start(100);

    /* --- 音声再生開始 --- */
    if (audioEl && !silentFallback) {
      try {
        await audioEl.play();
      } catch (err) {
        console.warn('音声再生に失敗しました。無音で出力します', err);
        showError('音声を再生できなかったため、無音動画として書き出します');
        silentFallback = true;
      }
    }

    /* --- 描画ループ --- */
    setProgress(20, '動画生成中...');
    const startTime = performance.now();
    await renderLoop(ctx, vw, vh, imgs, perSec, videoDur, startTime);

    /* --- 停止 --- */
    try { recorder.stop(); } catch (_) {}
    if (audioEl)  { try { audioEl.pause(); } catch (_) {} }
    if (audioCtx) { try { audioCtx.close(); } catch (_) {} }
    await recDone;

    /* --- Blob書き出し --- */
    setProgress(95, 'ファイルを書き出し中...');
    const finalMime = mimeType || (chunks[0] && chunks[0].type) || 'video/webm';
    const blob = new Blob(chunks, { type: finalMime });
    if (!blob.size) throw new Error('録画データが空でした');
    const ext = finalMime.includes('mp4') ? 'mp4' : 'webm';
    const url = URL.createObjectURL(blob);
    if (state.output && state.output.url) URL.revokeObjectURL(state.output.url);
    state.output = { blob, url, ext, mime: finalMime };

    /* --- プレビュー表示 --- */
    $('#previewCard').hidden = false;
    $('#previewVideo').src = url;
    const dl = $('#downloadBtn');
    dl.href = url;
    dl.download = 'movie_' + Date.now() + '.' + ext;

    setProgress(100, '完成しました！');
    setTimeout(() => { $('#progressArea').hidden = true; }, 1500);
    $('#previewCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    showError('動画生成に失敗: ' + (err.message || err));
    $('#progressArea').hidden = true;
  } finally {
    state.isRendering = false;
    $('#generateBtn').disabled = false;
  }
}

/* --- 描画ループ --- */
async function renderLoop(ctx, vw, vh, imgs, perSec, totalDur, startTime) {
  const transition = state.settings.transition;
  const fit = state.settings.fit;
  const bg = state.settings.bgColor;
  const transitionDur = Math.min(0.5, perSec * 0.25);

  return new Promise((resolve) => {
    const tick = () => {
      const elapsed = (performance.now() - startTime) / 1000;
      if (elapsed >= totalDur) {
        // 最終フレーム
        drawFrame(ctx, vw, vh, imgs[imgs.length - 1], 1, fit, bg, 1);
        resolve();
        return;
      }
      let idx = Math.floor(elapsed / perSec);
      if (idx >= imgs.length) idx = imgs.length - 1;
      const localT = elapsed - idx * perSec;

      let alpha = 1, scale = 1;
      if (transition === 'fade') {
        if (localT < transitionDur) {
          alpha = localT / transitionDur;
        } else if (localT > perSec - transitionDur) {
          alpha = Math.max(0, (perSec - localT) / transitionDur);
        }
      } else if (transition === 'zoom') {
        scale = 1 + (localT / perSec) * 0.05;
      }
      drawFrame(ctx, vw, vh, imgs[idx], alpha, fit, bg, scale);

      const pct = 20 + (elapsed / totalDur) * 75;
      setProgress(pct, `動画生成中... ${Math.round(elapsed)} / ${Math.round(totalDur)} 秒`);

      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/* --- 1フレーム描画 --- */
function drawFrame(ctx, vw, vh, img, alpha, fit, bg, scale) {
  // 背景
  if (bg === 'white') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, vw, vh);
  } else if (bg === 'blur') {
    try {
      ctx.save();
      ctx.filter = 'blur(40px) brightness(0.7)';
      const cr = drawCoverRect(img.naturalWidth, img.naturalHeight, vw, vh);
      ctx.drawImage(img, cr.x, cr.y, cr.w, cr.h);
      ctx.restore();
      ctx.filter = 'none';
    } catch (_) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, vw, vh);
    }
  } else {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, vw, vh);
  }

  // 画像
  ctx.save();
  ctx.globalAlpha = alpha;
  if (scale && scale !== 1) {
    const cx = vw / 2, cy = vh / 2;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
  }
  const rect = (fit === 'cover')
    ? drawCoverRect(img.naturalWidth, img.naturalHeight, vw, vh)
    : drawContainRect(img.naturalWidth, img.naturalHeight, vw, vh);
  ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

function drawContainRect(iw, ih, vw, vh) {
  const r = Math.min(vw / iw, vh / ih);
  const w = iw * r, h = ih * r;
  return { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
}
function drawCoverRect(iw, ih, vw, vh) {
  const r = Math.max(vw / iw, vh / ih);
  const w = iw * r, h = ih * r;
  return { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
}

/* =====================================================
 * 共有
 * ===================================================== */
async function shareVideo() {
  if (!state.output) return;
  const file = new File(
    [state.output.blob],
    'movie.' + state.output.ext,
    { type: state.output.mime }
  );
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '動画を共有' });
    } catch (err) {
      if (err && err.name !== 'AbortError') {
        showError('共有に失敗: ' + err.message);
      }
    }
  } else {
    showError('この端末では共有シートが使えません。「保存」ボタンからダウンロードしてください');
  }
}
