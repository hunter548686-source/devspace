import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, writeFile, unlink, realpath, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Express } from "express";
import type { WorkspaceRegistry } from "./workspaces.js";
import { isPathInsideRoot } from "./roots.js";

type ExportRecord={fileName:string;mimeType:string;size:number;sha256:string;expiresAt:number;workspaceId:string};
export class ArtifactExports {
  constructor(private readonly directory:string){}
  private key(token:string){if(!/^[a-f0-9]{64}$/.test(token))throw new Error("Export not found.");return createHash("sha256").update(token).digest("hex");}
  async create(workspaceId:string,root:string,path:string,mimeType:string,ttlSeconds:number){
    const physicalRoot=await realpath(root);const physicalPath=await realpath(path);
    if(!isPathInsideRoot(physicalPath,physicalRoot))throw new Error("Export path resolves outside the workspace.");
    const input=await open(physicalPath,constants.O_RDONLY|constants.O_NOFOLLOW);
    const token=randomBytes(32).toString("hex");const key=this.key(token);
    await mkdir(this.directory,{recursive:true,mode:0o700});
    await this.cleanup();
    const target=join(this.directory,key+".bin");
    let output:Awaited<ReturnType<typeof open>>|undefined;
    try {
      const before=await input.stat({bigint:true});if(!before.isFile())throw new Error("Export requires a regular file.");
      output=await open(target,"wx",0o600);
      const hash=createHash("sha256");const buffer=Buffer.alloc(1024*1024);let size=0;
      while(true){const {bytesRead}=await input.read(buffer,0,buffer.length,size);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));let at=0;while(at<bytesRead)at+=(await output.write(buffer,at,bytesRead-at,size+at)).bytesWritten;size+=bytesRead;}
      const after=await input.stat({bigint:true});
      if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error("FILE_CHANGED: export source changed.");
      await output.sync();
      const record:ExportRecord={fileName:basename(path),mimeType,size,sha256:hash.digest("hex"),expiresAt:Date.now()+ttlSeconds*1000,workspaceId};
      await writeFile(join(this.directory,key+".json"),JSON.stringify(record),{flag:"wx",mode:0o600});
      return {...record,token};
    }catch(error){await unlink(target).catch(()=>{});throw error;}finally{await input.close();await output?.close();}
  }
  async get(token:string){
    const key=this.key(token);const record:ExportRecord=JSON.parse(await readFile(join(this.directory,key+".json"),"utf8"));
    if(record.expiresAt<=Date.now())throw new Error("Export expired.");
    return {record,path:join(this.directory,key+".bin")};
  }
  async cleanup(){
    const names=await readdir(this.directory);let count=0;
    for(const name of names){if(!/^[a-f0-9]{64}\.json$/.test(name)||count>=64)continue;
      try{const record:ExportRecord=JSON.parse(await readFile(join(this.directory,name),"utf8"));if(record.expiresAt>Date.now())continue;
        await unlink(join(this.directory,name.replace(/\.json$/,".bin"))).catch(()=>{});await unlink(join(this.directory,name));count++;
      }catch{}
    }
  }
}
export function registerExportTool(server:McpServer,workspaces:WorkspaceRegistry,stateDir:string,publicBaseUrl:string){
  const exports=new ArtifactExports(join(stateDir,"exports"));
  server.registerTool("export_artifact",{
    description:"Return a downloadable immutable copy of one user-requested workspace deliverable. The link grants access only to this file and expires. Do not export credentials or unrelated private files.",
    inputSchema:{workspaceId:z.string(),path:z.string(),mimeType:z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i).default("application/octet-stream"),expiresInSeconds:z.number().int().min(60).max(604800).default(86400)},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async({workspaceId,path,mimeType,expiresInSeconds})=>{
    const ws=workspaces.getWorkspace(workspaceId);
    const result=await exports.create(workspaceId,ws.root,workspaces.resolvePath(ws,path),mimeType,expiresInSeconds);
    const url=new URL("/artifacts/download",publicBaseUrl);url.searchParams.set("token",result.token);
    const {token:_token,...metadata}=result;
    return {content:[{type:"resource_link" as const,uri:url.href,name:result.fileName,mimeType,size:result.size},{type:"text" as const,text:JSON.stringify({...metadata,downloadUrl:url.href})}]};
  });
}
export function registerExportRoute(app:Express,stateDir:string){
  const exports=new ArtifactExports(join(stateDir,"exports"));
  app.get("/artifacts/download",async(req,res)=>{
    res.setHeader("Cache-Control","no-store");res.setHeader("Referrer-Policy","no-referrer");res.setHeader("X-Content-Type-Options","nosniff");
    try{
      const token=typeof req.query.token==="string"?req.query.token:"";
      const {record,path}=await exports.get(token);
      res.type(record.mimeType);
      res.download(basename(path),record.fileName,{root:join(stateDir,"exports"),dotfiles:"deny"},error=>{if(error&&!res.headersSent)res.status(404).end();});
    }catch{res.status(404).json({error:"export_not_found_or_expired"});}
  });
}
