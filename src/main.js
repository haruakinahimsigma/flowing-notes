import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgl';
import { BasicPitch, outputToNotesPoly, noteFramesToTime, addPitchBendsToNoteEvents } from '@spotify/basic-pitch';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL, fetchFile } from '@ffmpeg/util';
import './style.css';

const $ = id => document.getElementById(id);
const canvas = $('pianoRoll'), ctx = canvas.getContext('2d');
const MODEL_URL = '/model/model.json';
const NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
let notes=[], duration=0, playing=false, started=0, offset=0, raf=0, audio=null, audioBuffer=null, audioSource=null, ffmpeg=null, ffmpegPromise=null, currentFile=null;

const fmt=s=>Math.floor(Math.max(0,s)/60)+':'+String(Math.floor(Math.max(0,s)%60)).padStart(2,'0');
function status(s){$('status').textContent=s}
function progress(p){$('progressWrap').hidden=false;$('progressBar').style.width=(p*100)+'%';$('progressText').textContent=Math.round(p*100)+'%'}
function keyName(p){return NAMES[p%12]+(Math.floor(p/12)-1)}
function keyEstimate(list){const e=Array(12).fill(0),maj=[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88],min=[6.33,2.68,3.52,5.38,2.6,3.53,2.54,4.75,3.98,2.69,3.34,3.17];list.forEach(n=>e[n.pitchMidi%12]+=n.durationSeconds);let best=-Infinity,result='—';for(let r=0;r<12;r++)for(const [m,p] of [['major',maj],['minor',min]]){let v=0;for(let i=0;i<12;i++)v+=e[(i+r)%12]*p[i];if(v>best){best=v;result=NAMES[r]+' '+m}}return result}
function draw(){const w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;ctx.clearRect(0,0,w,h);ctx.fillStyle='#0b1020';ctx.fillRect(0,0,w,h);const low=21,high=108,range=high-low,now=playing?offset+(performance.now()-started)/1000:offset,windowSec=6;const x=p=>(p-low)/range*w;const y=t=>h-(t-now)*h/windowSec;for(let p=low;p<=high;p++){const px=x(p);ctx.strokeStyle=p%12===0?'#293149':'#1b2336';ctx.lineWidth=p%12===0?1.2:.6;ctx.beginPath();ctx.moveTo(px,0);ctx.lineTo(px,h);ctx.stroke()}for(let t=Math.ceil(now);t<=Math.min(duration,now+windowSec);t++){const py=y(t);ctx.strokeStyle='#202a40';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,py);ctx.lineTo(w,py);ctx.stroke();ctx.fillStyle='#8490aa';ctx.font='10px system-ui';ctx.fillText(fmt(t),5,py-3)}for(const n of notes){const top=y(n.startTimeSeconds),bottom=y(n.startTimeSeconds+n.durationSeconds),left=x(n.pitchMidi-.46),right=x(n.pitchMidi+.46);if(bottom<0||top>h)continue;ctx.fillStyle='#7185ee';ctx.globalAlpha=.94;ctx.beginPath();ctx.roundRect(left,Math.max(0,top),Math.max(2,right-left),Math.max(3,Math.min(h,bottom)-Math.max(0,top)),3);ctx.fill();if(bottom-top>24){ctx.fillStyle='#07101b';ctx.font='10px system-ui';ctx.fillText(keyName(n.pitchMidi),left+3,Math.max(12,top+13))}}ctx.globalAlpha=1;ctx.strokeStyle='#f1f3ff';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(0,h-1);ctx.lineTo(w,h-1);ctx.stroke();if(playing){$('seek').value=duration?now/duration*1000:0;$('clock').textContent=fmt(now)+' / '+fmt(duration);if(now>=duration){pause();return}raf=requestAnimationFrame(draw)}}
function resize(){const r=canvas.getBoundingClientRect(),d=window.devicePixelRatio||1;canvas.width=Math.max(1,r.width*d);canvas.height=Math.max(1,r.height*d);ctx.setTransform(d,0,0,d,0,0);draw()}

