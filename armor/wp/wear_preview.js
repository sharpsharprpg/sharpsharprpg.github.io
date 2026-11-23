// 착용 미리보기 (2026-11-13) — 방어구·냉병기·마법 위키 공용
// 데이터: wp/*.json.gz (게임 안 /weardump 로 메모리에서 뽑은 값). 계산식은 Epic Fight 20.14.17 디컴파일을 한 줄씩 옮김:
//  - 관절 행렬  W_j = W_parent · Local_j · (T·R(q)·S)        (Armature.getPoseTransform / JointTransform.getAnimationBoundMatrix)
//  - 스킨 행렬  S_j = W_j · toOrigin_j (· 부위 vanillaPartTransform)   (SkinnedMesh.drawPosed)
//  - 정점      Σ w · S_j · p                                    (SkinnedMesh.getVertexPosition)
//  - R(q)      OpenMatrix4f.fromQuaternion 그대로(three.js 와 w 부호가 반대인 식)
//  - 손 물건    W(Tool_R) · 보정행렬(RenderItemBase) · 게임이 그린 정점
//  - 레이어    기본 레이어 위에 합성 레이어를 우선순위 순으로 덮고, 관절 마스크·KEEP_CHILD_LOCROT 적용 (ClientAnimator.getPose)
//  - 공격(ActionAnimation)  Root 의 수평 이동은 몸이 아니라 플레이어 위치로 (ActionAnimation.correctRootJoint, RAW_COORD)
//  - 채광모드  바닐라 HumanoidModel.setupAnim 식 (enable_player_vanilla_model = true 이므로 바닐라 모델로 그려짐)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const PRI = ['LOWEST', 'LOW', 'MIDDLE', 'HIGH', 'HIGHEST'];
const SLOTS = [['HEAD', '머리'], ['CHEST', '가슴'], ['LEGS', '다리'], ['FEET', '발']];
const STYLE_KO = { ONE_HAND: '한손', TWO_HAND: '양손(쌍수)', MOUNT: '탑승', COMMON: '공통', SHEATH: '납도', OCHS: '옥스 자세' };
// 양손/한손 (11-14 사용자 지시): 왼손이 빈 상태의 EF 잡는 방식(styleNow)의 Style.canUseOffhand (디컴파일)
//  COMMON·ONE_HAND = 한손, TWO_HAND·YAMATO(cdmoveset)·FALCHION·BOARD_BLADE(efn) = 양손. EF 무기 능력이 없는 물건은 EF 가 COMMON 으로 다룸 = 한손
const TWO_HAND_STYLES = new Set(['TWO_HAND', 'YAMATO', 'FALCHION', 'BOARD_BLADE']);
const handsTag = (w) => TWO_HAND_STYLES.has(w && w.sn) ? ' (양손)' : ' (한손)';
const HAND_TABS = [['melee', '냉병기'], ['staff', '지팡이']];   // 주문서는 무기가 아니라 뺌 (11-14 사용자)     // 11-14 사용자 지시
const OFF_TABS = [['shield', '방패'], ['melee', '냉병기'], ['staff', '지팡이']];
const PLUSH_SUPER = [['ba', '블루 아카이브'], ['hololive', '홀로라이브'], ['idolm', '학원마스']];   // 인형 고르기 분류 (core.plush[id].sup)
const ARMOR_TABS = [['war', '전사'], ['mage', '마법사'], ['mech', '기계'], ['cloth', '의복']];
const MOTION_KO = { IDLE: '대기', WALK: '걷기', RUN: '달리기', SNEAK: '웅크리기', BLOCK: '막기', KNEEL: '무릎 꿇기', SWIM: '수영', FLOAT: '물에 뜨기', FALL: '떨어지기', CHASE: '추격', JUMP: '점프', AIM: '조준', SHOT: '발사', DIGGING: '채굴', CREATIVE_IDLE: '크리에이티브 대기', CREATIVE_FLY: '크리에이티브 비행', LANDING_RECOVERY: '착지 경직', MOUNT: '탑승', SIT: '앉기', SLEEP: '잠자기', CLIMB: '오르기', DEATH: '죽음', EAT: '먹기', DRINK: '마시기', SPELLCAST: '주문 시전', BLOCK_SHIELD: '방패 막기', FLY: '비행' };

// ---------------------------------------------------------------- 데이터 읽기
async function loadGz(url) {
  const r = await fetch(url, { cache: 'no-cache' });   // 다시 게시해도 예전 데이터를 쓰지 않게 매번 확인
  if (!r.ok) throw new Error(url + ' ' + r.status);
  let buf = new Uint8Array(await r.arrayBuffer());
  if (buf[0] === 0x48 && buf[1] === 0x34 && buf[2] === 0x73 && buf[3] === 0x49) {   // "H4sI" = gzip 을 base64 로 쓴 것
    const bin = atob(new TextDecoder().decode(buf).trim()); buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  }
  let txt;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    txt = await new Response(ds).text();
  } else txt = new TextDecoder().decode(buf);   // 서버가 이미 풀어서 준 경우
  return JSON.parse(txt);
}

// ---------------------------------------------------------------- EF 행렬 (열 우선 16칸 = OpenMatrix4f m00..m33 순서 = three.js elements 순서)
const I4 = () => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function mul(a, b, o = new Float64Array(16)) {
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
function quatEF(x, y, z, w) { // OpenMatrix4f.fromQuaternion
  const m = I4(), xy = x * y, xz = x * z, xw = x * w, yz = y * z, yw = y * w, zw = z * w, xs = 2 * x * x, ys = 2 * y * y, zs = 2 * z * z;
  m[0] = 1 - ys - zs; m[1] = 2 * (xy - zw); m[2] = 2 * (xz + yw);
  m[4] = 2 * (xy + zw); m[5] = 1 - xs - zs; m[6] = 2 * (yz - xw);
  m[8] = 2 * (xz - yw); m[9] = 2 * (yz + xw); m[10] = 1 - xs - ys;
  return m;
}
function trsEF(t, q, s) { // I.translate(t).mulBack(R).scale(s)
  const R = quatEF(q[0], q[1], q[2], q[3]);
  const m = new Float64Array(16);
  for (let i = 0; i < 3; i++) for (let r = 0; r < 4; r++) m[i * 4 + r] = R[i * 4 + r] * s[i];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
}
function inv(m) { const M = new THREE.Matrix4().fromArray(m).invert(); return Float64Array.from(M.elements); }
function noTrans(m) { const o = Float64Array.from(m); o[12] = o[13] = o[14] = 0; return o; }

// ---------------------------------------------------------------- 키프레임 (TransformSheet.getInterpolationInfo + MathUtils.lerpQuaternion)
function sampleSheet(sh, time) {
  const T = sh.t, n = T.length;
  if (!n) return null;
  if (time < 0) time = T[n - 1] + time;
  let b = 0, e = n - 1;
  while (e - b > 1) {
    const i = b + ((e - b) >> 1);
    if (T[i] <= time && T[i + 1] > time) { b = i; e = i + 1; break; }
    if (T[i] > time) { e = i; continue; }
    if (T[i + 1] <= time) b = i;
  }
  const den = T[e] - T[b];
  let d = den === 0 ? 1 : Math.min(1, Math.max(0, (time - T[b]) / den));
  if (Number.isNaN(d)) d = 1;
  const P = sh.p, Q = sh.q, S = sh.s;
  const t = [P[b * 3] * (1 - d) + P[e * 3] * d, P[b * 3 + 1] * (1 - d) + P[e * 3 + 1] * d, P[b * 3 + 2] * (1 - d) + P[e * 3 + 2] * d];
  let qa = [Q[b * 4], Q[b * 4 + 1], Q[b * 4 + 2], Q[b * 4 + 3]], qb = [Q[e * 4], Q[e * 4 + 1], Q[e * 4 + 2], Q[e * 4 + 3]];
  const dot = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3];
  if (dot < 0) qb = qb.map(v => -v);
  let q = qa.map((v, i) => (1 - d) * v + d * qb[i]);
  const ql = Math.hypot(...q) || 1; q = q.map(v => v / ql);
  const s = S ? [S[b * 3] * (1 - d) + S[e * 3] * d, S[b * 3 + 1] * (1 - d) + S[e * 3 + 1] * d, S[b * 3 + 2] * (1 - d) + S[e * 3 + 2] * d] : [1, 1, 1];
  return { t, q, s };
}
function lerpPose(pa, pb, d) {
  d = Math.min(1, Math.max(0, d));
  const out = {};
  const keys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
  const I = { t: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] };
  for (const k of keys) {
    const a = pa[k] || I, b = pb[k] || I;
    let qb = b.q; const dot = a.q[0] * qb[0] + a.q[1] * qb[1] + a.q[2] * qb[2] + a.q[3] * qb[3];
    if (dot < 0) qb = qb.map(v => -v);
    let q = a.q.map((v, i) => (1 - d) * v + d * qb[i]); const ql = Math.hypot(...q) || 1; q = q.map(v => v / ql);
    out[k] = { t: a.t.map((v, i) => (1 - d) * v + d * b.t[i]), q, s: (a.s || I.s).map((v, i) => (1 - d) * v + d * (b.s || I.s)[i]) };
  }
  return out;
}
function clipPose(clip, time) {
  const pose = {};
  for (const jn in clip.j) { const v = sampleSheet(clip.j[jn], time); if (v) pose[jn] = v; }
  return pose;
}
const jtMat = (jt) => jt ? trsEF(jt.t, jt.q, jt.s) : I4();

// ---------------------------------------------------------------- 뼈대
// 스킨 그림 -> 64x64 캔버스 (마인크래프트 HttpTexture.processLegacySkin 그대로, 디컴파일 11-14)
//  64x32(옛 형식)면 64x64 로 늘리고 아래 절반을 비운 뒤 다리·팔 칸을 좌우 반전 복사(왼쪽 팔다리), 모자 겹이 전부 불투명이면 투명으로
//  기본 겹(머리 0,0-32,16 · 몸 0,16-64,32 · 왼쪽 팔다리 16,48-48,64)은 알파를 255 로
function processSkin(img) {
  if (img.width !== 64 || (img.height !== 32 && img.height !== 64)) return null;
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, 64, 64), A = d.data;
  const get = (x, y) => { const i = (y * 64 + x) * 4; return [A[i], A[i + 1], A[i + 2], A[i + 3]]; };
  const set = (x, y, p) => { const i = (y * 64 + x) * 4; A[i] = p[0]; A[i + 1] = p[1]; A[i + 2] = p[2]; A[i + 3] = p[3]; };
  const legacy = img.height === 32;
  if (legacy) {
    for (let y = 32; y < 64; y++) for (let x = 0; x < 64; x++) set(x, y, [0, 0, 0, 0]);
    const copyRect = (x, y, dx, dy, w, h, mx, my) => {
      const buf = [];
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) buf.push([i, j, get(x + i, y + j)]);
      for (const [i, j, p] of buf) set(x + dx + (mx ? w - 1 - i : i), y + dy + (my ? h - 1 - j : j), p);
    };
    copyRect(4, 16, 16, 32, 4, 4, true, false); copyRect(8, 16, 16, 32, 4, 4, true, false);
    copyRect(0, 20, 24, 32, 4, 12, true, false); copyRect(4, 20, 16, 32, 4, 12, true, false);
    copyRect(8, 20, 8, 32, 4, 12, true, false); copyRect(12, 20, 16, 32, 4, 12, true, false);
    copyRect(44, 16, -8, 32, 4, 4, true, false); copyRect(48, 16, -8, 32, 4, 4, true, false);
    copyRect(40, 20, 0, 32, 4, 12, true, false); copyRect(44, 20, -8, 32, 4, 12, true, false);
    copyRect(48, 20, -16, 32, 4, 12, true, false); copyRect(52, 20, -8, 32, 4, 12, true, false);
  }
  const noAlpha = (x0, y0, x1, y1) => { for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) A[(y * 64 + x) * 4 + 3] = 255; };
  const notch = (x0, y0, x1, y1) => {
    for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) if (A[(y * 64 + x) * 4 + 3] < 128) return;
    for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) A[(y * 64 + x) * 4 + 3] = 0;
  };
  // 팔 모양 추정은 불투명 처리 전에 (뒤에서 몸 칸 알파를 255 로 바꾸므로)
  let slimGuess = !legacy; if (!legacy) { for (let y = 20; y < 32 && slimGuess; y++) for (let x = 54; x < 56; x++) if (A[(y * 64 + x) * 4 + 3] !== 0) { slimGuess = false; break; } }
  c._slimGuess = slimGuess;
  noAlpha(0, 0, 32, 16);
  if (legacy) notch(32, 0, 64, 32);
  noAlpha(0, 16, 64, 32);
  noAlpha(16, 48, 48, 64);
  g.putImageData(d, 0, 0);
  return c;
}
// 팔 모양 추정: 게임은 그림이 아니라 계정 설정으로 정하므로 추정일 뿐 (사용자가 바꿀 수 있음).
// 슬림 스킨은 오른팔 바깥 열(54..55, 20..31)이 비어 있음
function guessSlim(c) { return !!c._slimGuess; }

