// TSX modules use the exact same GPU scene contract; JSX is not rasterized.
import { shaderScene } from "./shaderScene";
export default function createMain() {
  return shaderScene(
    /* wgsl */ `
@fragment fn fragment(@builtin(position) position:vec4f)->@location(0) vec4f {
 let uv=position.xy/u.resolution;let p=(uv-.5)*vec2f(u.resolution.x/u.resolution.y,1.);
 var col=background(uv)+orbit(p*(1.05+sin(u.time*.7)*.12),u.time+2.);
 let r=length(p);let core=exp(-r*18.);col+=vec3f(.2,.26,.64)*core;
 let a=atan2(p.y,p.x);let segments=pow(max(0.,cos(a*6.+u.time)),30.);
 col+=vec3f(.25,.65,.8)*segments*exp(-abs(r-.32)*140.)*.5;
 col=mix(col,vec3f(.64,.71,.9),text(uv,vec2f(.5,.86),.023)*.7);
 return vec4f(col,1.);
}`,
    "PURE GEOMETRY",
    1,
  );
}
