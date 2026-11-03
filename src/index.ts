import net from "node:net";

const MAX_HEADER_SIZE=8192;
const MAX_BODY_SIZE=1024*1024; // 1 MB
const IDLE_TIMEOUT=10_000;
const MAX_REQUESTS=100;

// Example: curl.exe -v http://localhost:3000/hello
//
// What curl sends over TCP (\r\n written out, normally invisible):
//
//   GET /hello HTTP/1.1\r\n          -> bytes  0-20
//   Host: localhost:3000\r\n         -> bytes 21-42
//   User-Agent: curl/8.21.0\r\n      -> bytes 43-67
//   Accept: */*                      -> bytes 68-78
//   \r\n\r\n                         -> bytes 79-82 (end of headers)
//
// Raw bytes (hex) in the Buffer:
//   G  E  T     /  h  e  l  l  o
//   47 45 54 20 2f 68 65 6c 6c 6f ...
//
// With keep-alive, the same connection can carry more requests,
// so the buffer can hold the next one right after byte 82:
//
//   [ request 1: bytes 0-82 ][ request 2: bytes 83-... ]
//
// Example with a body: curl.exe -v -d "hello" http://localhost:3000/echo
//
//   POST /echo HTTP/1.1\r\n                                -> bytes   0-20
//   Host: localhost:3000\r\n                               -> bytes  21-42
//   User-Agent: curl/8.21.0\r\n                            -> bytes  43-67
//   Accept: */*\r\n                                        -> bytes  68-80
//   Content-Length: 5\r\n                                  -> bytes  81-99
//   Content-Type: application/x-www-form-urlencoded        -> bytes 100-146
//   \r\n\r\n                                               -> bytes 147-150 (index=147)
//   hello                                                  -> bytes 151-155 (the body)
//
//   [ headers: 0-146 ][\r\n\r\n: 147-150][ body: 151-155 ][ next request: 156-... ]

// small helper so every error response looks the same
function sendError(socket:net.Socket,status:string){
  socket.end(
    `HTTP/1.1 ${status}\r\n`+
    "Content-Length: 0\r\n"+
    "Connection: close\r\n"+
    "\r\n"
  );
}

