'use strict';
/*
 * 鼓笛隊れんしゅうアプリ
 *  - 合言葉 → 曲えらび → 練習画面
 *  - 楽譜（MusicXML）を OpenSheetMusicDisplay で表示し、
 *    同じファイルを自前で読み取って音の再生と鍵盤の光り方に使う
 *  - 時間の単位は「四分音符 = 1」（コード中では q と書く）
 */

// 曲データは合言葉で暗号化してある（曲データ/encrypt_songs.mjs と方式を合わせること）
// 合言葉そのものはどこにも置かない。曲の一覧を復号できたら合言葉が正しいとみなす
const KDF_SALT = 'kotekitai-app-v1';
const KDF_ITER = 150000;
const KEY_UNLOCK = 'kotekitai-key';
const KEY_PREFS = 'kotekitai-prefs';

const $ = (id) => document.getElementById(id);
const EPS = 1e-6;

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 保存できなくても動く */ } }

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}
function fatal(msg) {
  $('loading').hidden = true;
  $('fatal').textContent = msg;
  $('fatal').hidden = false;
}

const prefs = Object.assign(
  { mode: 'own', metronome: false, doremi: false, zoom: 0.8 },
  (() => { try { return JSON.parse(lsGet(KEY_PREFS) || '{}'); } catch (e) { return {}; } })()
);
function savePrefs() { lsSet(KEY_PREFS, JSON.stringify(prefs)); }

// =====================================================================
// 合言葉
// =====================================================================
let songKey = null; // 復号に使う鍵
let songList = [];

class WrongPassError extends Error {}

async function deriveKey(pass) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(KDF_SALT), iterations: KDF_ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']
  );
}

// 形式: "KTK1"(4バイト) + IV(12バイト) + 暗号文（認証タグつき）
async function fetchDecrypted(url, key = songKey) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error('ファイルが見つかりません：' + url);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (String.fromCharCode(...buf.slice(0, 4)) !== 'KTK1') throw new Error('ファイルの形式が正しくありません：' + url);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(4, 16) }, key, buf.slice(16));
    return new TextDecoder().decode(plain);
  } catch (e) {
    throw new WrongPassError('合言葉がちがいます');
  }
}

async function loadCatalog(key) {
  songList = JSON.parse(await fetchDecrypted('songs/songs.enc', key));
  songKey = key;
}

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  ensureAudio(); // タップしたこの瞬間に音を使えるようにしておく（iPhone 対策）
  const input = $('pass').value.trim().normalize('NFKC');
  if (!input) return;
  $('loginError').textContent = 'たしかめています…';
  try {
    const key = await deriveKey(input);
    await loadCatalog(key);
    lsSet(KEY_UNLOCK, toB64(await crypto.subtle.exportKey('raw', key)));
    $('loginError').textContent = '';
    openSongs();
  } catch (err) {
    $('loginError').textContent = err instanceof WrongPassError
      ? '合言葉がちがいます'
      : '読み込めませんでした。通信状況を確認してください。';
  }
});

// =====================================================================
// 曲えらび
// =====================================================================
async function openSongs() {
  stopPlayback();
  const wanted = new URLSearchParams(location.search).get('song');
  const direct = songList.find((s) => s.id === wanted);
  if (direct) { openSong(direct); return; }

  const ul = $('songList');
  ul.innerHTML = '';
  for (const s of songList) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '🎵 ' + s.title;
    b.addEventListener('click', () => {
      history.replaceState(null, '', '?song=' + encodeURIComponent(s.id));
      openSong(s);
    });
    li.appendChild(b);
    ul.appendChild(li);
  }
  show('songs');
}

$('backBtn').addEventListener('click', () => {
  history.replaceState(null, '', location.pathname);
  openSongs();
});

// =====================================================================
// MusicXML の読み取り（音の再生・鍵盤用）
// =====================================================================
const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function kindFromName(name, perc) {
  const n = name || '';
  if (perc) {
    if (/バスドラ|大太鼓|bass\s*drum|b\.?\s*d/i.test(n)) return 'bassdrum';
    if (/シンバル|cymbal/i.test(n)) return 'cymbal';
    if (/テナー|tenor|トム|tom/i.test(n)) return 'tom';
    return 'snare';
  }
  if (/鍵盤|ハーモニカ|ピアニカ|メロディオン|melodica|pianica|melodion/i.test(n)) return 'reed';
  if (/ファイフ|笛|フルート|ピッコロ|リコーダー|fife|flute|piccolo|recorder/i.test(n)) return 'flute';
  if (/グロッケン|鉄琴|木琴|ベル|glock|xylo|bell|vib/i.test(n)) return 'bell';
  if (/ピアノ|キーボード|piano|keyboard/i.test(n)) return 'piano';
  return 'soft';
}

// 打楽器パートの「パッド」（画面の太鼓）を決め、各音がどのパッドを光らせるかを n.pads に入れる。
// 戻り値: { pads, layout }（layout: 'row' = 横一列 / 'tenor' = テナードラムの並び）
// 太鼓が1つならリムショットはそのフチ、複数ならフチ専用のパッドにする
function makePads(partName, notes) {
  const drums = new Map();
  for (const n of notes) {
    if (!n.rim && !drums.has(n.padKey)) drums.set(n.padKey, { key: n.padKey, disp: n.disp, kind: n.kind, instName: n.instName });
  }
  const list = [...drums.values()].sort((a, b) => a.disp - b.disp);
  if (!list.length) list.push({ key: '_', disp: 0, kind: kindFromName(partName, true), instName: '' });
  if (/テナー|tenor/i.test(partName) && list.length >= 4 && list.length <= 6) return makeTenorPads(list, notes);

  // 横一列: 五線の位置が低い太鼓（大きい太鼓）を左に
  const named = new Set(list.map((d) => d.instName).filter(Boolean)).size === list.length;
  const pads = list.map((d, i) => ({
    label: list.length === 1 ? partName : (named ? d.instName : String(i + 1)),
    kind: d.kind,
    freq: 110 * Math.pow(2, (list.length > 1 ? i / (list.length - 1) : 0.5) * 1.6),
    rimRing: false,
    rimPad: false,
  }));
  if (notes.some((n) => n.rim)) {
    if (pads.length === 1) pads[0].rimRing = true;
    else pads.push({ label: 'フチ', kind: 'rim', rimRing: false, rimPad: true });
  }
  const idx = new Map(list.map((d, i) => [d.key, i]));
  for (const n of notes) {
    n.pads = [n.rim ? (pads[0].rimRing ? 0 : pads.length - 1) : idx.get(n.padKey)];
    n.freq = pads[n.pads[0]].freq;
  }
  return { pads, layout: 'row' };
}

