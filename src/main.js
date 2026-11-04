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
let notes=[], duration=0, playing=false, started=0, offset=0, raf=0, audio=null, ffmpeg=null, ffmpegPromise=null;

const fmt=s=>Math.floor(Math.max(0,s)/60)+':'+String(Math.floor(Math.max(0,s)%60)).padStart(2,'0');
function status(s){$('status').textContent=s}
function progress(p){$('progressWrap').hidden=false;$('progressBar').style.width=(p*100)+'%';$('progressText').textContent=Math.round(p*100)+'%'}
function keyName(p){return NAMES[p%12]+(Math.floor(p/12)-1)}
function keyEstimate(list){const e=Array(12).fill(0),maj=[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88],min=[6.33,2.68,3.52,5.38,2.6,3.53,2.54,4.75,3.98,2.69,3.34,3.17];list.forEach(n=>e[n.pitchMidi%12]+=n.durationSeconds);let best=-Infinity,result='—';for(let r=0;r<12;r++)for(const [m,p] of [['major',maj],['minor',min]]){let v=0;for(let i=0;i<12;i++)v+=e[(i+r)%12]*p[i];if(v>best){best=v;result=NAMES[r]+' '+m}}return result}
function draw(){const w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;ctx.clearRect(0,0,w,h);ctx.fillStyle='#0b1020';ctx.fillRect(0,0,w,h);const low=21,high=109,range=high-low,now=playing?offset+(performance.now()-started)/1000:offset,windowSec=9;for(let p=low;p<=high;p++)if(p%12===0){const y=(high-p)/range*h;ctx.strokeStyle='#293149';ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke()}const playheadX=w*.2;const x=t=>playheadX+(t-now)*w/windowSec;for(const n of notes){const a=x(n.startTimeSeconds),b=x(n.startTimeSeconds+n.durationSeconds),y=(high-n.pitchMidi)/range*h,hh=Math.max(4,h/range*.8);if(b<0||a>w)continue;ctx.fillStyle='#7185ee';ctx.globalAlpha=.94;ctx.beginPath();ctx.roundRect(a,y-hh/2,Math.max(3,b-a),hh,3);ctx.fill();if(b-a>32){ctx.fillStyle='#07101b';ctx.font='10px system-ui';ctx.fillText(keyName(n.pitchMidi),a+4,y+3)}}ctx.globalAlpha=1;ctx.strokeStyle='#f1f3ff';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(x(now),0);ctx.lineTo(x(now),h);ctx.stroke();if(playing){$('seek').value=duration?now/duration*1000:0;$('clock').textContent=fmt(now)+' / '+fmt(duration);if(now>=duration){pause();return}raf=requestAnimationFrame(draw)}}
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

