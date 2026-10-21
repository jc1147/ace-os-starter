/* GLSL for the 3D brain. Plain strings; three.js r160 adds the GLSL3 prefix (texture2D, varying, gl_FragColor are mapped). */
window.BRAIN_SHADERS = (function () {
  'use strict';
  // every fibre is NP points; per vertex: u (0..1 along the fibre), fibre index, colour (type of the nearer end).
  // per fibre (float textures): state = (alpha, highlight, birth time, present); pulse = (start, signed speed, colour index, strength)
  const fibreVert = [
    'attribute float aU; attribute float aFib; attribute vec3 aCol;',
    'uniform sampler2D tState; uniform sampler2D tPulse; uniform vec2 uTex; uniform float uNear; uniform float uFar;',
    'varying float vU; varying vec3 vCol; varying vec4 vState; varying vec4 vPulse; varying float vFade;',
    'void main(){',
    '  vec2 tuv = vec2((mod(aFib, uTex.x) + 0.5) / uTex.x, (floor(aFib / uTex.x) + 0.5) / uTex.y);',
    '  vState = texture2D(tState, tuv); vPulse = texture2D(tPulse, tuv);',
    '  vU = aU; vCol = aCol;',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  vFade = 1.0 - 0.62 * smoothstep(uNear, uFar, -mv.z);',
    '  gl_Position = projectionMatrix * mv;',
    '}',
  ].join('\n');
  const fibreFrag = [
    'uniform float uTime; uniform vec3 uPC[7];',
    'varying float vU; varying vec3 vCol; varying vec4 vState; varying vec4 vPulse; varying float vFade;',
    'vec3 pcol(float k){ if(k<0.5) return uPC[0]; if(k<1.5) return uPC[1]; if(k<2.5) return uPC[2]; if(k<3.5) return uPC[3]; if(k<4.5) return uPC[4]; if(k<5.5) return uPC[5]; return uPC[6]; }',
    'void main(){',
    '  if (vState.a < 0.01) discard;',
    '  if (vState.b > 0.0) { float prog = (uTime - vState.b) / 0.9; if (vU > prog) discard; }',
    '  float a = vState.r * vFade;',
    '  vec3 c = mix(vCol, vec3(1.0), vState.g * 0.35) * a;',
    '  if (vPulse.w > 0.0) {',
    '    float age = uTime - vPulse.x;',
    '    if (age > 0.0) {',
    '      float uu = vPulse.y > 0.0 ? vU : 1.0 - vU;',
    '      float d = age * abs(vPulse.y) - uu;',
    '      if (d > -0.03 && d < 0.32) {',
    '        float tail = d < 0.0 ? 0.0 : pow(1.0 - d / 0.32, 2.2);',
    '        float head = exp(-d * d * 2600.0);',
    '        vec3 pc = pcol(vPulse.z);',
    '        c += mix(pc, vec3(1.0), head * 0.4) * vPulse.w * (tail * 1.1 + head * 2.2) * (0.45 + 0.55 * vFade);',
    '      }',
    '    }',
    '  }',
    '  gl_FragColor = vec4(c, 1.0);',
    '}',
  ].join('\n');

  // beads: glowing points, flash on fire, the core breathes
  const nodeVert = [
    'attribute vec3 aCol; attribute float aSize; attribute float aAlpha; attribute vec2 aFlash; attribute vec3 aFlashCol; attribute float aBreath;',
    'uniform float uPx; uniform float uTime; uniform float uNear; uniform float uFar;',
    'varying vec3 vCol; varying float vA; varying float vF; varying vec3 vFC; varying float vFade;',
    'void main(){',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  float age = uTime - aFlash.x; float f = age >= 0.0 ? aFlash.y * exp(-age * 2.4) : 0.0;',
    '  float br = 1.0 + aBreath * (0.16 * sin(uTime * 1.3) + 0.05 * sin(uTime * 3.1));',
    '  vFade = 1.0 - 0.55 * smoothstep(uNear, uFar, -mv.z);',
    '  gl_PointSize = aAlpha < 0.01 ? 0.0 : clamp(aSize * br * (1.0 + f * 0.9) * uPx / (-mv.z), 1.5, 320.0);',
    '  gl_Position = projectionMatrix * mv;',
    '  vCol = aCol; vA = aAlpha; vF = f; vFC = aFlashCol;',
    '}',
  ].join('\n');
  const nodeFrag = [
    'varying vec3 vCol; varying float vA; varying float vF; varying vec3 vFC; varying float vFade;',
    'void main(){',
    '  vec2 d = gl_PointCoord - 0.5; float r = length(d); if (r > 0.5) discard;',
    '  float core = smoothstep(0.085, 0.0, r);',
    '  float disk = smoothstep(0.15, 0.085, r);',
    '  float halo = pow(max(0.0, 1.0 - r * 2.0), 2.6) * 0.5;',
    '  float fl = clamp(vF, 0.0, 1.0);',
    '  vec3 c = mix(vCol, vec3(1.0), disk * 0.22 + core * 0.6);',
    '  c = mix(c, vFC * 1.25, fl * 0.85);',
    '  float a = (disk * 0.95 + halo * (1.0 + fl * 1.3) + core * 0.6 * (1.0 - fl * 0.5)) * vA * vFade;',
    '  gl_FragColor = vec4(c * a, 1.0);',
    '}',
  ].join('\n');

  // sparks: the bright heads of pulses (positions written per frame)
  const sparkVert = [
    'attribute vec3 aCol; attribute float aA; attribute float aSize;',
    'uniform float uPx; uniform float uNear; uniform float uFar;',
    'varying vec3 vCol; varying float vA;',
    'void main(){',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  float fade = 1.0 - 0.5 * smoothstep(uNear, uFar, -mv.z);',
    '  gl_PointSize = aA < 0.003 ? 0.0 : clamp(aSize * uPx / (-mv.z), 2.0, 200.0);',
    '  gl_Position = projectionMatrix * mv; vCol = aCol; vA = aA * fade;',
    '}',
  ].join('\n');
  const sparkFrag = [
    'varying vec3 vCol; varying float vA;',
    'void main(){',
    '  vec2 d = gl_PointCoord - 0.5; float r = length(d); if (r > 0.5) discard;',
    '  float core = smoothstep(0.12, 0.0, r); float halo = pow(max(0.0, 1.0 - r * 2.0), 2.2);',
    '  vec3 c = mix(vCol, vec3(1.0), core * 0.8);',
    '  gl_FragColor = vec4(c * (core * 1.2 + halo * 0.55) * vA, 1.0);',
    '}',
  ].join('\n');

  // ripples: an expanding ring where a note fires
  const rippleVert = [
    'attribute float aStart; attribute vec3 aCol; attribute float aStr;',
    'uniform float uPx; uniform float uTime;',
    'varying vec3 vCol; varying float vAge; varying float vStr;',
    'void main(){',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  float age = uTime - aStart; vAge = age; vStr = aStr; vCol = aCol;',
    '  float sz = (3.0 + age * 22.0) * (0.6 + 0.4 * aStr);',
    '  gl_PointSize = (age < 0.0 || age > 1.3) ? 0.0 : clamp(sz * uPx / (-mv.z), 2.0, 480.0);',
    '  gl_Position = projectionMatrix * mv;',
    '}',
  ].join('\n');
  const rippleFrag = [
    'varying vec3 vCol; varying float vAge; varying float vStr;',
    'void main(){',
    '  vec2 d = gl_PointCoord - 0.5; float r = length(d); if (r > 0.5) discard;',
    '  float k = 1.0 - clamp(vAge / 1.3, 0.0, 1.0);',
    '  float ring = smoothstep(0.05, 0.0, abs(r - 0.43)) + smoothstep(0.12, 0.0, abs(r - 0.40)) * 0.35;',
    '  gl_FragColor = vec4(mix(vCol, vec3(1.0), 0.25) * ring * k * k * vStr, 1.0);',
    '}',
  ].join('\n');

  // marks: thin rings around pinned / hovered / matched notes
  const markVert = [
    'attribute vec3 aCol; attribute float aSize;',
    'uniform float uPx; uniform float uTime;',
    'varying vec3 vCol;',
    'void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vCol = aCol;',
    '  gl_PointSize = aSize <= 0.0 ? 0.0 : clamp(aSize * (1.0 + 0.04 * sin(uTime * 3.0)) * uPx / (-mv.z), 12.0, 160.0);',
    '  gl_Position = projectionMatrix * mv; }',
  ].join('\n');
  const markFrag = [
    'varying vec3 vCol;',
    'void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d); if (r > 0.5) discard;',
    '  float a = smoothstep(0.045, 0.0, abs(r - 0.40)) * 0.95 + smoothstep(0.5, 0.25, r) * 0.06;',
    '  gl_FragColor = vec4(vCol * a, 1.0); }',
  ].join('\n');

  // the rim band: per lobe a flat ribbon plus an upright ribbon, glowing across its width
  const bandVert = [
    'attribute float aV; attribute float aLobe; attribute vec3 aCol;',
    'uniform float uHi[48]; uniform float uNear; uniform float uFar;',
    'varying float vV; varying float vH; varying float vFade; varying vec3 vC;',
    'void main(){',
    '  vV = aV; vC = aCol; int li = int(aLobe + 0.5); vH = aLobe < -0.5 ? -1.0 : uHi[li];',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  vFade = 1.0 - 0.55 * smoothstep(uNear, uFar, -mv.z);',
    '  gl_Position = projectionMatrix * mv;',
    '}',
  ].join('\n');
  const bandFrag = [
    'varying float vV; varying float vH; varying float vFade; varying vec3 vC;',
    'void main(){',
    '  float g = exp(-vV * vV * 3.2);',
    '  vec3 base = vC;', // per lobe: the section colour (the band's violet when the lobes are clusters)
    '  vec3 c;',
    '  if (vH < -0.5) c = base * 0.07 * g;',
    '  else c = mix(base * 0.30, mix(base, vec3(1.0), 0.4) * 1.05, vH) * (g * 0.8 + pow(g, 6.0) * 0.6);',
    '  gl_FragColor = vec4(c * vFade, 1.0);',
    '}',
  ].join('\n');

  const lineVert = 'attribute vec3 aCol; varying vec3 vCol; uniform float uNear; uniform float uFar; varying float vFade; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vFade = 1.0 - 0.6 * smoothstep(uNear, uFar, -mv.z); vCol = aCol; gl_Position = projectionMatrix * mv; }';
  const lineFrag = 'varying vec3 vCol; varying float vFade; void main(){ gl_FragColor = vec4(vCol * vFade, 1.0); }';

  const starVert = 'attribute float aA; attribute float aS; varying float vA; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vA = aA; gl_PointSize = aS; gl_Position = projectionMatrix * mv; }';
  const starFrag = 'varying float vA; void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d); if (r > 0.5) discard; gl_FragColor = vec4(vec3(0.78, 0.72, 0.95) * vA * smoothstep(0.5, 0.0, r), 1.0); }';

  // post: downsample (2x2 box, optional soft threshold), separable 9-tap gaussian, composite
  const quadVert = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  const downFrag = [
    'uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThr; varying vec2 vUv;',
    'void main(){',
    '  vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0.5, -0.5)).rgb',
    '         + texture2D(tSrc, vUv + uTexel * vec2(-0.5, 0.5)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0.5, 0.5)).rgb;',
    '  c *= 0.25;',
    '  if (uThr > 0.0) { float l = max(c.r, max(c.g, c.b)); c *= smoothstep(uThr, uThr * 7.0, l); }',
    '  gl_FragColor = vec4(c, 1.0);',
    '}',
  ].join('\n');
  const blurFrag = [
    'uniform sampler2D tSrc; uniform vec2 uDir; varying vec2 vUv;',
    'void main(){',
    '  vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270270;',
    '  c += (texture2D(tSrc, vUv + uDir * 1.3846153846).rgb + texture2D(tSrc, vUv - uDir * 1.3846153846).rgb) * 0.3162162162;',
    '  c += (texture2D(tSrc, vUv + uDir * 3.2307692308).rgb + texture2D(tSrc, vUv - uDir * 3.2307692308).rgb) * 0.0702702703;',
    '  gl_FragColor = vec4(c, 1.0);',
    '}',
  ].join('\n');
  const compFrag = [
    'uniform sampler2D tMain; uniform sampler2D tB1; uniform sampler2D tB2; uniform float uB1; uniform float uB2; varying vec2 vUv;',
    'void main(){',
    '  vec3 c = texture2D(tMain, vUv).rgb + texture2D(tB1, vUv).rgb * uB1 + texture2D(tB2, vUv).rgb * uB2;',
    '  c = 1.0 - exp(-c * 1.18);',
    '  float a = clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0);',
    '  gl_FragColor = vec4(c, a);',
    '}',
  ].join('\n');

  return { fibreVert, fibreFrag, nodeVert, nodeFrag, sparkVert, sparkFrag, rippleVert, rippleFrag, markVert, markFrag, bandVert, bandFrag, lineVert, lineFrag, starVert, starFrag, quadVert, downFrag, blurFrag, compFrag };
})();
