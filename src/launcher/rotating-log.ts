import { Writable } from 'node:stream';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { utf8Prefix } from '../runtime/log-query.js';

/** Async serialized, byte-bounded rotating writer. Callers must honor Writable backpressure. */
export class RotatingLog extends Writable {
  private file?: fs.FileHandle;
  private size = 0;
  private rotations = 0;
  private written = 0;
  private failure: string | null = null;
  constructor(readonly filename:string,readonly maxBytes=10*1024*1024,readonly files=3) {
    super({highWaterMark:65536});
    if(!Number.isInteger(maxBytes)||maxBytes<1024||!Number.isInteger(files)||files<1||files>20)throw new Error('Invalid rotating log limits.');
    this.on('error',e=>{this.failure=e.message;});
  }
  get stats(){return {file:this.filename,current_bytes:this.size,max_bytes:this.maxBytes,retained_files:this.files,
    rotations:this.rotations,written_bytes:this.written,queued_bytes:this.writableLength,error:this.failure};}
  private async openFile(){
    if(this.file)return;
    // On Windows an append-only handle may lack the write access required by
    // FlushFileBuffers. This writer is serialized, so positioned writes retain
    // append semantics without dropping the final durability check.
    const flags=process.platform==='win32'?constants.O_RDWR|constants.O_CREAT:constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|(constants.O_NOFOLLOW??0);
    const h=await fs.open(this.filename,flags,0o600);
    const s=await h.stat();
    if(!s.isFile()){await h.close();throw new Error('Diagnostic log must be a regular file.');}
    if(process.platform!=='win32')await h.chmod(0o600);this.file=h;this.size=s.size;
    if(this.size>this.maxBytes)await this.rotate();
  }
  private async rotate(){
    await this.file?.close();this.file=undefined;
    if(this.files===1)await fs.unlink(this.filename).catch(e=>{if(e.code!=='ENOENT')throw e;});
    else {
      await fs.unlink(`${this.filename}.${this.files-1}`).catch(e=>{if(e.code!=='ENOENT')throw e;});
      for(let n=this.files-2;n>=0;n--){
        const from=n===0?this.filename:`${this.filename}.${n}`;
        try{await fs.rename(from,`${this.filename}.${n+1}`);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      }
    }
    this.size=0;this.rotations++;
    this.file=await fs.open(this.filename,process.platform==='win32'?constants.O_RDWR|constants.O_CREAT:constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|(constants.O_NOFOLLOW??0),0o600);
  }
  private async put(data:Buffer){
    await this.openFile();
    let offset=0;
    while(offset<data.length){
      if(this.size===this.maxBytes)await this.rotate();
      let part=utf8Prefix(data.subarray(offset),this.maxBytes-this.size);
      if(!part.length){await this.rotate();part=utf8Prefix(data.subarray(offset),this.maxBytes);}
      if(!part.length)throw new Error('Could not split diagnostic log data.');
      if(process.platform==='win32'){
        let written=0;
        while(written<part.length){
          const r=await this.file!.write(part,written,part.length-written,this.size+written);
          if(r.bytesWritten===0)throw new Error('Diagnostic log write made no progress.');
          written+=r.bytesWritten;
        }
      }else await this.file!.writeFile(part);
      this.size+=part.length;this.written+=part.length;offset+=part.length;
    }
  }
  override _write(chunk:Buffer|string,encoding:BufferEncoding,done:(error?:Error|null)=>void){
    void this.put(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,encoding)).then(()=>done(),e=>done(e instanceof Error?e:new Error(String(e))));
  }
  override _final(done:(error?:Error|null)=>void){
    void (async()=>{if(this.file){await this.file.sync();await this.file.close();this.file=undefined;}})().then(()=>done(),done);
  }
  override _destroy(error:Error|null,done:(error?:Error|null)=>void){
    const file=this.file;this.file=undefined;
    void (file?.close()??Promise.resolve()).then(()=>done(error),e=>done(error??e));
  }
}