async function decode(file){const decoder=new AudioContext();try{const source=await decoder.decodeAudioData(await file.arrayBuffer()),length=Math.ceil(source.duration*22050),offline=new OfflineAudioContext(1,length,22050),node=offline.createBufferSource();node.buffer=source;node.connect(offline.destination);node.start();const mono=await offline.startRendering();return {samples:mono.getChannelData(0),duration:source.duration}}finally{await decoder.close()}}
async function transcribe(file){$('audioFile').disabled=true;$('linkBtn').disabled=true;['playBtn','stopBtn','exportBtn'].forEach(id=>$(id).disabled=true);progress(0);try{if(isVideoFile(file))file=await extractAudio(file);status('Decoding audio…');const decoded=await decode(file);duration=decoded.duration;status('Loading Spotify Basic Pitch…');await tf.setBackend('webgl');await tf.ready();const model=new BasicPitch(MODEL_URL),frames=[],onsets=[],contours=[];status('AI is detecting piano notes…');await model.evaluateModel(decoded.samples,(f,o,c)=>{frames.push(...f);onsets.push(...o);contours.push(...c)},progress);status('Converting detections into notes…');const raw=outputToNotesPoly(frames,onsets,.35,.12,8,true,null,27.5,false);notes=noteFramesToTime(addPitchBendsToNoteEvents(contours,raw)).filter(n=>n.pitchMidi>=21&&n.pitchMidi<=108&&n.durationSeconds>.025).sort((a,b)=>a.startTimeSeconds-b.startTimeSeconds);if(!notes.length)throw Error('No clear notes detected. Try a cleaner piano recording.');duration=Math.max(duration,...notes.map(n=>n.startTimeSeconds+n.durationSeconds));$('trackName').textContent=file.name;$('trackMeta').textContent='Piano transcription · '+fmt(duration);$('noteCount').textContent=notes.length.toLocaleString();$('duration').textContent=fmt(duration);$('key').textContent=keyEstimate(notes);$('empty').hidden=true;offset=0;['playBtn','stopBtn','exportBtn'].forEach(id=>$(id).disabled=false);$('seek').disabled=false;progress(1);status('Done — '+notes.length+' notes detected.');draw()}catch(e){console.error(e);status('Could not transcribe: '+(e.message||'unknown error'))}finally{$('audioFile').disabled=false;$('linkBtn').disabled=false}}
function stopAudio(){if(audio){audio.close();audio=null}}
function play(){if(!notes.length)return;if(offset>=duration)offset=0;playing=true;started=performance.now();audio=new AudioContext();for(const n of notes){if(n.startTimeSeconds+n.durationSeconds<offset)continue;const a=Math.max(0,n.startTimeSeconds-offset),b=Math.max(a+.04,n.startTimeSeconds+n.durationSeconds-offset),osc=audio.createOscillator(),gain=audio.createGain();osc.type='triangle';osc.frequency.value=440*Math.pow(2,(n.pitchMidi-69)/12);gain.gain.setValueAtTime(.0001,audio.currentTime+a);gain.gain.linearRampToValueAtTime(.08,audio.currentTime+a+.02);gain.gain.setValueAtTime(.08,audio.currentTime+b);gain.gain.linearRampToValueAtTime(.0001,audio.currentTime+b+.04);osc.connect(gain);gain.connect(audio.destination);osc.start(audio.currentTime+a);osc.stop(audio.currentTime+b+.05)}$('playBtn').textContent='Ⅱ Pause';draw()}
function pause(){if(!playing)return;offset=Math.min(duration,offset+(performance.now()-started)/1000);playing=false;cancelAnimationFrame(raf);stopAudio();$('playBtn').textContent='▶ Play';draw();$('clock').textContent=fmt(offset)+' / '+fmt(duration)}
function vlq(v){let b=v&127;const out=[];while((v>>=7)){b<<=8;b|=(v&127)|128}while(true){out.push(b&255);if(b&128)b>>=8;else break}return out}
function exportMidi(){const events=[];for(const n of notes){const a=Math.round(n.startTimeSeconds*960),b=Math.max(a+1,Math.round((n.startTimeSeconds+n.durationSeconds)*960));events.push({t:a,on:1,p:n.pitchMidi,v:Math.max(1,Math.min(127,Math.round(n.amplitude*127)))},{t:b,on:0,p:n.pitchMidi,v:0})}events.sort((a,b)=>a.t-b.t||a.on-b.on);const track=[];let last=0;for(const e of events){track.push(...vlq(e.t-last),e.on?0x90:0x80,e.p,e.v);last=e.t}track.push(0,255,47,0);const header=[77,84,104,100,0,0,0,6,0,0,0,1,1,224],chunk=[77,84,114,107,(track.length>>>24)&255,(track.length>>>16)&255,(track.length>>>8)&255,track.length&255,...track];const blob=new Blob([new Uint8Array([...header,...chunk])],{type:'audio/midi'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='flowing-notes.mid';a.click();URL.revokeObjectURL(url)}
function buildKeyboard(){const k=$('keyboard');for(let p=21;p<=108;p++){const el=document.createElement('div');el.className='key'+([1,3,6,8,10].includes(p%12)?' black':'');k.append(el)}}
$('audioFile').addEventListener('change',e=>{if(e.target.files?.[0])transcribe(e.target.files[0])});
$('linkBtn').onclick=async()=>{const value=$('videoUrl').value.trim();if(!value){status('Paste a direct audio or video file URL first.');return}try{const file=await fetchMediaUrl(value);await transcribe(file)}catch(e){console.error(e);status('Could not load link: '+(e.message||'unknown error'))}};
$('videoUrl').addEventListener('keydown',e=>{if(e.key==='Enter')$('linkBtn').click()});
$('playBtn').onclick=()=>playing?pause():play();$('stopBtn').onclick=()=>{pause();offset=0;draw();$('seek').value=0;$('clock').textContent='0:00 / '+fmt(duration)};$('seek').oninput=e=>{pause();offset=duration*Number(e.target.value)/1000;draw();$('clock').textContent=fmt(offset)+' / '+fmt(duration)};$('exportBtn').onclick=exportMidi;
buildKeyboard();new ResizeObserver(resize).observe(canvas);resize();
