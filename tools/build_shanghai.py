import osmium, json, math, pathlib, hashlib, time
from shapely.geometry import LineString,Point,shape,box,mapping
from shapely.ops import transform
from shapely import make_valid
from collections import defaultdict
src=pathlib.Path('work/shanghai/shanghai-latest.osm.pbf')
out=pathlib.Path('outputs/RunLab/app/src/main/assets/shanghai');out.mkdir(exist_ok=True)
factory=osmium.geom.GeoJSONFactory();tiles=defaultdict(list);counts=defaultdict(int)
def project(x,y,z=None):return ((x+180)/360,(1-math.asinh(math.tan(math.radians(max(-85,min(85,y)))))/math.pi)/2)
def quantize(coords,x,y,n):
 if len(coords)>0 and isinstance(coords[0],(int,float)):
  return [round((coords[0]*n-x)*4096),round((coords[1]*n-y)*4096)]
 return [quantize(v,x,y,n) for v in coords]
def add(geom,kind,name,minz):
 if geom.is_empty:return
 try:g=transform(project,geom)
 except Exception:return
 if not g.is_valid:g=make_valid(g)
 for z in [9,12,14]:
  if minz>(11 if z==9 else 14 if z==12 else 19):continue
  n=2**z;simple=g.simplify(.25/(256*n),preserve_topology=True);a,b,c,d=simple.bounds
  for x in range(math.floor(a*n),math.floor(c*n)+1):
   for y in range(math.floor(b*n),math.floor(d*n)+1):
    clip=simple.intersection(box(x/n,y/n,(x+1)/n,(y+1)/n))
    if clip.is_empty:continue
    def emit(part):
     if part.geom_type=='GeometryCollection':
      for sub in part.geoms:emit(sub)
     elif part.geom_type in ['Polygon','MultiPolygon','LineString','MultiLineString','Point']:
      m=mapping(part);tiles[z,x,y].append([kind,name,minz,m['type'],quantize(m['coordinates'],x,y,n)])
    emit(clip)
 counts[kind]+=1
class Reader(osmium.SimpleHandler):
 def node(self,n):
  t=n.tags;place=t.get('place','');name=t.get('name:zh',t.get('name',''))
  if place in ['city','town','suburb','quarter','village'] and name:add(Point(n.location.lon,n.location.lat),'label',name,9 if place=='city' else 11 if place in ['town','suburb'] else 14)
 def way(self,w):
  t=w.tags;h=t.get('highway','');kind='';mz=9
  if h:
   kind='walk' if h in ['footway','path','pedestrian','steps','cycleway'] else 'road'
   mz=15 if kind=='walk' else 14 if h in ['service','track'] else 12 if h in ['residential','unclassified','living_street'] else 9
  elif t.get('waterway',''):kind='stream';mz=12
  elif t.get('railway','') in ['rail','subway','light_rail']:kind='rail';mz=12
  elif t.get('natural','')=='coastline':kind='stream';mz=9
  if not kind:return
  c=[(n.lon,n.lat) for n in w.nodes if n.location.valid()]
  if len(c)<2:return
  add(LineString(c),kind,t.get('name:zh',t.get('name','')),mz)
 def area(self,a):
  t=a.tags;kind='';mz=9
  if t.get('natural','')=='water' or t.get('waterway','')=='riverbank':kind='water'
  elif t.get('building',''):kind='building';mz=15
  elif t.get('landuse','') in ['grass','forest','recreation_ground','meadow'] or t.get('leisure','') in ['park','garden','pitch']:kind='green';mz=12
  elif t.get('amenity','') in ['university','school']:kind='campus';mz=12
  if not kind:return
  try:g=shape(json.loads(factory.create_multipolygon(a)))
  except Exception:return
  name=t.get('name:zh',t.get('name',''));add(g,kind,name,mz)
  if name and kind=='campus':add(g.representative_point(),'label',name,14)
print('Processing Shanghai PBF',flush=True)
r=Reader();r.apply_file(str(src),locations=True,idx='flex_mem')
order={'green':0,'campus':1,'water':2,'building':3,'stream':4,'rail':5,'road':6,'walk':7,'label':8}
for (z,x,y),features in tiles.items():
 p=out/str(z)/str(x);p.mkdir(parents=True,exist_ok=True)
 features.sort(key=lambda a:order[a[0]])
 (p/(str(y)+'.json')).write_text(json.dumps(features,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
manifest={'region':'上海市（Geofabrik 上海区域提取）','source':'https://download.geofabrik.de/asia/china/shanghai.html','license':'ODbL 1.0 © OpenStreetMap contributors','levels':[9,12,14],'bounds':[[30.65,120.8],[31.9,122.15]],'counts':dict(counts),'tile_count':len(tiles),'pbf_sha256':hashlib.sha256(src.read_bytes()).hexdigest(),'tile_keys':[f'{z}/{x}/{y}' for z,x,y in tiles]}
(out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
print('DONE',dict(counts),'tiles',len(tiles),'MB',round(sum(p.stat().st_size for p in out.rglob('*.json'))/1e6,1),flush=True)