async function getFFmpeg(){
  if(ffmpeg)return ffmpeg;
  if(ffmpegPromise)return ffmpegPromise;
  ffmpegPromise=(async()=>{
    status('Loading free video engine…');
    const engine=new FFmpeg();
    engine.on('progress',({progress:p})=>{if(Number.isFinite(p))progress(Math.max(0,Math.min(1,p)))});
    const base='https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
    await engine.load({
      coreURL:await toBlobURL(base+'/ffmpeg-core.js','text/javascript'),
      wasmURL:await toBlobURL(base+'/ffmpeg-core.wasm','application/wasm')
    });
    ffmpeg=engine;
    return engine;
  })();
  try{return await ffmpegPromise}finally{ffmpegPromise=null}
}
function isVideoFile(file){
  return (file.type||'').startsWith('video/')||/[.](mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name||'');
}
async function extractAudio(file){
  const engine=await getFFmpeg();
  const ext=(file.name.match(/[.]([a-z0-9]+)$/i)||[])[1]||'mp4';
  const input='input.'+ext.toLowerCase(),output='extracted.wav';
  status('Extracting audio from video…');
  await engine.writeFile(input,await fetchFile(file));
  await engine.exec(['-i',input,'-vn','-ac','1','-ar','22050','-c:a','pcm_s16le',output]);
  const data=await engine.readFile(output);
  try{await engine.deleteFile(input);await engine.deleteFile(output)}catch{}
  return new File([data],file.name.replace(/[.][^.]+$/,'')+'.wav',{type:'audio/wav'});
}
function platformPage(url){
  const host=url.hostname.toLowerCase().startsWith('www.')?url.hostname.toLowerCase().slice(4):url.hostname.toLowerCase();
  const matches=(domain)=>host===domain||host.endsWith('.'+domain);
  if(matches('youtube.com')||host==='youtu.be'||matches('youtube-nocookie.com'))return 'YouTube';
  if(matches('instagram.com')||host==='instagr.am')return 'Instagram';
  if(matches('tiktok.com'))return 'TikTok';
  return null;
}
async function fetchMediaUrl(value){
  let url;
  try{url=new URL(value)}catch{throw Error('Enter a valid direct media-file URL.')}
  if(!['http:','https:'].includes(url.protocol))throw Error('Only HTTP or HTTPS media links are supported.');
  const platform=platformPage(url);
  if(platform){
    throw Error(platform+' link detected. This is a webpage, not a direct media file. Flowing Notes cannot retrieve or extract '+platform+' audio through this link. Upload your original recording or provide a direct media-file URL from a source that permits access.');
  }
  if(url.username||url.password)throw Error('Links containing embedded login credentials are not supported.');
  status('Downloading direct media file…');
  let response;
  try{response=await fetch(url.href,{redirect:'follow'})}
  catch{throw Error('This host blocked browser access (CORS), or the link is not a direct media file. Try uploading the recording instead.')}
  if(!response.ok)throw Error('The media host returned HTTP '+response.status+'.');
  const maxBytes=200*1024*1024;
  const declaredSize=Number(response.headers.get('content-length')||0);
  if(declaredSize>maxBytes)throw Error('This file is larger than the 200 MB browser-processing limit.');
  const blob=await response.blob();
  if(blob.size>maxBytes)throw Error('This file is larger than the 200 MB browser-processing limit.');
  const type=(blob.type||'').split(';')[0].trim().toLowerCase();
  const rawName=url.pathname.split('/').pop()||'linked-media';
  let name;
  try{name=decodeURIComponent(rawName)}catch{name=rawName}
  name=name.replaceAll('/','_').replaceAll('\\','_');
  const extension=(name.toLowerCase().split('.').pop()||'');
  const audioExtensions=new Set(['mp3','wav','m4a','ogg','flac','aac']);
  const videoExtensions=new Set(['mp4','mov','m4v','webm','mkv','avi']);
  const recognizedType=type.startsWith('audio/')||type.startsWith('video/');
  const recognizedExtension=audioExtensions.has(extension)||videoExtensions.has(extension);
  if(!recognizedType&&!recognizedExtension)throw Error('The URL did not return a recognized audio or video file. Paste a direct MP3, WAV, MP4, MOV or WEBM link.');
  const fallbackType=videoExtensions.has(extension)?'video/mp4':'audio/mpeg';
  return new File([blob],name,{type:type||fallbackType});
}