// テナードラム: 奥に弧の形で 5・3・2・4（左→右）、中央の手前に 1・1。音程は 1:ミ 2:ド 3:ラ 4:ファ 5:レ（1が一番高い）
const TENOR_ARC = [5, 3, 2, 4];
const TENOR_MIDI = { 1: 64, 2: 60, 3: 57, 4: 53, 5: 50 };

function makeTenorPads(list, notes) {
  // 太鼓の番号: 楽器名に数字があればそれ、なければ五線の高い位置から 1・2・3…（6個なら上の2つが 1・1）
  const byHigh = [...list].sort((a, b) => b.disp - a.disp);
  byHigh.forEach((d, i) => {
    const m = d.instName.normalize('NFKC').match(/[1-9]/);
    const num = m ? Number(m[0]) : (list.length === 6 ? Math.max(1, i) : i + 1);
    d.num = Math.min(5, num);
  });
  const pads = [...TENOR_ARC, 1, 1].map((num) => ({
    label: String(num), num, kind: 'tom', freq: freq(TENOR_MIDI[num]), rimRing: false, rimPad: false,
  }));
  if (notes.some((n) => n.rim)) pads.push({ label: 'フチ', kind: 'rim', rimRing: false, rimPad: true });
  // 1番が楽譜で2つに分かれていれば左右それぞれに、1つなら左右の両方を光らせる
  const ones = byHigh.filter((d) => d.num === 1);
  const padsOf = new Map();
  for (const d of list) {
    if (d.num === 1) padsOf.set(d.key, ones.length >= 2 ? [ones.indexOf(d) === 0 ? 4 : 5] : [4, 5]);
    else padsOf.set(d.key, [TENOR_ARC.indexOf(d.num)]);
  }
  for (const n of notes) {
    n.pads = n.rim ? [pads.length - 1] : padsOf.get(n.padKey);
    n.freq = pads[n.pads[0]].freq;
  }
  return { pads, layout: 'tenor' };
}

function childText(el, sel) {
  const c = el.querySelector(sel);
  return c ? c.textContent.trim() : null;
}

function parseMusicXML(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('楽譜ファイルの形式が正しくありません');
  if (!doc.querySelector('score-partwise')) throw new Error('この楽譜の形式（score-timewise）には対応していません');

  const title = childText(doc, 'work > work-title') || childText(doc, 'movement-title') || '';

  // パート名と、パート内の楽器名（打楽器が1パートに複数入っている場合用）
  const partNames = {};
  const instNames = {};
  for (const sp of doc.querySelectorAll('part-list > score-part')) {
    partNames[sp.id] = childText(sp, 'part-name') || childText(sp, 'part-abbreviation') || sp.id;
    for (const si of sp.querySelectorAll('score-instrument')) {
      instNames[si.id] = childText(si, 'instrument-name') || '';
    }
  }

  let tempo = null;
  const measureLens = [];   // 小節ごとの長さ（全パートの最大）
  const measureNums = [];
  const timeSigs = [];      // 小節ごとの拍子
  const rawParts = [];

  // 練習記号（A・B…）・コーダ・セーニョ・テンポ表示は、上のパートにしか書かれていないことが多い。
  // 表示するパートを切りかえても見えるよう、あとで全パートにコピーする
  const shared = new Map(); // "小節:記号" → { mi, label, el, parts: 書かれているパート }
  function addShared(mi, pi, label, el) {
    const k = mi + ':' + label;
    const s = shared.get(k) || { mi, label, el, parts: new Set() };
    s.parts.add(pi);
    shared.set(k, s);
  }

  const partEls = [...doc.querySelectorAll('score-partwise > part')];
  partEls.forEach((partEl, pi) => {
    let divisions = 1;
    let beats = 4, beatType = 4;
    const notes = [];
    [...partEl.children].filter((m) => m.tagName === 'measure').forEach((m, mi) => {
      let t = 0, maxT = 0, lastStart = 0;
      if (pi === 0) measureNums[mi] = m.getAttribute('number') || String(mi + 1);
      for (const el of m.children) {
        switch (el.tagName) {
          case 'attributes': {
            const d = childText(el, 'divisions');
            if (d) divisions = Number(d);
            const b = childText(el, 'time > beats');
            const bt = childText(el, 'time > beat-type');
            if (b && bt) { beats = parseInt(b, 10); beatType = Number(bt); }
            break;
          }
          case 'direction':
          case 'sound': {
            if (el.tagName === 'direction') {
              for (const dt of el.querySelectorAll(':scope > direction-type > *')) {
                const label = dt.tagName === 'rehearsal' ? dt.textContent.trim()
                  : dt.tagName === 'coda' ? 'コーダ'
                  : dt.tagName === 'segno' ? 'セーニョ' : null;
                if (label) addShared(mi, pi, label, el);
                else if (dt.tagName === 'metronome') addShared(mi, pi, '♩', el);
              }
            }
            const s = el.tagName === 'sound' ? el : el.querySelector('sound[tempo]');
            if (tempo === null && s && s.getAttribute('tempo')) tempo = Number(s.getAttribute('tempo'));
            if (tempo === null && el.tagName === 'direction') {
              const pm = childText(el, 'metronome > per-minute');
              const unit = childText(el, 'metronome > beat-unit');
              const mul = { whole: 4, half: 2, quarter: 1, eighth: 0.5 }[unit];
              if (pm && mul) tempo = Number(pm) * mul * (el.querySelector('metronome > beat-unit-dot') ? 1.5 : 1);
            }
            break;
          }
          case 'backup': t -= Number(childText(el, 'duration')) / divisions; break;
          case 'forward': t += Number(childText(el, 'duration')) / divisions; maxT = Math.max(maxT, t); break;
          case 'note': {
            if (el.querySelector(':scope > grace') || el.querySelector(':scope > cue')) break;
            const dur = Number(childText(el, ':scope > duration') || 0) / divisions;
            const isChord = !!el.querySelector(':scope > chord');
            const start = isChord ? lastStart : t;
            if (!isChord) { lastStart = t; t += dur; maxT = Math.max(maxT, t); }
            if (el.querySelector(':scope > rest')) break;
            const p = el.querySelector(':scope > pitch');
            const un = el.querySelector(':scope > unpitched');
            if (!p && !un) break;
            let midi = null;
            if (p) {
              midi = (Number(childText(p, 'octave')) + 1) * 12 + STEP[childText(p, 'step')] + Math.round(Number(childText(p, 'alter') || 0));
            }
            const instEl = el.querySelector(':scope > instrument');
            notes.push({
              mi, off: start, dur, midi, perc: !p,
              inst: instEl ? instEl.getAttribute('id') : null,
              tieStop: !!el.querySelector(':scope > tie[type="stop"]'),
              // 打楽器用: 五線上の位置（どの太鼓かの区別に使う）・符頭の形・アクセント
              disp: un ? (Number(childText(un, 'display-octave') || 4) + 1) * 12 + (STEP[childText(un, 'display-step')] || 0) : null,
              head: childText(el, ':scope > notehead') || '',
              accent: !!el.querySelector(':scope > notations > articulations > accent, :scope > notations > articulations > strong-accent'),
            });
            break;
          }
        }
      }
      if (pi === 0) timeSigs[mi] = { beats, beatType };
      measureLens[mi] = Math.max(measureLens[mi] || 0, maxT);
    });
    rawParts.push({ id: partEl.id, name: partNames[partEl.id] || partEl.id, notes });
  });

  // 小節の開始位置
  const measures = [];
  let pos = 0;
  measureLens.forEach((len, mi) => {
    const ts = timeSigs[mi] || timeSigs[mi - 1] || { beats: 4, beatType: 4 };
    if (!len) len = ts.beats * 4 / ts.beatType; // 空の小節
    measures.push({ num: measureNums[mi] || String(mi + 1), start: pos, len, beats: ts.beats, beatType: ts.beatType });
    pos += len;
  });

  const parts = rawParts.map((rp) => {
    const allPerc = rp.notes.length > 0 && rp.notes.every((n) => n.perc);
    const partKind = kindFromName(rp.name, allPerc);
    let list = rp.notes.map((n) => {
      const instName = instNames[n.inst] || '';
      const kind = n.perc ? kindFromName(instName || rp.name, true) : partKind;
      // リムショット: 楽器名に「リム」など、または × 形の符頭（シンバルの × は除く）
      const rim = n.perc && (/リム|フチ|rim|cross\s*stick|side\s*stick/i.test(instName)
        || (kind !== 'cymbal' && /^(x|cross|circle-x)$/.test(n.head)));
      return {
        q: measures[n.mi].start + n.off,
        dur: n.dur,
        midi: n.midi,
        perc: n.perc,
        kind,
        tieStop: n.tieStop,
        accent: n.accent,
        rim,
        disp: n.disp,
        padKey: n.perc ? (rim ? 'rim' : (n.inst || 'd' + n.disp)) : null,
        instName,
      };
    }).sort((a, b) => a.q - b.q);
    // タイでつながった音は1つの長い音にまとめる（打楽器はタイの後ろを叩かない）
    const merged = [];
    for (const n of list) {
      if (n.tieStop) {
        const same = (m) => (n.perc ? m.padKey === n.padKey : m.midi === n.midi);
        const prev = [...merged].reverse().find((m) => same(m) && Math.abs(m.q + m.dur - n.q) < 0.01);
        if (prev) { prev.dur += n.dur; continue; }
      }
      merged.push(n);
    }
    const pitched = merged.filter((n) => !n.perc);
    return {
      name: rp.name,
      kind: partKind,
      perc: allPerc,
      notes: merged,
      ...(allPerc ? makePads(rp.name, merged) : { pads: [], layout: null }),
      min: pitched.length ? Math.min(...pitched.map((n) => n.midi)) : null,
      max: pitched.length ? Math.max(...pitched.map((n) => n.midi)) : null,
    };
  });

  // 記号を全パートにコピー（表示用）
  const copied = new Map(); // 元の要素 → コピー済みのパート
  for (const s of shared.values()) {
    partEls.forEach((partEl, pi) => {
      if (s.parts.has(pi)) return;
      const done = copied.get(s.el) || new Set();
      if (done.has(pi)) return;
      done.add(pi);
      copied.set(s.el, done);
      const m = partEl.querySelectorAll(':scope > measure')[s.mi];
      if (!m) return;
      const c = s.el.cloneNode(true);
      c.querySelectorAll('staff, voice, offset').forEach((x) => x.remove());
      let ref = m.firstElementChild;
      while (ref && (ref.tagName === 'attributes' || ref.tagName === 'print')) ref = ref.nextElementSibling;
      m.insertBefore(c, ref);
    });
  }

  // 演奏を始める場所の候補（練習記号・コーダ・セーニョ）
  const marks = [...shared.values()]
    .filter((s) => s.label !== '♩' && s.mi < measures.length)
    .map((s) => ({ mi: s.mi, label: s.label }))
    .sort((a, b) => a.mi - b.mi);

  return { title, parts, measures, marks, tempo: Math.round(tempo || 100), totalQ: pos, doc };
}

