// 客户端本地 Web UI（单页，无外部依赖）。exe 启动后打开浏览器，玩家只看到这个页面。
export function renderAppHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AutoPack 整合包更新器</title>
<style>
:root{--bg:#0e1118;--card:#161a23;--line:#252b37;--fg:#e8ebf2;--dim:#8c95a9;--accent:#4c9aff;--green:#3ddc84;--red:#ff6b6b;--amber:#ffc857}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 600px at 50% -10%,#16203a 0%,var(--bg) 60%);color:var(--fg);font:14px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;min-height:100vh}
main{max-width:820px;margin:0 auto;padding:40px 20px 60px}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}
h1{font-size:20px;margin:0;font-weight:650;letter-spacing:.3px}
.badge{font-size:12px;padding:4px 10px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
.badge.ok{color:var(--green);border-color:#1f4733;background:#0f2419}
.badge.busy{color:var(--amber);border-color:#4a3a12;background:#241d0c}
.badge.err{color:var(--red);border-color:#4a1f1f;background:#241010}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:16px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
.versions{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.kv{background:#11151d;border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.kv .k{font-size:12px;color:var(--dim);margin-bottom:2px}
.kv .v{font-size:16px;font-weight:600;word-break:break-all}
.bar{height:10px;border-radius:999px;background:#0c0f15;border:1px solid var(--line);overflow:hidden;margin-top:14px}
.bar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#2f6fd0,#4c9aff,#7bc0ff);transition:width .25s ease}
.msg{margin-top:10px;color:var(--dim);font-size:13px;min-height:20px;word-break:break-all}
.speedline{margin-top:6px;font-size:13px;color:var(--accent);font-family:ui-monospace,Consolas,monospace;min-height:18px}
button{appearance:none;border:1px solid var(--line);background:#1b2130;color:var(--fg);padding:11px 18px;border-radius:10px;font-size:14px;cursor:pointer;transition:.15s;font-weight:550}
button:hover:not(:disabled){border-color:#3b4a63;background:#222b3d}
button.primary{background:linear-gradient(180deg,#3f8bf0,#2f6fd0);border-color:#2f6fd0;color:#fff}
button.primary:hover:not(:disabled){background:linear-gradient(180deg,#4c9aff,#3579dd)}
button:disabled{opacity:.45;cursor:not-allowed}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:4px}
.stat{background:#11151d;border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.stat .n{font-size:18px;font-weight:700}
.stat .l{font-size:12px;color:var(--dim)}
.list{max-height:220px;overflow:auto;margin-top:12px;border-top:1px solid var(--line);padding-top:10px;font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#b9c1d1}
.list div{padding:3px 0;border-bottom:1px dashed #1d2330;word-break:break-all}
.list .t{color:var(--amber)}.list .n{color:var(--green)}.list .d{color:var(--red)}
.log{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#93a0b8;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-all}
details summary{cursor:pointer;color:var(--dim);font-size:13px;outline:none}
label{display:block;font-size:12px;color:var(--dim);margin:12px 0 4px}
input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:#0e1219;color:var(--fg);font-size:13px;outline:none}
input:focus{border-color:var(--accent)}
.hint{font-size:12px;color:var(--dim);margin-top:6px}
.warn{color:var(--amber);font-size:13px;margin-top:10px}
.hide{display:none!important}
</style></head><body><main>
<header>
  <h1 id="title">整合包更新器</h1>
  <span class="badge" id="badge">准备就绪</span>
</header>

<div class="card">
  <div class="versions">
    <div class="kv"><div class="k">本地版本</div><div class="v" id="localVer">—</div></div>
    <div class="kv"><div class="k">线上版本</div><div class="v" id="remoteVer">—</div></div>
  </div>
  <div class="bar"><i id="progressBar"></i></div>
  <div class="speedline" id="speedline"></div>
  <div class="msg" id="message">正在读取状态…</div>
  <div id="warn" class="warn hide"></div>
  <div class="actions">
    <button id="btnCheck">检查更新</button>
    <button id="btnUpdate" class="primary" disabled>开始更新</button>
    <button id="btnLaunch">启动游戏</button>
  </div>
</div>

<div class="card" id="planCard">
  <div class="grid">
    <div class="stat"><div class="n" id="statInstall">0</div><div class="l">需下载</div></div>
    <div class="stat"><div class="n" id="statSize">0 B</div><div class="l">总大小</div></div>
    <div class="stat"><div class="n" id="statRemove">0</div><div class="l">替换旧文件</div></div>
    <div class="stat"><div class="n" id="statKeep">0</div><div class="l">保留本机文件</div></div>  </div>
  <div class="list" id="planList"></div>
</div>

<div class="card">
  <details>
    <summary>设置</summary>
    <label>更新源地址</label>
    <input id="cfgUrl" placeholder="https://你的项目.pages.dev">
    <label>启动器路径（可选，用于“启动游戏”按钮）</label>
    <input id="cfgLauncher" placeholder="例如 D:\\PCL\\Plain Craft Launcher.exe">
    <label>游戏目录</label>
    <input id="cfgDir" readonly>
    <div class="hint">保存后立即生效；换整合包只需改“更新源地址”。</div>
    <div class="actions"><button id="btnSave">保存设置</button><button id="btnOpenDir">打开游戏目录</button></div>
  </details>
</div>

<div class="card">
  <div class="log" id="log">等待操作…</div>
</div>
</main>
<script>
const $ = (id) => document.getElementById(id);
let lastPhase = '';
function fmtSize(n){if(!n)return'0 B';const u=['B','KiB','MiB','GiB'];let v=n,i=0;while(v>=1024&&i<u.length-1){v/=1024;i++}return v.toFixed(v>=10||i===0?0:1)+' '+u[i]}
function setBusy(b){for(const id of['btnCheck','btnUpdate','btnLaunch','btnSave'])$(id).disabled=b||($(id).dataset.need==='1')}
async function api(path,body){
  const r=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
  if(!r.ok){const t=await r.text();throw new Error(t||('HTTP '+r.status))}
  return r.headers.get('content-type')?.includes('json')?r.json():r.text();
}
async function refresh(){
  try{
    const s=await api('/api/state');
    $('title').textContent=(s.packName||'整合包')+' 更新器';
    $('localVer').textContent=s.localVersion||'(未安装)';
    $('remoteVer').textContent=s.remoteVersion||'—';
    $('cfgUrl').value=s.config.baseUrl||'';
    $('cfgLauncher').value=s.config.launcher||'';
    $('cfgDir').value=s.config.gameDir||'';
    const b=$('badge');
    b.className='badge';
    if(s.phase==='error'){b.classList.add('err');b.textContent='出错'}
    else if(['checking','downloading','applying'].includes(s.phase)){b.classList.add('busy');b.textContent='处理中'}
    else if(s.upToDate){b.classList.add('ok');b.textContent='已是最新'}
    else if(s.plan){b.textContent='有更新'}
    else {b.textContent='准备就绪'}
    $('message').textContent=s.message||'';
    const p=s.progress||{};
    const pct=p.total>0?Math.min(100,Math.round((p.current/p.total)*100)):0;
    $('progressBar').style.width=pct+'%';
    if(s.phase==='download'&&p.speed>0){
      const done=p.bytes||0, all=p.bytesTotal||0, left=Math.max(0,all-done);
      const eta=p.speed>0?Math.round(left/p.speed):0;
      const etaText=eta>0?(eta>=60?Math.floor(eta/60)+' 分 '+(eta%60)+' 秒':eta+' 秒'):'—';
      $('speedline').textContent='↓ '+fmtSize(p.speed)+'/s   '+fmtSize(done)+' / '+fmtSize(all)+'   剩余 '+etaText;
    } else if(s.phase==='download'){
      $('speedline').textContent=fmtSize(p.bytes||0)+' / '+fmtSize(p.bytesTotal||0);
    } else {
      $('speedline').textContent='';
    }
    if(s.plan){
      const pl=s.plan;
      $('statInstall').textContent=pl.installs.length;
      $('statSize').textContent=fmtSize(pl.bytes);
      $('statRemove').textContent=pl.toBackup.length;
      $('statKeep').textContent=pl.orphans.length+(pl.keptMods?pl.keptMods.length:0);
      $('planList').innerHTML=pl.installs.slice(0,200).map(f=>'<div><span class="'+(f.action==='install'?'n':'t')+'">'+(f.action==='install'?'新增':'更新')+'</span> '+f.path+'  <span style="color:#5d677d">'+fmtSize(f.size)+'</span></div>').join('')+(pl.installs.length>200?'<div style="color:#5d677d">… 其余 '+(pl.installs.length-200)+' 个</div>':'');
      $('btnUpdate').disabled=pl.upToDate;
      $('btnUpdate').textContent=pl.upToDate?'无需更新':'开始更新（'+pl.installs.length+' 个文件）';
    }
    if(s.plan&&s.plan.missingRequired&&s.plan.missingRequired.length){
      $('warn').classList.remove('hide');
      $('warn').textContent='缺少必须安装的模组：'+s.plan.missingRequired.join(', ')+'（更新源里没有对应文件，请联系服主）';
    }else $('warn').classList.add('hide');
    if(s.logs&&s.logs.length)$('log').textContent=s.logs.join('\\n');
    if(s.phase!==lastPhase){lastPhase=s.phase}
    $('btnUpdate').dataset.need=s.plan&&s.plan.upToDate?'1':'0';
  }catch(e){$('message').textContent='与本地更新器进程失去连接：'+e.message}
}
async function doCheck(){
  setBusy(true);$('message').textContent='检查更新…';
  try{await api('/api/check',{});}catch(e){$('message').textContent='检查失败：'+e.message}
  finally{setBusy(false);refresh()}
}
async function doUpdate(){
  setBusy(true);
  try{await api('/api/update',{});}catch(e){$('message').textContent='更新失败：'+e.message}
  finally{setBusy(false);refresh()}
}
async function doLaunch(){
  try{await api('/api/launch',{});$('message').textContent='已请求启动游戏';}
  catch(e){$('message').textContent='启动失败：'+e.message}
}
async function doSave(){
  try{
    await api('/api/config',{baseUrl:$('cfgUrl').value.trim(),launcher:$('cfgLauncher').value.trim()});
    $('message').textContent='设置已保存';refresh();
  }catch(e){$('message').textContent='保存失败：'+e.message}
}
$('btnCheck').onclick=doCheck;
$('btnUpdate').onclick=doUpdate;
$('btnLaunch').onclick=doLaunch;
$('btnSave').onclick=doSave;
$('btnOpenDir').onclick=()=>api('/api/open-dir',{});
refresh();setInterval(refresh,700);
</script>
</body></html>`;
}
