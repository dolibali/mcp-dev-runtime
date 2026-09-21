import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),[operation,...args]=process.argv.slice(2);
if(['command-install','command-remove'].includes(operation)){
  const file=path.join(root,'scripts',process.platform==='win32'?'windows/source.mjs':'global-command.mjs');
  process.argv=[process.execPath,file,...(process.platform==='win32'?['--commands-only']:[]),...(operation==='command-remove'?['--remove']:[]),...args];
  await import(pathToFileURL(file).href);
}else{
if(!['setup','uninstall'].includes(operation))throw new Error('Expected setup, uninstall or command registration operation.');
const exe=process.platform==='win32'?path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'):'bash';
const script=path.join(root,operation==='setup'?(process.platform==='win32'?'install.ps1':'install.sh'):(process.platform==='win32'?'uninstall.ps1':'uninstall.sh'));
const child=spawn(exe,[...(process.platform==='win32'?['-NoLogo','-NoProfile','-File']:[]),script,...args],{cwd:root,stdio:'inherit',windowsHide:true});
child.once('error',e=>{console.error(e.message);process.exitCode=1});child.once('exit',(code,signal)=>{process.exitCode=code??(signal?1:0)});
}
