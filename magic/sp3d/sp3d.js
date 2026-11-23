// 3D 마법 미리보기 (2026-11-15, 마법 위키 제작 세션)
// 게임이 실제로 그린 정점(spelldump: 주문 엔티티·파티클·시전자 레이어)을 틱마다 다시 그림. 데이터 = build_sp3d.py.
// 좌표는 마인크래프트 그대로(오른손, y 위). 원점 = 시전 순간 플레이어 발.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ---- Luxium blackhole.fsh 원문 (GLSL 150 -> three GLSL3: #version 줄과 InSize/OutSize(미사용) 만 뺌, 수학은 그대로)
const BH_FS = `

uniform sampler2D DiffuseSampler;
uniform sampler2D DepthSampler;
uniform mat4 ViewProj;
uniform mat4 InverseViewProj;
uniform vec3 CameraPos;
uniform vec3 SphereCenter;
uniform float SphereRadius;
uniform float Intensity;

in vec2 texCoord;
out highp vec4 fragColor;


const float PI = 3.14159265359;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i); float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0)); float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
    float value = 0.0; float amplitude = 0.5; float frequency = 1.0;
    for(int i = 0; i < 5; i++) { value += amplitude * noise(p * frequency); frequency *= 2.0; amplitude *= 0.5; }
    return value;
}
float turbulence(vec2 p) {
    float t = 0.0; float scale = 1.0;
    for(int i = 0; i < 4; i++) { t += abs(noise(p * scale)) / scale; scale *= 2.0; }
    return t;
}
vec4 getDiskTexture(vec2 uv, float distNorm, float radialDist) {
    float angle = uv.x * 2.0 * PI; float rad = uv.y;
    float rotation = angle + rad * 3.0; vec2 p = vec2(cos(rotation), sin(rotation)) * rad * 10.0;
    float baseNoise = fbm(p); float detail = turbulence(p * 2.0) * 0.5;
    float swirls = sin(angle * 8.0 + rad * 12.0 + baseNoise * 2.0) * 0.5 + 0.5;
    float pattern = baseNoise * 0.6 + detail * 0.3 + swirls * 0.1;
    float temp = 1.0 - smoothstep(0.0, 0.6, rad); temp = pow(temp, 0.7);
    float brightness = pattern * 0.4 + 0.6; brightness *= (1.0 + sin(angle * 15.0 + rad * 20.0) * 0.15);
    vec3 col;
    if (temp > 0.85) col = mix(vec3(1.0, 0.95, 0.8), vec3(1.2, 1.2, 1.3), (temp - 0.85) / 0.15);
    else if (temp > 0.6) col = mix(vec3(1.0, 0.8, 0.3), vec3(1.0, 0.95, 0.8), (temp - 0.6) / 0.25);
    else if (temp > 0.3) col = mix(vec3(1.0, 0.4, 0.1), vec3(1.0, 0.8, 0.3), (temp - 0.3) / 0.3);
    else col = mix(vec3(0.6, 0.1, 0.0), vec3(1.0, 0.4, 0.1), temp / 0.3);
    col *= brightness;
    float innerGlow = exp(-rad * 8.0) * 2.0; col += vec3(1.0, 0.9, 0.7) * innerGlow;
    float edgeFade = smoothstep(1.0, 0.7, rad);

    return vec4(col * edgeFade, edgeFade);
}

void main() {
    if (Intensity <= 0.001) {
        fragColor = texture(DiffuseSampler, texCoord);
        return;
    }

    vec4 ndcFar = vec4(texCoord * 2.0 - 1.0, 1.0, 1.0);
    vec4 relFar = InverseViewProj * ndcFar;
    vec3 rayDir = normalize(relFar.xyz / relFar.w);

    float sceneDepth = texture(DepthSampler, texCoord).r;
    bool isSky = sceneDepth > 0.99999;

    vec4 sceneClip = vec4(texCoord * 2.0 - 1.0, sceneDepth * 2.0 - 1.0, 1.0);
    vec4 sceneRel = InverseViewProj * sceneClip;
    float sceneDist = length(sceneRel.xyz / sceneRel.w);

    float Rs = SphereRadius;
    float M = Rs * 0.5;
    vec3 bh = vec3(0.0);
    vec3 eye = CameraPos - SphereCenter;

    float r_inner = Rs * 1.5;
    float r_outer = Rs * 5.0;
    vec3 disc_n = vec3(0.0, 1.0, 0.0);
    vec3 disc_s = vec3(1.0, 0.0, 0.0);

    vec3 h2e = eye - bh;
    float l2_h2e = dot(h2e, h2e);
    float rm = length(cross(rayDir, h2e));
    float t_cp = sqrt(max(0.0, l2_h2e - rm * rm));

    float frontInfluenceDist = t_cp - (Rs * 10.0);

    vec2 distortedUV = texCoord;
    if (rm > Rs) {
         vec3 cp = eye + rayDir * t_cp;
         vec3 toCenter = normalize(-cp);
         float deflection = (4.0 * M) / rm;

         vec3 bentRay = normalize(rayDir + toCenter * deflection);

         vec3 relSamplePos = rayDir * t_cp + bentRay * max(100.0, Rs * 8.0);
         vec4 clipSpace = ViewProj * vec4(relSamplePos, 1.0);
         vec2 newUV = (clipSpace.xy / max(clipSpace.w, 1e-5)) * 0.5 + 0.5;

         float influence = smoothstep(0.0, 10.0 * Rs, rm);
         if (isSky || sceneDist > frontInfluenceDist) {
             distortedUV = mix(texCoord, newUV, 0.8 * Intensity * (1.0 - influence));
         }
    }

    vec4 bgColor = texture(DiffuseSampler, distortedUV);

    float warpDepth = texture(DepthSampler, distortedUV).r;
    if (warpDepth < 0.99999) {
        vec4 wClip = vec4(distortedUV * 2.0 - 1.0, warpDepth * 2.0 - 1.0, 1.0);
        vec4 wRel = InverseViewProj * wClip;
        float warpDist = length(wRel.xyz / wRel.w);
        if (warpDist < frontInfluenceDist) {
            bgColor = texture(DiffuseSampler, texCoord);
        }
    }

    if (rm < Rs) {
        float horizonDist = t_cp - sqrt(Rs*Rs - rm*rm);
        if (!isSky && sceneDist < horizonDist) {
            fragColor = texture(DiffuseSampler, texCoord);
            return;
        }
        fragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    vec4 diskColorAccum = vec4(0.0);
    float alpha_ray = 4.0 * M / rm;
    float tan_a_2 = tan(alpha_ray * 0.5);

    vec3 cp = eye + rayDir * t_cp;
    vec3 coord_origin = cp + rayDir * (rm * tan_a_2);

    vec3 x_axis = normalize(bh - coord_origin);
    vec3 y_axis = normalize(rayDir + tan_a_2 * normalize(bh - cp));
    vec3 z_axis = cross(x_axis, y_axis);

    float c = length(bh - coord_origin);
    float k = tan_a_2;
    vec3 iline_r = normalize(cross(z_axis, disc_n));

    float x1 = -1.0, x2 = -1.0, y1, y2;
    float k2 = k*k; float b_val2 = c*c / (1.0 + k2); float a2 = k2 * b_val2;
    float denom = dot(x_axis, iline_r);

    if (abs(denom) > 0.0001) {
        float slope = dot(y_axis, iline_r) / denom;
        float k2_slope = slope * slope;
        float A = a2 * k2_slope - b_val2; float B = -2.0 * a2 * k2_slope * c;
        float C = a2 * (k2_slope * c * c + b_val2); float delta = B*B - 4.0*A*C;
        if (delta >= 0.0) {
            float sqrtDelta = sqrt(delta);
            x1 = (-B - sqrtDelta) / (2.0 * A); x2 = (-B + sqrtDelta) / (2.0 * A);
            y1 = slope * (x1 - c); y2 = slope * (x2 - c);
        }
    }

    float yeye = dot(eye - coord_origin, y_axis);

    vec3 p1 = coord_origin + x1 * x_axis + y1 * y_axis;
    float d1 = length(p1 - bh);
    if (x1 >= 0.0 && y1 >= yeye && d1 >= r_inner && d1 <= r_outer) {
        float distToP1 = length(p1 - eye);
        if (isSky || sceneDist > distToP1) {
            float u = atan(dot(p1, disc_s), dot(p1, cross(disc_s, disc_n))) / (2.0 * PI);
            float v = (d1 - r_inner) / (r_outer - r_inner);
            vec4 col = getDiskTexture(vec2(u, v), d1, d1);
            float innerFade = smoothstep(r_inner, r_inner + Rs*0.5, d1);
            float outerFade = smoothstep(r_outer, r_outer - Rs*0.8, d1);
            diskColorAccum += col * (innerFade * outerFade) * Intensity * 1.5;
        }
    }

    vec3 p2 = coord_origin + x2 * x_axis + y2 * y_axis;
    float d2 = length(p2 - bh);
    if (x2 >= 0.0 && y2 >= yeye && d2 >= r_inner && d2 <= r_outer) {
        float distToP2 = length(p2 - eye);
        if (isSky || sceneDist > distToP2) {
            float u = atan(dot(p2, disc_s), dot(p2, cross(disc_s, disc_n))) / (2.0 * PI);
            float v = (d2 - r_inner) / (r_outer - r_inner);
            vec4 col = getDiskTexture(vec2(u, v), d2, d2);
            float innerFade = smoothstep(r_inner, r_inner + Rs*0.5, d2);
            float outerFade = smoothstep(r_outer, r_outer - Rs*0.8, d2);
            diskColorAccum += col * (innerFade * outerFade) * Intensity * 1.2;
        }
    }

    float distToCenter = rm / Rs;
    float diskProximity = smoothstep(r_inner, r_outer, distToCenter * Rs);
    float diskGlow = exp(-abs(distToCenter - 2.5) * 0.8) * Intensity * diskProximity;
    vec3 glowColor = vec3(1.0, 0.8, 0.5) * diskGlow * 0.4;

    vec3 finalColor = bgColor.rgb;
    finalColor += diskColorAccum.rgb;

    float diskBrightness = dot(diskColorAccum.rgb, vec3(0.299, 0.587, 0.114));
    if (diskBrightness > 0.01) {
        vec3 bloomAccum = vec3(0.0);
        float bloomWeight = 0.0;
        float bloomRadius = 0.08 * Intensity;
        for (int i = 0; i < 16; i++) {
            float angle = float(i) * 6.28318 / 16.0;
            vec2 offset = vec2(cos(angle), sin(angle)) * bloomRadius;
            float weight = exp(-length(offset) * 8.0);
            bloomAccum += diskColorAccum.rgb * weight;
            bloomWeight += weight;
        }
        if (bloomWeight > 0.0) finalColor += (bloomAccum / bloomWeight) * diskBrightness * 0.8;
    }

    finalColor += glowColor;
    if (diskBrightness > 0.5) {
        float strongGlow = (diskBrightness - 0.5) * 2.0;
        vec3 glowSpread = diskColorAccum.rgb * strongGlow * 0.6;
        for (int i = 0; i < 8; i++) {
            float angle = float(i) * 0.785398;
            vec2 offset = vec2(cos(angle), sin(angle)) * 0.05;
            finalColor += glowSpread * exp(-length(offset) * 12.0) * 0.15;
        }
    }

    finalColor = finalColor / (1.0 + finalColor * 0.12);
    finalColor *= 0.75 + 0.25 * smoothstep(0.8, 0.4, length(texCoord - vec2(0.5)));

    fragColor = vec4(finalColor, 1.0);
}
`;

