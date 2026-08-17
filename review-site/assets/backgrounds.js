// 首页动态背景引擎。
//
// 5 套内置：none（素色，不起画布）+ mesh / aurora / silk / nebula 四套 WebGL 着色器。
// 另外支持最多 3 张自定义上传的图片背景（值形如 custom:<id>，走 <div> 贴图不走 WebGL）。
// 四套着色器都吃 uDark 这个 uniform，浅色/深色各一套配色 —— 站点默认是浅色，
// 只按深色调的背景会把整页压暗，所以配色必须分开给。
(function () {
  if (!document.body.classList.contains('home')) return;

  const SHADERS = ['mesh', 'aurora', 'silk', 'nebula'];
  const isCustom = (v) => typeof v === 'string' && v.startsWith('custom:');
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------------------------------------------------------- 图片背景层 */
  const imageLayer = document.createElement('div');
  imageLayer.className = 'nb-background-image';
  imageLayer.setAttribute('aria-hidden', 'true');
  imageLayer.hidden = true;
  document.body.prepend(imageLayer);

  const canvas = document.createElement('canvas');
  canvas.id = 'nb-background-canvas';
  canvas.className = 'nb-background-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.hidden = true;
  document.body.prepend(canvas);

  const gl = canvas.getContext('webgl', {
    alpha: true, antialias: false, depth: false, stencil: false,
    powerPreference: 'low-power', premultipliedAlpha: false,
  });
  if (!gl) {
    canvas.remove();
    document.documentElement.classList.add('nb-bg-fallback');
  }

  const vertex = `
    attribute vec2 aPosition;
    varying vec2 vUv;
    void main(){vUv=aPosition*0.5+0.5;gl_Position=vec4(aPosition,0.0,1.0);}
  `;

  // 各着色器共用的噪声工具
  const NOISE = `
    float h21(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    float vnoise(vec2 p){
      vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
      return mix(mix(h21(i),h21(i+vec2(1.,0.)),f.x),mix(h21(i+vec2(0.,1.)),h21(i+vec2(1.,1.)),f.x),f.y);
    }
    float fbm(vec2 p){float a=0.5,s=0.0;for(int i=0;i<5;i++){s+=a*vnoise(p);p*=2.03;a*=0.5;}return s;}
  `;

  const fragments = {
    // 流光：柔和的 mesh gradient。五团色斑各走各的李萨如轨迹，浅色下是奶油色调、
    // 深色下换成高饱和霓虹。这套在浅色主题里最好看，所以放在第一个。
    mesh: `
      precision highp float;
      varying vec2 vUv; uniform vec2 uResolution; uniform float uTime; uniform float uDark; uniform vec2 uMouse;
      vec3 blob(vec2 p, vec2 c, vec3 col, float r){
        float d=length(p-c); return col*exp(-d*d/(r*r));
      }
      void main(){
        float a=uResolution.x/max(1.0,uResolution.y);
        vec2 p=vec2(vUv.x*a,vUv.y);
        float t=uTime*0.075;
        vec2 m=(uMouse-0.5)*0.10;
        vec3 c=vec3(0.0);
        c+=blob(p,vec2(a*0.22+sin(t*1.10)*0.13+m.x, 0.30+cos(t*0.90)*0.11+m.y), mix(vec3(0.72,0.63,1.00),vec3(0.42,0.24,0.95),uDark), 0.44);
        c+=blob(p,vec2(a*0.80+cos(t*0.80)*0.15-m.x, 0.24+sin(t*1.30)*0.10+m.y), mix(vec3(0.60,0.86,1.00),vec3(0.10,0.48,0.96),uDark), 0.47);
        c+=blob(p,vec2(a*0.56+sin(t*0.62+2.0)*0.19+m.x, 0.82+cos(t*0.72)*0.13-m.y), mix(vec3(1.00,0.76,0.90),vec3(0.82,0.20,0.60),uDark), 0.42);
        c+=blob(p,vec2(a*0.12+cos(t*1.40)*0.11-m.x, 0.86+sin(t*0.52)*0.09-m.y), mix(vec3(0.76,1.00,0.94),vec3(0.08,0.66,0.68),uDark), 0.37);
        c+=blob(p,vec2(a*0.93+sin(t*1.02+1.0)*0.11+m.x, 0.60+cos(t*1.12)*0.12+m.y), mix(vec3(1.00,0.93,0.72),vec3(0.72,0.48,0.14),uDark), 0.34);
        float alpha=clamp(max(max(c.r,c.g),c.b)*1.10,0.0,1.0);
        gl_FragColor=vec4(c, alpha*mix(0.86,0.95,uDark));
      }
    `,
    // 极光：三道帘幕，各自有高度、颜色与抖动。旧版只有一道且贴着中线，
    // 看着像一条彩带；现在拉开层次并把底部收干净。
    aurora: `
      precision highp float;
      varying vec2 vUv; uniform vec2 uResolution; uniform float uTime; uniform float uDark; uniform vec2 uMouse;
      ${NOISE}
      float curtain(vec2 uv, float base, float speed, float amp, float width, float t){
        float n=fbm(vec2(uv.x*2.4+t*speed, t*speed*0.6));
        float crest=base+(n-0.5)*amp+sin(uv.x*6.1-t*0.22)*0.030;
        float body=1.0-smoothstep(0.0,width,abs(uv.y-crest));
        float ray=0.72+0.28*fbm(vec2(uv.x*13.0-t*0.35, uv.y*3.0+t*0.1));
        float fade=smoothstep(0.02,0.42,uv.y);
        return body*ray*fade;
      }
      void main(){
        vec2 uv=vUv; float t=uTime; float mx=(uMouse.x-0.5)*0.06;
        vec3 c1=mix(vec3(0.30,0.88,0.62),vec3(0.30,1.00,0.62),uDark);
        vec3 c2=mix(vec3(0.46,0.60,1.00),vec3(0.36,0.42,1.00),uDark);
        vec3 c3=mix(vec3(0.98,0.60,0.88),vec3(0.72,0.24,0.92),uDark);
        float a1=curtain(uv+vec2(mx,0.0),0.70,0.055,0.20,0.26,t);
        float a2=curtain(uv+vec2(-mx,0.0),0.56,0.041,0.26,0.20,t+31.0);
        float a3=curtain(uv,0.82,0.068,0.15,0.16,t+77.0);
        vec3 col=c1*a1+c2*a2*0.9+c3*a3*0.7;
        float alpha=clamp(a1*0.62+a2*0.52+a3*0.40,0.0,1.0);
        gl_FragColor=vec4(col, alpha*mix(0.92,0.95,uDark));
      }
    `,
    // 丝绸：域扭曲（domain warp）出来的绸缎褶皱，速度很慢，适合长时间盯着。
    silk: `
      precision highp float;
      varying vec2 vUv; uniform vec2 uResolution; uniform float uTime; uniform float uDark; uniform vec2 uMouse;
      void main(){
        float a=uResolution.x/max(1.0,uResolution.y);
        vec2 uv=(vUv*2.0-1.0); uv.x*=a;
        float t=uTime*0.13+(uMouse.x-0.5)*0.35;
        for(int i=0;i<5;i++){
          float f=float(i)+1.0;
          uv+=vec2(sin(uv.y*1.9*f+t*1.1)/f, cos(uv.x*1.7*f-t*0.9)/f)*0.28;
        }
        float v=0.5+0.5*sin(uv.x*1.6+uv.y*1.1);
        float w=0.5+0.5*cos(uv.y*2.1-uv.x*0.7);
        vec3 cA=mix(vec3(0.97,0.68,0.52),vec3(0.30,0.10,0.46),uDark);
        vec3 cB=mix(vec3(0.44,0.60,0.98),vec3(0.06,0.36,0.72),uDark);
        vec3 cC=mix(vec3(0.98,0.72,0.84),vec3(0.86,0.34,0.52),uDark);
        vec3 col=mix(mix(cA,cB,v),cC,w*0.42);
        // 浅色下高光要收着点，不然绸缎一亮就糊成一片白
        float sheen=pow(v,3.0)*mix(0.16,0.35,uDark);
        col+=sheen;
        gl_FragColor=vec4(col, mix(0.86,0.86,uDark));
      }
    `,
    // 星海：星点 + 慢慢流动的星云。浅色下换成淡淡的晨雾与微光，不至于把页面压暗。
    nebula: `
      precision highp float;
      varying vec2 vUv; uniform vec2 uResolution; uniform float uTime; uniform float uDark; uniform vec2 uMouse;
      ${NOISE}
      void main(){
        float a=uResolution.x/max(1.0,uResolution.y);
        vec2 p=vec2(vUv.x*a,vUv.y);
        float t=uTime*0.02;
        vec2 q=p+vec2(t,t*0.6)+(uMouse-0.5)*0.05;
        float n=fbm(q*2.3);
        float n2=fbm(q*4.7+n*1.2);
        float cloud=smoothstep(0.32,0.86,n*0.65+n2*0.45);
        vec3 deep=mix(vec3(0.86,0.88,0.99),vec3(0.03,0.02,0.10),uDark);
        vec3 hot =mix(vec3(0.62,0.48,0.98),vec3(0.52,0.16,0.86),uDark);
        vec3 cool=mix(vec3(0.42,0.70,0.98),vec3(0.10,0.34,0.86),uDark);
        vec3 col=mix(deep,mix(cool,hot,n2),cloud);
        // 星点：网格抖动，越亮越稀
        vec2 g=floor(p*vec2(220.0,220.0));
        float s=h21(g);
        float twinkle=0.6+0.4*sin(uTime*1.7+s*40.0);
        float star=smoothstep(0.9965,0.99965,s)*twinkle*(1.0-cloud*0.75);
        col+=vec3(1.0,0.98,0.94)*star*mix(0.35,1.6,uDark);
        gl_FragColor=vec4(col, mix(0.84,0.92,uDark));
      }
    `,
  };

  let program = null, frame = 0, started = performance.now(), current = '', positionBuffer = null;
  const mouse = { x: .5, y: .5, tx: .5, ty: .5 };

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(message || 'shader compile failed');
    }
    return shader;
  }

  function darkNow() { return document.documentElement.dataset.theme === 'dark' ? 1 : 0; }

  function build(name) {
    cancelAnimationFrame(frame);
    frame = 0;
    current = name;

    // 自定义图片背景：不走 WebGL
    if (isCustom(name)) {
      if (canvas.parentNode) canvas.hidden = true;
      const meta = (window.NBBackgrounds && NBBackgrounds.find(name)) || null;
      imageLayer.hidden = false;
      imageLayer.style.backgroundImage = meta
        ? `url("/api/background?id=${encodeURIComponent(meta.id)}&v=${meta.updated_at}")`
        : `url("/api/background?id=${encodeURIComponent(name.slice(7))}")`;
      return;
    }
    imageLayer.hidden = true;
    imageLayer.style.backgroundImage = '';

    if (!gl) return;
    canvas.hidden = !SHADERS.includes(name);
    if (!SHADERS.includes(name)) return;

    try {
      const next = gl.createProgram();
      const vs = compile(gl.VERTEX_SHADER, vertex);
      const fs = compile(gl.FRAGMENT_SHADER, fragments[name]);
      gl.attachShader(next, vs); gl.attachShader(next, fs); gl.linkProgram(next);
      gl.deleteShader(vs); gl.deleteShader(fs);
      if (!gl.getProgramParameter(next, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(next));
      if (program) gl.deleteProgram(program);
      program = next;
      if (!positionBuffer) {
        positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      }
      started = performance.now();
      resize();
      draw(performance.now());
    } catch (error) {
      canvas.hidden = true;
      document.documentElement.classList.add('nb-bg-fallback');
      console.warn('Background shader unavailable:', name, error);
    }
  }

  function resize() {
    const compact = innerWidth < 720;
    const dpr = Math.min(devicePixelRatio || 1, compact ? 1 : 1.35);
    const width = Math.max(1, Math.floor(innerWidth * dpr));
    const height = Math.max(1, Math.floor(innerHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width; canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
  }
  const loc = (n) => gl.getUniformLocation(program, n);
  function uniform2(n, x, y) { const l = loc(n); if (l !== null) gl.uniform2f(l, x, y); }
  function uniform1(n, v) { const l = loc(n); if (l !== null) gl.uniform1f(l, v); }

  function draw(now) {
    frame = 0;
    if (!program || !SHADERS.includes(current)) return;
    resize();
    mouse.x += (mouse.tx - mouse.x) * .055;
    mouse.y += (mouse.ty - mouse.y) * .055;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    const position = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    uniform2('uResolution', canvas.width, canvas.height);
    uniform2('uMouse', mouse.x, mouse.y);
    uniform1('uDark', darkNow());
    uniform1('uTime', REDUCED.matches ? 0 : (now - started) / 1000);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (!REDUCED.matches && !document.hidden) frame = requestAnimationFrame(draw);
  }

  const selected = () => document.documentElement.dataset.bg || 'none';
  addEventListener('pointermove', (event) => {
    mouse.tx = event.clientX / Math.max(1, innerWidth);
    mouse.ty = 1 - event.clientY / Math.max(1, innerHeight);
  }, { passive: true });
  addEventListener('resize', () => { if (gl) resize(); }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && SHADERS.includes(current) && !frame) frame = requestAnimationFrame(draw);
  });
  addEventListener('nb-background-change', (event) => build(event.detail.background));
  // 自定义背景列表拿回来后要重画一次（首帧可能还不知道图的 updated_at）
  addEventListener('nb-backgrounds-loaded', () => { if (isCustom(current)) build(current); });
  REDUCED.addEventListener('change', () => build(selected()));

  build(selected());
})();