const server=net.createServer((socket)=>{
  console.log("Client is connected");

  // empty bucket for this connection -> <Buffer >, length 0
  let request=Buffer.alloc(0);
  let requestsServed=0;
  let closing=false;

  // no data for 10s -> close the idle connection
  socket.setTimeout(IDLE_TIMEOUT);
  socket.on("timeout",()=>{
    console.log("Idle connection timeout");
    closing=true;
    socket.end();
  });

  socket.on("data",(chunk:Buffer)=>{
    if(closing) return;

    // TCP can split a request into pieces, so we keep adding them:
    //   data #1 chunk -> "GET /hello HTTP/1.1\r\n"
    //   request       -> "GET /hello HTTP/1.1\r\n"
    //   data #2 chunk -> "Host: localhost:3000\r\n"
    //   request       -> "GET /hello HTTP/1.1\r\nHost: localhost:3000\r\n"
    //   data #3 chunk -> "User-Agent: curl/8.21.0\r\nAccept: */*\r\n\r\n"
    //   request       -> full headers (now contains \r\n\r\n)
    request=Buffer.concat([request,chunk]);

    // one chunk can contain several requests -> handle them one by one
    while(true){
      // where do the headers end?
      //   not arrived yet -> -1
      //   GET example     -> 79
      //   POST example    -> 147
      const index=request.indexOf("\r\n\r\n");

      if(index===-1){
        // too big and still no end of headers -> reject
        // otherwise return, the next "data" event runs Buffer.concat again
        if(request.length>MAX_HEADER_SIZE){
          closing=true;
          sendError(socket,"431 Request Header Fields Too Large");
        }
        return; // wait for more data
      }

      // headers finished but bigger than the limit -> reject
      if(index+4>MAX_HEADER_SIZE){
        closing=true;
        sendError(socket,"431 Request Header Fields Too Large");
        return;
      }

      // subarray(0,79) -> header bytes only (without \r\n\r\n)
      // toString()     -> bytes to text:
      //   "GET /hello HTTP/1.1\r\nHost: localhost:3000\r\nUser-Agent: curl/8.21.0\r\nAccept: */*"
      const text=request.subarray(0,index).toString();

      // split("\r\n") ->
      //   firstLine = "GET /hello HTTP/1.1"
      //   headers   = ["Host: localhost:3000","User-Agent: curl/8.21.0","Accept: */*"]
      const [firstLine,...headers]=text.split("\r\n");

      // split(" ") -> ["GET","/hello","HTTP/1.1"]
      const [method,path,version]=firstLine.split(" ");

      // collect every Content-Length header:
      //   GET example  -> []                     -> contentLength=0
      //   POST example -> ["Content-Length: 5"]  -> contentLength=5
      const lengthHeaders=headers.filter(h=>
        /^content-length:/i.test(h)
      );

      // two Content-Length headers -> which one is right? reject
      if(lengthHeaders.length>1){
        closing=true;
        sendError(socket,"400 Bad Request");
        return;
      }

      // POST must say how big its body is
      if(method==="POST"&&lengthHeaders.length===0){
        closing=true;
        sendError(socket,"411 Length Required");
        return;
      }

      let contentLength=0;

      if(lengthHeaders.length===1){
        // "Content-Length: 5" -> split(":") -> ["Content-Length"," 5"] -> [1] -> " 5" -> trim -> "5"
        const value=lengthHeaders[0].split(":")[1].trim();

        // only digits allowed: "5" ok, "abc" / "-5" / "2.5" / "" -> 400
        if(!/^\d+$/.test(value)){
          closing=true;
          sendError(socket,"400 Bad Request");
          return;
        }

        contentLength=Number(value);
      }

      // validate BEFORE waiting for the body
      // (Content-Length is already checked above: digits only)
      const unsupported=
        version!=="HTTP/1.1"||
        (method!=="GET"&&method!=="POST")||
        headers.some(h=>/^transfer-encoding\s*:/i.test(h)); // chunked bodies not supported yet

      if(unsupported){
        closing=true;
        sendError(socket,"400 Bad Request");
        return;
      }

      if(contentLength>MAX_BODY_SIZE){
        closing=true;
        sendError(socket,"413 Content Too Large");
        return;
      }

      // where the body is in the buffer (POST example):
      //   bodyStart   = 147 + 4 = 151
      //   totalLength = 151 + 5 = 156  -> this request ends at byte 155
      const bodyStart=index+4;
      const totalLength=bodyStart+contentLength;

      // body not fully arrived yet -> wait for more data
      // (we keep the headers in the buffer and parse them again next time)
      if(request.length<totalLength){
        return;
      }

      // subarray(151,156) -> "hello"
      const requestBody=request.subarray(bodyStart,totalLength).toString();

      // cut off this whole request (headers + body) and keep whatever comes after it:
      //   only one request -> request = <Buffer >
      //   two requests     -> request = bytes of request 2
      request=request.subarray(totalLength);

      console.log("Method:",method);
      console.log("Path:",path);
      console.log("Body:",requestBody);

      // routing
      let status="200 OK";
      let body="";
      
      if(method==="GET"&&path==="/hello"){
        body="Hello from my tcp server";
      }else if(method==="GET" && path==="/block"){
        console.log("Blocking started")
        const startTime=Date.now();
        while(Date.now()-startTime<5000){
          //this shit is blocking
        }
        console.log("Blocking finished")
        body="Blocking completed"
      }else if(method=="GET" && path=="/nonblock"){
        console.log("non blocking started")
        closing=true;
        setTimeout(()=>{
          if(socket.destroyed) return;
          console.log("Non blocking finished")
          const result="Non blockign completed"
          const response=
      "HTTP/1.1 200 OK\r\n"+
      "Content-Type: text/plain\r\n"+
      `Content-Length: ${Buffer.byteLength(result)}\r\n`+
      "Connection: close\r\n"+
      "\r\n"+
      result;

    socket.end(response);
        },5000);
        return;
      }
      else if(method==="GET"&&path==="/health"){
        body="Server is healthy";
      }else if(method==="POST"&&path==="/echo"){
        body=`You sent: ${requestBody}`;
      }else{
        status="404 Not Found";
        body="Route not found";
      }

      requestsServed++;
      console.log("Requests on connection:",requestsServed);

      // client sent "Connection: close" -> close after this response
      // otherwise HTTP/1.1 keeps the connection open (keep-alive)
      const shouldClose=
      headers.some(h=>/^connection\s*:\s*close\s*$/i.test(h))||
      requestsServed>=MAX_REQUESTS;

      // response = status line + headers + empty line + body
      const response=
        `HTTP/1.1 ${status}\r\n`+
        "Content-Type: text/plain\r\n"+
        `Content-Length: ${Buffer.byteLength(body)}\r\n`+
        `Connection: ${shouldClose?"close":"keep-alive"}\r\n`+
        "\r\n"+
        body;

      if(shouldClose){
        closing=true;
        socket.end(response); // send and close
        return;
      }

      socket.write(response); // send and keep the connection open
    }
  });

  socket.on("close",()=>{
    console.log("Client disconnected");
  });

  socket.on("error",(err)=>{
    console.log("Socket error:",err.message);
  });
});

// 0.0.0.0 -> listen on every address this PC has (localhost, Wi-Fi IP, ...)
server.listen(3000,"0.0.0.0",()=>{
  console.log("TCP server is running on port 3000");
});