const CSS = `
.sp3d-ov{position:fixed;inset:0;z-index:9000;background:#0d0c0a;display:flex;flex-direction:column;font-family:'IBM Plex Sans KR','IBM Plex Sans',sans-serif;color:#e8e2d0}
.sp3d-top{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #3a352b;flex-wrap:wrap}
.sp3d-top .t{font-weight:600;font-size:15px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sp3d-top button,.sp3d-bar button{background:#1d1b17;color:#e8e2d0;border:1px solid #4a4436;padding:5px 11px;font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.sp3d-top button:hover,.sp3d-bar button:hover{border-color:#c8a35a}
.sp3d-cv{flex:1;position:relative;min-height:0}
.sp3d-cv canvas{display:block;width:100%;height:100%;touch-action:none}
.sp3d-msg{position:absolute;left:12px;top:10px;font-size:12px;color:#a49c86;pointer-events:none;line-height:1.6}
.sp3d-bar{display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid #3a352b;flex-wrap:wrap}
.sp3d-bar input[type=range]{flex:1;min-width:140px;accent-color:#c8a35a}
.sp3d-bar .tm{font-variant-numeric:tabular-nums;font-size:13px;min-width:92px;text-align:right}
.sp3d-bar select{background:#1d1b17;color:#e8e2d0;border:1px solid #4a4436;font:inherit;font-size:13px;padding:4px}
`;