// 表示用に、選んだパートだけの楽譜を作る
// （練習記号やテンポは一番上のパートにしか描かれないため、ほかのパートを隠すのではなく取りのぞく）
function partXml(song, pi) {
  const d = song.doc.cloneNode(true);
  const partEls = [...d.querySelectorAll('score-partwise > part')];
  const keep = partEls[pi].id;
  for (const p of partEls) if (p.id !== keep) p.remove();
  for (const sp of d.querySelectorAll('part-list > score-part')) if (sp.id !== keep) sp.remove();
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(d.documentElement);
}

// =====================================================================
// 音（Web Audio）
// =====================================================================
let ctx = null, master = null, noiseBuf = null;

function ensureAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.connect(ctx.destination);
    master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(comp);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state !== 'running') ctx.resume();
}

const freq = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

// 音の高さがある楽器の音を1つ作る。stop(時刻) で止める
function makeVoice(kind, midi, t, vol, dest) {
  const f = freq(midi);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.connect(dest);
  const oscs = [];
  const osc = (type, fr, v, to) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = fr;
    const og = ctx.createGain();
    og.gain.value = v;
    o.connect(og).connect(to || g);
    o.start(t);
    oscs.push(o);
  };
  let release = 0.05;
  switch (kind) {
    case 'reed': { // 鍵盤ハーモニカ風
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.min(f * 5, 5000);
      lp.connect(g);
      osc('sawtooth', f, 0.45, lp);
      osc('square', f * 1.004, 0.25, lp);
      g.gain.setTargetAtTime(vol, t, 0.012);
      release = 0.04;
      break;
    }
    case 'flute':
      osc('sine', f, 0.8);
      osc('triangle', f * 2, 0.08);
      g.gain.setTargetAtTime(vol, t, 0.025);
      release = 0.05;
      break;
    case 'piano':
      osc('triangle', f, 0.7);
      osc('sine', f * 2, 0.15);
      g.gain.setTargetAtTime(vol, t, 0.003);
      g.gain.setTargetAtTime(vol * 0.25, t + 0.02, 0.5);
      release = 0.12;
      break;
    case 'bell':
      osc('sine', f, 0.7);
      osc('sine', f * 4, 0.12);
      g.gain.setTargetAtTime(vol, t, 0.002);
      g.gain.setTargetAtTime(0.0001, t + 0.01, 0.4);
      release = 0.3;
      break;
    default:
      osc('triangle', f, 0.8);
      g.gain.setTargetAtTime(vol, t, 0.015);
      release = 0.06;
  }
  return {
    stop(t2) {
      const at = Math.max(t2, t + 0.01);
      g.gain.setTargetAtTime(0, at, release / 3);
      for (const o of oscs) o.stop(at + release * 3);
    },
  };
}

