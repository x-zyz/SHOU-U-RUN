(function(){'use strict';
const el=id=>document.getElementById(id),native=window.Android;let current={},historyKey='',busy=false;
window.onRecorderMessage=message=>{el('realMessage').textContent=message;busy=false;poll();};
const mobile=document.documentElement.classList.contains('mobile-workbench');
let fitting = false;
const stateNames={idle:'尚未开始',recording:'正在记录真实 GPS',paused:'已暂停',completed:'已结束并保存',interrupted:'上次采集已中断',error:'采集已停止'};
function reload(){if(!native?.realRunHistory)return;try{const records=JSON.parse(native.realRunHistory()),old=el('realHistory').value;el('realHistory').replaceChildren();for(const r of records){const option=document.createElement('option');option.value=r.name;option.textContent=new Date(r.modified).toLocaleString()+' · '+(r.bytes/1024).toFixed(1)+' KB · '+r.name;el('realHistory').append(option);}if(!records.length){const option=document.createElement('option');option.value='';option.textContent='暂无记录';el('realHistory').append(option);}else if(records.some(r=>r.name===old))el('realHistory').value=old;buttons();}catch(e){el('realMessage').textContent='无法读取历史记录：'+e.message;}}
function buttons(){const running=current.state==='recording',paused=current.state==='paused',active=running||paused;el('realStart').disabled=busy||active;el('realPause').disabled=busy||!running;el('realResume').disabled=busy||!paused;el('realStop').disabled=busy||!active;el('realExport').disabled=!el('realHistory').value||(active&&el('realHistory').value===current.file);el('fitPersonalPace').disabled=fitting||Boolean(native?.recordRun&&(active||!el('realHistory').value));}
function poll(){
  if(!native?.recorderState)return;
  try{
    current=JSON.parse(native.recorderState());
    const state=el('realState');
    const label=(stateNames[current.state]||current.state)+(current.message?' · '+current.message:'');
    if(state.textContent!==label)state.textContent=label;
    state.dataset.state=current.state;
    const metrics=el('realMetrics'), seconds=current.activeSeconds||0;
    const clock=Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
    const detail='已保存 '+(current.count||0)+' 点'+(current.accuracy>=0?' · 最近精度 ±'+Math.round(current.accuracy)+' 米':'')+(current.state==='recording'?(current.lastFixAge<0?' · 等待定位':current.lastFixAge>10?' · 已 '+current.lastFixAge+' 秒未收到定位':''):'');
    if(mobile){
      if(!metrics.firstElementChild){
        const time=document.createElement('strong');time.className='metric-time';
        const caption=document.createElement('span');
        metrics.replaceChildren(time,caption);
      }
      metrics.firstElementChild.textContent=clock;
      metrics.lastElementChild.textContent=detail;
    }else metrics.textContent='采集时长 '+clock+' · '+detail;
    const key=current.file+current.state;
    if(key!==historyKey){historyKey=key;reload();}
    buttons();
  }catch(e){el('realMessage').textContent='采集状态读取失败：'+e.message;}
}
function command(action){busy=true;buttons();native.recordRun(action);setTimeout(()=>{busy=false;poll();},2000);}
if (native?.fitRunPace) {
  const personal = RunPaceProfile;
  const status = message => { el('personalPaceStatus').textContent = message; };
  function showProfile() {
    const {profile, enabled} = personal.get();
    el('usePersonalPace').checked = enabled;
    el('usePersonalPace').disabled = !profile;
    el('clearPersonalPace').hidden = !profile;
    if (!profile) {
      el('personalPaceSummary').textContent = '尚未拟合，正在使用默认模型。';
      return;
    }
    const pace = Math.round(profile.pace);
    el('personalPaceSummary').textContent = profile.runs + ' 次跑步 · ' + profile.seconds + ' 秒有效样本 · 典型配速 ' +
      Math.floor(pace / 60) + '′' + String(pace % 60).padStart(2, '0') + '″/km' +
      (profile.runs < 2 || profile.seconds < 300 ? ' · 初步模型' : '');
  }
  function save(profile, enabled) {
    personal.save(profile, enabled);
    showProfile();
    document.dispatchEvent(new Event('personalpacechange'));
  }
  el('personalPace').hidden = false;
  showProfile();
  buttons();
  el('fitPersonalPace').onclick = () => {
    fitting = true;
    buttons();
    status(native.desktopWorkbench ? '请选择真实跑步 JSONL 文件…' : '正在读取本机记录并拟合…');
    native.fitRunPace();
  };
  window.onRunPaceSamples = (runs, message) => {
    try {
      if (message) { status(message); return; }
      save(personal.fit(runs), true);
      status('个人模型已启用，可在「参数」查看生成曲线。');
    } catch (error) {
      status(error.message);
    } finally {
      fitting = false;
      buttons();
    }
  };
  el('usePersonalPace').onchange = () => {
    try {
      save(personal.get().profile, el('usePersonalPace').checked);
      status(personal.get().enabled ? '已切换到个人模型。' : '已切换到默认模型。');
    } catch (_) {
      showProfile();
      status('无法保存模型设置，请重试。');
    }
  };
  el('clearPersonalPace').onclick = () => {
    try {
      save(null, false);
      status('已清除个人模型。');
    } catch (_) {
      status('无法清除模型，请重试。');
    }
  };
}
if(!native?.recordRun){el('realState').textContent='真实 GPS 采集需要在 Android 安装版中使用';['realStart','realPause','realResume','realStop','realSettings','realExport','realReload'].forEach(id=>el(id).disabled=true);return;}
el('realStart').onclick=()=>command('start');el('realPause').onclick=()=>command('pause');el('realResume').onclick=()=>command('resume');el('realStop').onclick=()=>command('stop');el('realSettings').onclick=()=>native.openRecorderSettings();el('realReload').onclick=reload;el('realHistory').onchange=buttons;el('realExport').onclick=()=>native.exportRealRun(el('realHistory').value);poll();setInterval(()=>{if(!document.hidden)poll();},1000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});
})();
