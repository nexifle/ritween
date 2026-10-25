import { shaderScene } from "./shaderScene";
export default function createOutro() {
  return shaderScene(
    /* wgsl */ `
@fragment fn fragment(@builtin(position) position:vec4f)->@location(0) vec4f {
 let uv=position.xy/u.resolution;let p=(uv-.5)*vec2f(u.resolution.x/u.resolution.y,1.);
 var col=background(uv)+orbit(p*(1.+u.progress*2.),u.time+6.)*(1.-u.progress)*.7;
 let fade=smoothstep(0.,.4,u.time)*(1.-smoothstep(.8,1.,u.progress));
 col=mix(col,vec3f(.9,.88,1.),text(uv,vec2f(.5,.48),.075)*fade);
 return vec4f(col,1.);
}`,
    "MADE OF CODE",
    2,
  );
}