// freqHz: 太鼓の音の高さ（テナードラムなど。なければ標準の高さ）
function playDrum(kind, t, vol, dest, freqHz) {
  const g = ctx.createGain();
  g.connect(dest);
  const noise = (hp, decay, v) => {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hp;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(v, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + decay);
    s.connect(f).connect(ng).connect(g);
    s.start(t);
    s.stop(t + decay + 0.05);
  };
  const tone = (f0, f1, decay, v) => {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + decay);
    const og = ctx.createGain();
    og.gain.setValueAtTime(v, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + decay);
    o.connect(og).connect(g);
    o.start(t);
    o.stop(t + decay + 0.05);
  };
  g.gain.value = vol;
  switch (kind) {
    case 'bassdrum': tone(120, 45, 0.3, 1.0); break;
    case 'cymbal': noise(6000, 1.0, 0.35); break;
    case 'tom': {
      const f = freqHz || 150;
      tone(f, f * 0.85, 0.3, 0.75); // 音程が分かるよう、音の下がり方は小さめ
      noise(2000, 0.06, 0.15);
      break;
    }
    case 'rim': noise(2500, 0.08, 0.9); tone(520, 420, 0.04, 0.5); break; // リムショット

    default: noise(1500, 0.15, 0.6); tone(220, 160, 0.08, 0.3); // スネア
  }
}

function playClick(t, accent, dest) {
  const o = ctx.createOscillator();
  o.frequency.value = accent ? 1600 : 1000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(accent ? 0.5 : 0.3, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + 0.06);
}

// =====================================================================
// 練習画面の状態
// =====================================================================
const state = {
  song: null,       // parseMusicXML の結果
  partIdx: 0,       // 練習するパート
  pos: 0,           // 止まっているときの位置
  loopOn: false,
  loopFrom: 0,      // 小節の番号（配列の位置）
  loopTo: 0,
  bpm: 100,         // はやさ（1分間に四分音符いくつ）
  startQ: 0,        // 演奏を始める場所
};
let osmd = null;

const measureText = (mi) => {
  const m = state.song.measures[mi];
  const mk = state.song.marks.filter((x) => x.mi === mi).map((x) => x.label);
  return mk.length ? `${m.num}（${mk.join('・')}）` : m.num;
};

async function openSong(entry) {
  stopPlayback();
  show('practice');
  $('loading').hidden = false;
  $('songTitle').textContent = entry.title;
  try {
    const text = await fetchDecrypted('songs/' + entry.file);
    const song = parseMusicXML(text);
    state.song = song;
    state.pos = 0;
    state.startQ = 0;
    state.loopOn = false;
    state.loopFrom = 0;
    state.loopTo = song.measures.length - 1;
    setBpm(song.tempo);

    // 演奏を始める場所: 最初から / A から / コーダから …
    const st = $('startSelect');
    st.innerHTML = '';
    const addStart = (label, q) => {
      const o = document.createElement('option');
      o.value = q;
      o.textContent = label;
      st.appendChild(o);
    };
    addStart('最初から', 0);
    for (const mk of song.marks) {
      if (mk.mi === 0 && mk.label.length === 1) continue; // 1小節目の「A」は「最初から」と同じ
      addStart(`${mk.label}から（${song.measures[mk.mi].num}小節）`, song.measures[mk.mi].start);
    }
    st.value = '0';
    st.hidden = st.options.length < 2;

    // 練習するパートの初期値: 鍵盤ハーモニカっぽい名前 → 音の高さがある最初のパート
    let idx = song.parts.findIndex((p) => p.kind === 'reed');
    if (idx < 0) idx = song.parts.findIndex((p) => !p.perc);
    state.partIdx = Math.max(0, idx);

    const sel = $('partSelect');
    sel.innerHTML = '';
    song.parts.forEach((p, i) => {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = p.name;
      sel.appendChild(o);
    });
    sel.value = state.partIdx;
    sel.hidden = song.parts.length < 2;

    for (const id of ['loopFrom', 'loopTo']) {
      const s = $(id);
      s.innerHTML = '';
      song.measures.forEach((m, i) => {
        const o = document.createElement('option');
        o.value = i;
        o.textContent = measureText(i);
        s.appendChild(o);
      });
    }
    $('loopFrom').value = state.loopFrom;
    $('loopTo').value = state.loopTo;
    updateLoopButton();

    if (typeof opensheetmusicdisplay === 'undefined') throw new Error('楽譜の表示部品を読み込めませんでした。通信状況を確認してください。');
    if (!osmd) {
      osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay($('score'), {
        autoResize: false, // 画面の大きさが変わったときは下の resize で描きなおす
        backend: 'svg',
        drawTitle: false,
        drawSubtitle: false,
        drawComposer: false,
        drawLyricist: false,
        drawCredits: false,
        drawPartNames: false,
        drawMeasureNumbers: true,
        followCursor: false,
      });
    }
    await renderScore();
    $('loading').hidden = true;
  } catch (e) {
    console.error(e);
    fatal('曲を開けませんでした：' + e.message);
  }
}

// 打楽器のパートのときは、ボタンを左に縦ならび・楽譜を1段の帯にして、太鼓を大きく出す
const isPercMode = () => !!(state.song && state.song.parts[state.partIdx].perc);
const scoreZoom = () => (isPercMode() ? prefs.zoom * 0.7 : prefs.zoom);
const slots = new Map(); // 動かした選択欄の元の場所

function moveTo(el, parent) {
  if (!slots.has(el)) slots.set(el, { parent: el.parentNode, next: el.nextSibling });
  parent.appendChild(el);
}
function moveBack(el) {
  const s = slots.get(el);
  if (s) s.parent.insertBefore(el, s.next);
}

function setPercMode(on) {
  $('practice').classList.toggle('perc', on);
  $('percRows').hidden = !on;
  if (on) {
    moveTo($('partSelect'), $('partSlot'));
    moveTo($('startSelect'), $('startSlot'));
  } else {
    moveBack($('partSelect'));
    moveBack($('startSelect'));
  }
  osmd.setOptions({ renderSingleHorizontalStaffline: on });
}

async function renderScore() {
  setPercMode(isPercMode());
  await osmd.load(partXml(state.song, state.partIdx));
  osmd.zoom = scoreZoom();
  osmd.render();
  osmd.cursor.show();
  cursor.reset();
  buildKeyboard();
  updateModeLabel();
  updateView(state.pos);
}

$('partSelect').addEventListener('change', async (e) => {
  const wasPlaying = player.playing;
  const q = currentQ();
  stopPlayback();
  state.partIdx = Number(e.target.value);
  state.pos = q;
  await renderScore();
  if (wasPlaying) startPlayback(q);
});

