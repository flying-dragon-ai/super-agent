const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('openSuperAgentDesktop',{version:1,engine:'electron',platform:process.platform,openSocket:()=>Promise.reject(new Error('unused')),on:()=>()=>{},invoke:(command,args)=>ipcRenderer.invoke('screen-smoke',command,args)});
for(const channel of ['open-super-agent:screen-port:v1','screen-smoke-source'])ipcRenderer.on(channel,(event,data)=>window.postMessage({type:channel,...data},location.origin,event.ports));