async function loadData(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error('불러오기 실패 ' + r.status);
  const b64 = (await r.text()).trim();
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const ds = new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip')));
  return JSON.parse(await ds.text());
}

function material(tex, blend) {
  const m = new THREE.MeshBasicMaterial({ map: tex || null, vertexColors: true, side: THREE.DoubleSide });
  if (blend === 'add') { m.transparent = true; m.blending = THREE.AdditiveBlending; m.depthWrite = false; }
  else if (blend === 'alpha') { m.transparent = true; m.depthWrite = false; m.alphaTest = 0.004; }
  else { m.alphaTest = 0.1; }
  return m;
}

// 메시 v = [x,y,z,u,v,r,g,b,a]*n, per = 4(사각) 또는 3
function geometry(v, per) {
  const n = v.length / 9, pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    pos.set([v[i * 9], v[i * 9 + 1], v[i * 9 + 2]], i * 3);
    uv.set([v[i * 9 + 3], v[i * 9 + 4]], i * 2);
    col.set([v[i * 9 + 5] / 255, v[i * 9 + 6] / 255, v[i * 9 + 7] / 255, v[i * 9 + 8] / 255], i * 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  if (per === 4) { const idx = []; for (let q = 0; q + 3 < n; q += 4) idx.push(q, q + 1, q + 2, q, q + 2, q + 3); g.setIndex(idx); }
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------- 플레이어 모델 (바닐라 PlayerModel, 1.20.1 디컴파일)
// 스킨 그림 -> 64x64 캔버스 (착용 미리보기 wear_preview.js processSkin 과 같음: 64x32 옛 스킨은 왼쪽 팔다리 복사)
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
  let slimGuess = !legacy; if (!legacy) { for (let y = 20; y < 32 && slimGuess; y++) for (let x = 54; x < 56; x++) if (A[(y * 64 + x) * 4 + 3] !== 0) { slimGuess = false; break; } }
  c._slimGuess = slimGuess;   // 슬림 스킨은 오른팔 바깥 열(54..55, 20..31)이 비어 있음 (추정일 뿐, 버튼으로 바꿈)
  noAlpha(0, 0, 32, 16);
  if (legacy) notch(32, 0, 64, 32);
  noAlpha(0, 16, 64, 32);
  noAlpha(16, 48, 48, 64);
  g.putImageData(d, 0, 0);
  return c;
}

// ModelPart.Cube 그대로 (모델 픽셀 단위, y 아래쪽). 꼭짓점·면·UV 는 Cube 생성자 바이트코드에서 옮김.
// 면 = [꼭짓점 4개, minU, minV, maxU, maxV, 밝기]; 꼭짓점 k 의 UV = (maxU,minV),(minU,minV),(minU,maxV),(maxU,maxV)
function boxGeo(ox, oy, oz, w, h, d, u, v, g) {
  const x0 = ox - g, y0 = oy - g, z0 = oz - g, x1 = ox + w + g, y1 = oy + h + g, z1 = oz + d + g;
  const V = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const u1 = u + d, u2 = u + d + w, u3 = u + d + w + w, u4 = u + d + w + d, u5 = u + 2 * d + 2 * w, v1 = v + d, v2 = v + d + h;
  const F = [[[5, 4, 0, 1], u1, v, u2, v1, 1], [[2, 3, 7, 6], u2, v1, u3, v, 0.5], [[0, 4, 7, 3], u, v1, u1, v2, 0.6],
    [[1, 0, 3, 2], u1, v1, u2, v2, 0.8], [[5, 1, 2, 6], u2, v1, u4, v2, 0.6], [[4, 5, 6, 7], u4, v1, u5, v2, 0.8]];
  const pos = [], uv = [], col = [], idx = [];
  for (const [vi, mnU, mnV, mxU, mxV, sh] of F) {
    const q = [[mxU, mnV], [mnU, mnV], [mnU, mxV], [mxU, mxV]], b = pos.length / 3;
    vi.forEach((k, j) => { pos.push(...V[k]); uv.push(q[j][0] / 64, q[j][1] / 64); col.push(sh, sh, sh); });
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

// van 순서 = [머리, 몸, 오른팔, 왼팔, 오른다리, 왼다리], 각 [x,y,z(피벗 px), xRot,yRot,zRot(라디안)]
const VAN_DEF = [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [-5, 2, 0, 0, 0, 0], [5, 2, 0, 0, 0, 0], [-1.9, 12, 0, 0, 0, 0], [1.9, 12, 0, 0, 0, 0]];
function makePlayer(map, slim) {
  // 변환 = 엔티티 위치 · Y(180-몸통yaw) · scale(-1,-1,1) · translate(0,-1.501,0) · 1/16 · 부위(이동 후 Z·Y·X 회전)
  const root = new THREE.Group(); root.rotation.order = 'YXZ';   // Ry·Rz: 죽음 쓰러짐(몸 앞쪽 z 축 회전)은 몸통 yaw 다음에 적용
  const flip = new THREE.Group(), off = new THREE.Group(), sc = new THREE.Group();
  flip.scale.set(-0.9375, -0.9375, 0.9375);   // PlayerRenderer.m_7546_ 의 0.9375 배 (리뷰)
  off.position.y = -1.501; sc.scale.setScalar(1 / 16);
  root.add(flip); flip.add(off); off.add(sc);
  const mat = new THREE.MeshBasicMaterial({ map, vertexColors: true, side: THREE.DoubleSide, alphaTest: 0.5 });
  // 11-16b 피격 겹침: 바닐라 OverlayTexture hurt = mix(빨강, 원색, 0.7) = 0.7*원색 + 0.3*빨강 (감마 값 그대로 섞음; 이 뷰어는 색 변환 없음). 이 인물의 재질에만 적용 -> 시전자 재질과 무관
  const hurtU = { value: 0 };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uHurt = hurtU;
    sh.fragmentShader = 'uniform float uHurt;\n' + sh.fragmentShader.replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.0, 0.0), uHurt);');
  };
  mat.customProgramCacheKey = () => 'sp3d-hurt';
  const geos = [], aw = slim ? 3 : 4;
  const mk = (pv, ox, oy, oz, w, h, d, u, v, g) => { const ge = boxGeo(ox, oy, oz, w, h, d, u, v, g); geos.push(ge); pv.add(new THREE.Mesh(ge, mat)); };
  const parts = [0, 1, 2, 3, 4, 5].map(() => { const pv = new THREE.Object3D(); sc.add(pv); return pv; });
  mk(parts[0], -4, -8, -4, 8, 8, 8, 0, 0, 0); mk(parts[0], -4, -8, -4, 8, 8, 8, 32, 0, 0.5);          // 머리 · 모자
  mk(parts[1], -4, 0, -2, 8, 12, 4, 16, 16, 0); mk(parts[1], -4, 0, -2, 8, 12, 4, 16, 32, 0.25);      // 몸 · 재킷
  mk(parts[2], slim ? -2 : -3, -2, -2, aw, 12, 4, 40, 16, 0); mk(parts[2], slim ? -2 : -3, -2, -2, aw, 12, 4, 40, 32, 0.25);   // 오른팔 · 소매
  mk(parts[3], -1, -2, -2, aw, 12, 4, 32, 48, 0); mk(parts[3], -1, -2, -2, aw, 12, 4, 48, 48, 0.25); // 왼팔 · 소매
  mk(parts[4], -2, 0, -2, 4, 12, 4, 0, 16, 0); mk(parts[4], -2, 0, -2, 4, 12, 4, 0, 32, 0.25);        // 오른다리 · 바지
  mk(parts[5], -2, 0, -2, 4, 12, 4, 16, 48, 0); mk(parts[5], -2, 0, -2, 4, 12, 4, 0, 48, 0.25);       // 왼다리 · 바지
  return {
    root, map,
    // 슬림 팔은 모델 정의 피벗 y 가 2.5 (바닐라 PlayerModel 슬림) — 기록은 넓은 팔(2)이라 0.5 더함
    pose(van) {
      parts.forEach((pv, i) => {
        const a = van ? van.slice(i * 6, i * 6 + 6) : VAN_DEF[i];
        pv.position.set(a[0], a[1] /* van 팔 y 는 setupAnim 최종값(슬림도 같음, 리뷰) */, a[2]);
        pv.rotation.set(a[3], a[4], a[5], 'ZYX');   // joml rotationZYX(z,y,x) = Rz·Ry·Rx (ModelPart.m_104299_ 바이트코드)
      });
    },
    // fallDeg = 바닐라 setupRotations 의 죽음 쓰러짐(몸 z 축 회전 각도)
    place(x, y, z, bodyYawDeg, fallDeg) { root.position.set(x, y, z); root.rotation.y = (180 - bodyYawDeg) * Math.PI / 180; root.rotation.z = (fallDeg || 0) * Math.PI / 180; },
    // 피격 붉은 겹침(바닐라 OverlayTexture: 색 = 원색*0.7 + (0.3,0,0)). 재질 색 곱셈으로 근사(이 인물의 재질만 바뀜)
    hurt(on) { hurtU.value = on ? 0.3 : 0; },
    dispose() { geos.forEach(g => g.dispose()); mat.dispose(); if (map) map.dispose(); },
  };
}