// =====================================================================
// 楽譜のカーソル（今どこを弾いているか）
// =====================================================================
const cursor = {
  q: 0,
  nextQ: Infinity,
  reset() {
    osmd.cursor.reset();
    this.q = this.ts();
    this.calcNext();
  },
  ts() { return osmd.cursor.iterator.currentTimeStamp.RealValue * 4; },
  calcNext() {
    const it = osmd.cursor.iterator.clone();
    it.moveToNext();
    this.nextQ = it.EndReached ? Infinity : it.currentTimeStamp.RealValue * 4;
  },
  moveTo(q) {
    let moved = false;
    if (q < this.q - EPS) { this.reset(); moved = true; }
    let guard = 0;
    while (q >= this.nextQ - EPS && guard++ < 2000) {
      osmd.cursor.next();
      this.q = this.ts();
      this.calcNext();
      moved = true;
    }
    if (moved) this.scrollIntoView();
  },
  scrollIntoView() {
    const el = osmd.cursor.cursorElement;
    const wrap = $('scoreWrap');
    if (!el) return;
    if (isPercMode()) {
      // 1段の帯: 今の位置が左から3分の1あたりに来るよう横に流す
      const left = el.offsetLeft;
      if (left < wrap.scrollLeft + 20 || left > wrap.scrollLeft + wrap.clientWidth * 0.6) {
        wrap.scrollTo({ left: Math.max(0, left - wrap.clientWidth / 3), behavior: 'smooth' });
      }
      return;
    }
    const top = el.offsetTop;
    const h = el.offsetHeight || 60;
    if (top < wrap.scrollTop || top + h > wrap.scrollTop + wrap.clientHeight) {
      wrap.scrollTo({ top: Math.max(0, top - 8), behavior: 'smooth' });
    }
  },
};

// =====================================================================
// 鍵盤
// =====================================================================
const DOREMI = ['ド', 'ド#', 'レ', 'レ#', 'ミ', 'ファ', 'ファ#', 'ソ', 'ソ#', 'ラ', 'ラ#', 'シ'];
const isBlack = (m) => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
let keyEls = new Map(); // midi → 要素

function buildKeyboard() {
  const kb = $('keyboard');
  kb.innerHTML = '';
  keyEls = new Map();
  const part = state.song.parts[state.partIdx];
  buildPads(part);
  kb.hidden = part.perc; // 打楽器は鍵盤のかわりに太鼓パッドを出す
  if (part.perc) return;
  // 左端は曲の一番低い音から下にさがって「ド」か「ファ」（鍵盤ハーモニカの左端はファ）。
  // そこから最低2オクターブ（白鍵15個）を表示し、曲の音域がもっと広ければ「ド」か「ファ」まで広げる
  const pc = (m) => ((m % 12) + 12) % 12;
  let lo = part.min ?? 60;
  const top = part.max ?? 72;
  while (pc(lo) !== 0 && pc(lo) !== 5) lo--;
  let hi = lo + 24;
  if (top > hi) { hi = top; while (pc(hi) !== 0 && pc(hi) !== 5) hi++; }

  const whites = [];
  for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites.push(m);
  const w = 100 / whites.length;
  let wi = 0;
  for (let m = lo; m <= hi; m++) {
    const k = document.createElement('div');
    k.dataset.midi = m;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = DOREMI[m % 12];
    label.hidden = !prefs.doremi;
    k.appendChild(label);
    if (isBlack(m)) {
      k.className = 'key black';
      k.style.left = `calc(${wi * w}% - ${w * 0.3}% + 4px)`;
      k.style.width = `${w * 0.6}%`;
    } else {
      k.className = 'key white';
      wi++;
    }
    kb.appendChild(k);
    keyEls.set(m, k);
  }
}

function setDoremi(on) {
  for (const l of $('keyboard').querySelectorAll('.label')) l.hidden = !on;
}

// 位置 q で「今おす音」を光らせる
function updateKeys(q) {
  if (!keyEls.size) return;
  const notes = state.song.parts[state.partIdx].notes;
  const on = new Set();
  for (const n of notes) {
    if (n.q <= q + EPS && q < n.q + n.dur * 0.95) on.add(n.midi);
  }
  for (const [m, el] of keyEls) el.classList.toggle('on', on.has(m));
}

// 指で押したときの音と判定（複数の指で同時に押せる）
const touching = new Map(); // pointerId → { midi, voice }

function keyAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const k = el && el.closest ? el.closest('.key') : null;
  return k && $('keyboard').contains(k) ? Number(k.dataset.midi) : null;
}

function pressKey(id, midi) {
  ensureAudio();
  const kind = state.song.parts[state.partIdx].kind;
  const voice = makeVoice(kind, midi, ctx.currentTime, 0.45, master);
  touching.set(id, { midi, voice });
  const el = keyEls.get(midi);
  if (!el) return;
  el.classList.add('pressed');
  if (player.playing) {
    // 今鳴っている音か、すぐ次（八分音符ぶん以内）の音なら「あたり」
    const q = currentQ();
    const ok = state.song.parts[state.partIdx].notes.some(
      (n) => n.midi === midi && n.q - 0.5 <= q && q < n.q + n.dur
    );
    el.classList.remove('good', 'miss');
    void el.offsetWidth;
    el.classList.add(ok ? 'good' : 'miss');
    setTimeout(() => el.classList.remove('good', 'miss'), 350);
  }
}

function releaseKey(id) {
  const t = touching.get(id);
  if (!t) return;
  t.voice.stop(ctx.currentTime);
  const el = keyEls.get(t.midi);
  if (el && ![...touching.values()].some((o) => o !== t && o.midi === t.midi)) el.classList.remove('pressed');
  touching.delete(id);
}

const kbEl = $('keyboard');
kbEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const m = keyAt(e.clientX, e.clientY);
  if (m === null) return;
  try { kbEl.setPointerCapture(e.pointerId); } catch (err) { /* 古い端末 */ }
  pressKey(e.pointerId, m);
});
kbEl.addEventListener('pointermove', (e) => {
  const t = touching.get(e.pointerId);
  if (!t) return;
  const m = keyAt(e.clientX, e.clientY);
  if (m !== null && m !== t.midi) { releaseKey(e.pointerId); pressKey(e.pointerId, m); }
});
for (const ev of ['pointerup', 'pointercancel']) {
  kbEl.addEventListener(ev, (e) => releaseKey(e.pointerId));
}

// =====================================================================
// 打楽器パッド
// =====================================================================
let padEls = []; // { el }
const PAD_FLASH = 0.25; // パッドが光っている長さ（拍）
const RIM_RATIO = 0.16; // パッドの半径のうちフチの太さ

