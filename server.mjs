import express from 'express';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app=express();
const port=10000;
const bucket=process.env.S3_BUCKET;
const required=['S3_ENDPOINT','S3_BUCKET','S3_REGION','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY'];
const missing=required.filter(k=>!process.env[k]);
if(missing.length) console.error('Missing storage configuration:',missing.join(', '));
const s3=new S3Client({
  region:process.env.S3_REGION||'auto',
  endpoint:process.env.S3_ENDPOINT,
  forcePathStyle:false,
  credentials:{accessKeyId:process.env.S3_ACCESS_KEY_ID||'missing',secretAccessKey:process.env.S3_SECRET_ACCESS_KEY||'missing'}
});
const hash=value=>createHash('sha256').update(value).digest('hex');
const keyFor=(id,name)=>`projects/${id}/${name}`;
async function readJson(key){
  const result=await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}));
  return JSON.parse(await result.Body.transformToString());
}
async function writeJson(key,value){
  await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:JSON.stringify(value),ContentType:'application/json'}));
}
async function authorize(req,res,next){
  try{
    if(missing.length)return res.status(503).json({error:'Cloud storage is not configured yet.'});
    const id=req.params.id,token=(req.get('authorization')||'').replace(/^Bearer\s+/i,'');
    if(!/^[0-9a-f-]{36}$/i.test(id)||token.length<32)return res.status(401).json({error:'Invalid project credentials.'});
    const meta=await readJson(keyFor(id,'project.json'));
    const a=Buffer.from(hash(token),'hex'),b=Buffer.from(meta.tokenHash,'hex');
    if(a.length!==b.length||!timingSafeEqual(a,b))return res.status(401).json({error:'Invalid project credentials.'});
    req.project=meta;req.projectId=id;next();
  }catch(e){if(e.name==='NoSuchKey'||e.$metadata?.httpStatusCode===404)return res.status(404).json({error:'Project not found.'});console.error(e);res.status(500).json({error:'Could not access cloud project.'})}
}
app.disable('x-powered-by');
app.use(express.json({limit:'8mb'}));
app.get('/api/health',(req,res)=>res.json({ok:missing.length===0,storage:missing.length===0?'connected':'not-configured'}));
app.post('/api/projects',async(req,res)=>{
  try{
    if(missing.length)return res.status(503).json({error:'Cloud storage is not configured yet.'});
    const id=randomUUID(),token=randomBytes(32).toString('base64url');
    await writeJson(keyFor(id,'project.json'),{tokenHash:hash(token),createdAt:new Date().toISOString(),fileName:'',contentType:'',hasRecording:false,hasTranscription:false});
    res.status(201).json({id,token});
  }catch(e){console.error(e);res.status(500).json({error:'Could not create cloud project.'})}
});
app.put('/api/projects/:id/recording',authorize,express.raw({type:'application/octet-stream',limit:'100mb'}),async(req,res)=>{
  try{
    if(!Buffer.isBuffer(req.body)||!req.body.length)return res.status(400).json({error:'Recording body is empty.'});
    const contentType=String(req.get('x-file-type')||'audio/mpeg').slice(0,120);
    let fileName=String(req.get('x-file-name')||'recording').slice(0,540);try{fileName=decodeURIComponent(fileName)}catch{}fileName=fileName.slice(0,180);
    await s3.send(new PutObjectCommand({Bucket:bucket,Key:keyFor(req.projectId,'recording'),Body:req.body,ContentType:contentType}));
    const meta={...req.project,fileName,contentType,hasRecording:true,updatedAt:new Date().toISOString()};
    await writeJson(keyFor(req.projectId,'project.json'),meta);
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Could not save recording.'})}
});
app.get('/api/projects/:id/recording',authorize,async(req,res)=>{
  try{
    if(!req.project.hasRecording)return res.status(404).json({error:'No recording is saved for this project.'});
    const obj=await s3.send(new GetObjectCommand({Bucket:bucket,Key:keyFor(req.projectId,'recording')}));
    res.setHeader('Content-Type',req.project.contentType||'audio/mpeg');
    res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(req.project.fileName||'recording')}`);
    obj.Body.pipe(res);
  }catch(e){console.error(e);res.status(500).json({error:'Could not load recording.'})}
});
app.put('/api/projects/:id/transcription',authorize,async(req,res)=>{
  try{
    const data=req.body;
    if(!data||!Array.isArray(data.notes)||data.notes.length>100000)return res.status(400).json({error:'Invalid transcription data.'});
    await writeJson(keyFor(req.projectId,'transcription.json'),data);
    await writeJson(keyFor(req.projectId,'project.json'),{...req.project,hasTranscription:true,updatedAt:new Date().toISOString(),trackName:String(data.trackName||'Piano recording').slice(0,180)});
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Could not save transcription.'})}
});
app.get('/api/projects/:id/transcription',authorize,async(req,res)=>{
  try{if(!req.project.hasTranscription)return res.status(404).json({error:'No transcription is saved.'});res.json(await readJson(keyFor(req.projectId,'transcription.json')))}
  catch(e){console.error(e);res.status(500).json({error:'Could not load transcription.'})}
});
app.get('/api/projects/:id',authorize,(req,res)=>{
  const {tokenHash,...safe}=req.project;res.json({id:req.projectId,...safe});
});
const here=path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(here,'dist')));
app.get('*',(req,res)=>res.sendFile(path.join(here,'dist','index.html')));
app.listen(port,'0.0.0.0',()=>console.log('Flowing Notes listening on',port));
