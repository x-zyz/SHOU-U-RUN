(function(root){
const zones=[['高强度间歇',180,376,'#fa6070'],['无氧耐力',376,405,'#ffb454'],['乳酸阈值',405,443,'#a4d546'],['马拉松',443,477,'#19bf91'],['轻松跑',477,539,'#5b80f5'],['缓和热身',539,900,'#a5baf8']];
function classify(pace){return zones.findIndex((z,i)=>(i===0||pace>=z[1]-1e-6)&&(pace<z[2]||i===5));}
root.RunZones={zones,classify};
})(globalThis);