// 上から見た太鼓の絵（SVG）。フープ（フチ）は半径 42〜50、ヘッド（皮）は半径 42 まで
// → フチの太さは RIM_RATIO（0.16）と合わせてある
function drumSvg(pad) {
  let s = '<svg viewBox="0 0 100 100" aria-hidden="true">';
  if (pad.kind === 'cymbal') {
    s += '<circle cx="50" cy="50" r="49.5" fill="url(#g-bronze)"/>';
    for (const r of [45, 39, 33, 27, 21]) s += `<circle cx="50" cy="50" r="${r}" fill="none" stroke="rgba(110,70,10,.28)" stroke-width=".7"/>`;
    s += '<circle cx="50" cy="50" r="14" fill="url(#g-bell)"/><circle cx="50" cy="50" r="2.6" fill="#5b4312"/>';
    s += '<circle class="glow-head" cx="50" cy="50" r="49.5"/>';
    return s + '</svg>';
  }
  const dark = pad.kind === 'bassdrum';
  s += `<circle cx="50" cy="50" r="49.5" fill="url(#${dark ? 'g-hoop-dark' : 'g-chrome'})"/>`;
  // 皮を張る金具（テンションボルト）
  const lugs = dark ? 12 : 10;
  for (let i = 0; i < lugs; i++) {
    const a = (i + 0.5) / lugs * Math.PI * 2;
    s += `<circle cx="${(50 + Math.cos(a) * 46).toFixed(2)}" cy="${(50 + Math.sin(a) * 46).toFixed(2)}" r="1.7" fill="${dark ? '#c9d3e6' : '#4b5058'}"/>`;
  }
  s += '<circle cx="50" cy="50" r="43" fill="rgba(0,0,0,.28)"/>'; // フープの内側のかげ
  s += pad.rimPad
    ? '<circle cx="50" cy="50" r="42" fill="#262a30"/>'
    : '<circle cx="50" cy="50" r="42" fill="url(#g-head)"/><circle cx="50" cy="50" r="36" fill="none" stroke="rgba(0,0,0,.05)" stroke-width="1"/>';
  s += '<circle class="glow-head" cx="50" cy="50" r="42"/>';
  s += '<circle class="glow-rim" cx="50" cy="50" r="46" fill="none" stroke-width="7.5"/>';
  return s + '</svg>';
}

function buildPads(part) {
  const box = $('pads');
  box.innerHTML = '';
  padEls = [];
  if (!part.perc) { box.hidden = true; return; }
  box.hidden = false;
  box.classList.toggle('tenor', part.layout === 'tenor');
  part.pads.forEach((pad, i) => {
    const el = document.createElement('div');
    el.className = 'pad' + (pad.rimRing ? ' has-rim' : '') + (pad.rimPad ? ' rim-pad' : '');
    el.dataset.pad = i;
    el.innerHTML = drumSvg(pad) + '<span class="pad-text"><span class="pad-accent">＞</span><span class="pad-label"></span></span>';
    el.querySelector('.pad-label').textContent = pad.label;
    if (pad.kind === 'cymbal') el.classList.add('cymbal');
    box.appendChild(el);
    padEls.push({ el });
  });
  requestAnimationFrame(sizePads);
}

// パッドの大きさと位置を、パッドの欄の大きさに合わせて決める
function sizePads() {
  const box = $('pads');
  if (!padEls.length || box.hidden) return;
  const part = state.song.parts[state.partIdx];
  const W = box.clientWidth, H = box.clientHeight;
  const gap = 10;
  const place = (el, size, left, top, fontRatio) => {
    el.style.width = el.style.height = size + 'px';
    el.style.left = left == null ? '' : left + 'px';
    el.style.top = top == null ? '' : top + 'px';
    el.style.setProperty('--rim', el.classList.contains('has-rim') || el.classList.contains('rim-pad') ? Math.round(size / 2 * RIM_RATIO) + 'px' : '3px');
    el.style.fontSize = Math.max(12, Math.min(40, size * fontRatio)) + 'px';
  };

  if (part.layout === 'tenor') {
    // 奥に弧（左から 5・3・2・4。外側ほど手前に下げる）、中央の手前に 1・1
    const s = Math.max(36, Math.min((H - 20) / 1.8, (W - 24 - gap * 3) / 4));
    const s1 = s * 0.75;
    const cx = W / 2;
    const top0 = 6;
    const arcDrop = [0.35, 0, 0, 0.35];
    const frontTop = top0 + s + 4;
    padEls.forEach(({ el }, i) => {
      if (i < 4) {
        place(el, s, cx + (i - 1.5) * (s + gap) - s / 2, top0 + arcDrop[i] * s, 0.32);
      } else if (i < 6) {
        const c = cx + (i === 4 ? -1 : 1) * (s1 / 2 + gap / 2);
        place(el, s1, c - s1 / 2, frontTop, 0.32);
      } else {
        place(el, s1 * 0.8, W - s1 * 0.8 - 8, H - s1 * 0.8 - 8, 0.18); // フチ専用（右下）
      }
    });
    return;
  }

  // 横一列: 全部ならび、高さにもおさまる一番大きい円
  const n = padEls.length;
  const size = Math.max(40, Math.min(H - 20, (W - 24 - 12 * (n - 1)) / n));
  for (const { el } of padEls) place(el, size, null, null, 1 / 9);
}

// 位置 q で、今叩くパッドを光らせる
function updatePads(q) {
  if (!padEls.length) return;
  const part = state.song.parts[state.partIdx];
  const st = padEls.map(() => ({ on: false, rim: false, accent: false }));
  for (const n of part.notes) {
    if (!(n.q <= q + EPS && q < n.q + Math.min(PAD_FLASH, n.dur))) continue;
    for (const i of n.pads) {
      const s = st[i];
      if (!s) continue;
      if (n.rim && part.pads[i].rimRing) s.rim = true; else s.on = true;
      if (n.accent) s.accent = true;
    }
  }
  padEls.forEach(({ el }, i) => {
    el.classList.toggle('on', st[i].on);
    el.classList.toggle('rim-on', st[i].rim);
    el.classList.toggle('accent', st[i].accent);
  });
}

// タップした所から一番近い太鼓（太鼓の外やすき間をタップしても、近い太鼓を叩いたことにする）
// d: 太鼓の中心からの距離（半径 = 1）
function padAt(x, y) {
  let best = null;
  padEls.forEach(({ el }, i) => {
    const r = el.getBoundingClientRect();
    const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2)) / (r.width / 2);
    if (!best || d < best.d) best = { i, el, d };
  });
  return best && best.d <= 2.2 ? best : null;
}

