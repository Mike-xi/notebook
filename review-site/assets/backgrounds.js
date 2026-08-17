// 首页动态背景引擎。
//
// 5 套内置：none（素色，不起画布）+ 四套 WebGL 着色器：
//   aurora  极光   ← React Bits「Soft Aurora」
//   blinds  百叶窗 ← React Bits「Gradient Blinds」
//   waves   波纹   ← React Bits「Sliced Waves」
//   terrain 地形   ← React Bits「Topography」
// 四套的 GLSL 都是从 React Bits 公开 registry 原样搬来的（原版靠 ogl 起一个全屏
// 三角形，这里换成自己的裸 WebGL runner，着色器本体没改），可调参数固化成常量，
// 只把配色按 uDark 拆成浅色/深色两套 —— 站点默认浅色，只按深色调的背景会把整页压暗。
//
// 另外支持最多 3 张自定义上传的图片背景（值形如 custom:<id>，走 <div> 贴图不走 WebGL）。
// 整体浓淡由 CSS 变量 --nb-bg-opacity 控制（设置面板里的滑杆，见 appearance.js）。
//
// 登录页（body.login）也用这套引擎，但不读偏好、不可切换：固定极光，浓淡固定。
(function () {
  const LOGIN = document.body.classList.contains('login');
  if (!LOGIN && !document.body.classList.contains('home')) return;

  const SHADERS = ['aurora', 'blinds', 'waves', 'terrain'];
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
  // waves / terrain 用 fwidth 做抗锯齿，WebGL1 里要显式开导数扩展
  const HAS_DERIV = gl ? !!gl.getExtension('OES_standard_derivatives') : false;
  const DERIV = HAS_DERIV ? '#extension GL_OES_standard_derivatives : enable\n' : '';

  const vertex = `
    attribute vec2 aPosition;
    varying vec2 vUv;
    void main(){vUv=aPosition*0.5+0.5;gl_Position=vec4(aPosition,0.0,1.0);}
  `;

  // 没有导数扩展时退化成固定宽度，画面略糊但不会编译失败
  const FW = HAS_DERIV ? '' : '#define fwidth(x) 0.002\n';

  const fragments = {
    /* ---- 极光 Soft Aurora ---------------------------------------------
       两层柏林噪声带 + 余弦调色板。原版参数：speed .6 / scale 1.5 /
       noiseFreq 2.5 / noiseAmp 1.0 / bandHeight .5 / bandSpread 1.0 /
       octaveDecay .1 / colorSpeed 1.0 / mouseInfluence .25。 */
    aurora: `
      precision highp float;
      varying vec2 vUv; uniform vec2 uResolution; uniform float uTime; uniform float uDark; uniform vec2 uMouse;
      #define TAU 6.28318

      vec3 gradientHash(vec3 p){
        p=vec3(dot(p,vec3(127.1,311.7,234.6)),dot(p,vec3(269.5,183.3,198.3)),dot(p,vec3(169.5,283.3,156.9)));
        vec3 h=fract(sin(p)*43758.5453123);
        float phi=acos(2.0*h.x-1.0);
        float theta=TAU*h.y;
        return vec3(cos(theta)*sin(phi), sin(theta)*cos(phi), cos(phi));
      }
      float quinticSmooth(float t){float t2=t*t;float t3=t*t2;return 6.0*t3*t2-15.0*t2*t2+10.0*t3;}
      vec3 cosineGradient(float t, vec3 a, vec3 b, vec3 c, vec3 d){return a+b*cos(TAU*(c*t+d));}

      float perlin3D(float amplitude, float frequency, float px, float py, float pz){
        float x=px*frequency; float y=py*frequency;
        float fx=floor(x); float fy=floor(y); float fz=floor(pz);
        float cx=ceil(x);  float cy=ceil(y);  float cz=ceil(pz);
        vec3 g000=gradientHash(vec3(fx,fy,fz));
        vec3 g100=gradientHash(vec3(cx,fy,fz));
        vec3 g010=gradientHash(vec3(fx,cy,fz));
        vec3 g110=gradientHash(vec3(cx,cy,fz));
        vec3 g001=gradientHash(vec3(fx,fy,cz));
        vec3 g101=gradientHash(vec3(cx,fy,cz));
        vec3 g011=gradientHash(vec3(fx,cy,cz));
        vec3 g111=gradientHash(vec3(cx,cy,cz));
        float d000=dot(g000,vec3(x-fx,y-fy,pz-fz));
        float d100=dot(g100,vec3(x-cx,y-fy,pz-fz));
        float d010=dot(g010,vec3(x-fx,y-cy,pz-fz));
        float d110=dot(g110,vec3(x-cx,y-cy,pz-fz));
        float d001=dot(g001,vec3(x-fx,y-fy,pz-cz));
        float d101=dot(g101,vec3(x-cx,y-fy,pz-cz));
        float d011=dot(g011,vec3(x-fx,y-cy,pz-cz));
        float d111=dot(g111,vec3(x-cx,y-cy,pz-cz));
        float sx=quinticSmooth(x-fx); float sy=quinticSmooth(y-fy); float sz=quinticSmooth(pz-fz);
        float lx00=mix(d000,d100,sx); float lx10=mix(d010,d110,sx);
        float lx01=mix(d001,d101,sx); float lx11=mix(d011,d111,sx);
        return amplitude*mix(mix(lx00,lx10,sy), mix(lx01,lx11,sy), sz);
      }

      float auroraGlow(float t, vec2 shift){
        vec2 uv=gl_FragCoord.xy/uResolution.y;
        uv+=shift;
        float noiseVal=0.0;
        float freq=2.5;      // uNoiseFreq
        float amp=1.0;       // uNoiseAmp
        vec2 samplePos=uv*1.5;   // uScale
        for(int i=0;i<3;i++){
          noiseVal+=perlin3D(amp,freq,samplePos.x,samplePos.y,t);
          amp*=0.1;          // uOctaveDecay
          freq*=2.0;
        }
        float yBand=uv.y*10.0-5.0;   // uBandHeight .5
        return 0.3*max(exp(1.0*(1.0-1.1*abs(noiseVal+yBand))),0.0);
      }

      void main(){
        vec2 uv=gl_FragCoord.xy/uResolution.xy;
        float t=0.6*0.4*uTime;                 // uSpeed .6
        vec2 shift=(uMouse-0.5)*0.25;          // uMouseInfluence
        vec3 c1=mix(vec3(0.99,0.96,1.00),vec3(0.97,0.97,0.97),uDark);
        vec3 c2=mix(vec3(0.55,0.32,0.92),vec3(0.88,0.00,1.00),uDark);
        vec3 col=vec3(0.0);
        col+=0.99*auroraGlow(t,shift)*cosineGradient(uv.x+uTime*0.6*0.2, vec3(0.5),vec3(0.5),vec3(1.0),vec3(0.3,0.20,0.20))*c1;
        col+=0.99*auroraGlow(t,shift)*cosineGradient(uv.x+uTime*0.6*0.1, vec3(0.5),vec3(0.5),vec3(2.0,1.0,0.0),vec3(0.5,0.20,0.25))*c2;
        col*=mix(0.85,1.0,uDark);              // uBrightness
        float alpha=clamp(length(col),0.0,1.0);
        gl_FragColor=vec4(col, alpha);
      }
    `,

    /* ---- 百叶窗 Gradient Blinds ---------------------------------------
       渐变底 + 等宽竖条 + 跟随鼠标的聚光。原版参数：angle 0 / noise .3 /
       blindCount 16 / spotlightRadius .5 / softness 1 / opacity 1。 */
    blinds: `
      precision mediump float;
      varying vec2 vUv; uniform vec2 uResolution; uniform float uTime; uniform float uDark; uniform vec2 uMouse;

      float rand(vec2 co){return fract(sin(dot(co,vec2(12.9898,78.233)))*43758.5453);}

      void main(){
        vec2 uv0=vUv;
        float aspect=uResolution.x/max(1.0,uResolution.y);
        vec2 p=uv0*2.0-1.0;
        p.x*=aspect;
        p.x/=aspect;
        vec2 uv=p*0.5+0.5;

        // 渐变底：两色线性插值（原版 getGradientColor 的 2 色档）
        vec3 g0=mix(vec3(0.99,0.62,0.99),vec3(1.00,0.62,0.99),uDark);
        vec3 g1=mix(vec3(0.42,0.30,0.92),vec3(0.32,0.15,1.00),uDark);
        vec3 base=mix(g0,g1,clamp(uv.x,0.0,1.0));

        // 聚光跟着鼠标
        float d=length(uv0-uMouse);
        float dn=d/0.5;
        float spot=(1.0-2.0*pow(dn,1.0))*mix(0.55,1.0,uDark);
        vec3 cir=vec3(spot);

        float stripe=fract(uv.x*16.0);
        vec3 ran=vec3(stripe)*mix(0.62,1.0,uDark);

        vec3 col=cir+base-ran;
        col+=(rand(gl_FragCoord.xy+uTime)-0.5)*0.3;
        col=clamp(col,0.0,1.0);
        gl_FragColor=vec4(col, mix(0.72,0.92,uDark));
      }
    `,

    /* ---- 波纹 Sliced Waves --------------------------------------------
       网格切片，每格一根来回滑动的横条。原版参数：columns 14 / rows 8 /
       thickness .1 / speed .35 / travel .7 / waveSpread .9 / rowOffset 1 /
       softness .05 / grain .05。原版是 #version 300 es，这里降到 ES 1.00。 */
    waves: `${DERIV}${FW}
      precision highp float;
      varying vec2 vUv; uniform vec2 uResolution; uniform float uTime; uniform float uDark; uniform vec2 uMouse;

      void main(){
        vec2 uv=gl_FragCoord.xy/uResolution.xy;
        vec2 grid=vec2(14.0,8.0);
        vec2 p=uv*grid;
        vec2 gv=fract(p)-0.5;
        vec2 id=floor(p);

        float barCoord=gv.y, waveId=id.x, offId=id.y, along=uv.x;   // 横向

        float dir=1.0;
        if(mod(offId,2.0)>=1.0) dir=-1.0;                            // uAlternate

        float phase=uTime*0.35+waveId*0.9+cos(offId*1.0);
        float mv=sin(phase)*0.5+0.5;
        if(dir<0.0) mv=1.0-mv;

        float md=distance(uv,uMouse);
        float infl=smoothstep(0.3,0.0,md)*1.0;

        float thick=clamp(0.1+infl*0.25,0.0,1.0);
        float startPos=(0.5-thick*0.5)*0.7;
        float endPos=(-0.5+thick*0.5)*0.7;
        float pos=mix(startPos,endPos,mv);

        float d=abs(barCoord+pos)-thick*0.5;
        float edge=max(0.05, fwidth(p.y));
        float mask=smoothstep(edge,-edge,d);
        float intensity=clamp(mask,0.0,1.0);

        float g=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233))+uTime)*43758.5453);
        intensity=clamp(intensity+(g-0.5)*0.05,0.0,1.0);

        vec3 k1=mix(vec3(0.98,0.58,0.96),vec3(1.00,0.62,0.99),uDark);
        vec3 k2=mix(vec3(0.40,0.28,0.90),vec3(0.32,0.15,1.00),uDark);
        vec3 k3=mix(vec3(0.62,0.52,0.82),vec3(0.71,0.59,0.81),uDark);
        vec3 grad=mix(k2,k1,mv);
        grad=mix(grad,k3,clamp(along,0.0,1.0)*0.45);

        vec3 col=clamp(grad*(1.0+infl*0.6),0.0,1.0);
        float a=intensity*mix(0.62,0.85,uDark);
        gl_FragColor=vec4(col, a);
      }
    `,

    /* ---- 地形 Topography ----------------------------------------------
       四条傅里叶控制曲线求距离场，再按等高线切带。控制向量 uCtrlA..D 由 JS
       每帧算好喂进来（原版同样在 JS 里算）。原版参数：morphAmount 3 /
       morphSpeed .05 / speed .35 / bands 2 / thickness .01 / glow .5 /
       contrast 3 / grain .05，colorMode = elevation。 */
    terrain: `${DERIV}${FW}
      precision highp float;
      varying vec2 vUv; uniform vec2 uResolution; uniform float uTime; uniform float uDark; uniform vec2 uMouse;
      uniform vec4 uCtrlA; uniform vec4 uCtrlB; uniform vec4 uCtrlC; uniform vec4 uCtrlD;

      float bez(float t, vec4 c){
        float w=6.2831853*t;
        return 0.5*(c.x*sin(w)+c.y*cos(w)+c.z*sin(2.0*w)+c.w*cos(2.0*w));
      }
      float field(vec2 uv){
        vec2 a=vec2(bez(uv.x,uCtrlA),bez(uv.x,uCtrlB));
        vec2 b=vec2(bez(uv.y,uCtrlC),bez(uv.y,uCtrlD));
        return distance(a,b);
      }

      void main(){
        vec2 res=uResolution.xy;
        vec2 uv=gl_FragCoord.xy/res;
        vec2 suv=uv;                       // uScale 1.0

        vec3 low =mix(vec3(0.42,0.30,0.92),vec3(0.32,0.15,1.00),uDark);
        vec3 mid =mix(vec3(0.93,0.55,0.92),vec3(1.00,0.62,0.99),uDark);
        vec3 high=mix(vec3(0.42,0.62,0.98),vec3(1.00,1.00,1.00),uDark);

        float fv=field(suv);

        vec2 dm=uv-uMouse;
        dm.x*=res.x/max(res.y,1.0);
        float bump=exp(-dot(dm,dm)/(0.3*0.3))*0.4;   // radius .3 / strength .4
        fv+=bump;

        float f=fv*2.0;                    // uBands
        float frac=fract(f);
        float lineDist=min(frac,1.0-frac);

        float aa=fwidth(f)+0.0001;
        float mask=1.0-smoothstep(0.01-aa,0.01+aa,lineDist);
        float glowR=0.01+0.5*0.5+aa;
        float glow=1.0-smoothstep(0.01,glowR,lineDist);

        float elev=clamp(fv/(3.0*2.5+0.001),0.0,1.0);
        vec3 lineCol=mix(low,mid,smoothstep(0.0,0.5,elev));
        lineCol=mix(lineCol,high,smoothstep(0.5,1.0,elev));

        float coverage=clamp(mask+glow*0.55,0.0,1.0);
        coverage=pow(coverage,3.0);        // uContrast

        float g=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233))+uTime)*43758.5453);
        float a=clamp(coverage+(g-0.5)*0.05,0.0,1.0);
        gl_FragColor=vec4(clamp(lineCol,0.0,1.0), a*mix(0.80,0.95,uDark));
      }
    `,
  };

  let program = null, frame = 0, started = performance.now(), current = '', positionBuffer = null;
  const mouse = { x: .5, y: .5, tx: .5, ty: .5 };
  // Topography 的四组控制向量：原版每帧在 JS 里算，这里照搬那套系数
  const CTRL_INDICES = [[1, -2, 3, -4], [9, -8, 7, -6], [5, 2, 5, -5], [-1, -3, 8, 9]];
  const ctrl = [new Float32Array(4), new Float32Array(4), new Float32Array(4), new Float32Array(4)];

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
  function uniform4v(n, v) { const l = loc(n); if (l !== null) gl.uniform4fv(l, v); }

  function draw(now) {
    frame = 0;
    if (!program || !SHADERS.includes(current)) return;
    resize();
    mouse.x += (mouse.tx - mouse.x) * .055;
    mouse.y += (mouse.ty - mouse.y) * .055;
    const time = REDUCED.matches ? 0 : (now - started) / 1000;
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
    uniform1('uTime', time);
    if (current === 'terrain') {
      for (let g = 0; g < 4; g++) {
        const arr = ctrl[g], idx = CTRL_INDICES[g];
        for (let j = 0; j < 4; j++) {
          const i = idx[j];
          arr[j] = 3.0 * Math.sin(time * 0.35 * Math.sin(i * 0.05) + i);
        }
      }
      uniform4v('uCtrlA', ctrl[0]); uniform4v('uCtrlB', ctrl[1]);
      uniform4v('uCtrlC', ctrl[2]); uniform4v('uCtrlD', ctrl[3]);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (!REDUCED.matches && !document.hidden) frame = requestAnimationFrame(draw);
  }

  const selected = () => (LOGIN ? 'aurora' : (document.documentElement.dataset.bg || 'none'));
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
