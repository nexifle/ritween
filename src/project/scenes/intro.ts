import { shaderScene } from "./shaderScene";
export default function createIntro() {
  return shaderScene(
    /* wgsl */ `
@fragment fn fragment(@builtin(position) position:vec4f)->@location(0) vec4f {
 let uv=position.xy/u.resolution;let p=(uv-.5)*vec2f(u.resolution.x/u.resolution.y,1.);
 var col=background(uv)+orbit(p*1.3,u.time)*.48;
 let reveal=smoothstep(0.,.55,u.time);let mask=text(uv,vec2f(.5,.47),.055)*smoothstep(uv.x-.02,uv.x+.02,u.progress*2.8);
 col=mix(col,vec3f(.91,.91,1.),mask*reveal);
 let line=(1.-smoothstep(.001,.003,abs(uv.y-.60)))*step(abs(uv.x-.5),.22*reveal);
 col+=vec3f(.56,.42,.9)*line;
 return vec4f(col,1.);
}`,
    "SOURCE TO MOTION",
    0,
  );
}