function hitPad(e) {
  const hit = padAt(e.clientX, e.clientY);
  if (!hit) return;
  ensureAudio();
  const { i, el, d } = hit;
  const part = state.song.parts[state.partIdx];
  const pad = part.pads[i];
  // フチつきの太鼓は、フープ（外側の銀色の輪）のあたりをタップしたらリムショット
  const rim = pad.rimPad || (pad.rimRing && d > 1 - RIM_RATIO && d <= 1.15);
  playDrum(rim ? 'rim' : pad.kind, ctx.currentTime, 0.6, master, pad.freq);
  el.classList.add('pressed');
  setTimeout(() => el.classList.remove('pressed'), 120);
  if (player.playing) {
    // 叩くタイミングの前後 0.15 秒以内なら「あたり」
    const q = currentQ();
    const tol = 0.15 * player.bps;
    const ok = part.notes.some((n) => n.pads.includes(i) && n.rim === rim && Math.abs(n.q - q) <= tol);
    el.classList.remove('good', 'miss');
    void el.offsetWidth;
    el.classList.add(ok ? 'good' : 'miss');
    setTimeout(() => el.classList.remove('good', 'miss'), 350);
  }
}

const padsEl = $('pads');
padsEl.addEventListener('pointerdown', (e) => { e.preventDefault(); hitPad(e); });
padsEl.addEventListener('contextmenu', (e) => e.preventDefault());
kbEl.addEventListener('contextmenu', (e) => e.preventDefault());

// =====================================================================
// 再生
// =====================================================================
const player = {
  playing: false,
  events: [],
  idx: 0,
  segs: [],      // { t: 音の時刻, q: そのときの位置 }（くり返すたびに増える）
  schedQ: 0,
  rangeStart: 0,
  rangeEnd: 0,
  bps: 1,        // 1秒あたり何拍（四分音符）すすむか
  bus: null,
  timer: null,
  raf: 0,
  wakeLock: null,
};

function playRange() {
  const ms = state.song.measures;
  if (!state.loopOn) return [0, state.song.totalQ];
  const a = Math.min(state.loopFrom, state.loopTo);
  const b = Math.max(state.loopFrom, state.loopTo);
  return [ms[a].start, ms[b].start + ms[b].len];
}

function buildEvents() {
  const song = state.song;
  const ev = [];
  song.parts.forEach((p, i) => {
    const own = i === state.partIdx;
    if (prefs.mode === 'own' && !own) return;
    if (prefs.mode === 'accomp' && own) return;
    const vol = own ? 0.5 : (prefs.mode === 'all' ? 0.3 : 0.4);
    for (const n of p.notes) ev.push({ q: n.q, type: 'note', n, vol });
  });
  if (prefs.metronome) {
    for (const m of song.measures) {
      const step = 4 / m.beatType;
      for (let b = 0; b < m.beats && b * step < m.len - EPS; b++) {
        ev.push({ q: m.start + b * step, type: 'click', accent: b === 0 });
      }
    }
  }
  return ev.sort((a, b) => a.q - b.q);
}

function firstIdx(q) {
  const ev = player.events;
  let i = 0;
  while (i < ev.length && ev[i].q < q - EPS) i++;
  return i;
}

function startPlayback(fromQ) {
  ensureAudio();
  if (!ctx) { fatal('この端末では音を鳴らせません'); return; }
  const [rs, re] = playRange();
  if (fromQ < rs - EPS || fromQ >= re - EPS) fromQ = rs;
  player.rangeStart = rs;
  player.rangeEnd = re;
  player.bps = state.bpm / 60;
  player.events = buildEvents();
  player.idx = firstIdx(fromQ);
  player.schedQ = fromQ;
  player.segs = [{ t: ctx.currentTime + 0.12, q: fromQ }];
  player.bus = ctx.createGain();
  player.bus.connect(master);
  player.playing = true;
  $('playBtn').textContent = $('sbPlay').textContent = '⏸';
  $('playBtn').setAttribute('aria-label', 'とめる');
  schedule();
  player.timer = setInterval(schedule, 25);
  player.raf = requestAnimationFrame(frame);
  if (navigator.wakeLock) navigator.wakeLock.request('screen').then((l) => { player.wakeLock = l; }).catch(() => {});
}

function stopPlayback() {
  if (!player.playing) return;
  state.pos = currentQ();
  player.playing = false;
  clearInterval(player.timer);
  cancelAnimationFrame(player.raf);
  const bus = player.bus;
  bus.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
  setTimeout(() => bus.disconnect(), 300);
  if (player.wakeLock) { player.wakeLock.release().catch(() => {}); player.wakeLock = null; }
  $('playBtn').textContent = $('sbPlay').textContent = '▶';
  $('playBtn').setAttribute('aria-label', 'さいせい');
}

function schedule() {
  const horizon = ctx.currentTime + 0.2;
  for (let guard = 0; guard < 8; guard++) {
    const seg = player.segs[player.segs.length - 1];
    const upto = Math.min(seg.q + (horizon - seg.t) * player.bps, player.rangeEnd);
    while (player.idx < player.events.length && player.events[player.idx].q < upto - EPS) {
      const e = player.events[player.idx++];
      if (e.q >= player.schedQ - EPS) fire(e, seg.t + (e.q - seg.q) / player.bps);
    }
    player.schedQ = upto;
    if (upto < player.rangeEnd - EPS) break;
    const endT = seg.t + (player.rangeEnd - seg.q) / player.bps;
    if (state.loopOn) {
      player.segs.push({ t: endT, q: player.rangeStart });
      if (player.segs.length > 4) player.segs.shift();
      player.schedQ = player.rangeStart;
      player.idx = firstIdx(player.rangeStart);
    } else {
      if (ctx.currentTime > endT + 0.3) {
        stopPlayback();
        state.pos = state.startQ;
        updateView(state.pos);
      }
      break;
    }
  }
}

function fire(e, t) {
  if (e.type === 'click') { playClick(t, e.accent, player.bus); return; }
  const n = e.n;
  if (n.perc) {
    playDrum(n.rim ? 'rim' : n.kind, t, e.vol * (n.accent ? 1.7 : 1), player.bus, n.freq);
    return;
  }
  const v = makeVoice(n.kind, n.midi, t, e.vol, player.bus);
  v.stop(t + Math.max(0.05, (n.dur / player.bps) * 0.92));
}

function currentQ() {
  if (!player.playing) return state.pos;
  const now = ctx.currentTime;
  let seg = player.segs[0];
  for (const s of player.segs) if (s.t <= now) seg = s;
  const q = seg.q + Math.max(0, now - seg.t) * player.bps;
  return Math.min(q, player.rangeEnd - EPS);
}

function frame() {
  if (!player.playing) return;
  updateView(currentQ());
  player.raf = requestAnimationFrame(frame);
}

