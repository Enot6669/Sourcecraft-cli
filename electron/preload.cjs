const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('studio',{
chooseProject:()=>ipcRenderer.invoke('project:choose'),listFiles:()=>ipcRenderer.invoke('project:list'),readFile:p=>ipcRenderer.invoke('file:read',p),saveFile:(p,content)=>ipcRenderer.invoke('file:save',p,content),
runTask:(prompt,agent)=>ipcRenderer.invoke('agent:run',prompt,agent),cancelTask:()=>ipcRenderer.invoke('agent:cancel'),checkCli:()=>ipcRenderer.invoke('agent:check'),
onOutput:fn=>{const handler=(_e,data)=>fn(data);ipcRenderer.on('agent:output',handler);return ()=>ipcRenderer.removeListener('agent:output',handler);}
});
