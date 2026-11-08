(function(root){'use strict';
const R=6371000,rad=x=>x*Math.PI/180;
function hav(a,b){const x=Math.sin(rad(b[0]-a[0])/2)**2+Math.cos(rad(a[0]))*Math.cos(rad(b[0]))*Math.sin(rad(b[1]-a[1])/2)**2;return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));}
function lengths(c){let d=[0];for(let i=1;i<c.length;i++)d.push(d[i-1]+hav(c[i-1],c[i]));return d;}
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const clamp=(x,lo,hi)=>Math.min(hi,Math.max(lo,x));
// Continuous effort model with optional coefficients fitted from recorded GPS speeds.
function build(c,o){
  if(c.length<2)throw Error('请先规划路线');
  const ds=lengths(c),distance=ds.at(-1),duration=+o.duration;
  if(!Number.isFinite(duration)||duration<10||duration>21600)throw Error('时长须在 10 秒至 6 小时之间');
  if(distance<10||distance>100000)throw Error('路线长度须在 10 米至 100 公里之间');
  const pace=duration*1000/distance;
  if(pace<180||pace>900)throw Error('当前起止时间对应配速超出 3–15 分钟/公里，请调整');
  if(!Number.isFinite(o.start)||o.cadence<60||o.cadence>240||o.hr<40||o.hr>220)throw Error('运动参数无效');

  const T=Math.round(duration),vmean=distance/T;
  const V=Math.max(0,Number.isFinite(+o.variation)?+o.variation:0)/100;
  const seed=Number.isFinite(+o.seed)?+o.seed:Math.floor(Math.random()*2147483647),rng=mulberry32((seed^0x5bd1e995)>>>0);
  const gauss=()=>Math.sqrt(-2*Math.log(1-rng()))*Math.cos(2*Math.PI*rng());

  // 1. Effort model. Up to 3 passes: each pass is rescaled by the previous pass's distance solve, so the pace the
  //    "runner" perceives (and compares with 8:00/km) is the same pace that ends up on the chart.
  const minSpeed=.5,maxSpeed=6.5,fadeLen=Math.min(60,Math.floor(T/4));
  const F=V?(Number.isFinite(+o.fatigue)?clamp(+o.fatigue,0,.2):.06):0;   // gradual slow-down (log speed) reached at the end of the run
  const profile=o.paceProfile;
  const personal=profile&&[profile.slow,profile.fast,profile.tau].every(Number.isFinite);
  const strength=V/.04;
  const a1=Math.exp(-1/(personal?clamp(profile.tau,8,90):40)),a2=Math.exp(-1/8);
  const s1=personal?clamp(profile.slow,0,.2)*strength:V*1.1;
  const s2=personal?clamp(profile.fast,0,.08)*strength:V*.2;
  function simulate(g){
    const r=mulberry32(seed),gs=()=>Math.sqrt(-2*Math.log(1-r()))*Math.cos(2*Math.PI*r()),vm=vmean*g,v=new Float64Array(T);
    let x=0,f=0,slow=0,slowLeft=0,slowDepth=0,velocity=vm,perceived=vm,slowSeconds=0,correcting=false,boost=0;
    const reaction=5+Math.floor(r()*5);
    for(let i=0;i<T;i++){
      const prog=i/T;
      x=a1*x+s1*Math.sqrt(1-a1*a1)*gs();f=a2*f+s2*Math.sqrt(1-a2*a2)*gs();
      if(V&&o.stops===true){if(slowLeft>0)slowLeft--;else if(r()<1/300){slowLeft=4+Math.floor(r()*12);slowDepth=.1+r()*.3;}slow+=((slowLeft>0?-slowDepth:0)-slow)*.15;}
      perceived+=(velocity-perceived)/6;
      // the runner only starts policing pace after the first quarter of the run
      const active=o.surges!==false&&pace<=480&&prog>=.25&&i<T-fadeLen;
      if(active){slowSeconds=1000/perceived>480?slowSeconds+1:Math.max(0,slowSeconds-1);if(!correcting&&slowSeconds>=reaction)correcting=true;if(correcting&&1000/perceived<Math.min(455,pace+5)){correcting=false;slowSeconds=0;}}
      else{correcting=false;slowSeconds=0;}
      const phase=clamp((prog-.3)/.4,0,1),desiredBoost=correcting?Math.min(.2,(.08+Math.max(0,(1000/perceived-480)/480)*1.2)*(1+phase*.6)):0;
      boost+=(desiredBoost-boost)/(correcting?6:12);                 // quick push, slower release -> a spike, not a hill
      const drift=-F*Math.pow(clamp((prog-.15)/.85,0,1),1.3);        // fatigue: what actually drags the runner into the easy zone
      const target=vm*Math.exp(clamp(x+f+slow+drift,-.7,.7))*(1+boost);
      velocity+=clamp((target-velocity)*.15,-.06,.05);v[i]=velocity;
    }
    if(o.finishSlow!==false&&T>=30){const begin=T-fadeLen,startSpeed=v[begin],endSpeed=Math.min(v[0]*.78,startSpeed);for(let j=0;j<fadeLen;j++){const u=j/(fadeLen-1),w=u*u*(3-2*u);v[begin+j]=startSpeed+(endSpeed-startSpeed)*w;}}
    // The generic model adds measurement-like variation. The personal model uses its fitted speed variation.
    const R=V&&!personal?(Number.isFinite(+o.roughness)?clamp(+o.roughness,0,3):1):0;
    if(R){const ar=.55,k=Math.sqrt(1-ar*ar),decay=Math.exp(-1/2.5);let n=0,ev=0;
      for(let i=0;i<T;i++){
        n=ar*n+k*V*.42*R*gs();
        ev*=decay;
        if(r()<1/55)ev+=clamp(gs()*V*2.2*R,-.18,.18);
        v[i]*=Math.exp(n+ev);
      }}
    return v;
  }
  // Solve the distance constraint with bounds applied AFTER scaling.
  function solve(v){let low=0,high=20;for(let k=0;k<60;k++){const sc=(low+high)/2;let sum=0;for(const s of v)sum+=clamp(s*sc,minSpeed,maxSpeed);if(sum<distance)low=sc;else high=sc;}return(low+high)/2;}
  let g=1,v;
  for(let pass=0;pass<3;pass++){v=simulate(g);const sc=solve(v);if(pass<2)g*=sc;else{for(let i=0;i<T;i++)v[i]=clamp(v[i]*sc,minSpeed,maxSpeed);}}

  const dist=new Float64Array(T+1);for(let i=0;i<T;i++)dist[i+1]=dist[i]+v[i];dist[T]=distance;

  // 4. per-sample channels
  const jit=Number.isFinite(+o.jitter)?clamp(+o.jitter,0,5):(V?.7:0),rho=.95,jk=Math.sqrt(1-rho*rho);
  const dropout=Number.isFinite(+o.dropout)?clamp(+o.dropout,0,.2):.012;
  let jx=0,jy=0,j=0,ema=v[0],hr=o.hr*.82,alt=0,dropped=false;
  const points=[];
  for(let i=0;i<=T;i++){
    const spd=v[Math.min(i?i-1:0,T-1)];
    ema+=(spd-ema)/12;
    hr+=(o.hr*clamp(1+.45*(ema/vmean-1),.8,1.15)-hr)/30;   // heart rate lags pace
    alt=alt*.995+(V?.05*gauss():0);
    jx=rho*jx+jk*jit*gauss();jy=rho*jy+jk*jit*gauss();
    const keep=i===0||i===T||dropped||rng()>=dropout; dropped=!keep;
    if(!keep)continue;
    const d=dist[i];while(j<ds.length-2&&ds[j+1]<d)j++;
    const gap=ds[j+1]-ds[j],fr=gap?(d-ds[j])/gap:0;
    let lat=c[j][0]+(c[j+1][0]-c[j][0])*fr,lon=c[j][1]+(c[j+1][1]-c[j][1])*fr;
    if(i>0&&i<T){lat+=jy/111320;lon+=jx/(111320*Math.cos(rad(lat)));} // GPS error lives in the position domain
    points.push({lat,lon,time:o.start+i*1000,distance:d,speed:spd,
      cadence:Math.round(clamp(o.cadence*clamp(1+.35*(ema/vmean-1),.7,1.2)+(V?1.2*gauss():0),60,240)),
      hr:Math.round(clamp(hr+(V?.8*gauss():0),40,220)),
      altitude:Math.round((o.altitude+alt)*5)/5});
  }
  return {points,distance,duration:T,pace:T*1000/distance,title:o.title||'RunLab Simulation',offset:o.offset||0};
}
const esc=s=>String(s).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
function gpx(a){return '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="RunLab" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><metadata><desc>Simulated activity generated by RunLab</desc><time>'+new Date(a.points[0].time).toISOString()+'</time></metadata><trk><name>'+esc(a.title)+'</name><type>running</type><trkseg>'+a.points.map(p=>`<trkpt lat="${p.lat.toFixed(8)}" lon="${p.lon.toFixed(8)}"><ele>${p.altitude.toFixed(1)}</ele><time>${new Date(p.time).toISOString()}</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${p.hr}</gpxtpx:hr><gpxtpx:cad>${p.cadence}</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions></trkpt>`).join('\n')+'</trkseg></trk></gpx>';}
function crc(bytes){let c=0;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=c&1?(c>>>1)^0xa001:c>>>1;}return c;}
function fit(a){let data=[];const u16=n=>[n&255,(n>>>8)&255],u32=n=>[n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255];
function msg(global,fields,values){data.push(0x40,0,0,...u16(global),fields.length);for(const [num,type] of fields)data.push(num,type===2||type===0?1:type===0x84?2:4,type);data.push(0);values.forEach((v,i)=>{const t=fields[i][1];data.push(...(t===2||t===0?[Math.round(v)&255]:t===0x84?u16(Math.round(v)):u32(Math.round(v))));});}
const epoch=Date.UTC(1989,11,31),ts=p=>Math.floor((p.time-epoch)/1000),p=a.points,s=p[0],e=p.at(-1),avg=k=>p.reduce((t,x)=>t+x[k],0)/p.length,max=k=>Math.max(...p.map(x=>x[k])),sc=x=>x*2147483648/180;
msg(0,[[0,0],[1,0x84],[2,0x84],[4,0x86]],[4,255,1,ts(s)]);
msg(12,[[0,0],[1,0]],[1,0]);
msg(21,[[253,0x86],[0,0],[1,0]],[ts(s),0,0]);
for(const v of p)msg(20,[[253,0x86],[0,0x85],[1,0x85],[2,0x84],[3,2],[4,2],[5,0x86],[6,0x84],[53,2],[85,0x84]],[ts(v),sc(v.lat),sc(v.lon),(v.altitude+500)*5,v.hr,Math.floor(v.cadence/2),v.distance*100,v.speed*1000,(v.cadence/2%1)*128,v.speed*600000/v.cadence]);
msg(21,[[253,0x86],[0,0],[1,0]],[ts(e),0,4]);
msg(19,[[253,0x86],[2,0x86],[7,0x86],[8,0x86],[9,0x86],[13,0x84],[15,2],[17,2],[25,0]],[ts(e),ts(s),a.duration*1000,a.duration*1000,a.distance*100,a.distance/a.duration*1000,avg('hr'),avg('cadence')/2,1]);
msg(18,[[253,0x86],[2,0x86],[5,0],[6,0],[7,0x86],[8,0x86],[9,0x86],[14,0x84],[15,0x84],[16,2],[17,2],[18,2],[19,2],[25,0x84],[26,0x84]],[ts(e),ts(s),1,0,a.duration*1000,a.duration*1000,a.distance*100,a.distance/a.duration*1000,max('speed')*1000,avg('hr'),max('hr'),avg('cadence')/2,max('cadence')/2,0,1]);
msg(34,[[253,0x86],[0,0x86],[1,0x84],[2,0],[3,0],[4,0],[5,0x86]],[ts(e),a.duration*1000,1,0,26,1,ts(e)+a.offset*3600]);
const h=[14,0x20,...u16(2180),...u32(data.length),46,70,73,84];h.push(...u16(crc(h)));const bytes=[...h,...data];return new Uint8Array([...bytes,...u16(crc(bytes))]);}
root.RunCore={hav,lengths,build,gpx,fit,crc};if(typeof module!=='undefined')module.exports=root.RunCore;
})(globalThis);
