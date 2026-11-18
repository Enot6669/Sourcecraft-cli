const {app,BrowserWindow,ipcMain,dialog}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process');
const {resolveWithin,within}=require('./paths.cjs');
let win,root=null,child=null;
function send(data){if(win&&!win.isDestroyed())win.webContents.send('agent:output',data);}
function createWindow(){win=new BrowserWindow({width:1440,height:900,minWidth:900,minHeight:600,backgroundColor:'#0d111b',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
if(!app.isPackaged)win.loadURL('http://127.0.0.1:5173');else win.loadFile(path.join(__dirname,'../dist/index.html'));
win.webContents.setWindowOpenHandler(()=>({action:'deny'}));}
app.whenReady().then(()=>{createWindow();app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
app.on('before-quit',()=>{if(child)child.kill();});
ipcMain.handle('project:choose',async()=>{const result=await dialog.showOpenDialog(win,{properties:['openDirectory']});if(result.canceled)return null;root=await fs.realpath(result.filePaths[0]);return root;});
async function checkedFile(rel){if(!root)throw Error('Сначала откройте проект');const full=resolveWithin(root,rel),real=await fs.realpath(full);if(!within(root,real))throw Error('Symlink outside project');const st=await fs.stat(real);if(!st.isFile()||st.size>2*1024*1024)throw Error('Invalid file size');return real;}
ipcMain.handle('project:list',async()=>{if(!root)return [];const output=[],ignored=new Set(['.git','node_modules','dist','release','.next','build']);async function walk(dir,depth){if(depth>5||output.length>=700)return;for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(output.length>=700)break;if(ignored.has(entry.name))continue;const full=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory())await walk(full,depth+1);else if(entry.isFile())output.push(path.relative(root,full));}}await walk(root,0);return output;});
ipcMain.handle('file:read',async(_e,p)=>fs.readFile(await checkedFile(p),'utf8'));
ipcMain.handle('file:save',async(_e,p,content)=>{if(typeof content!=='string'||Buffer.byteLength(content)>2*1024*1024)throw Error('Content too large');await fs.writeFile(await checkedFile(p),content,'utf8');return true;});
ipcMain.handle('agent:check',async()=>new Promise(resolve=>{const p=spawn('src',['--help'],{shell:false,windowsHide:true});let output='';p.stdout.on('data',d=>output+=d.toString().slice(0,300));p.on('error',e=>resolve({ok:false,message:e.message}));p.on('close',code=>resolve({ok:code===0,message:output.slice(0,300)}));}));
ipcMain.handle('agent:run',async(_e,prompt,agent)=>{if(!root)throw Error('Сначала откройте проект');if(child)throw Error('Задача уже выполняется');if(typeof prompt!=='string'||!prompt.trim()||prompt.length>12000)throw Error('Invalid prompt');const flags={ycodex:'--ycodex',codex:'--codex'};if(!Object.hasOwn(flags,agent))throw Error('Unsupported agent');
return new Promise(resolve=>{let done=false;const finish=result=>{if(done)return;done=true;child=null;resolve(result);};const p=spawn('src',['do',flags[agent],prompt],{cwd:root,shell:false,windowsHide:true,env:process.env});child=p;let bytes=0,limited=false;for(const stream of [p.stdout,p.stderr])stream.on('data',buf=>{bytes+=buf.length;if(bytes<4*1024*1024)send({kind:stream===p.stdout?'stdout':'stderr',text:buf.toString('utf8')});else if(!limited){limited=true;send({kind:'stderr',text:'\nOutput limit reached; task stopped.\n'});p.kill();}});p.on('error',e=>{send({kind:'stderr',text:e.message});finish({code:-1});});p.on('close',code=>finish({code:code??-1}));});});
ipcMain.handle('agent:cancel',async()=>{if(!child)return false;child.kill();return true;});