async function decode(file){const decoder=new AudioContext();try{const source=await decoder.decodeAudioData(await file.arrayBuffer()),length=Math.ceil(source.duration*22050),offline=new OfflineAudioContext(1,length,22050),node=offline.createBufferSource();node.buffer=source;node.connect(offline.destination);node.start();const mono=await offline.startRendering();return {samples:mono.getChannelData(0),duration:source.duration,audioBuffer:source}}finally{await decoder.close()}}
function estimateSustainedLengths(list,frameActivations,audioDuration){
  const frameCount=frameActivations.length;
  if(!frameCount||!frameActivations[0]?.length)return list;
  const secondsPerFrame=audioDuration/frameCount;
  const maxTailSeconds=.85,quietFrames=9;
  const nextSamePitch=new Map();
  for(const n of list){
    const starts=nextSamePitch.get(n.pitchMidi)||[];
    starts.push(n.startTimeSeconds);
    nextSamePitch.set(n.pitchMidi,starts);
  }
  for(const starts of nextSamePitch.values())starts.sort((a,b)=>a-b);
  return list.map(n=>{
    const pitchIndex=n.pitchMidi-21;
    if(pitchIndex<0||pitchIndex>=frameActivations[0].length)return n;
    const startFrame=Math.max(0,Math.min(frameCount-1,Math.floor(n.startTimeSeconds/secondsPerFrame)));
    const detectedEnd=n.startTimeSeconds+n.durationSeconds;
    const endFrame=Math.max(startFrame+1,Math.min(frameCount-1,Math.ceil(detectedEnd/secondsPerFrame)));
    let peak=0;
    for(let i=startFrame;i<endFrame;i++)peak=Math.max(peak,frameActivations[i]?.[pitchIndex]||0);
    if(peak<.12)return n;
    const threshold=Math.max(.055,peak*.16);
    const laterStarts=nextSamePitch.get(n.pitchMidi)||[];
    const nextStart=laterStarts.find(t=>t>n.startTimeSeconds+.01);
    const scanLimit=Math.min(audioDuration,detectedEnd+maxTailSeconds,nextStart==null?audioDuration:nextStart-.025);
    const limitFrame=Math.min(frameCount-1,Math.ceil(scanLimit/secondsPerFrame));
    let lastActive=endFrame-1,quiet=0;
    for(let i=endFrame;i<=limitFrame;i++){
      const value=frameActivations[i]?.[pitchIndex]||0;
      if(value>=threshold){lastActive=i;quiet=0}
      else if(++quiet>=quietFrames)break;
    }
    const estimatedEnd=Math.min(scanLimit,Math.max(detectedEnd,(lastActive+1)*secondsPerFrame));
    if(estimatedEnd-detectedEnd<.045)return n;
    return {...n,durationSeconds:estimatedEnd-n.startTimeSeconds};
  });
}

async function transcribe(file){$('audioFile').disabled=true;$('linkBtn').disabled=true;['playBtn','stopBtn','exportBtn'].forEach(id=>$(id).disabled=true);progress(0);try{if(isVideoFile(file))file=await extractAudio(file);currentFile=file;status('Decoding audio…');const decoded=await decode(file);duration=decoded.duration;audioBuffer=decoded.audioBuffer;status('Loading Spotify Basic Pitch…');await tf.setBackend('webgl');await tf.ready();const model=new BasicPitch(MODEL_URL),frames=[],onsets=[],contours=[];status('AI is detecting piano notes…');await model.evaluateModel(decoded.samples,(f,o,c)=>{frames.push(...f);onsets.push(...o);contours.push(...c)},progress);status('Converting detections into notes…');const raw=outputToNotesPoly(frames,onsets,.45,.20,5,true,null,27.5,false,18);const detected=noteFramesToTime(addPitchBendsToNoteEvents(contours,raw)).filter(n=>n.pitchMidi>=21&&n.pitchMidi<=108&&n.durationSeconds>.025).sort((a,b)=>a.startTimeSeconds-b.startTimeSeconds);notes=estimateSustainedLengths(detected,frames,decoded.duration);if(!notes.length)throw Error('No clear notes detected. Try a cleaner piano recording.');duration=Math.max(duration,...notes.map(n=>n.startTimeSeconds+n.durationSeconds));$('trackName').textContent=file.name;$('trackMeta').textContent='Piano transcription · '+fmt(duration);$('noteCount').textContent=notes.length.toLocaleString();$('duration').textContent=fmt(duration);$('key').textContent=keyEstimate(notes);$('empty').hidden=true;offset=0;['playBtn','stopBtn','exportBtn'].forEach(id=>$(id).disabled=false);$('saveCloudBtn').disabled=false;$('seek').disabled=false;progress(1);status('Done — '+notes.length+' notes detected.');draw()}catch(e){console.error(e);status('Could not transcribe: '+(e.message||'unknown error'))}finally{$('audioFile').disabled=false;$('linkBtn').disabled=false}}

