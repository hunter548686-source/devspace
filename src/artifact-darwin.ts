import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { ArtifactError } from "./artifact-error.js";

// Python's dir_fd operations are openat/linkat/unlinkat on macOS; unlike /dev/fd
// path concatenation they keep every operation anchored to a verified directory.
const helper = String.raw`
import os,sys,json,struct,hashlib,uuid,time,stat
root,relative,maximum=sys.argv[1],sys.argv[2],int(sys.argv[3])
parts=relative.split("/")
fds=[]; partial=None; parent=None; out=None
def fail(code): raise RuntimeError(code)
def exact(n):
    b=b""
    while len(b)<n:
        c=sys.stdin.buffer.read(n-len(b))
        if not c: fail("artifact_stream_incomplete")
        b+=c
    return b
def identity(fd):
    s=os.fstat(fd); return (s.st_dev,s.st_ino)
flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
try:
    try: fd=os.open(root,flags); fds.append(fd)
    except OSError: fail("artifact_workspace_unsafe")
    for part in parts[:-1]:
        try: os.mkdir(part,0o700,dir_fd=fd)
        except FileExistsError: pass
        try: fd=os.open(part,flags,dir_fd=fd); fds.append(fd)
        except OSError: fail("artifact_destination_parent_unsafe")
    parent=fd
    # Only remove old regular download partials from this anchored directory.
    cleaned=0
    for name in os.listdir(parent):
        if cleaned>=32: break
        if name.startswith(".devspace-download-") and name.endswith(".partial"):
            s=os.stat(name,dir_fd=parent,follow_symlinks=False)
            if stat.S_ISREG(s.st_mode) and time.time()-s.st_mtime>86400:
                os.unlink(name,dir_fd=parent); cleaned+=1
    partial=".devspace-download-"+str(uuid.uuid4())+".partial"
    out=os.open(partial,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
    owned=os.fstat(out)
    size=0; digest=hashlib.sha256()
    while True:
        count=struct.unpack(">I",exact(4))[0]
        if count==0: break
        if count>1048576 or size+count>maximum: fail("artifact_file_too_large")
        data=exact(count)
        at=0
        while at<len(data): at+=os.write(out,data[at:])
        size+=count; digest.update(data)
    os.fsync(out)
    written=os.fstat(out); current=os.stat(partial,dir_fd=parent,follow_symlinks=False)
    if not stat.S_ISREG(current.st_mode) or (written.st_dev,written.st_ino)!=(current.st_dev,current.st_ino): fail("artifact_partial_unsafe")
    # A renamed/replaced parent must not receive a publication at a stale path.
    check=[]
    try:
        verify=os.open(root,flags); check.append(verify)
        if identity(verify)!=identity(fds[0]): fail("artifact_destination_unsafe")
        for i,part in enumerate(parts[:-1]):
            verify=os.open(part,flags,dir_fd=verify); check.append(verify)
            if identity(verify)!=identity(fds[i+1]): fail("artifact_destination_unsafe")
        try: os.link(partial,parts[-1],src_dir_fd=parent,dst_dir_fd=parent,follow_symlinks=False)
        except FileExistsError: fail("artifact_destination_exists")
        os.unlink(partial,dir_fd=parent); partial=None
        try: os.fsync(parent)
        except OSError: pass
    finally:
        for v in reversed(check): os.close(v)
    print(json.dumps({"path":relative,"size":size,"sha256":"sha256:"+digest.hexdigest()}))
except Exception as error:
    message=str(error)
    print(json.dumps({"error":message if message.startswith("artifact_") else "artifact_destination_unsafe"}))
    sys.exit(1)
finally:
    if out is not None: os.close(out)
    if partial is not None and parent is not None:
        try:
            s=os.stat(partial,dir_fd=parent,follow_symlinks=False)
            if (s.st_dev,s.st_ino)==(owned.st_dev,owned.st_ino): os.unlink(partial,dir_fd=parent)
        except OSError: pass
    for fd in reversed(fds): os.close(fd)
`;

export async function downloadDarwin(stream: Readable, root: string, path: string, maximum: number, expectedSize?: number) {
  const child=spawn("/usr/bin/python3",["-I","-c",helper,root,path,String(maximum)],{stdio:["pipe","pipe","pipe"]});
  let output=""; let diagnostic="";
  child.stdout.on("data",chunk=>{output+=chunk.toString();});
  child.stderr.on("data",chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-1024);});
  const closed=new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
  void closed.catch(()=>{});
  child.stdin.on("error",()=>{});
  const send=async(data:Buffer)=>{if(!child.stdin.write(data))await once(child.stdin,"drain");};
  let inputError:unknown; const hash=createHash("sha256"); let size=0;
  try {
    for await (const raw of stream) {
      const chunk=Buffer.isBuffer(raw)?raw:Buffer.from(raw);
      if(size+chunk.length>maximum) throw new ArtifactError("artifact_file_too_large","Native file exceeds the configured per-file limit.");
      for(let at=0;at<chunk.length;at+=1048576){
        const part=chunk.subarray(at,at+1048576);const header=Buffer.alloc(4);header.writeUInt32BE(part.length);
        await send(header);await send(part);
      }
      hash.update(chunk);size+=chunk.length;
    }
    if(expectedSize!==undefined && size!==expectedSize)throw new ArtifactError("artifact_file_size_mismatch","Native file metadata did not match the downloaded content.");
    await send(Buffer.alloc(4)); child.stdin.end();
  } catch(error){inputError=error;stream.destroy();child.stdin.end();}
  const code=await closed;
  if(inputError)throw inputError;
  let result:{path:string;size:number;sha256:string;error?:string};
  try{result=JSON.parse(output);}catch{throw new ArtifactError("artifact_platform_unavailable",diagnostic?"macOS secure file helper failed. Check the installed system Python 3.":"macOS secure file helper produced no result.");}
  if(code!==0||result.error)throw new ArtifactError((result.error??"artifact_write_integrity_failed") as never,"Secure native file download failed: "+result.error);
  if(result.size!==size||result.sha256!=="sha256:"+hash.digest("hex"))throw new ArtifactError("artifact_write_integrity_failed","Native file hash verification failed.");
  return {path:result.path,size:result.size,sha256:result.sha256};
}
