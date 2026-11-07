import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';
import { chromium } from '@playwright/test';
const root = process.cwd();
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'iw-browser-'));
const stub = path.join(temp,'obsidian.js');
await fs.writeFile(stub,`export class Notice {constructor(text){(globalThis.notices??=[]).push(text)}};export class Scope {register(){}};export class TFile {constructor(path){this.path=path;this.extension=path.split('.').pop();this.name=path;this.basename=path.replace(/\\.[^.]+$/,'');}}`);
const bundle = await esbuild.build({stdin:{contents:`export { ImageEditor } from './image-editor'; export * from './png-meta'; export * from './copy-images'; export * from './html-style'; export * from './copy-text';`,resolveDir:root,sourcefile:'browser-test-entry.ts'},bundle:true,write:false,format:'iife',globalName:'IW',plugins:[{name:'stub-obsidian',setup(build){build.onResolve({filter:/^obsidian$/},()=>({path:stub}));}}]});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),args:['--no-sandbox']});
try {
 const page=await browser.newPage({viewport:{width:1000,height:800}});
 await page.setContent('<html><head></head><body></body></html>');
 await page.addStyleTag({content:await fs.readFile('styles.css','utf8')});
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.evaluate(()=>{
  HTMLElement.prototype.addClass=function(...names){this.classList.add(...names)};
  HTMLElement.prototype.toggleClass=function(name,on){this.classList.toggle(name,on)};
  HTMLElement.prototype.show=function(){this.style.display=''};
  HTMLElement.prototype.hide=function(){this.style.display='none'};
  HTMLElement.prototype.createEl=function(tag,o={}){const el=document.createElement(tag);if(o.text)el.textContent=o.text;if(o.cls)el.className=o.cls;if(o.type)el.type=o.type;for(const[k,v]of Object.entries(o.attr||{}))el.setAttribute(k,v);this.append(el);return el};
  HTMLElement.prototype.createDiv=function(o){return this.createEl('div',o)};
  HTMLElement.prototype.createSpan=function(o){return this.createEl('span',o)};
  const canvas=document.createElement('canvas');canvas.width=80;canvas.height=60;const c=canvas.getContext('2d');
  for(let y=0;y<60;y++)for(let x=0;x<80;x++){c.fillStyle=`rgb(${x*3},${y*4},${(x+y)%2*255})`;c.fillRect(x,y,1,1)}
  c.clearRect(0,0,4,4);
  const bytes=Uint8Array.from(atob(canvas.toDataURL().split(',')[1]),ch=>ch.charCodeAt(0));
  window.original=bytes;window.saved=bytes;window.file={path:'image.png',extension:'png',name:'image.png',basename:'image'};
  window.app={vault:{readBinary:async()=>saved.slice().buffer,modifyBinary:async(_file,data)=>{saved=new Uint8Array(data)}},keymap:{pushScope(){},popScope(){}}};
  window.makeEditor=()=>{window.editor=new IW.ImageEditor({app,doc:document,src:'',imageFile:file,notePath:null});editor.open()};
  makeEditor();
 });
 await page.waitForFunction(()=>!!window.editor.image);
 assert.equal(await page.getByRole('button',{name:'Mosaic',exact:true}).count(),1);
 assert.equal(await page.getByRole('button',{name:'Crop',exact:true}).count(),1);
 const mosaic=await page.evaluate(()=>{const e=editor;e.shapes=[{kind:'mosaic',x:10.8,y:10.8,w:20.8,h:20.8,blockSize:8}];e.render(false);const after=e.ctx.getImageData(11,11,1,1).data;const c=document.createElement('canvas');c.width=80;c.height=60;const ctx=c.getContext('2d');ctx.drawImage(e.image,0,0);const before=ctx.getImageData(11,11,1,1).data;return {changed:after.some((x,i)=>x!==before[i]),alpha:e.ctx.getImageData(1,1,1,1).data[3]}});
 assert.equal(mosaic.changed,true);assert.equal(mosaic.alpha,0);
 await page.evaluate(()=>{editor.shapes.push({kind:'crop',x:8,y:6,w:40,h:30});editor.render()});
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.image-workflow-editor'));
 const savedInfo=await page.evaluate(async()=>{const blob=new Blob([saved],{type:'image/png'});const img=await createImageBitmap(blob);const meta=JSON.parse(IW.readPngText(saved,'image-workflow'));const bytes=IW.readPngChunk(saved,'iwOg');return {width:img.width,height:img.height,meta,originalMatches:bytes.length===original.length&&bytes.every((b,i)=>b===original[i])}});
 assert.equal(savedInfo.width,40);assert.equal(savedInfo.height,30);assert.equal(savedInfo.meta.w,80);assert.equal(savedInfo.meta.h,60);assert.equal(savedInfo.originalMatches,true);
 const safeCopy=await page.evaluate(async()=>{const src='data:image/png;base64,'+btoa(String.fromCharCode(...saved));const prepared=await IW.prepareCopyImage(src,document);const bytes=Uint8Array.from(atob(prepared.src.split(',')[1]),c=>c.charCodeAt(0));return {original:IW.readPngChunk(bytes,'iwOg'),metadata:IW.readPngText(bytes,'image-workflow')};});
 assert.equal(safeCopy.original,null);assert.equal(safeCopy.metadata,null);
 await page.evaluate(()=>makeEditor());await page.waitForFunction(()=>!!editor.image);
 assert.deepEqual(await page.evaluate(()=>({w:editor.canvas.width,h:editor.canvas.height,kinds:editor.shapes.map(s=>s.kind)})),{w:80,h:60,kinds:['mosaic','crop']});
 await page.getByRole('button',{name:'Undo',exact:true}).click();assert.equal(await page.evaluate(()=>editor.activeCrop()),null);
 await page.getByRole('button',{name:'Revert',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.image-workflow-editor'));
 assert.equal(await page.evaluate(()=>saved.length===original.length&&saved.every((b,i)=>b===original[i])),true);
 // A closed editor must not finish a pending vault load or retain a blob URL.
 const cancelled = await page.evaluate(async()=>{
  const read = app.vault.readBinary; let release;
  app.vault.readBinary=()=>new Promise(resolve=>{release=resolve});
  makeEditor(); const closed=editor; closed.close(); release(original.slice().buffer);
  await new Promise(resolve=>setTimeout(resolve,30)); app.vault.readBinary=read;
  return {url:closed.objectUrl,loaded:!!closed.image,root:closed.root};
 });
 assert.deepEqual(cancelled,{url:null,loaded:false,root:null});
 // Corrupt metadata must fall back to the flattened PNG, without importing shapes.
 await page.evaluate(()=>{
  saved=IW.writePngChunk(IW.writePngText(original,'image-workflow',JSON.stringify({v:2,w:80,h:60,shapes:[null]})),'iwOg',original);
  makeEditor();
 });
 await page.waitForFunction(()=>!!editor.image);
 assert.equal(await page.evaluate(()=>editor.shapes.length),0);
 await page.evaluate(()=>editor.close());
 // While an asynchronous save is pending, keyboard undo and drawing cannot lose edits.
 await page.evaluate(()=>{saved=original;makeEditor()});
 await page.waitForFunction(()=>!!editor.image);
 const saving=await page.evaluate(async()=>{
  const write=app.vault.modifyBinary;let release;
  app.vault.modifyBinary=(_file,data)=>new Promise(resolve=>{release=()=>{saved=new Uint8Array(data);resolve()}});
  editor.shapes=[{kind:'rect',x:1,y:1,w:10,h:10,color:'#000000',width:3}];
  const pending=editor.save();
  const disabled=[...document.querySelectorAll('.image-workflow-editor button')].every(button=>button.disabled);
  editor.undo();editor.onPointerDown({button:0,preventDefault(){throw new Error('Drawing was not blocked')}});
  const count=editor.shapes.length;release();await pending;app.vault.modifyBinary=write;
  return {disabled,count,savedCount:JSON.parse(IW.readPngText(saved,'image-workflow')).shapes.length};
 });
 assert.deepEqual(saving,{disabled:true,count:1,savedCount:1});
 const resize=await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=2400;c.height=1600;const ctx=c.getContext('2d');ctx.fillStyle='red';ctx.fillRect(200,200,1000,800);const p=await IW.prepareCopyImage(c.toDataURL(),document);const bitmap=await createImageBitmap(await (await fetch(p.src)).blob());const o=document.createElement('canvas');o.width=bitmap.width;o.height=bitmap.height;const g=o.getContext('2d');g.drawImage(bitmap,0,0);return {width:p.width,height:p.height,alpha:g.getImageData(0,0,1,1).data[3],bytes:p.bytes}});
 assert.equal(resize.width,1200);assert.equal(resize.height,800);assert.equal(resize.alpha,0);assert.ok(resize.bytes>0);
 const formats=await page.evaluate(()=>{const root=document.createElement('div');root.innerHTML='<h1>Heading</h1><p>日本語<mark>強調</mark><strong>太字</strong></p><pre><code>  indented\ncode</code></pre><p><a class="internal-link" href="Note">Note</a></p>';const unstyled=root.cloneNode(true);IW.inlineStyleForExternalPaste(root,'gdocs');return {h1:root.querySelector('h1').getAttribute('style'),hasMark:!!root.querySelector('mark'),hasTable:!!root.querySelector('table[data-iw-code]'),code:root.querySelector('table').textContent,plain:IW.serializeToText(root,'plain'),slack:IW.serializeToText(unstyled,'slack')}});
 assert.ok(formats.h1.includes('20pt'));assert.equal(formats.hasMark,false);assert.equal(formats.hasTable,true);assert.ok(formats.code.includes('\u00a0'));assert.ok(formats.slack.includes('*強調*'));assert.ok(formats.plain.includes('日本語強調太字'));
 console.log('Browser checks passed: real Canvas mosaic/crop, PNG metadata/reopen/Revert, alpha-safe 1200px resize, and Docs/chat formatting.');
} finally {await browser.close();await fs.rm(temp,{recursive:true,force:true})}