const PROJECTS_KEY='flowingNotesCloudProjects';
function getCloudProjects(){try{return JSON.parse(localStorage.getItem(PROJECTS_KEY)||'[]')}catch{return []}}
function refreshCloudProjects(){
  const select=$('savedProjects');select.innerHTML='<option value="">Saved cloud projects…</option>';
  for(const p of getCloudProjects()){const option=document.createElement('option');option.value=p.id;option.textContent=p.name||'Piano recording';select.append(option)}
  $('openCloudBtn').disabled=select.options.length<=1;
}
async function cloudRequest(url,project,options={}){
  const headers=new Headers(options.headers||{});if(project?.token)headers.set('Authorization','Bearer '+project.token);
  const response=await fetch(url,{...options,headers});
  if(!response.ok){let message='Cloud storage request failed ('+response.status+').';try{message=(await response.json()).error||message}catch{}throw Error(message)}
  return response;
}
async function saveCloudProject(){
  if(!currentFile||!notes.length){status('Transcribe a recording before saving it to the cloud.');return}
  $('saveCloudBtn').disabled=true;
  try{
    status('Creating private cloud project…');
    const created=await cloudRequest('/api/projects',null,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    const project=await created.json();
    status('Uploading your recording to Singapore storage…');
    await cloudRequest('/api/projects/'+project.id+'/recording',{...project,token:project.token},{method:'PUT',headers:{'Content-Type':'application/octet-stream','X-File-Type':currentFile.type||'audio/wav','X-File-Name':encodeURIComponent(currentFile.name||'recording.wav')},body:currentFile});
    status('Saving detected notes…');
    await cloudRequest('/api/projects/'+project.id+'/transcription',project,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({notes:notes.map(n=>({pitchMidi:n.pitchMidi,startTimeSeconds:n.startTimeSeconds,durationSeconds:n.durationSeconds,amplitude:n.amplitude})),duration,trackName:currentFile.name||'Piano recording'})});
    const saved=getCloudProjects();saved.unshift({id:project.id,token:project.token,name:currentFile.name||'Piano recording',updatedAt:new Date().toISOString()});
    localStorage.setItem(PROJECTS_KEY,JSON.stringify(saved.slice(0,30)));refreshCloudProjects();
    $('savedProjects').value=project.id;status('Saved privately to your Flowing Notes cloud storage.');
  }catch(e){console.error(e);status('Cloud save failed: '+e.message)}
  finally{$('saveCloudBtn').disabled=false}
}
async function openCloudProject(){
  const project=getCloudProjects().find(p=>p.id===$('savedProjects').value);if(!project)return;
  $('openCloudBtn').disabled=true;
  try{
    status('Loading saved transcription…');
    const transcription=await (await cloudRequest('/api/projects/'+project.id+'/transcription',project)).json();
    status('Loading original recording…');
    const response=await cloudRequest('/api/projects/'+project.id+'/recording',project);
    const blob=await response.blob();currentFile=new File([blob],project.name||'recording.wav',{type:blob.type||'audio/wav'});
    const decoded=await decode(currentFile);audioBuffer=decoded.audioBuffer;
    notes=transcription.notes||[];duration=transcription.duration||decoded.duration;duration=Math.max(duration,...notes.map(n=>n.startTimeSeconds+n.durationSeconds));
    $('trackName').textContent=transcription.trackName||project.name||'Saved piano roll';$('trackMeta').textContent='Cloud project · '+fmt(duration);
    $('noteCount').textContent=notes.length.toLocaleString();$('duration').textContent=fmt(duration);$('key').textContent=keyEstimate(notes);
    $('empty').hidden=true;offset=0;playing=false;['playBtn','stopBtn','exportBtn','saveCloudBtn'].forEach(id=>$(id).disabled=false);$('seek').disabled=false;$('clock').textContent='0:00 / '+fmt(duration);draw();status('Cloud project loaded — no re-upload or re-transcription needed.');
  }catch(e){console.error(e);status('Could not open cloud project: '+e.message)}
  finally{$('openCloudBtn').disabled=false}
}

