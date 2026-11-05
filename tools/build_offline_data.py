from pathlib import Path
import xml.etree.ElementTree as E,json
r=E.parse('work/osm.xml').getroot();nodes={n.get('id'):[float(n.get('lat')),float(n.get('lon'))] for n in r.findall('node')}
features=[];edges=[];graphnodes={};labels=[];named=set();bbox=[30.875,121.88,30.91,121.91]
def inside(p):return bbox[0]<=p[0]<=bbox[2] and bbox[1]<=p[1]<=bbox[3]
for w in r.findall('way'):
 t={x.get('k'):x.get('v') for x in w.findall('tag')};ids=[x.get('ref') for x in w.findall('nd')];c=[nodes[i] for i in ids if i in nodes]
 if len(c)!=len(ids) or len(c)<2 or not any(inside(p) for p in c):continue
 closed=ids[0]==ids[-1];kind=''
 if t.get('natural')=='water' or t.get('waterway')=='riverbank':kind='water'
 elif t.get('waterway'):kind='stream'
 elif t.get('building'):kind='building'
 elif t.get('landuse') in ['grass','forest','recreation_ground'] or t.get('leisure') in ['park','pitch','garden']:kind='green'
 elif t.get('highway'):kind='walk' if t['highway'] in ['footway','path','pedestrian','steps'] else 'road'
 if kind:features.append({'type':'Feature','properties':{'kind':kind,'name':t.get('name',''),'highway':t.get('highway','')},'geometry':{'type':'Polygon' if closed and kind in ['water','building','green'] else 'LineString','coordinates':[[[p[1],p[0]] for p in c]] if closed and kind in ['water','building','green'] else [[p[1],p[0]] for p in c]}})
 name=t.get('name','')
 if name and name not in named and kind=='road' and inside(c[len(c)//2]):labels.append([*c[len(c)//2],name]);named.add(name)
 h=t.get('highway');access=t.get('access')
 if h and h not in ['motorway','motorway_link','trunk','trunk_link','construction','proposed','raceway'] and t.get('foot')!='no' and (access not in ['no','private'] or t.get('foot') in ['yes','designated','permissive']):
  for a,b in zip(ids,ids[1:]):
   if inside(nodes[a]) and inside(nodes[b]):
    graphnodes[a]=nodes[a];graphnodes[b]=nodes[b];edges.append([a,b,1 if h in ['footway','path','pedestrian','steps'] else 1.15])
labels.extend([[30.88469,121.89265,'上海海洋大学'],[30.8978749,121.892007,'龙光蓝鲸世界'],[30.8891641,121.89634,'海大 1 号门']])
data={'bounds':[[bbox[0],bbox[1]],[bbox[2],bbox[3]]],'map':{'type':'FeatureCollection','features':features},'labels':labels,'nodes':graphnodes,'edges':edges}
out=Path('outputs/RunLab/app/src/main/assets/offline-data.js');out.write_text('window.RunOfflineData='+json.dumps(data,ensure_ascii=False,separators=(',',':'))+';',encoding='utf-8');print('features',len(features),'nodes',len(graphnodes),'edges',len(edges),'bytes',out.stat().st_size)
