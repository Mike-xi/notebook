// React Bits 风格的轻量 WebGL 背景。仅主页创建一个画布，不引入运行时依赖。
(function () {
  if (!document.body.classList.contains('home')) return;
  const VALID = new Set(['aurora', 'balatro']);
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');
  const canvas = document.createElement('canvas');
  canvas.id = 'nb-background-canvas';
  canvas.className = 'nb-background-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);

  const gl = canvas.getContext('webgl', {
    alpha: true, antialias: false, depth: false, stencil: false,
    powerPreference: 'low-power', premultipliedAlpha: false,
  });
  if (!gl) {
    canvas.remove();
    document.documentElement.classList.add('nb-bg-fallback');
    return;
  }

  const vertex = `
    attribute vec2 aPosition;
    varying vec2 vUv;
    void main(){vUv=aPosition*0.5+0.5;gl_Position=vec4(aPosition,0.0,1.0);}
  `;

  const fragments = {
    aurora: `
      precision highp float;
      varying vec2 vUv; uniform vec2 uResolution; uniform float uTime;
      vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
      vec2 mod289(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}
      vec3 permute(vec3 x){return mod289(((x*34.0)+1.0)*x);}
      float snoise(vec2 v){
        const vec4 C=vec4(.2113248654,.3660254038,-.5773502692,.0243902439);
        vec2 i=floor(v+dot(v,C.yy)); vec2 x0=v-i+dot(i,C.xx);
        vec2 i1=x0.x>x0.y?vec2(1.,0.):vec2(0.,1.);
        vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1; i=mod289(i);
        vec3 p=permute(permute(i.y+vec3(0.,i1.y,1.))+i.x+vec3(0.,i1.x,1.));
        vec3 m=max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.);
        m=m*m; m=m*m; vec3 x=2.*fract(p*C.www)-1.; vec3 h=abs(x)-.5;
        vec3 ox=floor(x+.5); vec3 a0=x-ox;
        m*=1.792842914-.853734721*(a0*a0+h*h);
        vec3 g; g.x=a0.x*x0.x+h.x*x0.y; g.yz=a0.yz*x12.xz+h.yz*x12.yw;
        return 130.*dot(m,g);
      }
      vec3 ramp(float x){
        vec3 a=vec3(.486,1.,.404),b=vec3(.706,.592,.812),c=vec3(.322,.153,1.);
        return x<.5?mix(a,b,x*2.):mix(b,c,(x-.5)*2.);
      }
      void main(){
        vec2 uv=vUv; float n=snoise(vec2(uv.x*2.15+uTime*.055,uTime*.11));
        float crest=.54+n*.18+sin(uv.x*5.2-uTime*.16)*.035;
        float band=1.-smoothstep(0.,.34,abs(uv.y-crest));
        float veil=1.-smoothstep(0.,.62,abs(uv.y-crest));
        float shimmer=.72+.28*snoise(vec2(uv.x*5.-uTime*.08,uv.y*2.));
        vec3 color=ramp(clamp(uv.x+n*.11,0.,1.))*(band*.78+veil*.2)*shimmer;
        gl_FragColor=vec4(color,clamp(band*.66+veil*.12,0.,.78));
      }
    `,
    balatro: `
      precision highp float;
      varying vec2 vUv; uniform vec2 uResolution; uniform float uTime; uniform vec2 uMouse;
      void main(){
        float pixelSize=length(uResolution)/680.;
        vec2 screen=(floor(vUv*uResolution/pixelSize)+.5)*pixelSize;
        vec2 uv=(2.*screen-uResolution)/length(uResolution);
        float speed=uTime*.34,uvLen=length(uv);
        float angle=-1.8+(uMouse.x-.5)*1.3+speed-.65*uvLen;
        uv=mat2(cos(angle),-sin(angle),sin(angle),cos(angle))*uv;
        vec3 color=vec3(0.); vec3 c1=vec3(.49,.15,1.),c2=vec3(.03,.55,1.),c3=vec3(.04,.08,.16);
        for(float i=0.;i<5.;i++){
          float j=i+1.; uv+=sin(uv.yx*j+speed)*.22/j+cos(uv.xy*j-speed)*.09/j;
          float pattern=1.-abs(sin(length(uv)+i*.38-speed))*.82;
          color+=mix(c3,mix(c1,c2,fract(i*.37+length(uv))),pattern)/3.2;
        }
        color=pow(max(color,0.),vec3(1.18))*1.22;
        gl_FragColor=vec4(color,.72);
      }
    `,
  };

  let program=null,frame=0,started=performance.now(),current='',positionBuffer=null;
  const mouse={x:.5,y:.5,tx:.5,ty:.5};

  function compile(type,source){
    const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){
      const message=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw new Error(message||'shader compile failed');
    } return shader;
  }

  function build(name){
    cancelAnimationFrame(frame);frame=0;current=name;canvas.hidden=!VALID.has(name);
    if(!VALID.has(name))return;
    try{
      const next=gl.createProgram(),vs=compile(gl.VERTEX_SHADER,vertex),fs=compile(gl.FRAGMENT_SHADER,fragments[name]);
      gl.attachShader(next,vs);gl.attachShader(next,fs);gl.linkProgram(next);gl.deleteShader(vs);gl.deleteShader(fs);
      if(!gl.getProgramParameter(next,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(next));
      if(program)gl.deleteProgram(program);program=next;
      if(!positionBuffer){
        positionBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
      }
      started=performance.now();resize();draw(performance.now());
    }catch(error){
      canvas.hidden=true;document.documentElement.classList.add('nb-bg-fallback');
      console.warn('Background shader unavailable:',name,error);
    }
  }

  function resize(){
    const compact=innerWidth<720,dpr=Math.min(devicePixelRatio||1,compact?1:1.45);
    const width=Math.max(1,Math.floor(innerWidth*dpr)),height=Math.max(1,Math.floor(innerHeight*dpr));
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;gl.viewport(0,0,width,height);}
  }
  function uniform2(name,x,y){const location=gl.getUniformLocation(program,name);if(location!==null)gl.uniform2f(location,x,y);}
  function uniform1(name,value){const location=gl.getUniformLocation(program,name);if(location!==null)gl.uniform1f(location,value);}

  function draw(now){
    frame=0;if(!program||!VALID.has(current))return;resize();
    mouse.x+=(mouse.tx-mouse.x)*.055;mouse.y+=(mouse.ty-mouse.y)*.055;
    gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(program);gl.bindBuffer(gl.ARRAY_BUFFER,positionBuffer);
    const position=gl.getAttribLocation(program,'aPosition');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
    uniform2('uResolution',canvas.width,canvas.height);uniform2('uMouse',mouse.x,mouse.y);
    uniform1('uTime',REDUCED.matches?0:(now-started)/1000);
    gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.drawArrays(gl.TRIANGLES,0,6);
    if(!REDUCED.matches&&!document.hidden)frame=requestAnimationFrame(draw);
  }

  const selected=()=>document.documentElement.dataset.bg||'none';
  addEventListener('pointermove',(event)=>{
    mouse.tx=event.clientX/Math.max(1,innerWidth);mouse.ty=1-event.clientY/Math.max(1,innerHeight);
  },{passive:true});
  addEventListener('resize',resize,{passive:true});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&VALID.has(current)&&!frame)frame=requestAnimationFrame(draw);});
  addEventListener('nb-background-change',(event)=>build(event.detail.background));
  REDUCED.addEventListener('change',()=>build(selected()));
  build(selected());
})();