class Rig {
  constructor(core) {
    this.joints = core.joints.map((j, i) => ({ ...j, i, L: Float64Array.from(j.L), O: Float64Array.from(j.O), kids: [] }));
    this.byName = {};
    this.joints.forEach(j => { this.byName[j.n] = j; if (j.p >= 0) this.joints[j.p].kids.push(j); });
    this.root = this.joints.find(j => j.p < 0);
  }
  // pose: {joint: {t,q,s, pre?, post?}} -> W[j] (원점 행렬 없이), S[j] (원점 행렬 곱함)
  solve(pose) {
    const W = new Array(this.joints.length), S = new Array(this.joints.length);
    const rec = (j, parent) => {
      const jt = pose[j.n];
      let P = parent, L = j.L;
      if (jt && jt.pre) P = mul(jt.pre, parent);     // KEEP_CHILD_LOCROT 의 parent 항목
      if (jt && jt.post) L = mul(jt.post, j.L);      // KEEP_CHILD_LOCROT 의 joint_local 항목
      const R = mul(mul(P, L), jtMat(jt));
      W[j.i] = R;
      for (const k of j.kids) rec(k, R);
      S[j.i] = mul(R, j.O);
    };
    rec(this.root, I4());
    return { W, S };
  }
}

// ---------------------------------------------------------------- 스킨 메시 (CPU, EF 와 같은 식)
class SkinMesh {
  constructor(pk, texture, opts = {}) {
    this.pk = pk;
    const parts = Object.entries(pk.parts);
    let nv = 0; parts.forEach(([, p]) => nv += p.i.length / 3);
    this.vpos = new Int32Array(nv); this.vnrm = new Int32Array(nv); this.vpart = new Int16Array(nv);
    const uv = new Float32Array(nv * 2);
    this.partVT = [];
    // EF 가 구운 일부 갑옷 메시에 쉰 위치가 수만 블록 밖인 정점이 있음(예: alexscaves_torpedoes:tectonic_chestplate horn3 의 9개).
    // 그런 정점이 낀 삼각형은 그리지 않고 화면 맞춤에서도 뺌.
    const farPos = (pi) => Math.abs(pk.p[pi * 3]) > 10 || Math.abs(pk.p[pi * 3 + 1]) > 10 || Math.abs(pk.p[pi * 3 + 2]) > 10;
    this.dropped = 0;
    let k = 0;
    parts.forEach(([name, p], pi) => {
      this.partVT[pi] = p.vt ? Float64Array.from(p.vt) : null;
      for (let i = 0; i < p.i.length; i += 3) {
        const triStart = (i / 3) - ((i / 3) % 3);   // 이 정점이 속한 삼각형의 첫 정점
        let bad = false; for (let q = 0; q < 3; q++) { const ii = (triStart + q) * 3; if (ii < p.i.length && farPos(p.i[ii])) bad = true; }
        if (bad) this.dropped++;
        this.vpos[k] = p.i[i]; this.vnrm[k] = p.i[i + 2]; this.vpart[k] = bad ? -1 : pi;
        uv[k * 2] = pk.uv[p.i[i + 1] * 2]; uv[k * 2 + 1] = pk.uv[p.i[i + 1] * 2 + 1];
        k++;
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (pk.c) {   // 정점 색 (0-255) — 위치 인덱스와 같은 순서
      const col = new Float32Array(nv * 4);
      for (let v = 0; v < nv; v++) { const pi = this.vpos[v] * 4; col[v * 4] = pk.c[pi] / 255; col[v * 4 + 1] = pk.c[pi + 1] / 255; col[v * 4 + 2] = pk.c[pi + 2] / 255; col[v * 4 + 3] = pk.c[pi + 3] / 255; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    }
    this.geo = g;
    // opts.emissive: EF RenderType.entityTranslucentEmissive (빛 무시, 알파 opts.opacity) — 3D 무기의 *_l / *_light 텍스처 덧그림
    const mat = opts.eyes
      ? new THREE.MeshBasicMaterial({ map: texture || null, vertexColors: !!pk.c, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
      : opts.emissive
      ? new THREE.MeshBasicMaterial({ map: texture || null, transparent: true, opacity: opts.opacity != null ? opts.opacity : 1, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
      : new THREE.MeshLambertMaterial({ map: texture || null, alphaTest: 0.1, side: THREE.DoubleSide, transparent: !!opts.transparent, depthWrite: !opts.transparent, polygonOffset: !!opts.offset, polygonOffsetFactor: opts.offset ? -1 : 0, polygonOffsetUnits: opts.offset ? -1 : 0 });
    if (opts.color != null) mat.color.setHex(opts.color);
    if (pk.c && !opts.eyes && !opts.emissive) mat.vertexColors = true;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
  }
  // 원점·부위 행렬까지 곱한 위치 배열을 돌려줌(맞춤 상자 계산에도 씀)
  skin(S, outPos, outNrm) {
    const pk = this.pk, P = pk.p, N = pk.n, skin = pk.s;
    const nv = this.vpos.length;
    const cache = new Map();
    for (let v = 0; v < nv; v++) {
      const pi = this.vpart[v];
      if (pi < 0) { outPos[v * 3] = outPos[v * 3 + 1] = outPos[v * 3 + 2] = 0; if (outNrm) { outNrm[v * 3] = 0; outNrm[v * 3 + 1] = 1; outNrm[v * 3 + 2] = 0; } continue; }
      const vt = this.partVT[pi];
      const pidx = this.vpos[v], key = pi * 1e6 + pidx;
      let pp = cache.get(key);
      if (!pp) {
        let x = 0, y = 0, z = 0;
        const px = P[pidx * 3], py = P[pidx * 3 + 1], pz = P[pidx * 3 + 2];
        let qx = px, qy = py, qz = pz;
        if (vt) { qx = vt[0] * px + vt[4] * py + vt[8] * pz + vt[12]; qy = vt[1] * px + vt[5] * py + vt[9] * pz + vt[13]; qz = vt[2] * px + vt[6] * py + vt[10] * pz + vt[14]; }
        for (const [j, w] of skin[pidx]) {
          const m = S[j];
          x += w * (m[0] * qx + m[4] * qy + m[8] * qz + m[12]);
          y += w * (m[1] * qx + m[5] * qy + m[9] * qz + m[13]);
          z += w * (m[2] * qx + m[6] * qy + m[10] * qz + m[14]);
        }
        pp = [x, y, z]; cache.set(key, pp);
      }
      outPos[v * 3] = pp[0]; outPos[v * 3 + 1] = pp[1]; outPos[v * 3 + 2] = pp[2];
      if (outNrm) {
        const nidx = this.vnrm[v];
        let nx = N[nidx * 3], ny = N[nidx * 3 + 1], nz = N[nidx * 3 + 2];
        if (vt) { const a = vt[0] * nx + vt[4] * ny + vt[8] * nz, b = vt[1] * nx + vt[5] * ny + vt[9] * nz, c = vt[2] * nx + vt[6] * ny + vt[10] * nz; nx = a; ny = b; nz = c; }
        let x = 0, y = 0, z = 0;
        for (const [j, w] of skin[pidx]) {
          const m = S[j];
          x += w * (m[0] * nx + m[4] * ny + m[8] * nz); y += w * (m[1] * nx + m[5] * ny + m[9] * nz); z += w * (m[2] * nx + m[6] * ny + m[10] * nz);
        }
        const l = Math.hypot(x, y, z) || 1;
        outNrm[v * 3] = x / l; outNrm[v * 3 + 1] = y / l; outNrm[v * 3 + 2] = z / l;
      }
    }
  }
  update(S) {
    this.skin(S, this.geo.attributes.position.array, this.geo.attributes.normal.array);
    this.geo.attributes.position.needsUpdate = true; this.geo.attributes.normal.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- 손에 든 물건 (게임이 그린 정점 그대로)
function heldObject(parts, texOf) {
  const grp = new THREE.Group();
  const pts = [];
  for (const p of parts) {
    const v = p.v, per = p.per || 4, n = v.length / 12;
    const pos = [], uv = [], col = [], nrm = [];
    const push = (i) => { pos.push(v[i * 12], v[i * 12 + 1], v[i * 12 + 2]); uv.push(v[i * 12 + 3], v[i * 12 + 4]); col.push(v[i * 12 + 5] / 255, v[i * 12 + 6] / 255, v[i * 12 + 7] / 255, v[i * 12 + 8] / 255); nrm.push(v[i * 12 + 9], v[i * 12 + 10], v[i * 12 + 11]); };
    for (let i = 0; i + per <= n; i += per) {
      if (per === 4) { [0, 1, 2, 0, 2, 3].forEach(k => push(i + k)); }
      else if (per === 3) { [0, 1, 2].forEach(k => push(i + k)); }
    }
    for (let i = 0; i < n; i++) pts.push([v[i * 12], v[i * 12 + 1], v[i * 12 + 2]]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    const rt = p.rt || '';
    const emissive = /eyes|ghost|tesseract|portal|unlit|eye_alpha/.test(rt);
    const translucent = /translucent|ghost|eyes/.test(rt);
    const mat = emissive
      ? new THREE.MeshBasicMaterial({ map: texOf(p.png), vertexColors: true, transparent: true, depthWrite: false, blending: /eyes|eye_alpha/.test(rt) ? THREE.AdditiveBlending : THREE.NormalBlending, side: THREE.DoubleSide })
      : new THREE.MeshLambertMaterial({ map: texOf(p.png), vertexColors: true, alphaTest: 0.1, transparent: translucent, side: THREE.DoubleSide });
    const m = new THREE.Mesh(g, mat); m.frustumCulled = false;
    m.matrixAutoUpdate = false; m.userData.joint = p.j != null ? p.j : -1;     // EF 전용 렌더러로 기록한 부분은 관절 번호를 가짐
    m.userData.pts = []; for (let i = 0; i < n; i++) m.userData.pts.push([v[i * 12], v[i * 12 + 1], v[i * 12 + 2]]);
    grp.add(m);
  }
  grp.matrixAutoUpdate = false;
  grp.userData.pts = pts;
  return grp;
}

// ---------------------------------------------------------------- 바닐라 모델(채광모드) — HumanoidModel.setupAnim / setupAttackAnimation / bobArms
const VPART = { // EF 관절 -> 바닐라 부위
  Root: 'body', Torso: 'body', Chest: 'body', Head: 'head',
  Shoulder_R: 'rightArm', Arm_R: 'rightArm', Hand_R: 'rightArm', Tool_R: 'rightArm', Elbow_R: 'rightArm',
  Shoulder_L: 'leftArm', Arm_L: 'leftArm', Hand_L: 'leftArm', Tool_L: 'leftArm', Elbow_L: 'leftArm',
  Thigh_R: 'rightLeg', Leg_R: 'rightLeg', Knee_R: 'rightLeg', Thigh_L: 'leftLeg', Leg_L: 'leftLeg', Knee_L: 'leftLeg' };
const VREST = { head: [0, 0, 0], body: [0, 0, 0], rightArm: [-5, 2, 0], leftArm: [5, 2, 0], rightLeg: [-1.9, 12, 0], leftLeg: [1.9, 12, 0] };
// 바닐라 모델 좌표(블록 단위) -> EF 메시 좌표: (-x, 1.501 - y, z)  (LivingEntityRenderer: scale(-1,-1,1), translate(0,-1.501,0); EF 몸 메시 상자와 대조해 확인)
const F = (() => { const m = I4(); m[0] = -1; m[5] = -1; m[13] = 1.501; return m; })();
const Finv = inv(F);
function partMat(p) { // ModelPart.translateAndRotate: T(x/16,y/16,z/16) · Rz·Ry·Rx
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(p.xRot, p.yRot, p.zRot, 'ZYX'));
  m.setPosition(p.x / 16, p.y / 16, p.z / 16);
  return Float64Array.from(m.elements);
}
function vanillaParts(st) {
  // st: {age(틱), limb, limbAmt, attack(0..1, 0=안 휘두름), rightItem, leftItem, crouch}
  const P = {}; for (const k in VREST) P[k] = { x: VREST[k][0], y: VREST[k][1], z: VREST[k][2], xRot: 0, yRot: 0, zRot: 0 };
  const cos = Math.cos, sin = Math.sin, PI = Math.PI;
  const ls = st.limb, la = st.limbAmt;
  P.rightArm.xRot = cos(ls * 0.6662 + PI) * 2 * la * 0.5;
  P.leftArm.xRot = cos(ls * 0.6662) * 2 * la * 0.5;
  P.rightLeg.xRot = cos(ls * 0.6662) * 1.4 * la; P.leftLeg.xRot = cos(ls * 0.6662 + PI) * 1.4 * la;
  P.rightLeg.yRot = 0.005; P.leftLeg.yRot = -0.005; P.rightLeg.zRot = 0.005; P.leftLeg.zRot = -0.005;
  // poseRightArm / poseLeftArm : 물건을 들면 ITEM (xRot*0.5 - π/10), 빈손 EMPTY (yRot 0)
  if (st.rightItem) { P.rightArm.xRot = P.rightArm.xRot * 0.5 - 0.31415927; P.rightArm.yRot = 0; }
  if (st.leftItem) { P.leftArm.xRot = P.leftArm.xRot * 0.5 - 0.31415927; P.leftArm.yRot = 0; }
  // setupAttackAnimation (오른손잡이)
  const at = st.attack;
  if (at > 0) {
    P.body.yRot = sin(Math.sqrt(at) * PI * 2) * 0.2;
    P.rightArm.z = sin(P.body.yRot) * 5; P.rightArm.x = -cos(P.body.yRot) * 5;
    P.leftArm.z = -sin(P.body.yRot) * 5; P.leftArm.x = cos(P.body.yRot) * 5;
    P.rightArm.yRot += P.body.yRot; P.leftArm.yRot += P.body.yRot; P.leftArm.xRot += P.body.yRot;
    let f = 1 - at; f *= f; f *= f; f = 1 - f;
    const g = sin(f * PI), h = sin(at * PI) * -(P.head.xRot - 0.7) * 0.75;
    P.rightArm.xRot -= g * 1.2 + h; P.rightArm.yRot += P.body.yRot * 2; P.rightArm.zRot += sin(at * PI) * -0.4;
  }
  if (st.crouch) {
    P.body.xRot = 0.5; P.rightArm.xRot += 0.4; P.leftArm.xRot += 0.4; P.rightLeg.z = 4; P.leftLeg.z = 4; P.rightLeg.y = 12.2; P.leftLeg.y = 12.2;
    P.head.y = 4.2; P.body.y = 3.2; P.leftArm.y = 5.2; P.rightArm.y = 5.2;
  }
  // bobArms
  P.rightArm.zRot += 1 * (cos(st.age * 0.09) * 0.05 + 0.05); P.rightArm.xRot += 1 * (sin(st.age * 0.067) * 0.05);
  P.leftArm.zRot += -1 * (cos(st.age * 0.09) * 0.05 + 0.05); P.leftArm.xRot += -1 * (sin(st.age * 0.067) * 0.05);
  return P;
}
function vanillaSkin(rig, st) {
  const P = vanillaParts(st), S = [], W = [], partM = {};
  for (const k in P) {
    const r = VREST[k];
    const rest = I4(); rest[12] = r[0] / 16; rest[13] = r[1] / 16; rest[14] = r[2] / 16;
    partM[k] = partMat(P[k]);
    const M = mul(mul(F, mul(partM[k], inv(rest))), Finv);
    partM[k + '_ef'] = M;
  }
  rig.joints.forEach(j => { S[j.i] = partM[(VPART[j.n] || 'body') + '_ef']; });
  // 손: ItemInHandLayer — 팔 translateAndRotate · Rx(-90) · Ry(180) · T(±1/16, 0.125, -0.625)
  const hand = (arm, left) => {
    const a = new THREE.Matrix4().fromArray(partM[arm]);
    a.multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2)).multiply(new THREE.Matrix4().makeRotationY(Math.PI)).multiply(new THREE.Matrix4().makeTranslation((left ? -1 : 1) / 16, 0.125, -0.625));
    return mul(F, Float64Array.from(a.elements));
  };
  return { S, W, handR: hand('rightArm', false), handL: hand('leftArm', true) };
}

// ---------------------------------------------------------------- 레이어 합성 (ClientAnimator.getPose + applyBindModifier)
function maskJoints(meta, motion) {
  if (!meta || !meta.mask) return null;                // 마스크 없음 = 그 애니가 가진 관절 전부
  const m = (meta.mask.m && meta.mask.m[motion]) || meta.mask.d;
  return m || null;
}
function composePose(rig, base, layers, motion) {
  // layers: [{pose, meta}] 낮은 우선순위 -> 높은 순
  const out = {}; for (const k in base) out[k] = { ...base[k] };
  const enabled = layers.map(l => {
    const mk = maskJoints(l.meta, motion);
    const p = {};
    for (const k in l.pose) if (!mk || k in mk) p[k] = l.pose[k];   // Layer.getEnabledPose: 마스크 밖 관절은 끔
    return { ...l, en: p, mk };
  });
  enabled.forEach(l => { for (const k in l.en) out[k] = { ...l.en[k] }; });
  // applyBindModifier: 관절마다 높은 우선순위부터, 그 관절을 가진 레이어의 bind modifier 하나만
  const visit = (j) => {
    for (let i = enabled.length - 1; i >= 0; i--) {
      const l = enabled[i];
      if (!l.mk) continue;
      if (!(j.n in l.pose) || !(j.n in l.mk)) continue;
      const bm = l.mk[j.n];
      if (!bm) continue;
      if (bm === 'KEEP_CHILD_LOCROT') keepChildLocRot(rig, base, out, l, j);
      break;
    }
    j.kids.forEach(visit);
  };
  visit(rig.root);
  return out;
}
function keepChildLocRot(rig, base, result, layer, joint) {
  const lowest = base[joint.n] || { t: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] };
  const current = layer.pose[joint.n] || lowest;
  const r = result[joint.n] = result[joint.n] ? { ...result[joint.n], t: [...result[joint.n].t] } : { t: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] };
  r.t[1] = lowest.t[1];
  const lowM = jtMat(lowest), curM = jtMat(current);
  const c2l = mul(inv(curM), lowM);
  for (const sub of joint.kids) {
    if (layer.mk && sub.n in layer.mk) continue;          // 마스크 안(덮인) 관절은 건너뜀 (isMasked 일 때만 보정)
    const lowLocal = mul(joint.L, lowM), curLocal = mul(joint.L, curM);
    const child = mul(sub.L, jtMat(result[sub.n]));
    const lf = mul(lowLocal, child), cf = mul(curLocal, child);
    const vec = [(cf[12] - lf[12]) * 0.5, cf[13] - lf[13], cf[14] - lf[14]];
    const T = I4(); T[12] = vec[0]; T[13] = vec[1]; T[14] = vec[2];
    const jt = result[sub.n] = { ...(result[sub.n] || { t: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] }) };
    jt.pre = jt.pre ? mul(jt.pre, T) : T;                 // jointTransform.parent(translation(vec), mul)
    const c = Float64Array.from(c2l);                     // fromMatrixWithoutScale
    for (let i = 0; i < 3; i++) { const l = Math.hypot(c[i * 4], c[i * 4 + 1], c[i * 4 + 2]) || 1; c[i * 4] /= l; c[i * 4 + 1] /= l; c[i * 4 + 2] /= l; }
    jt.post = jt.post ? mul(jt.post, c) : c;              // jointLocal(..., mul)
  }
}
// ActionAnimation.correctRootJoint: Root 의 수평 이동을 몸에서 빼서 플레이어 위치로
function rootToCoord(rig, pose, moveVertical) {
  const jt = pose.Root; if (!jt) return [0, 0, 0];
  const R = noTrans(rig.byName.Root.L), Ri = inv(R);
  const p = jt.t;
  const w = [R[0] * p[0] + R[4] * p[1] + R[8] * p[2], R[1] * p[0] + R[5] * p[1] + R[9] * p[2], R[2] * p[0] + R[6] * p[1] + R[10] * p[2]];
  const moved = [w[0], 0, w[2]];
  const keep = [0, moveVertical && w[1] > 0 ? 0 : w[1], 0];
  const back = [Ri[0] * keep[0] + Ri[4] * keep[1] + Ri[8] * keep[2], Ri[1] * keep[0] + Ri[5] * keep[1] + Ri[9] * keep[2], Ri[2] * keep[0] + Ri[6] * keep[1] + Ri[10] * keep[2]];
  pose.Root = { ...jt, t: back };
  return moved;
}

// ---------------------------------------------------------------- 본체
export class WearPreview {
  constructor(root, opts = {}) {
    this.root = root; this.base = opts.base || 'wp/'; this.opts = opts;
    this.state = { mode: 'combat', slots: {}, plush: null, main: null, off: null, style: null, motion: 'idle', playing: true, t: 0 };
    this.cache = { clips: {}, armor: {}, held: {} };
    this.tex = new Map();
    this.ui();
  }
  // ---------------- UI
  ui() {
    const r = this.root;
    r.classList.add('wp');
    r.innerHTML = `
      <button class="wp-head" type="button" aria-expanded="false"><span class="wp-title">착용 미리보기</span><span class="wp-sum"></span><span class="wp-caret">▸</span></button>
      <div class="wp-body" hidden>
        <div class="wp-stage">
          <canvas class="wp-canvas"></canvas>
          <div class="wp-load">불러오는 중…</div>
          <div class="wp-tools">
            <button type="button" data-a="play" title="재생/멈춤">❚❚</button>
            <button type="button" data-a="reset" title="보기 초기화">보기 초기화</button>
            <button type="button" data-a="full" title="전체화면">전체화면</button>
          </div>
          <div class="wp-hint">끌기: 이동 · R 누른 채 끌기: 회전 · 휠: 확대 / 터치: 한 손가락 회전 · 두 손가락 이동·확대</div>
        </div>
        <div class="wp-ctrl">
          <div class="wp-row wp-modes"><button type="button" data-mode="combat" class="on">전투모드</button><button type="button" data-mode="mining">채광모드</button></div>
          <div class="wp-row wp-skin"><span class="wp-lbl">스킨</span><button type="button" data-a="skin">스킨 등록</button><button type="button" data-arm="wide">넓은 팔</button><button type="button" data-arm="slim">슬림 팔</button><button type="button" data-a="skin-reset">기본 스킨</button><input type="file" accept="image/png" hidden></div>
          <div class="wp-grid wp-slots"></div>
          <div class="wp-grid wp-hands"></div>
          <div class="wp-row wp-style"></div>
          <div class="wp-motions"></div>
          <div class="wp-note"></div>
        </div>
      </div>`;
    this.$ = (s) => r.querySelector(s);
    this.$('.wp-head').onclick = () => this.toggle();
    r.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { this.state.mode = b.dataset.mode; this.state.motion = 'idle'; this.refresh(); });
    this.$('[data-a="play"]').onclick = () => { this.state.playing = !this.state.playing; this.$('[data-a="play"]').textContent = this.state.playing ? '❚❚' : '▶'; };
    this.$('[data-a="reset"]').onclick = () => this.fit(true);
    this.$('[data-a="full"]').onclick = () => this.fullscreen();
    document.addEventListener('fullscreenchange', () => this.onFull());
    document.addEventListener('webkitfullscreenchange', () => this.onFull());
  }
  toggle(open) {
    const body = this.$('.wp-body'), head = this.$('.wp-head');
    const o = open != null ? open : body.hidden;
    body.hidden = !o; head.setAttribute('aria-expanded', o ? 'true' : 'false'); this.$('.wp-caret').textContent = o ? '▾' : '▸';
    try { localStorage.setItem('wp.open', o ? '1' : '0'); } catch (e) {}
    if (o) this.start();
  }
  async start() {
    if (this.ready) { this.resize(); return; }
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        this.core = await loadGz(this.base + 'core.gz.txt');
        this.rig = new Rig(this.core);
        this.three();
        this.ready = true;
        this.$('.wp-load').hidden = true;
        await this.refresh();
        this.loop();
      } catch (e) { this.$('.wp-load').textContent = '불러오지 못했습니다: ' + e.message; console.error(e); }
    })();
    return this.loading;
  }
  three() {
    const cv = this.$('.wp-canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const d1 = new THREE.DirectionalLight(0xffffff, 1.4); d1.position.set(-0.6, 1, -0.8); this.scene.add(d1);
    const d2 = new THREE.DirectionalLight(0xffffff, 0.6); d2.position.set(0.7, 0.4, 0.9); this.scene.add(d2);
    this.world = new THREE.Group(); this.scene.add(this.world);       // 플레이어 위치(공격 이동)
    this.model = new THREE.Group(); this.model.scale.setScalar(this.core.scale); this.world.add(this.model);
    this.controls = new OrbitControls(this.camera, cv);
    // 11-15 사용자 "r 누르면 회전, 스크롤로 확대 / 모바일: 한손 회전, 두 손 이동·확대": 작은 칸에서도 조작을 켬 (전에는 전체화면에서만)
    this.controls.enabled = true; this.controls.enableDamping = true;
    this.controls.addEventListener('start', () => { this.userMoved = true; if (!this.isFull) this.$('.wp-hint').hidden = true; });   // 직접 움직인 시점은 동작을 바꿔도 유지 (보기 초기화로 되돌림)
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.screenSpacePanning = true;
    const setRot = (on) => { this.controls.mouseButtons.LEFT = on ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN; };
    window.addEventListener('keydown', (e) => { if ((e.key === 'r' || e.key === 'R' || e.key === 'ㄱ') && !/INPUT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName || '')) setRot(true); });
    window.addEventListener('keyup', (e) => { if (e.key === 'r' || e.key === 'R' || e.key === 'ㄱ') setRot(false); });
    window.addEventListener('blur', () => setRot(false));
    this.body = new SkinMesh(this.core.body, this.texture('skin:steve', this.core.skins.steve));
    this.model.add(this.body.mesh);
    // 스킨 등록 (11-14 사용자 지시): 보는 사람 브라우저 안에서만 씀(어디에도 올리지 않음), 이 브라우저에 기억
    const fileIn = this.$('.wp-skin input[type=file]');
    this.$('[data-a="skin"]').onclick = () => fileIn.click();
    fileIn.onchange = () => { const f = fileIn.files && fileIn.files[0]; fileIn.value = ''; if (f) this.loadSkinFile(f); };
    this.$('[data-a="skin-reset"]').onclick = () => { this.skin = null; try { localStorage.removeItem('wp-skin'); } catch (e) {} this.applySkin(); };
    this.$('.wp-skin').querySelectorAll('[data-arm]').forEach(b => b.onclick = () => { if (!this.skin) return; this.skin.slim = b.dataset.arm === 'slim'; this.saveSkin(); this.applySkin(); });
    try { const sv = JSON.parse(localStorage.getItem('wp-skin') || 'null'); if (sv && sv.png) { const im = new Image(); im.onload = () => { const c = processSkin(im); if (c) { this.skin = { canvas: c, slim: !!sv.slim, png: sv.png }; this.applySkin(); } }; im.src = sv.png; } } catch (e) {}
    this.skinUI();
    this.armorMeshes = {}; this.heldObjs = { main: null, off: null };
    new ResizeObserver(() => this.resize()).observe(this.$('.wp-stage'));
    this.resize();
  }
  // ---------------- 스킨
  loadSkinFile(f) {
    const rd = new FileReader();
    rd.onload = () => {
      const im = new Image();
      im.onload = () => {
        const c = processSkin(im);
        if (!c) { this.skinMsg = `스킨은 가로 64, 세로 64 또는 32 픽셀이어야 합니다 (이 파일 ${im.width}×${im.height}).`; this.skinUI(); return; }
        this.skinMsg = '';
        this.skin = { canvas: c, slim: guessSlim(c), png: rd.result };
        this.saveSkin(); this.applySkin();
      };
      im.onerror = () => { this.skinMsg = '그림 파일을 읽지 못했습니다.'; this.skinUI(); };
      im.src = rd.result;
    };
    rd.readAsDataURL(f);
  }
  saveSkin() { try { if (this.skin) localStorage.setItem('wp-skin', JSON.stringify({ png: this.skin.png, slim: this.skin.slim })); } catch (e) {} }
  applySkin() {
    const slim = !!(this.skin && this.skin.slim && this.core.bodySlim);
    const pk = slim ? this.core.bodySlim : this.core.body;
    let tex;
    if (this.skin) { tex = new THREE.CanvasTexture(this.skin.canvas); tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true; }
    else tex = this.texture('skin:steve', this.core.skins.steve);
    if (this.body) { this.model.remove(this.body.mesh); this.body.geo.dispose(); if (this.body._own) this.body.mesh.material.map.dispose(); }
    this.body = new SkinMesh(pk, tex); this.body._own = !!this.skin;
    this.model.add(this.body.mesh);
    const fr = this.frame && this.cur ? this.frame(this.state.t) : null; if (fr) this.body.update(fr.S);
    this.skinUI();
  }
  skinUI() {
    const el = this.$('.wp-skin'); if (!el) return;
    const has = !!this.skin, slimOK = !!this.core.bodySlim;
    el.querySelectorAll('[data-arm]').forEach(b => {
      b.disabled = !has || (b.dataset.arm === 'slim' && !slimOK);
      b.classList.toggle('on', has && ((b.dataset.arm === 'slim') === !!(this.skin.slim && slimOK)));
      b.title = b.dataset.arm === 'slim' && !slimOK ? '슬림 팔 몸 메시가 아직 데이터에 없습니다' : '';
    });
    el.querySelector('[data-a="skin-reset"]').disabled = !has;
    this.skinNote = this.skinMsg || (has && this.skin.slim && !slimOK ? '슬림 팔 몸 메시가 아직 데이터에 없어 넓은 팔로 그립니다.' : '');
    if (this.uiNoteOnly) this.uiNoteOnly();
  }
  texture(key, b64) {
    if (!b64) return null;
    if (this.tex.has(key)) return this.tex.get(key);
    const img = new Image(); img.src = 'data:image/png;base64,' + b64;
    const t = new THREE.Texture(img);
    img.onload = () => { t.needsUpdate = true; };
    t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.flipY = false; t.colorSpace = THREE.SRGBColorSpace;
    this.tex.set(key, t);
    return t;
  }
  resize() {
    if (!this.renderer) return;
    const st = this.$('.wp-stage');
    const w = st.clientWidth, h = st.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    if (this.box) this.fit(!this.userMoved);
  }
  // ---------------- 고르기
  isHeadItem(id) { return !!(id && this.core.headItems && this.core.headItems[id]); }   // 머리 아이템 층(CustomHeadLayer)으로 그려지는 머리 칸 물건(드래곤 두개골 등) — 인형과 같은 state.plush 칸을 씀
  setSlot(slot, id) {
    if (slot === 'HEAD') { if (this.isHeadItem(id)) { this.state.plush = id; this.state.slots.HEAD = null; this.refresh(); return; } if (this.isHeadItem(this.state.plush)) this.state.plush = null; }
    this.state.slots[slot] = id || null; if (slot === 'HEAD' && id) this.state.plush = null; this.refresh();
  }   // 인형은 게임에서 머리 장비 칸을 쓰므로 투구와 동시에 못 낌
  setPlush(id) { this.state.plush = id || null; if (id) this.state.slots.HEAD = null; this.refresh(); }
  setHand(h, id) { this.state[h] = id || null; if (h === 'main' && id && !this.dualOK(id)) this.state.off = null; this.state.style = null; this.state.motion = 'idle'; this.refresh(); }
  equipSet(ids) {   // 처음 열기 전(core 없음)에도 되게: start() 를 기다린 뒤 입힘 (마법 위키 세션 지적, 11-13)
    this.toggle(true);
    (this.ready ? Promise.resolve() : this.start()).then(() => {
      // 세트 입히기 (11-14): 부위마다 세트 목록의 첫 번째(마법사 두건·모자처럼 한 부위에 여럿일 때), 세트에 없는 부위는 벗김
      const next = {}; (ids || []).forEach(id => { const a = this.core.armor[id] || (this.isHeadItem(id) ? { slot: 'HEAD' } : null); if (a && !next[a.slot]) next[a.slot] = id; });
      if (!Object.keys(next).length) return;
      for (const [sl] of SLOTS) this.state.slots[sl] = next[sl] || null;
      this.state.plush = null;
      if (this.isHeadItem(next.HEAD)) { this.state.plush = next.HEAD; this.state.slots.HEAD = null; }     // 인형도 머리 칸 물건 — '세트에 없는 부위는 벗김' 규칙대로 같이 벗김 (11-16 리뷰 지적)
      this.refresh();
    });
  }
  equip(id) {
    const go = () => {
      if ((this.core.plush && this.core.plush[id]) || this.isHeadItem(id)) { this.state.plush = id; this.state.slots.HEAD = null; }
      else if (this.core.armor[id]) { this.state.slots[this.core.armor[id].slot] = id; if (this.core.armor[id].slot === 'HEAD') this.state.plush = null; }
      else if (this.core.held[id] && (this.core.shieldList || []).includes(id)) { if (this.state.main && !this.dualOK(this.state.main)) this.state.main = null; this.state.off = id; this.state.motion = 'idle'; }   // 방패는 왼손
      else if (this.core.held[id]) { this.state.main = id; if (!this.dualOK(id)) this.state.off = null; this.state.style = null; this.state.motion = 'idle'; }
      this.refresh();
    };
    this.toggle(true);
    (this.ready ? Promise.resolve() : this.start()).then(go);
  }
  async loadChunk(kind, n) {
    const k = kind + n;
    if (!this.cache[k]) this.cache[k] = loadGz(`${this.base}${kind}_${n}.gz.txt`);
    return this.cache[k];
  }
  async getClip(id) {
    const m = this.core.anims[id]; if (!m) return null;
    const ch = await this.loadChunk('clips', m.c); return ch[id] || null;
  }
  async getArmor(id) {
    const a = this.core.armor[id]; if (!a) return null;
    const ch = await this.loadChunk('armor', a.c);
    const e = ch.items[id]; if (!e) return null;
    const mesh = e.mesh.startsWith('default:') ? this.core.defaults[e.mesh.slice(8)] : ch.mesh[e.mesh];
    const efc = e.efc ? (ch.mesh[e.efc] || []).map(L => ({ ...L, texB64: L.tex ? ch.tex[L.tex] : null })) : null;
    return { ...e, pk: mesh, efc, texB64: e.tex ? ch.tex[e.tex] : null, ovB64: e.overlay ? ch.tex[e.overlay] : null };
  }
  // 인형: 게임은 머리 장비 칸의 일반 아이템을 CustomHeadLayer/EF PatchedHeadLayer 로 그림. 정점은 빌더가 Head 관절 로컬 좌표로 구워 둠(가중치 1)
  async getPlush(id) {
    const a = (this.core.plush && this.core.plush[id]) || (this.core.headItems && this.core.headItems[id]); if (!a) return null;
    const ch = await this.loadChunk('plush', a.c);
    const L = ch.items[id]; if (!L) return null;
    return L.map(x => ({ pk: x.pk, tex: x.tex, b64: ch.tex[x.tex] }));
  }
  async getHeld(id) {
    const h = this.core.held[id]; if (!h) return null;
    const ch = await this.loadChunk('held', h.c);
    const e = ch.items[id]; if (!e) return null;
    return { ...e, texOf: (png) => png ? this.texture('h:' + png, ch.tex[png]) : null, meshOf: (k) => (ch.mesh || {})[k] || null };
  }
  // ---------------- 무기 정보
  weapon(id) { return id ? this.core.weapons[id] || null : null; }
  dualOK(id) { const w = this.weapon(id); return !!(w && w.off === true); }   // EF CapabilityItem.canBePlacedOffhand
  styleOf() {
    const w = this.weapon(this.state.main);
    const keys = w ? Object.keys(w.styles).filter(k => k !== 'MOUNT' && (w.styles[k].combo || w.styles[k].living || w.styles[k].innate)) : [];
    if (this.state.style && keys.includes(this.state.style)) return this.state.style;
    if (!keys.length) return null;
    if (keys.length === 1) return keys[0];
    const o = this.weapon(this.state.off);
    if (o && w && o.cat === w.cat && keys.includes('TWO_HAND')) return 'TWO_HAND';
    return keys.includes('ONE_HAND') ? 'ONE_HAND' : keys[0];
  }
  motions() {
    const L = [];
    if (this.state.mode === 'mining') {
      L.push({ k: 'idle', n: '대기' }, { k: 'walk', n: '걷기' }, { k: 'sprint', n: '뛰기' }, { k: 'swing', n: '휘두르기' }, { k: 'crouch', n: '웅크리기' });
      return L;
    }
    const w = this.weapon(this.state.main), st = this.styleOf();
    const S = w && st ? w.styles[st] : null;
    L.push({ k: 'idle', n: '대기', loop: true, living: 'IDLE' }, { k: 'walk', n: '걷기', loop: true, living: 'WALK' }, { k: 'run', n: '달리기', loop: true, living: 'RUN' });
    const combo = S && S.combo && S.combo.length ? S.combo : (w ? null : this.core.basic);
    if (combo) {
      const n = combo.length;
      combo.forEach((a, i) => L.push({ k: 'c' + i, n: n >= 3 && i === n - 2 ? '대시 공격' : n >= 3 && i === n - 1 ? '공중 공격' : `${i + 1}타`, anims: [a] }));
      const autos = n >= 3 ? combo.slice(0, n - 2) : combo;
      if (autos.length > 1) L.push({ k: 'chain', n: '연속 콤보', anims: autos });
    }
    if (S && S.innate) {
      const sk = this.core.skills[S.innate];
      if (sk) {
        const as = sk.anims.filter(a => this.core.anims[a]);   // 한 스킬의 동작들 = 한 묶음(게임 등록 순)
        if (sk.keys && sk.keys.length) sk.keys.forEach(kk => { const ka = kk.anims.filter(a => this.core.anims[a]); if (ka.length) L.push({ k: 'innk' + kk.key, n: `고유 스킬 (스킬 키 ${kk.key}): ${sk.name}`, anims: ka, tip: sk.tip }); });   // 키마다 다른 스킬
        else if (as.length) L.push({ k: 'inn', n: `고유 스킬: ${sk.name}`, anims: as, tip: sk.tip });
        else L.push({ k: 'innx', n: `고유 스킬: ${sk.name} (모션 없음)`, anims: [], tip: sk.tip, disabled: true });
      }
    }
    if (w && w.passive && this.core.skills[w.passive]) {
      const ps = this.core.skills[w.passive];
      const inCombo = new Set([...(S && S.combo || []), ...Object.values(S && S.living || {})]);
      const own = ps.anims.filter(a => this.core.anims[a] && !inCombo.has(a));
      const charge = ps.anims.find(a => this.core.anims[a] && /\/living\/[^/]*charg/.test(a));   // 차징 자세(생활 모션에도 쓰일 수 있음)
      const charged = own.filter(a => /charged_attack_(\d+)/.test(a)).sort();
      // 차징 시간: TormentPassiveSkill 디컴파일 — 모은 틱 >= 20 -> 1단계, >= 50 -> 2단계, >= 80 -> 3단계 (20틱 = 1초)
      const HOLD = { 'wom:torment_passive': { 1: 20, 2: 50, 3: 80 } }[w.passive] || {};
      charged.forEach(a => { const n = a.match(/charged_attack_(\d+)/)[1]; const ht = HOLD[n]; L.push({ k: 'pc' + n, n: `우클릭 차징 공격 ${n}단계`, anims: charge ? [ht ? { id: charge, hold: ht / 20 } : charge, a] : [a], tip: ps.tip || ps.name }); });
      own.filter(a => a !== charge && !charged.includes(a) && !/\/combat\/[^/]*auto_\d/.test(a)).forEach((a, i) => L.push({ k: 'pa' + i, n: `패시브 동작: ${a.split('/').pop()}`, anims: [a], tip: ps.tip || ps.name }));
    }
    if (S && S.living) for (const [mo, a] of Object.entries(S.living)) if (!['IDLE', 'WALK', 'RUN'].includes(mo)) L.push({ k: 'lv' + mo, n: MOTION_KO[mo] || mo, loop: true, living: mo });
    const mount = w && w.styles.MOUNT && w.styles.MOUNT.combo;
    if (mount && mount.length) L.push({ k: 'mount', n: '탑승 공격', anims: mount });
    return L;
  }
  // 재생 속도 = getPlaySpeed (선언 클래스별 식) -> PLAY_SPEED_MODIFIER (덤프에서 실제로 불러 본 값) , 틱마다 elapsed += 0.05 x 속도 (AnimationPlayer.tick)
  baseSpeed(meta, clip) {
    const decl = (meta.psDecl || '').split('.').pop();
    const sup = meta.supers || [];
    const isAvalon = decl === 'AvalonAttackAnimation' || (!decl && (meta.cls === 'AvalonAttackAnimation' || sup.includes('AvalonAttackAnimation')));
    const isAtk = decl ? decl === 'AttackAnimation' : (!isAvalon && (sup.includes('AttackAnimation') || meta.cls === 'AttackAnimation'));
    if (decl === 'AutoDiscardActionAnimation' || decl === 'VFXBBActionAnimation') return { v: meta.psf != null ? meta.psf : 1 };   // return this.play_speed
    if (decl === 'AvalonMovementAnimation') {   // 걷기 속도(WalkAnimationState.speed) x this.speed — 걷기 0.863(0.2158 블록/틱 x4), 달리기 1(상한)
      const ws = this._living === 'RUN' ? 1 : this._living === 'WALK' ? 0.863 : 1;
      return { v: ws * (meta.spdf != null ? meta.spdf : 1), note: meta.spdf == null ? '이 이동 동작의 속도 배율은 아직 덤프되지 않았습니다.' : '' };
    }
    if (!isAvalon && !isAtk) {
      if (!decl || ['StaticAnimation', 'DynamicAnimation', 'ActionAnimation', 'MainFrameAnimation', 'MovementAnimation'].includes(decl)) return { v: 1 };
      return { v: 1, note: `${decl} 의 재생 속도 식은 확인되지 않아 기본 속도로 보여 줍니다.` };
    }
    const hand = meta.hand === 'OFF_HAND' ? 'off' : 'main';
    const wid = this.state[hand] || this.state.main;
    const w = this.weapon(wid);
    let spd;
    if (!wid) spd = 4;
    else if (w && w.spd) spd = w.spd[this.styleOf()] != null ? w.spd[this.styleOf()] : w.spd._;
    if (spd == null) return { v: 1, note: '이 무기의 공격 속도는 확인되지 않아 기본 속도로 보여 줍니다.' };
    if (isAvalon) return { v: spd * (meta.psf != null ? meta.psf : 1), spd };    // AvalonAttackAnimation.getPlaySpeed = 공격속도 x play_speed
    let c = meta.bas ? spd / meta.bas : clip.t * spd;                            // AttackAnimation.getPlaySpeed
    c = Math.round(c * 1000) / 1000;
    return { v: 1 + (c - 1) * (meta.fac != null ? meta.fac : 1), spd };
  }
  timeline(meta, clip) {
    const b = this.baseSpeed(meta, clip);
    let note = b.note || '';
    const T = clip.t, tl = [0];
    let e = 0, guard = 0;
    const a1 = meta.psm1, a2 = meta.psm2;
    if (meta.psm && !a1) note = note || '이 동작은 게임 안 함수로 속도를 바꾸는데 그 값이 아직 덤프되지 않아 기본 속도로 보여 줍니다.';
    let sp = b.v;
    while (e < T && guard++ < 4000) {
      sp = b.v;
      if (a1) { const k = Math.min(a1.length - 1, Math.round(e / 0.05)); const f1 = a1[k], f2 = a2 ? a2[k] : null; if (f1 != null) sp = f2 != null ? f1 + (b.v - 1) * (f2 - f1) : f1; }
      else if (meta.psm) sp = 1;
      if (!(sp > 0.01)) sp = 0.01;
      e = Math.min(T, e + 0.05 * sp); tl.push(e);
    }
    if (!note && b.spd != null) note = `공격 속도 ${b.spd.toFixed(2)} 기준 재생 속도 ×${(T / ((tl.length - 1) * 0.05)).toFixed(2)}`;
    return { tl, dur: (tl.length - 1) * 0.05, note };
  }
  // 생활 모션: 기본 레이어 애니 + 무기 합성 레이어
  livingFor(motion) {
    const w = this.weapon(this.state.main), st = this.styleOf();
    const mod = w && st && w.styles[st] && w.styles[st].living ? w.styles[st].living : {};
    let baseId = this.core.living[motion] || this.core.living.IDLE;
    const comps = [];
    const a = mod[motion];
    if (a && this.core.anims[a]) {
      if (this.core.anims[a].layer === 'COMPOSITE_LAYER') comps.push(a); else baseId = a;
    }
    return { baseId, comps };
  }
  // ---------------- 갱신
  async refresh() {
    if (!this.ready) return;
    const tok = (this.tok = (this.tok || 0) + 1);
    if (this.state.main && !this.dualOK(this.state.main) && this.state.off) this.state.off = null;   // 쌍수 안 되는 무기: 왼손을 손 물건 만들기 전에 비움 (11-14)
    this.root.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === this.state.mode));
    // 갑옷
    for (const [slot] of SLOTS) {
      const id = this.state.slots[slot];
      const cur = this.armorMeshes[slot];
      if (cur && cur.id === id) continue;
      if (cur) cur.meshes.forEach(m => { this.model.remove(m.mesh); m.geo.dispose(); });
      delete this.armorMeshes[slot];
      if (!id) continue;
      const a = await this.getArmor(id); if (tok !== this.tok) return;
      if (a && a.efc && a.efc.length) {   // efcompat 가 그리는 갑옷 (GeckoLib·자체 모델): 게임처럼 원래 모델을 부위째 관절에 붙임
        const meshes = a.efc.map(L => new SkinMesh(L.pk, this.texture('a:' + L.tex, L.texB64), L.emis ? { eyes: true } : { transparent: !!L.alpha, offset: true }));
        meshes.forEach(m => this.model.add(m.mesh));
        this.armorMeshes[slot] = { id, meshes };
        continue;
      }
      if (!a || !a.pk) continue;
      const meshes = [];
      const dye = a.dye != null ? a.dye : null;
      meshes.push(new SkinMesh(a.pk, this.texture('a:' + a.tex, a.texB64), { color: dye != null ? (dye & 0xffffff) : null, offset: true }));
      if (a.ovB64) meshes.push(new SkinMesh(a.pk, this.texture('a:' + a.overlay, a.ovB64), { offset: true }));
      meshes.forEach(m => this.model.add(m.mesh));
      this.armorMeshes[slot] = { id, meshes };
    }
    // 인형 (머리 장비 칸 아이템)
    {
      const id = this.state.plush;
      const cur = this.armorMeshes.PLUSH;
      if (!(cur && cur.id === id)) {
        if (cur) cur.meshes.forEach(m => { this.model.remove(m.mesh); m.geo.dispose(); });
        delete this.armorMeshes.PLUSH;
        if (id) {
          const layers = await this.getPlush(id); if (tok !== this.tok) return;
          if (layers) {
            const meshes = layers.map(L => new SkinMesh(L.pk, this.texture('p:' + L.tex, L.b64), {}));
            meshes.forEach(m => this.model.add(m.mesh));
            this.armorMeshes.PLUSH = { id, meshes };
          }
        }
      }
    }
    // 손
    for (const h of ['main', 'off']) {
      const id = this.state[h];
      const cur = this.heldObjs[h];
      if (cur && cur.id === id && cur.mode === this.state.mode) continue;
      if (cur) { if (cur.obj.parent) cur.obj.parent.remove(cur.obj); if (cur.skin) for (const k in cur.skin.sets) cur.skin.sets[k].forEach(m => m.geo.dispose()); }
      this.heldObjs[h] = null;
      if (!id) continue;
      const e = await this.getHeld(id); if (tok !== this.tok) return;
      if (!e) continue;
      // 전투모드: EF 전용 손 렌더러(RenderMeshItem 등)가 있으면 그걸로 기록한 3D 모양, 채광모드: 바닐라 손 그림
      // 전투모드 + 스킨 메시 무기(Avalon RenderMeshItem, efn 무라사마/팔시온/야마토): 게임처럼 플레이어 뼈대 포즈로 메시를 그림 (SkinnedMesh.draw(armature.getPoseMatrices()))
      //  손 쪽 메시가 없으면(mesh_off 없음) 게임도 아무것도 안 그림
      if (this.state.mode === 'combat' && e.efMesh) {
        const sets = {}, obj = new THREE.Group();
        // 아이템 전용 뼈대(IAvalonAnimationItem: broadblade·nf_claw·thornwheel·kusabimaru): 게임은 오른손에 들었을 때만 그림(PLivingEntityRendererMixin)
        const arm = e.efMesh.arm || null;
        const irig = arm && h === 'main' && this.core.itemArm && this.core.itemArm[arm] ? (this._irig = this._irig || {}, this._irig[arm] = this._irig[arm] || new Rig({ joints: this.core.itemArm[arm] })) : null;
        const translucent = e.ren !== 'RenderMeshItem';     // RenderMeshItem = entityCutout, 나머지 = entityTranslucent
        for (const k of (!arm || irig) ? [h, h + '2'] : []) {     // 전용 뼈대 무기를 왼손에 들면 게임도 안 그림
          const L = e.efMesh[k]; if (!L) continue;
          const pk = e.meshOf(L.m); if (!pk) continue;
          const ms = [new SkinMesh(pk, e.texOf(L.t), { transparent: translucent })];
          if (L.l) ms.push(new SkinMesh(pk, e.texOf(L.l), { emissive: true, opacity: L.la }));
          ms.forEach(m => obj.add(m.mesh));
          sets[k === h ? 'a' : 'b'] = ms;
        }
        this.model.add(obj);
        this.heldObjs[h] = { id, obj, skin: { sets, alt: e.efMesh.alt || null, rig: irig }, corr: h === 'main' ? e.main : e.off, mode: this.state.mode, trail: e.trail || null };
        continue;
      }
      const efp = h === 'main' ? e.efR : e.efL;
      const useEF = this.state.mode === 'combat' && efp && efp.length;
      const obj = heldObject(useEF ? efp : (h === 'main' ? e.right : e.left), e.texOf);
      this.world.add(obj);
      this.heldObjs[h] = { id, obj, corr: h === 'main' ? e.main : e.off, mode: this.state.mode, trail: e.trail || null };
    }
    this.uiControls();
    await this.prepareMotion(tok);
    this.uiNoteOnly();
  }
  uiControls() {
    const names = (id) => id ? ((this.opts.names && this.opts.names[id]) || (this.core.plush && this.core.plush[id] && this.core.plush[id].name) || (this.core.headItems && this.core.headItems[id] && this.core.headItems[id].name) || (this.core.armor[id] && this.core.armor[id].name) || (this.core.held[id] && this.core.held[id].name) || id) : '없음';
    const slotsEl = this.$('.wp-slots');
    const shown = (s) => this.state.slots[s] || (s === 'HEAD' && this.isHeadItem(this.state.plush) ? this.state.plush : null);   // 머리 아이템 층 물건은 머리 칸에 보임
    slotsEl.innerHTML = SLOTS.map(([s, n]) => `<div class="wp-pick" data-slot="${s}"><span class="wp-lbl">${n}</span><button type="button" class="wp-sel">${shown(s) ? this.iconHtml(shown(s)) : ''}<span>${esc(names(shown(s)))}</span></button>${shown(s) ? '<button type="button" class="wp-x" title="벗기">×</button>' : ''}</div>`).join('');
    // 인형 칸 (머리 칸 바로 뒤): core.plush 가 있을 때만. opts.plushList 로 보일 인형을 제한할 수 있음
    const plushIds = this.core.plush ? Object.keys(this.core.plush).filter(id => !this.opts.plushList || this.opts.plushList.includes(id)) : [];
    if (plushIds.length) {
      const pid = this.isHeadItem(this.state.plush) ? null : this.state.plush;   // 머리 아이템(두개골)은 머리 칸에 보임
      const row = `<div class="wp-pick" data-plush="1"><span class="wp-lbl">인형</span><button type="button" class="wp-sel">${pid ? this.iconHtml(pid) : ''}<span>${esc(names(pid))}</span></button>${pid ? '<button type="button" class="wp-x" title="벗기">×</button>' : ''}</div>`;
      const hi = slotsEl.querySelector('.wp-pick[data-slot="HEAD"]');
      if (hi) hi.insertAdjacentHTML('afterend', row); else slotsEl.insertAdjacentHTML('afterbegin', row);
      const pel = slotsEl.querySelector('.wp-pick[data-plush]');
      const pName = (id) => (this.opts.names && this.opts.names[id]) || this.core.plush[id].name || id;
      // 탭 = 데이터의 분류(sup/supName) 순서대로 — 새 분류가 생겨도 빠지지 않게 (11-16 리뷰 지적)
      const pTabs = []; plushIds.forEach(id => { const P = this.core.plush[id], k = P.sup || 'etc'; if (!pTabs.some(t => t[0] === k)) pTabs.push([k, P.supName || (PLUSH_SUPER.find(t => t[0] === k) || [k, '기타'])[1]]); });
      pTabs.sort((x, y) => { const ix = PLUSH_SUPER.findIndex(t => t[0] === x[0]), iy = PLUSH_SUPER.findIndex(t => t[0] === y[0]); return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy); });
      pel.querySelector('.wp-sel').onclick = () => this.picker(plushIds.map(id => ({ id, n: pName(id), cat: this.core.plush[id].sup || 'etc' })), (id) => this.setPlush(id), pTabs, 'plush');
      const px = pel.querySelector('.wp-x'); if (px) px.onclick = () => this.setPlush(null);
    }
    if (this.state.main && !this.dualOK(this.state.main) && this.state.off) this.state.off = null;
    const hands = this.state.main && !this.dualOK(this.state.main) ? [['main', '오른손']] : [['main', '오른손'], ['off', '왼손']];
    const handsEl = this.$('.wp-hands');
    handsEl.innerHTML = hands.map(([h, n]) => `<div class="wp-pick" data-hand="${h}"><span class="wp-lbl">${n}</span><button type="button" class="wp-sel">${this.state[h] ? this.iconHtml(this.state[h]) : ''}<span>${esc(names(this.state[h]))}</span></button>${this.state[h] ? '<button type="button" class="wp-x" title="빼기">×</button>' : ''}</div>`).join('');
    const armorOK = this.opts.armorList || this.core.armorPick || Object.keys(this.core.armor);
    const aName = (id) => (this.opts.names && this.opts.names[id]) || (this.core.armor[id] || this.core.headItems[id]).name || id;   // 손 칸과 같은 원리: names 먼저
    const aCat = (id) => (this.core.armorCat || {})[id] || 'war';
    slotsEl.querySelectorAll('.wp-pick[data-slot]').forEach(el => {
      const s = el.dataset.slot;
      el.querySelector('.wp-sel').onclick = () => this.picker((s === 'HEAD' ? [...armorOK, ...Object.keys(this.core.headItems || {}).filter(id => !armorOK.includes(id) && (!this.opts.armorList || this.opts.armorList.includes(id)))] : armorOK).filter(id => (this.core.armor[id] && this.core.armor[id].slot === s) || (s === 'HEAD' && this.isHeadItem(id))).map(id => ({ id, n: aName(id), cat: aCat(id) })), (id) => this.setSlot(s, id), ARMOR_TABS, 'armor');
      const x = el.querySelector('.wp-x'); if (x) x.onclick = () => this.setSlot(s, null);
    });
    // 세트 칸 (11-14 사용자: "세트 카테고리를 추가 (한번에 입힐 수 있게)") — 이 위키 갑옷 목록에 모든 부위가 있는 세트만
    const okSet = new Set(armorOK);
    const sets = (this.core.armorSets || []).filter(st => st.ids.every(id => (okSet.has(id) || (this.isHeadItem(id) && (!this.opts.armorList || this.opts.armorList.includes(id)))) && (this.core.armor[id] || this.isHeadItem(id))));
    if (sets.length) {
      const row = document.createElement('div'); row.className = 'wp-pick'; row.dataset.set = '1';
      row.innerHTML = `<span class="wp-lbl">세트</span><button type="button" class="wp-sel"><span>세트 골라 한 번에 입히기</span></button>`;
      slotsEl.appendChild(row);
      const SL = { HEAD: '머리', CHEST: '가슴', LEGS: '다리', FEET: '발' };
      row.querySelector('.wp-sel').onclick = () => this.picker(sets.map(st => ({ id: 'set:' + st.k, n: st.n, cat: st.cat, icon: st.icon, sub: st.ids.map(id => SL[this.core.armor[id] ? this.core.armor[id].slot : 'HEAD']).join(' · ') })), (k) => { const st = sets.find(x => 'set:' + x.k === k); if (st) this.equipSet(st.ids); }, ARMOR_TABS, 'set');
    }
    handsEl.querySelectorAll('.wp-pick').forEach(el => {
      const h = el.dataset.hand;
      const shields = new Set(this.core.shieldList || []);
      const hCat = (id) => { const c = (this.core.handCat || {})[id]; if (h === 'off' && shields.has(id)) return 'shield'; return c && c !== 'shield' ? c : 'melee'; };
      el.querySelector('.wp-sel').onclick = () => this.picker([...new Set(h === 'main' ? (this.opts.handList || this.core.handList || Object.keys(this.core.held)) : [...(this.core.shieldList || []), ...(this.opts.handList || this.core.handList || []).filter(id => this.dualOK(id))])].filter(id => this.core.held[id]).map(id => ({ id, n: ((this.opts.names && this.opts.names[id]) || this.core.held[id].name || id) + (hCat(id) === 'shield' ? '' : handsTag(this.weapon(id))), cat: hCat(id) })), (id) => this.setHand(h, id), h === 'main' ? HAND_TABS : OFF_TABS, 'hand-' + h);
      const x = el.querySelector('.wp-x'); if (x) x.onclick = () => this.setHand(h, null);
    });
    // 잡는 방식
    const styleEl = this.$('.wp-style');
    const w = this.weapon(this.state.main);
    const keys = this.state.mode === 'combat' && w ? Object.keys(w.styles).filter(k => k !== 'MOUNT' && (w.styles[k].combo || w.styles[k].living || w.styles[k].innate)) : [];
    const cur = this.styleOf();
    styleEl.innerHTML = keys.length > 1 ? `<span class="wp-lbl">잡는 방식</span>` + keys.map(k => `<button type="button" data-style="${k}" class="${k === cur ? 'on' : ''}">${esc(STYLE_KO[k] || k)}</button>`).join('') : '';
    styleEl.querySelectorAll('[data-style]').forEach(b => b.onclick = () => { this.state.style = b.dataset.style; this.state.motion = 'idle'; this.refresh(); });
    // 동작
    const ms = this.motions();
    if (!ms.find(m => m.k === this.state.motion)) this.state.motion = 'idle';
    const mEl = this.$('.wp-motions');
    mEl.innerHTML = ms.map(m => `<button type="button" data-m="${m.k}" class="${m.k === this.state.motion ? 'on' : ''}" ${m.disabled ? 'disabled' : ''} title="${esc(m.tip || '')}">${esc(m.n)}</button>`).join('');
    mEl.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { this.state.motion = b.dataset.m; this.state.t = 0; mEl.querySelectorAll('[data-m]').forEach(x => x.classList.toggle('on', x === b)); this.prepareMotion(this.tok).then(() => this.uiNoteOnly()); });
    // 메모
    const notes = [];
    if (this.state.mode === 'mining') notes.push('채광모드: 이 팩은 Epic Fight 설정 enable_player_vanilla_model = true 라서 바닐라 모델 움직임으로 그립니다(갑옷 모양은 EF 가 구운 메시).');
    if (this.state.mode === 'combat' && this.state.main && w == null) notes.push('이 물건은 Epic Fight 무기 능력이 없어 맨손 콤보로 휘두릅니다.');
    if (this.state.mode === 'combat' && !this.state.main) notes.push('맨손: Epic Fight 기본 주먹 콤보.');
    this.baseNotes = notes; this.uiNoteOnly();
    this.$('.wp-sum').textContent = [SLOTS.map(([s]) => this.state.slots[s]).filter(Boolean).length ? `갑옷 ${SLOTS.map(([s]) => this.state.slots[s]).filter(Boolean).length}` : '', this.state.plush ? names(this.state.plush) : '', this.state.main ? names(this.state.main) : ''].filter(Boolean).join(' · ');
  }
  uiNoteOnly() { this.$('.wp-note').textContent = [this.skinNote || '', ...(this.baseNotes || []), this.state.mode === 'combat' ? this.speedNote : ''].filter(Boolean).join(' '); }
  iconHtml(id) {
    if (this.opts.iconHtml) { const h = this.opts.iconHtml(id); if (h) return h; }      // 다른 위키가 자기 아이콘을 줄 수 있음
    const P = this.core.pick; if (!P) return '';
    // 시트 배경은 .wp-ico-s(시트 칸)에만: iconHtml 로 넘긴 아이콘 뒤에 비치지 않게 (마법 위키 세션 지적, 11-13)
    if (!this._pickCss) { this._pickCss = true; const st = document.createElement('style'); st.textContent = `.wp-ico-s{background-image:url(data:image/png;base64,${P.png});background-size:${P.cols * 100}% ${P.rows * 100}%;}`; document.head.appendChild(st); }
    const i = P.idx[id]; if (i == null) return '<span class="wp-ico wp-ico-none"></span>';
    const c = i % P.cols, r = Math.floor(i / P.cols);
    return `<span class="wp-ico wp-ico-s" style="background-position:${P.cols > 1 ? c / (P.cols - 1) * 100 : 0}% ${P.rows > 1 ? r / (P.rows - 1) * 100 : 0}%"></span>`;
  }
  // 고르기 창 (11-14): 분류 탭(tabs [[키, 이름]]). 검색어가 있으면 모든 탭에서 찾고 분류 이름을 같이 보여 줌. 마지막 탭은 창 종류(kind)마다 기억
  picker(list, onPick, tabs, kind) {
    const old = this.root.querySelector('.wp-pop'); if (old) old.remove();
    const pop = document.createElement('div'); pop.className = 'wp-pop';
    const T = (tabs || []).filter(([k]) => list.some(x => x.cat === k));
    const tabName = Object.fromEntries((tabs || []).map(([k, n]) => [k, n]));
    this._pickTab = this._pickTab || {};
    let tab = T.find(([k]) => k === this._pickTab[kind]) ? this._pickTab[kind] : (T[0] ? T[0][0] : null);
    pop.innerHTML = `<div class="wp-pop-in"><input type="search" placeholder="이름 또는 id 검색" aria-label="검색"><div class="wp-pop-tabs"></div><div class="wp-pop-list"></div><button type="button" class="wp-pop-close">닫기</button></div>`;
    const inp = pop.querySelector('input'), box = pop.querySelector('.wp-pop-list'), tabsEl = pop.querySelector('.wp-pop-tabs');
    const draw = () => {
      const q = inp.value.trim().toLowerCase();
      tabsEl.innerHTML = T.length > 1 ? T.map(([k, n]) => `<button type="button" data-tab="${k}" class="${!q && k === tab ? 'on' : ''}">${esc(n)} <small>${list.filter(x => x.cat === k).length}</small></button>`).join('') : '';
      tabsEl.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; this._pickTab[kind] = tab; inp.value = ''; draw(); });
      const L = list.filter(x => q ? (x.id.toLowerCase().includes(q) || String(x.n).toLowerCase().includes(q)) : (!T.length || x.cat === tab)).slice(0, 1500);
      box.innerHTML = L.map(x => `<button type="button" data-id="${esc(x.id)}">${this.iconHtml(x.icon || x.id)}<span class="wp-pick-tx"><b>${esc(x.n)}</b><small>${esc([q && T.length > 1 ? tabName[x.cat] : '', x.sub || x.id].filter(Boolean).join(' · '))}</small></span></button>`).join('') || '<div class="wp-empty">없음</div>';
      box.querySelectorAll('[data-id]').forEach(b => b.onclick = () => { pop.remove(); onPick(b.dataset.id); });
      box.scrollTop = 0;
    };
    inp.oninput = draw; pop.querySelector('.wp-pop-close').onclick = () => pop.remove();
    pop.onclick = (e) => { if (e.target === pop) pop.remove(); };
    this.root.appendChild(pop); draw(); inp.focus();
  }
  // ---------------- 동작 준비: 클립 불러오기 + 모든 프레임으로 맞춤 상자 계산
  async prepareMotion(tok) {
    const m = this.motions().find(x => x.k === this.state.motion) || this.motions()[0];
    this.cur = null; this.speedNote = '';
    if (this.state.mode === 'mining') {
      this.cur = { mining: m.k, len: m.k === 'swing' ? 0.6 : 2.4 };
    } else if (m.living) {
      this._living = m.living;
      const { baseId, comps } = this.livingFor(m.living);
      const base = await this.getClip(baseId);
      const cs = []; for (const c of comps) cs.push({ clip: await this.getClip(c), meta: this.core.anims[c] });
      const rateOf = (meta, clip) => { if (!meta || !clip) return 1; const tm = this.timeline(meta, clip); if (tm.note) this.speedNote = this.speedNote || tm.note; return tm.dur > 0 ? clip.t / tm.dur : 1; };
      if (tok !== this.tok) return;
      const len = Math.max(base ? base.t : 1, ...cs.map(c => c.clip ? c.clip.t : 0)) || 1;
      const baseRate = rateOf(this.core.anims[baseId], base);
      cs.forEach(c => c.rate = rateOf(c.meta, c.clip));
      this.cur = { living: m.living, base: { clip: base, meta: this.core.anims[baseId], rate: baseRate }, comps: cs.filter(c => c.clip), len: Math.max(base ? base.t / baseRate : 1, ...cs.filter(c => c.clip).map(c => c.clip.t / c.rate)) || 1 };
    } else {
      const seq = [];
      const expanded = [];
      const holds = {};
      const addChain = (ent, depth) => { const id = typeof ent === 'string' ? ent : ent.id; if (typeof ent !== 'string' && ent.hold) holds[expanded.length] = ent.hold; expanded.push(id); const nx = (this.core.anims[id] || {}).next || []; if (depth < 3) nx.forEach(n => { if (!expanded.includes(n)) addChain(n, depth + 1); }); };
      (m.anims || []).forEach(a => addChain(a, 0));
      for (const [ix, a] of expanded.entries()) { const c = await this.getClip(a); if (c) { const meta = this.core.anims[a]; const tm = this.timeline(meta, c); let tl = tm.tl, dur = tm.dur; if (holds[ix]) { const n = Math.round(holds[ix] / 0.05); const base = tl.slice(); tl = []; for (let k = 0; k <= n; k++) tl.push(base[Math.min(k, base.length - 1)] % c.t); dur = n * 0.05; } seq.push({ id: a, clip: c, meta, tl, psNote: tm.note, dur }); } }
      if (tok !== this.tok) return;
      // 게임처럼 잇기 (11-14 사용자 "연속 콤보가 연속 콤보처럼 보이지 않음"):
      //  - 연속 콤보: 앞 공격은 다음 기본 공격을 받는 가장 이른 때(공격 구간 recovery, CAN_BASIC_ATTACK)에 끊음
      //  - 다음 동작은 Animator.playAnimation 처럼 그 동작의 transition 시간 동안 지금 자세에서 첫 자세로 넘어감(LinkAnimation)
      //  - 공격 이동(뿌리 이동)은 앞 동작이 끝난 자리에서 이어짐
      const isAct = (meta) => (meta.supers || []).some(n => /ActionAnimation/.test(n)) || /Attack|Action/.test(meta.cls || '');
      const disp = (s, lt) => { if (!isAct(s.meta)) return [0, 0, 0]; const w0 = rootToCoord(this.rig, clipPose(s.clip, 0), !!s.meta.mv), w = rootToCoord(this.rig, clipPose(s.clip, lt), !!s.meta.mv); return [w[0] - w0[0], 0, w[2] - w0[2]]; };
      const joined = []; let base = [0, 0, 0];
      for (let i = 0; i < seq.length; i++) {
        let s = seq[i]; const nx = seq[i + 1];
        if (m.k === 'chain' && nx && s.meta.rcv != null) {
          const k = s.tl.findIndex(v => v >= s.meta.rcv - 1e-6);
          if (k > 0 && k < s.tl.length - 1) s = { ...s, tl: s.tl.slice(0, k + 1), dur: k * 0.05, cut: true };
        }
        s = { ...s, base: base.slice() };
        const endLt = s.tl[s.tl.length - 1], d = disp(s, endLt);
        joined.push(s);
        base = [base[0] + d[0], 0, base[2] + d[2]];
        if (nx) {
          const tr = nx.meta.tr != null ? nx.meta.tr : 0.1;
          // 공격 동작 자세는 뿌리 이동을 몸 이동으로 빼낸 자세(ActionAnimation.correctRootJoint) — 잇는 자세도 같게
          const pa = clipPose(s.clip, endLt), pb = clipPose(nx.clip, nx.tl[0] || 0);
          if (isAct(s.meta)) rootToCoord(this.rig, pa, !!s.meta.mv);
          if (isAct(nx.meta)) rootToCoord(this.rig, pb, !!nx.meta.mv);
          if (tr > 0) joined.push({ link: true, id: nx.id, meta: nx.meta, dur: tr, base: base.slice(), pa, pb, layer: nx.meta.layer });
        }
      }
      seq.length = 0; seq.push(...joined);
      const endMove = base;
      const { baseId, comps } = this.livingFor('IDLE');
      const idle = await this.getClip(baseId);
      const len = seq.reduce((s, x) => s + x.dur, 0) || 1;
      this.speedNote = seq.map(x => x.psNote).filter(Boolean)[0] || '';
      this.cur = { seq, idle: { clip: idle, meta: this.core.anims[baseId] }, len: len + 0.4, endMove };
    }
    this.state.t = 0;
    this.computeBox();
    this.fit(false);      // 사용자가 시점을 움직였으면 그대로 둠 (작은 칸·전체화면 같은 원리)
  }
  // 시각 t 의 장면 상태 계산: 스킨 행렬, 손 행렬, 플레이어 이동
  frame(t) {
    const rig = this.rig, cur = this.cur;
    this.curSel = null;     // 공격 동작일 때만 아래에서 다시 채움 (생활 동작·채광모드에서 앞 공격의 궤적이 남던 문제, 11-14)
    if (!cur) return null;
    if (cur.mining) {
      const tick = t * 20;
      const st = { age: tick, limb: 0, limbAmt: 0, attack: 0, rightItem: !!this.state.main, leftItem: !!this.state.off, crouch: cur.mining === 'crouch' };
      if (cur.mining === 'walk') { st.limbAmt = 0.86; st.limb = tick * 0.86; }
      if (cur.mining === 'sprint') { st.limbAmt = 1; st.limb = tick * 1.0; }
      if (cur.mining === 'swing') { const sw = (tick % 12) / 6; st.attack = sw < 1 ? sw : 0; }
      const v = vanillaSkin(rig, st);
      return { S: v.S, hand: { main: v.handR, off: v.handL }, move: [0, 0, 0] };
    }
    let pose, move = [0, 0, 0], linkAnim = null;
    const motion = cur.living || 'IDLE';
    if (cur.living) {
      const tt = t % cur.len;
      const base = cur.base.clip ? clipPose(cur.base.clip, (tt * cur.base.rate) % cur.base.clip.t) : {};
      const layers = cur.comps.map(c => ({ pose: clipPose(c.clip, (tt * c.rate) % c.clip.t), meta: c.meta })).sort((a, b) => PRI.indexOf(a.meta.pri) - PRI.indexOf(b.meta.pri));
      pose = composePose(rig, base, layers, motion);
    } else {
      let tt = t % cur.len, acc = 0, sel = null, startMove = [0, 0, 0];
      for (const s of cur.seq) { if (tt < acc + s.dur) { sel = s; break; } acc += s.dur; }
      const idleBase = cur.idle.clip ? clipPose(cur.idle.clip, (t % cur.idle.clip.t)) : {};
      if (!sel) { pose = idleBase; move = (cur.endMove || [0, 0, 0]).slice(); }
      else if (sel.link) {
        const lp = lerpPose(sel.pa, sel.pb, (tt - acc) / sel.dur);
        pose = sel.layer === 'COMPOSITE_LAYER' ? composePose(rig, idleBase, [{ pose: lp, meta: sel.meta }], 'IDLE') : lp;
        move = sel.base.slice();
        linkAnim = sel.id;      // LinkAnimation.getRealAnimation = 다음 동작 (야마토 칼 모델 판정 등)
      }
      else {
        const x = (tt - acc) / 0.05, k = Math.floor(x), tl = sel.tl;
        this.curSel = { sel, x };                 // 틱 표에서 실제 시간 -> 클립 시간
        const lt = k >= tl.length - 1 ? tl[tl.length - 1] : tl[k] + (tl[k + 1] - tl[k]) * (x - k);
        const p = clipPose(sel.clip, lt);
        const isAction = (sel.meta.supers || []).some(n => /ActionAnimation/.test(n)) || /Attack|Action/.test(sel.meta.cls || '');
        if (isAction) {
          const p0 = clipPose(sel.clip, 0);
          const w0 = rootToCoord(rig, p0, !!sel.meta.mv), w = rootToCoord(rig, p, !!sel.meta.mv);
          move = [w[0] - w0[0], 0, w[2] - w0[2]];
        }
        if (sel.base) move = [move[0] + sel.base[0], 0, move[2] + sel.base[2]];
        if (sel.meta.layer === 'COMPOSITE_LAYER') pose = composePose(rig, idleBase, [{ pose: p, meta: sel.meta }], 'IDLE');
        else pose = p;
      }
    }
    const { W, S } = rig.solve(pose);
    const hand = {};
    for (const h of ['main', 'off']) {
      const o = this.heldObjs[h]; if (!o) continue;
      const jn = h === 'main' ? 'Tool_R' : 'Tool_L';
      const corr = (o.corr && o.corr[jn]) ? Float64Array.from(o.corr[jn]) : I4();
      hand[h] = mul(W[rig.byName[jn].i], corr);                  // RenderItemBase.getCorrectionMatrix: correction.mulFront(pose)
    }
    return { S, W, hand, move, pose, anim: (this.curSel && this.curSel.sel) ? this.curSel.sel.id : linkAnim };
  }
  // ---------------- EF 무기 궤적 (TrailInfo.overwrite + AnimationTrailParticle/AbstractTrailParticle)
  trailFor(sel, hand) {
    const o = this.heldObjs[hand]; if (!o || !o.trail) return [];
    const out = [];
    for (const at of (sel.meta.trails || [])) {
      if ((at.hand || 'MAIN_HAND') !== (hand === 'main' ? 'MAIN_HAND' : 'OFF_HAND')) continue;
      const it = o.trail, vt = (a, b) => a != null ? a : b;
      const okTime = at.t0 != null && at.t0 >= 0 && at.t1 != null && at.t1 >= 0;
      const okCol = at.r >= 0 && at.g >= 0 && at.b >= 0;
      const m = { s: vt(at.s, it.s), e: vt(at.e, it.e), j: vt(at.j, it.j) || 'Tool_R', t0: okTime ? at.t0 : it.t0, t1: okTime ? at.t1 : it.t1,
        r: okCol ? at.r : it.r, g: okCol ? at.g : it.g, b: okCol ? at.b : it.b, n: at.n >= 0 ? at.n : it.n, life: at.life >= 0 ? at.life : it.life, tex: vt(at.tex, it.tex) };
      if (!m.s || !m.e || !(m.n > 0) || !(m.life > 0) || !m.tex || m.t0 == null || m.t1 == null) continue;   // TrailInfo.playable
      out.push(m);
    }
    return out;
  }
  trailEdgePos(sel, clipT, m, hand) {
    const rig = this.rig;
    const p = clipPose(sel.clip, clipT);
    let mv = [0, 0, 0];
    const isAction = (sel.meta.supers || []).some(n => /ActionAnimation/.test(n)) || /Attack|Action/.test(sel.meta.cls || '');
    if (isAction) { const p0 = clipPose(sel.clip, 0); const w0 = rootToCoord(rig, p0, !!sel.meta.mv), w = rootToCoord(rig, p, !!sel.meta.mv); mv = [w[0] - w0[0], 0, w[2] - w0[2]]; }
    if (sel.base) mv = [mv[0] + sel.base[0], mv[1], mv[2] + sel.base[2]];   // 앞 동작까지 이동한 자리 (frame() 의 몸 위치와 같은 원리, 11-14)
    const pose = sel.meta.layer === 'COMPOSITE_LAYER' && this.cur.idle && this.cur.idle.clip ? composePose(rig, clipPose(this.cur.idle.clip, 0), [{ pose: p, meta: sel.meta }], 'IDLE') : p;
    const { W } = rig.solve(pose);
    const J = rig.byName[m.j]; if (!J) return null;
    const o = this.heldObjs[hand];
    const corr = (o.corr && o.corr[m.j]) ? Float64Array.from(o.corr[m.j]) : I4();
    const M = W[J.i];          // getBoundTransformFor(pose, joint) — 아이템 보정 없이 관절 기준 (EF 와 같음)
    const sc = this.core.scale, tf = (v) => [ (M[0] * v[0] + M[4] * v[1] + M[8] * v[2] + M[12]) * sc + mv[0], (M[1] * v[0] + M[5] * v[1] + M[9] * v[2] + M[13]) * sc + mv[1], (M[2] * v[0] + M[6] * v[1] + M[10] * v[2] + M[14]) * sc + mv[2] ];
    return [tf(m.s), tf(m.e)];
  }
  updateTrails() {
    if (!this.trailObjs) this.trailObjs = [];
    this.trailObjs.forEach(t => t.visible = false);
    const cs = this.curSel; if (!cs || this.state.mode !== 'combat') return;
    const { sel, x } = cs, tl = sel.tl;
    const clipAt = (tick) => { if (tick <= 0) return 0; const k = Math.floor(tick); return k >= tl.length - 1 ? tl[tl.length - 1] : tl[k] + (tl[k + 1] - tl[k]) * (tick - k); };
    let used = 0;
    for (const hand of ['main', 'off']) for (const m of this.trailFor(sel, hand)) {
      // 틱마다 interpolateCount*2 개 모서리, 각 모서리는 life 틱 동안 살아 있음. 시작 전·끝 뒤에는 새로 안 만듦(끝나면 life 동안 사라짐)
      const steps = m.n * 2, edges = [];
      const from = Math.max(0, x - m.life);
      for (let k = Math.floor(from * steps); k <= Math.floor(x * steps); k++) {
        const tick = k / steps; if (tick < from) continue;
        const ct = clipAt(tick);
        if (ct <= m.t0 || ct > m.t1 + 1e-6) continue;
        const e = this.trailEdgePos(sel, ct, m, hand); if (e) edges.push({ e, age: x - tick });
      }
      if (edges.length < 2) continue;
      let obj = this.trailObjs[used];
      if (!obj) {
        const g = new THREE.BufferGeometry();
        obj = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, vertexColors: true }));
        obj.frustumCulled = false; this.world.parent.add(obj); this.trailObjs[used] = obj;
      }
      used++;
      const tex = this.texture('t:' + m.tex, this.core.trailTex[m.tex]);
      if (obj.material.map !== tex) { obj.material.map = tex; if (tex) { tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; } obj.material.needsUpdate = true; }
      const pos = [], uv = [], col = [];
      const N = edges.length - 1;
      for (let i = 0; i < N; i++) {
        const a = edges[i], b = edges[i + 1];
        const fa = i / N, fb = (i + 1) / N;                 // 오래된 쪽 0 -> 새 쪽 1 (AbstractTrailParticle: u = from..to, alpha = clamp(u))
        const quad = [[a.e[0], fa, 1], [a.e[1], fa, 0], [b.e[1], fb, 0], [b.e[0], fb, 1]];
        [0, 1, 2, 0, 2, 3].forEach(q => { const [p, u, v] = quad[q]; pos.push(p[0], p[1], p[2]); uv.push(u, v); col.push(m.r, m.g, m.b, Math.min(1, Math.max(0, u))); });
      }
      obj.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      obj.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      obj.geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
      obj.visible = true;
    }
  }
  apply(fr) {
    if (!fr) return;
    this.body.update(fr.S);
    for (const k in this.armorMeshes) this.armorMeshes[k].meshes.forEach(m => m.update(fr.S));
    const sc = this.core.scale;
    for (const h of ['main', 'off']) {
      const o = this.heldObjs[h]; if (!o) continue;
      if (o.skin) { const act = this.skinSet(o, fr), S2 = this.skinS(o, fr); for (const k in o.skin.sets) o.skin.sets[k].forEach(m => { m.mesh.visible = k === act && !!S2; if (k === act && S2) m.update(S2); }); continue; }
      const M = fr.hand[h];
      if (!M) { o.obj.visible = false; continue; }
      o.obj.visible = true;
      const sm = new THREE.Matrix4().makeScale(sc, sc, sc);
      const m = new THREE.Matrix4().fromArray(M);
      o.obj.matrix.identity();
      o.obj.children.forEach(ch => {
        const j = ch.userData.joint;
        ch.matrix.copy(sm).multiply(j >= 0 && fr.W ? new THREE.Matrix4().fromArray(fr.W[j]) : m);
      });
    }
    this.world.position.set(fr.move[0], fr.move[1], fr.move[2]);
    this.updateTrails();
  }
  // 스킨 메시 무기: 어느 메시를 그릴지 (디컴파일 11-13)
  //  야마토(RenderYamato_DMC.isUseMesh2): 지금 동작이 지정 33개 중 하나면 mesh2(뽑은 칼), 아니면 mesh1(칼집)
  //  무라사마(칼집 NBT murasama_sheath)·팔시온(FALCHION_BLESS 효과)은 위키의 기본 상태 = mesh1
  // 스킨 행렬: 아이템 전용 뼈대면 같은 포즈(관절 이름 기준)를 그 뼈대로 풀어 씀 (armature.setPose(animator.getPose))
  skinS(o, fr) {
    if (!o.skin.rig) return fr.S;
    if (!fr.pose) return null;
    return o.skin.rig.solve(fr.pose).S;
  }
  skinSet(o, fr) {
    const S = o.skin.sets;
    if (o.skin.alt === 'yamato' && S.b && fr && fr.anim && (this.core.yamatoMesh2 || []).includes(fr.anim)) return 'b';
    return S.a ? 'a' : null;
  }
  // 동작 전체(모든 프레임)를 돌려서 몸·갑옷·손 물건이 차지하는 상자
  computeBox() {
    const box = new THREE.Box3(), v = new THREE.Vector3();
    const len = this.cur ? this.cur.len : 1, n = Math.max(12, Math.min(90, Math.ceil(len * 20)));
    const sc = this.core.scale;
    const meshes = [this.body]; for (const k in this.armorMeshes) meshes.push(...this.armorMeshes[k].meshes);
    for (let i = 0; i <= n; i++) {
      const fr = this.frame(len * i / n); if (!fr) continue;
      const all = meshes.slice();
      for (const h of ['main', 'off']) { const o = this.heldObjs[h]; if (o && o.skin) { const s = o.skin.sets[this.skinSet(o, fr)], S2 = this.skinS(o, fr); if (s && S2) all.push([s[0], S2]); } }
      for (const mm of all) {
        const m = Array.isArray(mm) ? mm[0] : mm, SS = Array.isArray(mm) ? mm[1] : fr.S;
        const tmp = new Float32Array(m.vpos.length * 3);
        m.skin(SS, tmp, null);
        for (let k = 0; k < tmp.length; k += 3) if (tmp[k] === tmp[k]) box.expandByPoint(v.set(tmp[k] * sc + fr.move[0], tmp[k + 1] * sc + fr.move[1], tmp[k + 2] * sc + fr.move[2]));
      }
      for (const h of ['main', 'off']) {
        const o = this.heldObjs[h]; if (!o || o.skin || !fr.hand[h]) continue;
        for (const ch of o.obj.children) {
        const M = ch.userData.joint >= 0 && fr.W ? fr.W[ch.userData.joint] : fr.hand[h];
        for (const p of ch.userData.pts) {
          const x = M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], y = M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], z = M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14];
          box.expandByPoint(v.set(x * sc + fr.move[0], y * sc + fr.move[1], z * sc + fr.move[2]));
        }
        }
      }
    }
    this.box = box;
  }
  // 상자 8 꼭짓점이 모두 화면 안에 들어오는 거리 (세로·가로 시야 둘 다)
  fit(force) {
    if (!this.box || this.box.isEmpty()) return;
    if (!force && this.userMoved) return;
    this.userMoved = false;
    const c = this.box.getCenter(new THREE.Vector3());
    const dir = new THREE.Vector3(-0.55, 0.28, -1).normalize();          // 앞(-z) 왼쪽 위에서 비스듬히
    const cam = this.camera;
    const vf = THREE.MathUtils.degToRad(cam.fov) / 2, hf = Math.atan(Math.tan(vf) * cam.aspect);
    const corners = [];
    for (const x of [this.box.min.x, this.box.max.x]) for (const y of [this.box.min.y, this.box.max.y]) for (const z of [this.box.min.z, this.box.max.z]) corners.push(new THREE.Vector3(x, y, z));
    // 카메라 축
    const fwd = dir.clone().negate(), right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize(), up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    let dist = 0.5;
    for (const p of corners) {
      const d = p.clone().sub(c);
      const along = d.dot(fwd), sx = Math.abs(d.dot(right)), sy = Math.abs(d.dot(up));
      dist = Math.max(dist, sx / Math.tan(hf) - along, sy / Math.tan(vf) - along);
    }
    dist *= 1.3;
    cam.position.copy(c).addScaledVector(dir, dist);
    cam.near = Math.max(0.01, dist / 100); cam.far = dist * 10; cam.updateProjectionMatrix();
    cam.lookAt(c);
    this.controls.target.copy(c); this.controls.update();
  }
  loop() {
    let last = performance.now();
    const tick = (now) => {
      requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      if (this.$('.wp-body').hidden && !this.isFull) return;
      if (this.state.playing) this.state.t += dt;
      this.apply(this.frame(this.state.t));
      if (this.controls.enabled) this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    requestAnimationFrame(tick);
  }
  // ---------------- 전체화면 + 자유 시점
  fullscreen() {
    const el = this.root;
    if (document.fullscreenElement || document.webkitFullscreenElement) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) req.call(el).catch(() => this.fakeFull(true)); else this.fakeFull(!this.isFull);
  }
  fakeFull(on) { this.root.classList.toggle('wp-full', on); this.isFull = on; this.onFull(true); }
  onFull(fake) {
    const on = fake ? this.isFull : !!(document.fullscreenElement === this.root || document.webkitFullscreenElement === this.root);
    if (!fake) this.isFull = on;
    this.root.classList.toggle('wp-is-full', on);
    this.$('.wp-hint').hidden = !on && !!this.userMoved;
    this.$('.wp-hint').textContent = '끌기: 이동 · R 누른 채 끌기: 회전 · 휠: 확대 / 터치: 한 손가락 회전 · 두 손가락 이동·확대' + (on ? ' · Esc 로 나가기' : '');
    this.$('[data-a="full"]').textContent = on ? '나가기' : '전체화면';
    setTimeout(() => { this.resize(); this.fit(true); }, 50);
    if (fake && on) { this._esc = this._esc || ((e) => { if (e.key === 'Escape' && this.isFull) this.fakeFull(false); }); document.addEventListener('keydown', this._esc); }
  }
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

export function mountWearPreview(el, opts) {
  const wp = new WearPreview(el, opts);
  let open = false; try { open = localStorage.getItem('wp.open') === '1'; } catch (e) {}
  if (open) wp.toggle(true);
  return wp;
}
