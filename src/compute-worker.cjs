const { parentPort,threadId }=require("node:worker_threads");

console.log("Worker thread started:",threadId);

const start=Date.now();
let count=0;

// burns CPU for ~5 seconds, but on THIS thread, not the server's main thread
while(Date.now()-start<5000){
  count++;
}

console.log("Worker finished:",threadId);

// send the result back to the main thread (index.ts)
parentPort.postMessage(count);
