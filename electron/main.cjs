const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {app,BrowserWindow,ipcMain,dialog}=require('electron');
const {resolveWithin,within}=require('./paths.cjs');
let win,root=null,child=null;
const settingsFile=()=>path.join(app.getPath('userData'),'settings.json');
let settings={cliPath:''};
async function loadSettings(){try{const x=JSON.parse(await fs.readFile(settingsFile(),'utf8'));settings.cliPath=typeof x.cliPath==='string'?x.cliPath:'';}catch{}}
async function saveSettings(){await fs.mkdir(path.dirname(settingsFile()),{recursive:true});await fs.writeFile(settingsFile(),JSON.stringify(settings,null,2),'utf8');}
function send(data){if(win&&!win.isDestroyed())win.webContents.send('agent:output',data);}
function createWindow(){win=new BrowserWindow({width:1440,height:900,minWidth:900,minHeight:600,backgroundColor:'#0d111b',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
if(!app.isPackaged)win.loadURL('http://127.0.0.1:5173');else win.loadFile(path.join(__dirname,'../dist/index.html'));
win.webContents.setWindowOpenHandler(()=>({action:'deny'}));}
app.whenReady().then(async()=>{await loadSettings();createWindow();app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
app.on('before-quit',()=>{if(child)child.kill();});
ipcMain.handle('project:choose',async()=>{const result=await dialog.showOpenDialog(win,{properties:['openDirectory']});if(result.canceled)return null;root=await fs.realpath(result.filePaths[0]);return root;});
async function checkedFile(rel){if(!root)throw Error('Сначала откройте проект');const full=resolveWithin(root,rel),real=await fs.realpath(full);if(!within(root,real))throw Error('Symlink outside project');const st=await fs.stat(real);if(!st.isFile()||st.size>2*1024*1024)throw Error('Invalid file size');return real;}
ipcMain.handle('project:list',async()=>{if(!root)return [];const output=[],ignored=new Set(['.git','node_modules','dist','release','.next','build']);async function walk(dir,depth){if(depth>5||output.length>=700)return;for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(output.length>=700)break;if(ignored.has(entry.name))continue;const full=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory())await walk(full,depth+1);else if(entry.isFile())output.push(path.relative(root,full));}}await walk(root,0);return output;});
ipcMain.handle('file:read',async(_e,p)=>fs.readFile(await checkedFile(p),'utf8'));
ipcMain.handle('file:save',async(_e,p,content)=>{if(typeof content!=='string'||Buffer.byteLength(content)>2*1024*1024)throw Error('Content too large');await fs.writeFile(await checkedFile(p),content,'utf8');return true;});
function execute(file,args,{cwd,timeout=8000}={}){return new Promise(resolve=>{let output='',done=false;const finish=(result)=>{if(done)return;done=true;clearTimeout(timer);resolve(result);};let proc;try{proc=spawn(file,args,{cwd,shell:false,windowsHide:true,env:process.env});}catch(e){return resolve({ok:false,output:e.message,code:-1});}const timer=setTimeout(()=>{proc.kill();finish({ok:false,output:'Timed out',code:-1});},timeout);for(const stream of [proc.stdout,proc.stderr])stream.on('data',d=>{if(output.length<8000)output+=d.toString().slice(0,8000-output.length)});proc.on('error',e=>finish({ok:false,output:e.message,code:-1}));proc.on('close',code=>finish({ok:code===0,output:output.trim(),code}));});}
async function locate(){if(settings.cliPath){try{const st=await fs.stat(settings.cliPath);if(st.isFile())return settings.cliPath;}catch{}return null;}
const candidates=[];for(const dir of (process.env.PATH||'').split(path.delimiter)){if(dir)candidates.push(path.join(dir,process.platform==='win32'?'src.exe':'src'));}
for(const candidate of candidates){try{const st=await fs.stat(candidate);if(st.isFile())return candidate;}catch{}}return null;}
async function diagnostics(){const cliPath=await locate();if(!cliPath)return {ok:false,path:settings.cliPath||'',version:'',auth:'unknown',message:'CLI не найден. Укажите путь к src.exe или добавьте его в PATH.'};const help=await execute(cliPath,['--help']);const version=await execute(cliPath,['--version']);return {ok:help.ok||version.ok,path:cliPath,version:version.output.slice(0,500),auth:'unknown',message:help.ok?'CLI доступен. Авторизация не проверена.':'Не удалось подтвердить запуск CLI: '+help.output.slice(0,500)};}
ipcMain.handle('settings:get',async()=>({cliPath:settings.cliPath}));
ipcMain.handle('settings:choose',async()=>{const result=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'CLI executable',extensions:process.platform==='win32'?['exe']:['*']}]});if(result.canceled)return null;return result.filePaths[0];});
ipcMain.handle('settings:setCliPath',async(_e,p)=>{if(child)throw Error('Дождитесь завершения задачи');if(typeof p!=='string'||p.length>2048)throw Error('Invalid path');if(p){if(!path.isAbsolute(p)||path.extname(p).toLowerCase()!=='.exe'&&process.platform==='win32')throw Error('Укажите абсолютный путь к src.exe');const stat=await fs.stat(p);if(!stat.isFile())throw Error('Not a file');}settings.cliPath=p;await saveSettings();return diagnostics();});
ipcMain.handle('agent:check',diagnostics);
ipcMain.handle('agent:auth',async()=>({status:'unknown',message:'Проверка авторизации пока не поддерживается: для установленной версии CLI не подтверждена безопасная команда статуса. Проверьте вход через официальный CLI.'}));
ipcMain.handle('agent:run',async(_e,prompt,agent)=>{if(!root)throw Error('Сначала откройте проект');if(child)throw Error('Задача уже выполняется');if(typeof prompt!=='string'||!prompt.trim()||prompt.length>12000)throw Error('Invalid prompt');const flags={ycodex:'--ycodex',codex:'--codex'};if(!Object.hasOwn(flags,agent))throw Error('Unsupported agent');const cliPath=await locate();if(!cliPath)throw Error('CLI не найден. Откройте настройки.');
return new Promise(resolve=>{let done=false;const finish=result=>{if(done)return;done=true;child=null;resolve(result);};const p=spawn(cliPath,['do',flags[agent],prompt],{cwd:root,shell:false,windowsHide:true,env:process.env});child=p;let bytes=0,limited=false;for(const stream of [p.stdout,p.stderr])stream.on('data',buf=>{bytes+=buf.length;if(bytes<4*1024*1024)send({kind:stream===p.stdout?'stdout':'stderr',text:buf.toString('utf8')});else if(!limited){limited=true;send({kind:'stderr',text:'\nOutput limit reached; task stopped.\n'});p.kill();}});p.on('error',e=>{send({kind:'stderr',text:e.message});finish({code:-1});});p.on('close',code=>finish({code:code??-1}));});});
ipcMain.handle('agent:cancel',async()=>{if(!child)return false;child.kill();return true;});
