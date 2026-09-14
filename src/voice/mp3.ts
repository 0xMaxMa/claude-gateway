/** Duration of bounded MPEG Layer III output. Count complete frames, skipping ID3 metadata. */
export function mp3DurationMs(bytes:Uint8Array):number {
  let offset=0,seconds=0,frames=0;
  if(bytes.length>=10&&bytes[0]===73&&bytes[1]===68&&bytes[2]===51){
    offset=10+((bytes[6]&127)*2097152+(bytes[7]&127)*16384+(bytes[8]&127)*128+(bytes[9]&127))+(bytes[5]&16?10:0);
  }
  while(offset+4<=bytes.length){
    const a=bytes[offset],b=bytes[offset+1],c=bytes[offset+2];
    const version=(b>>3)&3,layer=(b>>1)&3,rate=(c>>2)&3,index=c>>4;
    if(a!==255||(b&224)!==224||version===1||layer!==1||rate===3||index===0||index===15){offset++;continue;}
    const bitrates=version===3?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
    const sampleRate=[44100,48000,32000][rate]/(version===3?1:version===2?2:4);
    const size=Math.floor((version===3?144:72)*bitrates[index]*1000/sampleRate)+((c>>1)&1);
    if(offset+size>bytes.length)break;
    seconds+=(version===3?1152:576)/sampleRate;frames++;offset+=size;
  }
  if(!frames)throw Error('INVALID_MP3');
  return Math.ceil(seconds*1000);
}