function updateView(q) {
  if (!state.song) return;
  cursor.moveTo(q);
  updateKeys(q);
  updatePads(q);
  const ms = state.song.measures;
  let mi = 0;
  while (mi + 1 < ms.length && ms[mi + 1].start <= q + EPS) mi++;
  let sec = '';
  for (const mk of state.song.marks) if (mk.mi <= mi && mk.label.length === 1) sec = mk.label; // 今いる練習記号
  $('measureLabel').textContent = `${sec ? sec + '・' : ''}${ms[mi].num} / ${ms[ms.length - 1].num} 小節`;
  $('sbMeasure').textContent = `${sec ? sec + '・' : ''}${ms[mi].num}`;
}

// =====================================================================
// ボタン・せってい
// =====================================================================
$('playBtn').addEventListener('click', () => {
  if (player.playing) stopPlayback();
  else startPlayback(state.pos);
});

// ⏮ でもどる場所: くり返し中はその先頭、それ以外は「演奏を始める場所」
const startPos = () => (state.loopOn ? playRange()[0] : state.startQ);

function jumpTo(q) {
  const wasPlaying = player.playing;
  stopPlayback();
  state.pos = q;
  updateView(q);
  if (wasPlaying) startPlayback(q);
}

$('rewindBtn').addEventListener('click', () => jumpTo(startPos()));

$('startSelect').addEventListener('change', (e) => {
  state.startQ = Number(e.target.value);
  state.loopOn = false; // 始める場所を選んだら、くり返しは解除
  updateLoopButton();
  jumpTo(state.startQ);
});

// 再生中に設定を変えたら、今の位置から鳴らしなおす
function restartIfPlaying() {
  if (!player.playing) return;
  const q = currentQ();
  stopPlayback();
  startPlayback(q);
}

// はやさ（BPM）
const BPM_MIN = 30, BPM_MAX = 240;
let bpmTimer = 0;
function setBpm(v) {
  state.bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(Number(v) || state.bpm)));
  $('bpm').value = state.bpm;
  $('sbBpm').textContent = '♩' + state.bpm;
  $('bpmOrig').textContent = state.song && state.bpm !== state.song.tempo ? `（楽譜 ${state.song.tempo}）` : '';
}
function changeBpm(v) {
  setBpm(v);
  clearTimeout(bpmTimer);
  bpmTimer = setTimeout(restartIfPlaying, 400); // ボタン連打のあいだは鳴らしなおさない
}
$('bpmDown').addEventListener('click', () => changeBpm(state.bpm - 5));
$('bpmUp').addEventListener('click', () => changeBpm(state.bpm + 5));
$('bpm').addEventListener('change', (e) => changeBpm(e.target.value));
$('bpmOrig').addEventListener('click', () => changeBpm(state.song.tempo));

function updateLoopButton() {
  const b = $('loopBtn');
  b.setAttribute('aria-pressed', String(state.loopOn));
  $('sbLoop').setAttribute('aria-pressed', String(state.loopOn));
  if (state.loopOn && state.song) {
    const ms = state.song.measures;
    const a = Math.min(state.loopFrom, state.loopTo), z = Math.max(state.loopFrom, state.loopTo);
    b.textContent = `🔁 ${ms[a].num}〜${ms[z].num}小節`;
  } else {
    b.textContent = '🔁 くり返し';
  }
}

// 左の縦ならびのボタンは、ふだんのボタンと同じ働き
for (const [sb, orig] of [['sbBack', 'backBtn'], ['sbRewind', 'rewindBtn'], ['sbPlay', 'playBtn'],
  ['sbBpmUp', 'bpmUp'], ['sbBpmDown', 'bpmDown'], ['sbLoop', 'loopBtn'], ['sbSettings', 'settingsBtn']]) {
  $(sb).addEventListener('click', () => $(orig).click());
}

$('loopBtn').addEventListener('click', () => {
  state.loopOn = !state.loopOn;
  updateLoopButton();
  restartIfPlaying();
});
for (const id of ['loopFrom', 'loopTo']) {
  $(id).addEventListener('change', () => {
    state.loopFrom = Number($('loopFrom').value);
    state.loopTo = Number($('loopTo').value);
    state.loopOn = true;
    updateLoopButton();
    if (player.playing) {
      stopPlayback();
      startPlayback(playRange()[0]);
    } else {
      state.pos = playRange()[0];
      updateView(state.pos);
    }
  });
}

function updateModeLabel() {
  const p = state.song && state.song.parts[state.partIdx];
  $('modeOwnLabel').textContent = `お手本（${p ? p.name : '自分のパート'}だけ）`;
}

$('settingsBtn').addEventListener('click', () => {
  document.querySelector(`input[name="mode"][value="${prefs.mode}"]`).checked = true;
  $('metronome').checked = prefs.metronome;
  $('doremi').checked = prefs.doremi;
  $('settings').hidden = false;
});
$('settingsClose').addEventListener('click', () => { $('settings').hidden = true; });
$('settings').addEventListener('click', (e) => { if (e.target.id === 'settings') $('settings').hidden = true; });

for (const r of document.querySelectorAll('input[name="mode"]')) {
  r.addEventListener('change', () => { prefs.mode = r.value; savePrefs(); restartIfPlaying(); });
}
$('metronome').addEventListener('change', (e) => { prefs.metronome = e.target.checked; savePrefs(); restartIfPlaying(); });
$('doremi').addEventListener('change', (e) => { prefs.doremi = e.target.checked; savePrefs(); setDoremi(prefs.doremi); });

function rerenderScore() {
  if (!osmd || !osmd.sheet || $('practice').hidden) return;
  const q = currentQ();
  osmd.zoom = scoreZoom();
  osmd.render();
  cursor.reset();
  sizePads();
  updateView(q);
}

function changeZoom(d) {
  prefs.zoom = Math.min(1.6, Math.max(0.4, Math.round((prefs.zoom + d) * 10) / 10));
  savePrefs();
  rerenderScore();
}

let resizeTimer = 0;
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  sizePads();
  if (window.innerWidth === lastWidth) return; // 高さだけの変化（アドレスバーの出入り）は楽譜を描きなおさない
  lastWidth = window.innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(rerenderScore, 250);
});
$('zoomIn').addEventListener('click', () => changeZoom(0.1));
$('zoomOut').addEventListener('click', () => changeZoom(-0.1));

// 画面を閉じた・切りかえたときは止める
document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlayback(); });

// =====================================================================
// はじまり
// =====================================================================
(async () => {
  if (!window.crypto || !crypto.subtle) { fatal('このブラウザ（または http のページ）では使えません。https のページで開いてください。'); return; }
  const saved = lsGet(KEY_UNLOCK);
  if (saved) {
    try {
      const key = await crypto.subtle.importKey('raw', fromB64(saved), { name: 'AES-GCM' }, true, ['decrypt']);
      await loadCatalog(key);
      openSongs();
      return;
    } catch (e) {
      // 合言葉が変わった・通信できない など → 合言葉を入れなおしてもらう
    }
  }
  show('login');
})();
