/* =====================================================================
   HELI · 三维海图世界（three.js 全局构建，无模块无打包）
   ---------------------------------------------------------------------
   1 世界单位 = 1 km。节点坐标来自 coords.csv（对题目距离矩阵做 MDS 得到，
   平均相对误差 0.5%），所以图上量出来的距离基本就是题目给的距离。
   海岸线是一条解析曲线，海面着色器与陆地高程共用同一条，因此海陆边界严丝合缝。
   ===================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------- 地形函数 */
  const AP_FLAT = [];                 // [{x,z}] 机场附近压平成海滨平原
  const AP_ELEV = 8.2;

  function coastZ(x) {
    return 35 - 0.4376 * x
      + 26 * Math.sin(x * 0.0125)
      + 13 * Math.sin(x * 0.031 + 1.7)
      + 6 * Math.sin(x * 0.077 + 0.5);
  }
  const COAST_GLSL = `
    float coastZ(float x){
      return 35.0 - 0.4376*x
        + 26.0*sin(x*0.0125)
        + 13.0*sin(x*0.031 + 1.7)
        + 6.0*sin(x*0.077 + 0.5);
    }`;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

  function shoreProfile(s) { return -12 + 26 * smoothstep(-40, 30, s); }
  function hash2(x, y) { const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return h - Math.floor(h); }
  function vnoise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    return lerp(lerp(hash2(ix, iy), hash2(ix + 1, iy), u),
      lerp(hash2(ix, iy + 1), hash2(ix + 1, iy + 1), u), v);
  }
  function fbm(x, y) { let a = 0.5, f = 1, s = 0; for (let i = 0; i < 4; i++) { s += a * vnoise(x * f, y * f); f *= 2.07; a *= 0.5; } return s; }

  function terrainH(x, z) {
    const s = coastZ(x) - z;
    let h = shoreProfile(s);
    if (s > 10) h += smoothstep(10, 115, s) * (4 + 44 * fbm(x * 0.0082 + 11, z * 0.0082 + 7));
    for (const a of AP_FLAT) {
      const w = 1 - smoothstep(13, 38, Math.hypot(x - a.x, z - a.z));
      if (w > 0) h = lerp(h, AP_ELEV, w);
    }
    return h;
  }

  /* ==================================================================== */
  global.HeliWorld = function (canvas, opts) {
    const THREE = global.THREE;
    const H = global.HELI;
    const D = H.data;
    opts = opts || {};

    const nodeIds = Object.keys(D.nodes);
    const facIds = nodeIds.filter(n => D.nodes[n].k === 'F');
    const apIds = nodeIds.filter(n => D.nodes[n].k === 'A');
    const NODEPOS = {};
    for (const n of nodeIds) NODEPOS[n] = new THREE.Vector3(D.nodes[n].x, 0, -D.nodes[n].y);
    AP_FLAT.length = 0;
    for (const n of apIds) AP_FLAT.push({ x: NODEPOS[n].x, z: NODEPOS[n].z });

    const W = {
      camDist: 560, iconScale: 1.8, night: 0, sunElev: 0.6,
      layers: { routes: true, labels: true, weather: true, ships: true },
      hover: null, selected: null, follow: null, activeCount: 0,
    };

    /* ------------------------------------------------ 渲染器 / 场景 */
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setClearColor(0x0d1e33, 1);
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x0d1e33, 0.00062);
    const camera = new THREE.PerspectiveCamera(44, 1, 0.5, 6500);

    /* ------------------------------------------------ 相机 */
    const HOME = { tx: 70, tz: 170, dist: 640, theta: Math.PI * 0.5, phi: 0.96 };
    const cam = {
      target: new THREE.Vector3(HOME.tx, 0, HOME.tz),
      tTarget: new THREE.Vector3(HOME.tx, 0, HOME.tz),
      dist: 980, tDist: HOME.dist,
      theta: HOME.theta - 0.45, tTheta: HOME.theta,
      phi: 0.58, tPhi: HOME.phi,
    };
    const MINPHI = 0.12, MAXPHI = 1.48;

    function applyCam() {
      cam.theta += (cam.tTheta - cam.theta) * 0.12;
      cam.phi += (cam.tPhi - cam.phi) * 0.12;
      cam.dist += (cam.tDist - cam.dist) * 0.10;
      cam.target.lerp(cam.tTarget, 0.12);
      const sp = Math.sin(cam.phi), cp = Math.cos(cam.phi);
      camera.position.set(
        cam.target.x + cam.dist * sp * Math.cos(cam.theta),
        Math.max(6, cam.target.y + cam.dist * cp),
        cam.target.z + cam.dist * sp * Math.sin(cam.theta));
      camera.lookAt(cam.target);
      W.camDist = cam.dist;
      W.iconScale = clamp(cam.dist / 300, 0.5, 2.8);
    }

    /* ------------------------------------------------ 交互 */
    let drag = null, moved = 0, lastPinch = 0;
    const ptrs = new Map();
    canvas.style.cursor = 'grab';
    canvas.addEventListener('pointerdown', e => {
      try { canvas.setPointerCapture(e.pointerId); } catch (_) { }
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 1) { drag = { x: e.clientX, y: e.clientY, btn: e.button, sx: e.clientX, sy: e.clientY }; moved = 0; }
      canvas.style.cursor = 'grabbing';
    });
    canvas.addEventListener('pointermove', e => {
      const p = ptrs.get(e.pointerId);
      if (p) { p.x = e.clientX; p.y = e.clientY; }
      if (ptrs.size >= 2) { pinch(); return; }
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX; drag.y = e.clientY;
        moved += Math.abs(dx) + Math.abs(dy);
        if (drag.btn === 2 || drag.btn === 1 || e.shiftKey) panBy(dx, dy);
        else {
          cam.tTheta -= dx * 0.0042;
          cam.tPhi = clamp(cam.tPhi - dy * 0.0034, MINPHI, MAXPHI);
          W.follow = null;
        }
      } else hoverAt(e.clientX, e.clientY);
    });
    function endPtr(e) {
      ptrs.delete(e.pointerId);
      if (ptrs.size === 0) {
        if (drag && moved < 7) clickAt(drag.sx, drag.sy);
        drag = null; lastPinch = 0;
        canvas.style.cursor = W.hover ? 'pointer' : 'grab';
      }
    }
    canvas.addEventListener('pointerup', endPtr);
    canvas.addEventListener('pointercancel', endPtr);
    canvas.addEventListener('pointerleave', () => { W.hover = null; if (opts.onHover) opts.onHover(null); });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const k = 1 + clamp(e.deltaY * 0.0016, -0.3, 0.3);
      cam.tDist = clamp(cam.tDist * k, 24, 1600);
      W.follow = null;
    }, { passive: false });

    function pinch() {
      const a = [...ptrs.values()];
      const d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
      if (lastPinch) cam.tDist = clamp(cam.tDist * (lastPinch / d), 24, 1600);
      lastPinch = d;
      W.follow = null;
    }
    function panBy(dx, dy) {
      const k = cam.dist * 0.0018, c = Math.cos(cam.theta), s = Math.sin(cam.theta);
      cam.tTarget.x = clamp(cam.tTarget.x + (-s * dx + c * dy) * k, -540, 760);
      cam.tTarget.z = clamp(cam.tTarget.z + (c * dx + s * dy) * k, -280, 560);
      W.follow = null;
    }

    /* ------------------------------------------------ 光 */
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    scene.add(sun);
    const hemi = new THREE.HemisphereLight(0x8fc4ff, 0x0a1524, 0.6);
    scene.add(hemi);
    const ambient = new THREE.AmbientLight(0x22334d, 0.45);
    scene.add(ambient);

    /* ------------------------------------------------ 天空 */
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x2a6fd0) },
        uHor: { value: new THREE.Color(0xa9d4f5) },
        uSun: { value: new THREE.Vector3(0, 1, 0) },
        uSunC: { value: new THREE.Color(0xfff2d0) },
        uNight: { value: 0 },
      },
      vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `
        varying vec3 vP; uniform vec3 uTop,uHor,uSun,uSunC; uniform float uNight;
        float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.545); }
        void main(){
          vec3 d = normalize(vP);
          float t = clamp(d.y*1.3+0.05, 0.0, 1.0);
          vec3 c = mix(uHor, uTop, pow(t, 0.62));
          float sd = max(dot(d, normalize(uSun)), 0.0);
          c += uSunC * pow(sd, 340.0) * 2.4;
          c += uSunC * pow(sd, 7.0) * 0.26 * (1.0 - uNight*0.8);
          c += uSunC * pow(sd, 2.0) * 0.09;
          if(uNight > 0.02){
            vec2 g = floor(d.xz * 420.0 + d.y * 160.0);
            float s = h21(g);
            float star = smoothstep(0.9968, 0.99975, s) * smoothstep(-0.02, 0.30, d.y);
            c += vec3(0.82,0.90,1.0) * star * uNight * 2.4;
          }
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(3400, 40, 24), skyMat);
    sky.frustumCulled = false;
    scene.add(sky);

    /* ------------------------------------------------ 海 */
    const SEA = { x0: -1000, x1: 1150, z0: -680, z1: 800 };
    const seaGeo = new THREE.PlaneGeometry(SEA.x1 - SEA.x0, SEA.z1 - SEA.z0, 200, 145);
    seaGeo.rotateX(-Math.PI / 2);
    seaGeo.translate((SEA.x0 + SEA.x1) / 2, 0, (SEA.z0 + SEA.z1) / 2);
    const seaMat = new THREE.ShaderMaterial({
      fog: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 }, uNight: { value: 0 },
          uSun: { value: new THREE.Vector3(0, 1, 0) },
          uSunC: { value: new THREE.Color(0xfff0cf) },
          uDeep: { value: new THREE.Color(0x082b49) },
          uShallow: { value: new THREE.Color(0x1f8fa8) },
          uCam: { value: new THREE.Vector3() },
        }]),
      vertexShader: `
        varying vec3 vW; varying float vS; uniform float uTime;
        #include <fog_pars_vertex>
        ${COAST_GLSL}
        void main(){
          vec3 p = position;
          float s = coastZ(p.x) - p.z;
          vS = s;
          float sw = sin(p.x*0.021 + uTime*0.29)*0.13
                   + sin(p.z*0.017 - uTime*0.23)*0.11
                   + sin((p.x+p.z)*0.0083 + uTime*0.16)*0.16;
          p.y += sw * smoothstep(-8.0, -70.0, s);
          vW = p;
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        varying vec3 vW; varying float vS;
        uniform float uTime,uNight; uniform vec3 uSun,uSunC,uDeep,uShallow,uCam;
        #include <fog_pars_fragment>
        float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.545); }
        float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(h21(i),h21(i+vec2(1.,0.)),f.x), mix(h21(i+vec2(0.,1.)),h21(i+vec2(1.,1.)),f.x), f.y); }
        void main(){
          vec2 q = vW.xz; float t = uTime;
          // 五组解析行波：高度与梯度一起算出来，比逐点采样 fbm 便宜一个数量级
          const vec2 D0 = vec2(0.9439, 0.3303);
          const vec2 D1 = vec2(-0.5547, 0.8321);
          const vec2 D2 = vec2(0.7071, -0.7071);
          const vec2 D3 = vec2(-0.9806, -0.1961);
          const vec2 D4 = vec2(0.2425, 0.9701);
          float dcam = length(uCam - vW);
          float lod = 1.0 - smoothstep(240.0, 780.0, dcam);   // 远处收掉高频，免得闪烁
          float h = 0.0; vec2 g = vec2(0.0);
          // 振幅再被一层极慢的大尺度噪声调制，打散正弦的周期感
          float mod1 = 0.55 + 0.75*vn(q*0.0042 + vec2(t*0.006, -t*0.004));
          float p0 = dot(q,D0)*0.100 + t*0.62; h += 1.00*sin(p0); g += 1.00*cos(p0)*0.100*D0;
          float p1 = dot(q,D1)*0.190 - t*0.48; h += 0.55*sin(p1); g += 0.55*cos(p1)*0.190*D1;
          float p2 = dot(q,D2)*0.330 + t*0.79; h += 0.30*sin(p2); g += 0.30*cos(p2)*0.330*D2;
          float p3 = dot(q,D3)*0.580 - t*0.96; h += 0.16*lod*sin(p3); g += 0.16*lod*cos(p3)*0.580*D3;
          float p4 = dot(q,D4)*1.020 + t*1.32; h += 0.08*lod*sin(p4); g += 0.08*lod*cos(p4)*1.020*D4;
          g *= mod1; h *= mod1;
          vec3 n = normalize(vec3(-g.x*2.4, 1.0, -g.y*2.4));

          float depth = clamp(-vS/300.0, 0.0, 1.0);
          vec3 base = mix(uShallow, uDeep, smoothstep(0.015, 0.5, depth));
          base = mix(vec3(0.11,0.42,0.45), base, smoothstep(-34.0, 46.0, -vS));
          // 大尺度色斑，避免纯渐变过于干净
          base *= 0.90 + 0.20*vn(q*0.0055 + vec2(t*0.01, 0.0));

          vec3 V = normalize(uCam - vW), L = normalize(uSun);
          float fres = pow(1.0 - max(dot(n,V),0.0), 4.0);
          float rl = max(dot(reflect(-L,n),V), 0.0);
          float spec = pow(rl, 96.0);
          float glit = pow(rl, 20.0);
          vec3 c = base * (0.62 + 0.30*max(dot(n,L),0.0));
          c += uSunC * spec * 1.1 * (1.0-uNight);
          c += uSunC * glit * 0.07 * (1.0-uNight*0.8);
          c += mix(vec3(0.07,0.15,0.26), vec3(0.02,0.05,0.10), uNight) * fres * 0.9;
          float foam = smoothstep(1.30, 1.95, h) * smoothstep(-52.0,-10.0,vS) * (1.0-smoothstep(-10.0,14.0,vS));
          c = mix(c, vec3(0.84,0.91,0.97), foam*0.85);
          c *= mix(1.0, 0.34, uNight);
          gl_FragColor = vec4(c, 1.0);
          #include <fog_fragment>
        }`,
    });
    const sea = new THREE.Mesh(seaGeo, seaMat);
    sea.renderOrder = 1;
    scene.add(sea);

    /* ------------------------------------------------ 陆地 */
    (function buildLand() {
      const g = new THREE.PlaneGeometry(SEA.x1 - SEA.x0, SEA.z1 - SEA.z0, 250, 180);
      g.rotateX(-Math.PI / 2);
      g.translate((SEA.x0 + SEA.x1) / 2, 0, (SEA.z0 + SEA.z1) / 2);
      const pos = g.attributes.position, col = [];
      const c = new THREE.Color(), sand = new THREE.Color(0xb9a377), grass = new THREE.Color(0x40593a), rock = new THREE.Color(0x4e5049);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), z = pos.getZ(i), h = terrainH(x, z);
        pos.setY(i, h);
        if (h < 2.2) c.copy(sand);
        else if (h < 9) c.copy(sand).lerp(grass, smoothstep(2.2, 9, h));
        else c.copy(grass).lerp(rock, smoothstep(16, 42, h));
        const v = 0.85 + 0.3 * vnoise(x * 0.06, z * 0.06);
        col.push(c.r * v, c.g * v, c.b * v);
      }
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      // 海面不透明，深水下的陆地三角形画了也看不见，直接从索引里剔掉——省一大片填充率
      const idx = g.index.array, keep = [];
      for (let i = 0; i < idx.length; i += 3) {
        if (pos.getY(idx[i]) > -4 || pos.getY(idx[i + 1]) > -4 || pos.getY(idx[i + 2]) > -4) {
          keep.push(idx[i], idx[i + 1], idx[i + 2]);
        }
      }
      g.setIndex(keep);
      g.computeVertexNormals();
      const land = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
      land.frustumCulled = false;
      scene.add(land);
    })();

    /* ------------------------------------------------ 贴图 */
    function canvasTex(w, h, draw) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      draw(c.getContext('2d'), w, h);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      return t;
    }
    const helipadTex = canvasTex(128, 128, g => {
      g.fillStyle = '#20262c'; g.beginPath(); g.arc(64, 64, 63, 0, 7); g.fill();
      g.strokeStyle = '#eef4fa'; g.lineWidth = 4;
      g.beginPath(); g.arc(64, 64, 49, 0, 7); g.stroke();
      g.lineWidth = 10;
      g.beginPath();
      g.moveTo(47, 39); g.lineTo(47, 89); g.moveTo(81, 39); g.lineTo(81, 89); g.moveTo(47, 64); g.lineTo(81, 64);
      g.stroke();
    });
    const glowTex = canvasTex(64, 64, (g, w) => {
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(0.22, 'rgba(255,246,214,.55)');
      gr.addColorStop(1, 'rgba(255,220,150,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, w);
    });
    const flameTex = canvasTex(64, 96, (g, w, h) => {
      const gr = g.createRadialGradient(32, 76, 1, 32, 58, 36);
      gr.addColorStop(0, 'rgba(255,250,222,1)');
      gr.addColorStop(0.26, 'rgba(255,181,64,.9)');
      gr.addColorStop(0.6, 'rgba(231,92,26,.42)');
      gr.addColorStop(1, 'rgba(170,48,10,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
    const cloudTex = canvasTex(160, 128, g => {
      const gr = g.createRadialGradient(0, 0, 2, 0, 0, 40);
      gr.addColorStop(0, 'rgba(255,255,255,.85)');
      gr.addColorStop(0.45, 'rgba(255,255,255,.35)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      for (const [cx, cy, r] of [[80, 70, 42], [48, 78, 30], [112, 76, 33], [80, 52, 30], [62, 60, 26], [100, 58, 27]]) {
        g.save(); g.translate(cx, cy); g.scale(r / 40, r / 40); g.fillStyle = gr;
        g.beginPath(); g.arc(0, 0, 40, 0, 7); g.fill(); g.restore();
      }
    });
    const wakeTex = canvasTex(64, 128, (g, w, h) => {
      const gr = g.createLinearGradient(0, h, 0, 0);
      gr.addColorStop(0, 'rgba(255,255,255,.6)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(w / 2, h); g.lineTo(w, 0); g.lineTo(0, 0); g.closePath(); g.fill();
    });

    /* ------------------------------------------------ 共用材质 */
    const MAT = {
      steel: new THREE.MeshLambertMaterial({ color: 0x8b98a7 }),
      steelD: new THREE.MeshLambertMaterial({ color: 0x59646f }),
      deck: new THREE.MeshLambertMaterial({ color: 0x424b55 }),
      tank: new THREE.MeshLambertMaterial({ color: 0xd6a52a }),
      orange: new THREE.MeshLambertMaterial({ color: 0xcf6520 }),
      white: new THREE.MeshLambertMaterial({ color: 0xd5dbe2 }),
      pad: new THREE.MeshBasicMaterial({ map: helipadTex, transparent: true }),
      beacon: new THREE.MeshBasicMaterial({ color: 0xff4d4d }),
      asphalt: new THREE.MeshLambertMaterial({ color: 0x2f353c }),
      concrete: new THREE.MeshLambertMaterial({ color: 0x9aa3ac }),
      glassLit: new THREE.MeshBasicMaterial({ color: 0xffe6ac }),
    };

    /* ------------------------------------------------ 海上平台（实例化） */
    const NF = facIds.length;
    const platParts = [];
    const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3();

    function mk(px, py, pz, sx, sy, sz, rx, ry, rz) {
      const m = new THREE.Matrix4();
      m.compose(new THREE.Vector3(px, py, pz),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0)),
        new THREE.Vector3(sx, sy == null ? sx : sy, sz == null ? sx : sz));
      return m;
    }
    function addPart(geo, mat, local, count, order) {
      const im = new THREE.InstancedMesh(geo, mat, count);
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (order != null) im.renderOrder = order;
      scene.add(im);
      platParts.push({ mesh: im, local, per: local.length });
      return im;
    }
    addPart(new THREE.CylinderGeometry(0.19, 0.30, 7.6, 6), MAT.steelD,
      [mk(1.9, 0.1, 1.6, 1), mk(-1.9, 0.1, 1.6, 1), mk(1.9, 0.1, -1.6, 1), mk(-1.9, 0.1, -1.6, 1)], NF * 4);
    addPart(new THREE.BoxGeometry(5.2, 0.16, 0.16), MAT.steelD,
      [mk(0, 3.0, 1.6, 1), mk(0, 3.0, -1.6, 1), mk(0, 1.1, 1.6, 1), mk(0, 1.1, -1.6, 1)], NF * 4);
    addPart(new THREE.BoxGeometry(5.6, 0.44, 4.6), MAT.deck, [mk(0, 3.9, 0, 1)], NF);
    addPart(new THREE.BoxGeometry(2.0, 1.7, 2.4), MAT.white, [mk(-1.5, 4.98, 0, 1)], NF);
    addPart(new THREE.BoxGeometry(2.08, 0.18, 2.48), MAT.orange, [mk(-1.5, 5.55, 0, 1)], NF);
    addPart(new THREE.CylinderGeometry(0.34, 0.98, 4.4, 4, 1, true), MAT.steel, [mk(1.1, 6.3, -1.15, 1)], NF);
    addPart(new THREE.CylinderGeometry(2.0, 2.0, 0.2, 18), MAT.steelD, [mk(1.9, 4.24, 1.5, 1)], NF);
    addPart(new THREE.CircleGeometry(1.86, 22), MAT.pad, [mk(1.9, 4.36, 1.5, 1, 1, 1, -Math.PI / 2)], NF, 3);
    addPart(new THREE.CylinderGeometry(0.1, 0.13, 4.8, 5), MAT.steelD, [mk(3.6, 5.7, -0.7, 1, 1, 1, 0, 0, -0.9)], NF);
    addPart(new THREE.SphereGeometry(0.24, 7, 6), MAT.beacon, [mk(-1.5, 5.98, 0, 1)], NF);

    const refuelIdx = [];
    facIds.forEach((n, i) => { if (D.nodes[n].rf) refuelIdx.push(i); });
    const tankLocal = [mk(-0.25, 4.85, -1.75, 0.9), mk(0.9, 4.85, -1.75, 0.9)];
    const tankIM = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.62, 0.62, 1.5, 12), MAT.tank, refuelIdx.length * 2);
    tankIM.frustumCulled = false;
    tankIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(tankIM);

    const flameMat = new THREE.MeshBasicMaterial({ map: flameTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.7, side: THREE.DoubleSide });
    const flameIM = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), flameMat, NF);
    flameIM.frustumCulled = false; flameIM.renderOrder = 6;
    flameIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(flameIM);

    const glowMat = new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.3, side: THREE.DoubleSide });
    const glowIM = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), glowMat, NF + apIds.length);
    glowIM.frustumCulled = false; glowIM.renderOrder = 7;
    glowIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(glowIM);

    /* ------------------------------------------------ 机场 */
    const airportY = {};
    apIds.forEach(id => {
      const p = NODEPOS[id];
      const base = Math.max(2.0, terrainH(p.x, p.z));
      airportY[id] = base;
      const g = new THREE.Group();
      g.position.set(p.x, base, p.z);
      g.rotation.y = -0.35;

      const apron = new THREE.Mesh(new THREE.BoxGeometry(30, 0.5, 20), MAT.asphalt);
      apron.position.y = 0.05; g.add(apron);
      const taxi = new THREE.Mesh(new THREE.BoxGeometry(34, 0.4, 4.2), MAT.asphalt);
      taxi.position.set(2, 0.08, -12.5); g.add(taxi);

      for (let i = 0; i < 8; i++) {
        const pad = new THREE.Mesh(new THREE.CircleGeometry(2.7, 20), MAT.pad);
        pad.rotation.x = -Math.PI / 2;
        pad.position.set(-10.5 + (i % 4) * 7, 0.33, i < 4 ? -4.2 : 4.2);
        pad.renderOrder = 3;
        g.add(pad);
      }
      const term = new THREE.Mesh(new THREE.BoxGeometry(15, 3.6, 6), MAT.concrete);
      term.position.set(1, 2.0, 13.5); g.add(term);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(16.2, 0.5, 7.2), MAT.steelD);
      roof.position.set(1, 4.05, 13.5); g.add(roof);
      for (let i = 0; i < 7; i++) {
        const win = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.0, 0.12), MAT.glassLit);
        win.position.set(-4.9 + i * 1.95, 2.2, 10.44); g.add(win);
      }
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.3, 9.5, 10), MAT.concrete);
      tower.position.set(-12.5, 4.8, 12.5); g.add(tower);
      const cab = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 1.6, 2.0, 10), MAT.glassLit);
      cab.position.set(-12.5, 10.4, 12.5); g.add(cab);
      const cabTop = new THREE.Mesh(new THREE.ConeGeometry(2.3, 1.1, 10), MAT.steelD);
      cabTop.position.set(-12.5, 11.9, 12.5); g.add(cabTop);
      const hangar = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.4, 10, 12, 1, false, 0, Math.PI), MAT.steel);
      hangar.rotation.z = Math.PI / 2; hangar.rotation.y = Math.PI / 2;
      hangar.position.set(15, 0.4, 11); g.add(hangar);
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 6), MAT.beacon);
      beacon.position.set(-12.5, 12.7, 12.5); g.add(beacon);
      // 边灯
      for (let i = 0; i < 16; i++) {
        const a = i / 16 * Math.PI * 2;
        const l = new THREE.Mesh(new THREE.SphereGeometry(0.28, 5, 4), MAT.glassLit);
        l.position.set(Math.cos(a) * 16, 0.5, Math.sin(a) * 11.5);
        g.add(l);
      }
      g.userData = { beacon };
      scene.add(g);
    });

    /* ------------------------------------------------ 直升机 */
    const BODY = {
      T1: new THREE.MeshLambertMaterial({ color: 0xe2f2e8 }),
      T2: new THREE.MeshLambertMaterial({ color: 0xe8eff7 }),
      T3: new THREE.MeshLambertMaterial({ color: 0xf7eddd }),
      SEL: new THREE.MeshLambertMaterial({ color: 0xfff4d8 }),
    };
    const TRIM = {
      T1: new THREE.MeshLambertMaterial({ color: 0x2fae82 }),
      T2: new THREE.MeshLambertMaterial({ color: 0x2f7fd0 }),
      T3: new THREE.MeshLambertMaterial({ color: 0xd98b23 }),
      SEL: new THREE.MeshLambertMaterial({ color: 0xffb454 }),
    };
    const DARK = new THREE.MeshLambertMaterial({ color: 0x2b3239 });

    function buildHeli() {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), BODY.T2);
      body.scale.set(1.02, 0.86, 2.0); body.position.y = 0.05; g.add(body);
      const nose = new THREE.Mesh(new THREE.SphereGeometry(0.76, 12, 9), DARK);
      nose.scale.set(1, 0.8, 1.1); nose.position.set(0, 0.1, 1.55); g.add(nose);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.3, 1.6), TRIM.T2);
      stripe.position.set(0, -0.3, 0.3); g.add(stripe);
      const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.15, 2.8, 8), BODY.T2);
      boom.rotation.x = Math.PI / 2; boom.position.set(0, 0.22, -2.6); g.add(boom);
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.2, 0.9), TRIM.T2);
      fin.position.set(0, 0.8, -3.75); g.add(fin);
      const stab = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, 0.5), BODY.T2);
      stab.position.set(0, 0.3, -3.5); g.add(stab);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 0.55, 6), DARK);
      mast.position.y = 1.0; g.add(mast);
      for (const sx of [-1, 1]) {
        const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 3.1, 6), DARK);
        skid.rotation.x = Math.PI / 2; skid.position.set(sx * 0.75, -0.95, 0.15); g.add(skid);
        const st = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.75, 0.1), DARK);
        st.position.set(sx * 0.66, -0.55, 0.55); g.add(st);
        const st2 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.75, 0.1), DARK);
        st2.position.set(sx * 0.66, -0.55, -0.6); g.add(st2);
      }
      const rotor = new THREE.Group();
      for (let i = 0; i < 4; i++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 4.8), DARK);
        b.rotation.y = i * Math.PI / 2; b.position.y = 1.3; rotor.add(b);
      }
      const disc = new THREE.Mesh(new THREE.CircleGeometry(4.9, 26),
        new THREE.MeshBasicMaterial({ color: 0xcfe3f5, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false }));
      disc.rotation.x = -Math.PI / 2; disc.position.y = 1.31; rotor.add(disc);
      g.add(rotor);
      const trotor = new THREE.Group();
      for (let i = 0; i < 2; i++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.6, 0.16), DARK);
        b.rotation.z = i * Math.PI / 2; trotor.add(b);
      }
      trotor.position.set(0.18, 0.88, -3.8); g.add(trotor);
      const lamps = [];
      for (const [x, y, z, col] of [[-1.15, -0.15, 0.3, 0xff3b3b], [1.15, -0.15, 0.3, 0x3bff7a], [0, 0.55, -3.95, 0xffffff]]) {
        const l = new THREE.Mesh(new THREE.SphereGeometry(0.17, 6, 5), new THREE.MeshBasicMaterial({ color: col }));
        l.position.set(x, y, z); g.add(l); lamps.push(l);
      }
      const halo = new THREE.Mesh(new THREE.PlaneGeometry(9, 9),
        new THREE.MeshBasicMaterial({ map: glowTex, color: 0xffd28a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
      g.add(halo);
      g.userData = { rotor, trotor, lamps, halo, body, stripe, fin, boom, stab };
      g.visible = false;
      return g;
    }
    const heliPool = [];
    for (let i = 0; i < 28; i++) { const h = buildHeli(); scene.add(h); heliPool.push(h); }

    /* 远景标记：恒定屏幕大小的机位符号，拉远了也能看见飞机在哪 */
    const markTex = canvasTex(64, 64, g => {
      g.translate(32, 32);
      g.fillStyle = 'rgba(255,255,255,.95)';
      g.beginPath(); g.moveTo(0, -26); g.lineTo(16, 20); g.lineTo(0, 11); g.lineTo(-16, 20); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 2.4; g.stroke();
    });
    const markPool = heliPool.map(() => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: markTex, color: 0x8ce6ff, sizeAttenuation: false,
        depthTest: false, depthWrite: false, transparent: true, opacity: 0,
      }));
      s.renderOrder = 20; s.visible = false;
      scene.add(s);
      return s;
    });

    /* 尾迹 */
    const TRAIL_N = 96;
    const trails = heliPool.map(() => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 3), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 4), 4));
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
      l.frustumCulled = false; l.visible = false;
      scene.add(l);
      return { line: l, pts: [], key: null };
    });

    /* ------------------------------------------------ 航路带 */
    const routeVS = `
      attribute float aU; attribute float aV; attribute vec2 aN;
      varying float vU; varying float vV;
      uniform float uW;
      void main(){
        vU=aU; vV=aV;
        vec3 p = position + vec3(aN.x, 0.0, aN.y) * aV * uW;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`;
    const routeFS = `
      varying float vU; varying float vV;
      uniform float uTime,uOpacity,uLen; uniform vec3 uColor;
      void main(){
        float edge = 1.0 - smoothstep(0.34, 1.0, abs(vV));
        float dash = fract(vU/max(60.0, uLen*0.28) - uTime*0.22);
        float pulse = smoothstep(0.68, 0.99, dash);
        float a = edge * uOpacity * (0.42 + pulse*0.95);
        if(a < 0.004) discard;
        gl_FragColor = vec4(uColor * (0.72 + pulse*0.9), a);
      }`;
    const routeGroup = new THREE.Group();
    scene.add(routeGroup);
    const routeMeshes = {};

    function buildRoute(f) {
      const pos = [], us = [], vs = [], ns = [], idx = [];
      let acc = 0, k = 0;
      for (let j = 0; j < f.xy.length - 1; j++) {
        const a = f.xy[j], b = f.xy[j + 1];
        const ax = a[0], az = -a[1], bx = b[0], bz = -b[1];
        const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
        const nx = -dz / L, nz = dx / L;
        pos.push(ax, 0.7, az, ax, 0.7, az, bx, 0.7, bz, bx, 0.7, bz);
        ns.push(nx, nz, nx, nz, nx, nz, nx, nz);
        us.push(acc, acc, acc + L, acc + L);
        vs.push(1, -1, 1, -1);
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
        k += 4; acc += L;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('aU', new THREE.Float32BufferAttribute(us, 1));
      g.setAttribute('aV', new THREE.Float32BufferAttribute(vs, 1));
      g.setAttribute('aN', new THREE.Float32BufferAttribute(ns, 2));
      g.setIndex(idx);
      const m = new THREE.Mesh(g, new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
        uniforms: {
          uTime: { value: 0 }, uOpacity: { value: 0.4 }, uW: { value: 1.6 },
          uLen: { value: acc }, uColor: { value: new THREE.Color(0x4fd8ff) },
        },
        vertexShader: routeVS, fragmentShader: routeFS,
      }));
      m.renderOrder = 4; m.frustumCulled = false;
      return m;
    }
    function showRoutes(fis, strong) {
      const want = new Set(fis);
      for (const key of Object.keys(routeMeshes)) {
        if (!want.has(+key)) {
          routeGroup.remove(routeMeshes[key]);
          routeMeshes[key].geometry.dispose();
          routeMeshes[key].material.dispose();
          delete routeMeshes[key];
        }
      }
      for (const fi of fis) {
        if (!routeMeshes[fi]) { const m = buildRoute(D.flights[fi]); routeMeshes[fi] = m; routeGroup.add(m); }
        const sel = strong === fi;
        const u = routeMeshes[fi].material.uniforms;
        u.uOpacity.value = W.layers.routes ? (strong == null ? 0.30 : (sel ? 1.0 : 0.07)) : 0;
        u.uColor.value.set(sel ? 0xffc266 : 0x4fd8ff);
      }
      routeGroup.visible = W.layers.routes;
    }

    /* ------------------------------------------------ 云 / 船 */
    const clouds = [];
    for (let i = 0; i < 11; i++) {
      const s = 46 + Math.random() * 74;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s * 0.52),
        new THREE.MeshBasicMaterial({ map: cloudTex, transparent: true, depthWrite: false, opacity: 0.42, color: 0xffffff }));
      m.position.set(-520 + Math.random() * 1440, 74 + Math.random() * 46, -300 + Math.random() * 880);
      m.renderOrder = 8;
      scene.add(m); clouds.push(m);
    }
    const ships = [];
    (function () {
      const hull = new THREE.BoxGeometry(1.5, 0.55, 5.6);
      const hm = new THREE.MeshLambertMaterial({ color: 0xb2503a });
      const sm = new THREE.MeshLambertMaterial({ color: 0xe4ebf3 });
      for (let i = 0; i < 8; i++) {
        const g = new THREE.Group();
        const b = new THREE.Mesh(hull, hm); b.position.y = 0.28; g.add(b);
        const s = new THREE.Mesh(new THREE.BoxGeometry(1.25, 1.0, 1.5), sm); s.position.set(0, 1.0, -1.9); g.add(s);
        const wk = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 15),
          new THREE.MeshBasicMaterial({ map: wakeTex, transparent: true, depthWrite: false, opacity: 0.30 }));
        wk.rotation.x = -Math.PI / 2; wk.position.set(0, 0.14, -9); wk.renderOrder = 2; g.add(wk);
        g.userData = { x: -340 + Math.random() * 980, z: 70 + Math.random() * 280, hdg: Math.random() * 6.28, sp: 0.5 + Math.random() * 0.5 };
        g.scale.setScalar(1.15);
        scene.add(g); ships.push(g);
      }
    })();

    /* ------------------------------------------------ 选中/悬停光环 */
    function ring(color, r) {
      const m = new THREE.Mesh(new THREE.RingGeometry(r * 0.86, r, 48),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
      m.rotation.x = -Math.PI / 2; m.renderOrder = 5; m.visible = false;
      scene.add(m); return m;
    }
    const selRing = ring(0xffb454, 1), hovRing = ring(0x4fd8ff, 1);

    /* ------------------------------------------------ 标签层 */
    const labelLayer = document.createElement('div');
    labelLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:2';
    canvas.parentNode.appendChild(labelLayer);
    const labels = {};
    for (const n of nodeIds) {
      const el = document.createElement('div');
      const isA = D.nodes[n].k === 'A';
      el.textContent = isA ? n + ' ' + (D.meta.airportNames[n] || '') : n;
      el.style.cssText = 'position:absolute;transform:translate(-50%,-50%);white-space:nowrap;opacity:0;' +
        'font:600 ' + (isA ? '12px' : '10px') + '/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;' +
        'padding:3px 7px;border-radius:6px;transition:opacity .22s;will-change:transform;' +
        (isA ? 'color:#fff;background:rgba(16,74,124,.78);border:1px solid rgba(120,220,255,.55);text-shadow:0 1px 3px #000'
          : (D.nodes[n].rf ? 'color:#ffd98a;background:rgba(10,18,30,.62);border:1px solid rgba(216,165,42,.45)'
            : 'color:#c3e6ff;background:rgba(8,17,29,.55);border:1px solid rgba(90,150,200,.28)'));
      labelLayer.appendChild(el);
      labels[n] = el;
    }

    /* ------------------------------------------------ 拾取 */
    const pickPts = [];
    const _pv = new THREE.Vector3();
    let rect = canvas.getBoundingClientRect();
    function project(v) {
      _pv.copy(v).project(camera);
      return { x: (_pv.x * 0.5 + 0.5) * rect.width + rect.left, y: (-_pv.y * 0.5 + 0.5) * rect.height + rect.top, z: _pv.z };
    }
    function rebuildPick(active) {
      pickPts.length = 0;
      for (const n of nodeIds) pickPts.push({ kind: 'node', id: n, v: NODEPOS[n], r: D.nodes[n].k === 'A' ? 30 : 18 });
      for (const a of active) pickPts.push({ kind: 'heli', id: a.fi, v: a.v, r: 22 });
    }
    function nearest(cx, cy) {
      let best = null, bd = 1e9;
      for (const p of pickPts) {
        const s = project(p.v);
        if (s.z > 1) continue;
        const d = Math.hypot(s.x - cx, s.y - cy);
        if (d < p.r && d < bd) { bd = d; best = p; }
      }
      return best;
    }
    function hoverAt(cx, cy) {
      const t = nearest(cx, cy);
      const a = t ? t.kind + t.id : null, b = W.hover ? W.hover.kind + W.hover.id : null;
      W.hover = t;
      canvas.style.cursor = t ? 'pointer' : 'grab';
      if (a !== b && opts.onHover) opts.onHover(t, cx, cy);
      else if (t && opts.onHover) opts.onHover(t, cx, cy);
    }
    function clickAt(cx, cy) { if (opts.onSelect) opts.onSelect(nearest(cx, cy)); }

    /* ------------------------------------------------ 昼夜 */
    const SUNRISE = 5 * 60 + 20, SUNSET = 19 * 60 + 40;
    const sunDir = new THREE.Vector3();
    const cDay = new THREE.Color(0x2a6fd0), cDayH = new THREE.Color(0x9fcdf2);
    const cDusk = new THREE.Color(0x27407e), cDuskH = new THREE.Color(0xff8a3d);
    const cNight = new THREE.Color(0x02060f), cNightH = new THREE.Color(0x081729);
    const tA = new THREE.Color(), tB = new THREE.Color();

    function updateSun(minOfDay) {
      const f = (minOfDay - SUNRISE) / (SUNSET - SUNRISE);
      const elev = Math.sin(Math.PI * clamp(f, -0.42, 1.42)) * 1.15;
      const th = Math.PI * clamp(f, -0.12, 1.12);
      const hz = Math.max(0.05, Math.cos(elev));
      sunDir.set(hz * Math.cos(th), Math.sin(elev), hz * 0.5).normalize();
      W.sunElev = elev;
      const night = smoothstep(0.10, -0.17, elev);
      const dusk = 1 - Math.min(1, Math.abs(elev) / 0.58);
      W.night = night;

      tA.copy(cDay).lerp(cDusk, dusk).lerp(cNight, night);
      tB.copy(cDayH).lerp(cDuskH, dusk).lerp(cNightH, night);
      skyMat.uniforms.uTop.value.copy(tA);
      skyMat.uniforms.uHor.value.copy(tB);
      skyMat.uniforms.uSun.value.copy(sunDir);
      skyMat.uniforms.uNight.value = night;
      skyMat.uniforms.uSunC.value.setHSL(0.115 - 0.055 * dusk, 0.5 + 0.45 * dusk, 0.82 - 0.14 * dusk);

      scene.fog.color.copy(tB).multiplyScalar(0.60);
      renderer.setClearColor(scene.fog.color, 1);
      sun.position.copy(sunDir).multiplyScalar(1200);
      sun.intensity = lerp(0.05, 1.8, smoothstep(-0.16, 0.42, elev));
      sun.color.copy(skyMat.uniforms.uSunC.value);
      hemi.intensity = lerp(0.14, 0.60, 1 - night);
      hemi.color.copy(tB);
      ambient.intensity = lerp(0.38, 0.46, 1 - night);

      seaMat.uniforms.uSun.value.copy(sunDir);
      seaMat.uniforms.uNight.value = night;
      seaMat.uniforms.uSunC.value.copy(skyMat.uniforms.uSunC.value);

      glowMat.opacity = 0.10 + 0.72 * night;
      glowIM.visible = night > 0.04;
      flameMat.opacity = 0.45 + 0.5 * night;
      MAT.glassLit.color.setRGB(lerp(0.30, 1.0, night), lerp(0.33, 0.90, night), lerp(0.38, 0.66, night));
      for (const c of clouds) {
        c.material.opacity = lerp(0.34, 0.12, night);
        c.material.color.copy(tB).lerp(skyMat.uniforms.uSunC.value, 0.45 * (1 - night)).multiplyScalar(lerp(1.5, 0.55, night));
      }
    }

    /* ------------------------------------------------ 每帧更新 */
    const m4 = new THREE.Matrix4(), mBase = new THREE.Matrix4();
    let lastScale = -1, tSec = 0, lastMin = -1;
    const activeCache = [];

    function updatePlatformStruct() {
      const S = W.iconScale;
      for (let i = 0; i < NF; i++) {
        const p = NODEPOS[facIds[i]];
        mBase.compose(_v.set(p.x, 0, p.z), _q.set(0, 0, 0, 1), _s.set(S, S, S));
        for (const part of platParts) {
          for (let k = 0; k < part.per; k++) {
            m4.multiplyMatrices(mBase, part.local[k]);
            part.mesh.setMatrixAt(i * part.per + k, m4);
          }
        }
      }
      refuelIdx.forEach((i, j) => {
        const p = NODEPOS[facIds[i]];
        mBase.compose(_v.set(p.x, 0, p.z), _q.set(0, 0, 0, 1), _s.set(S, S, S));
        for (let k = 0; k < 2; k++) { m4.multiplyMatrices(mBase, tankLocal[k]); tankIM.setMatrixAt(j * 2 + k, m4); }
      });
      for (const part of platParts) part.mesh.instanceMatrix.needsUpdate = true;
      tankIM.instanceMatrix.needsUpdate = true;
    }

    function updateBillboards(t) {
      const S = W.iconScale;
      _e.set(0, Math.PI / 2 - cam.theta, 0);
      _q.setFromEuler(_e);
      let gi = 0;
      for (let i = 0; i < NF; i++) {
        const p = NODEPOS[facIds[i]];
        const fl = 0.8 + 0.32 * Math.sin(t * 5.1 + i * 2.3) + 0.16 * Math.sin(t * 11.7 + i);
        m4.compose(_v.set(p.x + 4.8 * S, (7.5 + fl * 0.8) * S, p.z - 1.7 * S), _q, _s.set(1.8 * S * (0.88 + fl * 0.22), 2.6 * S * fl, 1));
        flameIM.setMatrixAt(i, m4);
        m4.compose(_v.set(p.x, 5.2 * S, p.z), _q, _s.set(13 * S, 13 * S, 1));
        glowIM.setMatrixAt(gi++, m4);
      }
      for (const id of apIds) {
        const p = NODEPOS[id];
        m4.compose(_v.set(p.x, airportY[id] + 6, p.z), _q, _s.set(78, 78, 1));
        glowIM.setMatrixAt(gi++, m4);
      }
      flameIM.instanceMatrix.needsUpdate = true;
      glowIM.instanceMatrix.needsUpdate = true;
    }

    function groundY(node) {
      return node[0] === 'A' ? airportY[node] + 0.4 : 4.46 * W.iconScale;
    }

    function updateHelis(mAbs, dt) {
      const S = W.iconScale * 0.58;
      const act = H.activeFlights(mAbs);
      activeCache.length = 0;
      let n = 0;
      for (const a of act) {
        if (n >= heliPool.length) break;
        const f = D.flights[a.fi], st = a.st, g = heliPool[n], u = g.userData;
        const pos = H.flightPos(f, st, 9);
        const airborne = st.phase === 'air';
        const gy = groundY(airborne ? f.s[st.leg].n : (st.node || f.s[0].n));
        g.visible = true;
        g.position.set(pos.x, gy + 0.98 * S + pos.alt * 1.9, -pos.y);
        if (airborne) {
          let d = pos.hdg - g.rotation.y;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          g.rotation.y += d * Math.min(1, dt * 2.6);
          g.rotation.z += (clamp(-d * 2.2, -0.45, 0.45) - g.rotation.z) * Math.min(1, dt * 3);
          g.rotation.x += (-0.09 - g.rotation.x) * Math.min(1, dt * 3);
        } else {
          g.rotation.z *= 0.9; g.rotation.x *= 0.9;
        }
        g.scale.setScalar(S);
        const spin = st.phase === 'idle' ? 0 : (airborne ? 36 : 21);
        u.rotor.rotation.y += dt * spin;
        u.trotor.rotation.x += dt * spin * 1.6;
        u.halo.material.opacity = W.night * 0.42 * (airborne ? 1 : 0.5);
        u.halo.lookAt(camera.position);
        const sel = W.selected && W.selected.kind === 'heli' && W.selected.id === a.fi;
        const bm = sel ? BODY.SEL : (BODY[f.t] || BODY.T2);
        const tm = sel ? TRIM.SEL : (TRIM[f.t] || TRIM.T2);
        if (u.body.material !== bm) { u.body.material = bm; u.boom.material = bm; u.stab.material = bm; u.stripe.material = tm; u.fin.material = tm; }
        activeCache.push({ fi: a.fi, st, v: g.position.clone(), load: airborne ? f.load[st.leg] : 0 });

        // 远景标记
        const mk2 = markPool[n];
        const far = smoothstep(190, 330, W.camDist);
        mk2.visible = far > 0.02;
        if (mk2.visible) {
          mk2.position.copy(g.position);
          mk2.position.y += 4 + 3 * W.iconScale;
          mk2.material.opacity = far * (airborne ? 0.95 : 0.55);
          mk2.material.color.set(sel ? 0xffc266 : (airborne ? 0x8ce6ff : 0x9fb4d4));
          mk2.scale.set(0.030, 0.030, 1);
          // 屏幕空间朝向 = 航向
          if (airborne) {
            const s0 = project(g.position);
            _v.set(g.position.x + Math.sin(g.rotation.y) * 6, g.position.y, g.position.z - Math.cos(g.rotation.y) * 6);
            const s1 = project(_v);
            mk2.material.rotation = -Math.atan2(s1.x - s0.x, -(s1.y - s0.y));
          } else mk2.material.rotation = 0;
        }

        const tr = trails[n];
        if (tr.key !== a.fi) { tr.key = a.fi; tr.pts.length = 0; }
        if (airborne) {
          const last = tr.pts[tr.pts.length - 1];
          if (!last || last.distanceToSquared(g.position) > 1.2) tr.pts.push(g.position.clone());
          if (tr.pts.length > TRAIL_N) tr.pts.shift();
          const L = tr.pts.length;
          if (L > 2) {
            const pa = tr.line.geometry.attributes.position, ca = tr.line.geometry.attributes.color;
            for (let i = 0; i < L; i++) {
              const s = tr.pts[i];
              pa.setXYZ(i, s.x, s.y, s.z);
              ca.setXYZW(i, 0.45, 0.85, 1.0, Math.pow(i / (L - 1), 2.2) * 0.7);
            }
            pa.needsUpdate = true; ca.needsUpdate = true;
            tr.line.geometry.setDrawRange(0, L);
            tr.line.visible = true;
          } else tr.line.visible = false;
        } else { tr.line.visible = false; tr.pts.length = 0; }
        n++;
      }
      for (let i = n; i < heliPool.length; i++) {
        heliPool[i].visible = false; markPool[i].visible = false;
        trails[i].line.visible = false; trails[i].pts.length = 0; trails[i].key = null;
      }
      W.activeCount = activeCache.length;
      hotNodes.clear();
      for (const a of activeCache) for (const s of D.flights[a.fi].s) hotNodes.add(s.n);
      rebuildPick(activeCache);
      return activeCache;
    }

    function updateRings() {
      const S = W.iconScale;
      const put = (ring, target, colorPulse) => {
        if (!target) { ring.visible = false; return; }
        let v = null, r = 8 * S;
        if (target.kind === 'node') {
          v = NODEPOS[target.id];
          r = (D.nodes[target.id].k === 'A' ? 24 : 7 * S);
          ring.position.set(v.x, D.nodes[target.id].k === 'A' ? airportY[target.id] + 0.7 : 0.9, v.z);
        } else {
          const a = activeCache.find(x => x.fi === target.id);
          if (!a) { ring.visible = false; return; }
          ring.position.set(a.v.x, 0.9, a.v.z);
          r = 6 * S;
        }
        ring.scale.setScalar(r * (1 + 0.06 * Math.sin(tSec * 3 + colorPulse)));
        ring.visible = true;
      };
      put(selRing, W.selected, 0);
      put(hovRing, W.hover && (!W.selected || W.hover.id !== W.selected.id) ? W.hover : null, 1.7);
    }

    const hotNodes = new Set();
    const placed = [];
    function updateLabels() {
      rect = canvas.getBoundingClientRect();
      const showAll = W.camDist < 300;
      placed.length = 0;
      for (const n of nodeIds) {
        const el = labels[n], isA = D.nodes[n].k === 'A';
        if (!W.layers.labels) { if (el.style.opacity !== '0') el.style.opacity = '0'; continue; }
        const s = project(NODEPOS[n]);
        if (s.z > 1 || s.x < rect.left - 80 || s.x > rect.right + 80 || s.y < rect.top - 60 || s.y > rect.bottom + 60) {
          if (el.style.opacity !== '0') el.style.opacity = '0';
          continue;
        }
        const hot = (W.hover && W.hover.id === n) || (W.selected && W.selected.id === n);
        let vis = isA || hot || showAll || hotNodes.has(n);
        // 去重叠：后来的标签若压住已放置的就让位（机场与热点优先）
        if (vis && !isA && !hot) {
          for (const p of placed) {
            if (Math.abs(p.x - s.x) < 46 && Math.abs(p.y - s.y) < 15) { vis = false; break; }
          }
        }
        if (!vis) { if (el.style.opacity !== '0') el.style.opacity = '0'; continue; }
        placed.push(s);
        const lift = isA ? 30 : (14 * W.iconScale / 1.6 + 9);
        el.style.transform = `translate(-50%,-50%) translate(${(s.x - rect.left).toFixed(1)}px,${(s.y - rect.top - lift).toFixed(1)}px)`;
        el.style.opacity = isA ? '1' : hot ? '1' : hotNodes.has(n) ? '0.92' : '0.72';
      }
    }

    function updateAmbientLife(dt) {
      for (const s of ships) {
        const u = s.userData;
        u.hdg += Math.sin(tSec * 0.06 + u.x * 0.01) * 0.0022;
        u.x += Math.sin(u.hdg) * u.sp * dt * 7;
        u.z += Math.cos(u.hdg) * u.sp * dt * 7;
        if (u.x < -430) u.x = 960; if (u.x > 960) u.x = -430;
        if (u.z < 55) u.z = 430; if (u.z > 430) u.z = 55;
        s.position.set(u.x, 0.15, u.z);
        s.rotation.y = u.hdg;
        s.visible = W.layers.ships;
      }
      for (const c of clouds) {
        c.position.x += dt * 1.2;
        if (c.position.x > 980) c.position.x = -600;
        c.lookAt(camera.position.x, c.position.y, camera.position.z);
        c.visible = W.layers.weather;
      }
    }

    /* ------------------------------------------------ 主循环 */
    /* 自适应分辨率：这类场景是填充率瓶颈，集显上按帧率自动调 DPR 比一刀切更稳 */
    const DPR_CAP = Math.min(devicePixelRatio || 1, 1.5);
    let dpr = DPR_CAP, frames = 0, winStart = performance.now();
    function adaptRes(now) {
      frames++;
      const el = now - winStart;
      if (el < 2200) return;
      const fps = frames * 1000 / el;
      frames = 0; winStart = now;
      let next = dpr;
      if (fps < 44 && dpr > 0.75) next = Math.max(0.75, dpr - 0.25);
      else if (fps > 57 && dpr < DPR_CAP) next = Math.min(DPR_CAP, dpr + 0.25);
      if (next !== dpr) { dpr = next; renderer.setPixelRatio(dpr); resize(); W.dpr = dpr; }
    }

    let raf = 0, prev = performance.now();
    function frame(now) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      tSec += dt;
      adaptRes(now);

      const mAbs = H.Clock.now();
      updateSun(H.minOfDay(mAbs));
      applyCam();

      seaMat.uniforms.uTime.value = tSec;
      seaMat.uniforms.uCam.value.copy(camera.position);
      const rw = clamp(cam.dist * 0.0030, 0.5, 2.3);
      for (const k in routeMeshes) {
        const u = routeMeshes[k].material.uniforms;
        u.uTime.value = tSec; u.uW.value = rw;
      }

      if (Math.abs(W.iconScale - lastScale) > 0.004) { updatePlatformStruct(); lastScale = W.iconScale; }
      updateBillboards(tSec);
      const act = updateHelis(mAbs, dt);
      updateAmbientLife(dt);
      updateRings();
      updateLabels();

      if (W.follow != null) {
        const a = act.find(x => x.fi === W.follow);
        if (a) cam.tTarget.set(a.v.x, a.v.y, a.v.z);
        else W.follow = null;
      } else if (cam.tTarget.y !== 0) cam.tTarget.y = 0;

      sky.position.copy(camera.position);
      renderer.render(scene, camera);

      const mi = Math.floor(mAbs);
      if (opts.onFrame && mi !== lastMin) { lastMin = mi; opts.onFrame(mAbs, act); }
    }

    function resize() {
      const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      rect = canvas.getBoundingClientRect();
    }
    addEventListener('resize', resize);
    resize();
    applyCam();
    updatePlatformStruct();
    raf = requestAnimationFrame(frame);

    /* ------------------------------------------------ 对外接口 */
    return {
      three: { scene, camera, renderer },
      state: W,
      showRoutes, resize,
      setLayer(k, v) { W.layers[k] = v; if (k === 'routes') routeGroup.visible = v; },
      select(sel) { W.selected = sel; },
      follow(fi) { W.follow = fi; if (fi != null) cam.tDist = Math.min(cam.tDist, 34); },
      focus(node, dist) {
        const v = NODEPOS[node];
        if (!v) return;
        cam.tTarget.set(v.x, 0, v.z);
        if (dist) cam.tDist = dist;
        cam.tPhi = clamp(cam.tPhi, 0.5, 1.25);
        W.follow = null;
      },
      home() { cam.tTarget.set(HOME.tx, 0, HOME.tz); cam.tDist = HOME.dist; cam.tTheta = HOME.theta; cam.tPhi = HOME.phi; W.follow = null; },
      top() { cam.tPhi = 0.14; cam.tDist = 560; cam.tTheta = Math.PI * 1.5; W.follow = null; },
      activeList: () => activeCache,
      nodePos: n => NODEPOS[n],
      project,
      dispose() { cancelAnimationFrame(raf); renderer.dispose(); },
    };
  };
})(window);
