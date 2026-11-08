(function(root){'use strict';
const store = new Map();
let known = null, readiness = null;
function ready() {
  if (!readiness) {
    readiness = fetch('shanghai/manifest.json').then(r => {
      if (!r.ok) throw Error('离线地图索引读取失败');
      return r.json();
    }).then(m => {
      if (!Array.isArray(m.tile_keys)) throw Error('离线地图索引无效');
      known = new Set(m.tile_keys);
      return m;
    }).catch(error => { readiness = null; throw error; });
  }
  return readiness;
}
function getTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (store.has(key)) {
    const cached = store.get(key);
    store.delete(key);
    store.set(key, cached);
    return cached;
  }
  const promise = ready().then(() => {
    if (!known.has(key)) return [];
    return fetch('shanghai/' + key + '.json').then(r => {
      if (!r.ok) throw Error('离线分块读取失败');
      return r.json();
    });
  }).catch(error => {
    // Failed promises must not poison the LRU for the lifetime of the app.
    if (store.get(key) === promise) store.delete(key);
    throw error;
  });
  store.set(key, promise);
  if (store.size > 64) store.delete(store.keys().next().value);
  return promise;
}
function install(map){map.createPane('offline');map.getPane('offline').style.zIndex=190;const NativeLayer=L.GridLayer.extend({createTile(c,done){const canvas=document.createElement('canvas'),dpr=Math.min(window.devicePixelRatio||1,2);canvas.width=canvas.height=256*dpr;canvas.style.width=canvas.style.height='256px';const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);ctx.fillStyle='#f1f1e8';ctx.fillRect(0,0,256,256);const level=c.z<12?9:c.z<15?12:14,scale=2**(c.z-level),sx=Math.floor(c.x/scale),sy=Math.floor(c.y/scale);getTile(level,sx,sy).then(fs=>{const point=p=>[(p[0]/4096*scale+sx*scale-c.x)*256,(p[1]/4096*scale+sy*scale-c.y)*256];const occupied=[];function label(text,p,size,color){if(!text||text.length>26)return;const [x,y]=p;if(x<8||y<10||x>248||y>246)return;ctx.font=`${size}px sans-serif`;const w=ctx.measureText(text).width,b=[x-w/2,y-size/2,x+w/2,y+size/2];if(occupied.some(a=>b[0]<a[2]+5&&b[2]>a[0]-5&&b[1]<a[3]+4&&b[3]>a[1]-4))return;occupied.push(b);ctx.textAlign='center';ctx.textBaseline='middle';ctx.lineWidth=3;ctx.strokeStyle='#fffdf4';ctx.strokeText(text,x,y);ctx.fillStyle=color;ctx.fillText(text,x,y);}
const labels=[];
for(const [kind,name,minz,type,coords] of fs){if(minz>c.z)continue;if(type==='Point'){labels.push([name,point(coords),kind==='label'?12:10,'#4b6257']);continue;}const polygon=type.includes('Polygon');const groups=type==='Polygon'?[coords]:type==='MultiPolygon'?coords:type==='LineString'?[[coords]]:coords.map(p=>[p]);
ctx.fillStyle=({water:'#b1d5e4',green:'#d8e5c8',campus:'#e6e8d8',building:'#d9d5cb'})[kind]||'#f1f1e8';
for(const rings of groups){ctx.beginPath();for(const ring of rings){ring.forEach((p,i)=>{const [x,y]=point(p);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});if(polygon)ctx.closePath();}if(polygon){ctx.fill('evenodd');if(kind==='building'){ctx.lineWidth=.6;ctx.strokeStyle='#bfbdb4';ctx.stroke();}}else{ctx.lineJoin='round';ctx.lineCap='round';if(kind==='road'){ctx.setLineDash([]);ctx.lineWidth=c.z>=16?7:4;ctx.strokeStyle='#d6c9a5';ctx.stroke();ctx.lineWidth=c.z>=16?5:2.5;ctx.strokeStyle='#fffdf4';}else{ctx.lineWidth=kind==='walk'?1.8:kind==='stream'?2:1;ctx.strokeStyle=kind==='walk'?'#b99b73':kind==='stream'?'#a0c8db':'#a4a29d';ctx.setLineDash(kind==='walk'?[3,3]:kind==='rail'?[5,4]:[]);}ctx.stroke();ctx.setLineDash([]);}}
if(name&&kind==='road'&&c.z>=13){let line=type==='LineString'?coords:type==='MultiLineString'?coords[0]:null;if(line?.length>1){const p=point(line[Math.floor(line.length/2)]);labels.push([name,p,10,'#7e7868']);}}
if(name&&polygon&&c.z>=16){const r=type==='Polygon'?coords[0]:coords[0]?.[0];if(r?.length){const ps=r.map(point),p=[ps.reduce((s,p)=>s+p[0],0)/ps.length,ps.reduce((s,p)=>s+p[1],0)/ps.length];labels.push([name,p,10,'#6b7167']);}}
}for(const l of labels)label(...l);done(null,canvas);}).catch(e=>{ctx.fillStyle='#6c776b';ctx.font='12px sans-serif';ctx.fillText('离线分块加载失败',35,120);done(e,canvas);});return canvas;}});
const offline = new NativeLayer({pane:'offline', minZoom:9, maxZoom:20, keepBuffer:1,
  attribution:'离线数据 © OpenStreetMap contributors / Geofabrik'}).addTo(map);
const controls = RunOnline.install(map, offline);
ready().then(controls.setOfflineState).catch(() => controls.setOfflineState(null));
return controls;
}
root.RunOffline = {install, ready};
})(window);