export async function openSpell3D(url, opts = {}) {
  if (!document.getElementById('sp3d-css')) { const st = document.createElement('style'); st.id = 'sp3d-css'; st.textContent = CSS; document.head.appendChild(st); }
  const ov = document.createElement('div'); ov.className = 'sp3d-ov'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', '3D 마법 미리보기');
  ov.innerHTML = `<div class="sp3d-top"><span class="t">${opts.title || '3D 마법 미리보기'}</span>
      <button type="button" data-a="skin">스킨 넣기</button><button type="button" data-a="slim" aria-pressed="false">팔: 넓음</button><button type="button" data-a="defskin">기본 스킨</button><input type="file" accept="image/png" hidden data-a="skinfile">
      <button type="button" data-a="reset">시점 처음으로</button><button type="button" data-a="close">닫기 (Esc)</button></div>
    <div class="sp3d-cv"><div class="sp3d-msg">불러오는 중…</div></div>
    <div class="sp3d-bar"><button type="button" data-a="play">❚❚ 멈춤</button><input type="range" min="0" value="0" step="1" aria-label="시간"><span class="tm">0.00초</span>
      <select aria-label="재생 속도"><option value="0.25">0.25배</option><option value="0.5">0.5배</option><option value="1" selected>1배</option><option value="2">2배</option></select>
      <button type="button" data-a="loop" aria-pressed="true">반복 켬</button></div>`;
  document.body.appendChild(ov);
  const cvWrap = ov.querySelector('.sp3d-cv'), msg = ov.querySelector('.sp3d-msg'), slider = ov.querySelector('input[type=range]'), tm = ov.querySelector('.tm');
  const btnPlay = ov.querySelector('[data-a=play]'), btnLoop = ov.querySelector('[data-a=loop]'), sel = ov.querySelector('select');

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.info.autoReset = false;   // 후처리는 render 를 여러 번 부르므로 그림마다 직접 초기화(drawView)
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // 게임과 같이 감마 값을 그대로 화면에 씀(three 기본 sRGB 출력은 밝게 바꿔 버림)
  // 출력이 Linear(감마 그대로)라 hex 색을 sRGB→선형으로 바꾸면 더 어두워짐 -> hex 를 그대로 쓰게 LinearSRGB 로 읽음 (리뷰)
  const HEX = h => new THREE.Color().setHex(h, THREE.LinearSRGBColorSpace);
  renderer.setClearColor(HEX(0x1a1814));
  cvWrap.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 400);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  let alive = true, raf = 0;
  // ---- Luxium 블랙홀 화면 후처리 (게임 blackhole.fsh 그대로). lx 가 있는 프레임에서만 쓰이고, 없으면 renderer.render 만.
  const post = { A: null, ping: [null, null], quad: null, mat: null, scn: null, cam: null };
  const postSize = () => {
    const sz = renderer.getDrawingBufferSize(new THREE.Vector2());
    for (const t of [post.A, post.ping[0], post.ping[1]]) if (t) t.setSize(sz.x, sz.y);
  };
  const mkRT = (depth) => {
    const sz = renderer.getDrawingBufferSize(new THREE.Vector2());
    const t = new THREE.WebGLRenderTarget(sz.x, sz.y, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true, samples: depth ? 4 : 0 });
    t.texture.colorSpace = THREE.NoColorSpace;
    if (depth) { t.depthTexture = new THREE.DepthTexture(sz.x, sz.y); t.depthTexture.type = THREE.UnsignedIntType; }
    return t;
  };
  const postInit = () => {
    if (post.mat) return;
    post.A = mkRT(true);
    post.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    post.scn = new THREE.Scene();
    post.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: {
        DiffuseSampler: { value: null }, DepthSampler: { value: null },
        ViewProj: { value: new THREE.Matrix4() }, InverseViewProj: { value: new THREE.Matrix4() },
        CameraPos: { value: new THREE.Vector3() }, SphereCenter: { value: new THREE.Vector3() },
        SphereRadius: { value: 1 }, Intensity: { value: 1 },
      },
      vertexShader: 'out vec2 texCoord;\nvoid main(){ texCoord = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: BH_FS,
    });
    post.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), post.mat); post.quad.frustumCulled = false;
    post.scn.add(post.quad);
  };
  const postDispose = () => {
    for (const t of [post.A, post.ping[0], post.ping[1]]) if (t) { if (t.depthTexture) t.depthTexture.dispose(); t.dispose(); }
    if (post.quad) post.quad.geometry.dispose();
    if (post.mat) post.mat.dispose();
    post.A = post.ping[0] = post.ping[1] = post.mat = post.quad = null;
  };
  // 게임의 ViewProj = 투영 * (카메라 상대 좌표용 뷰: 이동 없는 회전만)
  const drawView = (lx) => {
    renderer.info.reset();
    if (!lx || !lx.length) { renderer.render(scene, camera); return; }
    postInit();
    camera.updateMatrixWorld();
    renderer.setRenderTarget(post.A); renderer.render(scene, camera);
    const vp = new THREE.Matrix4().extractRotation(camera.matrixWorldInverse).premultiply(camera.projectionMatrix);
    const ivp = vp.clone().invert();
    const u = post.mat.uniforms;
    u.ViewProj.value.copy(vp); u.InverseViewProj.value.copy(ivp); u.CameraPos.value.copy(camera.position);
    u.DepthSampler.value = post.A.depthTexture;
    let src = post.A.texture;
    lx.forEach((b, i) => {
      const last = i === lx.length - 1;
      u.DiffuseSampler.value = src; u.SphereCenter.value.set(b[0], b[1], b[2]); u.SphereRadius.value = b[3]; u.Intensity.value = b[4];
      let dst = null;
      if (!last) { const k = i % 2; if (!post.ping[k]) post.ping[k] = mkRT(false); dst = post.ping[k]; }
      renderer.setRenderTarget(dst); renderer.render(post.scn, post.cam);
      if (dst) src = dst.texture;
    });
    renderer.setRenderTarget(null);
  };
  const resize = () => { const w = cvWrap.clientWidth, h = cvWrap.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); postSize(); };
  const ro = new ResizeObserver(resize); ro.observe(cvWrap); resize();
  const close = () => { alive = false; cancelAnimationFrame(raf); ro.disconnect(); document.removeEventListener('keydown', onKey, true); disposeAll(); ov.remove(); };
  // 만든 geometry·material·texture 를 모두 해제(여러 번 열고 닫아도 쌓이지 않게). 이 함수들은 데이터 로드 뒤에 채워짐
  const disposeList = [];
  const disposeAll = () => {
    for (const d of disposeList) { try { d.dispose(); } catch (e) {} }
    disposeList.length = 0;
    scene.traverse(o => { if (o.geometry) o.geometry.dispose(); const m = o.material; if (m) (Array.isArray(m) ? m : [m]).forEach(x => { if (x.map) x.map.dispose(); x.dispose(); }); });
    controls.dispose();
    postDispose();
    renderer.dispose(); renderer.forceContextLoss();
  };
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } else if (e.key === ' ' && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); togglePlay(); } };
  document.addEventListener('keydown', onKey, true);
  ov.querySelector('[data-a=close]').addEventListener('click', close);

  let D;
  try { D = await loadData(url); } catch (e) { msg.textContent = '데이터를 불러오지 못했습니다: ' + e.message; return; }
  if (!alive) return;

  // 시전자 = 사용자 스킨(없으면 steve/alex) + 게임 기록 동작, 표적 = 히로빈
  const loader = new THREE.TextureLoader();
  const mkTex = src => {
    const tex = typeof src === 'string' ? loader.load(src) : new THREE.CanvasTexture(src);
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.flipY = false; tex.colorSpace = THREE.NoColorSpace;
    if (typeof src !== 'string') tex.needsUpdate = true;
    return tex;
  };
  const skinUrl = f => new URL(f, import.meta.url).href;
  const btnSlim = ov.querySelector('[data-a=slim]'), btnDef = ov.querySelector('[data-a=defskin]'), fileIn = ov.querySelector('[data-a=skinfile]');
  let userSkin = null, slim = false;   // userSkin = {canvas, png, slim}; 'wp-skin' = 착용 미리보기와 같은 저장 키
  try {
    const sv = JSON.parse(localStorage.getItem('wp-skin') || 'null');
    if (sv && sv.png) {
      const c = await new Promise(res => { const im = new Image(); im.onload = () => res(processSkin(im)); im.onerror = () => res(null); im.src = sv.png; });
      if (c) { userSkin = { canvas: c, png: sv.png, slim: !!sv.slim }; slim = userSkin.slim; }
    }
  } catch (e) {}
  if (!alive) return;
  const saveSkin = () => { try { if (userSkin) localStorage.setItem('wp-skin', JSON.stringify({ png: userSkin.png, slim: userSkin.slim })); else localStorage.removeItem('wp-skin'); } catch (e) {} };
  let curFrame = -1, caster = null;
  const buildCaster = () => {
    if (caster) { scene.remove(caster.root); caster.dispose(); }
    caster = makePlayer(mkTex(userSkin ? userSkin.canvas : skinUrl(slim ? 'alex.png' : 'steve.png')), slim);
    scene.add(caster.root);
    btnSlim.textContent = slim ? '팔: 슬림' : '팔: 넓음'; btnSlim.setAttribute('aria-pressed', String(slim));
    if (curFrame >= 0) showFrame(curFrame);
  };
  let targetFig = null;
  if (D.tg) { targetFig = makePlayer(mkTex(skinUrl('herobrine.png')), false); targetFig.pose(null); scene.add(targetFig.root); }
  buildCaster();
  ov.querySelector('[data-a=skin]').addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', () => {
    const f = fileIn.files && fileIn.files[0]; fileIn.value = ''; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const im = new Image();
      im.onload = () => {
        const c = processSkin(im);
        if (!c) { msg.textContent = `스킨은 가로 64, 세로 64 또는 32 픽셀이어야 합니다 (이 파일 ${im.width}×${im.height}).`; return; }
        slim = !!c._slimGuess; userSkin = { canvas: c, png: rd.result, slim }; saveSkin(); buildCaster(); setMsg();
      };
      im.onerror = () => { msg.textContent = '그림 파일을 읽지 못했습니다.'; };
      im.src = rd.result;
    };
    rd.readAsDataURL(f);
  });
  btnSlim.addEventListener('click', () => { slim = !slim; if (userSkin) { userSkin.slim = slim; saveSkin(); } buildCaster(); });
  btnDef.addEventListener('click', () => { userSkin = null; slim = false; saveSkin(); buildCaster(); });

  // 바닥
  const grid = new THREE.GridHelper(48, 48, HEX(0x4a4436), HEX(0x2c2923)); scene.add(grid);

  // 텍스처·재질
  const texs = [];   // dispose 목록용
  const mats = D.tex.map(t => {
    let tex = null;
    if (t.uri) { tex = loader.load(t.uri); tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.flipY = false; tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.NoColorSpace; texs.push(tex); disposeList.push(tex); }   // 게임은 감마 공간에서 텍스처×꼭짓점색을 곱함: 변환 없이(NoColorSpace) 그대로 곱하고 출력도 선형(아래)으로 둠
    const mt = material(tex, t.blend); disposeList.push(mt); return mt;
  });

  // 메시 풀 (같은 모양은 geometry 공유)
  const geos = [], pool = new Map(), shown = [];
  const meshGeo = i => geos[i] || (geos[i] = geometry(D.meshes[i].v, D.meshes[i].per));
  const take = (i, used) => {
    let arr = pool.get(i); if (!arr) pool.set(i, arr = []);
    const k = used.get(i) || 0; used.set(i, k + 1);
    if (!arr[k]) { arr[k] = new THREE.Mesh(meshGeo(i), mats[D.meshes[i].t] || mats[0]); scene.add(arr[k]); }
    return arr[k];
  };

  // 파티클: 텍스처마다 동적 사각형 묶음, 매 그림마다 뷰어 카메라를 보게 다시 세움(게임과 같은 빌보드 + roll)
  const pBatches = new Map();
  const batch = ti => {
    let b = pBatches.get(ti);
    if (!b) {
      const g = new THREE.BufferGeometry();
      b = { g, cap: 0, mesh: new THREE.Mesh(g, mats[ti] || mats[0]) };
      b.mesh.frustumCulled = false; scene.add(b.mesh); pBatches.set(ti, b);
    }
    return b;
  };
  const grow = (b, n) => {
    if (n <= b.cap) return;
    b.cap = Math.max(n, b.cap * 2, 64);
    b.g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.cap * 12), 3));
    b.g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(b.cap * 8), 2));
    b.g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(b.cap * 16), 4));
    const idx = new Uint32Array(b.cap * 6); for (let q = 0; q < b.cap; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
    b.g.setIndex(new THREE.BufferAttribute(idx, 1));
  };
  const L = new THREE.Vector3(), U = new THREE.Vector3();
  const CORN = [[-1, -1], [-1, 1], [1, 1], [1, -1]];
  function drawParticles(list) {
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    L.set(-e[0], -e[1], -e[2]); U.set(e[4], e[5], e[6]);   // 게임 카메라 국소 x = 왼쪽, y = 위
    const by = new Map();
    for (const p of list) { (by.get(p[0]) || by.set(p[0], []).get(p[0])).push(p); }
    for (const [ti, b] of pBatches) if (!by.has(ti)) b.g.setDrawRange(0, 0);
    for (const [ti, arr] of by) {
      const b = batch(ti); grow(b, arr.length);
      const P = b.g.attributes.position.array, UV = b.g.attributes.uv.array, C = b.g.attributes.color.array;
      arr.forEach((p, q) => {
        const [, x, y, z, h, u0, v0, u2, v2, r, g, bl, a, roll] = p;
        const cs = Math.cos(roll), sn = Math.sin(roll);
        const uv = [[u0, v0], [u0, v2], [u2, v2], [u2, v0]];
        for (let k = 0; k < 4; k++) {
          const lx = CORN[k][0] * cs - CORN[k][1] * sn, ly = CORN[k][0] * sn + CORN[k][1] * cs;
          const o = (q * 4 + k);
          P[o * 3] = x + h * (lx * L.x + ly * U.x); P[o * 3 + 1] = y + h * (lx * L.y + ly * U.y); P[o * 3 + 2] = z + h * (lx * L.z + ly * U.z);
          UV[o * 2] = uv[k][0]; UV[o * 2 + 1] = uv[k][1];
          C[o * 4] = r / 255; C[o * 4 + 1] = g / 255; C[o * 4 + 2] = bl / 255; C[o * 4 + 3] = a / 255;
        }
      });
      b.g.attributes.position.needsUpdate = b.g.attributes.uv.needsUpdate = b.g.attributes.color.needsUpdate = true;
      b.g.setDrawRange(0, arr.length * 6);
    }
  }

  const fallMat = new THREE.MeshBasicMaterial({ color: 0x8a7f6a });
  disposeList.push(fallMat);
  const fallGeo = new THREE.BoxGeometry(1, 1, 1); disposeList.push(fallGeo); const fallPool = [];
  function showFrame(fi) {
    const fr = D.f[fi]; if (!fr) return;
    for (const m of shown) m.visible = false;
    shown.length = 0;
    const used = new Map();
    const put = (i, x, y, z) => { const m = take(i, used); m.position.set(x, y, z); m.visible = true; shown.push(m); };
    for (const [x, y, z, ms] of fr.e) for (const i of ms) put(i, x, y, z);
    for (const i of fr.c) put(i, fr.me[0], fr.me[1], fr.me[2]);
    for (const i of fr.pr) put(i, 0, 0, 0);
    // 표적 (v2: 프레임마다 tg=[x,y,z,yaw], th 피격, td 죽음, tv 보임, tc 추가 레이어. 옛 기록은 최상위 tg 고정)
    const tgf = fr.tg || D.tg, tvis = fr.tv !== 0;
    if (tgf && fr.tc && tvis) for (const i of fr.tc) put(i, tgf[0], tgf[1], tgf[2]);
    (fr.fb || []).forEach((b, k) => { const m = fallPool[k] || (fallPool[k] = (() => { const x = new THREE.Mesh(fallGeo, fallMat); scene.add(x); return x; })()); m.position.set(b[1], b[2] + 0.5, b[3]); m.visible = true; shown.push(m); });
    // 시전자: 기록한 바닐라 6부위 + 몸통 yaw (바닐라 머리 yRot = headYaw - bodyYaw 이므로 bodyYaw = viewYaw - 머리 yRot)
    const van = fr.van && fr.van.length >= 36 ? fr.van : null;
    caster.pose(van); caster.place(fr.me[0], fr.me[1], fr.me[2], fr.me[3] - (van ? van[4] * 180 / Math.PI : 0));
    if (targetFig && tgf) {
      targetFig.root.visible = tvis;
      let yaw;
      if (tgf.length >= 4) yaw = tgf[3];
      else { const dx = fr.me[0] - tgf[0], dz = fr.me[2] - tgf[2]; yaw = (dx || dz) ? Math.atan2(-dx, dz) * 180 / Math.PI : 0; }   // yaw 없으면 시전자를 바라봄
      const td = fr.td || 0, th = fr.th || 0;
      // LivingEntityRenderer.setupRotations: deathTime>0 이면 min(1, sqrt((td+pt-1)/20*1.6)) * 90° (pt 는 틱 중간 0.5 로 둠)
      const fall = td > 0 ? Math.min(1, Math.sqrt(Math.max(0, (td - 0.5) / 20 * 1.6))) * 90 : 0;
      targetFig.hurt(th > 0 || td > 0);   // 바닐라: hurtTime>0 또는 deathTime>0 이면 붉은 겹침
      targetFig.place(tgf[0], tgf[1], tgf[2], yaw, fall);
    }
    curFrame = fi;
    slider.value = fi; tm.textContent = (fi / 20).toFixed(2) + '초 / ' + ((D.f.length - 1) / 20).toFixed(2) + '초';
  }

  // 기록 전체(엔티티·파티클·시전자·표적·덮개 위치)의 상자를 구해 화면에 맞춤. 원점에서 40칸 넘게 먼 점은 상자에서 뺌(너무 멀리 생긴 효과 때문에 작아지지 않게)
  function bounds() {
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9], CAP = 40;
    const add = (x, y, z) => {
      if (!isFinite(x + y + z) || Math.abs(x) > CAP || Math.abs(y) > CAP || Math.abs(z) > CAP) return;
      if (x < lo[0]) lo[0] = x; if (y < lo[1]) lo[1] = y; if (z < lo[2]) lo[2] = z;
      if (x > hi[0]) hi[0] = x; if (y > hi[1]) hi[1] = y; if (z > hi[2]) hi[2] = z;
    };
    if (D.tg) add(D.tg[0], D.tg[1], D.tg[2]);
    for (const fr of D.f) {
      add(fr.me[0], fr.me[1], fr.me[2]); add(fr.me[0], fr.me[1] + 1.8, fr.me[2]);
      const t = fr.tg || D.tg; if (t && fr.tv !== 0) { add(t[0], t[1], t[2]); add(t[0], t[1] + 1.8, t[2]); }
      for (const e of fr.e) add(e[0], e[1], e[2]);
      for (const q of fr.p) add(q[1], q[2], q[3]);
    }
    if (lo[0] > hi[0]) return null;
    return { lo, hi };
  }
  function resetView() {
    const c = D.cam;   // 덤프 때 게임 카메라 위치(원점 기준)
    const bb = bounds();
    let ctr, rad;
    if (bb) {
      ctr = new THREE.Vector3((bb.lo[0] + bb.hi[0]) / 2, (bb.lo[1] + bb.hi[1]) / 2, (bb.lo[2] + bb.hi[2]) / 2);
      rad = Math.hypot(bb.hi[0] - bb.lo[0], bb.hi[1] - bb.lo[1], bb.hi[2] - bb.lo[2]) / 2;
    } else { ctr = new THREE.Vector3(0, 1, 0); rad = 2; }
    rad = Math.max(rad, 1.5);
    const dir = new THREE.Vector3(c[0], c[1], c[2]).sub(ctr);
    if (dir.length() < 0.5) dir.set(0, 0.4, 1);
    dir.normalize();
    const vf = camera.fov * Math.PI / 180, hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
    const dist = Math.min(90, Math.max(6, rad * 1.15 / Math.sin(Math.min(vf, hf) / 2)));
    camera.position.copy(ctr).addScaledVector(dir, dist); controls.target.copy(ctr); controls.update();
  }

  slider.max = D.f.length - 1;
  let playing = true, loop = true, t0 = performance.now(), base = 0;
  const speed = () => parseFloat(sel.value) || 1;
  function togglePlay() { playing = !playing; btnPlay.textContent = playing ? '❚❚ 멈춤' : '▶ 재생'; base = curFrame; t0 = performance.now(); if (playing && curFrame >= D.f.length - 1) base = 0; }
  btnPlay.addEventListener('click', togglePlay);
  btnLoop.addEventListener('click', () => { loop = !loop; btnLoop.textContent = loop ? '반복 켬' : '반복 끔'; btnLoop.setAttribute('aria-pressed', String(loop)); });
  sel.addEventListener('change', () => { base = curFrame; t0 = performance.now(); });
  slider.addEventListener('input', () => { base = parseInt(slider.value, 10); t0 = performance.now(); showFrame(base); });
  ov.querySelector('[data-a=reset]').addEventListener('click', resetView);
  resetView();
  const setMsg = () => { msg.innerHTML = `레벨 ${D.level} · 게임에서 기록한 실제 효과 · 시전자 = 게임에서 기록한 실제 동작${D.tg ? ', 표적 = 히로빈' : ''}<br>끌기: 회전 · 오른쪽 끌기: 이동 · 휠: 확대`; };
  setMsg();

  function frame() {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    if (playing) {
      let fi = base + Math.floor((performance.now() - t0) / 50 * speed());
      if (fi >= D.f.length) { if (loop) { base = 0; t0 = performance.now(); fi = 0; } else { fi = D.f.length - 1; togglePlay(); } }
      if (fi !== curFrame) showFrame(fi);
    }
    controls.update();
    drawParticles(D.f[curFrame]?.p || []);
    drawView(D.f[curFrame]?.lx);
  }
  showFrame(0);
  frame();
  // 검사용
  window.__sp3d = { D, scene, camera, renderer, mats, showFrame, get frame() { return curFrame; }, close,
    renderAt(fi) { if (playing) togglePlay(); showFrame(fi); controls.update(); drawParticles(D.f[fi].p); drawView(D.f[fi].lx); return { ...renderer.info.render }; } };
}