function stopAudio(){if(audioSource){try{audioSource.stop()}catch{}audioSource.disconnect();audioSource=null}if(audio){audio.close();audio=null}}
function play(){if(!audioBuffer){status('Original audio is unavailable. Please upload the recording again.');return}if(offset>=duration)offset=0;playing=true;started=performance.now();audio=new AudioContext();audioSource=audio.createBufferSource();audioSource.buffer=audioBuffer;audioSource.connect(audio.destination);audioSource.start(0,Math.min(offset,audioBuffer.duration));$('playBtn').textContent='Ⅱ Pause';draw()}
function pause(){if(!playing)return;offset=Math.min(duration,offset+(performance.now()-started)/1000);playing=false;cancelAnimationFrame(raf);stopAudio();$('playBtn').textContent='▶ Play';draw();$('clock').textContent=fmt(offset)+' / '+fmt(duration)}
function vlq(v){let b=v&127;const out=[];while((v>>=7)){b<<=8;b|=(v&127)|128}while(true){out.push(b&255);if(b&128)b>>=8;else break}return out}
function exportMidi(){const events=[];for(const n of notes){const a=Math.round(n.startTimeSeconds*960),b=Math.max(a+1,Math.round((n.startTimeSeconds+n.durationSeconds)*960));events.push({t:a,on:1,p:n.pitchMidi,v:Math.max(1,Math.min(127,Math.round(n.amplitude*127)))},{t:b,on:0,p:n.pitchMidi,v:0})}events.sort((a,b)=>a.t-b.t||a.on-b.on);const track=[];let last=0;for(const e of events){track.push(...vlq(e.t-last),e.on?0x90:0x80,e.p,e.v);last=e.t}track.push(0,255,47,0);const header=[77,84,104,100,0,0,0,6,0,0,0,1,1,224],chunk=[77,84,114,107,(track.length>>>24)&255,(track.length>>>16)&255,(track.length>>>8)&255,track.length&255,...track];const blob=new Blob([new Uint8Array([...header,...chunk])],{type:'audio/midi'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='flowing-notes.mid';a.click();URL.revokeObjectURL(url)}
function buildKeyboard(){const k=$('keyboard');for(let p=21;p<=108;p++){const el=document.createElement('div');el.className='key'+([1,3,6,8,10].includes(p%12)?' black':'');k.append(el)}}
$('audioFile').addEventListener('change',e=>{if(e.target.files?.[0])transcribe(e.target.files[0])});
$('linkBtn').onclick=async()=>{const value=$('videoUrl').value.trim();if(!value){status('Paste a direct audio or video file URL first.');return}try{const file=await fetchMediaUrl(value);await transcribe(file)}catch(e){console.error(e);status('Could not load link: '+(e.message||'unknown error'))}};
$('videoUrl').addEventListener('keydown',e=>{if(e.key==='Enter')$('linkBtn').click()});
$('playBtn').onclick=()=>playing?pause():play();$('stopBtn').onclick=()=>{pause();offset=0;draw();$('seek').value=0;$('clock').textContent='0:00 / '+fmt(duration)};$('seek').oninput=e=>{pause();offset=duration*Number(e.target.value)/1000;draw();$('clock').textContent=fmt(offset)+' / '+fmt(duration)};$('exportBtn').onclick=exportMidi;$('saveCloudBtn').onclick=saveCloudProject;$('openCloudBtn').onclick=openCloudProject;refreshCloudProjects();
buildKeyboard();new ResizeObserver(resize).observe(canvas);resize();
